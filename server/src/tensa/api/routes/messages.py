"""What ANDES said while a session's commands ran.

- ``GET /sessions/{id}/messages`` reads the session's message log: the warnings,
  errors and progress notes ANDES logged while the worker loaded a case, solved a
  power flow or integrated a time-domain run, each with its level and the command
  that was running.
- ``DELETE /sessions/{id}/messages`` empties it.

The log lives in the server, filled from the worker's replies (see
``tensa.core.messages``), so a read never waits for the worker: it answers while
a run is going, and what a streamed run has logged so far is already in it.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status

from tensa.api.schemas import (
    MessageLevelSchema,
    ProblemDetails,
    SessionMessages,
    SessionMessageSchema,
)
from tensa.core.session import SessionExpiredError, SessionManager

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
    "/sessions/{session_id}/messages",
    openapi_extra={"x-tensa-gui-location": "messages-panel"},
    operation_id="listMessages",
    summary="Read what ANDES said while the session's commands ran.",
    response_model=SessionMessages,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def list_messages(
    session_id: str,
    request: Request,
    after: Annotated[
        int,
        Query(
            ge=0,
            description=(
                "Only messages numbered above this. Pass the ``next_after`` of the "
                "previous read to get what came since; 0 reads from the start."
            ),
        ),
    ] = 0,
    level: Annotated[
        MessageLevelSchema,
        Query(
            description=(
                "The lowest level to return: ``warning`` gives warnings and errors, "
                "``error`` only errors."
            ),
        ),
    ] = "info",
    limit: Annotated[int, Query(ge=1, le=2000, description="Most messages to return.")] = 500,
) -> SessionMessages:
    """The messages ANDES logged for this session, oldest first, at most
    ``limit`` of them. Warnings and errors are what to look for after a run that
    gave an odd result; ``info`` adds how each run went (iteration counts, the
    events a time-domain run applied). A read costs the worker nothing and does
    not wait for a command in progress."""
    mgr = _manager(request)
    try:
        page = mgr.session_messages(session_id).page(after=after, min_level=level, limit=limit)
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return SessionMessages(
        messages=[
            SessionMessageSchema(
                seq=m.seq,
                time=m.time,
                level=m.level,
                logger=m.logger,
                source=m.source,
                text=m.text,
                repeat=m.repeat,
            )
            for m in page.messages
        ],
        first_seq=page.first_seq,
        last_seq=page.last_seq,
        next_after=page.next_after,
        dropped=page.dropped,
    )


@router.delete(
    "/sessions/{session_id}/messages",
    openapi_extra={"x-tensa-gui-location": "messages-panel"},
    operation_id="clearMessages",
    summary="Forget the session's messages.",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def clear_messages(session_id: str, request: Request) -> None:
    """Empty the session's message log. Message numbers go on from where they
    were, so a client that reads on from the last number it has sees only what
    is logged from now."""
    mgr = _manager(request)
    try:
        mgr.session_messages(session_id).clear()
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
