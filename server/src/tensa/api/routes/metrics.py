"""Response metrics endpoint: nadir, rate of change, settling time, overshoot and
damping of signals the caller sends.

``POST /response-metrics`` holds no session. The web UI sends the series it plots
(a streamed run's columns, narrowed to the window between its two cursors), and
a script or an agent sends the ``traces`` of a batch TDS run. The definitions
live in ``tensa.core.response_metrics``.
"""

from __future__ import annotations

from fastapi import APIRouter

from tensa.api.body_limit import body_limited_route, json_number_bytes
from tensa.api.schemas import (
    MAX_METRIC_SAMPLES,
    MAX_METRIC_SAMPLES_TOTAL,
    MAX_METRIC_SERIES,
    DampingEstimate,
    MetricExtremum,
    MetricsSeries,
    ProblemDetails,
    ResponseMetricsRequest,
    ResponseMetricsResponse,
    SeriesMetrics,
)
from tensa.core.response_metrics import (
    Extremum,
    ResponseMetricsError,
    response_metrics,
)

# The most bytes a body within the limits can be: a time and a value for each
# of ``MAX_METRIC_SAMPLES_TOTAL`` samples. A larger one is answered 413 before
# it is read (``tensa.api.body_limit``), where it would otherwise be read,
# parsed and checked on the event loop to be answered 422 for its length.
MAX_METRICS_BYTES = json_number_bytes(2 * MAX_METRIC_SAMPLES_TOTAL)

router = APIRouter(route_class=body_limited_route(MAX_METRICS_BYTES, "a response-metrics request"))


def _extremum(found: Extremum | None) -> MetricExtremum | None:
    return None if found is None else MetricExtremum(value=found.value, t=found.t)


def _describe(series: MetricsSeries, body: ResponseMetricsRequest) -> SeriesMetrics:
    try:
        m = response_metrics(
            series.t,
            series.y,
            t_start=body.t_start,
            t_end=body.t_end,
            settling_band=body.settling_band,
            rocof_window=body.rocof_window,
        )
    except ResponseMetricsError as exc:
        return SeriesMetrics(name=series.name, error=str(exc))
    return SeriesMetrics(
        name=series.name,
        samples=m.samples,
        t_start=m.t_start,
        t_end=m.t_end,
        initial=m.initial,
        final=m.final,
        peak=_extremum(m.peak),
        nadir=_extremum(m.nadir),
        max_deviation=_extremum(m.max_deviation),
        rocof=_extremum(m.rocof),
        settling_time=m.settling_time,
        overshoot_pct=m.overshoot_pct,
        damping=(
            None
            if m.damping is None
            else DampingEstimate(
                ratio=m.damping.ratio,
                frequency_hz=m.damping.frequency_hz,
                extrema=m.damping.extrema,
            )
        ),
    )


@router.post(
    "/response-metrics",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="computeResponseMetrics",
    summary="Describe the response of sampled signals: nadir, rate of change, settling time, overshoot, damping.",
    response_model=ResponseMetricsResponse,
    responses={
        422: {
            "model": ProblemDetails,
            "description": (
                "The body is malformed, or a limit is exceeded: more than "
                f"{MAX_METRIC_SERIES} series, more than {MAX_METRIC_SAMPLES} samples in "
                "one, or a setting out of range. A series that is only too short to "
                "describe is not an error: it is answered with its own ``error``."
            ),
        },
    },
)
async def compute_response_metrics(body: ResponseMetricsRequest) -> ResponseMetricsResponse:
    """For each series: its initial and final value, its peak and nadir, the
    steepest rate of change over ``rocof_window``, the time it takes to settle,
    how far it overshoots, and the damping ratio and frequency of its oscillation.
    A series that cannot be described (too few samples, a window outside it)
    carries an ``error`` and the rest of the request is answered. The definitions
    are in each field's description. Needs no session: send the columns of a
    streamed run, or the ``traces`` of a batch run."""
    return ResponseMetricsResponse(results=[_describe(s, body) for s in body.series])
