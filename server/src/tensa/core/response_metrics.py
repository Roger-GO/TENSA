"""Response metrics of one signal: what a power-system study reads off a trace.

:func:`response_metrics` takes a sampled signal (a generator's speed, a bus
voltage, a line flow) and describes how it moved: where it started and ended up,
its extremes, how fast it changed, how long it took to settle, how far it
overshot, and how well its oscillation is damped. The signal is whatever the
caller has (a run's streamed columns, a batch run's ``traces``), in whatever
unit the caller reads it in: the metrics that carry the signal's unit
(``initial``, ``final``, the extremes, the rate) are in that unit, and the rest
(times, a percentage, a damping ratio) do not depend on it.

The definitions, for a signal ``y`` sampled at times ``t`` inside a window
``[t_start, t_end]`` (the whole signal unless the caller narrows it):

- ``initial``: ``y`` at ``t_start``. ``final``: the time-weighted mean of ``y``
  over the last 10 % of the window, which is what the signal has settled to if
  it has.
- ``peak`` and ``nadir``: the largest and the smallest value, with the time each
  is reached. For a frequency dip the nadir is the number that matters; for a
  voltage rise, the peak.
- ``max_deviation``: the largest distance from ``initial``, signed
  (``y - initial``), with its time.
- ``rocof`` (rate of change): the steepest slope of the straight line from
  ``y(s)`` to ``y(s + w)`` over every window start ``s`` in the window, where
  ``w`` is ``rocof_window`` (0.5 s unless asked, the width grid codes measure
  the rate of change of frequency over, shortened to the window if that is
  shorter). The sign is kept and ``t`` is ``s``. In the signal's unit per second.
- ``settling_time``: the time, counted from ``t_start``, after which ``y`` stays
  within ``settling_band`` (2 %) of the largest distance it ever has from
  ``final``. ``0`` for a signal that never leaves the band, ``None`` when it is
  still outside it in the last 10 % of the window.
- ``overshoot_pct``: for a signal that goes from ``initial`` to a ``final``
  different from it, how far it went past ``final``, in percent of
  ``|final - initial|`` (``0`` if it never went past, or by less than 0.01 % of
  the step). ``None`` when ``final``
  is within the settling band of ``initial``, as it is for an oscillation that
  returns to where it started: there is no step to overshoot.
- ``damping``: the damping ratio and frequency of the signal's oscillation, from
  the log decrement of its swings. Successive extremes of the signal (each placed
  by a parabola through the three samples around it) give half-cycle swings
  ``a_k = |x_{k+1} - x_k|``, and a line fitted through ``ln a_k`` against ``k``
  gives the half-cycle log decrement ``d`` (the line's negative slope), from
  which ``ratio = d / sqrt(pi**2 + d**2)``, negative for a swing that grows,
  and ``frequency_hz = 1 / (2 * mean half-period)``. Needs at least three
  extremes; ``None`` for a signal that does not oscillate. A signal with
  several modes gives the one that dominates its swings.

Samples that are not finite are dropped, samples at the same time collapse to
the last of them (ANDES records a time twice when an event changes the system at
that instant), and the times must not run backwards.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

# The share of the window, at its end, that ``final`` is taken over and that a
# settled signal must be inside the band for.
FINAL_FRACTION = 0.1
DEFAULT_SETTLING_BAND = 0.02
DEFAULT_ROCOF_WINDOW = 0.5
MIN_SAMPLES = 3
# A swing below this share of the largest is noise, not part of the oscillation.
_NOISE_FLOOR = 1e-3
# A distance past the final value below this share of the step is not an overshoot.
_OVERSHOOT_FLOOR = 1e-4

_Array = NDArray[np.float64]
# Samples as a caller holds them: a list (a JSON body), or an array; ``None``
# marks a value that is missing.
_Samples = Sequence[float | None] | _Array


class ResponseMetricsError(ValueError):
    """The signal or the window cannot be described (too few samples, times that
    run backwards)."""


@dataclass(frozen=True)
class Extremum:
    """A value of the signal and the time it is reached."""

    value: float
    t: float


@dataclass(frozen=True)
class Damping:
    """The oscillation of a signal: how fast it decays and how often it swings."""

    ratio: float
    frequency_hz: float
    #: How many extremes of the signal the estimate rests on.
    extrema: int


@dataclass(frozen=True)
class ResponseMetrics:
    """What :func:`response_metrics` found; see the module docstring."""

    samples: int
    t_start: float
    t_end: float
    initial: float
    final: float
    peak: Extremum
    nadir: Extremum
    max_deviation: Extremum
    rocof: Extremum | None
    settling_time: float | None
    overshoot_pct: float | None
    damping: Damping | None


def _clean(t: _Samples, y: _Samples) -> tuple[_Array, _Array]:
    """The finite samples in time order, one per time (the last given)."""
    if len(t) != len(y):
        raise ResponseMetricsError(
            f"t has {len(t)} samples and y has {len(y)}; they must be the same length"
        )
    tt = np.array(t, dtype=np.float64)
    yy = np.array([math.nan if v is None else v for v in y], dtype=np.float64)
    keep = np.isfinite(tt) & np.isfinite(yy)
    tt, yy = tt[keep], yy[keep]
    if tt.size > 1 and np.any(np.diff(tt) < 0):
        raise ResponseMetricsError("t must not decrease")
    if tt.size > 1:
        # Of several samples at one time keep the last: the state after the event.
        last = np.append(np.diff(tt) > 0, True)
        tt, yy = tt[last], yy[last]
    return tt, yy


def _window(t: _Array, y: _Array, t_start: float | None, t_end: float | None) -> tuple[_Array, _Array]:
    """The samples in ``[t_start, t_end]``, with the window's ends interpolated in
    where they fall between samples, so a window set by a cursor starts and ends
    where the cursor is."""
    lo = t[0] if t_start is None else max(t_start, t[0])
    hi = t[-1] if t_end is None else min(t_end, t[-1])
    if not lo < hi:
        raise ResponseMetricsError(
            f"the window [{t_start}, {t_end}] holds no part of the signal ({t[0]} to {t[-1]})"
        )
    inside = (t > lo) & (t < hi)
    wt = np.concatenate(([lo], t[inside], [hi]))
    wy = np.concatenate(([np.interp(lo, t, y)], y[inside], [np.interp(hi, t, y)]))
    if wt.size < MIN_SAMPLES:
        raise ResponseMetricsError(
            f"the window holds {wt.size} samples; at least {MIN_SAMPLES} are needed"
        )
    return wt, wy


def _rocof(t: _Array, y: _Array, window: float) -> Extremum | None:
    duration = float(t[-1] - t[0])
    width = min(window, duration)
    if width <= 0:
        return None
    # Every window that starts at a sample and ends inside the signal; the
    # tolerance keeps the one that ends exactly at ``t_end``.
    starts = t <= t[-1] - width + 1e-12 * max(1.0, abs(float(t[-1])))
    slopes = (np.interp(t[starts] + width, t, y) - y[starts]) / width
    steepest = int(np.argmax(np.abs(slopes)))
    return Extremum(float(slopes[steepest]), float(t[starts][steepest]))


def _final(t: _Array, y: _Array) -> tuple[float, int]:
    """The settled value, and the index of the first sample of the stretch it is
    the mean of."""
    duration = float(t[-1] - t[0])
    first = int(np.searchsorted(t, t[-1] - FINAL_FRACTION * duration, side="left"))
    first = min(first, t.size - 2)
    tail_t, tail_y = t[first:], y[first:]
    span = float(tail_t[-1] - tail_t[0])
    if span <= 0:
        return float(y[-1]), first
    area = float(np.sum((tail_y[1:] + tail_y[:-1]) / 2.0 * np.diff(tail_t)))
    return area / span, first


def _settling_time(t: _Array, y: _Array, final: float, tail: int, band: float) -> float | None:
    distance = np.abs(y - final)
    amplitude = float(distance.max())
    if amplitude <= 1e-12 * max(1.0, abs(final)):
        return 0.0
    limit = band * amplitude
    outside = np.flatnonzero(distance > limit)
    if outside.size == 0:
        return 0.0
    last = int(outside[-1])
    if last >= tail:
        return None
    # Where the distance crosses the limit for the last time, between the last
    # sample outside the band and the one after it.
    d0, d1 = float(distance[last]), float(distance[last + 1])
    crossing = float(t[last]) + (d0 - limit) / (d0 - d1) * float(t[last + 1] - t[last])
    return crossing - float(t[0])


def _overshoot_pct(y: _Array, initial: float, final: float, band: float) -> float | None:
    step = final - initial
    deviation = float(np.abs(y - initial).max())
    if abs(step) <= band * deviation or deviation == 0.0:
        return None
    direction = math.copysign(1.0, step)
    excursion = float((direction * (y - final)).max())
    # A signal that creeps up to its final value over the last of the window
    # is a hair past the mean it is compared with; that is not an overshoot.
    if excursion <= _OVERSHOOT_FLOOR * abs(step):
        return 0.0
    return 100.0 * excursion / abs(step)


def _swings(t: _Array, y: _Array) -> tuple[_Array, _Array]:
    """Time and value of each local extreme of ``y``, each placed by a parabola
    through the sample and its two neighbours."""
    dy = np.diff(y)
    turning = np.flatnonzero(dy[:-1] * dy[1:] < 0) + 1
    times = np.empty(turning.size)
    values = np.empty(turning.size)
    for n, i in enumerate(turning):
        x0, x1, x2 = t[i - 1], t[i], t[i + 1]
        y0, y1, y2 = y[i - 1], y[i], y[i + 1]
        # Parabola through the three points, as a function of x - x1.
        a = ((y2 - y1) / (x2 - x1) - (y1 - y0) / (x1 - x0)) / (x2 - x0)
        b = (y1 - y0) / (x1 - x0) + a * (x1 - x0)
        offset = -b / (2 * a) if a != 0 else 0.0
        if not (x0 - x1) <= offset <= (x2 - x1):
            offset = 0.0
        times[n] = x1 + offset
        values[n] = y1 + b * offset + a * offset * offset
    return times, values


def _damping(t: _Array, y: _Array) -> Damping | None:
    times, values = _swings(t, y)
    if times.size < MIN_SAMPLES:
        return None
    amplitude = np.abs(np.diff(values))
    keep = amplitude > _NOISE_FLOOR * amplitude.max()
    # The oscillation is the run of swings above the floor that starts at the
    # first of them. Wiggles of rounding size before it (a signal that is flat to
    # many digits before an event) and after it (once it has died into noise)
    # say nothing about it.
    first = int(np.argmax(keep))
    run = keep[first:]
    amplitude = amplitude[first : first + (int(np.argmin(run)) if not run.all() else run.size)]
    times = times[first : first + amplitude.size + 1]
    if amplitude.size < MIN_SAMPLES - 1:
        return None
    k = np.arange(amplitude.size, dtype=np.float64)
    slope = float(np.polyfit(k, np.log(amplitude), 1)[0])
    decrement = -slope
    half_period = float(np.mean(np.diff(times)))
    if half_period <= 0:
        return None
    return Damping(
        ratio=decrement / math.hypot(math.pi, decrement),
        frequency_hz=1.0 / (2.0 * half_period),
        extrema=int(amplitude.size + 1),
    )


def response_metrics(
    t: _Samples,
    y: _Samples,
    *,
    t_start: float | None = None,
    t_end: float | None = None,
    settling_band: float = DEFAULT_SETTLING_BAND,
    rocof_window: float = DEFAULT_ROCOF_WINDOW,
) -> ResponseMetrics:
    """Describe the response ``y(t)``; see the module docstring for each metric.

    ``t_start`` and ``t_end`` narrow the window (the rest of the signal is
    ignored, and a bound between two samples is interpolated); ``settling_band``
    is the settling band as a fraction (0.02 is 2 %), ``rocof_window`` the width
    in seconds the rate of change is measured over. Raises
    :class:`ResponseMetricsError` for a signal with fewer than
    :data:`MIN_SAMPLES` usable samples, times that decrease, or a window that
    holds none of it.
    """
    if not 0.0 < settling_band < 1.0:
        raise ResponseMetricsError("settling_band must be between 0 and 1, exclusive")
    if not rocof_window > 0.0:
        raise ResponseMetricsError("rocof_window must be greater than 0")
    tt, yy = _clean(t, y)
    if tt.size < MIN_SAMPLES:
        raise ResponseMetricsError(
            f"the signal has {tt.size} usable samples; at least {MIN_SAMPLES} are needed"
        )
    wt, wy = _window(tt, yy, t_start, t_end)

    initial = float(wy[0])
    final, tail = _final(wt, wy)
    peak = int(np.argmax(wy))
    nadir = int(np.argmin(wy))
    deviation = int(np.argmax(np.abs(wy - initial)))
    return ResponseMetrics(
        samples=int(wt.size),
        t_start=float(wt[0]),
        t_end=float(wt[-1]),
        initial=initial,
        final=final,
        peak=Extremum(float(wy[peak]), float(wt[peak])),
        nadir=Extremum(float(wy[nadir]), float(wt[nadir])),
        max_deviation=Extremum(float(wy[deviation] - initial), float(wt[deviation])),
        rocof=_rocof(wt, wy, rocof_window),
        settling_time=_settling_time(wt, wy, final, tail, settling_band),
        overshoot_pct=_overshoot_pct(wy, initial, final, settling_band),
        damping=_damping(wt, wy),
    )


__all__ = [
    "DEFAULT_ROCOF_WINDOW",
    "DEFAULT_SETTLING_BAND",
    "FINAL_FRACTION",
    "MIN_SAMPLES",
    "Damping",
    "Extremum",
    "ResponseMetrics",
    "ResponseMetricsError",
    "response_metrics",
]
