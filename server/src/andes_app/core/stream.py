"""Arrow IPC encoder + decimation aggregator for TDS streaming.

Each emitted Arrow batch is a self-contained IPC stream chunk (schema
header + one RecordBatch with one or more rows). The schema is ``t:
float64`` plus one float64 column per selected state variable; for v0.1
the default selection is all bus voltages (``Bus.v`` indexed by ANDES
bus idx, named ``Bus_<idx>_v``).

Two streaming modes:

- ``decimation="none"`` — every callpert step is one row. If
  ``max_rate_hz`` is also configured, multiple source steps are batched
  into one Arrow batch every ``1/max_rate_hz`` simulated seconds (cuts
  Arrow framing overhead from ~50% to ~3% per the plan's N-rows-per-batch
  guidance). Otherwise every step is its own one-row batch (highest
  fidelity, highest overhead, useful for spectral debugging).
- ``decimation="mean"`` — every aggregation window emits one row whose
  values are the boxcar mean of source steps in that window. Anti-aliases
  oscillations above the output Nyquist *when the integrator is fixed-step*;
  on adaptive-step integrators (ANDES default) the math is best-effort,
  declared honestly via ``algorithm: "boxcar-mean-best-effort"`` in the
  stream-start metadata.

The ``StreamAggregator`` owns the buffering decision; the worker just
calls ``push(t, values)`` per callpert step and ``flush()`` at run end,
and emits whatever rows the aggregator returns as one Arrow batch.
"""

from __future__ import annotations

import io
from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import pyarrow as pa
import pyarrow.ipc

if TYPE_CHECKING:
    from andes.system import System


DecimationAlgorithm = Literal["none", "boxcar-mean", "boxcar-mean-best-effort"]
DecimationMode = Literal["none", "mean"]


# ---- schema -----------------------------------------------------------------


def make_bus_voltage_schema(bus_idx_values: list[int | str]) -> pa.Schema:
    """Build the Arrow schema for a stream emitting bus voltages over time.

    ``t`` is the simulation time; each ``Bus_<idx>_v`` column carries the
    bus voltage magnitude in pu at that time. Column names are stable
    across the stream and surfaced in the stream-start metadata.
    """
    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    for idx in bus_idx_values:
        fields.append(pa.field(f"Bus_{idx}_v", pa.float64()))
    return pa.schema(fields)


# ---- encoding ---------------------------------------------------------------


def encode_batch(
    schema: pa.Schema,
    rows: Iterable[tuple[float, list[float]]],
) -> bytes:
    """Encode one or more rows into a self-contained Arrow IPC stream chunk.

    ``rows`` is an iterable of ``(t, values)`` tuples. Each value list must
    match the schema's variable columns in order. ``t`` and each variable
    value may arrive as numpy scalars or 0-d ndarrays (ANDES's ``dae.t`` is a
    numpy scalar); we coerce to ``float`` so pyarrow's array constructor
    doesn't need to introspect the wrapper type.
    """
    rows_list = list(rows)
    if not rows_list:
        # Empty batch is meaningless; signal up to caller.
        raise ValueError("encode_batch called with no rows")

    n_vars = len(rows_list[0][1])
    t_array = pa.array([float(t) for t, _ in rows_list], type=pa.float64())
    var_arrays = [
        pa.array(
            [float(row_values[i]) for _t, row_values in rows_list],
            type=pa.float64(),
        )
        for i in range(n_vars)
    ]
    columns: list[pa.Array] = [t_array, *var_arrays]
    batch = pa.RecordBatch.from_arrays(columns, schema=schema)
    sink = io.BytesIO()
    # pyarrow ships partial stubs; new_stream is untyped in the published type
    # information but is a stable API.
    with pa.ipc.new_stream(sink, schema) as writer:  # type: ignore[no-untyped-call]
        writer.write_batch(batch)
    return sink.getvalue()


# ---- ANDES wiring -----------------------------------------------------------


def collect_bus_voltages(system: System) -> list[float]:
    """Read the current bus voltage magnitudes off the System's Bus model."""
    return [float(v) for v in system.Bus.v.v]


