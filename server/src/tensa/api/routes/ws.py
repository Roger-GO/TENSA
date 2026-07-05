"""WebSocket route for TDS streaming.

Wire protocol (text frames are JSON; binary frames are Arrow IPC stream
chunks):

  server → client (text)  {"type":"ready"}    once the session is validated

  --- new run ---
  client → server (text)  {"type":"start_tds","tf":1.0,"h":0.0083}  start the run
  server → client (text)  {"type":"stream_start","run_id":"...",    schema preamble +
                            "metadata":{...}}                       run identifier
  server → client (binary) <Arrow IPC stream chunk with frame_seq=N>
                                       ...
  server → client (text)  {"type":"done","converged":true,"final_t":1.0,...}

  --- resume an existing run after WS drop ---
  client → server (text)  {"type":"resume","run_id":"...","last_seq":N}
  server → client (text)  {"type":"stream_start","run_id":"...",    re-emitted so the
                            "metadata":{...}}                       client decoder
                                                                    can rebuild
  server → client (binary) <Arrow IPC stream chunk for seq N+1>
                                       ...                          buffered + live
  server → client (text)  {"type":"done",...}

Frames carry a monotonic ``frame_seq`` (matching the server-side ``seq``)
so the client can resume from the last frame it processed. The server's
ring buffer holds ~30 seconds of frames at the configured output rate;
reconnect attempts past that window receive ``{"type":"resync",...}`` and
must re-fetch via the batch endpoint.

Unknown session id closes with 4404. Unknown run_id on resume closes with
4404. Worker / wrapper errors close with code 4500 + a JSON
``{"type":"error",...}`` text frame just before close.
"""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

from fastapi import APIRouter, Request, WebSocket, status
from starlette.websockets import WebSocketDisconnect, WebSocketState

from tensa.core.session import (
    SessionExpiredError,
    SessionManager,
)
from tensa.core.stream import DEFAULT_VARS, VAR_GROUPS

router = APIRouter()
log = logging.getLogger("tensa.ws")

# WS close codes — RFC 6455 §7.4 reserves 4000-4999 for application use.
WS_CLOSE_SESSION_NOT_FOUND = 4404
WS_CLOSE_WORKER_ERROR = 4500
WS_CLOSE_INTERNAL_ERROR = 4500


def _manager(request: Request | WebSocket) -> SessionManager | None:
    return getattr(request.app.state, "session_manager", None)


# parity-reviewed: 2026-05-30 — gui-location: run-controls. The TDS "Run"
# affordance (web/src/components/tds/RunButton.tsx) opens this WS for live
# streaming plots; it is the GUI's sole TDS path (batch POST /tds is CLI-only).
@router.websocket("/ws/{session_id}")
async def ws_tds_stream(websocket: WebSocket, session_id: str) -> None:
    """WebSocket endpoint for streaming TDS results.

    Flow: the server accepts the connection, validates the session (4404
    close on unknown session), then sends ``{"type":"ready"}`` and waits for
    ``start_tds`` (or ``resume``). While streaming, the worker emits per-step
    Arrow IPC batches that are forwarded as binary frames; the run ends with
    a ``done`` text frame and a clean close.
    """
    await websocket.accept()
    mgr = _manager(websocket)
    if mgr is None:
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, "server not configured"
        )
        return

    if not mgr.is_alive(session_id):
        await _close_with_error(
            websocket,
            WS_CLOSE_SESSION_NOT_FOUND,
            f"session {session_id!r} is not active",
        )
        return

    await websocket.send_text(json.dumps({"type": "ready"}))

    # ---- START_TDS or RESUME ----
    try:
        cfg_text = await websocket.receive_text()
    except WebSocketDisconnect:
        return
    try:
        cfg = json.loads(cfg_text)
    except json.JSONDecodeError:
        await _close_with_error(websocket, WS_CLOSE_INTERNAL_ERROR, "bad start message")
        return

    cfg_type = cfg.get("type")
    if cfg_type == "resume":
        await _handle_resume(websocket, mgr, session_id, cfg)
        return
    if cfg_type != "start_tds":
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            f"expected start_tds or resume, got {cfg_type!r}",
        )
        return

    # New run path.
    try:
        tf = float(cfg["tf"])
    except (KeyError, TypeError, ValueError):
        await _close_with_error(websocket, WS_CLOSE_INTERNAL_ERROR, "missing or invalid 'tf'")
        return
    h_raw = cfg.get("h")
    h = float(h_raw) if h_raw is not None else None

    # Optional decimation controls. Defaults match the v0.1 baseline: every
    # callpert step is one row in its own one-row Arrow batch (algorithm
    # "none"). ``decimation="mean"`` requires ``max_rate_hz``; the worker
    # raises if the combination is invalid and the WS surface translates
    # that to a structured error.
    decimation_raw = cfg.get("decimation", "none")
    if decimation_raw not in ("none", "mean"):
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            f"unknown decimation mode {decimation_raw!r}; expected 'none' or 'mean'",
        )
        return
    max_rate_hz_raw = cfg.get("max_rate_hz")
    max_rate_hz = float(max_rate_hz_raw) if max_rate_hz_raw is not None else None
    if decimation_raw == "mean" and max_rate_hz is None:
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            "decimation='mean' requires max_rate_hz to be set",
        )
        return

    # Optional ``vars`` selector — picks which variable groups (bus_v,
    # gen_state, line_flow) appear as columns in each Arrow record batch.
    # Validation lives here (not just in the schemas/Pydantic layer) because
    # the WS path doesn't go through FastAPI request-body machinery.
    vars_raw = cfg.get("vars", list(DEFAULT_VARS))
    if not isinstance(vars_raw, list) or not all(
        isinstance(v, str) for v in vars_raw
    ):
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            "'vars' must be a list of variable-group strings",
        )
        return
    if not vars_raw:
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            "'vars' must be a non-empty list when provided",
        )
        return
    unknown = [v for v in vars_raw if v not in VAR_GROUPS]
    if unknown:
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            f"unknown var group(s) {unknown!r}; expected one of {list(VAR_GROUPS)!r}",
        )
        return

    # Optional Unit 16 fields: integrator + tolerance overrides. These
    # default to the trapezoidal-fixed-step path so existing clients see
    # no change. Validation is light-touch here (literal + dict shape);
    # the wrapper raises ``SetupFailedError`` on unknown override keys
    # which the WS path surfaces as a worker_error close.
    integrator_raw = cfg.get("integrator", "trapezoidal")
    if integrator_raw not in ("trapezoidal", "qndf"):
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            f"unknown integrator {integrator_raw!r}; expected 'trapezoidal' or 'qndf'",
        )
        return
    overrides_raw = cfg.get("tds_config_overrides")
    if overrides_raw is not None and not isinstance(overrides_raw, dict):
        await _close_with_error(
            websocket,
            WS_CLOSE_INTERNAL_ERROR,
            "'tds_config_overrides' must be an object of {string → number}; "
            "keys are canonical aliases (rtol/atol/max_step) or real "
            "ss.TDS.config field names, validated by the substrate",
        )
        return

    # Start the streaming run as a background task; the run survives WS
    # disconnect and can be resumed via {"type":"resume",...}.
    run_args: dict[str, Any] = {
        "tf": tf,
        "h": h,
        "stream": True,
        "decimation": decimation_raw,
        "max_rate_hz": max_rate_hz,
        "vars": vars_raw,
        "integrator": integrator_raw,
    }
    if overrides_raw is not None:
        run_args["tds_config_overrides"] = overrides_raw
    try:
        run_id = await mgr.start_streaming_run(
            session_id,
            "run_tds",
            run_args,
        )
    except SessionExpiredError as exc:
        await _close_with_error(websocket, WS_CLOSE_SESSION_NOT_FOUND, str(exc))
        return

    await _stream_run_to_websocket(
        websocket, mgr, session_id, run_id, last_seq=0, include_run_id_in_metadata=True
    )


