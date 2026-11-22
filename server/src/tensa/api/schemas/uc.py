"""Request and response models for the Sienna unit commitment route."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class UcOverrideSchema(BaseModel):
    """What the request adds to one generator, beyond the case file."""

    model_config = ConfigDict(extra="forbid")

    startup_cost: float | None = Field(
        default=None,
        description=(
            "Start-up cost in $, added to the gencost row's STARTUP (the "
            "row's second number, which the shipped cases carry as 0)."
        ),
    )
    min_up_h: float | None = Field(
        default=None,
        description=(
            "Minimum up time in hours; MATPOWER has no column for it, so "
            "only the request can give one."
        ),
    )
    min_down_h: float | None = Field(
        default=None,
        description="Minimum down time in hours; MATPOWER has no column for it.",
    )
    must_run: bool | None = Field(
        default=None, description="Commit the generator in every period."
    )


class UcRequest(BaseModel):
    """The body of ``POST /sessions/{id}/uc``."""

    model_config = ConfigDict(extra="forbid")

    network_model: Literal["copper_plate", "dc", "ptdf"] = Field(
        description=(
            "The network model of the commitment: copper_plate (no network), "
            "dc or ptdf."
        )
    )
    horizon_h: int = Field(description="The horizon in hours, 1 to 168.")
    resolution_min: Literal[15, 30, 60] = Field(
        description="The period length in minutes."
    )
    series: list[float] = Field(
        description=(
            "One load factor per period, applied to every load's max active "
            "power; one positive finite number per period, "
            "horizon_h * 60 / resolution_min of them."
        )
    )
    overrides: dict[str, UcOverrideSchema] = Field(
        default_factory=dict,
        description=(
            "Per-generator additions keyed by the generator's key "
            "(gen:<bus>-<id>): start-up cost, minimum up and down times, "
            "must-run."
        ),
    )


class UcGeneratorSchema(BaseModel):
    """One committed generator."""

    bus: int = Field(description="The number of the bus the generator is on.")
    id: str = Field(description="The generator's id on its bus, from its key.")
    idx: str = Field(
        description="The PowerSystems component name (the engine's handle)."
    )
    on: list[bool] = Field(description="Committed (true) or not, per period.")
    p_mw: list[float] = Field(
        description="The dispatched active power per period, in MW."
    )
    energy: float = Field(
        description=(
            "The generator's energy cost over the horizon, in $: the "
            "quadratic and linear gencost terms at the dispatched MW, times "
            "the period length in hours."
        )
    )
    startup: float = Field(
        description="The generator's start-up cost over the horizon, in $."
    )
    fixed: float = Field(
        description=(
            "The generator's fixed cost over the horizon, in $: the gencost "
            "constant term c0 ($/h) per committed period, times the period "
            "length in hours."
        )
    )


class UcCostSchema(BaseModel):
    """The objective split over the horizon."""

    energy: float = Field(description="The energy cost over the horizon, in $.")
    startup: float = Field(description="The start-up cost over the horizon, in $.")
    fixed: float = Field(description="The fixed cost over the horizon, in $.")
    total: float = Field(description="The total cost over the horizon, in $.")


class UcSlackSchema(BaseModel):
    """One slack variable whose value is not zero (past 1e-6 MW)."""

    variable: str = Field(
        description="The slack variable's name, as PowerSimulations names it."
    )
    element: str = Field(
        description="The element the slack is on, as PowerSimulations names it."
    )
    time: str = Field(description="The period the slack is in, as an ISO timestamp.")
    value: float = Field(description="The slack's value, in MW.")


class UcResponse(BaseModel):
    """The result of a unit commitment of a Sienna session."""

    status: str = Field(description="completed when the commitment solved.")
    engine: str = Field(description="The engine that ran the commitment: sienna.")
    network_model: str = Field(description="The network model the commitment used.")
    horizon_h: int = Field(description="The horizon, in hours.")
    resolution_min: int = Field(description="The period length, in minutes.")
    periods: list[str] = Field(
        description="The period start times, ISO strings, one per period."
    )
    base_mva: float = Field(description="The system MVA base.")
    objective: float = Field(
        description=(
            "The solver's objective over the horizon, in $. The gencost "
            "constant term is put on the model as c0 times the period length "
            "per committed period, so it equals objective_check, except that "
            "PowerSimulations leaves the constant term of a must-run "
            "generator out of its objective."
        )
    )
    objective_check: float = Field(
        description=(
            "The cost recomputed from the commitment and dispatch and the "
            "case file's own gencost coefficients, in $; equal to objective "
            "within solver tolerance."
        )
    )
    cost: UcCostSchema = Field(
        description="The objective split: energy, start-up, fixed, total, in $."
    )
    total_load_mw: list[float] = Field(description="The total load per period, in MW.")
    generators: dict[str, UcGeneratorSchema] = Field(
        description="The generators, keyed by the neutral key (gen:<bus>-<id>)."
    )
    slacks: list[UcSlackSchema] = Field(
        description=(
            "Every slack variable whose value is past 1e-6 MW; empty when "
            "all are zero."
        )
    )
    parameters: list[str] = Field(
        description="The parameter names of the optimization model, as PowerSimulations names them."
    )
    expressions: list[str] = Field(
        description="The expression names of the optimization model, as PowerSimulations names them."
    )
    keys: dict[str, dict[str, str]] = Field(
        description=(
            "The keys lookup: under \"generator\", the PowerSystems "
            "component name of each generator of the answer mapped to its "
            "neutral key."
        )
    )
    notes: list[str] = Field(
        description="What the Julia side logged at warning level and above while the commitment ran."
    )
    extra: dict[str, Any] | None = Field(
        default=None,
        description="Reserved; absent.",
    )
