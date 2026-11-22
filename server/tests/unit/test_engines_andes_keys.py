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
@pytest.mark.parametrize(
    ("vn1", "vn2", "bucket"),
    [
        (20.0, 230.0, "transformer"),
        (20.7, 20.9, "transformer"),  # the closest two levels of the ANDES examples
        (1000.0, 998.9, "transformer"),  # 0.11 % apart
        (1000.0, 999.0005, "line"),  # 0.09995 % of the larger, 0.10005 % of the smaller
        (999.0005, 1000.0, "line"),
        (230.0, 230.0, "line"),
    ],
)
def test_rated_voltages_split_lines_as_the_topology_does(
    vn1: float, vn2: float, bucket: str
) -> None:
    # The bucket of a key and the list the topology puts a branch in are one
    # rule: two ends rated more than 0.1 % of the larger apart are two levels.
    from tensa.core.wrapper.topology import _marked_as_transformers

    ss = _system(
        Bus=_model([1, 5]),
        Line=_model(
            [101], bus1=[1], bus2=[5], tap=[1.0], phi=[0.0], trans=[0],
            Vn1=[vn1], Vn2=[vn2],
        ),
    )
    entry = assign_andes_keys(ss, None).entry_of("branch:1-5-1")
    assert entry is not None
    topology = "transformer" if 101 in _marked_as_transformers(ss) else "line"
    assert topology == bucket
    assert entry.bucket == bucket, "the key's bucket departs from the topology's"


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
def test_added_load_takes_the_first_free_ordinal_on_its_bus() -> None:
    # Kundur's shape: the only load on bus 7 has id 2. A load added there
    # takes the first ordinal no element holds, 1, and not 2 with a suffix.
    identity = _identity(buses=(7, 8), loads=(DeviceId(7, "2"), DeviceId(8, "1")))
    ss = _system(Bus=_model([7, 8]), PQ=_model([1, 2], bus=[7, 8]))
    book = assign_andes_keys(ss, identity)
    assert book.key_of("PQ", 1) == "load:7-2"

    ss.PQ = _model([1, 2, 3], bus=[7, 8, 7])
    ss.models["PQ"] = ss.PQ
    book = assign_andes_keys(ss, identity, book)
    assert book.key_of("PQ", 1) == "load:7-2"
    assert book.key_of("PQ", 2) == "load:8-1"
    assert book.key_of("PQ", 3) == "load:7-1"
    ss.PQ = _model([1, 2, 3, 4], bus=[7, 8, 7, 7])
    ss.models["PQ"] = ss.PQ
    book = assign_andes_keys(ss, identity, book)
    assert book.key_of("PQ", 4) == "load:7-3"
    assert all("~" not in entry.key for entry in book.entries())
    assert book.problems == []


@pytest.mark.unit
def test_added_load_after_a_file_load_with_id_one() -> None:
    identity = _identity(buses=(4,), loads=(DeviceId(4, "1"),))
    ss = _system(Bus=_model([4]), PQ=_model([1], bus=[4]))
    book = assign_andes_keys(ss, identity)
    ss.PQ = _model([1, "PQ_new"], bus=[4, 4])
    ss.models["PQ"] = ss.PQ
    book = assign_andes_keys(ss, identity, book)
    assert book.key_of("PQ", 1) == "load:4-1"
    assert book.key_of("PQ", "PQ_new") == "load:4-2"
    assert book.problems == []


@pytest.mark.unit
def test_added_parallel_line_keeps_the_corridors_orientation() -> None:
    # IEEE 14's shape: the file writes the branch 6 to 5. A line added from 5
    # to 6 is a second circuit of that corridor, branch:6-5-2, not branch:5-6-1.
    identity = _identity(buses=(5, 6, 9), branches=(BranchId(6, 5, "1", transformer=False),))
    ss = _system(Bus=_model([5, 6, 9]), Line=_model(["Line_1"], bus1=[6], bus2=[5]))
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", "Line_1") == "branch:6-5-1"
    ss.Line = _model(["Line_1", "Line_new"], bus1=[6, 5], bus2=[5, 6])
    ss.models["Line"] = ss.Line
    book = assign_andes_keys(ss, identity, book)
    assert book.key_of("Line", "Line_1") == "branch:6-5-1"
    assert book.key_of("Line", "Line_new") == "branch:6-5-2"
    # A line added on a pair with no branch yet is written in bus-number order.
    ss.Line = _model(["Line_1", "Line_new", "Line_far"], bus1=[6, 5, 9], bus2=[5, 6, 5])
    ss.models["Line"] = ss.Line
    book = assign_andes_keys(ss, identity, book)
    assert book.key_of("Line", "Line_far") == "branch:5-9-1"
    assert all("~" not in entry.key for entry in book.entries())
    assert book.problems == []


