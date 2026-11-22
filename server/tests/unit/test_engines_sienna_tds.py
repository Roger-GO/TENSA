"""Unit tests for the Sienna batch time-domain run and ``tds_init``.

No Julia: the bridge is faked and answers recorded JSON shaped as P5-A's
contracts. The state is loaded by hand (session, topology, power flow, key
book), the way ``load_case`` would leave it.
"""

from __future__ import annotations

import math
import threading
from typing import Any

import pytest

from tensa.core.disturbance import FaultSpec, ToggleSpec
from tensa.core.errors import NoCaseLoadedError, TdsRequestError
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.state import SiennaState

# The recorded tds_run_json answer: one bus, one machine, three rows.
RUN_OK: dict[str, Any] = {
    "ok": True,
    "status": "completed",
    "error": None,
    "t": [0.0, 0.5, 1.0],
    "columns": [
        {"quantity": "voltage", "kind": "bus", "bus": 7, "unit": "pu"},
        {"quantity": "angle", "kind": "bus", "bus": 7, "unit": "rad"},
        {"quantity": "rotor_speed", "kind": "generator", "bus": 2, "id": "1", "unit": "pu"},
        {"quantity": "rotor_angle", "kind": "generator", "bus": 2, "id": "1", "unit": "rad"},
    ],
    "rows": [
        [1.03, 0.20, 1.0, 0.30],
        [1.02, 0.21, 1.0001, 0.31],
        [1.01, 0.22, 0.9999, 0.32],
    ],
    "post": {
        "t": [0.0, 1.0],
        "series": [
            {"quantity": "p", "kind": "generator", "bus": 2, "id": "1", "unit": "MW", "y": [700.0, 701.0]},
            {"quantity": "q", "kind": "generator", "bus": 2, "id": "1", "unit": "MVAr", "y": [185.0, 186.0]},
        ],
    },
    "steps": 2,
    "t_end": 1.0,
    "loads": {"converted": 1, "left": []},
    "notes": [],
    "timings": {"build_s": 0.1, "run_s": 0.2},
}

INIT_OK: dict[str, Any] = {
    "ok": True,
    "initialized": True,
    "n_states": 32,
    "states": [{"device": "generator-2-1", "bus": 2, "id": "1", "state": "δ", "value": 0.3}],
    "notes": [],
}


class FakeBridge:
    """Records the dynamics calls and answers the recorded JSON."""

    def __init__(self, run_answer: dict[str, Any] | None = None) -> None:
        self.run_answer = RUN_OK if run_answer is None else run_answer
        self.init_answer: dict[str, Any] = INIT_OK
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def tds_run(
        self,
        session: Any,
        tf: float,
        step: float | None = None,
        disturbances: Any = None,
        load_model: str = "impedance",
        on_step: Any = None,
    ) -> dict[str, Any]:
        self.calls.append(
            ("tds_run", (session,), {
                "tf": tf,
                "step": step,
                "disturbances": disturbances,
                "load_model": load_model,
                "on_step": on_step,
            })
        )
        return self.run_answer

    def tds_init(self, session: Any, load_model: str = "impedance") -> dict[str, Any]:
        self.calls.append(("tds_init", (session,), {"load_model": load_model}))
        return self.init_answer


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("bus:7", "bus", "Bus", 7, "engine"))
    book.assign(KeyEntry("bus:2", "bus", "Bus", 2, "engine"))
    book.assign(KeyEntry("branch:7-8-1", "line", "Line", "line-7-8-1", "file"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "file"))
    book.assign(
        KeyEntry("gen:2-1/machine", "dynamic", "GENROU", "generator-2-1/GENROU", "engine")
    )
    return book


def loaded_state(
    bridge: FakeBridge | None = None,
    *,
    pflow: dict[str, Any] | None = None,
) -> SiennaState:
    """A state as ``load_case`` plus a converged power flow would leave it."""
    state = SiennaState(None, None, None, bridge=bridge or FakeBridge())
    state._session = object()  # noqa: SLF001
    # The bus types as the Julia module writes them (PowerSystems' own names;
    # ``kundur.topology.json`` among the samples has the same).
    state._topology_json = {  # noqa: SLF001
        "buses": [
            {"number": 2, "type": "PV"},
            {"number": 7, "type": "REF"},
        ]
    }
    state._pflow_json = {"converged": True} if pflow is None else pflow  # noqa: SLF001
    state._key_book = _book()  # noqa: SLF001
    return state


def _bridge_of(state: SiennaState) -> FakeBridge:
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    return bridge


