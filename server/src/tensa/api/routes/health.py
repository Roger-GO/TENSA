"""Health endpoint: whether the server is up, and the few facts a monitor wants.

``GET /health`` answers from the server's own state: the two package versions, how
many sessions are open against the cap, and whether ANDES's generated code is
ready. It touches no worker and takes no session's lock, so it answers while a
run or a sweep holds every session, and a script, a process supervisor or a
container health check can poll it. It needs no session and no case, and costs
a few ``stat`` calls.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from tensa import __version__, andes_version
from tensa.core.codegen_cache import CacheState, background_warm_running, cache_state
from tensa.core.session import SessionManager

router = APIRouter()


class HealthSessions(BaseModel):
    """How full the server is."""

    active: int = Field(..., description="Sessions open now, each with its own worker process.")
    max: int = Field(
        ...,
        description="Cap on open sessions (``--max-sessions``). Creating one past it answers 429.",
    )


class HealthCache(BaseModel):
    """State of ANDES's generated code (``~/.andes/pycode``), which a case load needs."""

    state: Literal["ready", "unchecked", "missing"] = Field(
        ...,
        description=(
            "``ready``: generated and checked against the installed ANDES. "
            "``unchecked``: there is code, but nothing has checked it against this ANDES "
            "(it was upgraded, or another ANDES regenerated the code). "
            "``missing``: ANDES has generated nothing yet."
        ),
    )
    warm: bool = Field(
        ...,
        description="True when ``state`` is ``ready``: the next case load does not generate code.",
    )
    generating: bool = Field(
        ...,
        description=(
            "True while the server's background process is generating the code. A case "
            "loaded meanwhile waits for it."
        ),
    )


class HealthResponse(BaseModel):
    """Response shape for ``GET /health``."""

    status: Literal["ok"] = Field(
        ..., description="Always ``ok``: a server that cannot answer sends no response."
    )
    version: str = Field(..., description="Installed tensa version.")
    andes_version: str = Field(
        ...,
        description="Installed ANDES version, or ``unknown`` when its package metadata is missing.",
    )
    sessions: HealthSessions = Field(
        ..., description="How many sessions are open, against the cap on them."
    )
    cache: HealthCache = Field(
        ...,
        description=(
            "Whether ANDES's generated code is ready, so that a case load does not "
            "wait for it."
        ),
    )


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


def _cache_state(version: str) -> CacheState:
    try:
        return cache_state(version)
    except RuntimeError:  # no home directory to look in, so ANDES has no code there either
        return "missing"


@router.get(
    "/health",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": "Operations probe for scripts, process supervisors and container health checks. The UI reads GET /version for its About dialog and GET /sessions/{id} for session liveness.",
    },
    operation_id="getHealth",
    summary="Report that the server is up, with its versions, session load and code-cache state.",
    response_model=HealthResponse,
)
async def get_health(request: Request) -> HealthResponse:
    """Reads the session registry and a few files; nothing here waits for a worker."""
    mgr = _manager(request)
    version = andes_version()
    state = _cache_state(version)
    return HealthResponse(
        status="ok",
        version=__version__,
        andes_version=version,
        sessions=HealthSessions(
            active=len(mgr.list_sessions()),
            max=int(request.app.state.max_sessions),
        ),
        cache=HealthCache(
            state=state,
            warm=state == "ready",
            generating=background_warm_running(),
        ),
    )
