"""Response models for the bus admittance matrix route."""

from __future__ import annotations

from pydantic import BaseModel, Field


class YbusEntrySchema(BaseModel):
    """One nonzero of the bus admittance matrix."""

    row: int = Field(
        description="Row of the entry, from 0; bus_idx[row] is the bus of the row."
    )
    col: int = Field(
        description="Column of the entry, from 0; bus_idx[col] is the bus of the column."
    )
    re: float = Field(
        description="Real part (conductance), in per unit on the system base (base_mva)."
    )
    im: float = Field(
        description="Imaginary part (susceptance), in per unit on the system base (base_mva)."
    )


class YbusResponse(BaseModel):
    """The bus admittance matrix of the loaded case, as sparse triplets."""

    n_bus: int = Field(description="Number of buses; the matrix is n_bus by n_bus.")
    base_mva: float | None = Field(
        description=(
            "The system MVA base the per-unit values are on: an admittance in "
            "siemens is the per-unit value times base_mva over the square of the "
            "bus's rated voltage in kV. Null when the case carries no usable base."
        )
    )
    bus_idx: list[str] = Field(
        description="bus_idx[i] is the ANDES idx of the bus of row and column i."
    )
    bus_key: list[str | None] = Field(
        description=(
            "bus_key[i] is the key of the bus of row and column i, as "
            "GET /sessions/{id}/keys gives it; null for a bus that has none."
        )
    )
    entries: list[YbusEntrySchema] = Field(
        description=(
            "The nonzero entries of the bus admittance matrix ANDES builds from "
            "its lines, transformers and shunts (the models it flags ybus), in "
            "per unit on the system base; an entry not listed is zero. Device "
            "status at the time of the call is reflected (a line switched off "
            "adds nothing); the models that contribute are those present at "
            "setup. Loads and generators are not in it."
        )
    )