@pytest.mark.unit
def test_line_added_after_a_file_line_was_deleted_takes_a_free_circuit() -> None:
    # Kundur's 5-6 corridor has circuits 1 and 2. Circuit 1 is deleted and a
    # line of the pair added: the queue hands the added line the record of
    # circuit 2, whose key the remaining line holds, so it takes the first
    # circuit the file does not give and no branch holds, 3.
    identity = _identity(
        buses=(5, 6),
        branches=(
            BranchId(5, 6, "1", transformer=False),
            BranchId(5, 6, "2", transformer=False),
        ),
    )
    ss = _system(Bus=_model([5, 6]), Line=_model([1, 2], bus1=[5, 5], bus2=[6, 6]))
    book = assign_andes_keys(ss, identity)
    assert [book.key_of("Line", i) for i in (1, 2)] == ["branch:5-6-1", "branch:5-6-2"]
    book.retain({("Bus", "5"), ("Bus", "6"), ("Line", "2")})
    ss.Line = _model([2, 3], bus1=[5, 6], bus2=[6, 5])
    ss.models["Line"] = ss.Line
    book = assign_andes_keys(ss, identity, book)
    assert book.key_of("Line", 2) == "branch:5-6-2"
    assert book.key_of("Line", 3) == "branch:5-6-3"
    assert all("~" not in entry.key for entry in book.entries())
    assert book.problems == []


@pytest.mark.unit
def test_added_generator_takes_the_first_free_id_on_its_bus() -> None:
    ss = _system(Bus=_model([1]), PV=_model([1], bus=[1], subidx=[1]))
    book = assign_andes_keys(ss, None)
    assert book.key_of("PV", 1) == "gen:1-1"
    # One with no machine id, then one whose machine id another holds.
    ss.PV = _model([1, 2, 3], bus=[1, 1, 1], subidx=[1, None, 1])
    ss.models["PV"] = ss.PV
    book = assign_andes_keys(ss, None, book)
    assert book.key_of("PV", 1) == "gen:1-1"
    assert book.key_of("PV", 2) == "gen:1-2"
    assert book.key_of("PV", 3) == "gen:1-3"
    # One whose own machine id is free keeps it.
    ss.PV = _model([1, 2, 3, 4], bus=[1, 1, 1, 1], subidx=[1, None, 1, 7])
    ss.models["PV"] = ss.PV
    book = assign_andes_keys(ss, None, book)
    assert book.key_of("PV", 4) == "gen:1-7"
    assert all("~" not in entry.key for entry in book.entries())
    assert book.problems == []


SHUNTS_RAW = """\
  0,    100.00, 33, 0, 0, 60.00       /
  FIXED AND SWITCHED SHUNTS ON ONE BUS
  SECOND COMMENT LINE
    9,'Bus Nine    ',  69.0000,1,   1,   1,   1,1.00000,   0.0000
   14,'Bus Fourteen',  69.0000,1,   1,   1,   1,1.00000,   0.0000
 0 / END OF BUS DATA, BEGIN LOAD DATA
 0 / END OF LOAD DATA, BEGIN FIXED SHUNT DATA
    9,'1 ',1,   0.000,  10.000
 0 / END OF FIXED SHUNT DATA, BEGIN GENERATOR DATA
 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA
 0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA
 0 / END OF TRANSFORMER DATA, BEGIN AREA DATA
 0 / END OF AREA DATA, BEGIN TWO-TERMINAL DC DATA
 0 / END OF TWO-TERMINAL DC DATA, BEGIN VOLTAGE SOURCE CONVERTER DATA
 0 / END OF VOLTAGE SOURCE CONVERTER DATA, BEGIN IMPEDANCE CORRECTION DATA
 0 / END OF IMPEDANCE CORRECTION DATA, BEGIN MULTI-TERMINAL DC DATA
 0 / END OF MULTI-TERMINAL DC DATA, BEGIN MULTI-SECTION LINE DATA
 0 / END OF MULTI-SECTION LINE DATA, BEGIN ZONE DATA
 0 / END OF ZONE DATA, BEGIN INTER-AREA TRANSFER DATA
 0 / END OF INTER-AREA TRANSFER DATA, BEGIN OWNER DATA
 0 / END OF OWNER DATA, BEGIN FACTS CONTROL DEVICE DATA
 0 / END OF FACTS CONTROL DEVICE DATA, BEGIN SWITCHED SHUNT DATA
    9,1,0,1,1.02500,0.96000,     0,  100.0,'            ',   19.00, 3,   5.00
   14,1,0,1,1.02500,0.96000,     0,  100.0,'            ',   15.00, 3,   5.00
   14,1,0,1,1.02500,0.96000,     0,  100.0,'            ',   10.00, 2,   5.00
 0 / END OF SWITCHED SHUNT DATA, BEGIN GNE DEVICE DATA
 0 / END OF GNE DEVICE DATA
Q
"""


@pytest.mark.unit
def test_fixed_and_switched_shunts_on_one_bus_each_get_a_key() -> None:
    # ANDES makes one Shunt per fixed and per switched shunt record, the fixed
    # ones first, in file order. A switched shunt has no id: it takes the
    # first ordinal on its bus that no shunt before it holds, so a bus with a
    # fixed shunt of id 1 and a switched shunt, or two switched shunts, gives
    # every shunt a key of its own and no "~" suffix.
    from tensa.engines.identity import read_psse_raw_identity

    identity = read_psse_raw_identity(SHUNTS_RAW)
    ss = _system(
        Bus=_model([9, 14]),
        Shunt=_model([1, 2, 3, 4], bus=[9, 9, 14, 14]),
    )
    book = assign_andes_keys(ss, identity)
    assert [book.key_of("Shunt", i) for i in (1, 2, 3, 4)] == [
        "shunt:9-1",
        "shunt:9-2",
        "shunt:14-1",
        "shunt:14-2",
    ]
    assert all(entry.source == "file" for entry in book.entries() if entry.model == "Shunt")
    assert book.problems == []


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
