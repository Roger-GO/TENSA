"""Unit tests of ``SiennaState``'s edit methods and the runtime's argument
mapping, with a fake bridge. No Julia.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tensa.core.errors import (
    ElementNotFoundError,
    ElementValidationError,
    NoCaseLoadedError,
    SiennaError,
)
from tensa.engines.sienna.runtime import _HANDLERS
from tensa.engines.sienna.state import SiennaState

# A small fixed topology: buses 1 and 7, branch 1-7 ckt "1", generator
# generator-1-1 on bus 1, load load71 id "1" on bus 7, shunt 7-1 on bus 7.
_TOPOLOGY: dict[str, Any] = {
    "base_mva": 100.0,
    "freq_hz": 60.0,
    "buses": [
        {"number": 1, "name": "BUS1", "vn_kv": 20.0, "type": "REF", "v_pu": 1.0, "angle_rad": 0.0, "available": True},
        {"number": 7, "name": "BUS7", "vn_kv": 230.0, "type": "PQ", "v_pu": 1.0, "angle_rad": 0.0, "available": True},
    ],
    "branches": [
        {"name": "1-7-i_1", "from": 1, "to": 7, "ckt": "1", "kind": "line", "sienna_type": "Line",
         "r_pu": 0.01, "x_pu": 0.1, "b_pu": 0.0, "tap": 1.0, "shift_rad": 0.0, "rate_mva": None, "available": True},
    ],
    "generators": [
        {"name": "generator-1-1", "bus": 1, "id": "1", "kind": "Slack", "sienna_type": "ThermalStandard",
         "p_mw": 100.0, "q_mvar": 0.0, "v_set_pu": 1.0, "q_min_mvar": None, "q_max_mvar": None,
         "mbase_mva": 100.0, "available": True, "has_dynamics": False},
    ],
    "loads": [
        {"name": "load71", "bus": 7, "id": "1", "sienna_type": "PowerLoad",
         "p_mw": 50.0, "q_mvar": 10.0, "available": True},
    ],
    "shunts": [
        {"name": "7-1", "bus": 7, "order": 1, "kind": "fixed", "sienna_type": "FixedAdmittance",
         "g_mw": 0.0, "b_mvar": 20.0, "available": True},
    ],
    "dynamics": [],
}

_REPORT: dict[str, Any] = {
    "buses": 2,
    "notes": [],
    "unsupported": [],
    "events": [],
    "normalised_buses": [],
    "dyr_records": 0,
    "dynamic_injectors": 0,
    "applied": [],
}

_PFLOW: dict[str, Any] = {
    "converged": True,
    "tolerance": 1e-9,
    "max_iterations": 30,
    "notes": [],
    "buses": [
        {"number": 1, "v_pu": 1.0, "angle_rad": 0.0},
        {"number": 7, "v_pu": 0.99, "angle_rad": -0.1},
    ],
    "branches": [],
    "generators": [{"name": "generator-1-1", "bus": 1, "id": "1", "p_mw": 150.0, "q_mvar": 5.0}],
    "loads": [{"name": "load71", "bus": 7, "id": "1", "p_mw": 50.0, "q_mvar": 10.0}],
}


class FakeBridge:
    """Records calls and answers the fixed JSON above."""

    def __init__(self) -> None:
        self.started = True
        self.load_calls: list[Path] = []
        self.edits_sent: list[str] = []
        self.fail_apply = False
        # A key whose edits the System refuses, as the Julia module answers one.
        self.refuse_key: str | None = None

    def load_case(self, raw: Path, dyr: Any, scratch: Path, v_setpoints: Any, corrections: Any) -> Any:
        self.load_calls.append(raw)
        return {"case": raw.stem}

    def report(self, session: Any) -> dict[str, Any]:
        return dict(_REPORT)

    def topology(self, session: Any) -> dict[str, Any]:
        return json.loads(json.dumps(_TOPOLOGY))

    def apply_edits(self, session: Any, edits_json: str) -> dict[str, Any]:
        if self.fail_apply:
            raise SiennaError("no such component")
        self.edits_sent.append(edits_json)
        ops = json.loads(edits_json)
        refused = [
            {"key": op["key"], "reason": "no load named load71 in the System"}
            for op in ops
            if op["key"] == self.refuse_key
        ]
        return {"applied": [op for op in ops if op["key"] != self.refuse_key], "refused": refused}

    def pflow(self, session: Any, tolerance: Any = None, max_iterations: Any = None) -> dict[str, Any]:
        return dict(_PFLOW)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "case.raw").write_text("0, 100.0, 33, 0, 0, 60.0\n")
    return ws


@pytest.fixture
def state(workspace: Path) -> SiennaState:
    return SiennaState(str(workspace), "s1", None, bridge=FakeBridge())


@pytest.fixture
def loaded(state: SiennaState, workspace: Path) -> SiennaState:
    state.load_case(workspace / "case.raw")
    return state


def _fake(state: SiennaState) -> FakeBridge:
    bridge = state._bridge  # noqa: SLF001
    assert isinstance(bridge, FakeBridge)
    return bridge


def test_set_field_appends_and_applies(loaded: SiennaState) -> None:
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    fake = _fake(loaded)
    assert len(fake.edits_sent) == 1
    assert json.loads(fake.edits_sent[0]) == [
        {"op": "set", "key": "load:7-1", "name": "load71", "field": "p_mw", "value": 500.0}
    ]
    assert loaded._pflow_json is None  # noqa: SLF001


def test_set_field_unknown_key(loaded: SiennaState) -> None:
    with pytest.raises(ElementNotFoundError, match=r"no element with key 'load:9-1' in the loaded case"):
        loaded.edit_element("load:9-1", "p_mw", 1.0)


def test_set_field_wrong_field_for_kind(loaded: SiennaState) -> None:
    with pytest.raises(ElementValidationError, match="in_service"):
        loaded.edit_element("branch:1-7-1", "p_mw", 1.0)


def test_set_field_bool_into_number(loaded: SiennaState) -> None:
    with pytest.raises(ElementValidationError, match="must be a number"):
        loaded.edit_element("load:7-1", "p_mw", True)
    with pytest.raises(ElementValidationError, match="must be a finite number"):
        loaded.edit_element("load:7-1", "p_mw", float("nan"))


def test_set_in_service_requires_bool(loaded: SiennaState) -> None:
    with pytest.raises(ElementValidationError, match="must be true or false"):
        loaded.edit_element("gen:1-1", "in_service", 1)


def test_add_load_takes_smallest_free_ordinal(loaded: SiennaState) -> None:
    loaded.add_element("load", {"bus": 7, "p_mw": 10.0, "q_mvar": 1.0})
    fake = _fake(loaded)
    sent = json.loads(fake.edits_sent[-1])
    assert sent[-1] == {"op": "add", "key": "load:7-2", "fields": {"bus": 7, "p_mw": 10.0, "q_mvar": 1.0}}
    loaded.add_element("load", {"bus": 7, "p_mw": 1.0, "q_mvar": 0.5})
    sent = json.loads(fake.edits_sent[-1])
    assert sent[-1]["key"] == "load:7-3"


def test_add_on_missing_bus(loaded: SiennaState) -> None:
    with pytest.raises(ElementValidationError, match=r"no bus 9 in the loaded case"):
        loaded.add_element("load", {"bus": 9, "p_mw": 1.0, "q_mvar": 1.0})


def test_add_missing_field(loaded: SiennaState) -> None:
    with pytest.raises(ElementValidationError, match="q_mvar"):
        loaded.add_element("load", {"bus": 7, "p_mw": 1.0})


def test_add_rejects_generator(loaded: SiennaState) -> None:
    with pytest.raises(ElementValidationError, match="only a load or a shunt can be added"):
        loaded.add_element("generator", {"bus": 7})


def test_remove_shunt(loaded: SiennaState) -> None:
    loaded.delete_element("shunt:7-1")
    fake = _fake(loaded)
    assert json.loads(fake.edits_sent[-1]) == [{"op": "remove", "key": "shunt:7-1", "name": "7-1"}]


def test_remove_branch_refused(loaded: SiennaState) -> None:
    with pytest.raises(
        ElementValidationError,
        match=r"only a load or a shunt can be removed; 'branch:1-7-1' is a line",
    ):
        loaded.delete_element("branch:1-7-1")


def test_undo_reloads_without_last_edit(loaded: SiennaState) -> None:
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.edit_element("load:7-1", "q_mvar", 50.0)
    fake = _fake(loaded)
    loads_before = len(fake.load_calls)
    loaded.undo_last_edit()
    assert len(fake.load_calls) == loads_before + 1
    assert json.loads(fake.edits_sent[-1]) == [
        {"op": "set", "key": "load:7-1", "name": "load71", "field": "p_mw", "value": 500.0}
    ]


def test_undo_empty(loaded: SiennaState) -> None:
    with pytest.raises(ElementValidationError, match="no edits to undo"):
        loaded.undo_last_edit()


def test_redo_reapplies(loaded: SiennaState) -> None:
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.edit_element("load:7-1", "q_mvar", 50.0)
    loaded.undo_last_edit()
    loaded.redo_edit()
    fake = _fake(loaded)
    assert len(json.loads(fake.edits_sent[-1])) == 2
    with pytest.raises(ElementValidationError, match="no edits to redo"):
        loaded.redo_edit()


def test_new_edit_clears_redo(loaded: SiennaState) -> None:
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.undo_last_edit()
    loaded.edit_element("load:7-1", "q_mvar", 50.0)
    with pytest.raises(ElementValidationError, match="no edits to redo"):
        loaded.redo_edit()


def test_failed_apply_rolls_log_back(loaded: SiennaState) -> None:
    fake = _fake(loaded)
    fake.fail_apply = True
    with pytest.raises(SiennaError, match="no such component"):
        loaded.edit_element("load:7-1", "p_mw", 500.0)
    assert loaded._edit_log == []  # noqa: SLF001


def test_reload_replays_log(loaded: SiennaState) -> None:
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.edit_element("gen:1-1", "in_service", False)
    fake = _fake(loaded)
    loads, sends = len(fake.load_calls), len(fake.edits_sent)
    loaded.reload_case()
    # The reload reads the file again and applies the whole log to it.
    assert len(fake.load_calls) == loads + 1
    assert len(fake.edits_sent) == sends + 1
    sent = json.loads(fake.edits_sent[-1])
    assert [row["op"] for row in sent] == ["set", "set"]
    assert sent[0]["field"] == "p_mw"
    assert sent[1]["field"] == "in_service"
    assert len(loaded._edit_log) == 2  # noqa: SLF001


def test_every_edit_rebuilds_from_the_file_with_the_whole_log(loaded: SiennaState) -> None:
    """The System is the case file with the log applied: each edit reads the
    file again and sends every edit so far, never the new one alone onto a
    System that already holds the others."""
    fake = _fake(loaded)
    loads = len(fake.load_calls)
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.edit_element("load:7-1", "q_mvar", 50.0)
    assert len(fake.load_calls) == loads + 2
    sent = json.loads(fake.edits_sent[-1])
    assert [(row["field"], row["value"]) for row in sent] == [("p_mw", 500.0), ("q_mvar", 50.0)]


def test_a_case_loaded_starts_a_new_log(loaded: SiennaState, workspace: Path) -> None:
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.edit_element("load:7-1", "q_mvar", 50.0)
    loaded.undo_last_edit()
    fake = _fake(loaded)
    sends = len(fake.edits_sent)
    loaded.load_case(workspace / "case.raw")
    # Nothing of the old log reaches the new case, and nothing is left to
    # undo or redo.
    assert len(fake.edits_sent) == sends
    assert loaded._edit_log == []  # noqa: SLF001
    with pytest.raises(ElementValidationError, match="no edits to undo"):
        loaded.undo_last_edit()
    with pytest.raises(ElementValidationError, match="no edits to redo"):
        loaded.redo_edit()


def test_an_edit_the_system_refuses_is_an_error_and_not_logged(loaded: SiennaState) -> None:
    loaded.edit_element("gen:1-1", "p_mw", 120.0)
    _fake(loaded).refuse_key = "load:7-1"
    with pytest.raises(ElementValidationError, match=r"refused the edit: load:7-1: no load named load71"):
        loaded.edit_element("load:7-1", "p_mw", 500.0)
    assert [op.key for op in loaded._edit_log] == ["gen:1-1"]  # noqa: SLF001


def test_an_edit_keeps_the_pending_disturbances_and_a_reload_drops_them(
    loaded: SiennaState,
) -> None:
    from tensa.core.disturbance import FaultSpec

    loaded.add_disturbance(FaultSpec(bus_idx=7, tf=1.0, tc=1.1, xf=0.01, rf=0.0))
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.undo_last_edit()
    loaded.redo_edit()
    assert len(loaded.list_disturbances()) == 1
    loaded.reload_case()
    assert loaded.list_disturbances() == []


def test_edit_clears_solved_state(loaded: SiennaState) -> None:
    loaded.run_pflow()
    assert loaded.operating_point().converged is True
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    point = loaded.operating_point()
    assert point.converged is False
    assert point.bus_voltages[7] == 1.0


def test_key_book_retains_removed_element(loaded: SiennaState) -> None:
    loaded.delete_element("shunt:7-1")
    assert loaded.keys().entry_of("shunt:7-1") is None
    loaded.add_element("shunt", {"bus": 7, "g_mw": 1.0, "b_mvar": 2.0})
    entry = loaded.keys().entry_of("shunt:7-1")
    assert entry is not None


def test_no_case(state: SiennaState) -> None:
    for call in (
        lambda: state.add_element("load", {"bus": 7, "p_mw": 1.0, "q_mvar": 1.0}),
        lambda: state.edit_element("load:7-1", "p_mw", 1.0),
        lambda: state.delete_element("load:7-1"),
        lambda: state.undo_last_edit(),
        lambda: state.redo_edit(),
    ):
        with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
            call()


# ---- the runtime's argument mapping -----------------------------------------


class _StateDouble:
    """Records the calls the handlers make."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []
        from tensa.engines.keys import KeyBook, KeyEntry

        book = KeyBook()
        book.assign(KeyEntry("load:7-1", "load", "PQ", "load71", "file"))
        book.assign(KeyEntry("branch:1-7-1", "line", "Line", "1-7-i_1", "file"))
        self._book = book

    def base_mva(self) -> float:
        return 100.0

    def keys(self) -> Any:
        return self._book

    def topology(self) -> Any:
        return _snapshot()

    def add_element(self, kind: str, fields: dict[str, Any]) -> Any:
        self.calls.append(("add", kind, fields))
        return _snapshot(with_added_load=True)

    def edit_element(self, key: str, field: str, value: Any) -> Any:
        self.calls.append(("edit", key, field, value))
        return _snapshot()

    def delete_element(self, key: str) -> Any:
        self.calls.append(("delete", key))
        return _snapshot()

    def undo_last_edit(self) -> Any:
        self.calls.append(("undo",))
        return _snapshot()

    def redo_edit(self) -> Any:
        self.calls.append(("redo",))
        return _snapshot()


