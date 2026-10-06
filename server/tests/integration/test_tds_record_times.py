"""A run's record against ANDES's own.

ANDES keeps every step it solves in ``dae.ts``, under the time the step ended
at. The streamed rows and a batch run's ``traces`` are read off the System from
the per-step hook, which ANDES calls before it solves the step the call names,
so the values at a call are the step before. These tests run the worker's
handler on ANDES's bundled IEEE 14 case and hold the record to ``dae.ts`` row
for row: the same times, the same values, the last row at ``tf``. They also
hold the two runs ANDES used to give up on a rounding error before the time it
was asked to reach.

Markers: ``integration``.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core import worker
from tensa.core.disturbance import FaultSpec
from tensa.core.stream import decode_batch
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

# A state, an algebraic variable at the faulted bus, and another machine's angle.
RECORDED = ["omega GENROU 1", "v Bus 4", "delta GENROU 2"]


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _ieee14(*, fault_at: float | None = 0.5) -> Wrapper:
    cases = _cases() / "ieee14"
    w = Wrapper()
    w.load_case(cases / "ieee14.raw", addfiles=[cases / "ieee14.dyr"])
    if fault_at is not None:
        w.add_disturbance(FaultSpec(bus_idx=4, tf=fault_at, tc=fault_at + 0.1))
    return w


class _RecordingPipe:
    """Stands in for the worker's data Pipe; keeps every message sent."""

    def __init__(self, stop: threading.Event | None = None, stop_after: int = 0) -> None:
        self.sent: list[dict[str, Any]] = []
        self._stop = stop
        self._stop_after = stop_after

    def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)
        frames = sum(m["type"] == "stream_frame" for m in self.sent)
        if self._stop is not None and frames >= self._stop_after:
            self._stop.set()

    def rows(self) -> tuple[np.ndarray, np.ndarray]:
        decoded = [decode_batch(m["payload"]) for m in self.sent if m["type"] == "stream_frame"]
        return (
            np.concatenate([t for t, _ in decoded]),
            np.concatenate([values for _, values in decoded]),
        )


def _stored(w: Wrapper, names: list[str]) -> tuple[np.ndarray, np.ndarray]:
    """What ANDES itself kept of the run: its times, and ``names`` as columns."""
    ss = w._require_loaded()  # noqa: SLF001
    ts = ss.dae.ts
    columns = []
    for name in names:
        if name in ss.dae.x_name:
            columns.append(np.asarray(ts.x)[:, list(ss.dae.x_name).index(name)])
        else:
            columns.append(np.asarray(ts.y)[:, list(ss.dae.y_name).index(name)])
    return np.asarray(ts.t, dtype=float), np.column_stack(columns)


def _batch(w: Wrapper, **args: Any) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    request: dict[str, Any] = {"tf": 0.9, "h": 1 / 60, "dae_vars": RECORDED, **args}
    result = worker._handle_run_tds(w, request, threading.Event())  # noqa: SLF001
    traces = result["traces"]
    values = np.column_stack([np.array(v["values"], dtype=float) for v in traces["variables"]])
    return result, np.array(traces["t"], dtype=float), values


def test_a_batch_runs_traces_are_the_rows_andes_stored() -> None:
    w = _ieee14()
    result, t, values = _batch(w)
    stored_t, stored = _stored(w, RECORDED)

    assert result["converged"] is True
    assert t.tolist() == stored_t.tolist()
    assert np.array_equal(values, stored)
    # The record ends where the run does, on the state the System is left in.
    assert t[-1] == 0.9 == result["final_t"]
    ss = w._require_loaded()  # noqa: SLF001
    assert values[-1, 0] == ss.dae.x[list(ss.dae.x_name).index("omega GENROU 1")]


def test_the_fault_shows_in_the_row_of_the_instant_after_it_was_applied() -> None:
    """ANDES solves the step that ends at the fault time on the network as it
    was, applies the fault, and solves the next one 0.1 ms later on the faulted
    network. A row labelled a step late put the collapse a step after it."""
    w = _ieee14()
    _, t, values = _batch(w)
    v_bus4 = dict(zip(t.tolist(), values[:, 1].tolist(), strict=True))

    assert v_bus4[0.5] > 0.9
    assert v_bus4[0.5001] < 0.1
    # And it is back at the instant after it was cleared.
    assert v_bus4[0.6] < 0.1
    assert v_bus4[0.6001] > 0.5


def test_the_row_of_a_cleared_fault_is_the_faulted_network_andes_solved() -> None:
    """ANDES clears a fault by putting the voltages back to what they were
    before it, as the starting point for the next step. Read off the System at
    that moment, the row at the clearing time showed a network that had
    recovered in full, 0.1 ms before the first step that solves it without the
    fault."""
    w = _ieee14()
    _, t, values = _batch(w)
    v_bus4 = dict(zip(t.tolist(), values[:, 1].tolist(), strict=True))

    assert v_bus4[0.5999] < 0.1
    assert v_bus4[0.6] == pytest.approx(v_bus4[0.5999], abs=1e-5)
    # The first step after it: recovering, well short of where it started.
    assert 0.5 < v_bus4[0.6001] < v_bus4[0.5] - 0.2


