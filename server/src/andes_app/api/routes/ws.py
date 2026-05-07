"""WebSocket route for TDS streaming.

Wire protocol (text frames are JSON; binary frames are Arrow IPC stream
chunks):

  client → server (text)  {"type":"auth","token":"..."}            within 2 s
  server → client (text)  {"type":"ready"}                          on auth ok
  client → server (text)  {"type":"start_tds","tf":1.0,"h":0.0083}  start the run
  server → client (text)  {"type":"stream_start","metadata":{...}}  schema preamble
  server → client (binary) <Arrow IPC stream chunk>                 once per step
  server → client (binary) <Arrow IPC stream chunk>
                                       ...
  server → client (text)  {"type":"done","converged":true,"final_t":1.0,...}

Auth failures close with code 4401. Unknown session id closes with 4404.
Worker / wrapper errors close with code 4500 + a JSON ``{"type":"error",...}``
text frame just before close.

Single-message-state-machine on the client: open, send auth, send start_tds,
read frames until done. The server side is built on
``SessionManager.invoke_streaming`` which loops over the worker's data Pipe
and forwards each ``stream_start`` / ``stream_frame`` to the WS sender.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any

from fastapi import APIRouter, Request, WebSocket, status
from starlette.websockets import WebSocketDisconnect, WebSocketState

from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from andes_app.security.token import constant_time_eq

router = APIRouter()
log = logging.getLogger("andes-app.ws")

# WS close codes — RFC 6455 §7.4 reserves 4000-4999 for application use.
WS_CLOSE_AUTH_FAILED = 4401
WS_CLOSE_SESSION_NOT_FOUND = 4404
WS_CLOSE_WORKER_ERROR = 4500
WS_CLOSE_INTERNAL_ERROR = 4500

AUTH_DEADLINE_SECONDS = 2.0


def _expected_token(request: Request | WebSocket) -> str | None:
    return getattr(request.app.state, "expected_token", None)


def _manager(request: Request | WebSocket) -> SessionManager | None:
    return getattr(request.app.state, "session_manager", None)


@router.websocket("/ws/{session_id}")
async def ws_tds_stream(websocket: WebSocket, session_id: str) -> None:
    """WebSocket endpoint for streaming TDS results.

    Auth flow: client must send ``{"type":"auth","token":"..."}`` as the first
    text frame within ``AUTH_DEADLINE_SECONDS``. After auth succeeds, the
    server sends ``{"type":"ready"}`` and waits for ``start_tds``. While
    streaming, the worker emits per-step Arrow IPC batches that are forwarded
    as binary frames; the run ends with a ``done`` text frame and a clean
    close.
    """
    await websocket.accept()
    expected_token = _expected_token(websocket)
    mgr = _manager(websocket)
    if expected_token is None or mgr is None:
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, "server not configured"
        )
        return

    # ---- AUTH (first message; 2-second deadline) ----
    try:
        first = await asyncio.wait_for(
            websocket.receive_text(), timeout=AUTH_DEADLINE_SECONDS
        )
    except TimeoutError:
        await _close_with_error(
            websocket, WS_CLOSE_AUTH_FAILED, "auth deadline exceeded"
        )
        return
    except WebSocketDisconnect:
        return

    try:
        auth_msg = json.loads(first)
    except json.JSONDecodeError:
        await _close_with_error(websocket, WS_CLOSE_AUTH_FAILED, "auth message must be JSON")
        return

    if auth_msg.get("type") != "auth" or not constant_time_eq(
        expected_token, str(auth_msg.get("token", ""))
    ):
        await _close_with_error(websocket, WS_CLOSE_AUTH_FAILED, "invalid token")
        return

    if not mgr.is_alive(session_id):
        await _close_with_error(
            websocket,
            WS_CLOSE_SESSION_NOT_FOUND,
            f"session {session_id!r} is not active",
        )
        return

    await websocket.send_text(json.dumps({"type": "ready"}))

    # ---- START_TDS ----
    try:
        cfg_text = await websocket.receive_text()
    except WebSocketDisconnect:
        return
    try:
        cfg = json.loads(cfg_text)
    except json.JSONDecodeError:
        await _close_with_error(websocket, WS_CLOSE_INTERNAL_ERROR, "bad start message")
        return

    if cfg.get("type") != "start_tds":
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, f"expected start_tds, got {cfg.get('type')!r}"
        )
        return

    tf = float(cfg["tf"])
    h_raw = cfg.get("h")
    h = float(h_raw) if h_raw is not None else None

    # ---- STREAM ----
    async def _on_metadata(metadata: dict[str, Any]) -> None:
        msg = {"type": "stream_start", "metadata": metadata}
        await websocket.send_text(json.dumps(msg))

    async def _on_frame(payload: bytes) -> None:
        await websocket.send_bytes(payload)

    try:
        result = await mgr.invoke_streaming(
            session_id,
            "run_tds",
            {"tf": tf, "h": h, "stream": True},
            on_metadata=_on_metadata,
            on_frame=_on_frame,
            timeout=300.0,
        )
    except SessionExpiredError as exc:
        await _close_with_error(
            websocket, WS_CLOSE_SESSION_NOT_FOUND, str(exc)
        )
        return
    except WorkerError as exc:
        await _close_with_error(
            websocket,
            WS_CLOSE_WORKER_ERROR,
            f"{exc.category}: {exc.detail}",
        )
        return
    except Exception as exc:  # noqa: BLE001
        log.exception("internal error during streaming TDS")
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, f"internal error: {exc!s}"
        )
        return

    # Final result envelope
    done_msg = {
        "type": "done",
        "converged": bool(result.get("converged", False)),
        "final_t": float(result.get("final_t", 0.0)),
        "callpert_count": int(result.get("callpert_count", 0)),
    }
    if websocket.client_state == WebSocketState.CONNECTED:
        await websocket.send_text(json.dumps(done_msg))
        await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)


async def _close_with_error(
    websocket: WebSocket, code: int, reason: str
) -> None:
    """Send a structured error text frame (when possible) and close the socket."""
    if websocket.client_state != WebSocketState.CONNECTED:
        return
    with contextlib.suppress(Exception):
        await websocket.send_text(
            json.dumps({"type": "error", "code": code, "reason": reason})
        )
    with contextlib.suppress(Exception):
        await websocket.close(code=code, reason=reason[:120])
