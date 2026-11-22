"""Session lifecycle endpoints.

``POST /sessions`` — create a new session (server-generated id; rejects
client-supplied ``session_id``).
``GET /sessions`` — list active sessions.
``GET /sessions/{id}`` — describe one. Counts as activity: a session is reaped
after ``--idle-timeout-seconds`` without any, so a client with nothing else to
send (the web UI, whose open tab checks in every 30 seconds) keeps its session
by calling this.
``DELETE /sessions/{id}`` — close one.
"""

from __future__ import annotations

import contextlib
import hashlib
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import ValidationError

from tensa.api.schemas import (
    CreateSessionRequest,
    ProblemDetails,
    SessionDescriptor,
    SessionList,
)
from tensa.core.errors import EngineUnavailableError
from tensa.core.session import SessionExpiredError, SessionManager
from tensa.engines.ops import DEFAULT_ENGINE

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


def workspace_id(workspace: Path) -> str:
    """An opaque name for the workspace folder ``workspace``.

    A digest of its path, cut to 16 hex digits: the same for one folder however
    often the server is started on it, another for another folder, and nothing a
    client can read the path back from.
    """
    return hashlib.sha256(str(workspace).encode("utf-8", "surrogatepass")).hexdigest()[:16]


def _descriptor(request: Request, session_id: str) -> SessionDescriptor:
    workspace = getattr(request.app.state, "workspace", None)
    mgr = _manager(request)
    return SessionDescriptor(
        session_id=session_id,
        state="live",
        workspace_id=workspace_id(workspace) if isinstance(workspace, Path) else "",
        engine=mgr.engine_of(session_id),
    )


@router.post(
    "/sessions",
    openapi_extra={"x-tensa-gui-location": "auto"},
    operation_id="createSession",
    summary="Create a new session backed by a fresh worker subprocess for its engine.",
    response_model=SessionDescriptor,
    status_code=status.HTTP_201_CREATED,
    responses={
        409: {
            "model": ProblemDetails,
            "description": "The named engine is not part of this build; the detail says why.",
        },
        422: {
            "model": ProblemDetails,
            "description": "Body failed validation (an unknown engine, or a field other than engine).",
        },
        429: {
            "model": ProblemDetails,
            "description": "max_sessions cap reached; retry after closing a session.",
        },
    },
)
async def create_session(
    request: Request
) -> SessionDescriptor:
    # A body is optional; ``CreateSessionRequest`` has ``extra="forbid"``, so a
    # client-supplied ``session_id`` (or any field but ``engine``) raises 422.
    engine = DEFAULT_ENGINE
    raw = await request.body()
    if raw:
        try:
            engine = CreateSessionRequest.model_validate_json(raw).engine
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    "POST /sessions accepts only an optional 'engine' field. "
                    "session_id is server-generated. "
                    f"validation errors: {exc.errors()}"
                ),
            ) from exc
    mgr = _manager(request)
    try:
        session_id = await mgr.create_session(engine)
    except EngineUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    return _descriptor(request, session_id)


@router.get(
    "/sessions",
    openapi_extra={"x-tensa-gui-location": "auto"},
    operation_id="listSessions",
    summary="List currently-active sessions.",
    response_model=SessionList,
)
async def list_sessions(request: Request) -> SessionList:
    mgr = _manager(request)
    return SessionList(
        sessions=[_descriptor(request, sid) for sid in mgr.list_sessions()]
    )


@router.get(
    "/sessions/{session_id}",
    openapi_extra={"x-tensa-gui-location": "auto"},
    operation_id="getSession",
    summary="Describe a session and count the call as activity.",
    response_model=SessionDescriptor,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def get_session(
    session_id: str, request: Request
) -> SessionDescriptor:
    mgr = _manager(request)
    # The call resets the idle clock. The web UI polls this while a tab is open,
    # so a session whose user is thinking (or has stepped away) is not reaped
    # under them; a 404 here is how the UI finds out the session is gone.
    if not mgr.is_alive(session_id) or not mgr.touch(session_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"session {session_id!r} is not active",
        )
    return _descriptor(request, session_id)


@router.delete(
    "/sessions/{session_id}",
    openapi_extra={"x-tensa-gui-location": "auto"},
    operation_id="closeSession",
    summary="Close a session and reap its worker subprocess.",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def close_session(
    session_id: str, request: Request
) -> None:
    mgr = _manager(request)
    # idempotent: closing an unknown session is a no-op
    with contextlib.suppress(SessionExpiredError):
        await mgr.close_session(session_id)
