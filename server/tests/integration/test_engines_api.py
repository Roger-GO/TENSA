"""Integration tests for the engine routes: ``GET /engines`` and creating a
session for an engine.

A real FastAPI app over an ASGI transport; no worker is spawned for the
listing, and a session is spawned only where the test says so. What the tests
assert of Sienna follows the environment: on a machine with Julia and the
Sienna project set up the engine is available and a session starts; elsewhere
it is reported unavailable with the reason and a session is refused with 409.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager
from tensa.engines.sienna.environment import sienna_unavailable_reason

pytestmark = pytest.mark.integration

_SIENNA_REASON = sienna_unavailable_reason()
_SIENNA_OPS = [
    "add_disturbance",
    "clear_disturbances",
    "eig_participation",
    "init_tds",
    "list_disturbances",
    "list_keys",
    "load_case",
    "network_matrix",
    "operating_point",
    "reload_case",
    "run_eig",
    "run_pflow",
    "run_tds",
    "topology",
]


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh app (no sessions started
    by the fixture itself)."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace

    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def test_list_engines(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/engines")
    assert resp.status_code == 200, resp.text
    engines = resp.json()["engines"]
    assert [e["name"] for e in engines] == ["andes", "sienna"]
    andes, sienna = engines
    assert andes["available"] is True
    assert andes["unavailable_reason"] is None
    assert andes["versions"]["andes"]
    assert andes["editing"] is True
    assert "run_tds" in andes["ops"]
    if _SIENNA_REASON is None:
        assert sienna["available"] is True
        assert sienna["unavailable_reason"] is None
        # The Manifest of the session's project holds julia and PowerSystems.
        assert sienna["versions"]["julia"]
        assert sienna["versions"]["PowerSystems"]
        assert all(
            isinstance(k, str) and isinstance(v, str)
            for k, v in sienna["versions"].items()
        )
        assert sienna["formats"] == {
            "read": ["psse-raw", "psse-dyr", "matpower"],
            "write": [],
        }
        assert sienna["routines"] == ["matrices", "pflow", "eig", "tds"]
        assert sienna["ops"] == _SIENNA_OPS
        assert sienna["editing"] is False
    else:
        assert sienna["available"] is False
        assert sienna["unavailable_reason"] == _SIENNA_REASON
        assert sienna["versions"] == {}
        assert sienna["formats"] == {"read": [], "write": []}
        assert sienna["routines"] == []
        assert sienna["ops"] == []
        assert sienna["editing"] is False


@pytest.mark.skipif(
    _SIENNA_REASON is None,
    reason="Sienna's Julia runtime is available on this machine",
)
async def test_create_session_with_sienna_is_409(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions", json={"engine": "sienna"})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["detail"] == f"the sienna engine is not available: {_SIENNA_REASON}"


@pytest.mark.skipif(
    _SIENNA_REASON is not None,
    reason="Sienna's Julia runtime is not available",
)
async def test_create_session_with_sienna_starts(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions", json={"engine": "sienna"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["engine"] == "sienna"
    assert body["state"] == "live"


async def test_create_session_with_an_unknown_engine_is_422(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post("/api/sessions", json={"engine": "nope"})
    assert resp.status_code == 422, resp.text


async def test_create_session_defaults_to_andes(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    assert resp.json()["engine"] == "andes"
