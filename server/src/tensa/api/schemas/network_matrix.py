"""Response models for the Sienna network matrix route."""

from __future__ import annotations

from pydantic import BaseModel, Field


class NetworkMatrixBusSchema(BaseModel):
    """One bus of a matrix axis, with its key."""

    bus: int = Field(description="Bus number.")
    key: str = Field(
        description="The bus's key, as GET /sessions/{id}/keys gives it."
    )


class NetworkMatrixArcSchema(BaseModel):
    """One arc of a matrix axis, with the keys of its branches."""

    from_bus: int = Field(alias="from", description="Bus number of the arc's from end.")
    to_bus: int = Field(alias="to", description="Bus number of the arc's to end.")
    keys: list[str] = Field(
        description=(
            "The key of every branch on this arc, as GET /sessions/{id}/keys "
            "gives them; parallel circuits share an arc."
        )
    )


class NetworkMatrixEntrySchema(BaseModel):
    """One nonzero of a complex matrix (ybus), as the ANDES ybus entry."""

    row: int = Field(description="Row of the entry, from 0.")
    col: int = Field(description="Column of the entry, from 0.")
    re: float = Field(description="Real part, in per unit on the system base.")
    im: float = Field(description="Imaginary part, in per unit on the system base.")


class NetworkMatrixResponse(BaseModel):
    """One network matrix of the loaded case, built by PowerNetworkMatrices."""

    kind: str = Field(description="ptdf, lodf, ybus or incidence.")
    n_rows: int = Field(description="Number of rows of the matrix.")
    n_cols: int = Field(description="Number of columns of the matrix.")
    n_entries: int = Field(
        description="n_rows times n_cols for a dense matrix; the nonzero count for ybus."
    )
    complex_: bool = Field(alias="complex", description="True for ybus, which is complex.")
    base_mva: float = Field(description="The system MVA base the per-unit values are on.")
    rows: list[NetworkMatrixBusSchema] | list[NetworkMatrixArcSchema] = Field(
        description="Row axis: bus entries for ybus, arc entries for ptdf, lodf, incidence."
    )
    cols: list[NetworkMatrixBusSchema] | list[NetworkMatrixArcSchema] = Field(
        description="Column axis: bus entries for ptdf, ybus, incidence; arc entries for lodf."
    )
    ref_buses: list[str] | None = Field(
        default=None,
        description="Keys of the reference buses the matrix was built against; absent for ybus.",
    )
    distributed_slack: bool = Field(description="Always false; no distributed slack is applied.")
    values: list[list[float]] | None = Field(
        default=None,
        description="The matrix, row by row, for ptdf, lodf and incidence; absent for ybus.",
    )
    entries: list[NetworkMatrixEntrySchema] | None = Field(
        default=None,
        description="The nonzero entries for ybus; absent for the dense kinds.",
    )
