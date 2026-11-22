"""Unit tests of the Sienna sim: the conversion of the sim JSON,
``check_load_profile`` and ``SiennaState.run_sim`` with a fake bridge.
No Julia."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest

from tensa.core.errors import NoCaseLoadedError, SiennaError
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.dispatch import NO_COST_DATA_MESSAGE, DispatchRequestError
from tensa.engines.sienna.sim import (
    BAD_PROFILE_MESSAGE,
    SimRequestError,
    SimResult,
    check_load_profile,
    sim_result,
)
from tensa.engines.sienna.state import SiennaState

pytestmark = pytest.mark.unit


def _payload() -> dict[str, Any]:
    """A recorded sim answer, shaped as the Julia module answers: two
    generators, the DA stage with commitment and dispatch, the RT stage with
    dispatch alone. The numbers are a hand example: A on in hours 2 and 3 at
    120 and 150 MW, B at 40 MW in hours 1 and 4."""
    return {
        "status": "completed",
        "network_model": "copper_plate",
        "base_mva": 100.0,
        "interval_minutes": 60,
        "stages": [
            {
                "name": "DA",
                "kind": "uc",
                "resolution_minutes": 60,
                "steps": 24,
                "horizon_hours": 24,
                "objective": 29600.0,
                "commitment": [
                    {"name": "gen-1", "bus": 1, "id": "1", "on": [0.0, 1.0] + [1.0] + [0.0] * 21},
                    {"name": "gen-2", "bus": 2, "id": "1", "on": [1.0] * 24},
                ],
                "dispatch": [
                    {"name": "gen-1", "bus": 1, "id": "1", "p_mw": [0.0, 120.0, 150.0] + [0.0] * 21},
                    {"name": "gen-2", "bus": 2, "id": "1", "p_mw": [40.0, 0.0, 0.0] + [40.0] * 21},
                ],
            },
            {
                "name": "RT",
                "kind": "dispatch",
                "resolution_minutes": 15,
                "steps": 96,
                "horizon_hours": 1,
                "objective": 29100.0,
                "dispatch": [
                    {"name": "gen-1", "bus": 1, "id": "1", "p_mw": [0.0] * 4 + [120.0] * 4 + [150.0] * 4 + [0.0] * 84},
                    {"name": "gen-2", "bus": 2, "id": "1", "p_mw": [40.0] * 4 + [0.0] * 8 + [40.0] * 84},
                ],
            },
        ],
        "slacks": [],
        "store_dir": "sim-20260101-000000",
        "notes": [],
    }


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("gen:1-1", "generator", "Slack", "gen-1", "engine"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "gen-2", "engine"))
    return book


def test_sim_result_keys_generators_by_key() -> None:
    result = sim_result(_payload(), _book())
    assert isinstance(result, SimResult)
    assert result.keys == {"generator": {"gen-1": "gen:1-1", "gen-2": "gen:2-1"}}
    for stage in result.stages:
        assert set(stage.dispatch) == {"gen-1", "gen-2"}
    assert result.stages[0].dispatch["gen-1"].values[1] == 120.0
    assert result.stages[1].dispatch["gen-2"].values[0] == 40.0


def test_sim_result_commitment_only_on_da() -> None:
    result = sim_result(_payload(), _book())
    assert set(result.stages[0].commitment) == {"gen-1", "gen-2"}
    assert result.stages[0].commitment["gen-1"].values[:4] == [0.0, 1.0, 1.0, 0.0]
    assert result.stages[1].commitment == {}


def test_sim_result_fields() -> None:
    result = sim_result(_payload(), _book())
    assert result.status == "completed"
    assert result.network_model == "copper_plate"
    assert result.base_mva == 100.0
    assert result.interval_minutes == 60
    assert result.store_dir == "sim-20260101-000000"
    da, rt = result.stages
    assert (da.name, da.kind, da.resolution_minutes, da.steps, da.horizon_hours) == (
        "DA", "uc", 60, 24, 24.0,
    )
    assert (rt.name, rt.kind, rt.resolution_minutes, rt.steps, rt.horizon_hours) == (
        "RT", "dispatch", 15, 96, 1.0,
    )
    # The two objectives are carried apart: a wrong implementation that drops
    # one, or copies one into the other, fails.
    assert da.objective == 29600.0
    assert rt.objective == 29100.0
    assert result.slacks == []


def test_sim_result_unknown_generator_has_no_key() -> None:
    payload = _payload()
    payload["stages"][1]["dispatch"].append(
        {"name": "gen-9", "bus": 9, "id": "3", "p_mw": [1.0] * 96}
    )
    result = sim_result(payload, _book())
    assert result.stages[1].dispatch["gen-9"].values[0] == 1.0
    assert "gen-9" not in result.keys["generator"]


def test_check_load_profile_accepts_96() -> None:
    profile = [0.5] * 96
    assert check_load_profile(profile) == profile
    # Integers are numbers.
    assert check_load_profile([1] * 96) == [1.0] * 96


def test_check_load_profile_rejects_wrong_length() -> None:
    with pytest.raises(SimRequestError) as excinfo:
        check_load_profile([1.0] * 95)
    assert str(excinfo.value) == BAD_PROFILE_MESSAGE
    with pytest.raises(SimRequestError):
        check_load_profile("not a list")


def test_check_load_profile_rejects_negative_and_nan() -> None:
    for bad in (-0.5, float("nan"), float("inf")):
        with pytest.raises(SimRequestError) as excinfo:
            check_load_profile([1.0] * 95 + [bad])
        assert str(excinfo.value).startswith(
            "load_profile entries must be finite numbers >= 0"
        )


def test_check_load_profile_rejects_all_zero() -> None:
    with pytest.raises(SimRequestError) as excinfo:
        check_load_profile([0.0] * 96)
    assert str(excinfo.value) == "load_profile is all zero; the day has no load to serve"


def test_notes_flattened() -> None:
    payload = _payload()
    payload["notes"] = [{"level": "Warn", "text": "w"}, "plain"]
    result = sim_result(payload, _book())
    assert result.notes == ["w", "plain"]


class FakeBridge:
    """A bridge with a recorded sim payload; records its calls."""

    def __init__(self, payload: dict[str, Any] | None = None, error: Exception | None = None) -> None:
        self.payload = payload if payload is not None else _payload()
        self.error = error
        self.calls: list[tuple[Any, list[float], str, Any]] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def sim(
        self,
        session: Any,
        load_profile: list[float],
        network_model: str,
        ops: Any = None,
    ) -> dict[str, Any]:
        self.calls.append((session, load_profile, network_model, ops))
        if self.error is not None:
            raise self.error
        return self.payload


def _loaded_state(workspace: Path, bridge: FakeBridge) -> SiennaState:
    state = SiennaState(str(workspace), "b" * 32, 1234, bridge=bridge)
    state._session = {"case": "uc_case"}  # noqa: SLF001
    state._key_book = _book()  # noqa: SLF001
    return state


def test_run_sim_calls_the_bridge_and_logs_notes(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    payload = _payload()
    payload["notes"] = [{"level": "warning", "text": "a warning"}, "a string note"]
    bridge = FakeBridge(payload)
    state = _loaded_state(tmp_path, bridge)
    with caplog.at_level(logging.INFO, logger="tensa.notice"):
        result = state.run_sim([0.5] * 96, "dc")
    assert bridge.calls == [(state._session, [0.5] * 96, "dc", None)]  # noqa: SLF001
    assert result.stages[0].dispatch["gen-1"].values[1] == 120.0
    messages = [record.getMessage() for record in caplog.records]
    assert "a warning" in messages
    assert "a string note" in messages


def test_run_sim_defaults_the_network_model(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    state.run_sim([1.0] * 96)
    assert bridge.calls[0][2] == "copper_plate"


def test_run_sim_refuses_a_bad_profile(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    with pytest.raises(SimRequestError):
        state.run_sim([1.0] * 95)
    assert bridge.calls == []


def test_run_sim_refuses_a_bad_network_model(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    with pytest.raises(DispatchRequestError):
        state.run_sim([1.0] * 96, "sdp")
    assert bridge.calls == []


def test_run_sim_refuses_a_psse_case(tmp_path: Path) -> None:
    """PowerSystems gives a .raw case's generators a placeholder cost the
    Julia check cannot tell from a real one, so the state refuses it."""
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    state._case_path = tmp_path / "kundur.RAW"  # noqa: SLF001
    with pytest.raises(DispatchRequestError, match=r"^the case has no generator cost data; .*\.raw"):
        state.run_sim([1.0] * 96)
    assert bridge.calls == []


def test_run_sim_with_no_case(tmp_path: Path) -> None:
    state = SiennaState(str(tmp_path), "b" * 32, 1234, bridge=FakeBridge())
    with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
        state.run_sim([1.0] * 96)


def test_run_sim_propagates_the_sienna_error(tmp_path: Path) -> None:
    bridge = FakeBridge(error=SiennaError(NO_COST_DATA_MESSAGE))
    state = _loaded_state(tmp_path, bridge)
    with pytest.raises(SiennaError) as excinfo:
        state.run_sim([1.0] * 96)
    assert str(excinfo.value) == NO_COST_DATA_MESSAGE