def bus_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES bus idx values in the order their voltages will
    appear in each Arrow batch."""
    return list(system.Bus.idx.v)


# ---- aggregator -------------------------------------------------------------


@dataclass
class StreamAggregator:
    """Buffers per-step ``(t, values)`` snapshots and decides when to emit.

    Modes:

    - ``decimation="none"`` + ``max_rate_hz=None`` — every push emits as a
      one-row batch (no aggregation; one Arrow batch per source step).
    - ``decimation="none"`` + ``max_rate_hz=N`` — buffer until
      ``next_emit_t``, then emit all buffered rows as one Arrow batch
      (N-rows-per-batch; cuts Arrow framing overhead).
    - ``decimation="mean"`` + ``max_rate_hz=N`` — buffer until
      ``next_emit_t``, then emit one row whose values are the mean of all
      buffered values (anti-aliased decimation; output rate = N Hz).

    ``decimation="mean"`` requires ``max_rate_hz`` (the aggregation window
    is ``1/max_rate_hz`` simulated seconds). The constructor raises
    ``ValueError`` if the combination is invalid.
    """

    decimation: DecimationMode
    max_rate_hz: float | None
    fixed_step: bool = False  # ANDES TDS.config.fixt
    _next_emit_t: float | None = None
    _buffer: list[tuple[float, list[float]]] | None = None

    def __post_init__(self) -> None:
        if self.decimation == "mean" and self.max_rate_hz is None:
            raise ValueError(
                "decimation='mean' requires max_rate_hz to be set "
                "(the aggregation window is 1/max_rate_hz seconds)"
            )
        self._buffer = []

    @property
    def algorithm(self) -> DecimationAlgorithm:
        """Honest algorithm label for the stream-start metadata."""
        if self.decimation == "none":
            return "none"
        # For mean: only label "boxcar-mean" if integrator is fixed-step;
        # otherwise the math is best-effort because samples aren't uniformly
        # spaced in simulated time.
        return "boxcar-mean" if self.fixed_step else "boxcar-mean-best-effort"

    @property
    def output_rate_hz(self) -> float | None:
        """Output emission rate (Hz) declared in the stream-start metadata.

        ``None`` when no rate-bound aggregation is active (every source
        step emits)."""
        return self.max_rate_hz if self.max_rate_hz is not None else None

    @property
    def aggregation_window(self) -> float | None:
        """Aggregation window in simulated seconds, or ``None`` if no rate."""
        return 1.0 / self.max_rate_hz if self.max_rate_hz is not None else None

    def push(
        self, t: float, values: list[float]
    ) -> list[tuple[float, list[float]]] | None:
        """Add a per-step snapshot. Returns the list of rows to emit as one
        Arrow batch, or ``None`` if no emit is due yet.

        Window alignment is anchored to the t=0 simulation origin so windows
        are predictable: [0, W), [W, 2W), ... A sample at exactly the
        boundary t=k*W belongs to window k (the higher-numbered one) and
        seeds the new window's buffer; the previous window's accumulated
        rows emit.
        """
        assert self._buffer is not None  # set in __post_init__
        window = self.aggregation_window

        if window is None:
            # decimation="none" + no rate → emit immediately, no buffering.
            return [(t, values)]

        # Anchor the first emit deadline to the t=0 origin: the next boundary
        # is the smallest k*W strictly greater than t. (k = floor(t/W) + 1)
        if self._next_emit_t is None:
            self._next_emit_t = (int(t // window) + 1) * window

        if t < self._next_emit_t:
            # Still inside the current window — buffer and don't emit.
            self._buffer.append((t, values))
            return None

        # Window boundary crossed. Drain the previous window's contents and
        # emit them now; the just-pushed sample belongs to the new window.
        rows = self._drain_buffer()

        # Advance the window. Multiple boundaries may have passed in rare
        # cases (large jumps in simulated t); align next_emit_t to the next
        # boundary strictly greater than the current sample.
        while self._next_emit_t <= t:
            self._next_emit_t += window

        # Seed the new window with the just-pushed sample.
        self._buffer.append((t, values))
        return rows

    def flush(self) -> list[tuple[float, list[float]]] | None:
        """Emit any buffered rows at end of run. Returns ``None`` if buffer
        is empty (e.g., no callpert fired since the last emit)."""
        assert self._buffer is not None
        if not self._buffer:
            return None
        return self._drain_buffer()

    def _drain_buffer(self) -> list[tuple[float, list[float]]]:
        assert self._buffer is not None
        if self.decimation == "none":
            rows = list(self._buffer)
        else:  # mean
            n = len(self._buffer)
            t_mean = sum(b[0] for b in self._buffer) / n
            n_vars = len(self._buffer[0][1])
            mean_values = [
                sum(b[1][i] for b in self._buffer) / n for i in range(n_vars)
            ]
            rows = [(t_mean, mean_values)]
        self._buffer.clear()
        return rows


__all__ = [
    "DecimationAlgorithm",
    "DecimationMode",
    "StreamAggregator",
    "bus_idx_values_from_system",
    "collect_bus_voltages",
    "encode_batch",
    "make_bus_voltage_schema",
]
