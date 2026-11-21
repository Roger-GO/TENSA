"""The bus admittance matrix of a session's case: ``GET /sessions/{id}/ybus``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ProblemDetails, YbusResponse
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError
from tensa.core.wrapper.ybus import MAX_YBUS_ENTRIES

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


# parity-reviewed: 2026-11-20. No web surface reads the matrix yet; it is for
# scripts and agents, and will later appear on the network-analysis results panel.
@router.get(
    "/sessions/{session_id}/ybus",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface reads the bus admittance matrix yet; the route is for "
            "scripts and agents. It will later appear on the network-analysis "
            "results panel."
        ),
    },
    operation_id="getBusAdmittanceMatrix",
    summary="Get the bus admittance matrix of the loaded case, as sparse triplets.",
    response_model=YbusResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES setup() failed before the matrix could be built (recovery "
                "reload-case: POST /api/sessions/{id}/reload), or the matrix has "
                f"more than {MAX_YBUS_ENTRIES} nonzero entries, the most one "
                "answer carries."
            ),
        },
    },
)
async def get_bus_admittance_matrix(
    session_id: str,
    request: Request,
) -> YbusResponse:
    """The bus admittance matrix ANDES builds from the case's lines,
    transformers and shunts, in per unit on the system base, as the nonzero
    entries with ``bus_idx`` and ``bus_key`` naming the bus of each row and
    column. It reflects the status of each device at the time of the call.

    ANDES builds the matrix only on a System that is set up, so the wrapper
    sets it up first when it is not, as the connectivity check does; after
    that no disturbance can be added until the case is reloaded. No power
    flow is needed. A ``SetupFailedError`` answers 422 with its reload hint and
    the ``reload-case`` recovery.
    """
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(session_id, "bus_admittance_matrix", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return YbusResponse.model_validate(payload)
