"""What the streaming TDS handler puts in its frames, checked end to end.

The unit tests drive the aggregator and the encoder with made-up rows. These
run the worker's handler on ANDES's bundled IEEE 14 case, with a recording
pipe in place of the data Pipe, and read the frames it would have sent.

Markers: ``integration``.
"""

from __future__ import annotations

import io
import threading
from pathlib import Path
from typing import Any

import pyarrow.ipc
import pytest

from tensa.core import worker
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
    table = pyarrow.ipc.open_stream(io.BytesIO(frame["payload"])).read_all()
    return [float(t) for t in table.column("t").to_pylist()]


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
