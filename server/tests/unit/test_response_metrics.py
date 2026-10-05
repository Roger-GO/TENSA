"""Unit tests for the response metrics of a sampled signal.

Each metric is checked against a signal whose answer is known in closed form: the
step response of a second-order system (overshoot and settling time follow from
its damping ratio), a damped cosine (damping ratio and frequency are its
parameters), a ramp (the rate of change is its slope), and a frequency dip
(nadir and rate of change of frequency). Sampling is at ANDES's default of 30 Hz
unless a test is about the sampling.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from tensa.core.response_metrics import (
    ResponseMetricsError,
    response_metrics,
)

pytestmark = pytest.mark.unit


def _grid(seconds: float, rate: float = 30.0) -> np.ndarray:
    return np.arange(0.0, seconds + 0.5 / rate, 1.0 / rate)


def _step_response(t: np.ndarray, zeta: float, wn: float) -> np.ndarray:
    """Unit step response of a second-order system with damping ratio ``zeta``."""
    wd = wn * math.sqrt(1 - zeta**2)
    return 1.0 - np.exp(-zeta * wn * t) * (
        np.cos(wd * t) + zeta / math.sqrt(1 - zeta**2) * np.sin(wd * t)
    )


def _damped_sine(t: np.ndarray, zeta: float, f_hz: float, amplitude: float = 1.0) -> np.ndarray:
    """A swing that starts at 1.0 and returns to it, with damping ratio ``zeta``."""
    wd = 2 * math.pi * f_hz
    sigma = zeta * wd / math.sqrt(1 - zeta**2)
    return 1.0 + amplitude * np.exp(-sigma * t) * np.sin(wd * t)


def _damped_cosine(t: np.ndarray, zeta: float, f_hz: float, amplitude: float = 1.0) -> np.ndarray:
    """A swing that decays with damping ratio ``zeta`` at damped frequency ``f_hz``."""
    wd = 2 * math.pi * f_hz
    sigma = zeta * wd / math.sqrt(1 - zeta**2)
    return 1.0 + amplitude * np.exp(-sigma * t) * np.cos(wd * t)


# ---- initial, final, extremes -------------------------------------------------


def test_initial_final_and_extremes_of_a_frequency_dip() -> None:
    t = _grid(10.0)
    # Speed falls from 1.0 to a nadir of 0.992 at 2 s and recovers to 0.996.
    y = np.where(t < 2, 1.0 - 0.004 * t, 0.992 + 0.004 * (1 - np.exp(-(t - 2))))

    m = response_metrics(t, y)

    assert m.initial == 1.0
    assert m.final == pytest.approx(0.9959, abs=2e-4)
    assert m.nadir.value == pytest.approx(0.992, abs=1e-6)
    assert m.nadir.t == pytest.approx(2.0, abs=1 / 30)
    assert m.peak.value == 1.0
    assert m.peak.t == 0.0
    assert m.max_deviation.value == pytest.approx(-0.008, abs=1e-6)
    assert m.max_deviation.t == pytest.approx(2.0, abs=1 / 30)
    assert m.samples == len(t)
    assert (m.t_start, m.t_end) == (0.0, pytest.approx(10.0))


def test_a_deviation_upwards_is_positive() -> None:
    t = _grid(5.0)
    y = 1.0 + 0.05 * np.exp(-((t - 1.0) ** 2) / 0.1)

    m = response_metrics(t, y)

    assert m.max_deviation.value == pytest.approx(0.05, abs=1e-3)
    assert m.peak.value == pytest.approx(1.05, abs=1e-3)


# ---- rate of change ------------------------------------------------------------


def test_the_rate_of_change_of_a_ramp_is_its_slope_whatever_the_window() -> None:
    t = _grid(4.0)
    y = 1.0 - 0.01 * t

    for window in (0.1, 0.5, 2.0):
        m = response_metrics(t, y, rocof_window=window)
        assert m.rocof is not None
        assert m.rocof.value == pytest.approx(-0.01, rel=1e-6)


def test_the_rate_of_change_finds_the_steepest_stretch_and_where_it_starts() -> None:
    t = _grid(10.0)
    # Flat, then a steep fall between 3 s and 4 s, then flat.
    y = np.interp(t, [0, 3, 4, 10], [1.0, 1.0, 0.98, 0.98])

    m = response_metrics(t, y, rocof_window=0.5)

    assert m.rocof is not None
    assert m.rocof.value == pytest.approx(-0.02, rel=1e-6)
    assert 3.0 <= m.rocof.t <= 3.5 + 1e-9


def test_the_window_is_cut_to_the_signal_when_it_is_longer() -> None:
    t = _grid(0.3)
    y = 2.0 * t

    m = response_metrics(t, y, rocof_window=5.0)

    assert m.rocof is not None
    assert m.rocof.value == pytest.approx(2.0)


# ---- overshoot and settling ----------------------------------------------------


@pytest.mark.parametrize("zeta", [0.1, 0.3, 0.6])
def test_overshoot_of_a_second_order_step_follows_its_damping(zeta: float) -> None:
    t = _grid(40.0)
    y = _step_response(t, zeta, wn=2 * math.pi * 0.5)

    m = response_metrics(t, y)

    expected = 100 * math.exp(-math.pi * zeta / math.sqrt(1 - zeta**2))
    assert m.overshoot_pct == pytest.approx(expected, rel=0.03)
    assert m.initial == 0.0
    assert m.final == pytest.approx(1.0, abs=1e-3)


def test_a_response_that_never_goes_past_its_final_value_has_no_overshoot() -> None:
    t = _grid(20.0)
    y = 1.0 - np.exp(-t)

    assert response_metrics(t, y).overshoot_pct == 0.0


def test_a_falling_step_overshoots_downwards() -> None:
    t = _grid(40.0)
    y = 1.0 - _step_response(t, 0.3, wn=2 * math.pi * 0.5)  # 1 down to 0

    m = response_metrics(t, y)

    assert m.overshoot_pct == pytest.approx(100 * math.exp(-math.pi * 0.3 / math.sqrt(0.91)), rel=0.03)


def test_an_oscillation_that_returns_to_its_start_has_no_step_to_overshoot() -> None:
    t = _grid(30.0)

    assert response_metrics(t, _damped_sine(t, 0.1, 0.8)).overshoot_pct is None


@pytest.mark.parametrize("zeta", [0.3, 0.6])
def test_settling_time_of_a_second_order_step_is_where_it_enters_the_band_for_good(
    zeta: float,
) -> None:
    wn = 2 * math.pi * 0.5
    t = _grid(40.0)
    y = _step_response(t, zeta, wn)

    m = response_metrics(t, y)

    # The last time the response is outside 2 % of its largest distance from the
    # final value (the step itself, 1.0, or the overshoot), found by brute force
    # on a fine grid.
    fine = np.linspace(0, 40, 400_001)
    distance = np.abs(_step_response(fine, zeta, wn) - 1.0)
    limit = 0.02 * distance.max()
    expected = fine[np.flatnonzero(distance > limit)[-1]]
    assert m.settling_time == pytest.approx(expected, abs=0.05)


def test_a_signal_that_never_leaves_the_band_settles_at_once() -> None:
    t = _grid(5.0)
    y = np.ones_like(t)

    m = response_metrics(t, y)

    assert m.settling_time == 0.0
    assert m.overshoot_pct is None
    assert m.damping is None
    assert m.rocof is not None and m.rocof.value == 0.0


def test_a_signal_still_moving_at_the_end_has_not_settled() -> None:
    t = _grid(10.0)
    y = np.sin(2 * math.pi * 0.2 * t)  # a full oscillation with no decay

    assert response_metrics(t, y).settling_time is None


def test_settling_time_counts_from_the_start_of_the_window() -> None:
    t = _grid(40.0)
    y = np.where(t < 5, 0.0, _step_response(np.maximum(t - 5, 0), 0.5, 2 * math.pi * 0.5))

    whole = response_metrics(t, y)
    from_the_step = response_metrics(t, y, t_start=5.0)

    assert whole.settling_time is not None and from_the_step.settling_time is not None
    assert whole.settling_time - from_the_step.settling_time == pytest.approx(5.0, abs=0.1)


def test_a_wider_band_settles_sooner() -> None:
    t = _grid(40.0)
    y = _step_response(t, 0.2, 2 * math.pi * 0.5)

    narrow = response_metrics(t, y, settling_band=0.02).settling_time
    wide = response_metrics(t, y, settling_band=0.2).settling_time

    assert narrow is not None and wide is not None
    assert wide < narrow


# ---- damping --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("zeta", "f_hz"), [(0.02, 0.4), (0.05, 0.8), (0.1, 1.5), (0.25, 0.6)]
)
def test_damping_ratio_and_frequency_of_a_damped_cosine_are_recovered(
    zeta: float, f_hz: float
) -> None:
    t = _grid(40.0)

    m = response_metrics(t, _damped_cosine(t, zeta, f_hz))

    assert m.damping is not None
    assert m.damping.ratio == pytest.approx(zeta, rel=0.03)
    assert m.damping.frequency_hz == pytest.approx(f_hz, rel=0.02)
    assert m.damping.extrema >= 3


def test_a_growing_oscillation_has_negative_damping() -> None:
    t = _grid(20.0)
    y = 1.0 + 0.01 * np.exp(0.05 * t) * np.cos(2 * math.pi * 0.7 * t)

    m = response_metrics(t, y)

    assert m.damping is not None
    assert m.damping.ratio < 0
    assert m.damping.ratio == pytest.approx(-0.05 / (2 * math.pi * 0.7), rel=0.05)


def test_damping_does_not_depend_on_where_the_oscillation_sits_or_its_size() -> None:
    t = _grid(30.0)
    base = response_metrics(t, _damped_cosine(t, 0.08, 0.9)).damping
    moved = response_metrics(t, 7.0 + 300.0 * (_damped_cosine(t, 0.08, 0.9) - 1.0)).damping

    assert base is not None and moved is not None
    assert moved.ratio == pytest.approx(base.ratio, rel=1e-6)
    assert moved.frequency_hz == pytest.approx(base.frequency_hz, rel=1e-6)


def test_damping_is_read_from_the_swing_after_a_flat_start() -> None:
    """A trace is flat until the disturbance. Rounding noise before it must not
    be taken for the oscillation."""
    rng = np.random.default_rng(3)
    t = _grid(40.0)
    wiggle = _damped_sine(np.maximum(t - 5, 0), 0.07, 0.8) - 1.0
    y = 1.0 + np.where(t < 5, 0.0, wiggle) + rng.normal(0, 1e-12, t.size)

    m = response_metrics(t, y)

    assert m.damping is not None
    assert m.damping.ratio == pytest.approx(0.07, rel=0.05)


def test_samples_between_the_swings_are_enough_at_a_coarse_rate() -> None:
    """At 10 Hz a 1.5 Hz swing has about 3 samples a half cycle: the parabola
    through each extreme keeps the estimate close."""
    t = _grid(30.0, rate=10.0)

    m = response_metrics(t, _damped_cosine(t, 0.06, 1.5))

    assert m.damping is not None
    assert m.damping.ratio == pytest.approx(0.06, rel=0.1)


def test_a_signal_that_only_decays_has_no_oscillation() -> None:
    t = _grid(10.0)

    assert response_metrics(t, np.exp(-t)).damping is None


def test_a_signal_with_one_swing_has_no_damping_estimate() -> None:
    t = _grid(10.0)
    y = np.exp(-((t - 3) ** 2))

    assert response_metrics(t, y).damping is None


# ---- the window ----------------------------------------------------------------


def test_a_window_looks_only_at_the_signal_inside_it() -> None:
    t = _grid(20.0)
    y = np.where(t < 10, 5.0 + np.sin(t), 1.0 - 0.02 * (t - 10))

    m = response_metrics(t, y, t_start=10.0, t_end=15.0)

    assert m.initial == pytest.approx(1.0)
    assert m.peak.value == pytest.approx(1.0)
    assert m.nadir.value == pytest.approx(0.9, abs=1e-6)
    assert (m.t_start, m.t_end) == (10.0, 15.0)


def test_a_window_bound_between_samples_is_interpolated() -> None:
    t = np.array([0.0, 1.0, 2.0, 3.0, 4.0])
    y = np.array([0.0, 10.0, 20.0, 30.0, 40.0])

    m = response_metrics(t, y, t_start=0.5, t_end=3.5)

    assert m.initial == 5.0
    assert m.nadir.value == 5.0
    assert m.peak.value == 35.0
    assert m.samples == 5  # the two bounds and the three samples between them


def test_a_window_wider_than_the_signal_is_the_whole_signal() -> None:
    t = _grid(5.0)
    y = np.sin(t)

    wide = response_metrics(t, y, t_start=-10.0, t_end=100.0)
    whole = response_metrics(t, y)

    assert wide == whole


def test_a_window_outside_the_signal_is_refused() -> None:
    t = _grid(5.0)

    with pytest.raises(ResponseMetricsError, match="holds no part"):
        response_metrics(t, np.sin(t), t_start=6.0, t_end=9.0)


def test_a_window_holding_too_few_samples_is_refused() -> None:
    t = _grid(5.0)

    with pytest.raises(ResponseMetricsError, match="at least 3"):
        response_metrics(t, np.sin(t), t_start=1.0, t_end=1.0 + 1e-3)


# ---- what is done with the samples -------------------------------------------------


def test_samples_that_are_not_numbers_are_dropped() -> None:
    t = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]
    y = [1.0, None, 3.0, float("nan"), 5.0, 6.0]

    m = response_metrics(t, y)

    assert m.samples == 4
    assert m.initial == 1.0
    assert m.peak.value == 6.0


def test_samples_at_one_time_collapse_to_the_last() -> None:
    """ANDES records a time twice when an event changes the system at that
    instant: the value after the event is the one that carries on."""
    t = [0.0, 1.0, 1.0, 2.0, 3.0]
    y = [1.0, 1.0, 0.5, 0.5, 0.5]

    m = response_metrics(t, y)

    assert m.samples == 4
    assert m.nadir.value == 0.5
    assert m.nadir.t == 1.0


def test_times_that_run_backwards_are_refused() -> None:
    with pytest.raises(ResponseMetricsError, match="must not decrease"):
        response_metrics([0.0, 2.0, 1.0, 3.0], [1.0, 2.0, 3.0, 4.0])


def test_unequal_lengths_are_refused() -> None:
    with pytest.raises(ResponseMetricsError, match="same length"):
        response_metrics([0.0, 1.0, 2.0], [1.0, 2.0])


def test_too_few_samples_are_refused() -> None:
    with pytest.raises(ResponseMetricsError, match="at least 3"):
        response_metrics([0.0, 1.0], [1.0, 2.0])


def test_the_samples_do_not_have_to_be_evenly_spaced() -> None:
    rng = np.random.default_rng(5)
    t = np.sort(rng.uniform(0, 40, 1500))
    t[0] = 0.0

    m = response_metrics(t, _damped_cosine(t, 0.05, 0.8))

    assert m.damping is not None
    assert m.damping.ratio == pytest.approx(0.05, rel=0.05)


@pytest.mark.parametrize("band", [0.0, 1.0, -0.1, 2.0])
def test_a_settling_band_outside_zero_and_one_is_refused(band: float) -> None:
    with pytest.raises(ResponseMetricsError, match="settling_band"):
        response_metrics([0.0, 1.0, 2.0], [0.0, 1.0, 2.0], settling_band=band)


@pytest.mark.parametrize("window", [0.0, -1.0])
def test_a_rate_window_that_is_not_positive_is_refused(window: float) -> None:
    with pytest.raises(ResponseMetricsError, match="rocof_window"):
        response_metrics([0.0, 1.0, 2.0], [0.0, 1.0, 2.0], rocof_window=window)
