"""The worker ops a parallel sweep uses, called with a stub wrapper.

The session's worker answers ``sweep_plan``; each sub-worker answers
``adopt_sweep_source`` once and ``run_sweep_iteration`` per iteration. The
wrapper's own behaviour is covered in ``tests/unit/test_wrapper_sweep.py``; here
it is the handlers' argument checks, the abort handling, and the wiring.
"""

from __future__ import annotations

import threading
from typing import Any
from unittest.mock import MagicMock

import pytest

pytest.importorskip("andes")

from tensa.core import worker
from tensa.core.disturbance import FaultSpec, ToggleSpec
from tensa.core.errors import AndesAppError, TdsRequestError
from tensa.core.sweep_pool import PipeAbortEvent

FAULT_TC = "disturbance.fault.tc"


def _bridge_threads() -> set[threading.Thread]:
    return {t for t in threading.enumerate() if t.name.endswith("abort-bridge")}


def _args(**overrides: Any) -> dict[str, Any]:
    args: dict[str, Any] = {
        "index": 2,
        "value": 1.15,
        "specs": [
            FaultSpec(bus_idx=3, tf=0.5, tc=0.6).model_dump(),
            ToggleSpec(model="Line", dev_idx="L1", t=1.5).model_dump(),
        ],
        "parameter_kind": FAULT_TC,
        "parameter_target": 0,
        "tf": 0.2,
        "h": 0.01,
    }
    args.update(overrides)
    return args


@pytest.fixture
def abort_event() -> threading.Event:
    return threading.Event()


def test_the_plan_and_adopt_ops_are_registered() -> None:
    assert worker.HANDLERS["sweep_plan"] is worker._handle_sweep_plan
    assert worker.HANDLERS["adopt_sweep_source"] is worker._handle_adopt_sweep_source
    # The iteration needs the abort event, so ``worker_main`` dispatches it like
    # run_tds and run_sweep (tests/integration/test_sweep_parallel.py runs it for
    # real) rather than through HANDLERS.
    assert "run_sweep_iteration" not in worker.HANDLERS


# ---- run_sweep_iteration -----------------------------------------------------


def test_an_iteration_runs_on_the_wrapper_with_the_specs_rebuilt(
    abort_event: threading.Event,
) -> None:
    wrapper = MagicMock()
    wrapper.run_sweep_iteration.return_value = {"iteration": 2, "error": None}

    result = worker._handle_run_sweep_iteration(wrapper, _args(), abort_event)

    assert result == {"iteration": 2, "error": None}
    kwargs = wrapper.run_sweep_iteration.call_args.kwargs
    assert kwargs["index"] == 2
    assert kwargs["value"] == 1.15
    assert kwargs["parameter_kind"] == FAULT_TC
    assert kwargs["parameter_target"] == 0
    assert kwargs["tf"] == 0.2
    assert kwargs["h"] == 0.01
    assert kwargs["specs"] == [
        FaultSpec(bus_idx=3, tf=0.5, tc=0.6),
        ToggleSpec(model="Line", dev_idx="L1", t=1.5),
    ]
    assert isinstance(kwargs["abort_flag"], threading.Event)


def test_an_iteration_with_the_abort_already_set_runs_nothing_and_leaves_it_set(
    abort_event: threading.Event,
) -> None:
    """Every sub-worker is told about one abort, and none may hide it from the
    next iteration by clearing it."""
    wrapper = MagicMock()
    abort_event.set()
    bridges_before = _bridge_threads()

    result = worker._handle_run_sweep_iteration(wrapper, _args(), abort_event)

    assert result == {"skipped": True}
    wrapper.run_sweep_iteration.assert_not_called()
    assert abort_event.is_set()
    assert _bridge_threads() <= bridges_before


def test_an_abort_during_an_iteration_reaches_the_flag_the_wrapper_watches(
    abort_event: threading.Event,
) -> None:
    seen: dict[str, bool] = {}

    def _iteration(**kwargs: Any) -> dict[str, Any]:
        flag = kwargs["abort_flag"]
        abort_event.set()
        seen["reached"] = flag.wait(5.0)
        return {"iteration": kwargs["index"], "error": None}

    wrapper = MagicMock()
    wrapper.run_sweep_iteration.side_effect = _iteration

    worker._handle_run_sweep_iteration(wrapper, _args(), abort_event)

    assert seen == {"reached": True}
    assert abort_event.is_set()  # still set: it is the server's to end


def test_an_abort_sent_down_the_sub_workers_pipe_reaches_the_wrapper() -> None:
    """The sub-worker's event is a ``PipeAbortEvent``, not a ``multiprocessing.Event``;
    the handler needs only ``is_set`` and ``wait`` of it."""
    import multiprocessing

    reader, writer = multiprocessing.Pipe(duplex=False)
    event = PipeAbortEvent(reader)
    seen: dict[str, bool] = {}

    def _iteration(**kwargs: Any) -> dict[str, Any]:
        writer.send(True)
        seen["reached"] = kwargs["abort_flag"].wait(5.0)
        return {"iteration": kwargs["index"], "error": None}

    wrapper = MagicMock()
    wrapper.run_sweep_iteration.side_effect = _iteration
    try:
        worker._handle_run_sweep_iteration(wrapper, _args(), event)  # type: ignore[arg-type]
        assert seen == {"reached": True}
        # And the next iteration is skipped, as the abort is still in force.
        assert worker._handle_run_sweep_iteration(  # type: ignore[arg-type]
            wrapper, _args(index=3), event
        ) == {"skipped": True}
    finally:
        reader.close()
        writer.close()


