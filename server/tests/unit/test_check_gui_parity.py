"""``scripts/check_gui_parity.py`` sees every route, however the routers are nested.

FastAPI 0.137 stopped copying an included router's routes into
``app.router.routes``; the list holds one placeholder per ``include_router``
call instead. A check that read only that list found no WebSocket routes and no
hidden HTTP routes behind ``/api`` and still printed OK. These tests build apps
with routes inside included routers, and the real app, then assert that the
check finds those routes and fails closed when it should. They skip when the
tests run away from a checkout.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from fastapi import APIRouter, FastAPI, WebSocket
from starlette.routing import BaseRoute, Route, WebSocketRoute

from tensa.api.app import make_app

pytestmark = pytest.mark.unit

# server/tests/unit/test_check_gui_parity.py -> server/ and the repository root.
_SERVER_DIR = Path(__file__).resolve().parents[2]
_SCRIPT = _SERVER_DIR.parent / "scripts" / "check_gui_parity.py"

_APP_WEBSOCKETS = {
    "/api/ws/{session_id}",
    "/api/ws/{session_id}/jobs/events",
    "/api/ws/{session_id}/sweep/{sweep_id}",
}


@pytest.fixture(scope="module")
def script() -> ModuleType:
    if not _SCRIPT.is_file():
        pytest.skip("scripts/check_gui_parity.py is not next to the tests")
    spec = importlib.util.spec_from_file_location("check_gui_parity", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _socket(websocket: WebSocket) -> None:
    await websocket.close()


async def _page() -> None:
    return None


def _nested_app() -> FastAPI:
    """Routes two routers deep, behind a prefix at each level, none of them marked."""
    inner = APIRouter(prefix="/inner")
    inner.add_api_websocket_route("/ws/{token}", _socket)
    inner.add_api_route("/hidden", _page, include_in_schema=False)
    outer = APIRouter(prefix="/outer")
    outer.include_router(inner)
    outer.add_api_route("/plain", _page)
    app = FastAPI()
    app.include_router(outer, prefix="/api")
    return app


def test_walk_descends_into_nested_included_routers(script: ModuleType) -> None:
    routes = list(script._iter_routes(_nested_app().router.routes))
    websockets = {path for route, path in routes if isinstance(route, WebSocketRoute)}
    http = {path for route, path in routes if isinstance(route, Route)}
    assert websockets == {"/api/outer/inner/ws/{token}"}
    assert {"/api/outer/inner/hidden", "/api/outer/plain"} <= http
    # FastAPI's own docs endpoints stay in the walk; the check allow-lists them by path.
    assert {"/openapi.json", "/docs", "/redoc"} <= http


def test_walk_finds_the_websocket_routes_of_the_app(script: ModuleType, tmp_path: Path) -> None:
    app = make_app(workspace=tmp_path)
    websockets = {
        path
        for route, path in script._iter_routes(app.router.routes)
        if isinstance(route, WebSocketRoute)
    }
    assert websockets >= _APP_WEBSOCKETS


def test_the_app_passes_and_every_route_kind_is_reviewed(
    script: ModuleType, tmp_path: Path
) -> None:
    (tmp_path / "index.html").write_text("<html></html>", encoding="utf-8")
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    failures, openapi_rows, manual_rows = script._check(app)
    assert failures == []
    assert openapi_rows
    reviewed = {(kind, ident): marked for kind, ident, _source, marked in manual_rows}
    assert all(reviewed.values())
    assert {ident for kind, ident in reviewed if kind == "websocket"} >= _APP_WEBSOCKETS
    assert any(kind == "mount" for kind, _ident in reviewed)


def test_unmarked_routes_inside_included_routers_fail_the_check(script: ModuleType) -> None:
    failures, _openapi_rows, manual_rows = script._check(_nested_app())
    assert any(
        f.startswith("MANUAL-REVIEW websocket /api/outer/inner/ws/{token}") for f in failures
    )
    assert any(f.startswith("SCHEMA-INVISIBLE GET /api/outer/inner/hidden") for f in failures)
    assert [row[:2] for row in manual_rows] == [("websocket", "/api/outer/inner/ws/{token}")]


class _UnknownRoute(BaseRoute):
    """A route of a kind the check has no code for, such as a future placeholder type."""


def test_a_route_of_an_unknown_kind_fails_the_check(script: ModuleType) -> None:
    app = SimpleNamespace(
        router=SimpleNamespace(routes=[_UnknownRoute()]),
        openapi=lambda: {"paths": {}},
    )
    failures, _openapi_rows, _manual_rows = script._check(app)
    assert [f for f in failures if f.startswith("UNKNOWN-ROUTE _UnknownRoute")]
