"""Response metrics of sampled signals: ``POST /response-metrics``."""

from __future__ import annotations

import math

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Bounds on one request: a 10-minute run at ANDES's finest usual step is far
# below them, and a body of this size parses in well under a second.
MAX_METRIC_SERIES = 64


MAX_METRIC_SAMPLES = 200_000


MAX_METRIC_SAMPLES_TOTAL = 1_000_000


class MetricsSeries(BaseModel):
    """One signal to describe."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="What the signal is called; echoed back on its result.",
    )
    t: list[float] = Field(
        ...,
        max_length=MAX_METRIC_SAMPLES,
        description=(
            "Sample times in seconds, not decreasing. Samples at one time count "
            "as one, the last of them."
        ),
    )
    y: list[float | None] = Field(
        ...,
        max_length=MAX_METRIC_SAMPLES,
        description=(
            "The signal's value at each time, in whatever unit the caller reads "
            "it in. ``null`` marks a missing value (a diverged step); that sample "
            "is left out."
        ),
    )

    @field_validator("t")
    @classmethod
    def _t_is_finite(cls, v: list[float]) -> list[float]:
        if not all(math.isfinite(x) for x in v):
            raise ValueError("t must hold finite numbers")
        return v


class ResponseMetricsRequest(BaseModel):
    """Request body for ``POST /response-metrics``."""

    model_config = ConfigDict(extra="forbid")

    series: list[MetricsSeries] = Field(
        ...,
        min_length=1,
        max_length=MAX_METRIC_SERIES,
        description="The signals to describe, each on its own timeline.",
    )
    t_start: float | None = Field(
        None,
        allow_inf_nan=False,
        description=(
            "Start of the window the metrics are read over, in seconds. A bound "
            "that falls between two samples is interpolated. Defaults to the "
            "first sample."
        ),
    )
    t_end: float | None = Field(
        None,
        allow_inf_nan=False,
        description="End of the window, in seconds. Defaults to the last sample.",
    )
    settling_band: float = Field(
        0.02,
        gt=0.0,
        lt=1.0,
        description=(
            "The settling band as a fraction of the signal's largest distance from "
            "its final value: 0.02 is 2 %."
        ),
    )
    rocof_window: float = Field(
        0.5,
        gt=0.0,
        allow_inf_nan=False,
        description=(
            "Width in seconds the rate of change is measured over: the steepest "
            "slope of the line from ``y(s)`` to ``y(s + rocof_window)``. Cut to the "
            "window when the window is shorter."
        ),
    )

    @field_validator("series")
    @classmethod
    def _within_total(cls, v: list[MetricsSeries]) -> list[MetricsSeries]:
        if sum(len(s.t) for s in v) > MAX_METRIC_SAMPLES_TOTAL:
            raise ValueError(f"the series hold more than {MAX_METRIC_SAMPLES_TOTAL} samples in all")
        return v


class MetricExtremum(BaseModel):
    """A value of the signal and when it is reached."""

    value: float = Field(..., description="The value, in the signal's unit.")
    t: float = Field(..., description="The time it is reached, in seconds.")


class DampingEstimate(BaseModel):
    """The oscillation of a signal, from the log decrement of its swings."""

    ratio: float = Field(
        ...,
        description=(
            "Damping ratio, ``d / sqrt(pi**2 + d**2)`` for the half-cycle log "
            "decrement ``d``. Negative for a swing that grows."
        ),
    )
    frequency_hz: float = Field(
        ..., description="Frequency of the oscillation, in hertz."
    )
    extrema: int = Field(
        ..., description="How many extremes of the signal the estimate rests on."
    )


class SeriesMetrics(BaseModel):
    """What one signal's response metrics came to. Either ``error`` says why it
    could not be described, or the rest is filled in."""

    name: str = Field(..., description="The series' name, as sent.")
    error: str | None = Field(
        default=None,
        description=(
            "Why this signal has no metrics (too few samples, a window outside "
            "it, times that run backwards); ``null`` when it has them."
        ),
    )
    samples: int | None = Field(
        default=None, description="Samples in the window, its two bounds included."
    )
    t_start: float | None = Field(
        default=None, description="Start of the window used, in seconds."
    )
    t_end: float | None = Field(default=None, description="End of the window used, in seconds.")
    initial: float | None = Field(default=None, description="Value at the start of the window.")
    final: float | None = Field(
        default=None,
        description="Time-weighted mean over the last 10 % of the window: what it settled to.",
    )
    peak: MetricExtremum | None = Field(default=None, description="Largest value and when.")
    nadir: MetricExtremum | None = Field(default=None, description="Smallest value and when.")
    max_deviation: MetricExtremum | None = Field(
        default=None,
        description="Largest distance from ``initial``: ``value`` is signed (``y - initial``).",
    )
    rocof: MetricExtremum | None = Field(
        default=None,
        description=(
            "Steepest rate of change over ``rocof_window``, in the signal's unit "
            "per second, sign kept; ``t`` is the start of that window."
        ),
    )
    settling_time: float | None = Field(
        default=None,
        description=(
            "Seconds from the start of the window after which the signal stays "
            "within the settling band; ``null`` when it had not settled by the end."
        ),
    )
    overshoot_pct: float | None = Field(
        default=None,
        description=(
            "How far the signal went past its final value, in percent of the step "
            "from ``initial`` to ``final``; ``null`` when ``final`` is within the "
            "settling band of ``initial``."
        ),
    )
    damping: DampingEstimate | None = Field(
        default=None, description="``null`` for a signal that does not oscillate."
    )


class ResponseMetricsResponse(BaseModel):
    """Response body for ``POST /response-metrics``."""

    results: list[SeriesMetrics] = Field(
        ..., description="One entry per requested series, in the order sent."
    )