def _run_kwargs(bridge: FakeBridge) -> dict[str, Any]:
    run_calls = [c for c in bridge.calls if c[0] == "tds_run"]
    assert run_calls
    return run_calls[-1][2]


def test_happy_path_payload_and_bridge_arguments() -> None:
    state = loaded_state()
    payload = state.run_tds(tf=5.0)
    assert payload["converged"] is True
    assert payload["final_t"] == 1.0
    assert payload["callpert_count"] == 2
    assert payload["integrator"] == "ida"
    assert payload["controllers"] is None
    kwargs = _run_kwargs(_bridge_of(state))
    assert kwargs["tf"] == 5.0
    assert kwargs["step"] is None
    assert kwargs["disturbances"] is None
    assert kwargs["load_model"] == "impedance"
    assert kwargs["on_step"] is None


def test_traces_names_and_values() -> None:
    state = loaded_state()
    payload = state.run_tds(tf=5.0)
    traces = payload["traces"]
    assert traces["t"] == [0.0, 0.5, 1.0]
    assert traces["truncated"] is False
    names = [v["name"] for v in traces["variables"]]
    assert names == [
        "voltage|bus:7",
        "angle|bus:7",
        "rotor_speed|gen:2-1",
        "rotor_angle|gen:2-1",
        "angle_rel|bus:7",
    ]
    by_name = dict(zip(names, [v["values"] for v in traces["variables"]], strict=True))
    assert by_name["voltage|bus:7"] == [1.03, 1.02, 1.01]
    # One bus, which is the reference: its relative angle is exactly zero.
    assert by_name["angle_rel|bus:7"] == [0.0, 0.0, 0.0]
    # rotor_angle_rel is left out (no inertia reported), and the notes say so.
    assert "rotor_angle_rel|gen:2-1" not in by_name
    assert payload["notes"] == [
        "relative rotor angles need each machine's inertia, "
        "which the Sienna engine does not report yet"
    ]


def test_angle_rel_against_the_reference_bus() -> None:
    """Two buses: the reference is the topology's ``ref`` bus (bus 7), and the
    other bus's relative angle is its angle minus bus 7's, row by row."""
    answer = dict(RUN_OK)
    answer["columns"] = [
        {"quantity": "angle", "kind": "bus", "bus": 2, "unit": "rad"},
        {"quantity": "angle", "kind": "bus", "bus": 7, "unit": "rad"},
    ]
    answer["rows"] = [[0.50, 0.20], [0.55, 0.22], [0.60, 0.24]]
    answer["post"] = None
    state = loaded_state(FakeBridge(answer))
    payload = state.run_tds(tf=5.0)
    by_name = {v["name"]: v["values"] for v in payload["traces"]["variables"]}
    # Hand-computed: 0.50-0.20, 0.55-0.22, 0.60-0.24.
    assert by_name["angle_rel|bus:2"] == pytest.approx([0.30, 0.33, 0.36])
    assert by_name["angle_rel|bus:7"] == [0.0, 0.0, 0.0]


def test_post_series_on_their_own_time_base() -> None:
    state = loaded_state()
    payload = state.run_tds(tf=5.0)
    post = payload["post"]
    assert post["t"] == [0.0, 1.0]
    assert post["truncated"] is False
    by_name = {v["name"]: v["values"] for v in post["variables"]}
    assert by_name == {"p|gen:2-1": [700.0, 701.0], "q|gen:2-1": [185.0, 186.0]}


def test_aborted_run_reports_not_converged() -> None:
    answer = dict(RUN_OK)
    answer["status"] = "aborted"
    answer["t"] = [0.0, 0.5]
    answer["rows"] = answer["rows"][:2]
    answer["steps"] = 1
    state = loaded_state(FakeBridge(answer))
    payload = state.run_tds(tf=5.0)
    assert payload["converged"] is False
    assert payload["final_t"] == 0.5
    assert payload["traces"]["t"] == [0.0, 0.5]


def test_failed_run_reports_not_converged_without_raising() -> None:
    answer = dict(RUN_OK)
    answer["status"] = "failed"
    answer["error"] = "IDA stopped at t=0.8"
    state = loaded_state(FakeBridge(answer))
    payload = state.run_tds(tf=5.0)
    assert payload["converged"] is False
    assert payload["final_t"] == 1.0


