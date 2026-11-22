"""Unit tests of the Sienna unit commitment: the request validation, the
conversion of the uc JSON and ``SiennaState.run_uc`` with a fake bridge.
No Julia."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tensa.core.errors import SiennaError
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.dispatch import DispatchRequestError
from tensa.engines.sienna.state import SiennaState
from tensa.engines.sienna.uc import (
    UcRequestError,
    UcResult,
    check_uc_overrides,
    check_uc_request,
    uc_result,
)

pytestmark = pytest.mark.unit

# The hand-worked optimum of the Julia test, as the recorded payload:
# generator A (gen-1) 10 $/MWh, PMIN 50, start-up 500 $; generator B (gen-2)
# 30 $/MWh; load 40, 120, 150, 40 MW. A on in hours 2 and 3, one start-up:
# energy 10*270 + 30*80 = 5100 $, start-up 500 $, fixed 0 $, total 5600 $.
def _payload() -> dict[str, Any]:
    return {
        "status": "completed",
        "network_model": "copper_plate",
        "horizon_h": 4,
        "resolution_min": 60,
        "periods": [
            "2026-01-01T01:00:00",
            "2026-01-01T02:00:00",
            "2026-01-01T03:00:00",
            "2026-01-01T04:00:00",
        ],
        "base_mva": 100.0,
        "objective": 5600.0,
        "objective_check": 5600.0,
        "cost": {"energy": 5100.0, "startup": 500.0, "fixed": 0.0, "total": 5600.0},
        "total_load_mw": [40.0, 120.0, 150.0, 40.0],
        "generators": [
            {
                "name": "gen-1",
                "bus": 1,
                "id": "1",
                "on": [False, True, True, False],
                "p_mw": [0.0, 120.0, 150.0, 0.0],
                "energy": 2700.0,
                "startup": 500.0,
                "fixed": 0.0,
            },
            {
                "name": "gen-2",
                "bus": 2,
                "id": "1",
                "on": [True, False, False, True],
                "p_mw": [40.0, 0.0, 0.0, 40.0],
                "energy": 2400.0,
                "startup": 0.0,
                "fixed": 0.0,
            },
        ],
        "slacks": [],
        "parameters": ["ActivePowerTimeSeriesParameter__PowerLoad"],
        "expressions": ["ProductionCostExpression__ThermalStandard"],
        "notes": [],
    }


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("gen:1-1", "generator", "PV", "gen-1", "file"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "gen-2", "file"))
    return book


def test_check_uc_request_accepts_the_hand_case() -> None:
    assert check_uc_request("copper_plate", 4, 60, [0.5, 0.7, 1.0, 0.6]) is None


def test_unknown_network_model() -> None:
    with pytest.raises(UcRequestError) as excinfo:
        check_uc_request("ac", 4, 60, [1.0, 1.0, 1.0, 1.0])
    assert str(excinfo.value) == (
        "network_model must be copper_plate, dc or ptdf, got 'ac'"
    )


def test_horizon_bounds() -> None:
    for bad in (0, 169, 2.5, True):
        with pytest.raises(UcRequestError) as excinfo:
            check_uc_request("dc", bad, 60, [1.0, 1.0, 1.0, 1.0])
        assert str(excinfo.value).startswith(
            "horizon_h must be a whole number of hours from 1 to 168, got "
        )


def test_resolution() -> None:
    with pytest.raises(UcRequestError) as excinfo:
        check_uc_request("dc", 4, 45, [1.0, 1.0, 1.0, 1.0])
    assert str(excinfo.value) == "resolution_min must be 15, 30 or 60, got 45"


def test_series_length() -> None:
    with pytest.raises(UcRequestError) as excinfo:
        check_uc_request("dc", 4, 60, [1.0, 1.0, 1.0])
    assert str(excinfo.value) == (
        "series must give one factor per period: 4 periods of 60 minutes "
        "over 4 hours, got [1.0, 1.0, 1.0]"
    )


def test_series_factor_not_positive() -> None:
    with pytest.raises(UcRequestError) as excinfo:
        check_uc_request("dc", 4, 60, [0.5, 0.0, 1.0, 0.6])
    assert str(excinfo.value) == (
        "series factors must be finite numbers above 0, got 0.0 at period 2"
    )
    with pytest.raises(UcRequestError, match="got nan at period 3"):
        check_uc_request("dc", 4, 60, [0.5, 0.7, float("nan"), 0.6])
    with pytest.raises(UcRequestError, match="got True at period 1"):
        check_uc_request("dc", 4, 60, [True, 0.7, 1.0, 0.6])


def test_overrides_unknown_key() -> None:
    with pytest.raises(UcRequestError) as excinfo:
        check_uc_overrides({"gen:9-1": {"startup_cost": 100.0}}, _book())
    assert str(excinfo.value) == "no generator with key 'gen:9-1'"


def test_overrides_unknown_field() -> None:
    with pytest.raises(UcRequestError) as excinfo:
        check_uc_overrides({"gen:1-1": {"ramp": 5.0}}, _book())
    assert str(excinfo.value) == (
        "unknown override field 'ramp' for gen:1-1; the fields are "
        "startup_cost, min_up_h, min_down_h, must_run"
    )


def test_overrides_keyed_to_names() -> None:
    named = check_uc_overrides(
        {"gen:1-1": {"startup_cost": 100.0, "min_up_h": 2.0}}, _book()
    )
    assert named == {"gen-1": {"startup_cost": 100.0, "min_up_h": 2.0}}


def test_overrides_value_shapes() -> None:
    with pytest.raises(UcRequestError, match="must_run must be true or false"):
        check_uc_overrides({"gen:1-1": {"must_run": 1}}, _book())
    with pytest.raises(UcRequestError, match="startup_cost must be"):
        check_uc_overrides({"gen:1-1": {"startup_cost": -1.0}}, _book())


class FakeBridge:
    """A bridge with a recorded uc payload; records its calls."""

    def __init__(
        self,
        payload: dict[str, Any] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.payload = payload if payload is not None else _payload()
        self.error = error
        self.calls: list[tuple[Any, ...]] = []
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def uc(
        self,
        session: Any,
        network_model: str,
        horizon_h: int,
        resolution_min: int,
        series: list[float],
        overrides: dict[str, dict[str, Any]],
        ops: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            (session, network_model, horizon_h, resolution_min, series, overrides, ops)
        )
        if self.error is not None:
            raise self.error
        return self.payload


def _loaded_state(workspace: Path, bridge: FakeBridge) -> SiennaState:
    state = SiennaState(str(workspace), "b" * 32, 1234, bridge=bridge)
    state._session = {"case": "uc_case"}  # noqa: SLF001
    state._case_path = Path("case.m")  # noqa: SLF001
    state._topology_json = {"base_mva": 100.0}  # noqa: SLF001
    state._key_book = _book()  # noqa: SLF001
    state._document = {  # noqa: SLF001
        "generator_ops": [
            {"bus": 1, "gen_id": "1", "startup_usd": 500.0},
            {"bus": 2, "gen_id": "1", "startup_usd": 0.0},
        ]
    }
    return state


def test_run_uc_calls_the_bridge(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    result = state.run_uc(
        "copper_plate",
        4,
        60,
        [0.5, 0.7, 1.0, 0.6],
        {"gen:1-1": {"startup_cost": 100.0}},
    )
    assert isinstance(result, UcResult)
    session, network_model, horizon_h, resolution_min, series, overrides, ops = (
        bridge.calls[0]
    )
    assert session is state._session  # noqa: SLF001
    assert network_model == "copper_plate"
    assert horizon_h == 4
    assert resolution_min == 60
    assert series == [0.5, 0.7, 1.0, 0.6]
    assert overrides == {"gen-1": {"startup_cost": 100.0}}
    # The case facts' startup_usd rows go to Julia, which sets them on the
    # copy because PowerSystems does not read the STARTUP column.
    assert ops == [
        {"bus": 1, "gen_id": "1", "startup_usd": 500.0},
        {"bus": 2, "gen_id": "1", "startup_usd": 0.0},
    ]
    assert result.generators["gen-1"].on == [False, True, True, False]


def test_run_uc_refuses_a_raw_case(tmp_path: Path) -> None:
    bridge = FakeBridge()
    state = _loaded_state(tmp_path, bridge)
    state._case_path = tmp_path / "kundur.raw"  # noqa: SLF001
    with pytest.raises(DispatchRequestError) as excinfo:
        state.run_uc("copper_plate", 4, 60, [0.5, 0.7, 1.0, 0.6])
    assert str(excinfo.value).startswith(
        "the case has no generator cost data; economic dispatch needs "
        "gencost records, which a PSS/E .raw case does not carry"
    )
    assert bridge.calls == []


def test_run_uc_refuses_before_julia(tmp_path: Path) -> None:
    class GuardBridge(FakeBridge):
        def uc(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            raise AssertionError("the bridge must not be called")

    state = _loaded_state(tmp_path, GuardBridge())
    with pytest.raises(UcRequestError, match="series must give one factor per period"):
        state.run_uc("copper_plate", 4, 60, [1.0])


def test_uc_result_keys() -> None:
    result = uc_result(_payload(), _book())
    assert result.keys == {"generator": {"gen-1": "gen:1-1", "gen-2": "gen:2-1"}}
    assert result.cost.total == pytest.approx(
        result.cost.energy + result.cost.startup + result.cost.fixed
    )


def test_uc_result_notes_flattened() -> None:
    payload = _payload()
    payload["notes"] = [{"level": "warning", "text": "w"}, "s"]
    result = uc_result(payload, _book())
    assert result.notes == ["w", "s"]


def test_sienna_error_propagates(tmp_path: Path) -> None:
    bridge = FakeBridge(error=SiennaError("unit commitment did not solve: kHighs"))
    state = _loaded_state(tmp_path, bridge)
    with pytest.raises(SiennaError) as excinfo:
        state.run_uc("copper_plate", 4, 60, [0.5, 0.7, 1.0, 0.6])
    assert str(excinfo.value) == "unit commitment did not solve: kHighs"
