"""The engine-neutral streaming driver (``tensa.core.stream.run_tds_stream``)
with fake plans and run functions: no ANDES, no Julia.

The driver owns the ``stream_start`` envelope, the frame encoding and
sequencing, the decimation, the abort bridge and the tail flush; the plan owns
the column names and the per-step row.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np
import pytest

from tensa.core.stream import decode_batch, run_tds_stream
from tensa.engines.base import TdsStreamPlan

pytestmark = pytest.mark.unit


class _Pipe:
    """Stands in for the worker's data Pipe; keeps every message sent."""

    def __init__(self, fail_on_frame: int | None = None) -> None:
        self.sent: list[dict[str, Any]] = []
        self._fail_on_frame = fail_on_frame

    def send(self, message: dict[str, Any]) -> None:
        if (
            self._fail_on_frame is not None
            and message.get("type") == "stream_frame"
            and message.get("frame_seq") == self._fail_on_frame
        ):
            raise BrokenPipeError("the parent went away")
        self.sent.append(message)

    def frames(self) -> list[dict[str, Any]]:
        return [m for m in self.sent if m["type"] == "stream_frame"]


def _plan(
    var_columns: list[str],
    metadata_extra: dict[str, Any] | None = None,
    collect: Any = None,
) -> TdsStreamPlan:
    if collect is None:
        collect = lambda t, values: (t, np.asarray(values, dtype=np.float64))  # noqa: E731
    return TdsStreamPlan(
        var_columns=var_columns,
        metadata_extra=metadata_extra or {},
        collect=collect,
    )


def _run_with(steps: list[tuple[float, Any]], result: Any = None) -> Any:
    """A run function that calls the driver's callback for each step."""

    def _run(on_step: Any) -> Any:
        for t, values in steps:
            if on_step(t, values):
                break
        return result

    return _run


def test_stream_start_envelope_shape() -> None:
    pipe = _Pipe()
    plan = _plan(["a|bus:1", "b|bus:2"], {"load_model": "impedance"})
    run_tds_stream(
        plan=plan,
        run=_run_with([(0.0, [1.0, 2.0])], {"ok": True}),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=7,
        decimation="none",
        max_rate_hz=None,
        fixed_step=False,
    )
    start = pipe.sent[0]
    assert start["type"] == "stream_start"
    assert start["seq"] == 7
    metadata = start["metadata"]
    assert metadata["schema_version"] == "2.0"
    assert metadata["var_columns"] == ["a|bus:1", "b|bus:2"]
    assert metadata["load_model"] == "impedance"
    assert metadata["decimation"] == {
        "algorithm": "none",
        "mode": "none",
        "source_rate_hz": None,
        "output_rate_hz": None,
        "fixed_step": False,
    }


