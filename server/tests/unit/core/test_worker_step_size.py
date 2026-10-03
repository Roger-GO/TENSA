"""The worker's TDS and sweep handlers refuse a bad step size ``h`` before
they touch the wrapper or start a stream.

The route layers validate ``h`` too; these tests pin the worker's own check so
a caller that skips the routes (a test, a future op) cannot start a run that
ANDES would quietly turn into a variable-step one.
"""

from __future__ import annotations

import threading
from typing import Any
from unittest.mock import MagicMock

import pytest

pytest.importorskip("andes")

from tensa.core import worker
from tensa.core.errors import SetupFailedError

# An int too large for a float: ``float()`` raises OverflowError, not ValueError.
_HUGE_INT = pytest.param(10**400, id="int-too-large-for-float")


@pytest.fixture
def abort_event() -> threading.Event:
    return threading.Event()


def _bridge_threads() -> set[threading.Thread]:
    return {t for t in threading.enumerate() if t.name.endswith("abort-bridge")}


@pytest.mark.parametrize("bad", [0, -0.01, float("nan"), float("inf"), "abc", True, _HUGE_INT])
@pytest.mark.parametrize("stream", [False, True])
def test_run_tds_handler_refuses_a_bad_step(
    abort_event: threading.Event, bad: Any, stream: bool
) -> None:
    wrapper = MagicMock()
    data_pipe = MagicMock()
    bridges_before = _bridge_threads()
    with pytest.raises(SetupFailedError, match="step size 'h'"):
        worker._handle_run_tds(
            wrapper,
            {"tf": 1.0, "h": bad, "stream": stream},
            abort_event,
            data_pipe,
            seq=1,
        )
    # Nothing ran and no stream-start frame went out ahead of the failure, and
    # no abort-bridge thread was left polling (a refusal never sets abort_flag).
    wrapper.run_tds.assert_not_called()
    data_pipe.send.assert_not_called()
    assert _bridge_threads() <= bridges_before


def test_run_tds_handler_passes_a_valid_step_through_as_a_float(
    abort_event: threading.Event,
) -> None:
    wrapper = MagicMock()
    worker._handle_run_tds(wrapper, {"tf": 1.0, "h": "0.005"}, abort_event)
    assert wrapper.run_tds.call_args.kwargs["h"] == 0.005


@pytest.mark.parametrize("bad", [0, -1.0, float("nan"), float("inf"), "abc", True, _HUGE_INT])
def test_run_sweep_handler_refuses_a_bad_step(
    abort_event: threading.Event, bad: Any
) -> None:
    wrapper = MagicMock()
    args = {
        "snapshot_name": "base",
        "parameter_kind": "disturbance.fault.tc",
        "parameter_target": 0,
        "values": [1.0, 1.1],
        "tf": 0.2,
        "h": bad,
        "sweep_id": "sw1",
    }
    bridges_before = _bridge_threads()
    with pytest.raises(SetupFailedError, match="step size 'h'"):
        worker._handle_run_sweep(wrapper, args, abort_event)
    wrapper.run_sweep.assert_not_called()
    assert _bridge_threads() <= bridges_before
