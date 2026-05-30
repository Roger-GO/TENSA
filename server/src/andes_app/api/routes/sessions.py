"""Session lifecycle endpoints.

``POST /sessions`` — create a new session (server-generated id; rejects
client-supplied ``session_id``).
``GET /sessions`` — list active sessions.
``GET /sessions/{id}`` — describe one.
``DELETE /sessions/{id}`` — close one.
"""

from __future__ import annotations

import contextlib

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import ValidationError

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import (
    CreateSessionRequest,
    ProblemDetails,
    SessionDescriptor,
    SessionList,
)
from andes_app.core.session import SessionExpiredError, SessionManager

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


@router.post(
    "/sessions",
    openapi_extra={"x-andes-app-gui-location": "auto"},
    operation_id="createSession",
    summary="Create a new session backed by a fresh ANDES worker subprocess.",
    response_model=SessionDescriptor,
    status_code=status.HTTP_201_CREATED,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        422: {
            "model": ProblemDetails,
            "description": "Body included a client-supplied session_id (rejected).",
        },
        429: {
            "model": ProblemDetails,
            "description": "max_sessions cap reached; retry after closing a session.",
        },
    },
)
async def create_session(
    request: Request, _: RequireToken
) -> SessionDescriptor:
    # Reject any non-empty body. ``CreateSessionRequest`` has ``extra="forbid"``,
    # so client-supplied ``session_id`` (or any other field) raises 422.
    raw = await request.body()
    if raw:
        try:
            CreateSessionRequest.model_validate_json(raw)
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    "POST /sessions does not accept any body fields. "
                    "session_id is server-generated. "
                    f"validation errors: {exc.errors()}"
                ),
            ) from exc
    mgr = _manager(request)
    try:
        session_id = await mgr.create_session()
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    return SessionDescriptor(session_id=session_id, state="live")


@router.get(
    "/sessions",
    openapi_extra={"x-andes-app-gui-location": "auto"},
    operation_id="listSessions",
    summary="List currently-active sessions.",
    response_model=SessionList,
    responses={401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."}},
)
async def list_sessions(request: Request, _: RequireToken) -> SessionList:
    mgr = _manager(request)
    return SessionList(
        sessions=[SessionDescriptor(session_id=sid, state="live") for sid in mgr.list_sessions()]
    )


@router.get(
    "/sessions/{session_id}",
    openapi_extra={
        "x-andes-app-gui-location": "none",
        "x-andes-app-parity-deferred": "Session metadata is not surfaced standalone in the GUI; the web client tracks the active session client-side and never issues a bare GET /sessions/{id}.",
    },
    operation_id="getSession",
    summary="Describe a session.",
    response_model=SessionDescriptor,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def get_session(
    session_id: str, request: Request, _: RequireToken
) -> SessionDescriptor:
    mgr = _manager(request)
    if not mgr.is_alive(session_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"session {session_id!r} is not active",
        )
    return SessionDescriptor(session_id=session_id, state="live")


@router.delete(
    "/sessions/{session_id}",
    openapi_extra={"x-andes-app-gui-location": "auto"},
    operation_id="closeSession",
    summary="Close a session and reap its worker subprocess.",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
    },
)
async def close_session(
    session_id: str, request: Request, _: RequireToken
) -> None:
    mgr = _manager(request)
    # idempotent: closing an unknown session is a no-op
    with contextlib.suppress(SessionExpiredError):
        await mgr.close_session(session_id)
