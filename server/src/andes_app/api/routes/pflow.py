"""Power-flow endpoints.

POST /sessions/{id}/pflow runs PF synchronously. The wrapper calls
``ss.setup()`` first if not yet committed (verified: PFlow.run does not
auto-call setup; see ANDES_VERSIONS.md contract #6). After this, no further
disturbances can be added until /reload.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import PflowResult, PflowRunRequest, ProblemDetails
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


def _result_from_payload(payload: dict[str, Any], run_id: str) -> PflowResult:
    """Build a PflowResult response model from the wrapper's serialized
    PflowResult dict. The wrapper sends bus_voltages / bus_angles keyed by
    Python idx values (which can be int or str on the wire); JSON object keys
    must be strings, so we stringify them at the boundary."""
    return PflowResult(
        run_id=run_id,
        converged=bool(payload["converged"]),
        iterations=int(payload["iterations"]),
        mismatch=float(payload["mismatch"]),
        bus_voltages={str(k): float(v) for k, v in payload["bus_voltages"].items()},
        bus_angles={str(k): float(v) for k, v in payload["bus_angles"].items()},
    )


def _map_worker_error(exc: WorkerError) -> HTTPException:
    category = exc.category
    if category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if category == "SetupFailedError":
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{exc.detail} — call POST /sessions/{{id}}/reload to recover."
            ),
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{category}: {exc.detail}",
    )


@router.post(
    "/sessions/{session_id}/pflow",
    operation_id="runPflow",
    summary="Run power flow on the session's loaded case.",
    response_model=PflowResult,
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
async def run_pflow(
    session_id: str,
    body: PflowRunRequest,  # noqa: ARG001 — accepted for forward-compat
    request: Request,
    _: RequireToken,
) -> PflowResult:
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "run_pflow", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc

    run_id = uuid.uuid4().hex
    return _result_from_payload(payload, run_id)
