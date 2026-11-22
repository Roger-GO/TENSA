"""The Sienna streaming run with a fake bridge: no Julia.

The fake ``SiennaState`` answers the dyn plan and runs the recorded steps
through the ``on_step`` the handler hands it, honouring the polarity the
bridge's contract sets (``False`` stops the run).
"""

from __future__ import annotations

import threading
from typing import Any

import pytest

from tensa.core.errors import AndesAppError, SetupFailedError
from tensa.core.stream import decode_batch
from tensa.engines.sienna.runtime import _handle_run_tds, _sienna_tds_stream_plan

pytestmark = pytest.mark.unit

_COLUMNS = [
    {"quantity": "voltage", "kind": "bus", "bus": 1},
    {"quantity": "voltage", "kind": "bus", "bus": 2},
    {"quantity": "angle", "kind": "bus", "bus": 1},
    {"quantity": "angle", "kind": "bus", "bus": 2},
    {"quantity": "rotor_speed", "kind": "generator", "bus": 1, "id": "1"},
    {"quantity": "rotor_angle", "kind": "generator", "bus": 1, "id": "1"},
]
_NAMES = [
    "voltage|bus:1",
    "voltage|bus:2",
    "angle|bus:1",
    "angle|bus:2",
    "rotor_speed|gen:1-1",
    "rotor_angle|gen:1-1",
]
_ROWS = [
    (0.0, [1.0, 1.01, 0.0, -0.1, 1.0, 0.5]),
    (0.033, [1.0, 1.01, 0.001, -0.1, 1.0, 0.51]),
    (0.066, [1.0, 1.01, 0.002, -0.1, 1.0, 0.52]),
]


class _FakeBridge:
    """Answers the dyn plan and runs the recorded steps through ``on_step``."""

    def __init__(
        self,
        plan: dict[str, Any] | None = None,
        rows: list[tuple[float, list[float]]] | None = None,
        answer: dict[str, Any] | None = None,
    ) -> None:
        self._plan = plan or {"ok": True, "ready": True, "columns": _COLUMNS}
        self._rows = _ROWS if rows is None else rows
        self._answer = answer or {
            "ok": True,
            "status": "completed",
            "t": [t for t, _ in self._rows],
            "steps": len(self._rows),
            "columns": _COLUMNS,
            "rows": [values for _, values in self._rows],
        }
        self.seen_returns: list[bool] = []
        self.runs = 0

    def dyn_plan(self, session: Any, load_model: str = "impedance") -> dict[str, Any]:
        return self._plan

    def tds_run(self, session: Any, tf: float, **kwargs: Any) -> dict[str, Any]:
        self.runs += 1
        on_step = kwargs.get("on_step")
        if on_step is not None:
            for t, values in self._rows:
                keep_going = bool(on_step(t, values))
                self.seen_returns.append(keep_going)
                if not keep_going:
                    return {**self._answer, "status": "aborted", "t": [t]}
        return self._answer


class _FakeState:
    """The surface of ``SiennaState`` the streaming handler uses."""

    def __init__(self, bridge: _FakeBridge) -> None:
        self._bridge = bridge
        self._session = object()

    def _require_session(self) -> Any:
        return self._session

    def _require_bridge(self) -> _FakeBridge:
        return self._bridge

    def run_tds(self, tf: float, h: Any = None, load_model: str = "impedance",
                abort_event: Any = None, on_step: Any = None, **other: Any) -> dict[str, Any]:
        answer = self._bridge.tds_run(self._session, tf, on_step=on_step)
        status = str(answer.get("status", "failed"))
        t_values = [float(v) for v in answer.get("t", [])]
        # The shape ``SiennaState.run_tds`` answers in, traces included.
        return {
            "converged": status == "completed",
            "final_t": t_values[-1] if t_values else 0.0,
            "callpert_count": int(answer.get("steps", 0)),
            "integrator": "ida",
            "status": status,
            "traces": {"t": t_values, "variables": [], "truncated": False},
            "post": None,
        }


class _Pipe:
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


