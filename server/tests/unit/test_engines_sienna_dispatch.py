"""Unit tests of the Sienna dispatch: the conversion of the dispatch JSON and
``SiennaState.run_dispatch`` with a fake bridge. No Julia."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest

from tensa.core.errors import NoCaseLoadedError, SiennaError
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.dispatch import (
    NO_COST_DATA_MESSAGE,
    DispatchRequestError,
    DispatchResult,
    check_network_model,
    dispatch_result,
)
from tensa.engines.sienna.state import SiennaState

pytestmark = pytest.mark.unit


def _payload() -> dict[str, Any]:
    return {
        "status": "completed",
        "network_model": "copper_plate",
        "objective_per_h": 1500.0,
        "objective_check_per_h": 1500.0,
        "fixed_per_h": 0.0,
        "base_mva": 100.0,
        "total_load_mw": 150.0,
        "total_dispatch_mw": 150.0,
        "generators": [
            {"name": "generator-1-1", "bus": 1, "id": "1", "p_mw": 150.0},
            {"name": "generator-2-1", "bus": 2, "id": "1", "p_mw": 0.0},
        ],
        "duals": [],
        "slacks": [],
        "parameters": ["ActivePowerTimeSeriesParameter__PowerLoad"],
        "expressions": [
            "ProductionCostExpression__ThermalStandard",
            "ActivePowerBalance__System",
        ],
        "notes": [],
    }


def _ac_payload() -> dict[str, Any]:
    """A recorded AC answer: one bus, one branch, one generator with q_mvar,
    and the total losses. The numbers are a hand example: 90 MW in at the
    from end, 88.5 MW out at the to end, 1.5 MW of losses."""
    payload = _payload()
    payload["network_model"] = "ac"
    payload["generators"] = [
        {"name": "gen-1", "bus": 1, "id": "1", "p_mw": 90.0, "q_mvar": 12.5},
    ]
    payload["buses"] = [
        {"name": "bus-1", "bus": 1, "v_pu": 1.05, "angle_rad": 0.0},
    ]
    payload["branches"] = [
        {
            "name": "branch-1-2-1",
            "from": 1,
            "to": 2,
            "ckt": "1",
            "p_from_mw": 90.0,
            "q_from_mvar": 20.0,
            "p_to_mw": -88.5,
            "q_to_mvar": -18.0,
            "losses_mw": 1.5,
            "losses_mvar": 2.0,
        },
    ]
    payload["total_losses_mw"] = 1.5
    return payload


def _book() -> KeyBook:
    """The book a load of the two-generator case holds: the buses, and each
    generator under its neutral key (the slack at bus 1, a PV at bus 2)."""
    book = KeyBook()
    book.assign(KeyEntry("bus:1", "bus", "Bus", 1, "engine"))
    book.assign(KeyEntry("bus:2", "bus", "Bus", 2, "engine"))
    book.assign(KeyEntry("gen:1-1", "generator", "Slack", "generator-1-1", "engine"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "engine"))
    return book


def _ac_book() -> KeyBook:
    """The book of the recorded AC answer, as assign_sienna_keys fills it: a
    bus under its number, a line under the ``line`` bucket by its component
    name, a generator by its component name."""
    book = KeyBook()
    book.assign(KeyEntry("bus:1", "bus", "Bus", 1, "engine"))
    book.assign(KeyEntry("branch:1-2-1", "line", "Line", "branch-1-2-1", "engine"))
    book.assign(KeyEntry("gen:1-1", "generator", "Slack", "gen-1", "engine"))
    return book


def test_conversion_carries_the_values_verbatim() -> None:
    result = dispatch_result(_payload(), _book())
    assert isinstance(result, DispatchResult)
    assert result.status == "completed"
    assert result.network_model == "copper_plate"
    # The two objectives are carried apart: a wrong implementation that drops
    # one, or copies one into the other, fails.
    assert result.objective_per_h == 1500.0
    assert result.objective_check_per_h == 1500.0
    assert result.base_mva == 100.0
    assert result.total_load_mw == 150.0
    assert result.total_dispatch_mw == 150.0
    assert result.parameters == ["ActivePowerTimeSeriesParameter__PowerLoad"]
    assert result.expressions == [
        "ProductionCostExpression__ThermalStandard",
        "ActivePowerBalance__System",
    ]
    assert result.slacks == []
    assert result.duals == []


def test_generators_and_keys() -> None:
    result = dispatch_result(_payload(), _book())
    assert set(result.generators) == {"generator-1-1", "generator-2-1"}
    assert result.generators["generator-1-1"].p_mw == 150.0
    assert result.generators["generator-1-1"].bus == 1
    assert result.generators["generator-1-1"].id == "1"
    assert result.generators["generator-2-1"].p_mw == 0.0
    # The keys come from the book, matched by idx, with no topology JSON.
    assert result.keys == {
        "generator": {
            "generator-1-1": "gen:1-1",
            "generator-2-1": "gen:2-1",
        },
        "bus": {},
        "branch": {},
    }


def test_a_generator_the_book_lacks_is_kept_without_a_key() -> None:
    payload = _payload()
    payload["generators"].append(
        {"name": "generator-9-3", "bus": 9, "id": "3", "p_mw": 1.0}
    )
    result = dispatch_result(payload, _book())
    assert result.generators["generator-9-3"].p_mw == 1.0
    assert "generator-9-3" not in result.keys["generator"]


def test_a_matpower_generator_is_keyed_by_its_name_not_its_row() -> None:
    """PowerSystems names a MATPOWER generator after its row (gen-<n>), and the
    answer's id is read off that name: gen-1, the second unit on bus 2, says
    id 1, but its key is gen:2-2. The key comes from the book by name."""
    book = KeyBook()
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "gen-2", "engine"))
    book.assign(KeyEntry("gen:2-2", "generator", "PV", "gen-1", "engine"))
    payload = _payload()
    payload["generators"] = [
        {"name": "gen-1", "bus": 2, "id": "1", "p_mw": 30.0},
        {"name": "gen-2", "bus": 2, "id": "2", "p_mw": 120.0},
    ]
    result = dispatch_result(payload, book)
    assert result.keys["generator"] == {"gen-1": "gen:2-2", "gen-2": "gen:2-1"}


def test_only_a_generator_entry_keys_a_generator() -> None:
    """A machine's dynamic model is named after its generator, so the book
    can hold a dynamic entry under the generator's name; it is not the
    generator's key."""
    book = KeyBook()
    book.assign(KeyEntry("gen:1-1/machine", "dynamic", "GENROU", "generator-1-1", "engine"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "engine"))
    result = dispatch_result(_payload(), book)
    assert result.keys["generator"] == {"generator-2-1": "gen:2-1"}


