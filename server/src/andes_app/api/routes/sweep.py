"""Sensitivity sweep API — Unit 18 of the v2.0 plan.

Two surfaces:

- ``POST /sessions/{id}/sweep`` — start a sweep. Returns the
  ``sweep_id`` immediately; the actual work runs as a background task
  on the SessionManager and pumps per-iteration progress into a
  ``_SweepBuffer``. While the sweep is active, the session's
  ``sweep_in_progress`` flag is set and other session-scoped routes
  return ``503 Service Unavailable`` via the ``SweepInProgressError``
  → 503 mapping in their own ``invoke()`` calls (see
  ``SessionManager.invoke``).

- ``WS /api/ws/{session_id}/sweep/{sweep_id}`` — progress channel.
  The wire protocol mirrors the TDS WS endpoint but ships JSON text
  envelopes only (no Arrow IPC binary frames):

      server → client (text)  {"type":"ready"}
      server → client (text)  {"type":"snapshot","sweep_id":...,
                               "total":N,"iterations_so_far":[...],
                               "state":"running"}
      server → client (text)  {"type":"iteration","iteration":N,...}
                              ...
      server → client (text)  {"type":"finished","state":"completed"
                               | "error" | "aborted"}

  The client may pass ``?last_iteration=N`` in the URL query string to
  resume — iterations with ``iteration <= N`` are skipped. The
  default is ``-1`` (replay every iteration).

The sweep snapshot-restart pattern is the substrate's contract for
deterministic per-iteration runs; the wrapper's ``run_sweep``
implementation lives in ``andes_app.core.wrapper.Wrapper.run_sweep``.
"""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket, status
from pydantic import BaseModel, ConfigDict, Field
from starlette.websockets import WebSocketDisconnect, WebSocketState

from andes_app.api.schemas import ProblemDetails
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    SweepInProgressError,
)
from andes_app.core.sweep import (
    SweepRequest,
    SweepValidationError,
    parse_sweep_target,
)

router = APIRouter()

log = logging.getLogger("andes-app.sweep")


# WS close codes — same alphabet as the TDS streaming endpoint so
# clients can share the close-code translation logic.
WS_CLOSE_SESSION_NOT_FOUND = 4404
WS_CLOSE_INTERNAL_ERROR = 4500


def _manager(request: Request | WebSocket) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


# ---- response shapes -------------------------------------------------------


class StartSweepResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/sweep``."""

    model_config = ConfigDict(extra="forbid")

    sweep_id: str = Field(
        ...,
        description=(
            "Identifier the WS progress channel keys on. The UI uses "
            "this to subscribe via ``/api/ws/{session_id}/sweep/{sweep_id}``."
        ),
    )
    total: int = Field(
        ..., description="Number of iterations the sweep will run."
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this sweep (v3.1 Unit 5c). Additive "
            "and IDENTICAL to ``sweep_id`` — the two fields alias the same "
            "value, with ``sweep_id`` preserved for backward compatibility. "
            "``GET /sessions/{id}/jobs/{job_id}`` returns the matching "
            "``JobRecord`` (kind ``sweep``)."
        ),
    )


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/sweep",
    openapi_extra={"x-andes-app-gui-location": "sweep-dialog"},
    operation_id="startSweep",
    summary="Start a sensitivity sweep — Unit 18.",
    response_model=StartSweepResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        202: {"description": "Sweep started; subscribe to the WS channel for progress."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "A sweep is already running on this session OR no "
                "snapshot was found by the requested name."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Invalid sweep parameter kind, target out of range, or "
                "snapshot has no matching disturbance."
            ),
        },
    },
)
async def start_sweep(
    session_id: str,
    body: SweepRequest,
    request: Request,
) -> StartSweepResponse:
    """Start a sweep. Returns immediately; the WS channel emits progress.

    Validates the parameter kind locally (so a bad request doesn't
    waste a worker round trip), materialises the parameter range, then
    schedules the background task via ``SessionManager.start_sweep``.
    The ``sweep_in_progress`` flag is set BEFORE this call returns so
    the next session-scoped route call observes it.
    """
    mgr = _manager(request)

    # Materialise the range early so the route can fail fast on invalid
    # inputs rather than letting the worker reject them mid-iteration.
    try:
        parse_sweep_target(body.parameter.kind)
    except SweepValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    values = body.parameter.range.values()

    sweep_args: dict[str, Any] = {
        "snapshot_name": body.snapshot_name,
        "parameter_kind": body.parameter.kind,
        "parameter_target": body.parameter.target,
        "values": values,
        "tf": body.sim.tf,
        "h": body.sim.h,
    }

    try:
        sweep_id = await mgr.start_sweep(session_id, sweep_args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except SweepInProgressError as exc:
        # 409: a sweep is already running on this session. The user
        # must wait for it to finish or call ``/abort`` first.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc

    # v3.1 Unit 5c: ``job_id`` aliases ``sweep_id`` (same value across both
    # fields) — the sweep is registered as a first-class job inside
    # ``SessionManager.start_sweep``. Additive: nothing is removed.
    return StartSweepResponse(
        sweep_id=sweep_id, total=len(values), job_id=sweep_id
    )


# ---- WS progress channel --------------------------------------------------


# parity-reviewed: 2026-05-30 — gui-location: sweep-dialog. The sweep dialog
# (web/src/streaming/SweepStream.ts, opened from SweepDialog.tsx) subscribes
# here for per-iteration progress after POST /sweep starts the run.
@router.websocket("/ws/{session_id}/sweep/{sweep_id}")
async def ws_sweep_progress(
    websocket: WebSocket, session_id: str, sweep_id: str
) -> None:
    """WebSocket endpoint for streaming sweep iteration progress.

    Mirrors the TDS WS: the server accepts the connection, validates the
    session (4404 close on unknown session), sends ``{"type":"ready"}``,
    and immediately starts pumping the ``attach_to_sweep`` async iterator.
    """
    await websocket.accept()
    mgr_obj = getattr(websocket.app.state, "session_manager", None)
    if mgr_obj is None:
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, "server not configured"
        )
        return
    mgr: SessionManager = mgr_obj

    if not mgr.is_alive(session_id):
        await _close_with_error(
            websocket,
            WS_CLOSE_SESSION_NOT_FOUND,
            f"session {session_id!r} is not active",
        )
        return

    # Optional resume cursor in the URL query string. Default to ``-1``
    # so the client receives every iteration starting at index 0.
    last_iteration_raw = websocket.query_params.get("last_iteration", "-1")
    try:
        last_iteration = int(last_iteration_raw)
    except (TypeError, ValueError):
        last_iteration = -1

    await websocket.send_text(json.dumps({"type": "ready"}))

    # ---- pump events ----
    try:
        async for event in mgr.attach_to_sweep(session_id, sweep_id, last_iteration):
            event_type = event.get("type")
            if event_type == "not_found":
                await _close_with_error(
                    websocket,
                    WS_CLOSE_SESSION_NOT_FOUND,
                    f"sweep {sweep_id!r} not found for this session",
                )
                return
            if websocket.client_state != WebSocketState.CONNECTED:
                return
            await websocket.send_text(json.dumps(event))
            if event_type == "finished":
                await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
                return
    except WebSocketDisconnect:
        return
    except Exception as exc:  # noqa: BLE001
        log.exception("internal error while streaming sweep %s", sweep_id)
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
