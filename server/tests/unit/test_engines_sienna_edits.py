"""Unit tests of ``SiennaState``'s edit methods and the runtime's argument
mapping, with a fake bridge. No Julia.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tensa.core.edit_log import EditStep
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
    """Records calls and answers the fixed JSON above, with the edits it is
    sent applied: the System it reports is the case file with the log applied,
    as the Julia module's is. An add names its element as the Julia side does
    (a load ``load<bus>-<id>``, a shunt ``<bus>-<id>``, with ``id`` the
    ordinal the key carries)."""

    def __init__(self) -> None:
        self.started = True
        self.load_calls: list[Path] = []
        self.edits_sent: list[str] = []
        self.fail_apply = False
        # A key whose edits the System refuses, as the Julia module answers one.
        self.refuse_key: str | None = None
        self._loads: list[dict[str, Any]] = []
        self._shunts: list[dict[str, Any]] = []

    def load_case(self, raw: Path, dyr: Any, scratch: Path, v_setpoints: Any, corrections: Any) -> Any:
        self.load_calls.append(raw)
        base = json.loads(json.dumps(_TOPOLOGY))
        self._loads = base["loads"]
        self._shunts = base["shunts"]
        return {"case": raw.stem}

    def report(self, session: Any) -> dict[str, Any]:
        return dict(_REPORT)

    def topology(self, session: Any) -> dict[str, Any]:
        topology = json.loads(json.dumps(_TOPOLOGY))
        topology["loads"] = json.loads(json.dumps(self._loads))
        topology["shunts"] = json.loads(json.dumps(self._shunts))
        return topology

    def _apply_add(self, op: dict[str, Any]) -> None:
        kind, _, rest = op["key"].partition(":")
        bus, _, ordinal = rest.partition("-")
        fields = op["fields"]
        if kind == "load":
            self._loads.append(
                {"name": f"load{bus}-{ordinal}", "bus": int(bus), "id": ordinal,
                 "sienna_type": "PowerLoad", "p_mw": fields.get("p_mw", 0.0),
                 "q_mvar": fields.get("q_mvar", 0.0), "available": True}
            )
        else:
            self._shunts.append(
                {"name": f"{bus}-{ordinal}", "bus": int(bus), "order": int(ordinal),
                 "kind": "fixed", "sienna_type": "FixedAdmittance",
                 "g_mw": fields.get("g_mw", 0.0), "b_mvar": fields.get("b_mvar", 0.0),
                 "available": True}
            )

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
        applied = [op for op in ops if op["key"] != self.refuse_key]
        for op in applied:
            if op["op"] == "add":
                self._apply_add(op)
            elif op["op"] == "remove":
                self._loads = [row for row in self._loads if row["name"] != op["name"]]
                self._shunts = [row for row in self._shunts if row["name"] != op["name"]]
        return {"applied": applied, "refused": refused}

    def pflow(self, session: Any, tolerance: Any = None, max_iterations: Any = None) -> dict[str, Any]:
        return dict(_PFLOW)


# A minimal PSS/E v33 file. Only its path and suffix matter: the readers the
# state's load calls (read_identity, read_case_facts, corrections_document)
# are faked by the file_identity fixture below, which supplies the file ids
# the key assignment matches against, so a file element's key has source
# "file" and an added one "ordinal".
_CASE_RAW = """0, 100.0, 33, 0, 0, 60.0
TENSA test case
two buses
third comment line
1,'BUS1',20.0,3,1,1,1,1.0,0.0
7,'BUS7',230.0,1,1,1,1,1.0,0.0
0 /
7,'1',50.0,10.0,1,1,1,1,1
0 /
7,'1',0.0,20.0
0 /
1,'1',100.0,0.0,999.0,-999.0,1.0,0,100.0,0.0,1.0,0.0,0.0,1.0,1,100.0,999.0,-999.0,1,1.0
0 /
1,7,'1',0.01,0.1,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,1,1,0.0,1,1.0
0 /
0 /
0 /
0 /
0 /
0 /
0 /
0 /
0 /
0 /
0 /
0 /
0 /
0 /
Q
"""


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "case.raw").write_text(_CASE_RAW)
    return ws


@pytest.fixture
def state(workspace: Path) -> SiennaState:
    return SiennaState(str(workspace), "s1", None, bridge=FakeBridge())


@pytest.fixture
def file_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fake the three case-file readers the state's load calls.

    The raw file above is only a path with a ``.raw`` suffix; what the key
    assignment matches against is the identity this fixture hands
    ``read_identity``: one load id "1" on bus 7, one fixed shunt id "1" on
    bus 7, one generator id "1" on bus 1 and one branch 1-7 ckt "1", as a
    MATPOWER case (no by-id fallback, the shape the review's reproduction
    needs). ``corrections_document`` answers an empty document.
    """
    from tensa.engines.identity import BranchId, CaseIdentity, DeviceId

    identity = CaseIdentity(
        format="matpower",
        version=None,
        base_mva=100.0,
        freq_hz=60.0,
        buses=(1, 7),
        isolated_buses=(),
        swing_buses=(),
        loads=(DeviceId(7, "1"),),
        fixed_shunts=(DeviceId(7, "1"),),
        switched_shunts=(),
        generators=(DeviceId(1, "1"),),
        branches=(BranchId(1, 7, "1", transformer=False),),
        transformers3=(),
        area_slack_buses={},
        counts={},
        unread_blocks=(),
    )
    document = {
        "v_setpoints": {},
        "transformers": [],
        "line_charging": [],
        "transformer_charging": [],
        "notes": [],
    }
    monkeypatch.setattr(
        "tensa.engines.sienna.state.read_identity", lambda path: identity
    )
    monkeypatch.setattr(
        "tensa.engines.sienna.state.read_case_facts", lambda path: {}
    )
    monkeypatch.setattr(
        "tensa.engines.sienna.state.corrections_document", lambda facts: document
    )