def test_distinct_objectives_are_carried_apart() -> None:
    payload = _payload()
    payload["objective_per_h"] = 1500.0
    payload["objective_check_per_h"] = 1500.0001
    result = dispatch_result(payload, _book())
    assert result.objective_per_h == 1500.0
    assert result.objective_check_per_h == 1500.0001


def test_the_constant_terms_are_carried_apart() -> None:
    """The solver's objective leaves the gencost constant terms out, the
    recomputed cost holds them, and fixed_per_h is the difference."""
    payload = _payload()
    payload["objective_per_h"] = 1500.0
    payload["objective_check_per_h"] = 1650.0
    payload["fixed_per_h"] = 150.0
    result = dispatch_result(payload, _book())
    assert result.fixed_per_h == 150.0
    assert result.objective_per_h + result.fixed_per_h == result.objective_check_per_h


def test_slacks_and_duals_pass_through() -> None:
    payload = _payload()
    payload["slacks"] = [
        {"variable": "SystemBalanceSlackUp__System", "element": "System", "value": 3.5}
    ]
    payload["duals"] = [
        {"name": "CopperPlateBalanceConstraint__System", "rows": [{"element": "System", "value": -12.0}]}
    ]
    result = dispatch_result(payload, _book())
    assert result.slacks == [
        {"variable": "SystemBalanceSlackUp__System", "element": "System", "value": 3.5}
    ]
    assert result.duals[0]["name"] == "CopperPlateBalanceConstraint__System"
    assert result.duals[0]["rows"] == [{"element": "System", "value": -12.0}]


def test_notes_are_texts() -> None:
    payload = _payload()
    payload["notes"] = ["a string note", {"level": "warning", "text": "a warning"}]
    result = dispatch_result(payload, _book())
    assert result.notes == ["a string note", "a warning"]


def test_check_network_model() -> None:
    assert check_network_model("dc") == "dc"


def test_check_network_model_ac() -> None:
    assert check_network_model("ac") == "ac"


def test_check_network_model_rejects_unknown() -> None:
    with pytest.raises(DispatchRequestError) as excinfo:
        check_network_model("sdp")
    assert str(excinfo.value) == (
        "network_model must be copper_plate, dc, ptdf or ac, got 'sdp'"
    )


def test_dispatch_result_ac_fields() -> None:
    result = dispatch_result(_ac_payload(), _ac_book())
    assert result.buses["bus-1"].v_pu == 1.05
    assert result.buses["bus-1"].bus == 1
    assert result.buses["bus-1"].angle_rad == 0.0
    assert result.branches["branch-1-2-1"].losses_mw == 1.5
    # The losses are the sum of the two ends: 90.0 + (-88.5) = 1.5 MW.
    assert (
        result.branches["branch-1-2-1"].p_from_mw
        + result.branches["branch-1-2-1"].p_to_mw
        == result.branches["branch-1-2-1"].losses_mw
    )
    assert result.branches["branch-1-2-1"].losses_mvar == 2.0
    assert result.generators["gen-1"].q_mvar == 12.5
    assert result.total_losses_mw == 1.5
    assert result.keys == {
        "generator": {"gen-1": "gen:1-1"},
        "bus": {"bus-1": "bus:1"},
        "branch": {"branch-1-2-1": "branch:1-2-1"},
    }


