"""Jobs API — v3.1 Unit 5a.

Read + cancel surface over the per-session ``_JobRegistry`` (plus the
manager-wide global registry for session-mutating jobs, KTD-20), and a
per-session multiplexed WebSocket that streams every job transition.

HTTP surface (all under the ``/api`` prefix):

- ``GET  /sessions/{id}/jobs`` — list jobs, optionally filtered by ``kind``
  and/or ``status`` query params. Returns ``JobRecordSchema[]``.
- ``GET  /sessions/{id}/jobs/{job_id}`` — fetch one job. 404 if unknown.
- ``DELETE /sessions/{id}/jobs/{job_id}`` — cancel a job. If the job is
  cancellable (``can_cancel == true``) it transitions to ``cancelled`` and the
  updated record is returned (200). If it is NOT cancellable, the request fails
  with ``409 Conflict`` carrying a ``wait-for-job`` recovery CTA (the job is
  running and must be waited out — ``conflict: job-running``, ``retryable:
  false`` in plan terms). 404 when the ``job_id`` is unknown.

WebSocket surface:

- ``WS /ws/{id}/jobs/events`` — per-session multiplexed feed. After the shared
  first-message auth handshake (``require_ws_auth``) the server sends a
  ``snapshot`` of the current job list, then one ``{job_id, kind, status,
  progress?, problem?}`` envelope per subsequent transition for ANY job in the
  session. Multiple subscribers each receive every broadcast with no loss.

Routine routes are untouched in this unit — the registry has read-only
consumers here plus the cancel transition; population lands in Unit 5b.
"""

from __future__ import annotations

import contextlib
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, status
from starlette.websockets import WebSocketDisconnect, WebSocketState

from andes_app.api.auth import RequireToken
from andes_app.api.routes.ws import require_ws_auth
from andes_app.api.schemas import (
    JobKindSchema,
    JobRecordSchema,
    JobStatusSchema,
    ProblemDetails,
)
from andes_app.core.errors import SessionBusyError
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    _job_event_envelope,
)

router = APIRouter()

log = logging.getLogger("andes-app.jobs")

# WS close codes — same alphabet as the TDS / sweep endpoints so clients can
# share the close-code translation logic.
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


def _job_to_schema(record: Any) -> JobRecordSchema:
    """Serialize a ``JobRecord`` dataclass through the wire schema."""
    return JobRecordSchema.model_validate(record, from_attributes=True)


# ---- HTTP routes ----------------------------------------------------------


@router.get(
    "/sessions/{session_id}/jobs",
    operation_id="listJobs",
    summary="List jobs for a session (v3.1 Unit 5a).",
    response_model=list[JobRecordSchema],
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def list_jobs(
    session_id: str,
    request: Request,
    _: RequireToken,
    kind: JobKindSchema | None = None,
    status_filter: JobStatusSchema | None = Query(
        default=None,
        alias="status",
        description="Optional lifecycle-state filter (pending/running/done/failed/cancelled).",
    ),
) -> list[JobRecordSchema]:
    """Return the session's jobs, newest-last, optionally filtered.

    ``kind`` filters by routine kind; ``status`` (the wire query param) filters
    by lifecycle state — aliased to the local ``status_filter`` so it doesn't
    shadow the imported ``status`` module. Both default to ``None`` (no
    filter). The list spans the per-session registry AND the manager-wide
    global registry so session-mutating jobs (KTD-20) surface here too.
    """
    mgr = _manager(request)
    try:
        records = mgr.list_session_jobs(session_id, kind=kind, status=status_filter)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    return [_job_to_schema(r) for r in records]


@router.get(
    "/sessions/{session_id}/jobs/{job_id}",
    operation_id="getJob",
    summary="Fetch one job by id (v3.1 Unit 5a).",
    response_model=JobRecordSchema,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {
            "model": ProblemDetails,
            "description": "Session or job not found.",
        },
    },
)
async def get_job(
    session_id: str,
    job_id: str,
    request: Request,
    _: RequireToken,
) -> JobRecordSchema:
    """Return one job record. 404 when the session or job id is unknown."""
    mgr = _manager(request)
    try:
        record = mgr.get_session_job(session_id, job_id)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"job {job_id!r} not found for session {session_id!r}",
        )
    return _job_to_schema(record)


