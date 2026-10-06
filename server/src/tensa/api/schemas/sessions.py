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


class SessionList(BaseModel):
    """Response shape for ``GET /sessions``."""

    sessions: list[SessionDescriptor] = Field(
        ..., description="Snapshot of currently-active sessions for this token."
    )
