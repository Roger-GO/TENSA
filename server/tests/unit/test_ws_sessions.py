"""How the tests leave a WebSocket: ``tests/_ws.py``.

Starlette's test client cancels a route the moment its socket is left, so a test
that opens a socket with ``client.websocket_connect`` ends the route at a point
that changes with the timing of the run. ``websocket_session`` closes the socket
and waits for the route to return first. These tests hold it to that on routes
made for the purpose, and hold the suite to opening its sockets through it.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import pytest
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocket, WebSocketDisconnect

from tests._ws import websocket_session

pytestmark = pytest.mark.unit

# How each call of the slow route ended.
_ended: list[str] = []


async def _slow_to_end(websocket: WebSocket) -> None:
    """A route that still has something to do after its client has gone."""
    await websocket.accept()
    with contextlib.suppress(WebSocketDisconnect):
        await websocket.receive_text()
    try:
        await asyncio.sleep(0.05)
    except asyncio.CancelledError:
        _ended.append("cancelled")
        raise
    _ended.append("returned")


async def _never_ends(websocket: WebSocket) -> None:
    """A route that does not look at its socket, and so outlives its client."""
    await websocket.accept()
    await asyncio.Event().wait()


async def _refuses(websocket: WebSocket) -> None:
    await websocket.close(code=1008)


@pytest.fixture
def client() -> TestClient:
    _ended.clear()
    return TestClient(
        Starlette(
            routes=[
                WebSocketRoute("/slow", _slow_to_end),
                WebSocketRoute("/stuck", _never_ends),
                WebSocketRoute("/refused", _refuses),
            ]
        )
    )


def test_the_route_has_returned_by_the_time_the_block_is_left(client: TestClient) -> None:
    """Left through the client alone, this route is cancelled in its last wait."""
    with websocket_session(client, "/slow"):
        pass
    assert _ended == ["returned"]


def test_a_route_that_outlives_its_client_fails_the_test_that_opened_it(
    client: TestClient,
) -> None:
    with (
        pytest.raises(AssertionError, match="the route of /stuck had not returned 0.05 s after"),
        websocket_session(client, "/stuck", route_end_timeout=0.05),
    ):
        pass


def test_a_failure_in_the_block_is_reported_as_itself(client: TestClient) -> None:
    """Without the wait: on this route it would turn the failure into a timeout."""
    with (
        pytest.raises(ValueError, match="the test's own"),
        websocket_session(client, "/stuck", route_end_timeout=0.05),
    ):
        raise ValueError("the test's own")


def test_a_refused_connection_raises_where_the_socket_is_opened(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as refused, websocket_session(client, "/refused"):
        pytest.fail("the block of a refused socket ran")
    assert refused.value.code == 1008


def test_every_test_opens_its_sockets_with_the_shared_helper() -> None:
    """A socket opened on the client itself is left with the route still running."""
    tests_dir = Path(__file__).resolve().parents[1]
    own = {tests_dir / "_ws.py", Path(__file__).resolve()}
    strays = [
        path.relative_to(tests_dir).as_posix()
        for path in sorted(tests_dir.rglob("*.py"))
        if path not in own and "websocket_connect" in path.read_text(encoding="utf-8")
    ]
    assert strays == []
