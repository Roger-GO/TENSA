"""What the streaming TDS handler puts in its frames, checked end to end.

The unit tests drive the aggregator and the encoder with made-up rows. These
run the worker's handler on ANDES's bundled IEEE 14 case, with a recording
pipe in place of the data Pipe, and read the frames it would have sent.

Markers: ``integration``.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core import worker
from tensa.core.stream import decode_batch
from tensa.core.wrapper import Wrapper


def _ieee14_paths() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    raw = cases / "ieee14.raw"
    dyr = cases / "ieee14.dyr"
    if not raw.exists() or not dyr.exists():  # pragma: no cover
        pytest.skip(f"IEEE 14 fixtures not bundled with this ANDES install: {cases}")
    return raw, dyr


class _RecordingPipe:
    """Stands in for the worker's data Pipe; keeps every message sent."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    def frames(self) -> list[dict[str, Any]]:
        return [m for m in self.sent if m["type"] == "stream_frame"]

    def metadata(self) -> dict[str, Any]:
        (start,) = (m for m in self.sent if m["type"] == "stream_start")
        metadata: dict[str, Any] = start["metadata"]
        return metadata


@pytest.fixture
def wrapper() -> Wrapper:
    raw, dyr = _ieee14_paths()
    w = Wrapper()
    w.load_case(raw, addfiles=[dyr])
    return w


def _stream(w: Wrapper, **args: Any) -> _RecordingPipe:
    pipe = _RecordingPipe()
    request: dict[str, Any] = {"tf": 0.5, "h": 1 / 120, "stream": True, **args}
    worker._handle_run_tds(w, request, threading.Event(), pipe, seq=1)  # type: ignore[arg-type]
    return pipe


def _times(frame: dict[str, Any]) -> list[float]:
    t, _values = decode_batch(frame["payload"])
    return [float(x) for x in t]


@pytest.mark.integration
def test_rows_of_a_batched_frame_carry_their_own_step_times(wrapper: Wrapper) -> None:
    """ANDES hands ``callpert`` one array for the time and changes it in place,
    so a row buffered for a later frame must have copied the value. Every row
    of a multi-row frame used to carry the time of the step that closed the
    window."""
    frames = _stream(wrapper, decimation="none", max_rate_hz=10.0).frames()

    multi = [_times(f) for f in frames if f["row_count"] > 1]
    assert multi, "decimation=none with a rate should batch several steps per frame"
    for times in multi:
        assert times == sorted(set(times)), f"rows share a time: {times}"
    # The frames follow each other in time.
    flat = [t for f in frames for t in _times(f)]
    assert flat == sorted(flat)


@pytest.mark.integration
def test_mean_frame_time_lies_inside_its_window(wrapper: Wrapper) -> None:
    """A boxcar-mean row is stamped with the mean time of its window, so it falls
    before the boundary the next sample crossed; it used to be stamped with that
    sample's own time, at or after the boundary."""
    pipe = _stream(wrapper, decimation="mean", max_rate_hz=10.0)
    closed = [f for f in pipe.frames() if not f.get("tail")]

    assert len(closed) >= 4
    for k, frame in enumerate(closed, start=1):
        (t,) = _times(frame)
        assert (k - 1) * 0.1 <= t < k * 0.1, f"frame {k}: t={t}"


@pytest.mark.integration
def test_frames_carry_the_values_of_the_columns_stream_start_names(wrapper: Wrapper) -> None:
    """The frames name no columns; position in the row is the only link to the
    names announced once in ``stream_start``. Bus 1's voltage and angle must sit
    where ``var_columns`` says they do, and every row must be as wide as the
    list."""
    pipe = _stream(wrapper, tf=0.2, vars=["bus_v", "gen_state"])
    metadata = pipe.metadata()
    columns: list[str] = metadata["var_columns"]
    assert metadata["schema_version"] == "2.0"
    assert columns[:2] == ["Bus_1_v", "Bus_1_a"]

    ss = wrapper._require_loaded()  # noqa: SLF001
    v1, a1 = float(ss.Bus.v.v[0]), float(ss.Bus.a.v[0])
    frames = pipe.frames()
    assert frames
    for frame in frames:
        _t, values = decode_batch(frame["payload"])
        assert values.shape == (frame["row_count"], len(columns))
    _t, first = decode_batch(frames[0]["payload"])
    # Early in a fault-free run the bus is still at its power-flow solution.
    assert first[0, 0] == pytest.approx(v1, abs=0.01)
    assert first[0, 1] == pytest.approx(a1, abs=0.01)
    omega = [i for i, name in enumerate(columns) if name.endswith("_omega")]
    assert omega
    assert np.allclose(first[0, omega], 1.0, atol=0.01)


@pytest.mark.integration
def test_a_frame_is_far_smaller_than_the_one_column_per_variable_layout(
    wrapper: Wrapper,
) -> None:
    """Every variable group on IEEE 14 is 110 columns, 880 bytes of values. A
    frame came to about 12 KB, with each name repeated in its schema."""
    pipe = _stream(
        wrapper,
        tf=0.1,
        vars=["bus_v", "gen_state", "gen_power", "line_flow", "load_pq"],
    )
    n_columns = len(pipe.metadata()["var_columns"])
    assert n_columns == 110

    sizes = [len(f["payload"]) for f in pipe.frames()]
    assert max(sizes) <= 8 * (n_columns + 1) + 1024