def test_dispatch_result_lossless_has_no_ac_fields() -> None:
    result = dispatch_result(_payload(), _book())
    assert result.buses == {}
    assert result.branches == {}
    assert result.total_losses_mw is None
    assert result.generators["generator-1-1"].q_mvar is None
    assert result.keys["bus"] == {}
    assert result.keys["branch"] == {}


def test_dispatch_result_unmatched_names_have_no_key() -> None:
    payload = _ac_payload()
    payload["branches"] = [
        {
            "name": "branch-4-5-1",
            "from": 4,
            "to": 5,
            "ckt": "1",
            "p_from_mw": 10.0,
            "q_from_mvar": 1.0,
            "p_to_mw": -9.9,
            "q_to_mvar": -0.9,
            "losses_mw": 0.1,
            "losses_mvar": 0.1,
        },
    ]
    result = dispatch_result(payload, _ac_book())
    assert result.branches["branch-4-5-1"].losses_mw == 0.1
    assert result.keys["branch"] == {}


class FakeBridge:
    """A bridge with a recorded dispatch payload; records its calls."""

    def __init__(self, payload: dict[str, Any] | None = None, error: Exception | None = None) -> None:
        self.payload = payload if payload is not None else _payload()
        self.error = error
        self.calls: list[tuple[Any, str, bool]] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def dispatch(self, session: Any, network_model: str, duals: bool = False) -> dict[str, Any]:
        self.calls.append((session, network_model, duals))
        if self.error is not None:
            raise self.error
        return self.payload


def _loaded_state(workspace: Path, bridge: FakeBridge) -> SiennaState:
    state = SiennaState(str(workspace), "b" * 32, 1234, bridge=bridge)
    state._session = {"case": "two_gen"}  # noqa: SLF001
    state._key_book = _book()  # noqa: SLF001
    return state


def test_run_dispatch_calls_the_bridge_and_logs_notes(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    payload = _payload()
    payload["notes"] = [{"level": "warning", "text": "a warning"}, "a string note"]
    bridge = FakeBridge(payload)
    state = _loaded_state(tmp_path, bridge)
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        result = state.run_dispatch("copper_plate")
    assert bridge.calls == [(state._session, "copper_plate", False)]  # noqa: SLF001
    assert result.generators["generator-1-1"].p_mw == 150.0
    messages = [record.getMessage() for record in caplog.records]
    assert "a warning" in messages
    assert "a string note" in messages


def test_run_dispatch_passes_duals(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    state.run_dispatch("dc", duals=True)
    assert bridge.calls == [(state._session, "dc", True)]  # noqa: SLF001


def test_run_dispatch_accepts_ac(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    state.run_dispatch("ac")
    assert bridge.calls == [(state._session, "ac", False)]  # noqa: SLF001


def test_run_dispatch_refuses_a_bad_network_model(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    with pytest.raises(DispatchRequestError) as excinfo:
        state.run_dispatch("sdp")
    assert str(excinfo.value) == (
        "network_model must be copper_plate, dc, ptdf or ac, got 'sdp'"
    )
    assert bridge.calls == []


def test_run_dispatch_refuses_a_psse_case(tmp_path: Path) -> None:
    """PowerSystems gives a .raw case's generators a placeholder cost the
    Julia check cannot tell from a real one, so the state refuses it."""
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    state._case_path = tmp_path / "kundur.RAW"  # noqa: SLF001
    with pytest.raises(DispatchRequestError, match=r"^the case has no generator cost data; .*\.raw"):
        state.run_dispatch("copper_plate")
    assert bridge.calls == []
    state._case_path = tmp_path / "case.m"  # noqa: SLF001
    state.run_dispatch("copper_plate")
    assert len(bridge.calls) == 1


def test_run_dispatch_with_no_case(tmp_path: Path) -> None:
    state = SiennaState(str(tmp_path), "b" * 32, 1234, bridge=FakeBridge())
    with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
        state.run_dispatch("copper_plate")


def test_run_dispatch_propagates_the_sienna_error(tmp_path: Path) -> None:
    bridge = FakeBridge(error=SiennaError(NO_COST_DATA_MESSAGE))
    state = _loaded_state(tmp_path, bridge)
    with pytest.raises(SiennaError) as excinfo:
        state.run_dispatch("copper_plate")
    assert str(excinfo.value) == NO_COST_DATA_MESSAGE