def _stream(state: _FakeState, args: dict[str, Any]) -> tuple[_Pipe, dict[str, Any]]:
    pipe = _Pipe()
    result = _handle_run_tds(
        state,  # type: ignore[arg-type]
        {"tf": 0.066, "stream": True, **args},
        threading.Event(),
        pipe,
        seq=1,
    )
    return pipe, result


def test_sienna_stream_start_neutral_names() -> None:
    pipe, _result = _stream(_FakeState(_FakeBridge()), {})
    metadata = pipe.metadata()
    assert metadata["var_columns"] == _NAMES
    assert metadata["load_model"] == "impedance"
    assert metadata["vars"] == []
    assert metadata["dae_vars"] == []
    assert metadata["decimation"]["fixed_step"] is False


def test_sienna_frames_decode() -> None:
    pipe, _result = _stream(_FakeState(_FakeBridge()), {})
    frames = pipe.frames()
    assert len(frames) == 3
    for frame, (t_expected, values_expected) in zip(frames, _ROWS, strict=True):
        t, values = decode_batch(frame["payload"])
        assert t.tolist() == [t_expected]
        assert values.tolist() == [values_expected]


def test_sienna_abort_through_the_hook() -> None:
    """The driver's True (stop) reaches the bridge as False, and the run ends
    aborted with ``converged`` False."""
    bridge = _FakeBridge()
    state = _FakeState(bridge)
    abort = threading.Event()
    pipe = _Pipe()

    original_send = pipe.send

    def _send_then_abort(message: dict[str, Any]) -> None:
        original_send(message)
        if message.get("type") == "stream_frame":
            abort.set()

    pipe.send = _send_then_abort  # type: ignore[method-assign]
    result = _handle_run_tds(
        state,  # type: ignore[arg-type]
        {"tf": 0.066, "stream": True},
        abort,
        pipe,
        seq=1,
    )
    assert result["converged"] is False
    assert result["status"] == "aborted"
    # The polarity adapter: the bridge saw True (go on) for the first step and
    # False (stop) for the step on which the abort was seen, and nothing after.
    assert bridge.seen_returns == [True, False]
    # That step was solved, so its row went out before the run stopped.
    assert len(pipe.frames()) == 2


def test_sienna_plan_not_ready_is_refused_before_any_send() -> None:
    bridge = _FakeBridge(
        plan={"ok": True, "ready": False, "reason": "solve the power flow first"}
    )
    pipe = _Pipe()
    with pytest.raises(SetupFailedError, match="solve the power flow first"):
        _sienna_tds_stream_plan(_FakeState(bridge), {})  # type: ignore[arg-type]
    assert pipe.sent == []


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"integrator": "qndf"}, "no integrator selection"),
        ({"vars": ["line_flow"]}, "var groups are ANDES columns"),
        ({"dae_vars": ["omega GENROU 1"]}, "dae_vars are ANDES variable names"),
        ({"tds_config_overrides": {"rtol": 1e-3}}, "tds_config_overrides is an ANDES feature"),
        ({"controllers": [{"kind": "droop"}]}, "droop and ffr controllers are ANDES-only"),
        ({"h": 0.01, "step": 0.01}, "name only one of 'h' and 'step'"),
        ({"load_model": "zip"}, "unknown load_model"),
    ],
)
def test_sienna_refused_fields(args: dict[str, Any], message: str) -> None:
    pipe = _Pipe()
    with pytest.raises(AndesAppError, match=message):
        _handle_run_tds(
            _FakeState(_FakeBridge()),  # type: ignore[arg-type]
            {"tf": 0.066, "stream": True, **args},
            threading.Event(),
            pipe,
            seq=1,
        )
    assert pipe.sent == []


def test_sienna_default_integrator_and_vars_are_accepted() -> None:
    """What the WS route sends when the client named nothing must start the run."""
    pipe, result = _stream(
        _FakeState(_FakeBridge()),
        {"integrator": "trapezoidal", "vars": ["bus_v", "gen_state"]},
    )
    assert result["converged"] is True
    assert pipe.frames()