async def _handle_resume(
    websocket: WebSocket,
    mgr: SessionManager,
    session_id: str,
    cfg: dict[str, Any],
) -> None:
    """Validate a resume request and stream the rest of the run to the WS."""
    run_id_raw = cfg.get("run_id")
    last_seq_raw = cfg.get("last_seq", 0)
    if not isinstance(run_id_raw, str) or not run_id_raw:
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, "resume requires a 'run_id'"
        )
        return
    try:
        last_seq = int(last_seq_raw)
    except (TypeError, ValueError):
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, "resume 'last_seq' must be an integer"
        )
        return
    if last_seq < 0:
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, "resume 'last_seq' must be >= 0"
        )
        return

    await _stream_run_to_websocket(
        websocket,
        mgr,
        session_id,
        run_id_raw,
        last_seq=last_seq,
        include_run_id_in_metadata=True,
    )


async def _stream_run_to_websocket(
    websocket: WebSocket,
    mgr: SessionManager,
    session_id: str,
    run_id: str,
    *,
    last_seq: int,
    include_run_id_in_metadata: bool,
) -> None:
    """Pump events from ``mgr.attach_to_run`` to the WebSocket. Translates
    each event to the appropriate JSON text or binary frame, then closes."""
    try:
        async for event in mgr.attach_to_run(session_id, run_id, last_seq):
            event_type = event.get("type")
            if event_type == "not_found":
                await _close_with_error(
                    websocket,
                    WS_CLOSE_SESSION_NOT_FOUND,
                    f"run {run_id!r} not found for this session",
                )
                return
            if event_type == "resync":
                msg = {
                    "type": "resync",
                    "run_id": run_id,
                    "current_seq": int(event.get("current_seq", 0)),
                    "reason": (
                        "frame fell out of the resume buffer; "
                        "re-fetch via the batch endpoint"
                    ),
                }
                if websocket.client_state == WebSocketState.CONNECTED:
                    await websocket.send_text(json.dumps(msg))
                    await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
                return
            if event_type == "metadata":
                msg = {"type": "stream_start", "metadata": event.get("data", {})}
                if include_run_id_in_metadata:
                    msg["run_id"] = run_id
                await websocket.send_text(json.dumps(msg))
            elif event_type == "frame":
                await websocket.send_bytes(event["payload"])
            elif event_type == "done":
                result = event.get("result") or {}
                done_msg = {
                    "type": "done",
                    "run_id": run_id,
                    "converged": bool(result.get("converged", False)),
                    "final_t": float(result.get("final_t", 0.0)),
                    "callpert_count": int(result.get("callpert_count", 0)),
                }
                if websocket.client_state == WebSocketState.CONNECTED:
                    await websocket.send_text(json.dumps(done_msg))
                    await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
                return
            elif event_type == "error":
                category = str(event.get("category", "unknown"))
                detail = str(event.get("detail", ""))
                await _close_with_error(
                    websocket,
                    WS_CLOSE_WORKER_ERROR,
                    f"{category}: {detail}",
                )
                return
    except WebSocketDisconnect:
        # Client went away mid-stream. The run continues running in the
        # background buffer; client can reconnect with {"type":"resume",...}.
        return
    except Exception as exc:  # noqa: BLE001
        log.exception("internal error while streaming run %s", run_id)
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, f"internal error: {exc!s}"
        )
        return


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
