"""Unit tests of the Sienna DC power flow with a fake bridge.

No Julia is started: the fake bridge records ``dc_pflow(session, method)``
calls and answers a recorded JSON dict, the way the Julia module answers. The
recorded case is the three-bus triangle of the unit: buses 1, 2, 3, lines
1-2, 1-3 and 2-3, each r = 0 and x = 0.1, bus 1 the reference, a load of
150 MW at bus 3 and generation of 100 MW at bus 1 and 50 MW at bus 2. The
flows are worked by hand in the comment of ``_dc_json``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tensa.core.errors import NoCaseLoadedError, PflowRequestError
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.state import SiennaState


def _topology() -> dict[str, Any]:
    return {
        "base_mva": 100.0,
        "buses": [
            {"number": 1, "type": "ref", "v_pu": 1.0},
            {"number": 2, "type": "pv", "v_pu": 1.0},
            {"number": 3, "type": "pq", "v_pu": 1.0},
        ],
        "branches": [
            {"name": "1-2-i_1", "from": 1, "to": 2, "ckt": "1", "rate_mva": None},
            {"name": "1-3-i_1", "from": 1, "to": 3, "ckt": "1", "rate_mva": None},
            {"name": "2-3-i_1", "from": 2, "to": 3, "ckt": "1", "rate_mva": None},
        ],
        "generators": [
            {
                "name": "generator-1-1",
                "bus": 1,
                "id": "1",
                "kind": "Slack",
                "available": True,
            },
            {
                "name": "generator-2-1",
                "bus": 2,
                "id": "1",
                "kind": "PV",
                "available": True,
            },
        ],
        "loads": [
            {"name": "load31", "bus": 3, "id": "1", "available": True},
        ],
        "shunts": [],
        "dynamics": [],
    }


def _book() -> KeyBook:
    book = KeyBook()
    for number in (1, 2, 3):
        book.assign(KeyEntry(f"bus:{number}", "bus", "Bus", number, "engine"))
    for from_bus, to_bus in ((1, 2), (1, 3), (2, 3)):
        name = f"{from_bus}-{to_bus}-i_1"
        book.assign(
            KeyEntry(f"branch:{from_bus}-{to_bus}-1", "line", "Line", name, "file")
        )
    book.assign(
        KeyEntry("gen:1-1", "generator", "Slack", "generator-1-1", "file")
    )
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "file"))
    book.assign(KeyEntry("load:3-1", "load", "PQ", "load31", "file"))
    return book


def _dc_json(method: str = "dc") -> dict[str, Any]:
    # Hand computation from the PTDF of the matrices unit. The injections are
    # +0.5 pu at bus 2 and -1.5 pu at bus 3 (the reference bus 1 balances).
    # With the PTDF columns of the matrices unit's test (line 1-2: bus 2
    # -2/3, bus 3 -1/3; line 1-3: bus 2 -1/3, bus 3 -2/3; line 2-3: bus 2
    # +1/3, bus 3 -1/3), the flows in per unit are:
    #   line 1-2: (-2/3)(0.5) + (-1/3)(-1.5) = 1/6   -> 16.6667 MW
    #   line 1-3: (-1/3)(0.5) + (-2/3)(-1.5) = 5/6   -> 83.3333 MW
    #   line 2-3: (+1/3)(0.5) + (-1/3)(-1.5) = 2/3   -> 66.6667 MW
    # The slack picks up the balance: 150 - 50 = 100 MW at bus 1.
    return {
        "converged": True,
        "method": method,
        "tolerance": None,
        "max_iterations": None,
        "notes": [],
        "buses": [
            {"number": 1, "v_pu": 1.0, "angle_rad": 0.0},
            {"number": 2, "v_pu": 1.0, "angle_rad": 1.0 / 60.0},
            {"number": 3, "v_pu": 1.0, "angle_rad": 1.0 / 12.0},
        ],
        "branches": [
            {
                "name": "1-2-i_1",
                "from": 1,
                "to": 2,
                "ckt": "1",
                "p_from_mw": 100.0 / 6.0,
                "q_from_mvar": None,
                "p_to_mw": -100.0 / 6.0,
                "q_to_mvar": None,
            },
            {
                "name": "1-3-i_1",
                "from": 1,
                "to": 3,
                "ckt": "1",
                "p_from_mw": 500.0 / 6.0,
                "q_from_mvar": None,
                "p_to_mw": -500.0 / 6.0,
                "q_to_mvar": None,
            },
            {
                "name": "2-3-i_1",
                "from": 2,
                "to": 3,
                "ckt": "1",
                "p_from_mw": 400.0 / 6.0,
                "q_from_mvar": None,
                "p_to_mw": -400.0 / 6.0,
                "q_to_mvar": None,
            },
        ],
        "generators": [
            {"name": "generator-1-1", "bus": 1, "id": "1", "p_mw": 100.0, "q_mvar": None},
            {"name": "generator-2-1", "bus": 2, "id": "1", "p_mw": 50.0, "q_mvar": None},
        ],
        "loads": [
            {"name": "load31", "bus": 3, "id": "1", "p_mw": 150.0, "q_mvar": None},
        ],
    }


def _ac_json() -> dict[str, Any]:
    return {
        "converged": True,
        "tolerance": 1e-8,
        "max_iterations": 30,
        "notes": [],
        "buses": [
            {"number": 1, "v_pu": 1.0, "angle_rad": 0.0},
            {"number": 2, "v_pu": 1.0, "angle_rad": 0.01},
            {"number": 3, "v_pu": 0.99, "angle_rad": 0.05},
        ],
        "branches": [
            {
                "name": "1-2-i_1",
                "from": 1,
                "to": 2,
                "ckt": "1",
                "p_from_mw": 17.0,
                "q_from_mvar": 2.0,
                "p_to_mw": -17.0,
                "q_to_mvar": -1.5,
            },
            {
                "name": "1-3-i_1",
                "from": 1,
                "to": 3,
                "ckt": "1",
                "p_from_mw": 83.0,
                "q_from_mvar": 9.0,
                "p_to_mw": -83.0,
                "q_to_mvar": -8.0,
            },
            {
                "name": "2-3-i_1",
                "from": 2,
                "to": 3,
                "ckt": "1",
                "p_from_mw": 67.0,
                "q_from_mvar": 7.0,
                "p_to_mw": -67.0,
                "q_to_mvar": -6.5,
            },
        ],
        "generators": [
            {"name": "generator-1-1", "bus": 1, "id": "1", "p_mw": 100.0, "q_mvar": 11.0},
            {"name": "generator-2-1", "bus": 2, "id": "1", "p_mw": 50.0, "q_mvar": 5.5},
        ],
        "loads": [
            {"name": "load31", "bus": 3, "id": "1", "p_mw": 150.0, "q_mvar": 30.0},
        ],
    }


class _FakeBridge:
    """Records the calls and answers the recorded JSON."""

    def __init__(self) -> None:
        self.started = True
        self.dc_calls: list[tuple[Any, str]] = []
        self.ac_calls: list[dict[str, Any]] = []

    def start(self) -> None:
        return None

    def start_network(self) -> None:
        return None

    def dc_pflow(self, session: Any, method: str) -> dict[str, Any]:
        self.dc_calls.append((session, method))
        return _dc_json(method)

    def pflow(self, session: Any, **kwargs: Any) -> dict[str, Any]:
        self.ac_calls.append(kwargs)
        return _ac_json()


def _state(tmp_path: Path, bridge: _FakeBridge) -> SiennaState:
    state = SiennaState(
        workspace=str(tmp_path), session_id="s1", owner_pid=None, bridge=bridge
    )
    state._session = object()
    state._case_path = tmp_path / "case.raw"
    state._topology_json = _topology()
    state._report_json = {"unsupported": [], "applied": [], "notes": []}
    state._key_book = _book()
    return state


def test_dc_method_reaches_bridge(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    state = _state(tmp_path, bridge)
    result = state.run_pflow(method="dc")
    assert [method for _, method in bridge.dc_calls] == ["dc"]
    assert bridge.dc_calls[0][0] is state._session
    assert bridge.ac_calls == []
    assert result.converged is True


def test_ptdf_dc_method_reaches_bridge(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    _state(tmp_path, bridge).run_pflow(method="ptdf-dc")
    assert [method for _, method in bridge.dc_calls] == ["ptdf-dc"]


def test_dc_result_active_flows(tmp_path: Path) -> None:
    result = _state(tmp_path, _FakeBridge()).run_pflow(method="dc")
    flow = result.line_flows["1-2-i_1"]
    assert flow.p == pytest.approx(100.0 / 6.0, abs=1e-9)
    assert flow.p_to == pytest.approx(-100.0 / 6.0, abs=1e-9)
    assert flow.loss == pytest.approx(0.0, abs=1e-9)


def test_dc_result_reactive_is_null_never_zero(tmp_path: Path) -> None:
    result = _state(tmp_path, _FakeBridge()).run_pflow(method="dc")
    for flow in result.line_flows.values():
        assert flow.q is None
        assert flow.q_to is None
    for output in result.generator_outputs.values():
        assert output.q is None
    for load in result.load_consumption.values():
        assert load.q is None
    assert result.summary is not None
    assert result.summary.generation_q is None
    assert result.summary.load_q is None
    assert result.summary.loss_q is None
    assert result.summary.slack_q is None
    assert result.summary.shunt_q is None


def test_dc_result_active_summary(tmp_path: Path) -> None:
    result = _state(tmp_path, _FakeBridge()).run_pflow(method="dc")
    assert result.summary is not None
    assert result.summary.generation_p == pytest.approx(150.0, abs=1e-9)
    assert result.summary.load_p == pytest.approx(150.0, abs=1e-9)
    assert result.summary.loss_p == pytest.approx(0.0, abs=1e-9)
    assert result.summary.slack_p == pytest.approx(100.0, abs=1e-9)


def test_dc_result_settings_say_method(tmp_path: Path) -> None:
    result = _state(tmp_path, _FakeBridge()).run_pflow(method="dc")
    assert result.settings is not None
    assert result.settings.method == "dc"
    assert result.settings.tolerance == 0.0
    assert result.settings.max_iterations == 0
    assert result.settings.flat_start is False
    assert result.settings.enforce_q_limits is False


def test_dc_result_keys(tmp_path: Path) -> None:
    result = _state(tmp_path, _FakeBridge()).run_pflow(method="dc")
    assert result.keys["bus"]["2"] == "bus:2"
    assert result.keys["line"]["1-2-i_1"] == "branch:1-2-1"
    assert result.keys["generator"]["generator-1-1"] == "gen:1-1"
    assert result.keys["load"]["load31"] == "load:3-1"


def test_dc_rejects_tolerance(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    with pytest.raises(
        PflowRequestError,
        match="method dc takes neither tolerance nor max_iterations",
    ):
        _state(tmp_path, bridge).run_pflow(method="dc", tolerance=1e-6)
    assert bridge.dc_calls == []


def test_dc_rejects_max_iterations(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    with pytest.raises(
        PflowRequestError,
        match="method dc takes neither tolerance nor max_iterations",
    ):
        _state(tmp_path, bridge).run_pflow(method="dc", max_iterations=10)
    assert bridge.dc_calls == []


def test_unknown_method_refused(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    with pytest.raises(
        PflowRequestError,
        match=r"the Sienna engine does not have method 'qndf'; it has ac, dc and ptdf-dc",
    ):
        _state(tmp_path, bridge).run_pflow(method="qndf")
    assert bridge.dc_calls == []
    assert bridge.ac_calls == []


def test_andes_only_options_still_refused(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    state = _state(tmp_path, bridge)
    with pytest.raises(
        PflowRequestError, match="the Sienna engine does not take n_factorize"
    ):
        state.run_pflow(n_factorize=4)
    with pytest.raises(
        PflowRequestError, match="the Sienna engine does not take linesearch"
    ):
        state.run_pflow(linesearch=True)
    with pytest.raises(
        PflowRequestError, match="the Sienna engine does not take n_factorize"
    ):
        state.run_pflow(method="dc", n_factorize=4)
    assert bridge.dc_calls == []
    assert bridge.ac_calls == []


def test_flat_start_still_refused_with_dc(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    with pytest.raises(
        PflowRequestError, match="the Sienna engine does not take flat_start"
    ):
        _state(tmp_path, bridge).run_pflow(method="dc", flat_start=True)
    assert bridge.dc_calls == []


def test_enforce_q_limits_still_refused_with_dc(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    with pytest.raises(
        PflowRequestError, match="the Sienna engine does not take enforce_q_limits"
    ):
        _state(tmp_path, bridge).run_pflow(method="dc", enforce_q_limits=True)
    assert bridge.dc_calls == []


def test_ac_default_unchanged(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    result = _state(tmp_path, bridge).run_pflow()
    assert bridge.dc_calls == []
    # The AC call carries no method: the engine's default is the AC power flow.
    assert bridge.ac_calls == [{"tolerance": None, "max_iterations": None}]
    assert result.settings is not None
    assert result.settings.method == "NR"
    assert result.settings.tolerance == pytest.approx(1e-8)
    assert result.settings.max_iterations == 30


def test_ac_explicit_method(tmp_path: Path) -> None:
    bridge = _FakeBridge()
    result = _state(tmp_path, bridge).run_pflow(method="ac")
    assert bridge.dc_calls == []
    assert result.settings is not None
    assert result.settings.method == "NR"


def test_operating_point_after_dc(tmp_path: Path) -> None:
    state = _state(tmp_path, _FakeBridge())
    state.run_pflow(method="dc")
    point = state.operating_point()
    assert point.converged is True
    assert point.settings is None
    assert point.summary is None
    assert point.bus_angles[2] == pytest.approx(1.0 / 60.0, abs=1e-12)
    for flow in point.line_flows.values():
        assert flow.q is None


def test_convert_ac_json_unaffected(tmp_path: Path) -> None:
    result = _state(tmp_path, _FakeBridge()).run_pflow()
    flow = result.line_flows["1-2-i_1"]
    assert flow.q == pytest.approx(2.0)
    assert flow.q_to == pytest.approx(-1.5)
    assert result.generator_outputs["generator-1-1"].q == pytest.approx(11.0)
    assert result.load_consumption["load31"].q == pytest.approx(30.0)
    assert result.summary is not None
    assert result.summary.generation_q == pytest.approx(16.5)
    assert result.summary.load_q == pytest.approx(30.0)


def test_no_case(tmp_path: Path) -> None:
    state = SiennaState(
        workspace=str(tmp_path), session_id="s1", owner_pid=None, bridge=_FakeBridge()
    )
    with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
        state.run_pflow(method="dc")


def test_a_dynamic_analysis_refuses_to_start_after_a_dc_power_flow(tmp_path: Path) -> None:
    """A DC power flow solves a copy of the System and leaves no operating
    point; the time-domain run and the eigenvalue analysis say so, and an AC
    power flow after it lets them start again."""
    from tensa.core.errors import EigPrerequisiteError, TdsRequestError

    state = _state(tmp_path, _FakeBridge())
    state.run_pflow(method="dc")
    with pytest.raises(TdsRequestError, match="the last power flow was a DC one"):
        state.run_tds(tf=1.0)
    with pytest.raises(EigPrerequisiteError, match="the last power flow was a DC one"):
        state.run_eig()
    state.run_pflow()
    state._require_converged_pflow()  # noqa: SLF001 - the gate itself passes again


def test_an_ac_answer_with_no_generators_keeps_numeric_reactive_totals() -> None:
    """Whether a result is DC is read from the method the answer names, not
    from its generators: an AC case with none still has reactive totals."""
    from tensa.engines.sienna.convert import pflow_result

    answer = _ac_json()
    answer["generators"] = []
    topology = _topology()
    topology["generators"] = []
    result = pflow_result(answer, topology, _book())
    assert result.summary is not None
    assert result.summary.generation_q == 0.0
    assert result.summary.load_q is not None
    assert result.summary.loss_q is not None