def _snapshot(*, with_added_load: bool = False) -> Any:
    """The fixture's topology; with ``with_added_load``, with a second load on
    bus 7 as an add of one answers it."""
    from tensa.engines.keys import KeyBook
    from tensa.engines.sienna.convert import topology_snapshot

    topology = json.loads(json.dumps(_TOPOLOGY))
    if with_added_load:
        topology["loads"].append(
            {"name": "load7-2", "bus": 7, "id": "2", "sienna_type": "PowerLoad",
             "p_mw": 50.0, "q_mvar": 10.0, "available": True}
        )
    return topology_snapshot(topology, _REPORT, KeyBook())


def test_add_element_answers_the_added_entry() -> None:
    answer = _HANDLERS["add_element"](
        _StateDouble(), {"model": "PQ", "params": {"bus": 7, "p0": 0.5, "q0": 0.1}}
    )
    assert answer["idx"] == "load7-2"
    assert answer["kind"] == "PQ"


def test_delete_element_answers_what_went() -> None:
    answer = _HANDLERS["delete_element"](
        _StateDouble(), {"model": "PQ", "idx": "load71", "cascade": False}
    )
    assert [entry["idx"] for entry in answer["deleted"]] == ["load71"]
    assert answer["disturbances"] == []


def test_add_element_maps_pq_params() -> None:
    double = _StateDouble()
    _HANDLERS["add_element"](double, {"model": "PQ", "params": {"bus": 7, "p0": 0.5, "q0": 0.1, "u": 1}})
    assert double.calls == [("add", "load", {"bus": 7, "p_mw": 50.0, "q_mvar": 10.0, "in_service": True})]


