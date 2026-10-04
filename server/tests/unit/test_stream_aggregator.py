"""Unit tests for the stream aggregator that drives N-rows-per-batch
emission and anti-aliased decimation."""

from __future__ import annotations

import numpy as np
import pytest

from tensa.core.stream import StreamAggregator

# ---- StreamAggregator -------------------------------------------------------


@pytest.mark.unit
def test_decimation_none_no_rate_emits_per_push() -> None:
    agg = StreamAggregator(decimation="none", max_rate_hz=None)
    rows = agg.push(0.001, [1.0, 2.0])
    assert rows == [(0.001, [1.0, 2.0])]
    rows2 = agg.push(0.002, [1.1, 2.1])
    assert rows2 == [(0.002, [1.1, 2.1])]
    assert agg.algorithm == "none"
    assert agg.output_rate_hz is None


@pytest.mark.unit
def test_decimation_none_with_rate_buffers_until_window() -> None:
    """With ``decimation="none"`` + ``max_rate_hz=10`` (window=0.1s), source
    steps that fall inside window 0 ([0, 0.1)) accumulate. The boundary
    sample at t=0.1 belongs to window 1 and triggers an emit of the
    previous window's contents (9 rows)."""
    agg = StreamAggregator(decimation="none", max_rate_hz=10.0)
    # Steps at 0.01, 0.02, ..., 0.09 — all in window [0, 0.1)
    for i in range(1, 10):
        t = i * 0.01
        rows = agg.push(t, [float(i), float(i) * 2])
        assert rows is None, f"unexpected mid-window emit at t={t}: {rows}"

    # The sample at t=0.10 belongs to window [0.1, 0.2) and triggers the emit
    # of the prior window's 9 buffered rows.
    final = agg.push(0.10, [10.0, 20.0])
    assert final is not None
    assert len(final) == 9


@pytest.mark.unit
def test_decimation_mean_emits_one_row_per_window() -> None:
    """With ``decimation="mean"`` + ``max_rate_hz=10`` (window=0.1s), the
    boundary sample at t=0.1 closes window 0; that window's mean is the
    mean of the 9 buffered samples (values 1..9, times 0.01..0.09)."""
    agg = StreamAggregator(decimation="mean", max_rate_hz=10.0)
    for i in range(1, 10):
        t = i * 0.01
        rows = agg.push(t, [float(i)])
        assert rows is None  # no emit until window closes

    rows = agg.push(0.10, [10.0])
    assert rows is not None
    assert len(rows) == 1
    emitted_t, emitted_values = rows[0]
    # Mean of t in {0.01..0.09} = 0.05
    assert pytest.approx(emitted_t, abs=1e-9) == 0.05
    # Mean of values in {1..9} = 5.0
    assert pytest.approx(emitted_values[0], abs=1e-9) == 5.0


@pytest.mark.unit
def test_decimation_mean_subsequent_windows_align_to_origin() -> None:
    """After emitting window 0, subsequent windows are aligned to the t=0
    origin (boundaries at 0.1, 0.2, 0.3, ...). The aggregator does not drift
    based on first-seen t."""
    agg = StreamAggregator(decimation="mean", max_rate_hz=10.0)
    # Window 0: samples at t=0.05 and 0.06
    agg.push(0.05, [10.0])
    agg.push(0.06, [12.0])
    # Cross into window 1 at t=0.10
    rows0 = agg.push(0.10, [100.0])  # seeds window 1
    assert rows0 is not None and len(rows0) == 1
    # Window 1: samples at 0.15
    agg.push(0.15, [200.0])
    # Cross into window 2 at t=0.20
    rows1 = agg.push(0.20, [999.0])
    assert rows1 is not None and len(rows1) == 1
    # Window 1 contained t=0.10 and t=0.15, mean t = 0.125
    assert pytest.approx(rows1[0][0], abs=1e-9) == 0.125
    # Mean of values 100.0 and 200.0 is 150.0
    assert pytest.approx(rows1[0][1][0], abs=1e-9) == 150.0


@pytest.mark.unit
def test_decimation_mean_without_rate_raises() -> None:
    with pytest.raises(ValueError, match="max_rate_hz"):
        StreamAggregator(decimation="mean", max_rate_hz=None)


@pytest.mark.unit
def test_algorithm_label_reflects_integrator_step_mode() -> None:
    """For decimation=mean, ``algorithm`` is ``"boxcar-mean"`` only when the
    integrator is fixed-step; otherwise the math is best-effort and the
    label declares it honestly."""
    fixed = StreamAggregator(decimation="mean", max_rate_hz=10.0, fixed_step=True)
    assert fixed.algorithm == "boxcar-mean"

    adaptive = StreamAggregator(decimation="mean", max_rate_hz=10.0, fixed_step=False)
    assert adaptive.algorithm == "boxcar-mean-best-effort"


@pytest.mark.unit
def test_algorithm_label_for_none_is_none() -> None:
    """``decimation="none"`` is always labeled ``"none"`` regardless of step
    mode (no decimation math involved)."""
    agg_a = StreamAggregator(decimation="none", max_rate_hz=None, fixed_step=False)
    agg_b = StreamAggregator(decimation="none", max_rate_hz=10.0, fixed_step=True)
    assert agg_a.algorithm == "none"
    assert agg_b.algorithm == "none"