@pytest.fixture
def loaded(state: SiennaState, workspace: Path, file_identity: None) -> SiennaState:
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


def test_file_element_keeps_its_key_through_add_delete_and_undo(
    loaded: SiennaState,
) -> None:
    """The review's reproduction through the state's own edit methods: add a
    load on bus 7 (load:7-2), delete the file load (load:7-1), undo the
    delete. The file load must be load:7-1 again and the added one still
    load:7-2 (spec section 13: a key never changes within a session)."""
    assert loaded.keys().key_of("PQ", "load71") == "load:7-1"
    loaded.add_element("load", {"bus": 7, "p_mw": 10.0, "q_mvar": 1.0})
    assert loaded.keys().entry_of("load:7-2") is not None
    loaded.delete_element("load:7-1")
    assert loaded.keys().entry_of("load:7-1") is None
    loaded.undo_last_edit()
    book = loaded.keys()
    entry = book.entry_of("load:7-1")
    assert entry is not None
    assert (entry.model, str(entry.idx)) == ("PQ", "load71")
    assert entry.source == "file"
    added = book.entry_of("load:7-2")
    assert added is not None
    assert added.source == "ordinal"


def test_file_shunt_keeps_its_key_through_add_delete_and_undo(
    loaded: SiennaState,
) -> None:
    """The shunt of the same shape, through the state's edit methods."""
    assert loaded.keys().key_of("Shunt", "7-1") == "shunt:7-1"
    loaded.add_element("shunt", {"bus": 7, "g_mw": 1.0, "b_mvar": 2.0})
    assert loaded.keys().entry_of("shunt:7-2") is not None
    loaded.delete_element("shunt:7-1")
    assert loaded.keys().entry_of("shunt:7-1") is None
    loaded.undo_last_edit()
    book = loaded.keys()
    entry = book.entry_of("shunt:7-1")
    assert entry is not None
    assert (entry.model, str(entry.idx)) == ("Shunt", "7-1")
    assert book.entry_of("shunt:7-2") is not None


def test_redo_of_an_add_keeps_the_added_elements_key(loaded: SiennaState) -> None:
    """Add a load, undo the add, redo it: the added load is load:7-2 again,
    and the file load is load:7-1 throughout."""
    loaded.add_element("load", {"bus": 7, "p_mw": 10.0, "q_mvar": 1.0})
    loaded.undo_last_edit()
    assert loaded.keys().entry_of("load:7-2") is None
    loaded.redo_edit()
    book = loaded.keys()
    added = book.entry_of("load:7-2")
    assert added is not None
    assert added.source == "ordinal"
    file_entry = book.entry_of("load:7-1")
    assert file_entry is not None
    assert (file_entry.model, str(file_entry.idx)) == ("PQ", "load71")


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


# ---- the undo and redo a topology names (as an ANDES topology does) ----


def test_a_fresh_case_has_nothing_to_undo_or_redo(loaded: SiennaState) -> None:
    topology = loaded.topology()
    assert topology.undo is None
    assert topology.redo is None


def test_an_edit_is_named_by_model_idx_and_andes_param(loaded: SiennaState) -> None:
    answered = loaded.edit_element("load:7-1", "p_mw", 500.0)
    expected = EditStep(op="edit", model="PQ", idx="load71", params=("p0",))
    assert answered.undo == expected
    assert answered.redo is None
    assert loaded.topology().undo == expected


def test_undo_and_redo_move_the_steps(loaded: SiennaState) -> None:
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.edit_element("load:7-1", "q_mvar", 50.0)
    after_undo = loaded.undo_last_edit()
    assert after_undo.undo == EditStep(op="edit", model="PQ", idx="load71", params=("p0",))
    assert after_undo.redo == EditStep(op="edit", model="PQ", idx="load71", params=("q0",))
    after_redo = loaded.redo_edit()
    assert after_redo.undo == EditStep(op="edit", model="PQ", idx="load71", params=("q0",))
    assert after_redo.redo is None


def test_a_delete_names_the_element_it_took_out(loaded: SiennaState) -> None:
    answered = loaded.delete_element("shunt:7-1")
    assert answered.undo is not None
    assert answered.undo.op == "delete"
    assert answered.undo.model == "Shunt"
    assert answered.undo.idx == "7-1"
    undone = loaded.undo_last_edit()
    assert undone.undo is None
    assert undone.redo is not None and undone.redo.op == "delete"
