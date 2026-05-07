"""Arrow IPC encoder for TDS streaming.

Each per-step state snapshot is encoded as a self-contained Arrow IPC
stream (schema header + one RecordBatch with one row). This is wasteful
(~150 bytes of schema overhead per frame) but lets the client decode each
WebSocket binary frame independently with no per-stream state. A future
optimization batches N rows per emit (the plan's N-rows-per-batch default);
v0.1 streaming accepts the overhead for the simpler client side.

The schema is ``t: float64`` plus one float64 column per selected state
variable. For v0.1 the default selection is all bus voltages
(``Bus.v`` indexed by ANDES bus idx), named ``Bus_<idx>_v``. Future
extensions can let the caller pick state variables; the wire format is
forward-compatible because ``var_columns`` is part of the stream-start
metadata message.
"""

from __future__ import annotations

import io
from typing import TYPE_CHECKING

import pyarrow as pa
import pyarrow.ipc

if TYPE_CHECKING:
    from andes.system import System


def make_bus_voltage_schema(bus_idx_values: list[int | str]) -> pa.Schema:
    """Build the Arrow schema for a stream emitting bus voltages over time.

    ``t`` is the simulation time; each ``Bus_<idx>_v`` column carries the
    bus voltage magnitude in pu at that time. Column names are stable
    across the stream and are also surfaced in the stream-start metadata
    message so the client can label plots.
    """
    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    for idx in bus_idx_values:
        fields.append(pa.field(f"Bus_{idx}_v", pa.float64()))
    return pa.schema(fields)


def encode_self_contained_batch(
    schema: pa.Schema,
    t: float,
    values: list[float],
) -> bytes:
    """Encode a single row (one timestep + N bus voltages) as a self-contained
    Arrow IPC stream chunk. Caller can send the returned bytes verbatim as
    a WebSocket binary frame.

    ``t`` and each entry in ``values`` may arrive as numpy scalars or 0-d
    ndarrays (ANDES's ``dae.t`` is a numpy scalar). We coerce to Python
    ``float`` here so pyarrow's array constructor doesn't need to introspect
    the wrapper type.
    """
    columns: list[pa.Array] = [pa.array([float(t)], type=pa.float64())]
    for v in values:
        columns.append(pa.array([float(v)], type=pa.float64()))
    batch = pa.RecordBatch.from_arrays(columns, schema=schema)
    sink = io.BytesIO()
    # pyarrow ships partial stubs; new_stream is untyped in the published
    # type information but is a stable API.
    with pa.ipc.new_stream(sink, schema) as writer:  # type: ignore[no-untyped-call]
        writer.write_batch(batch)
    return sink.getvalue()


def collect_bus_voltages(system: System) -> list[float]:
    """Read the current bus voltage magnitudes off the System's Bus model.

    ``ss.Bus.v.v`` is the numpy array of bus voltage magnitudes (pu),
    indexed in the same order as ``ss.Bus.idx.v`` (returned by
    ``bus_idx_values_from_system``).
    """
    return [float(v) for v in system.Bus.v.v]


def bus_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES bus idx values in the order their voltages will
    appear in each Arrow batch."""
    return list(system.Bus.idx.v)


__all__ = [
    "bus_idx_values_from_system",
    "collect_bus_voltages",
    "encode_self_contained_batch",
    "make_bus_voltage_schema",
]
