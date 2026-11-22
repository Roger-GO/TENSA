"""The Sienna network matrices of a session's case: ``GET /sessions/{id}/network-matrix``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import NetworkMatrixResponse, ProblemDetails
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError
from tensa.core.wrapper.ybus import MAX_YBUS_ENTRIES

router = APIRouter()

# Worker error categories this route answers itself, beside the shared map:
# the two network matrix refusals are 422 and no case is 409, as the pflow
# route's own categories are mapped in ``error_mapping``.
_CATEGORY_STATUS = {
    "NoCaseLoadedError": status.HTTP_409_CONFLICT,
    "NetworkMatrixKindError": status.HTTP_422_UNPROCESSABLE_CONTENT,
    "NetworkMatrixTooLargeError": status.HTTP_422_UNPROCESSABLE_CONTENT,
}


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


@router.get(
    "/sessions/{session_id}/network-matrix",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface reads the network matrices yet; the route is for "
            "scripts and agents. A later unit adds it to the network-analysis "
            "results panel."
        ),
    },
    operation_id="getNetworkMatrix",
    summary="Get a network matrix (ptdf, lodf, ybus or incidence) of the loaded case.",
    response_model=NetworkMatrixResponse,
    response_model_exclude_unset=True,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case has been loaded into this session yet, or the session's "
                "engine does not build network matrices (an ANDES session has "
                "GET /sessions/{id}/ybus instead)."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The kind is not one of ptdf, lodf, ybus, incidence, or the "
                f"matrix has more than {MAX_YBUS_ENTRIES} entries, the most one "
                "answer carries."
            ),
        },
    },
)
async def get_network_matrix(
    session_id: str,
    request: Request,
    kind: str = "ptdf",
) -> NetworkMatrixResponse:
    """One network matrix of the loaded case of a Sienna session, built by
    PowerNetworkMatrices: the PTDF, the LODF, the bus admittance matrix or the
    incidence matrix, in per unit on the system base. The axes name each row
    and column: arcs as ``from`` and ``to`` bus numbers with the keys of the
    branches on the arc, buses with their keys. The dense kinds answer the
    values inline, row by row; ``ybus`` answers its nonzero entries as sparse
    triplets. A matrix with more entries than one answer carries is a 422
    with the count.
    """
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(session_id, "network_matrix", {"kind": kind})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        http_status = _CATEGORY_STATUS.get(exc.category)
        if http_status is not None:
            raise HTTPException(status_code=http_status, detail=exc.detail) from exc
        raise map_worker_error(exc) from exc
    # Fields the kind does not carry (``values`` of a ybus, ``entries`` of a
    # dense kind, ``ref_buses`` of a ybus) are absent from the JSON, not null.
    return NetworkMatrixResponse.model_validate(payload)
