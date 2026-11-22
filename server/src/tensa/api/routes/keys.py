"""The keys of a session's case: ``GET /sessions/{id}/keys``.

A key names an element the same way in every engine (section 4 of
``design/multiengine/spec.md``); this route lists them all, the way
``GET /sessions/{id}/topology`` lists the topology.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import KeyEntrySchema, KeyList, ProblemDetails
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
    "/sessions/{session_id}/keys",
    openapi_extra={"x-tensa-gui-location": "auto"},
    operation_id="listKeys",
    summary="List the keys of the loaded case's elements, in assignment order.",
    response_model=KeyList,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def list_keys(
    session_id: str,
    request: Request,
) -> KeyList:
    """Every key of the case, each with its bucket, model, idx and source, and
    the problems the assignment noted. With no case loaded the lists are empty:
    a listing is a read."""
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(session_id, "list_keys", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return KeyList(
        keys=[KeyEntrySchema(**entry) for entry in payload.get("keys", [])],
        problems=[str(problem) for problem in payload.get("problems", [])],
    )