def test_frames_carry_encoded_rows_in_order() -> None:
    pipe = _Pipe()
    plan = _plan(["a|bus:1", "b|bus:2"])
    run_tds_stream(
        plan=plan,
        run=_run_with([(0.0, [1.0, 2.0]), (0.1, [3.0, 4.0])]),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=3,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    frames = pipe.frames()
    assert [f["frame_seq"] for f in frames] == [1, 2]
    assert [f["row_count"] for f in frames] == [1, 1]
    t0, v0 = decode_batch(frames[0]["payload"])
    t1, v1 = decode_batch(frames[1]["payload"])
    assert t0.tolist() == [0.0]
    assert v0.tolist() == [[1.0, 2.0]]
    assert t1.tolist() == [0.1]
    assert v1.tolist() == [[3.0, 4.0]]


def test_abort_event_stops_the_run() -> None:
    """An abort asks the run to stop; the step it was asked on is a step the
    run solved, so its row is still streamed (a stopped run's record holds
    every step it solved)."""
    abort = threading.Event()
    pipe = _Pipe()
    calls: list[float] = []

    def _run(on_step: Any) -> Any:
        calls.append(0.0)
        assert on_step(0.0, [1.0]) is False
        abort.set()
        calls.append(0.1)
        # The driver sees the set event and asks the run to stop.
        assert on_step(0.1, [2.0]) is True
        return {"stopped": True}

    result = run_tds_stream(
        plan=_plan(["a"]),
        run=_run,
        abort_event=abort,
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    assert result == {"stopped": True}
    assert [decode_batch(f["payload"])[0].tolist() for f in pipe.frames()] == [[0.0], [0.1]]
    assert calls == [0.0, 0.1]


def test_collect_true_stops_the_run() -> None:
    pipe = _Pipe()
    answers = iter([(0.0, np.asarray([1.0])), True])
    plan = _plan(["a"], collect=lambda t, values: next(answers))
    run_tds_stream(
        plan=plan,
        run=_run_with([(0.0, None), (0.1, None), (0.2, None)]),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    assert len(pipe.frames()) == 1


def test_none_row_is_skipped() -> None:
    """The ANDES clock's first call and its retries answer ``None``: no row."""
    pipe = _Pipe()
    answers = iter([None, (0.1, np.asarray([2.0]))])
    plan = _plan(["a"], collect=lambda t, values: next(answers))
    run_tds_stream(
        plan=plan,
        run=_run_with([(0.0, None), (0.1, None)]),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    frames = pipe.frames()
    assert len(frames) == 1
    t, values = decode_batch(frames[0]["payload"])
    assert t.tolist() == [0.1]
    assert values.tolist() == [[2.0]]


def test_broken_pipe_sets_the_abort_and_never_raises() -> None:
    pipe = _Pipe(fail_on_frame=1)
    seen: list[bool] = []

    def _run(on_step: Any) -> Any:
        # The send of the first step's frame raises inside the driver, which
        # sets its local abort and answers stop at once; a run that honours the
        # stop never makes the second call.
        seen.append(on_step(0.0, [1.0]))
        if seen[-1]:
            return {}
        seen.append(on_step(0.1, [2.0]))
        return {}

    run_tds_stream(
        plan=_plan(["a"]),
        run=_run,
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    assert seen == [True]
    # The failed frame never landed; nothing after it was sent either.
    assert pipe.frames() == []


def test_mean_decimation_tail_frames() -> None:
    pipe = _Pipe()
    plan = _plan(["a"])
    steps = [(t, [float(i)]) for i, t in enumerate((0.0, 0.05, 0.1, 0.15, 0.2))]
    run_tds_stream(
        plan=plan,
        run=_run_with(steps),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="mean",
        max_rate_hz=10.0,
        fixed_step=True,
    )
    frames = pipe.frames()
    assert frames[-1].get("tail") is True
    # The run's last step is never averaged: it is the last row as it is.
    t, values = decode_batch(frames[-1]["payload"])
    assert t.tolist() == [0.2]
    assert values.tolist() == [[4.0]]
    # The mean rows precede it: the first window holds t = 0.0 and 0.05, whose
    # mean time is 0.025 and mean value 0.5 (computed by hand).
    t0, v0 = decode_batch(frames[0]["payload"])
    assert t0.tolist() == [0.025]
    assert v0.tolist() == [[0.5]]


def test_final_row_emits_one_more_row() -> None:
    """The step the run ended on, which no call of the callback saw (ANDES's
    ``StepClock.end``), goes out after the run, before the tail flush."""
    pipe = _Pipe()
    collected: list[float] = []

    def collect(t: float, values: Any) -> Any:
        collected.append(t)
        return t, np.asarray(values, dtype=np.float64)

    run_tds_stream(
        plan=_plan(["a"], collect=collect),
        run=_run_with([(0.4, [4.0])]),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
        final_row=lambda: (0.5, np.asarray([5.0])),
    )
    frames = pipe.frames()
    assert len(frames) == 2
    t, values = decode_batch(frames[-1]["payload"])
    assert t.tolist() == [0.5]
    assert values.tolist() == [[5.0]]
    # The final row does not go through ``collect``: for ANDES that would ask
    # its clock again, which has been told the run ended and answers nothing.
    assert collected == [0.4]


def test_a_row_is_stamped_with_the_time_collect_gives() -> None:
    """ANDES's hook names the step it is about to solve; its row is the step
    before, under that step's time, which is the time ``collect`` answers."""
    pipe = _Pipe()
    plan = _plan(["a"], collect=lambda t, values: (round(t - 0.02, 10), np.asarray([t])))
    run_tds_stream(
        plan=plan,
        run=_run_with([(0.02, None), (0.04, None)]),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    stamped = [decode_batch(f["payload"])[0].tolist() for f in pipe.frames()]
    assert stamped == [[0.0], [0.02]]


def test_a_plan_that_places_var_columns_keeps_its_key_order() -> None:
    """The ANDES stream's metadata keeps the order it always had, with
    ``var_columns`` after ``vars`` and ``dae_vars``."""
    pipe = _Pipe()
    extra = {"vars": ["bus_v"], "dae_vars": [], "var_columns": ["a"], "bus_idx_values": ["1"]}
    run_tds_stream(
        plan=_plan(["a"], extra),
        run=_run_with([]),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    assert list(pipe.sent[0]["metadata"]) == [
        "schema_version",
        "decimation",
        "vars",
        "dae_vars",
        "var_columns",
        "bus_idx_values",
    ]


def test_a_plan_whose_metadata_names_other_columns_is_refused() -> None:
    pipe = _Pipe()
    with pytest.raises(ValueError, match="other columns"):
        run_tds_stream(
            plan=_plan(["a"], {"var_columns": ["b"]}),
            run=_run_with([]),
            abort_event=threading.Event(),
            data_pipe=pipe,
            seq=1,
            decimation="none",
            max_rate_hz=None,
            fixed_step=True,
        )
    assert pipe.sent == []


def test_aggregator_value_error_propagates() -> None:
    with pytest.raises(ValueError, match="max_rate_hz"):
        run_tds_stream(
            plan=_plan(["a"]),
            run=_run_with([]),
            abort_event=threading.Event(),
            data_pipe=_Pipe(),
            seq=1,
            decimation="mean",
            max_rate_hz=None,
            fixed_step=True,
        )


def test_result_returned_unchanged() -> None:
    payload = {"converged": True, "final_t": 0.1}
    result = run_tds_stream(
        plan=_plan(["a"]),
        run=_run_with([(0.0, [1.0])], payload),
        abort_event=threading.Event(),
        data_pipe=_Pipe(),
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    assert result is payload


def test_plan_names_are_fixed_at_start() -> None:
    """The names travel once, in ``stream_start``; a plan whose collect later
    sees other data cannot rename a column mid-run."""
    pipe = _Pipe()
    plan = _plan(["voltage|bus:7"])
    run_tds_stream(
        plan=plan,
        run=_run_with([(0.0, [1.0]), (0.1, [2.0])]),
        abort_event=threading.Event(),
        data_pipe=pipe,
        seq=1,
        decimation="none",
        max_rate_hz=None,
        fixed_step=True,
    )
    assert pipe.sent[0]["metadata"]["var_columns"] == ["voltage|bus:7"]
    for frame in pipe.frames():
        assert b"voltage" not in frame["payload"]
