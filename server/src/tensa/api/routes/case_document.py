"""The neutral case document of a session's case: ``GET /sessions/{id}/case/neutral``.

The document of section 5 of ``design/multiengine/spec.md``: what the system
is, in terms that belong to TENSA, the same for every engine. There is no web
surface for it yet; one comes with the editing unit of Phase 8.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import CaseDocument, ProblemDetails
from tensa.core.session import (
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


@router.get(
    "/sessions/{session_id}/case/neutral",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "no web surface reads the case document yet; the Phase 8 editing "
            "unit that builds a session from one adds it"
        ),
    },
    operation_id="getCaseDocument",
    summary="The loaded case in the engine-neutral form of section 5.",
    response_model=CaseDocument,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {"model": ProblemDetails, "description": "No case has been loaded."},
    },
)
async def get_case_document(
    session_id: str,
    request: Request,
) -> CaseDocument:
    """The neutral case document of the session's loaded case."""
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(session_id, "case_document", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return CaseDocument.model_validate(payload)