def test_sienna_step_maps_to_the_run_and_h_is_accepted() -> None:
    seen: dict[str, Any] = {}

    class _RecordingState(_FakeState):
        def run_tds(self, tf: float, h: Any = None, **kwargs: Any) -> dict[str, Any]:
            seen["h"] = h
            return super().run_tds(tf, h=h, **kwargs)

    _stream(_RecordingState(_FakeBridge()), {"h": 0.01})
    assert seen["h"] == 0.01
    _stream(_RecordingState(_FakeBridge()), {"step": 0.02})
    assert seen["h"] == 0.02


def test_sienna_row_length_mismatch_names_both_counts() -> None:
    bridge = _FakeBridge(rows=[(0.0, [1.0, 2.0, 3.0, 4.0, 5.0])])
    pipe = _Pipe()
    with pytest.raises(AndesAppError, match="row has 5 values; the column plan has 6"):
        _handle_run_tds(
            _FakeState(bridge),  # type: ignore[arg-type]
            {"tf": 0.066, "stream": True},
            threading.Event(),
            pipe,
            seq=1,
        )


def test_sienna_batch_delegates_to_the_state_with_the_abort_event() -> None:
    """A batch request (no ``stream`` flag) is the state's own run: the
    dispatch passes the abort event through, as the ANDES table's special
    case does."""
    seen: dict[str, Any] = {}

    class _RecordingState(_FakeState):
        def run_tds(self, tf: float, **kwargs: Any) -> dict[str, Any]:
            seen["tf"] = tf
            seen["abort_event"] = kwargs.get("abort_event")
            return {"converged": True, "final_t": tf, "callpert_count": 3, "integrator": "ida"}

    event = threading.Event()
    result = _handle_run_tds(
        _RecordingState(_FakeBridge()),  # type: ignore[arg-type]
        {"tf": 0.066},
        event,
        None,
        None,
    )
    assert seen["tf"] == 0.066
    assert seen["abort_event"] is event
    assert result["converged"] is True


def test_sienna_done_payload() -> None:
    _pipe, result = _stream(_FakeState(_FakeBridge()), {})
    assert result["converged"] is True
    assert result["final_t"] == pytest.approx(0.066)
    assert result["callpert_count"] == 3
    assert result["integrator"] == "ida"
    assert result["status"] == "completed"
    # The rows went out frame by frame: the end carries the summary only.
    assert "traces" not in result
    assert "post" not in result


def test_a_failed_run_reports_failed_not_aborted() -> None:
    bridge = _FakeBridge()
    bridge._answer = {**bridge._answer, "status": "failed"}  # noqa: SLF001
    _pipe, result = _stream(_FakeState(bridge), {})
    assert result["converged"] is False
    assert result["status"] == "failed"


def test_the_abort_event_is_spent_even_when_the_stream_raises() -> None:
    class _Raising(_FakeState):
        def run_tds(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("the Julia side died")

    abort = threading.Event()
    abort.set()
    with pytest.raises(RuntimeError):
        _handle_run_tds(
            _Raising(_FakeBridge()),  # type: ignore[arg-type]
            {"tf": 0.066, "stream": True},
            abort,
            _Pipe(),
            seq=1,
        )
    assert not abort.is_set()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("controllers", [{"kind": "droop", "device": "ESD1_1"}]),
        ("dae_vars", ["omega GENROU 1"]),
        ("tds_config_overrides", {"rtol": 1e-3}),
        ("integrator", "qndf"),
    ],
)
def test_a_batch_request_with_an_option_the_engine_lacks_is_refused(
    field: str, value: Any
) -> None:
    """The batch path hands every option to ``SiennaState.run_tds``, which
    refuses by name what the engine does not have, before the bridge runs."""
    from tensa.core.errors import TdsRequestError
    from tensa.engines.sienna.state import SiennaState

    bridge = _FakeBridge()
    state = SiennaState(None, None, None, bridge=bridge)  # type: ignore[arg-type]
    state._session = object()  # noqa: SLF001
    state._pflow_json = {"converged": True}  # noqa: SLF001
    with pytest.raises(TdsRequestError, match=field if field != "integrator" else "integrator"):
        _handle_run_tds(state, {"tf": 1.0, field: value}, threading.Event())
    assert bridge.runs == 0
