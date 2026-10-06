"""Disturbances (a fault, a toggle, an alter): ``POST /sessions/{id}/disturbances``."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# The wrapper-level discriminated-union types, used here as the request body.
# They are Pydantic v2 models already, so they slot into FastAPI request bodies
# directly.
from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec


class AddDisturbancesRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/disturbances``.

    Accepts a list so a caller can register multiple disturbances in one
    request — useful for the v0.2 timeline editor that wants to commit a
    full study scenario at once. ANDES rejects all post-setup ``add()`` calls,
    so this endpoint is gated on pre-setup state (returns 409 otherwise with
    a hint to call ``/reload``).
    """

    model_config = ConfigDict(extra="forbid")

    disturbances: list[FaultSpec | ToggleSpec | AlterSpec] = Field(
        ...,
        description=(
            "List of disturbance specifications. Discriminated by the "
            "``kind`` field (``fault``, ``toggle``, ``alter``)."
        ),
        min_length=1,
    )


class DisturbanceAck(BaseModel):
    """One entry in the response to ``POST /sessions/{id}/disturbances``."""

    kind: Literal["fault", "toggle", "alter"] = Field(
        ..., description="Discriminator from the original spec."
    )
    idx: int | str = Field(
        ...,
        description=(
            "ANDES idx assigned to the created disturbance device. Use this "
            "to reference the disturbance in subsequent operations."
        ),
    )


class AddDisturbancesResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/disturbances``."""

    accepted: list[DisturbanceAck] = Field(
        ..., description="One ack entry per accepted disturbance, in input order."
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the disturbance-commit routine (kind "
            "``disturbance-commit``). One job covers the whole "
            "batch; ``null`` on legacy responses."
        ),
    )