def test_an_iteration_leaves_no_abort_bridge_polling(abort_event: threading.Event) -> None:
    wrapper = MagicMock()
    wrapper.run_sweep_iteration.return_value = {"iteration": 2}
    bridges_before = _bridge_threads()

    worker._handle_run_sweep_iteration(wrapper, _args(), abort_event)

    for thread in _bridge_threads() - bridges_before:
        thread.join(2.0)
    assert _bridge_threads() <= bridges_before


@pytest.mark.parametrize("bad", [0, -0.01, float("nan"), float("inf"), "abc", True])
def test_an_iteration_refuses_a_bad_step_before_starting_a_bridge(
    abort_event: threading.Event, bad: Any
) -> None:
    wrapper = MagicMock()
    bridges_before = _bridge_threads()

    with pytest.raises(TdsRequestError, match="step size 'h'"):
        worker._handle_run_sweep_iteration(wrapper, _args(h=bad), abort_event)

    wrapper.run_sweep_iteration.assert_not_called()
    assert _bridge_threads() <= bridges_before


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"index": -1}, "'index'"),
        ({"index": "0"}, "'index'"),
        ({"parameter_kind": 3}, "'parameter_kind'"),
        ({"parameter_target": -1}, "'parameter_target'"),
        ({"value": "abc"}, "'value'"),
        ({"value": None}, "'value'"),
        ({"tf": 0}, "'tf'"),
        ({"tf": "1"}, "'tf'"),
        ({"specs": "none"}, "'specs'"),
        ({"specs": [{"kind": "bogus"}]}, "'specs'"),
        ({"specs": [{"kind": "fault", "bus_idx": 1, "tf": "soon"}]}, "'specs'"),
        ({"specs": ["fault"]}, "'specs'"),
    ],
)
def test_an_iteration_refuses_malformed_arguments(
    abort_event: threading.Event, overrides: dict[str, Any], message: str
) -> None:
    wrapper = MagicMock()
    bridges_before = _bridge_threads()

    with pytest.raises(AndesAppError, match=message):
        worker._handle_run_sweep_iteration(wrapper, _args(**overrides), abort_event)

    wrapper.run_sweep_iteration.assert_not_called()
    assert _bridge_threads() <= bridges_before


def test_an_iteration_without_a_value_is_refused(abort_event: threading.Event) -> None:
    args = _args()
    del args["value"]
    with pytest.raises(AndesAppError, match="'value'"):
        worker._handle_run_sweep_iteration(MagicMock(), args, abort_event)


# ---- sweep_plan and adopt_sweep_source ---------------------------------------


def test_the_plan_op_passes_the_snapshot_and_target_to_the_wrapper() -> None:
    wrapper = MagicMock()
    wrapper.sweep_plan.return_value = {"source": {}, "specs": []}

    plan = worker._handle_sweep_plan(
        wrapper,
        {"snapshot_name": "base", "parameter_kind": FAULT_TC, "parameter_target": 1},
    )

    assert plan == {"source": {}, "specs": []}
    wrapper.sweep_plan.assert_called_once_with(
        snapshot_name="base", parameter_kind=FAULT_TC, parameter_target=1
    )


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"snapshot_name": None}, "'snapshot_name'"),
        ({"parameter_kind": 5}, "'parameter_kind'"),
        ({"parameter_target": -2}, "'parameter_target'"),
        ({"parameter_target": "0"}, "'parameter_target'"),
    ],
)
def test_the_plan_op_refuses_malformed_arguments(overrides: dict[str, Any], message: str) -> None:
    args: dict[str, Any] = {
        "snapshot_name": "base",
        "parameter_kind": FAULT_TC,
        "parameter_target": 0,
    }
    args.update(overrides)
    wrapper = MagicMock()

    with pytest.raises(AndesAppError, match=message):
        worker._handle_sweep_plan(wrapper, args)

    wrapper.sweep_plan.assert_not_called()


def test_the_adopt_op_hands_the_source_to_the_wrapper() -> None:
    wrapper = MagicMock()
    source = {"case_path": "case.raw", "addfiles": None, "replay": []}

    assert worker._handle_adopt_sweep_source(wrapper, {"source": source}) is None

    wrapper.adopt_sweep_source.assert_called_once_with(source)


@pytest.mark.parametrize("source", [None, "case.raw", ["case.raw"]])
def test_the_adopt_op_refuses_a_source_that_is_not_a_dict(source: Any) -> None:
    wrapper = MagicMock()

    with pytest.raises(AndesAppError, match="'source'"):
        worker._handle_adopt_sweep_source(wrapper, {"source": source})

    wrapper.adopt_sweep_source.assert_not_called()
