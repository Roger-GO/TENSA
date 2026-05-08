"""Disturbance management endpoint.

POST /sessions/{id}/disturbances accepts a list of FaultSpec / ToggleSpec /
AlterSpec, all gated by pre-setup state. ANDES rejects post-setup
``add()`` calls regardless of model type, so this endpoint returns 409 with
guidance to call ``/reload`` once the System has been committed.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import (
    AddDisturbancesRequest,
    AddDisturbancesResponse,
    DisturbanceAck,
    ProblemDetails,
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
    """Translate WorkerError categories into HTTP responses for this endpoint."""
    if exc.category == "disturbance-commit":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{exc.detail} — call POST /api/sessions/{{id}}/reload to return "
                "to pre-setup state."
            ),
        )
    if exc.category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if exc.category in {"DisturbanceValidationError", "CaseLoadError"}:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.detail,
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{exc.category}: {exc.detail}",
    )


@router.post(
    "/sessions/{session_id}/disturbances",
    operation_id="addDisturbances",
    summary="Register one or more disturbances on a pre-setup session.",
    response_model=AddDisturbancesResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "Session has already been committed (PF or TDS has run); "
                "call POST /api/sessions/{id}/reload to return to pre-setup."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": "ANDES rejected one of the disturbance specs (e.g., bad bus idx).",
        },
    },
)
async def add_disturbances(
    session_id: str,
    body: AddDisturbancesRequest,
    request: Request,
    _: RequireToken,
) -> AddDisturbancesResponse:
    mgr = _manager(request)
    accepted: list[DisturbanceAck] = []
    for spec in body.disturbances:
        try:
            idx = await mgr.invoke(
                session_id,
                "add_disturbance",
                {"spec": spec.model_dump()},
            )
        except SessionExpiredError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=str(exc),
            ) from exc
        except WorkerError as exc:
            raise _map_worker_error(exc) from exc
        accepted.append(DisturbanceAck(kind=spec.kind, idx=idx))
    return AddDisturbancesResponse(accepted=accepted)