@router.delete(
    "/sessions/{session_id}/jobs/{job_id}",
    operation_id="cancelJob",
    summary="Cancel a job (v3.1 Unit 5a).",
    response_model=JobRecordSchema,
    responses={
        200: {"description": "Job cancelled; the updated record is returned."},
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session or job not found."},
        409: {
            "model": ProblemDetails,
            "description": (
                "The job is not cancellable (a synchronous routine that must "
                "run to completion). Carries a ``wait-for-job`` recovery CTA."
            ),
        },
    },
)
async def cancel_job(
    session_id: str,
    job_id: str,
    request: Request,
    _: RequireToken,
) -> JobRecordSchema:
    """Cancel a job.

    - ``can_cancel == true`` → ``mark_cancelled`` + broadcast + 200 with the
      updated record.
    - ``can_cancel == false`` → 409 ``SessionBusyError`` (``wait-for-job``
      recovery, ``retryable: false``): the job is running and must be waited
      out. The shared ``SessionBusyError`` exception handler renders the
      ProblemDetails envelope with the recovery CTA + the ``current_job``.
    - Unknown job id → 404.
    """
    mgr = _manager(request)
    try:
        record = mgr.get_session_job(session_id, job_id)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"job {job_id!r} not found for session {session_id!r}",
        )

    if not record.can_cancel:
        # Non-cancellable running routine. ``SessionBusyError`` already encodes
        # the exact wire contract the activity panel keys off: 409 +
        # ``wait-for-job`` recovery + the in-flight ``current_job`` extra. The
        # app-level handler (``_session_busy_to_problem_details``) renders it.
        raise SessionBusyError(current_job=record)

    # Cancellable: transition + broadcast. ``get_session_job`` may have read
    # from the global registry, so resolve the owning registry the same way
    # the manager does and mutate there.
    cancelled = mgr.cancel_session_job(session_id, job_id)
    if cancelled is None:
        # Lost a race — the job was evicted/terminal between the read and the
        # cancel. Surface as 404 (no longer cancellable).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"job {job_id!r} is no longer cancellable",
        )
    return _job_to_schema(cancelled)


# ---- WebSocket: per-session multiplexed job events ------------------------


@router.websocket("/ws/{session_id}/jobs/events")
async def ws_job_events(websocket: WebSocket, session_id: str) -> None:
    """Per-session multiplexed job-event feed (v3.1 Unit 5a).

    Auth handshake mirrors the TDS / sweep endpoints via the shared
    ``require_ws_auth`` helper (first-message token, 2-second deadline, 4401
    close on failure; skipped when ``require_auth`` is False). After ``ready``,
    the server sends a ``snapshot`` of the current job list, then one envelope
    per subsequent transition for ANY job in the session.
    """
    await websocket.accept()
    mgr = getattr(websocket.app.state, "session_manager", None)
    if mgr is None or not isinstance(mgr, SessionManager):
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, "server not configured"
        )
        return

    if not await require_ws_auth(websocket):
        return

    if not mgr.is_alive(session_id):
        await _close_with_error(
            websocket,
            WS_CLOSE_SESSION_NOT_FOUND,
            f"session {session_id!r} is not active",
        )
        return

    await websocket.send_text(json.dumps({"type": "ready"}))

    # Initial snapshot of the current job list so a fresh subscriber renders
    # in-flight + recent jobs before live transitions arrive.
    try:
        snapshot = mgr.list_session_jobs(session_id)
    except SessionExpiredError as exc:
        await _close_with_error(websocket, WS_CLOSE_SESSION_NOT_FOUND, str(exc))
        return
    await websocket.send_text(
        json.dumps(
            {
                "type": "snapshot",
                "jobs": [_job_event_envelope(r) for r in snapshot],
            }
        )
    )

    # Live phase: drain the per-session event stream.
    try:
        async for envelope in mgr.subscribe_job_events(session_id):
            if websocket.client_state != WebSocketState.CONNECTED:
                return
            await websocket.send_text(json.dumps({"type": "job", **envelope}))
    except SessionExpiredError as exc:
        await _close_with_error(websocket, WS_CLOSE_SESSION_NOT_FOUND, str(exc))
        return
    except WebSocketDisconnect:
        return
    except Exception as exc:  # noqa: BLE001
        log.exception("internal error while streaming job events for %s", session_id)
        await _close_with_error(
            websocket, WS_CLOSE_INTERNAL_ERROR, f"internal error: {exc!s}"
        )
        return


async def _close_with_error(websocket: WebSocket, code: int, reason: str) -> None:
    """Send a structured error text frame (when possible) and close the socket."""
    if websocket.client_state != WebSocketState.CONNECTED:
        return
    with contextlib.suppress(Exception):
        await websocket.send_text(
            json.dumps({"type": "error", "code": code, "reason": reason})
        )
    with contextlib.suppress(Exception):
        await websocket.close(code=code, reason=reason[:120])
