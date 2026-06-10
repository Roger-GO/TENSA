"""Time-domain simulation endpoint (batch mode).

POST /sessions/{id}/tds runs TDS synchronously and returns a summary on
completion. Streaming mode (``?stream=ws``) lands in Unit 6 with the Arrow
IPC + WebSocket pipeline.

The wrapper (``run_tds``) calls ``ss.setup()`` first if not yet committed,
runs PF first if not yet converged (TDS requires PF), then ``ss.TDS.run()``
with ``callpert`` wired to count steps and check the abort flag.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from andes_app.api.error_mapping import map_worker_error
from andes_app.api.schemas import (
    AbortResponse,
    ProblemDetails,
    TdsBatchResult,
    TdsRunRequest,
)
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from andes_app.core.session import (
    _stream_error_problem as _job_error_problem,
)

router = APIRouter()


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


def _to_http_error(exc: WorkerError) -> HTTPException:
    """Route-local adapter over the shared ``map_worker_error`` (Unit 4b).

    The shared mapper owns the canonical category→status table (``no-case-loaded``
    → 409, ``SetupFailedError`` → 422), recovery, and the body shape. This route
    only appends the documented "reload to recover" hint to ``SetupFailedError``.
    """
    if exc.category == "SetupFailedError":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to recover."
        )
    return map_worker_error(exc)


@router.post(
    "/sessions/{session_id}/tds",
    openapi_extra={
        "x-andes-app-gui-location": "none",
        "x-andes-app-parity-deferred": "Batch (synchronous) TDS; the GUI runs TDS exclusively through the streaming WS channel (/ws/{session_id}) for live plotting. The batch POST is retained for CLI/agent/scripted use.",
    },
    operation_id="runTds",
    summary="Run a time-domain simulation (batch mode; streaming lands in Unit 6).",
    response_model=TdsBatchResult,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session.",
        },
        422: {
            "model": ProblemDetails,
            "description": "ANDES setup() failed; call /reload to recover.",
        },
    },
)
async def run_tds(
    session_id: str,
    body: TdsRunRequest,
    request: Request,
) -> TdsBatchResult:
    mgr = _manager(request)
    # Unit 16: forward integrator + tolerance overrides. The wrapper
    # validates ``integrator`` (Literal-bounded by Pydantic) and the
    # override keys (rtol/atol/max_step). ``tds_config_overrides`` is
    # only forwarded when non-None so the wire shape stays minimal for
    # the default trapezoidal path.
    args: dict[str, Any] = {
        "tf": body.tf,
        "h": body.h,
        "integrator": body.integrator,
    }
    if body.tds_config_overrides is not None:
        args["tds_config_overrides"] = body.tds_config_overrides

    # v3.1 Unit 5c: mirror the batch run as a first-class job whose ``job_id``
    # EQUALS the response's ``run_id`` (same value across both fields — additive,
    # nothing removed). The ``run_id`` is minted FIRST so it can seed the
    # registry id; the registry lifecycle (running → done / failed) is driven
    # inline here rather than via ``_run_as_job`` because that helper mints its
    # own id and we need the alias. Falls back to a bare ``run_id`` (no record)
    # when the session is already gone — the invoke below will 404 anyway.
    run_id = uuid.uuid4().hex
    registry = None
    try:
        registry = mgr.session_job_registry(session_id)
    except SessionExpiredError:
        registry = None
    if registry is not None:
        registry.register_job(
            kind="tds-batch",
            can_cancel=True,
            request_summary=body.model_dump(),
            job_id=run_id,
        )
        _broadcast_job(mgr, session_id, run_id)
        registry.mark_running(run_id)
        _broadcast_job(mgr, session_id, run_id)

    # Generous timeout: TDS for IEEE 14 / 1-second sim is sub-second; for
    # larger cases or longer horizons it can take minutes. The watchdog in
    # SessionManager handles wedged sessions; this timeout is a backstop.
    try:
        payload = await mgr.invoke(
            session_id,
            "run_tds",
            args,
            timeout=300.0,
        )
    except SessionExpiredError as exc:
        # Session is gone — the record (if any) goes with it. No reconcile.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        if registry is not None:
            survivor_id = registry.mark_failed(
                run_id, problem=_job_error_problem("tds-batch", (exc.category, exc.detail))
            )
            _broadcast_job(mgr, session_id, survivor_id)
        raise _to_http_error(exc) from exc
    except Exception as exc:
        # The inline tds-batch lifecycle re-implements register→mark_running→
        # mark_done/failed (instead of ``_run_as_job``) so it can alias
        # ``job_id`` onto the pre-minted ``run_id``. That re-opened the
        # "stuck ``running``" trap ``_run_as_job``'s ``except Exception`` was
        # written to close: ``mgr.invoke`` can also raise ``SessionBusyError``
        # (concurrent op on the session gate), ``SweepInProgressError`` (a
        # sweep holds the session), or ``asyncio.TimeoutError`` (the 300 s
        # backstop) — none of which are ``WorkerError``/``SessionExpiredError``.
        # The worker stays alive in all three cases, so the liveness sweeper
        # (dead-worker only) never rescues the record. Mark it failed here
        # before re-raising so the app-level handlers (SessionBusyError→409,
        # SweepInProgressError→503, TimeoutError→500) still render unchanged.
        # NOT BaseException — CancelledError/KeyboardInterrupt/SystemExit are
        # lifecycle signals, left to propagate untouched.
        if registry is not None:
            survivor_id = registry.mark_failed(
                run_id,
                problem=_job_error_problem(
                    "tds-batch", ("WorkerInternalError", str(exc))
                ),
            )
            _broadcast_job(mgr, session_id, survivor_id)
        raise

    if registry is not None:
        registry.mark_done(run_id)
        _broadcast_job(mgr, session_id, run_id)

    return TdsBatchResult(
        run_id=run_id,
        job_id=run_id,
        converged=bool(payload["converged"]),
        final_t=float(payload["final_t"]),
        callpert_count=int(payload["callpert_count"]),
    )


def _broadcast_job(mgr: SessionManager, session_id: str, job_id: str) -> None:
    """Broadcast the current state of ``job_id`` to the session's WS subscribers."""
    try:
        registry = mgr.session_job_registry(session_id)
    except SessionExpiredError:
        return
    record = registry.get_job(job_id)
    if record is not None:
        mgr.broadcast_job_event(session_id, record)


@router.post(
    "/sessions/{session_id}/abort",
    openapi_extra={"x-andes-app-gui-location": "run-controls"},
    operation_id="abortRun",
    summary="Signal a cooperative abort of the active TDS run on a session.",
    response_model=AbortResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def abort_run(
    session_id: str,
    request: Request,
) -> AbortResponse:
    """Set the session's abort event. Cooperatively terminates an active
    streaming or batch ``run_tds`` invocation at the next ``callpert``
    tick. Returns 200 immediately — the actual TDS exit is asynchronous
    on the worker.

    Session-scoped (not run-scoped): v0.2 has at most one active run per
    session, mirroring ``SessionManager.signal_abort``'s API. Calling
    abort while no TDS is running is a 200 no-op (the event is set but
    never consumed; subsequent runs will see and clear it).
    """
    mgr = _manager(request)
    try:
        await mgr.signal_abort(session_id)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    return AbortResponse(aborted=True)
