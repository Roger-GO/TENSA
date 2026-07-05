"""Unit tests for the stream aggregator that drives N-rows-per-batch
emission and anti-aliased decimation."""

from __future__ import annotations

import io

import pyarrow.ipc
import pytest

from tensa.core.stream import (
    StreamAggregator,
    encode_batch,
    make_bus_voltage_schema,
)

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


# ---- encode_batch round-trip ------------------------------------------------


@pytest.mark.unit
def test_encode_batch_round_trip_through_arrow_ipc() -> None:
    """The bytes emitted by ``encode_batch`` decode back through pyarrow's
    standard IPC stream reader. Round-trip is byte-stable for fixed input.

    The bus_v schema now emits ``Bus_<idx>_v`` then ``Bus_<idx>_a`` per
    bus, so each row carries two values per bus interleaved
    ``[v_0, a_0, v_1, a_1, ...]``."""
    schema = make_bus_voltage_schema([1, 2, 3])
    rows = [
        (0.0, [1.0, 0.0, 1.04, -0.03, 1.05, -0.06]),
        (0.01, [1.001, 0.001, 1.039, -0.031, 1.049, -0.061]),
        (0.02, [1.002, 0.002, 1.038, -0.032, 1.048, -0.062]),
    ]
    payload = encode_batch(schema, rows)

    reader = pyarrow.ipc.open_stream(io.BytesIO(payload))
    decoded_schema = reader.schema
    assert decoded_schema.names == [
        "t",
        "Bus_1_v", "Bus_1_a",
        "Bus_2_v", "Bus_2_a",
        "Bus_3_v", "Bus_3_a",
    ]

    batch = reader.read_next_batch()
    assert batch.num_rows == 3
    assert batch.num_columns == 7
    t_col = batch.column("t").to_pylist()
    assert t_col == [0.0, 0.01, 0.02]
    assert batch.column("Bus_1_v").to_pylist() == [1.0, 1.001, 1.002]
    assert batch.column("Bus_1_a").to_pylist() == [0.0, 0.001, 0.002]


@pytest.mark.unit
def test_encode_batch_with_no_rows_raises() -> None:
    schema = make_bus_voltage_schema([1])
    with pytest.raises(ValueError, match="no rows"):
        encode_batch(schema, [])
