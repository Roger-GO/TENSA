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


def _book() -> KeyBook:
    """The book a load of the two-generator case holds: the buses, and each
    generator under its neutral key (the slack at bus 1, a PV at bus 2)."""
    book = KeyBook()
    book.assign(KeyEntry("bus:1", "bus", "Bus", 1, "engine"))
    book.assign(KeyEntry("bus:2", "bus", "Bus", 2, "engine"))
    book.assign(KeyEntry("gen:1-1", "generator", "Slack", "generator-1-1", "engine"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "engine"))
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
        }
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
    assert result.keys == {"generator": {"gen-1": "gen:2-2", "gen-2": "gen:2-1"}}


def test_only_a_generator_entry_keys_a_generator() -> None:
    """A machine's dynamic model is named after its generator, so the book
    can hold a dynamic entry under the generator's name; it is not the
    generator's key."""
    book = KeyBook()
    book.assign(KeyEntry("gen:1-1/machine", "dynamic", "GENROU", "generator-1-1", "engine"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "engine"))
    result = dispatch_result(_payload(), book)
    assert result.keys == {"generator": {"generator-2-1": "gen:2-1"}}


def test_distinct_objectives_are_carried_apart() -> None:
    payload = _payload()
    payload["objective_per_h"] = 1500.0
    payload["objective_check_per_h"] = 1500.0001
    result = dispatch_result(payload, _book())
    assert result.objective_per_h == 1500.0
    assert result.objective_check_per_h == 1500.0001


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
    with pytest.raises(DispatchRequestError) as excinfo:
        check_network_model("ac")
    assert str(excinfo.value) == (
        "network_model must be copper_plate, dc or ptdf, got 'ac'"
    )


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


def test_run_dispatch_refuses_a_bad_network_model(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    with pytest.raises(DispatchRequestError) as excinfo:
        state.run_dispatch("ac")
    assert str(excinfo.value) == (
        "network_model must be copper_plate, dc or ptdf, got 'ac'"
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
