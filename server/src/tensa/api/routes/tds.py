"""Time-domain simulation endpoint (batch mode).

POST /sessions/{id}/tds runs TDS synchronously and returns a summary on
completion. Streaming runs use the WebSocket at ``/ws/{session_id}`` instead,
which sends Arrow IPC frames while the run is in progress.

The wrapper (``run_tds``) calls ``ss.setup()`` first if not yet committed,
runs PF first if not yet converged (TDS requires PF), then ``ss.TDS.run()``
with ``callpert`` wired to count steps, check the abort flag and run the
request's controllers (``tensa.core.tds_controllers``).
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import (
    AbortResponse,
    DaeVariableInfo,
    DaeVariableList,
    ProblemDetails,
    TdsBatchResult,
    TdsControllerCatalogue,
    TdsControllerResult,
    TdsRunRequest,
    TdsTraces,
    TdsTraceSeries,
)
from tensa.core.errors import SetupFailedError
from tensa.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from tensa.core.session import (
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
    only swaps the hint ``SetupFailedError`` ends with (``reload_case()``, the
    Python API's wording) for the documented "reload to recover" endpoint, so
    the caller reads one hint, not both.
    """
    if exc.category == "SetupFailedError":
        message = exc.detail.removesuffix(SetupFailedError.RECOVERY_HINT)
        exc.detail = (
            f"{message} — call POST /api/sessions/{{id}}/reload to recover."
        )
    return map_worker_error(exc)


@router.post(
    "/sessions/{session_id}/tds",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": "Batch (synchronous) TDS; the GUI runs TDS exclusively through the streaming WS channel (/ws/{session_id}) for live plotting. The batch POST is retained for CLI/agent/scripted use.",
    },
    operation_id="runTds",
    summary="Run a time-domain simulation (batch mode; stream live frames over the /ws/{session_id} WebSocket).",
    response_model=TdsBatchResult,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES setup() failed (call /reload to recover), or the request names a "
                "step size or an override ANDES must not be given, or a controller the "
                "loaded case cannot bind (nothing was written, so there is nothing to "
                "reload)."
            ),
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
    if body.dae_vars:
        args["dae_vars"] = body.dae_vars
    if body.controllers:
        args["controllers"] = [controller.model_dump() for controller in body.controllers]

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

    traces = payload.get("traces")
    controllers = payload.get("controllers")
    return TdsBatchResult(
        run_id=run_id,
        job_id=run_id,
        converged=bool(payload["converged"]),
        final_t=float(payload["final_t"]),
        callpert_count=int(payload["callpert_count"]),
        traces=(
            TdsTraces(
                t=traces["t"],
                variables=[TdsTraceSeries(**v) for v in traces["variables"]],
                truncated=bool(traces["truncated"]),
            )
            if traces
            else None
        ),
        controllers=(
            [TdsControllerResult(**controller) for controller in controllers]
            if controllers
            else None
        ),
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


@router.get(
    "/sessions/{session_id}/dae-variables",
    openapi_extra={"x-tensa-gui-location": "run-controls"},
    operation_id="listDaeVariables",
    summary="List the ANDES variables of the loaded case that a TDS run can record.",
    response_model=DaeVariableList,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def list_dae_variables(
    session_id: str,
    request: Request,
    q: Annotated[
        str | None,
        Query(
            max_length=200,
            description=(
                "Words that must all appear in the variable's name, whatever their "
                "case: ``omega gen`` finds ``omega GENROU 1``."
            ),
        ),
    ] = None,
    kind: Annotated[
        Literal["x", "y"] | None,
        Query(description="``x`` for state variables only, ``y`` for algebraic ones only."),
    ] = None,
    model: Annotated[
        str | None,
        Query(max_length=100, description="Only this ANDES model's variables (``GENROU``)."),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=1000, description="Page size.")] = 100,
    offset: Annotated[int, Query(ge=0, description="Matches to skip.")] = 0,
) -> DaeVariableList:
    """The states and algebraic variables ANDES keeps for the loaded case's
    devices, named as ``dae.x_name`` / ``dae.y_name`` name them, for the
    ``dae_vars`` of a TDS request. Needs no setup, so asking does not close the
    case to new disturbances. A static generator that a dynamic one replaces
    keeps no algebraic variables in a TDS run and is left out. With no case
    loaded the list is empty (a 200, as for the disturbance list)."""
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(
            session_id,
            "list_dae_variables",
            {"q": q, "kind": kind, "model": model, "limit": limit, "offset": offset},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return DaeVariableList(
        total=int(payload["total"]),
        items=[DaeVariableInfo(**item) for item in payload["items"]],
    )


@router.get(
    "/sessions/{session_id}/tds/controllers",
    openapi_extra={"x-tensa-gui-location": "run-controls"},
    operation_id="listTdsControllers",
    summary="List the controllers a TDS run takes and the devices of the loaded case they can command.",
    response_model=TdsControllerCatalogue,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def list_tds_controllers(session_id: str, request: Request) -> TdsControllerCatalogue:
    """The kinds of controller a TDS request's ``controllers`` can name (a
    frequency droop, a fast frequency response) and the devices of the loaded
    case each can command, with the ANDES variables to record to watch one at
    work. Needs no setup, so asking does not close the case to new
    disturbances. With no case loaded the list of devices is empty (a 200, as
    for the variable list)."""
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "list_tds_controllers", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return TdsControllerCatalogue(**payload)


@router.post(
    "/sessions/{session_id}/abort",
    openapi_extra={"x-tensa-gui-location": "run-controls"},
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
