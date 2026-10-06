"""The request log: one ``DEBUG`` line per request, so ``--log-level debug`` shows
what a client asked for.

uvicorn's access log is off, which left the log with a startup line and nothing about
the requests that followed. The middleware is pure ASGI and the outermost layer, so
the requests the Host/Origin check turns away are in it as well.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tensa.api.app import make_app
from tensa.api.request_log import make_request_log_middleware

pytestmark = pytest.mark.unit

Inner = Callable[[Any, Any, Any], Awaitable[None]]


@pytest.fixture(autouse=True)
def _debug(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="tensa.request")


def _lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "tensa.request"]


async def _drive(inner: Inner, scope: dict[str, Any]) -> list[dict[str, Any]]:
    """Call the wrapped ``inner`` with ``scope``; return what reached the server."""
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await make_request_log_middleware(inner)(scope, receive, send)
    return sent


def _responds(status: int) -> Inner:
    async def inner(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b"ok", "more_body": False})

    return inner


def _get(path: str = "/api/sessions", **extra: Any) -> dict[str, Any]:
    return {"type": "http", "method": "GET", "path": path, "query_string": b"", **extra}


# ---- HTTP ---------------------------------------------------------------------


async def test_a_request_is_one_line_with_method_path_status_and_time(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sent = await _drive(_responds(200), _get())
    (line,) = _lines(caplog)
    assert re.fullmatch(r"GET /api/sessions -> 200 \(\d+ ms\)", line), line
    (record,) = [r for r in caplog.records if r.name == "tensa.request"]
    assert record.levelno == logging.DEBUG
    # The response goes through as the app sent it.
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]
    assert sent[0]["status"] == 200


async def test_the_status_is_the_one_the_app_sent(caplog: pytest.LogCaptureFixture) -> None:
    await _drive(_responds(404), _get("/api/nothing-here"))
    assert _lines(caplog)[0].startswith("GET /api/nothing-here -> 404 (")


async def test_nothing_is_logged_above_debug(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="tensa.request")
    sent = await _drive(_responds(200), _get())
    assert _lines(caplog) == []
    assert sent[0]["status"] == 200  # and the request still went through


async def test_the_query_string_is_not_logged(caplog: pytest.LogCaptureFixture) -> None:
    scope = _get("/api/cases", query_string=b"path=/home/me/secret-case.xlsx")
    await _drive(_responds(200), scope)
    assert "secret" not in _lines(caplog)[0]
    assert "/api/cases ->" in _lines(caplog)[0]


async def test_a_path_cannot_break_a_log_line(caplog: pytest.LogCaptureFixture) -> None:
    await _drive(_responds(404), _get("/api/x\nERROR forged line\r"))
    (line,) = _lines(caplog)
    assert "\n" not in line and "\r" not in line
    assert "%0A" in line


async def test_an_app_that_fails_before_it_responds_is_logged_as_500_and_raises(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def broken(scope: Any, receive: Any, send: Any) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await _drive(broken, _get())
    assert _lines(caplog)[0].startswith("GET /api/sessions -> 500 (")


async def test_a_failure_after_the_response_started_keeps_its_status(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def breaks_midway(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        raise RuntimeError("stream broke")

    with pytest.raises(RuntimeError, match="stream broke"):
        await _drive(breaks_midway, _get())
    assert _lines(caplog)[0].startswith("GET /api/sessions -> 200 (")


async def test_a_request_that_never_got_a_response_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def gone(scope: Any, receive: Any, send: Any) -> None:
        return None

    await _drive(gone, _get())
    assert _lines(caplog)[0].startswith("GET /api/sessions -> no response (")


async def test_other_scopes_pass_through_without_a_line(caplog: pytest.LogCaptureFixture) -> None:
    seen: list[str] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        seen.append(scope["type"])

    await _drive(inner, {"type": "lifespan"})
    assert seen == ["lifespan"]
    assert _lines(caplog) == []


# ---- WebSocket ----------------------------------------------------------------


async def test_a_websocket_is_logged_when_accepted_and_when_it_ends(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def inner(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "websocket.accept"})
        await send({"type": "websocket.close", "code": 1000})

    scope = {"type": "websocket", "path": "/api/sessions/abc/jobs/ws", "query_string": b""}
    await _drive(inner, scope)
    accepted, closed = _lines(caplog)
    assert accepted == "WEBSOCKET /api/sessions/abc/jobs/ws accepted"
    assert re.fullmatch(r"WEBSOCKET /api/sessions/abc/jobs/ws closed after \d+\.\d s", closed)


async def test_a_websocket_turned_away_is_logged_as_refused(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def inner(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "websocket.close", "code": 1008})

    await _drive(inner, {"type": "websocket", "path": "/api/x/ws", "query_string": b""})
    assert _lines(caplog) == ["WEBSOCKET /api/x/ws refused"]


# ---- through the app ----------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
    app = make_app(workspace=tmp_path, bind_port=8000, static_override=static)
    return TestClient(app, base_url="http://127.0.0.1:8000")


def test_the_app_logs_what_it_serves(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    client.get("/api/version")
    client.get("/api/nothing-here")
    client.get("/")
    lines = _lines(caplog)
    assert [line.split(" (")[0] for line in lines] == [
        "GET /api/version -> 200",
        "GET /api/nothing-here -> 404",
        "GET / -> 200",
    ]


def test_the_app_logs_a_request_the_host_check_rejects(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """The log is outside the Host/Origin check, so a rejection is in it: the first
    thing to look for when a browser tab gets a 400."""
    response = client.get("/api/version", headers={"Host": "evil.example"})
    assert response.status_code == 400
    assert _lines(caplog)[0].startswith("GET /api/version -> 400 (")


def test_the_app_logs_a_websocket_the_origin_check_rejects(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/api/sessions/abc/jobs/ws", headers={"Origin": "http://evil.example"}),
    ):
        pass
    assert _lines(caplog) == ["WEBSOCKET /api/sessions/abc/jobs/ws refused"]


def test_the_app_logs_nothing_at_the_default_level(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO, logger="tensa.request")
    client.get("/api/version")
    assert _lines(caplog) == []