def test_no_power_flow_is_refused_before_the_bridge_is_called() -> None:
    for pflow in (None, {"converged": False}):
        state = loaded_state(pflow=pflow)
        state._pflow_json = pflow  # noqa: SLF001
        with pytest.raises(TdsRequestError, match="solve the power flow first"):
            state.run_tds(tf=5.0)
        assert _bridge_of(state).calls == []


def test_option_refusals_name_the_option_and_run_nothing() -> None:
    refusals: list[tuple[dict[str, Any], str]] = [
        ({"integrator": "qndf"}, "integrator"),
        ({"tds_config_overrides": {"rtol": 1e-3}}, "tds_config_overrides"),
        ({"dae_vars": ["omega GENROU 1"]}, "dae_vars"),
        ({"controllers": [{"type": "droop"}]}, "controllers"),
        ({"h": 0.0}, "h"),
        ({"tf": -1.0}, "tf"),
        ({"load_model": "zip"}, "load_model"),
    ]
    for kwargs, name in refusals:
        state = loaded_state()
        with pytest.raises(TdsRequestError, match=name):
            state.run_tds(**{"tf": 5.0, **kwargs})
        assert _bridge_of(state).calls == [], kwargs
    # The schema's default integrator and None are "not given".
    state = loaded_state()
    state.run_tds(tf=5.0, integrator="trapezoidal")
    state.run_tds(tf=5.0, integrator=None)


def test_abort_wiring() -> None:
    class _Event:
        def __init__(self, value: bool) -> None:
            self._value = value

        def is_set(self) -> bool:
            return self._value

    class _Broken:
        def is_set(self) -> bool:
            raise RuntimeError("broken")

    for event, expected in ((_Event(True), False), (_Event(False), True), (_Broken(), True)):
        state = loaded_state()
        state.run_tds(tf=5.0, abort_event=event)
        on_step = _run_kwargs(_bridge_of(state))["on_step"]
        assert on_step is not None
        assert on_step(0.0, None) is expected


def test_an_abort_sent_before_the_run_stops_it_and_is_spent() -> None:
    """As on the ANDES engine: an abort that arrived while nothing ran stops the
    next run at its first step, and is cleared once that run is over, so the
    run after it is not stopped too. The event is cleared when the bridge
    raises as well."""
    seen: list[bool] = []

    class _Stepping(FakeBridge):
        def tds_run(self, session: Any, tf: float, **kwargs: Any) -> dict[str, Any]:
            seen.append(kwargs["on_step"](0.0, None))
            return super().tds_run(session, tf, **kwargs)

    event = threading.Event()
    event.set()
    state = loaded_state(_Stepping())
    state.run_tds(tf=5.0, abort_event=event)
    assert seen == [False]
    assert not event.is_set()
    state.run_tds(tf=5.0, abort_event=event)
    assert seen == [False, True]

    class _Raising(FakeBridge):
        def tds_run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("the Julia side died")

    event.set()
    with pytest.raises(RuntimeError):
        loaded_state(_Raising()).run_tds(tf=5.0, abort_event=event)
    assert not event.is_set()


def test_disturbances_reach_the_bridge_in_pending_order() -> None:
    state = loaded_state()
    state.add_disturbance(FaultSpec(bus_idx=7, tf=1.0, tc=1.05, xf=1e-4, rf=0.0))
    state.add_disturbance(ToggleSpec(model="Line", dev_idx="line-7-8-1", t=1.2))
    state.run_tds(tf=5.0)
    assert _run_kwargs(_bridge_of(state))["disturbances"] == [
        {"kind": "bus_fault", "bus": 7, "t_on": 1.0, "t_clear": 1.05, "r_pu": 0.0, "x_pu": 0.0001},
        {"kind": "branch_trip", "from": 7, "to": 8, "ckt": "1", "t": 1.2},
    ]


def test_nan_values_come_out_as_none() -> None:
    answer = dict(RUN_OK)
    answer["rows"] = [
        [1.03, 0.20, 1.0, 0.30],
        [math.nan, 0.21, 1.0001, 0.31],
        [1.01, 0.22, 0.9999, 0.32],
    ]
    state = loaded_state(FakeBridge(answer))
    payload = state.run_tds(tf=5.0)
    by_name = {v["name"]: v["values"] for v in payload["traces"]["variables"]}
    assert by_name["voltage|bus:7"] == [1.03, None, 1.01]