def test_recording_a_run_does_not_change_it() -> None:
    """The same run with nothing reading it gives ANDES the same steps."""
    plain = _ieee14()
    plain.run_tds(tf=0.9, h=1 / 60)
    read = _ieee14()
    pipe = _RecordingPipe()
    request = {
        "tf": 0.9, "h": 1 / 60, "stream": True, "decimation": "none",
        "vars": ["bus_v", "gen_state", "gen_power", "line_flow", "load_pq"],
        "dae_vars": RECORDED,
    }
    worker._handle_run_tds(read, request, threading.Event(), pipe, seq=1)  # type: ignore[arg-type]  # noqa: SLF001

    a, b = plain._require_loaded().dae.ts, read._require_loaded().dae.ts  # noqa: SLF001
    assert np.asarray(a.t).tolist() == np.asarray(b.t).tolist()
    assert np.array_equal(np.asarray(a.x), np.asarray(b.x))
    assert np.array_equal(np.asarray(a.y), np.asarray(b.y))
    # And the rows of the groups are as long as the record of the variables.
    t, _values = pipe.rows()
    assert t.tolist() == np.asarray(b.t).tolist()


def test_the_streamed_rows_are_the_rows_andes_stored() -> None:
    w = _ieee14()
    pipe = _RecordingPipe()
    request = {
        "tf": 0.9, "h": 1 / 60, "stream": True, "decimation": "none",
        "vars": [], "dae_vars": RECORDED,
    }
    result = worker._handle_run_tds(w, request, threading.Event(), pipe, seq=1)  # type: ignore[arg-type]  # noqa: SLF001
    t, values = pipe.rows()
    stored_t, stored = _stored(w, RECORDED)

    assert t.tolist() == stored_t.tolist()
    assert np.array_equal(values, stored)
    assert t[-1] == 0.9 == result["final_t"]
    # One row per step ANDES solved, each in a frame of its own, numbered in order.
    frames = [m for m in pipe.sent if m["type"] == "stream_frame"]
    assert [f["frame_seq"] for f in frames] == list(range(1, len(stored_t) + 1))


def test_a_batched_stream_ends_on_the_last_step_too() -> None:
    w = _ieee14()
    pipe = _RecordingPipe()
    request = {
        "tf": 0.9, "h": 1 / 60, "stream": True, "decimation": "none", "max_rate_hz": 10,
        "vars": [], "dae_vars": RECORDED,
    }
    worker._handle_run_tds(w, request, threading.Event(), pipe, seq=1)  # type: ignore[arg-type]  # noqa: SLF001
    t, values = pipe.rows()
    stored_t, stored = _stored(w, RECORDED)

    assert t.tolist() == stored_t.tolist()
    assert np.array_equal(values, stored)
    frames = [m for m in pipe.sent if m["type"] == "stream_frame"]
    assert len(frames) < len(stored_t)
    assert frames[-1].get("tail") is True


def test_a_run_that_carries_on_starts_after_the_step_the_last_one_ended_on() -> None:
    w = _ieee14()
    _, first_t, first = _batch(w, tf=0.3)
    _, second_t, second = _batch(w, tf=0.9)
    stored_t, stored = _stored(w, RECORDED)

    assert first_t[-1] == 0.3
    assert second_t[0] > 0.3
    assert second_t[-1] == 0.9
    # Together they are the whole of what ANDES kept, no step twice and none missing.
    assert np.concatenate([first_t, second_t]).tolist() == stored_t.tolist()
    assert np.array_equal(np.vstack([first, second]), stored)


def test_a_run_that_is_stopped_records_every_step_andes_solved() -> None:
    """A stop is seen at the next call of the hook, and ANDES still solves the
    step that call announced: the record holds it, and the one before it."""
    w = _ieee14()
    stop = threading.Event()
    pipe = _RecordingPipe(stop, stop_after=5)
    request = {
        "tf": 600.0, "h": 1 / 60, "stream": True, "decimation": "none",
        "vars": [], "dae_vars": RECORDED,
    }
    result = worker._handle_run_tds(w, request, stop, pipe, seq=1)  # type: ignore[arg-type]  # noqa: SLF001
    t, values = pipe.rows()
    stored_t, stored = _stored(w, RECORDED)

    assert result["converged"] is False
    assert 5 <= len(t) < 600 * 60
    assert t.tolist() == stored_t.tolist()
    assert np.array_equal(values, stored)


# ---- the step ANDES cannot take ------------------------------------------------------


def test_a_run_whose_steps_add_up_a_rounding_error_short_of_tf_reaches_it() -> None:
    """Fifteen steps of 1/30 s, the default, are 0.49999999999999994 s. ANDES
    then asked for a step of 5.6e-17 s, could not take it, and the run ended
    "not converged" on the time it was asked to reach."""
    w = _ieee14(fault_at=None)
    seen: list[float] = []
    result = w.run_tds(tf=0.5, on_step=lambda t, _system: seen.append(float(t)))

    assert result.converged is True
    assert result.final_t == 0.5
    assert result.callpert_count == 16
    assert seen[-1] == 0.5
    ss = w._require_loaded()  # noqa: SLF001
    assert float(ss.dae.ts.t[-1]) == 0.5
    assert len(ss.dae.ts.t) == 16


def test_a_step_that_ends_a_rounding_error_before_an_event_does_not_end_the_run() -> None:
    """The same before an event time: a fault at 0.5001 s makes 0.5 s a time
    ANDES has to land on, fifteen default steps from zero. The run stopped
    there and the fault was never applied."""
    w = _ieee14(fault_at=0.5001)
    result, t, values = _batch(w, h=None)

    assert result["converged"] is True
    assert result["final_t"] == 0.9
    times = t.tolist()
    assert 0.5 in times and 0.5001 in times
    v_bus4 = dict(zip(times, values[:, 1].tolist(), strict=True))
    assert v_bus4[0.5001] > 0.9
    assert min(values[:, 1]) < 0.1
