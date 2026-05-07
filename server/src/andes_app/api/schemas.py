"""Pydantic v2 request / response models for the HTTP API.

Every field has an explicit ``description`` (R25 acceptance: the
OpenAPI-to-MCP audit asserts no field has an empty description). Every error
response is shaped as ``ProblemDetails`` per RFC 7807.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# ---- error envelope ---------------------------------------------------------


class ProblemDetails(BaseModel):
    """RFC 7807 problem-details object. Used for all 4xx and 5xx responses."""

    model_config = ConfigDict(extra="allow")

    type: str = Field(
        "about:blank",
        description=(
            "URI reference identifying the problem type. ``about:blank`` "
            "means the title is the canonical reason for the status code."
        ),
    )
    title: str = Field(..., description="Short, human-readable summary of the problem.")
    status: int = Field(..., description="HTTP status code for this response.")
    detail: str | None = Field(
        None,
        description=(
            "Human-readable explanation specific to this occurrence of the "
            "problem (e.g., 'session id is required to be server-generated; "
            "remove the session_id field from your request body')."
        ),
    )
    instance: str | None = Field(
        None,
        description="URI reference that identifies the specific occurrence of the problem.",
    )


# ---- session resources ------------------------------------------------------


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