@pytest.mark.unit
def test_flush_drains_buffer_at_end_of_run() -> None:
    agg = StreamAggregator(decimation="none", max_rate_hz=10.0)
    agg.push(0.01, [1.0])
    agg.push(0.02, [2.0])
    # No emit yet (still inside window [0, 0.1))
    tail = agg.flush()
    assert tail is not None
    assert len(tail) == 2


@pytest.mark.unit
def test_flush_after_partial_window_returns_only_buffered_rows() -> None:
    """A run that ends mid-window emits only the partial window's buffer,
    not a faux window-aligned summary."""
    agg = StreamAggregator(decimation="mean", max_rate_hz=10.0)
    agg.push(0.05, [1.0])
    agg.push(0.06, [2.0])
    # Run ends mid-window
    tail = agg.flush()
    assert tail is not None
    assert len(tail) == 1
    # Mean of values 1.0, 2.0 = 1.5; mean of t = 0.055
    assert pytest.approx(tail[0][0], abs=1e-9) == 0.055
    assert pytest.approx(tail[0][1][0], abs=1e-9) == 1.5


@pytest.mark.unit
def test_flush_returns_none_when_buffer_empty() -> None:
    agg = StreamAggregator(decimation="none", max_rate_hz=None)
    # decimation=none + no rate → push always emits, never buffers
    agg.push(0.001, [1.0])
    assert agg.flush() is None


# ---- the step time is copied when a row is buffered ---------------------------


@pytest.mark.unit
def test_buffered_rows_keep_the_time_their_step_had() -> None:
    """ANDES calls ``callpert`` with the same mutable 0-d array (``dae.t``) at
    every step. Rows that kept that reference all read as the newest step's
    time once the window closed, so every row of a batch carried one ``t``."""
    clock = np.array(0.0)
    agg = StreamAggregator(decimation="none", max_rate_hz=10.0)
    for i in range(1, 10):
        clock[...] = i * 0.01
        assert agg.push(clock, [float(i)]) is None  # type: ignore[arg-type]

    clock[...] = 0.10
    rows = agg.push(clock, [10.0])  # type: ignore[arg-type]
    assert rows is not None
    assert [t for t, _ in rows] == pytest.approx([i * 0.01 for i in range(1, 10)])
    tail = agg.flush()
    assert tail is not None
    assert [t for t, _ in tail] == pytest.approx([0.10])


@pytest.mark.unit
def test_mean_row_time_is_the_window_mean_of_the_step_times() -> None:
    """The mean row's ``t`` averages the times of the steps in the window,
    ``0.05`` here, not the time of the sample that closed the window."""
    clock = np.array(0.0)
    agg = StreamAggregator(decimation="mean", max_rate_hz=10.0)
    for i in range(1, 10):
        clock[...] = i * 0.01
        agg.push(clock, [float(i)])  # type: ignore[arg-type]

    clock[...] = 0.10
    rows = agg.push(clock, [10.0])  # type: ignore[arg-type]
    assert rows is not None
    assert len(rows) == 1
    assert rows[0][0] == pytest.approx(0.05)


# ---- rows of numpy arrays ------------------------------------------------------


@pytest.mark.unit
def test_mean_of_array_rows_is_the_column_wise_mean() -> None:
    """The collector pushes numpy rows. A window's mean row is one array, each
    column the mean of that column's values over the window."""
    agg = StreamAggregator(decimation="mean", max_rate_hz=10.0)
    agg.push(0.02, np.array([1.0, 10.0, -1.0]))
    agg.push(0.04, np.array([2.0, 20.0, -2.0]))
    agg.push(0.06, np.array([6.0, 60.0, -6.0]))

    rows = agg.push(0.10, np.array([100.0, 100.0, 100.0]))

    assert rows is not None and len(rows) == 1
    t, values = rows[0]
    assert t == pytest.approx(0.04)
    assert np.asarray(values).tolist() == pytest.approx([3.0, 30.0, -3.0])


@pytest.mark.unit
def test_mean_over_wide_rows_matches_the_mean_taken_one_column_at_a_time() -> None:
    """A WECC row is 1208 values. The window mean is taken as one array
    operation; it must agree with averaging each column on its own."""
    rng = np.random.default_rng(11)
    pushed = [rng.normal(size=1208) for _ in range(6)]
    agg = StreamAggregator(decimation="mean", max_rate_hz=10.0)
    for i, row in enumerate(pushed):
        assert agg.push(0.01 * (i + 1), row) is None

    tail = agg.flush()

    assert tail is not None
    expected = [sum(row[j] for row in pushed) / len(pushed) for j in range(1208)]
    assert np.asarray(tail[0][1]).tolist() == pytest.approx(expected, rel=1e-12, abs=1e-12)


@pytest.mark.unit
def test_mean_of_rows_with_no_columns_still_averages_the_times() -> None:
    """A run that selects only groups with no devices on the case streams ``t``
    alone, and its windows still close with the mean time."""
    agg = StreamAggregator(decimation="mean", max_rate_hz=10.0)
    agg.push(0.02, np.empty(0))
    agg.push(0.04, np.empty(0))

    tail = agg.flush()

    assert tail is not None
    assert tail[0][0] == pytest.approx(0.03)
    assert np.asarray(tail[0][1]).shape == (0,)
