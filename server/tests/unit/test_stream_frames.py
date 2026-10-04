"""The wire layout of a streamed frame: ``t`` plus one list column of values.

A run names its columns once, in ``stream_start``. A frame holds numbers only,
so its size, and the cost of encoding or decoding it, follow the number of
values and not a schema with a field per variable.
"""

from __future__ import annotations

import io

import numpy as np
import pyarrow as pa
import pyarrow.ipc
import pytest

from tensa.core.stream import decode_batch, encode_batch

pytestmark = pytest.mark.unit


def _open(payload: bytes) -> pyarrow.ipc.RecordBatchStreamReader:
    return pyarrow.ipc.open_stream(io.BytesIO(payload))


def test_encode_batch_round_trip() -> None:
    """Each row's values come back in the row they went in, in the column
    order: ``[v_0, a_0, v_1, a_1, ...]`` for the bus group."""
    rows = [
        (0.0, [1.0, 0.0, 1.04, -0.03, 1.05, -0.06]),
        (0.01, [1.001, 0.001, 1.039, -0.031, 1.049, -0.061]),
        (0.02, [1.002, 0.002, 1.038, -0.032, 1.048, -0.062]),
    ]

    t, values = decode_batch(encode_batch(6, rows))

    assert t.tolist() == [0.0, 0.01, 0.02]
    assert values.shape == (3, 6)
    assert values.tolist() == [row_values for _t, row_values in rows]


def test_encode_batch_takes_rows_of_arrays_as_it_does_rows_of_lists() -> None:
    """The collector hands the aggregator numpy rows, and the encoder must write
    the same frame for them as for the lists the tests build by hand."""
    lists = [(0.0, [1.0, 0.0, 1.04, -0.03]), (0.01, [1.001, 0.001, 1.039, -0.031])]
    arrays = [(t, np.array(values)) for t, values in lists]

    assert encode_batch(4, arrays) == encode_batch(4, lists)


def test_a_frame_is_one_record_batch_of_t_and_a_values_list() -> None:
    """The frame is a plain Arrow IPC stream any Arrow reader opens: one batch,
    ``t`` and ``v`` (a fixed-size list of float64 per row), whose child holds
    the rows' values one row after the other."""
    rows = [(0.01 * i, [float(i * 10 + j) for j in range(5)]) for i in range(4)]

    reader = _open(encode_batch(5, rows))
    assert reader.schema.names == ["t", "v"]
    assert reader.schema.field("t").type == pa.float64()
    assert reader.schema.field("v").type == pa.list_(pa.float64(), 5)
    batch = reader.read_next_batch()
    assert batch.num_rows == 4
    assert batch.column("v").flatten().to_pylist() == [
        float(i * 10 + j) for i in range(4) for j in range(5)
    ]
    with pytest.raises(StopIteration):
        reader.read_next_batch()


def test_a_frame_does_not_repeat_the_column_names() -> None:
    """The names travel in ``stream_start``; a frame that carried them would
    grow with every column."""
    names = ["Bus_1_v", "Bus_1_a", "Bus_2_v", "Bus_2_a"]

    payload = encode_batch(len(names), [(0.0, [1.0, 0.0, 1.0, 0.0])])

    for name in names:
        assert name.encode() not in payload


@pytest.mark.parametrize("n_columns", [38, 1208, 10_000])
def test_frame_size_follows_the_values_not_the_column_count(n_columns: int) -> None:
    """A frame costs its values (8 bytes each) plus a fixed header, and its
    schema stays two fields wide. With one Arrow column per variable the
    frame for 1208 variables was 134 KB for 9.7 KB of values."""
    payload = encode_batch(n_columns, [(0.5, [0.25] * n_columns)])

    assert len(payload) <= 8 * (n_columns + 1) + 1024
    assert len(_open(payload).schema) == 2


def test_a_run_without_columns_sends_the_time_alone() -> None:
    """A ``vars`` selection with no members on the case (``gen_state`` on a
    case without dynamic models) leaves ``t`` as the only column."""
    payload = encode_batch(0, [(0.0, []), (0.1, [])])

    assert _open(payload).schema.names == ["t"]
    t, values = decode_batch(payload)
    assert t.tolist() == [0.0, 0.1]
    assert values.shape == (2, 0)


def test_nan_and_infinity_survive() -> None:
    """A non-finite value is a value, not a null: the plot draws a gap for NaN."""
    _t, values = decode_batch(encode_batch(3, [(0.0, [float("nan"), float("inf"), -1.5])]))

    assert np.isnan(values[0, 0])
    assert values[0, 1] == float("inf")
    assert values[0, 2] == -1.5


def test_numpy_scalars_and_zero_dimensional_arrays_are_accepted() -> None:
    """ANDES's ``dae.t`` is a 0-d array and its variables are numpy floats."""
    t, values = decode_batch(
        encode_batch(2, [(np.array(0.25), [np.float64(1.5), np.array(2.5)])])  # type: ignore[list-item]
    )

    assert t.tolist() == [0.25]
    assert values.tolist() == [[1.5, 2.5]]


def test_encode_batch_with_no_rows_raises() -> None:
    with pytest.raises(ValueError, match="no rows"):
        encode_batch(1, [])


@pytest.mark.parametrize(
    "rows",
    [
        [(0.0, [1.0])],
        [(0.0, [1.0, 2.0, 3.0])],
        [(0.0, [1.0, 2.0]), (0.1, [1.0])],
        [(0.0, [])],
    ],
    ids=["too few", "too many", "ragged", "empty"],
)
def test_a_row_of_the_wrong_width_is_refused(rows: list[tuple[float, list[float]]]) -> None:
    """A row that does not match the column count would shift every later value
    into the wrong column, so it is refused instead of encoded."""
    with pytest.raises(ValueError):
        encode_batch(2, rows)