def test_add_element_rejects_other_model() -> None:
    with pytest.raises(
        ElementValidationError,
        match=r"the Sienna engine adds a load or a shunt; got model 'GENROU'",
    ):
        _HANDLERS["add_element"](_StateDouble(), {"model": "GENROU", "params": {"bus": 7}})


def test_add_element_rejects_unknown_param() -> None:
    with pytest.raises(ElementValidationError, match="Vn"):
        _HANDLERS["add_element"](
            _StateDouble(), {"model": "PQ", "params": {"bus": 7, "p0": 0.5, "q0": 0.1, "Vn": 20.0}}
        )


def test_edit_element_maps_by_key() -> None:
    double = _StateDouble()
    _HANDLERS["edit_element"](double, {"model": "PQ", "idx": "load71", "params": {"p0": 0.5}})
    assert double.calls == [("edit", "load:7-1", "p_mw", 50.0)]


def test_edit_element_unknown_element() -> None:
    with pytest.raises(ElementNotFoundError, match=r"no PQ with idx='x'"):
        _HANDLERS["edit_element"](_StateDouble(), {"model": "PQ", "idx": "x", "params": {"p0": 0.5}})


def test_edit_element_one_field_only() -> None:
    with pytest.raises(ElementValidationError, match="one field at a time"):
        _HANDLERS["edit_element"](
            _StateDouble(), {"model": "PQ", "idx": "load71", "params": {"p0": 0.5, "q0": 0.1}}
        )


def test_edit_element_line_u() -> None:
    double = _StateDouble()
    _HANDLERS["edit_element"](double, {"model": "Line", "idx": "1-7-i_1", "params": {"u": 0}})
    assert double.calls == [("edit", "branch:1-7-1", "in_service", False)]


def test_delete_element_rejects_cascade() -> None:
    with pytest.raises(ElementValidationError, match="does not cascade a delete"):
        _HANDLERS["delete_element"](_StateDouble(), {"model": "PQ", "idx": "load71", "cascade": True})


def test_delete_element_maps_by_key() -> None:
    double = _StateDouble()
    _HANDLERS["delete_element"](double, {"model": "PQ", "idx": "load71", "cascade": False})
    assert double.calls == [("delete", "load:7-1")]


def test_undo_redo_handlers() -> None:
    double = _StateDouble()
    _HANDLERS["undo_last_edit"](double, {})
    _HANDLERS["redo_edit"](double, {})
    assert double.calls == [("undo",), ("redo",)]
