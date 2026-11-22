"""Unit tests for the Sienna disturbance store: the neutral mapping, the run
entries, and the state's pending list. No Julia; the bridge is faked."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from tensa.core.errors import DisturbanceValidationError, NoCaseLoadedError
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.disturbances import (
    PendingDisturbance,
    run_json_entries,
    to_pending,
)
from tensa.engines.sienna.state import SiennaState

_SAMPLES = Path(__file__).parent / "sienna_samples"


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("bus:7", "bus", "Bus", 7, "engine"))
    book.assign(KeyEntry("branch:7-8-1", "line", "Line", "line-7-8-1", "file"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", "generator-2-1", "file"))
    book.assign(
        KeyEntry("gen:2-1/machine", "dynamic", "GENROU", "generator-2-1/GENROU", "engine")
    )
    return book


def test_fault_maps_to_bus_fault() -> None:
    spec = FaultSpec(bus_idx=7, tf=1.0, tc=1.05, xf=1e-4, rf=0.0)
    pending = to_pending(spec, _book())
    assert pending.spec is spec
    assert pending.neutral == {
        "kind": "bus_fault",
        "bus": "bus:7",
        "t_on": 1.0,
        "t_clear": 1.05,
        "r_pu": 0.0,
        "x_pu": 0.0001,
    }
    assert run_json_entries([pending], _book()) == [
        {
            "kind": "bus_fault",
            "bus": 7,
            "t_on": 1.0,
            "t_clear": 1.05,
            "r_pu": 0.0,
            "x_pu": 0.0001,
        }
    ]


def test_toggle_on_a_line_maps_to_branch_trip() -> None:
    spec = ToggleSpec(model="Line", dev_idx="line-7-8-1", t=1.0)
    pending = to_pending(spec, _book())
    assert pending.neutral == {"kind": "branch_trip", "target": "branch:7-8-1", "t": 1.0}
    assert run_json_entries([pending], _book()) == [
        {"kind": "branch_trip", "from": 7, "to": 8, "ckt": "1", "t": 1.0}
    ]


def test_toggle_on_a_machine_maps_to_gen_trip_on_the_unit() -> None:
    spec = ToggleSpec(model="GENROU", dev_idx="generator-2-1/GENROU", t=1.0)
    pending = to_pending(spec, _book())
    assert pending.neutral == {"kind": "gen_trip", "target": "gen:2-1", "t": 1.0}
    assert run_json_entries([pending], _book()) == [
        {"kind": "gen_trip", "bus": 2, "id": "1", "t": 1.0}
    ]


def test_toggle_on_a_static_generator_maps_to_gen_trip() -> None:
    spec = ToggleSpec(model="PV", dev_idx="generator-2-1", t=1.0)
    pending = to_pending(spec, _book())
    assert pending.neutral == {"kind": "gen_trip", "target": "gen:2-1", "t": 1.0}
    assert run_json_entries([pending], _book()) == [
        {"kind": "gen_trip", "bus": 2, "id": "1", "t": 1.0}
    ]


def test_toggle_on_a_load_is_refused_naming_what_the_engine_takes() -> None:
    spec = ToggleSpec(model="PQ", dev_idx="load-7-1", t=1.0)
    with pytest.raises(DisturbanceValidationError) as caught:
        to_pending(spec, _book())
    assert str(caught.value) == (
        "the Sienna engine takes a Fault on a bus, a Toggle on a Line "
        "(a branch trip) or on a generator (a generator trip); "
        "it does not take a Toggle on PQ"
    )


def test_an_alter_is_refused_naming_what_the_engine_takes() -> None:
    spec = AlterSpec(model="PQ", dev_idx="load-7-1", src="Ppf", t=1.0, method="=", amount=1.2)
    with pytest.raises(DisturbanceValidationError) as caught:
        to_pending(spec, _book())
    assert str(caught.value) == (
        "the Sienna engine takes a Fault on a bus, a Toggle on a Line "
        "(a branch trip) or on a generator (a generator trip); "
        "it does not take an Alter"
    )


def test_a_fault_on_a_bus_the_case_lacks_is_refused() -> None:
    spec = FaultSpec(bus_idx=99, tf=1.0, tc=1.05, xf=1e-4, rf=0.0)
    with pytest.raises(DisturbanceValidationError, match="99"):
        to_pending(spec, _book())


def test_a_toggle_on_a_generator_the_case_lacks_is_refused() -> None:
    spec = ToggleSpec(model="PV", dev_idx="generator-9-1", t=1.0)
    with pytest.raises(DisturbanceValidationError, match="generator-9-1"):
        to_pending(spec, _book())


def test_run_entries_refuse_a_key_the_book_dropped() -> None:
    book = _book()
    pending = to_pending(ToggleSpec(model="Line", dev_idx="line-7-8-1", t=1.0), book)
    book.retain(set())
    with pytest.raises(DisturbanceValidationError, match="branch:7-8-1"):
        run_json_entries([pending], book)


def test_run_entries_refuse_a_key_that_does_not_parse() -> None:
    book = _book()
    book.assign(KeyEntry("branch:odd", "line", "Line", "line-odd", "engine"))
    pending = PendingDisturbance(
        spec=ToggleSpec(model="Line", dev_idx="line-odd", t=1.0),
        neutral={"kind": "branch_trip", "target": "branch:odd", "t": 1.0},
    )
    with pytest.raises(DisturbanceValidationError, match="branch:odd"):
        run_json_entries([pending], book)


class _FakeBridge:
    """The smallest fake for a load: recorded samples, no dynamics."""

    def __init__(self) -> None:
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def start(self) -> None:
        self._started = True

    def _sample(self, name: str, kind: str) -> dict[str, Any]:
        return json.loads((_SAMPLES / f"{name}.{kind}.json").read_text("utf-8"))

    def load_case(self, raw: Path, dyr: Any, scratch: Path, v_setpoints: Any, corrections: Any) -> Any:
        return {"case": raw.stem}

    def report(self, session: Any) -> dict[str, Any]:
        return self._sample(session["case"], "report")

    def topology(self, session: Any) -> dict[str, Any]:
        return self._sample(session["case"], "topology")


def _andes_cases_dir() -> Path:
    andes = pytest.importorskip("andes")
    return Path(andes.__file__).parent / "cases"


def test_state_pending_list_round_trip_and_clear(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    case = workspace / "kundur.raw"
    case.write_bytes((_andes_cases_dir() / "kundur" / "kundur.raw").read_bytes())
    state = SiennaState(str(workspace), "d" * 32, 1234, bridge=_FakeBridge())

    with pytest.raises(NoCaseLoadedError):
        state.add_disturbance(FaultSpec(bus_idx=7, tf=1.0, tc=1.05, xf=1e-4, rf=0.0))

    state.load_case(case)
    fault = FaultSpec(bus_idx=7, tf=1.0, tc=1.05, xf=1e-4, rf=0.0)
    assert state.add_disturbance(fault) == "0"
    listed = state.list_disturbances()
    assert listed == [fault]
    assert [spec.model_dump() for spec in listed] == [fault.model_dump()]
    state.clear_disturbances()
    assert state.list_disturbances() == []

    # A fresh load wipes the pending list, as the ANDES wrapper's does.
    state.add_disturbance(fault)
    state.load_case(case)
    assert state.list_disturbances() == []
