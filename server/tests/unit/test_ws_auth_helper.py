"""Unit 5a — the shared ``require_ws_auth`` WebSocket auth helper.

Extracted from the TDS WS handshake (``ws.py``) and reused by the new
``/jobs/events`` handler. Covered:

- valid token → returns True, consumes exactly the one auth frame;
- wrong token → closes 4401, returns False;
- malformed JSON → closes 4401, returns False;
- timeout → closes 4401, returns False;
- ``require_auth=False`` (the serve --no-auth dev toggle) → returns True
  WITHOUT reading any frame (so dev WS mode works without a token).

A tiny fake WebSocket records ``close`` calls and feeds canned frames.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

from andes_app.api.routes.ws import WS_CLOSE_AUTH_FAILED, require_ws_auth

VALID_TOKEN = "c" * 64


class _FakeWebSocket:
    """Minimal WebSocket stand-in for the auth handshake.

    ``frames`` is the queue of text frames ``receive_text`` returns; if it is
    empty, ``receive_text`` blocks forever (so the ``asyncio.wait_for`` deadline
    fires, exercising the timeout path).
    """

    def __init__(self, *, require_auth: bool, frames: list[str] | None = None) -> None:
        self.app = SimpleNamespace(
            state=SimpleNamespace(
                require_auth=require_auth, expected_token=VALID_TOKEN
            )
        )
        self._frames = list(frames or [])
        self.reads = 0
        self.closed_code: int | None = None
        self.sent: list[str] = []
        # The handler reads ``client_state`` in ``_close_with_error``; mimic a
        # connected socket so the close path runs.
        from starlette.websockets import WebSocketState

        self.client_state = WebSocketState.CONNECTED

    async def receive_text(self) -> str:
        self.reads += 1
        if not self._frames:
            # Block so the auth deadline trips (timeout path).
            await asyncio.sleep(3600)
        return self._frames.pop(0)

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_code = code
        from starlette.websockets import WebSocketState

        self.client_state = WebSocketState.DISCONNECTED


def test_valid_token_returns_true_and_consumes_one_frame() -> None:
    ws = _FakeWebSocket(
        require_auth=True,
        frames=[json.dumps({"type": "auth", "token": VALID_TOKEN})],
    )
    result = asyncio.run(require_ws_auth(ws))  # type: ignore[arg-type]
    assert result is True
    assert ws.reads == 1
    assert ws.closed_code is None


def test_wrong_token_closes_4401() -> None:
    ws = _FakeWebSocket(
        require_auth=True,
        frames=[json.dumps({"type": "auth", "token": "wrong"})],
    )
    result = asyncio.run(require_ws_auth(ws))  # type: ignore[arg-type]
    assert result is False
    assert ws.closed_code == WS_CLOSE_AUTH_FAILED


def test_malformed_json_closes_4401() -> None:
    ws = _FakeWebSocket(require_auth=True, frames=["not-json{"])
    result = asyncio.run(require_ws_auth(ws))  # type: ignore[arg-type]
    assert result is False
    assert ws.closed_code == WS_CLOSE_AUTH_FAILED


def test_timeout_closes_4401() -> None:
    async def _run() -> Any:
        ws = _FakeWebSocket(require_auth=True, frames=[])

        # Patch the deadline tiny so the test doesn't wait 2 seconds.
        import andes_app.api.routes.ws as ws_mod

        original = ws_mod.AUTH_DEADLINE_SECONDS
        ws_mod.AUTH_DEADLINE_SECONDS = 0.05
        try:
            result = await require_ws_auth(ws)  # type: ignore[arg-type]
        finally:
            ws_mod.AUTH_DEADLINE_SECONDS = original
        return ws, result

    ws, result = asyncio.run(_run())
    assert result is False
    assert ws.closed_code == WS_CLOSE_AUTH_FAILED


def test_no_auth_bypass_returns_true_without_reading() -> None:
    """``require_auth=False`` → no token needed, no frame consumed (mirrors the
    HTTP ``require_token`` no-op so --no-auth dev WS mode works)."""
    ws = _FakeWebSocket(require_auth=False, frames=[])
    result = asyncio.run(require_ws_auth(ws))  # type: ignore[arg-type]
    assert result is True
    assert ws.reads == 0
    assert ws.closed_code is None
