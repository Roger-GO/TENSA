"""Request and response models for the Sienna economic dispatch route."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class DispatchRequest(BaseModel):
    """The body of ``POST /sessions/{id}/dispatch``."""

    model_config = ConfigDict(extra="forbid")

    network_model: Literal["copper_plate", "dc", "ptdf"] = Field(
        description=(
            "The network model of the dispatch: copper_plate (no network), "
            "dc or ptdf."
        )
    )
    duals: bool = Field(
        default=False,
        description=(
            "Read the dual variables back and list them in the answer. The "
            "copper plate model has none; dc and ptdf may."
        ),
    )


class DispatchGeneratorSchema(BaseModel):
    """One dispatched generator."""

    p_mw: float = Field(description="The dispatched active power, in MW.")
    bus: int = Field(description="The number of the bus the generator is on.")
    id: str = Field(
        description=(
            "The generator's id on its bus, from its key; for a generator the "
            "key book does not hold, the one the engine reads off its name."
        )
    )
    idx: str = Field(
        description="The PowerSystems component name of the generator (the engine's handle)."
    )


class DispatchDualRowSchema(BaseModel):
    """One row of a dual variable."""

    element: str = Field(description="The element the row is for, as PowerSimulations names it.")
    value: float = Field(description="The dual value of the row.")


class DispatchDualSchema(BaseModel):
    """One dual variable of the dispatch, read back when duals was true."""

    name: str = Field(description="The dual variable's name, as PowerSimulations names it.")
    rows: list[DispatchDualRowSchema] = Field(description="The dual's rows.")


class DispatchSlackSchema(BaseModel):
    """One slack variable whose value is not zero (past 1e-6 MW)."""

    variable: str = Field(description="The slack variable's name, as PowerSimulations names it.")
    element: str = Field(description="The element the slack is on, as PowerSimulations names it.")
    value: float = Field(description="The slack's value, in MW.")


class DispatchResponse(BaseModel):
    """The result of a one-period economic dispatch of a Sienna session."""

    status: str = Field(description="completed when the dispatch solved.")
    engine: str = Field(description="The engine that ran the dispatch: sienna.")
    network_model: str = Field(description="The network model the dispatch used.")
    objective_per_h: float = Field(
        description=(
            "The solver's objective, in $/h: the cost curves are labelled as "
            "natural units before the model is built, so the objective is the "
            "true cost of the dispatch with power in MW."
        )
    )
    objective_check_per_h: float = Field(
        description=(
            "The cost recomputed from the dispatch in MW and the case file's "
            "own gencost coefficients, in $/h; equal to objective_per_h "
            "within solver tolerance."
        )
    )
    base_mva: float = Field(description="The system MVA base.")
    total_load_mw: float = Field(description="The total load of the case, in MW.")
    total_dispatch_mw: float = Field(
        description="The sum of the dispatched generator powers, in MW."
    )
    generators: dict[str, DispatchGeneratorSchema] = Field(
        description=(
            "The dispatched generators, keyed by the neutral key "
            "(gen:<bus>-<id>), each with its MW, bus, id and idx."
        )
    )
    duals: list[DispatchDualSchema] = Field(
        description="The dual variables, when the request asked for them; empty otherwise."
    )
    slacks: list[DispatchSlackSchema] = Field(
        description="Every slack variable whose value is past 1e-6 MW; empty when all are zero."
    )
    parameters: list[str] = Field(
        description="The parameter names of the optimization model, as PowerSimulations names them."
    )
    expressions: list[str] = Field(
        description="The expression names of the optimization model, as PowerSimulations names them."
    )
    keys: dict[str, dict[str, str]] = Field(
        description=(
            "The keys lookup: under \"generator\", the PowerSystems component "
            "name of each dispatched generator mapped to its neutral key."
        )
    )
    notes: list[str] = Field(
        description="What the Julia side logged at warning level and above while the dispatch ran."
    )
    extra: dict[str, Any] | None = Field(
        default=None,
        description="Reserved; absent.",
    )
