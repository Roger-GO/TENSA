"""The session resource: create, describe and list."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateSessionRequest(BaseModel):
    """Request body for ``POST /sessions``. Empty by design — the
    ``session_id`` is server-generated; client-supplied values are rejected."""

    model_config = ConfigDict(extra="forbid")


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


class SessionList(BaseModel):
    """Response shape for ``GET /sessions``."""

    sessions: list[SessionDescriptor] = Field(
        ..., description="Snapshot of currently-active sessions for this token."
    )
