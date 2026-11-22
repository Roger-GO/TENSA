"""Request and response models for the Sienna multi-stage simulation route."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class SimRequest(BaseModel):
    """The body of ``POST /sessions/{id}/sim``."""

    model_config = ConfigDict(extra="forbid")

    load_profile: list[float] = Field(
        min_length=96,
        max_length=96,
        description=(
            "The load profile of the day: 96 fractions of each load's max "
            "active power, one per 15-minute step (1.0 is the case's load). "
            "The day-ahead stage aggregates four consecutive steps into one "
            "hourly value."
        ),
    )
    network_model: Literal["copper_plate", "dc", "ptdf"] = Field(
        default="copper_plate",
        description=(
            "The network model of both stages: copper_plate (no network), "
            "dc or ptdf."
        ),
    )


class SimGeneratorSeriesSchema(BaseModel):
    """One generator's series in one stage."""

    bus: int = Field(description="The number of the bus the generator is on.")
    id: str = Field(description="The generator's id on its bus, from its key.")
    idx: str = Field(
        description="The PowerSystems component name (the engine's handle)."
    )
    values: list[float] = Field(
        description=(
            "The value at each step of the stage: MW for dispatch, 0 or 1 "
            "for commitment. Step i of the day-ahead stage is hour i of the "
            "day from 2026-01-01T00:00:00; step j of the real-time stage is "
            "15 minutes times j."
        )
    )


class SimStageSchema(BaseModel):
    """One stage of the simulation."""

    name: str = Field(description="The stage's name: DA (day-ahead) or RT (real-time).")
    kind: str = Field(description="The stage's kind: uc for DA, dispatch for RT.")
    resolution_minutes: int = Field(
        description="The step length of the stage: 60 for DA, 15 for RT."
    )
    steps: int = Field(description="The number of steps: 24 for DA, 96 for RT.")
    horizon_hours: float = Field(
        description="The horizon each step optimizes over, in hours: 24 for DA, 1 for RT."
    )
    objective: float = Field(
        description=(
            "The stage's cost over the day, in $, recomputed from its "
            "dispatch and the case file's own gencost coefficients (the "
            "day-ahead stage's includes the start-up costs and the gencost "
            "constant term per committed hour)."
        )
    )
    commitment: dict[str, SimGeneratorSeriesSchema] = Field(
        description=(
            "Per-generator on/off by step (0 or 1), keyed by the neutral key "
            "(gen:<bus>-<id>); only the day-ahead uc stage has it."
        )
    )
    dispatch: dict[str, SimGeneratorSeriesSchema] = Field(
        description="Per-generator active power by step, in MW, keyed by the neutral key."
    )


class SimSlackSchema(BaseModel):
    """One slack variable whose value is not zero (past 1e-6 MW)."""

    variable: str = Field(
        description="The slack variable's name, as PowerSimulations names it."
    )
    element: str = Field(
        description="The element the slack is on, as PowerSimulations names it."
    )
    time: str = Field(description="The step the slack is in, as an ISO timestamp.")
    value: float = Field(description="The slack's value, in MW.")


class SimResponse(BaseModel):
    """The result of a two-stage simulation of a Sienna session."""

    status: str = Field(description="completed when the simulation solved.")
    engine: str = Field(description="The engine that ran the simulation: sienna.")
    network_model: str = Field(description="The network model both stages used.")
    base_mva: float = Field(description="The system MVA base.")
    interval_minutes: int = Field(
        description="The interval between the two stages, in minutes: 60 (the day-ahead resolution)."
    )
    stages: list[SimStageSchema] = Field(
        description="The two stages: DA (unit commitment, hourly) then RT (economic dispatch, 15 minutes)."
    )
    slacks: list[SimSlackSchema] = Field(
        description=(
            "Every slack variable of either stage whose value is past 1e-6 "
            "MW; empty when all are zero."
        )
    )
    keys: dict[str, dict[str, str]] = Field(
        description=(
            "The keys lookup: under \"generator\", the PowerSystems "
            "component name of each generator of the answer mapped to its "
            "neutral key."
        )
    )
    notes: list[str] = Field(
        description="What the Julia side logged at warning level and above while the simulation ran."
    )
    extra: dict[str, Any] | None = Field(
        default=None,
        description="Reserved; absent.",
    )
