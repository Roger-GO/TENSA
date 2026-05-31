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

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator


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

    Maps to ``ss.add('Alter', model=..., dev=..., src=..., t=..., method=...,
    amount=...)``. ANDES's ``Alter`` model has NO ``value`` parameter — the new
    value is ``v_new = v_current <method> amount`` where ``method`` is one of
    ``+ - * / =`` and ``amount`` is the operand (verified against ANDES 2.0.0;
    ``method`` is MANDATORY — omitting it raises "Mandatory parameter method
    missing"). Examples:

    - set absolute: ``method='=', amount=1.2``
    - step up by 0.2 pu: ``method='+', amount=0.2``
    - scale (e.g. +20% load): ``method='*', amount=1.2``

    NOTE for load increases: ANDES applies time-domain alterations to ``Ppf`` /
    ``Qpf`` on PQ loads, not ``p0`` / ``q0`` (the latter only feed power flow and
    are no-ops in TDS) — pick ``Ppf``/``Qpf`` as ``src`` for a load change that
    actually moves the simulation.
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
            "Source parameter name on the model (e.g., 'Ppf' for a PQ load's "
            "time-domain active power, or a generator set-point)."
        ),
    )
    t: float = Field(..., description="Time the parameter change applies, in seconds.")
    method: Literal["+", "-", "*", "/", "="] = Field(
        "=",
        description=(
            "How ``amount`` is combined with the parameter's current value: "
            "'=' set, '+' add, '-' subtract, '*' multiply, '/' divide. "
            "Mandatory in ANDES; defaults to '=' (absolute set)."
        ),
    )
    amount: float = Field(
        ...,
        description=(
            "Operand applied via ``method`` (the absolute value when "
            "method='=', the delta/factor otherwise)."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_value(cls, data: Any) -> Any:
        """Back-compat: an old AlterSpec persisted as ``{..., 'value': X}``
        (pre method/amount) deserializes as an absolute set ``method='=',
        amount=X`` so existing snapshots/bundles keep loading."""
        if isinstance(data, dict) and "value" in data and "amount" not in data:
            data = dict(data)
            data["amount"] = data.pop("value")
            data.setdefault("method", "=")
        return data


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
