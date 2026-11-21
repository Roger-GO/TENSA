"""Unit tests for ``tensa.engines.andes.keys.assign_andes_keys`` on fake systems
built from ``types.SimpleNamespace`` (unit P3-B2a, refined by P3-B2b).

A fake model has ``n``, ``idx.v``, ``group`` and its params as objects with
``.v``, shaped like the ANDES models the assigner reads.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tensa.engines.andes.keys import assign_andes_keys
from tensa.engines.identity import BranchId, CaseIdentity, DeviceId


def _param(values: list[Any]) -> Any:
    return SimpleNamespace(v=values)


def _model(
    idx: list[Any],
    group: str = "",
    **params: list[Any],
) -> Any:
    model = SimpleNamespace(n=len(idx), idx=_param(idx), group=SimpleNamespace(class_name=group))
    for name, values in params.items():
        setattr(model, name, _param(values))
    return model


def _system(**models: Any) -> Any:
    ss = SimpleNamespace()
    for name, model in models.items():
        setattr(ss, name, model)
    ss.models = dict(models.items())
    return ss


def _identity(
    buses: tuple[int, ...] = (),
    loads: tuple[DeviceId, ...] = (),
    fixed_shunts: tuple[DeviceId, ...] = (),
    switched_shunts: tuple[DeviceId, ...] = (),
    generators: tuple[DeviceId, ...] = (),
    branches: tuple[BranchId, ...] = (),
) -> CaseIdentity:
    return CaseIdentity(
        format="psse-raw",
        version=33,
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


@pytest.mark.unit
def test_numeric_bus_idx() -> None:
    ss = _system(Bus=_model([1, 2, 3]))
    book = assign_andes_keys(ss, None)
    assert book.key_of("Bus", 1) == "bus:1"
    assert book.key_of("Bus", 3) == "bus:3"
    assert all(entry.source == "engine" for entry in book.entries())
    assert book.problems == []


@pytest.mark.unit
def test_non_numeric_bus_idx_numbered_after_largest() -> None:
    ss = _system(Bus=_model([1, "star_1", 5, "star_2"]))
    book = assign_andes_keys(ss, None)
    assert book.key_of("Bus", 1) == "bus:1"
    assert book.key_of("Bus", 5) == "bus:5"
    assert book.key_of("Bus", "star_1") == "bus:6"
    assert book.key_of("Bus", "star_2") == "bus:7"
    entries = {entry.idx: entry for entry in book.entries()}
    assert entries["star_1"].source == "ordinal"
    assert len(book.problems) == 2


@pytest.mark.unit
def test_fractional_float_bus_idx_is_not_a_number() -> None:
    # 1.5 is no bus number: it is numbered after the largest, not cut to 1.
    ss = _system(Bus=_model([2, 1.5, 3.0]))
    book = assign_andes_keys(ss, None)
    assert book.key_of("Bus", 2) == "bus:2"
    assert book.key_of("Bus", 3.0) == "bus:3"
    assert book.key_of("Bus", 1.5) == "bus:4"
    entries = {entry.idx: entry for entry in book.entries()}
    assert entries[1.5].source == "ordinal"
    assert entries[3.0].source == "engine"
    assert book.problems == ["bus 1.5 has no number; numbered 4 in ANDES order"]


@pytest.mark.unit
def test_lines_matched_to_identity_with_parallel_circuits() -> None:
    ss = _system(
        Bus=_model([7, 8]),
        Line=_model([101, 102], bus1=[7, 7], bus2=[8, 8]),
    )
    identity = _identity(
        buses=(7, 8),
        branches=(
            BranchId(7, 8, "1", transformer=False),
            BranchId(7, 8, "2", transformer=False),
        ),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", 101) == "branch:7-8-1"
    assert book.key_of("Line", 102) == "branch:7-8-2"
    assert all(entry.source == "file" for entry in book.entries() if entry.model == "Line")
    assert all(entry.bucket == "line" for entry in book.entries() if entry.model == "Line")
    assert book.problems == []


@pytest.mark.unit
def test_lines_matched_by_bus_pair_matpower_order() -> None:
    # A MATPOWER-like order: ANDES keeps the branch rows in file order with a
    # transformer between plain lines, and the identity lists the plain lines
    # first. Every line still gets its file circuit by bus pair.
    ss = _system(
        Bus=_model([1, 2, 3, 4]),
        Line=_model(
            [101, 102, 103, 104],
            bus1=[1, 2, 1, 3],
            bus2=[2, 3, 2, 4],
            tap=[1.0, 1.05, 1.0, 1.0],
            phi=[0.0, 0.0, 0.0, 0.0],
            trans=[0, 1, 0, 0],
        ),
    )
    identity = _identity(
        buses=(1, 2, 3, 4),
        branches=(
            BranchId(1, 2, "1", transformer=False),
            BranchId(1, 2, "2", transformer=False),
            BranchId(3, 4, "1", transformer=False),
            BranchId(2, 3, "1", transformer=True),
        ),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", 101) == "branch:1-2-1"
    assert book.key_of("Line", 102) == "branch:2-3-1"
    assert book.key_of("Line", 103) == "branch:1-2-2"
    assert book.key_of("Line", 104) == "branch:3-4-1"
    entries = {entry.idx: entry for entry in book.entries() if entry.model == "Line"}
    assert all(entry.source == "file" for entry in entries.values())
    assert entries[102].bucket == "transformer"
    assert entries[101].bucket == "line"
    assert entries[103].bucket == "line"
    assert entries[104].bucket == "line"
    assert book.problems == []


@pytest.mark.unit
def test_line_with_no_record_gets_ordinal_and_note() -> None:
    ss = _system(
        Bus=_model([7, 8, 9]),
        Line=_model([101, 102], bus1=[7, 8], bus2=[8, 9]),
    )
    # The file names only the 7-8 branch; the 8-9 line has no record and
    # takes an ordinal circuit, with one note.
    identity = _identity(
        buses=(7, 8, 9),
        branches=(BranchId(7, 8, "1", transformer=False),),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", 101) == "branch:7-8-1"
    assert book.key_of("Line", 102) == "branch:8-9-1"
    entries = {entry.idx: entry for entry in book.entries() if entry.model == "Line"}
    assert entries[101].source == "file"
    assert entries[102].source == "ordinal"
    assert len(book.problems) == 1
    assert "no branch record" in book.problems[0]


@pytest.mark.unit
def test_identity_branch_left_unused_gets_note() -> None:
    ss = _system(
        Bus=_model([7, 8]),
        Line=_model([101], bus1=[7], bus2=[8]),
    )
    # The file names a second 7-8 branch and a 7-8 transformer ANDES does not
    # hold: two records are left unused, with one note.
    identity = _identity(
        buses=(7, 8),
        branches=(
            BranchId(7, 8, "1", transformer=False),
            BranchId(7, 8, "2", transformer=False),
            BranchId(7, 8, "T", transformer=True),
        ),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", 101) == "branch:7-8-1"
    assert len(book.problems) == 1
    assert "left unused" in book.problems[0]
    assert "2 branch record(s)" in book.problems[0]


@pytest.mark.unit
def test_line_past_identity_branches_gets_ordinal_circuit() -> None:
    ss = _system(
        Bus=_model([7, 8]),
        Line=_model([101, 102], bus1=[7, 7], bus2=[8, 8]),
    )
    # Only one branch in the file: the second line has no partner and takes
    # the next free circuit for the pair, skipping the file's "1".
    identity = _identity(
        buses=(7, 8),
        branches=(BranchId(7, 8, "1", transformer=False),),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", 101) == "branch:7-8-1"
    assert book.key_of("Line", 102) == "branch:7-8-2"


@pytest.mark.unit
def test_bus_and_line_the_engine_added_get_engine_keys() -> None:
    # ANDES turns a three-winding transformer into a star bus the file does
    # not number (9) and three lines to it.
    ss = _system(
        Bus=_model([1, 2, 3, 9]),
        Line=_model(
            [101, 102, 103],
            bus1=[1, 2, 3],
            bus2=[9, 9, 9],
            tap=[1.0, 1.0, 1.0],
            phi=[0.0, 0.0, 0.0],
            trans=[0, 0, 0],
        ),
    )
    identity = _identity(buses=(1, 2, 3))
    book = assign_andes_keys(ss, identity)
    bus_entry = book.entry_of("engine:andes:Bus:9")
    assert bus_entry is not None
    assert bus_entry.bucket == "other"
    assert bus_entry.source == "engine"
    for idx in (101, 102, 103):
        entry = book.entry_of(f"engine:andes:Line:{idx}")
        assert entry is not None
        assert entry.bucket == "other"
        assert entry.source == "engine"
    assert len(book.problems) == 1
    assert "three-winding" in book.problems[0]
    assert "1 bus(es) and 3 line(s)" in book.problems[0]


@pytest.mark.unit
def test_added_bus_without_identity_still_gets_a_bus_key() -> None:
    ss = _system(
        Bus=_model([1, 2, 9]),
        Line=_model([101], bus1=[1], bus2=[9]),
    )
    book = assign_andes_keys(ss, None)
    assert book.key_of("Bus", 9) == "bus:9"
    assert book.key_of("Line", 101) == "branch:1-9-1"


@pytest.mark.unit
def test_transformer_told_by_tap() -> None:
    ss = _system(
        Bus=_model([1, 5]),
        Line=_model([101], bus1=[1], bus2=[5], tap=[1.05], phi=[0.0], trans=[0]),
    )
    book = assign_andes_keys(ss, None)
    entry = book.entry_of("branch:1-5-1")
    assert entry is not None
    assert entry.bucket == "transformer"
    assert entry.source == "ordinal"


@pytest.mark.unit
def test_transformer_told_by_rated_voltages() -> None:
    ss = _system(
        Bus=_model([1, 5]),
        Line=_model(
            [101], bus1=[1], bus2=[5], tap=[1.0], phi=[0.0], trans=[0],
            Vn1=[20.0], Vn2=[230.0],
        ),
    )
    book = assign_andes_keys(ss, None)
    entry = book.entry_of("branch:1-5-1")
    assert entry is not None
    assert entry.bucket == "transformer"


@pytest.mark.unit
def test_line_and_transformer_of_one_pair_share_the_key_space() -> None:
    # The file holds a line and a transformer between the same buses with the
    # same circuit id: both ask for branch:7-8-1. The second is stored with a
    # "~2" suffix and a note, and keeps its bucket.
    ss = _system(
        Bus=_model([7, 8]),
        Line=_model(
            [101, 102],
            bus1=[7, 7],
            bus2=[8, 8],
            tap=[1.0, 1.05],
            phi=[0.0, 0.0],
            trans=[0, 0],
        ),
    )
    identity = _identity(
        buses=(7, 8),
        branches=(
            BranchId(7, 8, "1", transformer=False),
            BranchId(7, 8, "1", transformer=True),
        ),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", 101) == "branch:7-8-1"
    assert book.key_of("Line", 102) == "branch:7-8-1~2"
    entries = {entry.idx: entry for entry in book.entries() if entry.model == "Line"}
    assert entries[101].bucket == "line"
    assert entries[102].bucket == "transformer"
    assert all(entry.source == "file" for entry in entries.values())
    assert book.problems == [
        "key branch:7-8-1 of Line 102 is already held by Line 101; "
        "stored as branch:7-8-1~2"
    ]


@pytest.mark.unit
def test_ordinal_circuit_counts_lines_and_transformers_together() -> None:
    # No identity: a line and a transformer of one bus pair take the circuits
    # "1" and "2" of one shared ordinal sequence.
    ss = _system(
        Bus=_model([7, 8]),
        Line=_model(
            [101, 102],
            bus1=[7, 7],
            bus2=[8, 8],
            tap=[1.0, 1.05],
            phi=[0.0, 0.0],
            trans=[0, 0],
        ),
    )
    book = assign_andes_keys(ss, None)
    assert book.key_of("Line", 101) == "branch:7-8-1"
    assert book.key_of("Line", 102) == "branch:7-8-2"
    entries = {entry.idx: entry for entry in book.entries() if entry.model == "Line"}
    assert entries[101].bucket == "line"
    assert entries[102].bucket == "transformer"
    assert book.problems == []


@pytest.mark.unit
def test_generators_with_and_without_subidx() -> None:
    ss = _system(
        Bus=_model([1, 2]),
        PV=_model([1, 2], bus=[1, 2], subidx=[1.0, None]),
        Slack=_model([3], bus=[2], subidx=[""]),
    )
    book = assign_andes_keys(ss, None)
    # A whole-number subidx is written as an integer.
    assert book.key_of("PV", 1) == "gen:1-1"
    # Without a subidx: the ordinal among static generators on the bus.
    assert book.key_of("PV", 2) == "gen:2-1"
    assert book.key_of("Slack", 3) == "gen:2-2"
    entries = {entry.idx: entry for entry in book.entries()}
    assert entries[1].source == "engine"
    assert entries[2].source == "ordinal"


@pytest.mark.unit
def test_loads_matched_and_unmatched() -> None:
    matched_ss = _system(
        Bus=_model([7, 8]),
        PQ=_model([1, 2], bus=[7, 8]),
    )
    identity = _identity(
        buses=(7, 8),
        loads=(DeviceId(7, "2"), DeviceId(8, "1")),
    )
    book = assign_andes_keys(matched_ss, identity)
    assert book.key_of("PQ", 1) == "load:7-2"
    assert book.key_of("PQ", 2) == "load:8-1"
    assert all(entry.source == "file" for entry in book.entries() if entry.model == "PQ")

    unmatched_ss = _system(
        Bus=_model([7]),
        PQ=_model([1, 2], bus=[7, 7]),
    )
    book = assign_andes_keys(unmatched_ss, identity)
    assert book.key_of("PQ", 1) == "load:7-1"
    assert book.key_of("PQ", 2) == "load:7-2"
    assert all(
        entry.source == "ordinal" for entry in book.entries() if entry.model == "PQ"
    )


@pytest.mark.unit
def test_loads_not_matched_when_the_file_has_more_records() -> None:
    # The file names three loads, ANDES holds two whose buses match the first
    # two records: the counts differ, so no file id is given by position.
    ss = _system(
        Bus=_model([7, 8]),
        PQ=_model([1, 2], bus=[7, 7]),
    )
    identity = _identity(
        buses=(7, 8),
        loads=(DeviceId(7, "A"), DeviceId(7, "B"), DeviceId(8, "C")),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("PQ", 1) == "load:7-1"
    assert book.key_of("PQ", 2) == "load:7-2"
    assert all(
        entry.source == "ordinal" for entry in book.entries() if entry.model == "PQ"
    )


@pytest.mark.unit
def test_exciter_and_governor_resolve_to_their_unit() -> None:
    ss = _system(
        Bus=_model([1]),
        PV=_model([1], bus=[1], subidx=[1]),
        GENROU=_model([1], group="SynGen", bus=[1], gen=[1]),
        EXDC2=_model([1], group="Exciter", syn=[1]),
        TGOV1=_model([1], group="TurbineGov", syn=[1]),
    )
    book = assign_andes_keys(ss, None)
    assert book.key_of("GENROU", 1) == "gen:1-1/machine"
    assert book.key_of("EXDC2", 1) == "gen:1-1/exciter"
    assert book.key_of("TGOV1", 1) == "gen:1-1/governor"
    entries = {entry.model: entry for entry in book.entries() if entry.bucket == "dynamic"}
    assert entries["GENROU"].source == "engine"


@pytest.mark.unit
def test_two_models_of_one_role_on_a_unit() -> None:
    ss = _system(
        Bus=_model([1]),
        PV=_model([1], bus=[1], subidx=[1]),
        GENROU=_model([1], group="SynGen", bus=[1], gen=[1]),
        GENCLS=_model([2], group="SynGen", bus=[1], gen=[1]),
    )
    book = assign_andes_keys(ss, None)
    assert book.key_of("GENROU", 1) == "gen:1-1/machine"
    assert book.key_of("GENCLS", 2) == "gen:1-1/machine:GENCLS"


@pytest.mark.unit
def test_three_devices_of_one_model_on_one_unit() -> None:
    # Six ESD1 devices can name one static generator; here three. The second
    # and third take "-2" and "-3" on the model-qualified key, with no note.
    ss = _system(
        Bus=_model([1]),
        PV=_model([1], bus=[1], subidx=[1]),
        ESD1=_model([1, 2, 3], group="DG", bus=[1, 1, 1], gen=[1, 1, 1]),
    )
    book = assign_andes_keys(ss, None)
    assert book.key_of("ESD1", 1) == "gen:1-1/renewable"
    assert book.key_of("ESD1", 2) == "gen:1-1/renewable:ESD1"
    assert book.key_of("ESD1", 3) == "gen:1-1/renewable:ESD1-2"
    assert all("~" not in entry.key for entry in book.entries())
    assert book.problems == []


@pytest.mark.unit
def test_device_with_only_a_bus() -> None:
    ss = _system(
        Bus=_model([5]),
        PMU=_model([3], group="PhasorMeasurement", bus=[5]),
    )
    book = assign_andes_keys(ss, None)
    entry = book.entry_of("pmu:5-1")
    assert entry is not None
    assert entry.bucket == "other"
    assert entry.source == "ordinal"


@pytest.mark.unit
def test_device_with_nothing() -> None:
    ss = _system(
        Bus=_model([5]),
        COI=_model([1], group="Other"),
    )
    book = assign_andes_keys(ss, None)
    entry = book.entry_of("engine:andes:COI:1")
    assert entry is not None
    assert entry.bucket == "other"
    assert entry.source == "engine"


@pytest.mark.unit
def test_second_call_keeps_old_keys_and_numbers_the_new_line() -> None:
    ss = _system(
        Bus=_model([7, 8]),
        Line=_model([101], bus1=[7], bus2=[8]),
    )
    book = assign_andes_keys(ss, None)
    assert book.key_of("Line", 101) == "branch:7-8-1"

    # A line is added; the same book is passed back in.
    ss.Line.n = 2
    ss.Line.idx.v = [101, 102]
    ss.Line.bus1.v = [7, 7]
    ss.Line.bus2.v = [8, 8]
    book = assign_andes_keys(ss, None, book)
    assert book.key_of("Line", 101) == "branch:7-8-1"
    assert book.key_of("Line", 102) == "branch:7-8-2"
    assert book.problems == []


@pytest.mark.unit
def test_second_call_notes_no_problem_twice() -> None:
    # The keys are read again on every listing; a problem the first assignment
    # noted (an unnumbered bus, a file record left unused) is noted once.
    ss = _system(
        Bus=_model([7, 8, "star"]),
        Line=_model([101], bus1=[7], bus2=[8]),
    )
    identity = _identity(
        buses=(7, 8),
        branches=(
            BranchId(7, 8, "1", transformer=False),
            BranchId(7, 8, "2", transformer=False),
        ),
    )
    book = assign_andes_keys(ss, identity)
    first = list(book.problems)
    assert len(first) == 2
    book = assign_andes_keys(ss, identity, book)
    book = assign_andes_keys(ss, identity, book)
    assert book.problems == first


@pytest.mark.unit
def test_timed_events_and_bookkeeping_models_are_skipped() -> None:
    ss = _system(
        Bus=_model([1]),
        Toggle=_model([1], group="TimedEvent"),
        Summary=_model([1], group=""),
        Area=_model([1], group=""),
    )
    book = assign_andes_keys(ss, None)
    assert [entry.model for entry in book.entries()] == ["Bus"]
