"""Unit tests for ``tensa.engines.sienna.keys.assign_sienna_keys`` (unit P4-C2).

The central contract: for each of the nine recorded cases the keys the Sienna
topology JSON gets are the keys ``assign_andes_keys`` gives the same file, so
the two engines name every static element of a case the same. ANDES is used
only as the reference; the tests fail when its case files are missing.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from tensa.core.examples import _andes_cases_dir
from tensa.engines.andes.keys import assign_andes_keys
from tensa.engines.identity import BranchId, CaseIdentity, DeviceId, read_identity
from tensa.engines.keys import KeyBook
from tensa.engines.roles import role_of_model
from tensa.engines.sienna.keys import assign_sienna_keys

SAMPLES = Path(__file__).resolve().parent / "sienna_samples"

# case name -> (raw file relative to the ANDES cases dir, dyr file or None)
CASES: dict[str, tuple[str, str | None]] = {
    "kundur": ("kundur/kundur.raw", None),
    "kundur_dyr": ("kundur/kundur.raw", "kundur/kundur_full.dyr"),
    "ieee14": ("ieee14/ieee14.raw", None),
    "ieee14_dyr": ("ieee14/ieee14.raw", "ieee14/ieee14.dyr"),
    "ieee39": ("ieee39/ieee39.raw", None),
    "wscc9": ("wscc9/wscc9.raw", None),
    "npcc": ("npcc/npcc.raw", None),
    "wecc": ("wecc/wecc.raw", None),
    "case14_m": ("matpower/case14.m", None),
}

CASE_NAMES = tuple(CASES)


def _sample(name: str, kind: str) -> dict[str, Any]:
    path = SAMPLES / f"{name}.{kind}.json"
    document: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return document


def _case_path(name: str) -> Path:
    cases_dir = _andes_cases_dir()
    assert cases_dir is not None, "ANDES cases folder not found"
    path = Path(cases_dir) / CASES[name][0]
    assert path.is_file(), f"ANDES case file missing: {CASES[name][0]}"
    return path


def _andes_book(name: str) -> KeyBook:
    """The keys ANDES gives the case, loaded pre-setup with its dyr if any."""
    import andes

    andes.config_logger(stream_level=50)
    raw = _case_path(name)
    dyr = CASES[name][1]
    addfile = None
    if dyr is not None:
        cases_dir = _andes_cases_dir()
        assert cases_dir is not None
        addfile = str(Path(cases_dir) / dyr)
        assert Path(addfile).is_file(), f"ANDES case file missing: {dyr}"
    ss = andes.load(
        str(raw), setup=False, no_output=True, default_config=True, addfile=addfile
    )
    return assign_andes_keys(ss, read_identity(raw))


def _bucket_keys(book: KeyBook, *buckets: str) -> set[str]:
    return {entry.key for entry in book.entries() if entry.bucket in buckets}


def _static_generator_keys(book: KeyBook) -> set[str]:
    """The ``gen:<bus>-<id>`` keys of the book, without the unit model keys."""
    return {
        entry.key
        for entry in book.entries()
        if entry.bucket == "generator" and "/" not in entry.key
    }


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_static_keys_match_andes(name: str) -> None:
    topology = _sample(name, "topology")
    identity = read_identity(_case_path(name))
    sienna = assign_sienna_keys(topology, identity)
    andes_book = _andes_book(name)

    assert _bucket_keys(sienna, "bus") == _bucket_keys(andes_book, "bus")
    assert _bucket_keys(sienna, "line", "transformer") == _bucket_keys(
        andes_book, "line", "transformer"
    )
    assert _static_generator_keys(sienna) == _static_generator_keys(andes_book)
    assert _bucket_keys(sienna, "load") == _bucket_keys(andes_book, "load")
    assert _bucket_keys(sienna, "shunt") == _bucket_keys(andes_book, "shunt")


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_no_tilde_and_no_problems(name: str) -> None:
    topology = _sample(name, "topology")
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    assert all("~" not in entry.key for entry in book.entries())
    assert book.problems == []


@pytest.mark.unit
@pytest.mark.parametrize("name", ("wecc", "kundur"))
def test_parallel_circuits_keep_their_ids(name: str) -> None:
    topology = _sample(name, "topology")
    identity = read_identity(_case_path(name))
    book = assign_sienna_keys(topology, identity)
    records: dict[tuple[int, int, str], BranchId] = {}
    for branch in identity.branches:
        records[(min(branch.from_bus, branch.to_bus), max(branch.from_bus, branch.to_bus), branch.ckt)] = branch
    for row in topology["branches"]:
        entry = book.entry_of(book.key_of("Line", str(row["name"])) or "")
        assert entry is not None
        assert entry.source == "file"
        record = records[
            (min(row["from"], row["to"]), max(row["from"], row["to"]), row["ckt"])
        ]
        assert entry.key == f"branch:{record.from_bus}-{record.to_bus}-{record.ckt}"
        assert entry.key.endswith(f"-{row['ckt']}")


@pytest.mark.unit
def test_matpower_row_numbers_become_file_circuits() -> None:
    topology = _sample("case14_m", "topology")
    identity = read_identity(_case_path("case14_m"))
    book = assign_sienna_keys(topology, identity)
    # The second branch row, from bus 1 to bus 5, is the first record of its
    # pair in the file: branch:1-5-1, not the row number 2.
    second = topology["branches"][1]
    assert (second["from"], second["to"], second["ckt"]) == (1, 5, "2")
    assert book.key_of("Line", str(second["name"])) == "branch:1-5-1"
    for row in topology["branches"]:
        entry = book.entry_of(book.key_of("Line", str(row["name"])) or "")
        assert entry is not None
        assert entry.source == "file"
    # Generators and loads get the identity's ids (ordinals per bus, "1").
    assert book.key_of("Slack", "gen-1") == "gen:1-1"
    assert book.key_of("PV", "gen-2") == "gen:2-1"
    assert book.key_of("PQ", "bus2") == "load:2-1"
    assert book.key_of("PQ", "bus14") == "load:14-1"


@pytest.mark.unit
@pytest.mark.parametrize("name", ("kundur_dyr", "ieee14_dyr"))
def test_dynamic_keys_match_andes_on_common_models(name: str) -> None:
    topology = _sample(name, "topology")
    book = assign_sienna_keys(topology, read_identity(_case_path(name)))
    andes_book = _andes_book(name)

    # The ANDES book's dynamic keys: gen:<bus>-<id>/<role>, or qualified with
    # the model name (gen:<bus>-<id>/<role>:<MODEL>) for a second model of one
    # role on a unit. Map (unit key, model name) to the key of the first entry
    # ANDES holds for it, which is the one the Sienna key must equal.
    andes_by_unit_model: dict[tuple[str, str], str] = {}
    for entry in andes_book.entries():
        if entry.bucket == "dynamic" and "/" in entry.key:
            unit = entry.key.split("/", 1)[0]
            andes_by_unit_model.setdefault((unit, entry.model), entry.key)

    common_machine = 0
    common_governor = 0
    for row in topology["dynamics"]:
        model = row["model"]
        idx = f"{row['generator']}/{model}"
        key = book.key_of(model, idx)
        assert key is not None
        role = role_of_model(model)
        unit = key.split("/", 1)[0]
        assert key == f"{unit}/{role}"
        assert unit.startswith("gen:")
        andes_key = andes_by_unit_model.get((unit, model))
        if andes_key is not None:
            assert key == andes_key
            if role == "machine":
                common_machine += 1
            elif role == "governor":
                common_governor += 1
    assert common_machine >= 1
    assert common_governor >= 1


def _identity(
    buses: tuple[int, ...] = (),
    loads: tuple[DeviceId, ...] = (),
    fixed_shunts: tuple[DeviceId, ...] = (),
    switched_shunts: tuple[DeviceId, ...] = (),
    generators: tuple[DeviceId, ...] = (),
    branches: tuple[BranchId, ...] = (),
    format: str = "psse-raw",
) -> CaseIdentity:
    return CaseIdentity(
        format=format,
        version=33 if format == "psse-raw" else None,
        base_mva=100.0,
        freq_hz=60.0,
        buses=buses,
        isolated_buses=(),
        swing_buses=(),
        loads=loads,
        fixed_shunts=fixed_shunts,
        switched_shunts=switched_shunts,
        generators=generators,
        branches=branches,
        transformers3=(),
        area_slack_buses={},
        counts={},
        unread_blocks=(),
    )


def _topology(
    buses: list[int],
    branches: list[Mapping[str, Any]],
    shunts: list[Mapping[str, Any]] | None = None,
    loads: list[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "base_mva": 100.0,
        "freq_hz": 60.0,
        "buses": [
            {"number": n, "name": str(n), "vn_kv": 20.0, "type": "PQ",
             "v_pu": 1.0, "angle_rad": 0.0, "available": True}
            for n in buses
        ],
        "branches": list(branches),
        "generators": [],
        "loads": list(loads or []),
        "shunts": list(shunts or []),
        "dynamics": [],
    }


def _branch(name: str, from_bus: int, to_bus: int, ckt: str) -> dict[str, Any]:
    return {
        "name": name, "from": from_bus, "to": to_bus, "ckt": ckt,
        "kind": "line", "sienna_type": "Line", "r_pu": 0.01, "x_pu": 0.1,
        "b_pu": 0.0, "tap": 1.0, "shift_rad": 0.0, "rate_mva": None,
        "available": True,
    }


@pytest.mark.unit
def test_branch_past_identity_records_gets_ordinal_and_one_note() -> None:
    topology = _topology(
        [7, 8],
        [_branch("a", 7, 8, "1"), _branch("b", 7, 8, "2")],
    )
    identity = _identity(
        buses=(7, 8),
        branches=(BranchId(7, 8, "1", transformer=False),),
    )
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Line", "a") == "branch:7-8-1"
    assert book.key_of("Line", "b") == "branch:7-8-2"
    entries = {
        str(entry.idx): entry for entry in book.entries() if entry.model == "Line"
    }
    assert entries["a"].source == "file"
    assert entries["b"].source == "ordinal"
    assert len(book.problems) == 1
    assert "1 branch(es)" in book.problems[0]


@pytest.mark.unit
def test_identity_none_uses_the_jsons_own_ids() -> None:
    topology = _topology(
        [7, 8],
        [_branch("a", 8, 7, "X")],
        shunts=[
            {"name": "s1", "bus": 7, "order": 1, "kind": "fixed",
             "sienna_type": "FixedAdmittance", "g_mw": 0.0, "b_mvar": 10.0,
             "available": True},
        ],
    )
    book = assign_sienna_keys(topology, None)
    entry = book.entry_of("branch:8-7-X")
    assert entry is not None
    assert entry.source == "engine"
    assert entry.bucket == "line"
    shunt = book.entry_of("shunt:7-1")
    assert shunt is not None
    assert shunt.source == "engine"
    assert book.problems == []


@pytest.mark.unit
def test_two_shunts_where_the_identity_has_one() -> None:
    topology = _topology(
        [7],
        [],
        shunts=[
            {"name": "s1", "bus": 7, "order": 1, "kind": "fixed",
             "sienna_type": "FixedAdmittance", "g_mw": 0.0, "b_mvar": 10.0,
             "available": True},
            {"name": "s2", "bus": 7, "order": 2, "kind": "switched",
             "sienna_type": "SwitchedAdmittance", "g_mw": 0.0, "b_mvar": 20.0,
             "available": True},
        ],
    )
    identity = _identity(
        buses=(7,),
        fixed_shunts=(DeviceId(7, "F"),),
    )
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Shunt", "s1") == "shunt:7-F"
    assert book.key_of("Shunt", "s2") == "shunt:7-1"
    entries = {
        str(entry.idx): entry for entry in book.entries() if entry.model == "Shunt"
    }
    assert entries["s1"].source == "file"
    assert entries["s2"].source == "ordinal"
    assert len(book.problems) == 1
    assert "1 shunt(s)" in book.problems[0]


def _shunt(name: str, bus: int, order: int, kind: str) -> dict[str, Any]:
    return {
        "name": name, "bus": bus, "order": order, "kind": kind,
        "sienna_type": "SwitchedAdmittance" if kind == "switched" else "FixedAdmittance",
        "g_mw": 0.0, "b_mvar": 10.0, "available": True,
    }


def _load(name: str, bus: int, id: str) -> dict[str, Any]:
    return {
        "name": name, "bus": bus, "id": id, "sienna_type": "PowerLoad",
        "p_mw": 10.0, "q_mvar": 1.0, "available": True,
    }


@pytest.mark.unit
def test_branch_beyond_the_records_of_a_pair_with_none_matching() -> None:
    # Neither JSON circuit is the file's, and the counts differ: each branch
    # takes the first circuit of the pair that the file does not give (1 is
    # the file's) and no branch holds, in the bus order the file gives the
    # pair, not the JSON's.
    topology = _topology([7, 8], [_branch("a", 8, 7, "X"), _branch("b", 8, 7, "Y")])
    identity = _identity(buses=(7, 8), branches=(BranchId(7, 8, "1", transformer=False),))
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Line", "a") == "branch:7-8-2"
    assert book.key_of("Line", "b") == "branch:7-8-3"
    assert all(entry.source == "ordinal" for entry in book.entries() if entry.model == "Line")
    assert book.problems == [
        "2 branch(es) of the Sienna topology matched no branch record of the "
        "case file; circuits assigned by ordinal"
    ]


@pytest.mark.unit
def test_extra_parallel_branch_is_written_in_the_files_bus_order() -> None:
    # The file gives 8-7 circuit 1; the JSON has that branch the other way
    # round and one more: the extra one is written as the corridor is.
    topology = _topology([7, 8], [_branch("b", 7, 8, "2"), _branch("a", 7, 8, "1")])
    identity = _identity(buses=(7, 8), branches=(BranchId(8, 7, "1", transformer=False),))
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Line", "a") == "branch:8-7-1"
    assert book.key_of("Line", "b") == "branch:8-7-2"


@pytest.mark.unit
def test_parallel_circuits_matched_by_id_not_by_place() -> None:
    # The JSON lists circuit 2 before circuit 1 and the file the other way
    # round, each in its own bus order: every branch takes its own record.
    topology = _topology([7, 8], [_branch("two", 8, 7, "2"), _branch("one", 7, 8, "1")])
    identity = _identity(
        buses=(7, 8),
        branches=(
            BranchId(7, 8, "1", transformer=False),
            BranchId(8, 7, "2", transformer=False),
        ),
    )
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Line", "one") == "branch:7-8-1"
    assert book.key_of("Line", "two") == "branch:8-7-2"
    assert book.problems == []


@pytest.mark.unit
def test_matpower_row_numbers_are_ordered_as_numbers() -> None:
    # Rows 10 and 2 of a MATPOWER branch matrix on one pair: row 2 comes first
    # in the file, so it is circuit 1, though "10" sorts first as text.
    topology = _topology(
        [1, 2], [_branch("row10", 2, 1, "10"), _branch("row2", 1, 2, "2")]
    )
    identity = _identity(
        buses=(1, 2),
        branches=(
            BranchId(1, 2, "1", transformer=False),
            BranchId(2, 1, "2", transformer=False),
        ),
        format="matpower",
    )
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Line", "row2") == "branch:1-2-1"
    assert book.key_of("Line", "row10") == "branch:2-1-2"
    assert book.problems == []


@pytest.mark.unit
def test_matpower_row_number_is_no_circuit_id() -> None:
    # A MATPOWER pair with more JSON rows than records: a row number that
    # equals a circuit the file gives is not matched by it; all are ordinals.
    topology = _topology([1, 2], [_branch("r1", 1, 2, "1"), _branch("r5", 1, 2, "5")])
    identity = _identity(
        buses=(1, 2), branches=(BranchId(1, 2, "1", transformer=False),), format="matpower"
    )
    book = assign_sienna_keys(topology, identity)
    sources = {str(entry.idx): entry.source for entry in book.entries() if entry.model == "Line"}
    assert sources == {"r1": "ordinal", "r5": "ordinal"}
    assert {book.key_of("Line", "r1"), book.key_of("Line", "r5")} == {
        "branch:1-2-2",
        "branch:1-2-3",
    }


@pytest.mark.unit
def test_shunts_fixed_before_switched_whatever_their_order() -> None:
    # PowerSystems numbered the switched shunt first; the file lists the
    # fixed one first, and the switched one takes the first ordinal its bus
    # leaves free (decision 28).
    topology = _topology(
        [7], [], shunts=[_shunt("sw", 7, 1, "switched"), _shunt("fx", 7, 2, "fixed")]
    )
    identity = _identity(
        buses=(7,), fixed_shunts=(DeviceId(7, "A"),), switched_shunts=(DeviceId(7, "1"),)
    )
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Shunt", "fx") == "shunt:7-A"
    assert book.key_of("Shunt", "sw") == "shunt:7-1"
    assert book.problems == []


@pytest.mark.unit
def test_second_switched_shunt_takes_the_first_free_ordinal() -> None:
    # The file has a fixed shunt with id 1 and a switched one (id 2, the first
    # ordinal after the fixed ids); the JSON has one switched shunt more.
    topology = _topology(
        [7],
        [],
        shunts=[
            _shunt("fx", 7, 1, "fixed"),
            _shunt("sw1", 7, 2, "switched"),
            _shunt("sw2", 7, 3, "switched"),
        ],
    )
    identity = _identity(
        buses=(7,), fixed_shunts=(DeviceId(7, "1"),), switched_shunts=(DeviceId(7, "2"),)
    )
    book = assign_sienna_keys(topology, identity)
    assert book.key_of("Shunt", "fx") == "shunt:7-1"
    assert book.key_of("Shunt", "sw1") == "shunt:7-2"
    assert book.key_of("Shunt", "sw2") == "shunt:7-3"
    assert all("~" not in entry.key for entry in book.entries())
    assert book.problems == [
        "1 shunt(s) of the Sienna topology matched no record of the case file; "
        "ids assigned by ordinal"
    ]


def _rekey_after(
    book: KeyBook,
    identity: CaseIdentity,
    loads: list[Mapping[str, Any]],
    shunts: list[Mapping[str, Any]] | None = None,
) -> KeyBook:
    """Key a topology of bus 7 with the given loads and shunts against the
    book, as the state does across a rebuild: the book keeps the entries of
    the handles the topology lists plus the ones the edit log added, minus
    the ones it removed (``SiennaState``'s retain)."""
    topology = _topology([7], [], shunts=shunts, loads=loads)
    book = assign_sienna_keys(topology, identity, book)
    handles = {
        ("PQ", str(row["name"])) for row in topology["loads"]
    } | {("Shunt", str(row["name"])) for row in topology["shunts"]}
    book.retain(handles)
    return book


@pytest.mark.unit
def test_file_load_keeps_its_key_through_delete_and_undo_matpower() -> None:
    # The reproduction of the review: bus 7 has one load from the file, keyed
    # load:7-1. A PQ added on bus 7 is load:7-2. Delete load:7-1, then undo:
    # the rebuild lists the file load and the added one, the book holds the
    # added one's key only, and the file load must take load:7-1 back, not an
    # ordinal. A MATPOWER case has no by-id fallback, so before the fix the
    # counts (2 items, 1 file id) sent it to load:7-3.
    identity = _identity(buses=(7,), loads=(DeviceId(7, "1"),), format="matpower")
    book = assign_sienna_keys(
        _topology([7], [], loads=[_load("bus7", 7, "1")]), identity
    )
    assert book.key_of("PQ", "bus7") == "load:7-1"
    # The add: the topology lists both loads, the added one takes load:7-2.
    book = _rekey_after(
        book, identity, [_load("bus7", 7, "1"), _load("load7-2", 7, "2")]
    )
    assert book.key_of("PQ", "load7-2") == "load:7-2"
    # The delete: the topology lists the added load alone; the book drops the
    # file load's entry.
    book = _rekey_after(book, identity, [_load("load7-2", 7, "2")])
    assert book.entry_of("load:7-1") is None
    # The undo: the file load is back and must be load:7-1 again.
    book = _rekey_after(
        book, identity, [_load("bus7", 7, "1"), _load("load7-2", 7, "2")]
    )
    assert book.key_of("PQ", "bus7") == "load:7-1"
    assert book.key_of("PQ", "load7-2") == "load:7-2"
    assert all("~" not in entry.key for entry in book.entries())


@pytest.mark.unit
def test_file_load_keeps_its_key_through_delete_and_undo_psse() -> None:
    # The same sequence on a PSS/E case, whose by-id fallback already gave
    # load:7-1 back; the fix must not change that.
    identity = _identity(buses=(7,), loads=(DeviceId(7, "1"),))
    book = assign_sienna_keys(
        _topology([7], [], loads=[_load("load71", 7, "1")]), identity
    )
    book = _rekey_after(
        book, identity, [_load("load71", 7, "1"), _load("load7-2", 7, "2")]
    )
    assert book.key_of("PQ", "load7-2") == "load:7-2"
    book = _rekey_after(book, identity, [_load("load7-2", 7, "2")])
    book = _rekey_after(
        book, identity, [_load("load71", 7, "1"), _load("load7-2", 7, "2")]
    )
    assert book.key_of("PQ", "load71") == "load:7-1"
    assert book.key_of("PQ", "load7-2") == "load:7-2"


@pytest.mark.unit
def test_file_shunt_keeps_its_key_through_delete_and_undo_matpower() -> None:
    # The shunt of the same shape: one fixed shunt from the file, one added,
    # the file one deleted and put back by an undo.
    identity = _identity(
        buses=(7,), fixed_shunts=(DeviceId(7, "1"),), format="matpower"
    )
    book = assign_sienna_keys(
        _topology([7], [], shunts=[_shunt("7-1", 7, 1, "fixed")]), identity
    )
    assert book.key_of("Shunt", "7-1") == "shunt:7-1"
    book = _rekey_after(
        book,
        identity,
        [],
        [_shunt("7-1", 7, 1, "fixed"), _shunt("7-2", 7, 2, "fixed")],
    )
    assert book.key_of("Shunt", "7-2") == "shunt:7-2"
    book = _rekey_after(book, identity, [], [_shunt("7-2", 7, 2, "fixed")])
    assert book.entry_of("shunt:7-1") is None
    book = _rekey_after(
        book,
        identity,
        [],
        [_shunt("7-1", 7, 1, "fixed"), _shunt("7-2", 7, 2, "fixed")],
    )
    assert book.key_of("Shunt", "7-1") == "shunt:7-1"
    assert book.key_of("Shunt", "7-2") == "shunt:7-2"


@pytest.mark.unit
def test_add_after_delete_and_undo_takes_a_fresh_ordinal() -> None:
    # After the delete and the undo, bus 7 holds load:7-1 (file) and
    # load:7-2 (added). A load added now takes load:7-3, the first ordinal no
    # element of the book holds, and the two present throughout keep theirs.
    identity = _identity(buses=(7,), loads=(DeviceId(7, "1"),), format="matpower")
    book = assign_sienna_keys(
        _topology([7], [], loads=[_load("bus7", 7, "1")]), identity
    )
    book = _rekey_after(
        book, identity, [_load("bus7", 7, "1"), _load("load7-2", 7, "2")]
    )
    book = _rekey_after(book, identity, [_load("load7-2", 7, "2")])
    book = _rekey_after(
        book, identity, [_load("bus7", 7, "1"), _load("load7-2", 7, "2")]
    )
    book = _rekey_after(
        book,
        identity,
        [_load("bus7", 7, "1"), _load("load7-2", 7, "2"), _load("load7-3", 7, "3")],
    )
    assert book.key_of("PQ", "bus7") == "load:7-1"
    assert book.key_of("PQ", "load7-2") == "load:7-2"
    assert book.key_of("PQ", "load7-3") == "load:7-3"
    assert all("~" not in entry.key for entry in book.entries())


@pytest.mark.unit
def test_redo_of_an_add_keeps_the_added_elements_key() -> None:
    # Delete the file load, then redo the add of load:7-2 (which the undo of
    # the add had taken back): the added element takes the key it had, and the
    # file load keeps its own throughout.
    identity = _identity(buses=(7,), loads=(DeviceId(7, "1"),), format="matpower")
    book = assign_sienna_keys(
        _topology([7], [], loads=[_load("bus7", 7, "1")]), identity
    )
    book = _rekey_after(
        book, identity, [_load("bus7", 7, "1"), _load("load7-2", 7, "2")]
    )
    # Undo of the add: the added load leaves the topology and the book.
    book = _rekey_after(book, identity, [_load("bus7", 7, "1")])
    assert book.entry_of("load:7-2") is None
    # Redo of the add: it is back, under the key it had.
    book = _rekey_after(
        book, identity, [_load("bus7", 7, "1"), _load("load7-2", 7, "2")]
    )
    assert book.key_of("PQ", "bus7") == "load:7-1"
    assert book.key_of("PQ", "load7-2") == "load:7-2"


@pytest.mark.unit
def test_added_load_takes_the_smallest_free_ordinal() -> None:
    # Decision 28: the only load of bus 7 has id 2 in the file. A load added
    # later on that bus takes 1, the keyed load keeps its key, and an element
    # added to a keyed case is no problem of the file.
    identity = _identity(buses=(7,), loads=(DeviceId(7, "2"),))
    book = assign_sienna_keys(_topology([7], [], loads=[_load("L2", 7, "2")]), identity)
    assert book.key_of("PQ", "L2") == "load:7-2"
    later = _topology([7], [], loads=[_load("L2", 7, "2"), _load("new", 7, "7")])
    book = assign_sienna_keys(later, identity, book)
    assert book.key_of("PQ", "L2") == "load:7-2"
    assert book.key_of("PQ", "new") == "load:7-1"
    assert book.problems == []


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_deterministic_and_inputs_untouched(name: str) -> None:
    topology = _sample(name, "topology")
    identity = read_identity(_case_path(name))
    before = copy.deepcopy(topology)
    first = assign_sienna_keys(topology, identity)
    second = assign_sienna_keys(topology, identity)
    assert first.entries() == second.entries()
    assert first.problems == second.problems == []
    assert topology == before
    again = assign_sienna_keys(topology, identity, first)
    assert again.entries() == second.entries()
    assert again.problems == []


@pytest.mark.unit
def test_second_call_changes_nothing_and_notes_no_problem_twice() -> None:
    topology = _topology(
        [7, 8],
        [_branch("a", 7, 8, "1"), _branch("b", 7, 8, "2")],
    )
    identity = _identity(
        buses=(7, 8),
        branches=(BranchId(7, 8, "1", transformer=False),),
    )
    book = assign_sienna_keys(topology, identity)
    first_keys = [(entry.model, entry.idx, entry.key) for entry in book.entries()]
    first_problems = list(book.problems)
    assert len(first_problems) == 1
    book = assign_sienna_keys(topology, identity, book)
    book = assign_sienna_keys(topology, identity, book)
    assert [(entry.model, entry.idx, entry.key) for entry in book.entries()] == first_keys
    assert book.problems == first_problems


@pytest.mark.unit
def test_buckets_and_sources_on_a_recorded_case() -> None:
    topology = _sample("kundur_dyr", "topology")
    book = assign_sienna_keys(topology, read_identity(_case_path("kundur_dyr")))
    by_handle = {(entry.model, str(entry.idx)): entry for entry in book.entries()}
    assert by_handle[("Bus", "1")].bucket == "bus"
    assert by_handle[("Line", "1-101-i_1")].bucket == "transformer"
    assert by_handle[("Line", "101-102-i_1")].bucket == "line"
    assert by_handle[("Line", "101-102-i_1")].source == "file"
    assert by_handle[("Slack", "generator-1-1")].bucket == "generator"
    assert by_handle[("PV", "generator-2-1")].bucket == "generator"
    assert by_handle[("PQ", "load72")].bucket == "load"
    assert by_handle[("PQ", "load72")].source == "file"
    machine = by_handle[("GENROU", "generator-1-1/GENROU")]
    assert machine.bucket == "dynamic"
    assert machine.key == "gen:1-1/machine"
    governor = by_handle[("TGOV1", "generator-1-1/TGOV1")]
    assert governor.key == "gen:1-1/governor"
    # The bus order of a key is the identity record's, not the JSON row's.
    assert by_handle[("Line", "13-112-i_1")].key == "branch:8-9-1"
