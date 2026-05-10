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

from andes_app.api.auth import RequireToken
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


def _map_worker_error(exc: WorkerError) -> HTTPException:
    if exc.category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if exc.category == "SetupFailedError":
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{exc.detail} — call POST /api/sessions/{{id}}/reload to recover."
            ),
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{exc.category}: {exc.detail}",
    )


@router.post(
    "/sessions/{session_id}/tds",
    operation_id="runTds",
    summary="Run a time-domain simulation (batch mode; streaming lands in Unit 6).",
    response_model=TdsBatchResult,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
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
    _: RequireToken,
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc

    return TdsBatchResult(
        run_id=uuid.uuid4().hex,
        converged=bool(payload["converged"]),
        final_t=float(payload["final_t"]),
        callpert_count=int(payload["callpert_count"]),
    )


@router.post(
    "/sessions/{session_id}/abort",
    operation_id="abortRun",
    summary="Signal a cooperative abort of the active TDS run on a session.",
    response_model=AbortResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def abort_run(
    session_id: str,
    request: Request,
    _: RequireToken,
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
