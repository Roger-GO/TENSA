"""Disturbance specifications: discriminated union over Fault / Toggle / Alter.

These are the substrate's contract for how callers describe ANDES events.
The wrapper translates each ``DisturbanceSpec`` into the corresponding
``ss.add('Fault', ...)`` / ``ss.add('Toggle', ...)`` / ``ss.add('Alter', ...)``
keyword arguments at disturbance-add time. All disturbances require pre-setup
state — ANDES rejects post-setup ``add()`` calls regardless of model type
(verified against ANDES 2.0.0 ``andes/system/facade.py:362-407``).

The exact field-level mapping into ANDES kwargs is intentionally narrow here.
Fields beyond what's listed are out of scope for v0.2's editor UX (per the
plan); advanced users still drop into Python and edit ANDES models directly.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class FaultSpec(BaseModel):
    """3-phase-to-ground fault on a bus.

    Maps to ``ss.add('Fault', bus=..., tf=..., tc=..., xf=..., rf=...)``.
    Single-phase faults are not natively supported by ANDES and are not in
    scope (per Phase A plan).
    """

    kind: Literal["fault"] = Field(
        "fault",
        description="Discriminator: this spec creates an ANDES Fault device.",
    )
    bus_idx: int | str = Field(
        ..., description="ANDES idx of the bus where the fault is applied."
    )
    tf: float = Field(..., description="Time the fault is applied, in seconds.")
    tc: float = Field(
        ..., description="Time the fault is cleared, in seconds. Must be > tf."
    )
    xf: float = Field(0.0001, description="Fault reactance in pu.")
    rf: float = Field(0.0, description="Fault resistance in pu.")


class ToggleSpec(BaseModel):
    """Status toggle on a device — used for line trips, generator trips, etc.

    Maps to ``ss.add('Toggle', model=..., dev=..., t=...)``. Toggling sets the
    target device's status to its complement at time ``t`` (closed→open or
    open→closed).
    """

    kind: Literal["toggle"] = Field(
        "toggle",
        description="Discriminator: this spec creates an ANDES Toggle device.",
    )
    model: str = Field(
        ...,
        description=(
            "ANDES model class name whose device is being toggled. "
            "Examples: 'Line', 'GENROU', 'PV'."
        ),
    )
    dev_idx: int | str = Field(
        ..., description="ANDES idx of the device within ``model`` to toggle."
    )
    t: float = Field(..., description="Time the toggle fires, in seconds.")


class AlterSpec(BaseModel):
    """Parameter alteration at a scheduled time — used for load steps,
    parameter ramps, set-point changes, etc.

    Maps to ``ss.add('Alter', model=..., dev=..., src=..., t=..., value=...)``.
    """

    kind: Literal["alter"] = Field(
        "alter",
        description="Discriminator: this spec creates an ANDES Alter device.",
    )
    model: str = Field(
        ..., description="ANDES model class name containing the parameter."
    )
    dev_idx: int | str = Field(
        ..., description="ANDES idx of the device within ``model``."
    )
    src: str = Field(
        ...,
        description=(
            "Source parameter name on the model (e.g., 'p0' for active-power "
            "set-point on a generator)."
        ),
    )
    t: float = Field(..., description="Time the parameter change applies, in seconds.")
    value: float = Field(..., description="New value of the parameter at time ``t``.")


# Discriminated union — Pydantic v2 picks the variant by ``kind``.
DisturbanceSpec = Annotated[
    FaultSpec | ToggleSpec | AlterSpec,
    Field(discriminator="kind"),
]


__all__ = [
    "AlterSpec",
    "DisturbanceSpec",
    "FaultSpec",
    "ToggleSpec",
]
