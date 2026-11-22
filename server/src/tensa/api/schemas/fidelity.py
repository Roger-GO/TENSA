"""Response models for the fidelity route (spec section 8)."""

from __future__ import annotations

from pydantic import BaseModel, Field


class FidelityEntry(BaseModel):
    """One element of the loaded case whose fidelity is not exact."""

    key: str = Field(
        description="The element's key, as GET /sessions/{id}/keys gives it."
    )
    model: str = Field(description="The TENSA kind of the dynamic model, e.g. TGOV1.")
    state: str = Field(
        description=(
            "The fidelity state: known-difference:<id>, unverified or unsupported. "
            "Elements that are exact are not listed."
        )
    )
    handling: str | None = Field(
        default=None,
        description="Only on an unsupported entry: what the adapter did, dropped.",
    )
    reason: str | None = Field(
        default=None,
        description="Only on an unsupported entry: why the engine cannot hold the model.",
    )
    detail: str | None = Field(
        default=None,
        description="Only on a known-difference entry: the register entry's summary.",
    )


class FidelityReport(BaseModel):
    """The elements of the loaded case whose fidelity is not exact."""

    session_id: str = Field(description="The session this report is for.")
    engine: str = Field(description="The engine the session runs.")
    entries: list[FidelityEntry] = Field(
        description="One entry per element that is not exact, sorted by key."
    )
