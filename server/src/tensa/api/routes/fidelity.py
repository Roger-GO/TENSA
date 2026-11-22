"""The fidelity report of a session's case: ``GET /sessions/{id}/fidelity``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import FidelityEntry, FidelityReport, ProblemDetails
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError

router = APIRouter()

# Worker error categories this route answers itself, beside the shared map:
# no case is 409, as the topology route's own category is mapped.
_CATEGORY_STATUS = {
    "NoCaseLoadedError": status.HTTP_409_CONFLICT,
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
    "/sessions/{session_id}/fidelity",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface reads the fidelity report yet; the route is for "
            "scripts and agents. A later unit adds it to the case view."
        ),
    },
    operation_id="getSessionFidelity",
    summary="List the elements of the loaded case whose fidelity is not exact.",
    response_model=FidelityReport,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
    },
)
async def get_session_fidelity(session_id: str, request: Request) -> FidelityReport:
    """The fidelity report of the loaded case (spec section 8): one entry per
    dynamic model whose state is not ``exact`` for the session's engine, plus
    one per record the engine dropped on load, sorted by key. ANDES is the
    reference engine, so an ANDES session whose dynamics are all common models
    answers an empty list.
    """
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(session_id, "fidelity", {})
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
    # The session's engine, from the registry's own record (the invoke above
    # already answered, so the session is live).
    engine = mgr._sessions[session_id].engine  # noqa: SLF001
    return FidelityReport(
        session_id=session_id,
        engine=engine,
        entries=[FidelityEntry.model_validate(row) for row in payload],
    )