def test_a_null_the_julia_side_wrote_is_a_gap() -> None:
    """JSON has no NaN: the Julia side writes a value that is not finite as
    null, which arrives as ``None`` and is a gap like a NaN."""
    answer = dict(RUN_OK)
    answer["rows"] = [
        [1.03, 0.20, 1.0, 0.30],
        [None, 0.21, None, 0.31],
        [1.01, 0.22, 0.9999, 0.32],
    ]
    state = loaded_state(FakeBridge(answer))
    payload = state.run_tds(tf=5.0)
    by_name = {v["name"]: v["values"] for v in payload["traces"]["variables"]}
    assert by_name["voltage|bus:7"] == [1.03, None, 1.01]
    assert by_name["rotor_speed|gen:2-1"] == [1.0, None, 0.9999]


def test_the_reference_bus_is_found_by_the_type_the_julia_side_writes() -> None:
    """The relative angles are taken against the bus PowerSystems marks REF;
    here it is bus 7 although bus 2 has the lower number."""
    answer = dict(RUN_OK)
    answer["columns"] = [
        {"quantity": "angle", "kind": "bus", "bus": 2, "unit": "rad"},
        {"quantity": "angle", "kind": "bus", "bus": 7, "unit": "rad"},
    ]
    answer["rows"] = [[0.50, 0.20]]
    answer["post"] = None
    state = loaded_state(FakeBridge(answer))
    by_name = {
        v["name"]: v["values"] for v in state.run_tds(tf=5.0)["traces"]["variables"]
    }
    assert by_name["angle_rel|bus:7"] == [0.0]
    assert by_name["angle_rel|bus:2"] == pytest.approx([0.30])


def test_a_column_whose_key_the_book_lacks_still_completes() -> None:
    answer = dict(RUN_OK)
    answer["columns"] = [
        {"quantity": "voltage", "kind": "bus", "bus": 99, "unit": "pu"},
    ]
    answer["rows"] = [[1.0], [1.0], [1.0]]
    answer["post"] = None
    state = loaded_state(FakeBridge(answer))
    payload = state.run_tds(tf=5.0)
    names = [v["name"] for v in payload["traces"]["variables"]]
    assert names == ["voltage|bus 99"]
    assert payload["converged"] is True
    assert any("bus 99" in note for note in payload["notes"])


def test_run_tds_with_no_case_raises() -> None:
    state = SiennaState(None, None, None, bridge=FakeBridge())
    with pytest.raises(NoCaseLoadedError):
        state.run_tds(tf=5.0)


# ---- init_tds -----------------------------------------------------------------


def test_init_tds_happy_path() -> None:
    """PSID's vector holds the devices' states and then the real and imaginary
    voltage of every bus: here 1 device state listed in a vector of 32, so 1
    state and 31 algebraic variables (Kundur's real answer is 32 states and 20
    bus voltage parts in a vector of 52)."""
    state = loaded_state()
    payload = state.init_tds()
    assert payload == {
        "initialized": True,
        "test_ok": True,
        "test_init": True,
        "n_states": 1,
        "n_algeb": 31,
        "max_residual": 0.0,
        "nan_residuals": 0,
        "clamped": [],
        "residuals": [],
        "diagnostics_truncated": False,
    }
    assert _run_kwargs_init(_bridge_of(state))["load_model"] == "impedance"


def _run_kwargs_init(bridge: FakeBridge) -> dict[str, Any]:
    init_calls = [c for c in bridge.calls if c[0] == "tds_init"]
    assert init_calls
    return init_calls[-1][2]


def test_init_tds_not_initialized_reports_test_ok_false() -> None:
    bridge = FakeBridge()
    bridge.init_answer = {
        "ok": True,
        "initialized": False,
        "error": "no steady state",
        "n_states": 0,
        "states": [],
        "notes": [{"level": "warning", "text": "residuals remain"}],
    }
    state = loaded_state(bridge)
    payload = state.init_tds()
    assert payload["initialized"] is False
    assert payload["test_ok"] is False
    assert payload["n_states"] == 0


def test_init_tds_without_a_power_flow_is_refused() -> None:
    state = loaded_state(pflow=None)
    state._pflow_json = None  # noqa: SLF001
    with pytest.raises(TdsRequestError, match="solve the power flow first"):
        state.init_tds()
    assert _bridge_of(state).calls == []


def test_init_tds_refuses_test_init_false() -> None:
    state = loaded_state()
    with pytest.raises(TdsRequestError, match="test_init"):
        state.init_tds(test_init=False)
    assert _bridge_of(state).calls == []


def test_init_tds_with_no_case_raises() -> None:
    state = SiennaState(None, None, None, bridge=FakeBridge())
    with pytest.raises(NoCaseLoadedError):
        state.init_tds()
