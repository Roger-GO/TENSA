"""Unit tests for ``tensa.engines.andes.keys.assign_andes_keys`` on fake systems
built from ``types.SimpleNamespace`` (unit P3-B2a).

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
    assert book.key_of("Line", 101) == "line:7-8-1"
    assert book.key_of("Line", 102) == "line:7-8-2"
    assert all(entry.source == "file" for entry in book.entries() if entry.model == "Line")
    assert book.problems == []


@pytest.mark.unit
def test_lines_mismatch_falls_back_to_ordinals_with_problem() -> None:
    ss = _system(
        Bus=_model([7, 8, 9]),
        Line=_model([101, 102], bus1=[7, 8], bus2=[8, 9]),
    )
    # The identity's second branch is on the wrong pair: positions do not line
    # up, so every line is unmatched and gets an ordinal circuit.
    identity = _identity(
        buses=(7, 8, 9),
        branches=(
            BranchId(7, 8, "1", transformer=False),
            BranchId(7, 9, "1", transformer=False),
        ),
    )
    book = assign_andes_keys(ss, identity)
    assert book.key_of("Line", 101) == "line:7-8-1"
    assert book.key_of("Line", 102) == "line:8-9-1"
    assert all(
        entry.source == "ordinal" for entry in book.entries() if entry.model == "Line"
    )
    assert any("line up" in problem for problem in book.problems)


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
    assert book.key_of("Line", 101) == "line:7-8-1"
    assert book.key_of("Line", 102) == "line:7-8-2"


@pytest.mark.unit
def test_transformer_told_by_tap() -> None:
    ss = _system(
        Bus=_model([1, 5]),
        Line=_model([101], bus1=[1], bus2=[5], tap=[1.05], phi=[0.0], trans=[0]),
    )
    book = assign_andes_keys(ss, None)
    entry = book.entry_of("xfmr:1-5-1")
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
    assert book.entry_of("xfmr:1-5-1") is not None


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
    assert book.key_of("Line", 101) == "line:7-8-1"

    # A line is added; the same book is passed back in.
    ss.Line.n = 2
    ss.Line.idx.v = [101, 102]
    ss.Line.bus1.v = [7, 7]
    ss.Line.bus2.v = [8, 8]
    book = assign_andes_keys(ss, None, book)
    assert book.key_of("Line", 101) == "line:7-8-1"
    assert book.key_of("Line", 102) == "line:7-8-2"
    assert book.problems == []


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
