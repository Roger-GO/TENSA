"""The session resource: create, describe and list."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateSessionRequest(BaseModel):
    """Request body for ``POST /sessions``. A body is optional; ``engine`` is the
    only field it may carry. The ``session_id`` stays server-generated;
    client-supplied values are rejected."""

    model_config = ConfigDict(extra="forbid")

    engine: Literal["andes", "sienna"] = Field(
        "andes",
        description=(
            "The engine the session runs. A session is created for one engine and "
            "keeps it; a body that names none (or no body at all) creates an ANDES "
            "session. An engine this build cannot start is refused with 409."
        ),
    )


class SessionDescriptor(BaseModel):
    """Response shape for session create / read."""

    session_id: str = Field(
        ...,
        description=(
            "Server-generated UUID-shaped opaque identifier for the session. "
            "Use it in subsequent URL paths (e.g., ``/sessions/{session_id}/case``)."
        ),
    )
    state: Literal["live", "closed"] = Field(
        ...,
        description=(
            "``live`` if the worker subprocess is alive and accepting commands; "
            "``closed`` if the session has been reaped or explicitly closed."
        ),
    )
    workspace_id: str = Field(
        "",
        description=(
            "An opaque name for the workspace folder this server serves: the same for "
            "every session of one folder, and another for another folder. It is a digest "
            "and holds no path. A client that keeps something by case file name (the web "
            "UI keeps the drafts of a diagram in the browser) keys it by this as well, so "
            "that a file of the same name in another workspace is another case."
        ),
    )
    engine: str = Field(
        ...,
        description=(
            "The engine the session runs (``andes``, ``sienna``). A session is created "
            "for one engine and keeps it; the capabilities of the engine are listed by "
            "``GET /engines``, not repeated here."
        ),
    )


class SessionList(BaseModel):
    """Response shape for ``GET /sessions``."""

    sessions: list[SessionDescriptor] = Field(
        ..., description="Snapshot of currently-active sessions for this token."
    )
