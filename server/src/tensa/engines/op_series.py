"""The series block of a case or study: load profiles over one horizon.

A load profile is a list of factors over a horizon at a resolution, for every
load or per load key. The Python side resolves keys to PowerSystems component
names before anything reaches Julia, as ``dispatch.py`` keys by name.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "CaseSeries",
    "CostCurveRecord",
    "GeneratorOp",
    "SeriesProfile",
]


class CostCurveRecord(BaseModel):
    """One generator's variable cost, as the case file gives it.

    A MATPOWER gencost model 2 row is a polynomial; model 1 is a piecewise
    linear curve. The numbers are the file's own, in $/MW^n h and $/h on the
    system MVA base, never converted: PowerSystems reads them labelled
    DEVICE_BASE and the dispatch relabels them NATURAL_UNITS, so the document
    holds what the file holds.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["polynomial", "piecewise"] = Field(
        description="polynomial for a MATPOWER gencost model 2 row, piecewise for model 1."
    )
    coefficients: list[float] | None = Field(
        default=None,
        description=(
            "For polynomial: the coefficients highest degree first, as the "
            "gencost row lists them (a, b, c for a quadratic a*P^2 + b*P + c, "
            "in $/MW^2h, $/MWh, $/h)."
        ),
    )
    points: list[list[float]] | None = Field(
        default=None,
        description=(
            "For piecewise: the (MW, $/h) points in the row's order, each a "
            "two-element list."
        ),
    )
    startup_usd: float | None = Field(
        default=None, description="The start-up cost, in $ (the gencost row's second column)."
    )
    shutdown_usd: float | None = Field(
        default=None, description="The shut-down cost, in $ (the gencost row's third column)."
    )


class GeneratorOp(BaseModel):
    """The operations data of one generator: what dispatch, unit commitment
    and simulation read. Null where the case gives nothing; a PSS/E .raw has
    none of these fields and its generators carry no ``op`` block at all."""

    model_config = ConfigDict(extra="forbid")

    p_min_mw: float | None = Field(
        default=None, description="The lower active power limit, in MW (MATPOWER PMIN, column 10)."
    )
    p_max_mw: float | None = Field(
        default=None, description="The upper active power limit, in MW (MATPOWER PMAX, column 9)."
    )
    ramp_up_mw_per_min: float | None = Field(
        default=None,
        description=(
            "The ramp-up limit, in MW per minute: MATPOWER's RAMP_AGC "
            "(MW/min) where it is non-zero, else RAMP_10 (MW in 10 minutes) "
            "divided by 10; null where both are 0 (the file gives no ramp "
            "data, and 0 must never become a limit). It is the limit the "
            "Sienna engine's unit commitment and simulation enforce."
        ),
    )
    ramp_down_mw_per_min: float | None = Field(
        default=None,
        description="The ramp-down limit, in MW per minute, same rule as ramp_up_mw_per_min.",
    )
    min_up_h: float | None = Field(
        default=None, description="The minimum up time, in hours; null where the case gives none."
    )
    min_down_h: float | None = Field(
        default=None, description="The minimum down time, in hours; null where the case gives none."
    )
    cost: CostCurveRecord | None = Field(
        default=None, description="The variable cost curve; null where the case has no cost data."
    )
    initial_p_mw: float | None = Field(
        default=None,
        description="The output the unit commitment starts from, in MW; the case's PG.",
    )
    initial_status: Literal["on", "off"] | None = Field(
        default=None,
        description=(
            "Whether the unit is committed at the start of the horizon; null "
            "where the case does not say (a MATPOWER case: on when in service)."
        ),
    )


class SeriesProfile(BaseModel):
    """One load profile: factors over a horizon at a resolution, multiplying
    the load's ``p_mw`` (and ``q_mvar`` at the same factor). A factor of 1.0
    is the case as loaded."""

    model_config = ConfigDict(extra="forbid")

    applies_to: str = Field(
        description=(
            "The load key (load:7-1) the profile multiplies, or \"*\" for "
            "every load of the case."
        )
    )
    resolution_s: float = Field(
        gt=0, description="The time between two factors, in seconds."
    )
    factors: list[float] = Field(
        min_length=1,
        description="The multiplier at each step, from the horizon's start; each >= 0.",
    )


class CaseSeries(BaseModel):
    """The time series of a case or a study: load profiles over one horizon.
    The horizon's length is the longest profile's; a shorter profile's last
    factor holds to the end."""

    model_config = ConfigDict(extra="forbid")

    start: str | None = Field(
        default=None,
        description=(
            "The horizon's start as an ISO 8601 date-time; null means the "
            "engine's default (the Sienna adapter uses 2026-01-01T00:00:00, "
            "the date its dispatch already uses)."
        ),
    )
    load: list[SeriesProfile] = Field(
        default_factory=list,
        description="The load profiles; at most one with applies_to \"*\".",
    )
