"""The edit log against real ANDES: removing a device, finding what depends on it,
and what ``Wrapper`` builds on the two (delete, undo, redo).

ANDES has no call that removes a device, so ``tensa.core.edit_log.remove_device``
takes one out of the lists a pre-setup System keeps (contract 14 in
``server/ANDES_VERSIONS.md``). The first tests here are what that contract is held
to: a System with a device removed is compared, list by list, with one ANDES read
from a file that never had the device, and then set up and solved beside it.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core import wrapper as wrapper_mod
from tensa.core.case_events import event_from_spec
from tensa.core.disturbance import FaultSpec, ToggleSpec
from tensa.core.edit_log import (
    _NOT_REFERENCES,
    _PAIRED_REFERENCES,
    _UNTYPED_REFERENCES,
    AddOp,
    DeleteOp,
    EditOp,
    dependents,
    is_event,
    reference_params,
    referrers,
    remove_device,
)
from tensa.core.errors import (
    DisturbanceCommitError,
    DisturbanceValidationError,
    ElementHasDependentsError,
    ElementNotFoundError,
    ElementValidationError,
    SetupFailedError,
)
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _load(case: str, *addfiles: str) -> Any:
    import andes

    cases = _cases()
    return andes.load(
        str(cases / case),
        addfile=[str(cases / a) for a in addfiles] or None,
        setup=False,
        no_output=True,
        default_config=True,
    )


def _without(ss: Any, model: str, idx: int | str, tmp_path: Path) -> Any:
    """The System ANDES reads from ``ss`` written out with one device left out."""
    import andes
    from andes.io import json as andes_json

    buffer = io.StringIO()
    andes_json.write(ss, buffer, overwrite=True)
    data = json.loads(buffer.getvalue())
    rows = [row for row in data[model] if row["idx"] != idx]
    assert len(rows) == len(data[model]) - 1
    data[model] = rows
    path = tmp_path / "without.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return andes.load(str(path), setup=False, no_output=True, default_config=True)


def _same(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return bool(a == b)
    try:
        return bool(np.isclose(float(a), float(b), rtol=1e-12, atol=0.0))
    except (TypeError, ValueError):
        return bool(a == b)


def _registries_without(ss: Any, model: str, idx: int | str) -> dict[str, list[Any]]:
    """Each group's devices, in the order the group holds them, less one device.

    Under every name the group goes by: ANDES lists ``ACNode`` as ``ACTopology``
    too, one object under two names.
    """
    own = ss.groups[ss.models[model].group]
    return {
        name: [held for held in group._idx2model if not (group is own and held == idx)]
        for name, group in ss.groups.items()
    }


def _assert_same_devices(got: Any, want: Any, registries: dict[str, list[Any]]) -> None:
    """Every model of ``got`` holds what ``want`` holds, in the same order, and
    every group holds ``registries`` (what it held before, less what was removed).

    The params a file does not carry are left out: the ones ANDES does not
    export, and the ones that copy another model's values (``ExtParam``), which a
    parser may link early and ``setup()`` fills in either System. A group is not
    compared with ``want`` for order, because a group that spans models keeps the
    order its devices were added in, and each file format adds them in its own.
    """
    from andes.core.param import ExtParam

    for name, model in want.models.items():
        other = got.models[name]
        assert other.n == model.n, name
        assert dict(other.uid) == dict(model.uid), name
        for param_name, param in model.params.items():
            if not param.export or isinstance(param, ExtParam):
                continue
            mine = list(other.params[param_name].v)
            theirs = list(param.v)
            assert len(mine) == len(theirs), (name, param_name)
            assert all(_same(x, y) for x, y in zip(mine, theirs, strict=True)), (name, param_name)
        # No list of the model is left longer than the model.
        for param_name, param in other.params.items():
            for attr in ("v", "vin", "pu_coeff"):
                values = getattr(param, attr, None)
                if isinstance(values, list) or getattr(values, "ndim", 0) >= 1:
                    assert len(values) in (0, other.n), (name, param_name, attr)
    for name, group in want.groups.items():
        other = got.groups[name]
        assert list(other._idx2model) == registries[name], name
        assert dict(other.uid) == {idx: i for i, idx in enumerate(registries[name])}, name
        assert other.n == group.n, name
        assert {
            idx: model.class_name for idx, model in other._idx2model.items()
        } == {idx: model.class_name for idx, model in group._idx2model.items()}, name


# ---- remove_device (contract 14) --------------------------------------------


@pytest.mark.parametrize(
    ("case", "addfiles", "model", "idx"),
    [
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "Line", "Line_3"),
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "PQ", "PQ_1"),
        # A model whose ExtParams the dynamic file's parser linked before setup.
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "GENROU", "GENROU_2"),
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "ESST3A", "ESST3A_2"),
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "Toggle", "Toggle_1"),
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "PV", 3),
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "Bus", 14),
        ("kundur/kundur_full.xlsx", (), "Line", "Line_3"),
        ("kundur/kundur_full.xlsx", (), "Toggle", 1),
        ("ieee39/ieee39_full.xlsx", (), "PQ", "PQ_3"),
        # The only device of its model: the model is left empty.
        ("kundur/kundur_full.xlsx", (), "Slack", 1),
    ],
)
def test_a_system_with_a_device_removed_is_the_one_a_file_without_it_gives(
    case: str, addfiles: tuple[str, ...], model: str, idx: int | str, tmp_path: Path
) -> None:
    ss = _load(case, *addfiles)
    assert idx in ss.models[model].idx.v, (model, list(ss.models[model].idx.v))
    want = _without(ss, model, idx, tmp_path)
    registries = _registries_without(ss, model, idx)

    remove_device(ss, model, idx)

    assert idx not in ss.models[model].idx.v
    _assert_same_devices(ss, want, registries)
    # ANDES's own export still works on every model, which it does not when a
    # param list is left longer than the others.
    for instance in ss.models.values():
        if instance.n:
            assert len(instance.as_df()) == instance.n


@pytest.mark.parametrize(
    ("case", "addfiles", "model", "idx"),
    [
        ("ieee14/ieee14.raw", ("ieee14/ieee14.dyr",), "Line", "Line_3"),
        ("kundur/kundur_full.xlsx", (), "Line", "Line_3"),
        ("ieee39/ieee39_full.xlsx", (), "PQ", "PQ_3"),
    ],
)
def test_a_system_with_a_device_removed_solves_like_one_read_without_it(
    case: str, addfiles: tuple[str, ...], model: str, idx: int | str, tmp_path: Path
) -> None:
    ss = _load(case, *addfiles)
    want = _without(ss, model, idx, tmp_path)
    remove_device(ss, model, idx)

    solved = []
    for system in (ss, want):
        assert system.setup()
        system.PFlow.run()
        assert system.PFlow.converged
        system.TDS.config.tf = 1.5
        system.TDS.config.no_tqdm = 1
        system.TDS.run()
        assert not system.TDS.busted and system.dae.t == pytest.approx(1.5)
        solved.append((np.array(system.Bus.v.v), np.array(system.dae.x)))
    np.testing.assert_allclose(solved[0][0], solved[1][0], rtol=0, atol=1e-10)
    np.testing.assert_allclose(solved[0][1], solved[1][1], rtol=0, atol=1e-8)


def test_remove_device_refuses_what_it_cannot_do() -> None:
    ss = _load("ieee14/ieee14.raw")
    with pytest.raises(KeyError, match="no Line with idx='Line_99'"):
        remove_device(ss, "Line", "Line_99")
    assert ss.Line.n == 20

    assert ss.setup()
    with pytest.raises(RuntimeError, match="set up"):
        remove_device(ss, "Line", "Line_3")
    assert ss.Line.n == 20


def test_a_correction_andes_noted_for_a_device_goes_with_it() -> None:
    """ANDES reports the params it corrected at ``setup()``, by device. One that
    is gone by then must not be named."""
    ss = _load("ieee14/ieee14.raw")
    ss.Line._param_corrections[("x", "zero")].extend(["Line_3", "Line_4"])

    remove_device(ss, "Line", "Line_3")

    assert ss.Line._param_corrections[("x", "zero")] == ["Line_4"]


# ---- what depends on a device -----------------------------------------------


def test_the_references_followed_are_the_ones_this_andes_declares() -> None:
    """``referrers`` reads what each ``IdxParam`` says it points into. The ones
    that say nothing are listed by hand in ``edit_log``; if an ANDES release adds
    one, or a target that is neither a group nor a model, this says so."""
    import andes

    ss = andes.System(no_output=True, default_config=True)
    untyped = {
        (name, param_name)
        for name, model in ss.models.items()
        for param_name, param in model.idx_params.items()
        if param.model is None
    }
    by_hand = (
        set(_UNTYPED_REFERENCES)
        | set(_NOT_REFERENCES)
        | {(name, pair[1]) for name, pair in _PAIRED_REFERENCES.items()}
    )
    assert untyped == by_hand

    for (name, _param), group in _UNTYPED_REFERENCES.items():
        assert name in ss.models and group in ss.groups
    for name, (model_param, dev_param) in _PAIRED_REFERENCES.items():
        assert model_param in ss.models[name].params
        assert dev_param in ss.models[name].idx_params

    followed = reference_params(ss)
    nowhere = {
        target
        for target in followed.values()
        if target is not None
        and not target.startswith("<")
        and target not in ss.groups
        and target not in ss.models
    }
    # Declared by ANDES 2.0.0 as targets with no model or group of that name
    # behind them, so nothing can be deleted from under them.
    assert nowhere == {"Region", "Owner", "COI2", "Synchronous"}
    assert ss.groups["TimedEvent"].models.keys() == {"Fault", "Toggle", "Alter"}


def test_dependents_follow_the_references_down() -> None:
    ss = _load("ieee14/ieee14.raw", "ieee14/ieee14.dyr")

    # A static generator, the machine on it, and what is on the machine.
    assert referrers(ss, [("PV", 2)]) == [("GENROU", "GENROU_2")]
    assert dependents(ss, "PV", 2) == [
        ("GENROU", "GENROU_2"),
        ("IEEEG1", "IEEEG1_4"),
        ("EXST1", "EXST1_1"),
        ("ST2CUT", "ST2CUT_3"),
    ]
    # A reference is matched as ANDES looks it up: the bus is 2, not "2".
    assert dependents(ss, "PV", "2") == []

    on_bus_2 = dependents(ss, "Bus", 2)
    assert {ref for ref in on_bus_2 if ref[0] == "Line"} == {
        ("Line", "Line_1"), ("Line", "Line_3"), ("Line", "Line_4"), ("Line", "Line_5"),
    }
    assert ("PV", 2) in on_bus_2 and ("ST2CUT", "ST2CUT_3") in on_bus_2
    # The case trips Line_1, which is on the bus: the two toggles follow it.
    events = [ref for ref in on_bus_2 if is_event(ss, ref[0])]
    assert events == [("Toggle", "Toggle_1"), ("Toggle", "Toggle_2")]
    assert on_bus_2.index(("Line", "Line_1")) < on_bus_2.index(("Toggle", "Toggle_1"))

    assert dependents(ss, "Line", "Line_3") == []
    assert dependents(ss, "Toggle", "Toggle_1") == []


def test_a_toggle_names_its_device_by_model_or_by_group() -> None:
    ss = _load("ieee14/ieee14.raw")
    ss.add("Toggle", {"model": "Line", "dev": "Line_3", "t": 1.0})
    ss.add("Toggle", {"model": "ACLine", "dev": "Line_4", "t": 1.0})
    # The same idx in another model is not the device meant.
    ss.add("Toggle", {"model": "PQ", "dev": "Line_3", "t": 1.0})
    ss.add("Alter", {"model": "PQ", "dev": "PQ_1", "src": "p0", "t": 1.0, "method": "+", "amount": 0.1})

    # ANDES knows the Toggle model as ``Toggler`` too, and a bus's group as
    # ``ACTopology``.
    ss.add("Toggle", {"model": "Toggler", "dev": "Toggle_1", "t": 2.0})
    ss.add("Toggle", {"model": "ACTopology", "dev": 14, "t": 2.0})

    assert dependents(ss, "Line", "Line_3") == [("Toggle", "Toggle_1"), ("Toggle", "Toggle_5")]
    assert dependents(ss, "Line", "Line_4") == [("Toggle", "Toggle_2")]
    # An Alter's ``src`` names a param, never a device.
    assert dependents(ss, "PQ", "PQ_1") == [("Alter", "Alter_4")]
    assert ("Toggle", "Toggle_6") in dependents(ss, "Bus", 14)


# ---- Wrapper: delete --------------------------------------------------------


def _wrapper(case: str = "ieee14/ieee14.raw", *addfiles: str) -> Wrapper:
    cases = _cases()
    w = Wrapper()
    w.load_case(cases / case, addfiles=[cases / a for a in addfiles] or None)
    return w


def _voltages(w: Wrapper) -> dict[str, float]:
    result = w.run_pflow()
    assert result.converged
    return {str(idx): float(v) for idx, v in result.bus_voltages.items()}


def test_deleting_a_case_line_solves_like_the_line_out_of_service() -> None:
    deleted = _wrapper()
    result = deleted.delete_element("Line", "Line_3")
    assert [(e.kind, e.idx) for e in result.deleted] == [("Line", "Line_3")]
    assert result.disturbances == []
    assert "Line_3" not in {e.idx for e in result.topology.lines}

    switched_off = _wrapper()
    switched_off.edit_element("Line", "Line_3", {"u": 0})

    got, want = _voltages(deleted), _voltages(switched_off)
    assert got.keys() == want.keys()
    assert got == pytest.approx(want, abs=1e-9)
    # And it is not the case as it was loaded.
    assert got != pytest.approx(_voltages(_wrapper()), abs=1e-6)


def test_deleting_a_generator_is_refused_with_everything_on_it_then_takes_it_all() -> None:
    w = _wrapper("ieee14/ieee14.raw", "ieee14/ieee14.dyr")
    before = w.topology_snapshot()

    with pytest.raises(ElementHasDependentsError) as refused:
        w.delete_element("PV", "2")

    assert [(d["kind"], d["idx"]) for d in refused.value.dependents] == [
        ("GENROU", "GENROU_2"), ("IEEEG1", "IEEEG1_4"), ("EXST1", "EXST1_1"), ("ST2CUT", "ST2CUT_3"),
    ]
    assert refused.value.total == 4 and refused.value.disturbances == []
    assert "cascade=true" in str(refused.value)
    assert w.topology_snapshot() == before

    result = w.delete_element("PV", "2", cascade=True)

    assert [(e.kind, e.idx) for e in result.deleted] == [
        ("GENROU", "GENROU_2"), ("IEEEG1", "IEEEG1_4"), ("EXST1", "EXST1_1"),
        ("ST2CUT", "ST2CUT_3"), ("PV", 2),
    ]
    ss = w._ss
    assert ss is not None
    assert 2 not in ss.PV.idx.v and "GENROU_2" not in ss.GENROU.idx.v
    assert "EXST1_1" not in ss.EXST1.idx.v and "ST2CUT_3" not in ss.ST2CUT.idx.v
    # Nothing is left naming what went: the case sets up and runs.
    assert w.run_pflow().converged
    assert w.run_tds(tf=1.5).converged


def test_deleting_a_line_the_case_trips_takes_the_trip_and_the_run_goes_through() -> None:
    """``ieee14.dyr`` trips ``Line_1`` at 1 s and recloses it. With the line gone
    and the toggles left, ANDES sets up and then raises from inside the run."""
    w = _wrapper("ieee14/ieee14.raw", "ieee14/ieee14.dyr")
    assert [e.dev_idx for e in w.topology_snapshot().events] == ["Line_1", "Line_1"]

    with pytest.raises(ElementHasDependentsError) as refused:
        w.delete_element("Line", "Line_1")
    assert refused.value.dependents == [] and refused.value.total == 0
    assert refused.value.disturbances == [
        {"source": "case", "kind": "toggle", "model": "Line", "dev_idx": "Line_1",
         "t": 1.0, "name": "Toggle_1"},
        {"source": "case", "kind": "toggle", "model": "Line", "dev_idx": "Line_1",
         "t": 1.1, "name": "Toggle_2"},
    ]
    assert refused.value.disturbances_total == 2

    result = w.delete_element("Line", "Line_1", cascade=True)

    assert [d.name for d in result.disturbances] == ["Toggle_1", "Toggle_2"]
    assert result.topology.events == []
    assert result.topology.undo is not None and result.topology.undo.also == 2
    ss = w._ss
    assert ss is not None and ss.Toggle.n == 0
    tds = w.run_tds(tf=1.5)
    assert tds.converged and tds.final_t == pytest.approx(1.5)


def test_a_case_event_is_an_element_of_the_case_and_can_be_deleted() -> None:
    w = _wrapper("ieee14/ieee14.raw", "ieee14/ieee14.dyr")

    result = w.delete_element("Toggle", "Toggle_2")

    assert [(e.kind, e.idx) for e in result.deleted] == [("Toggle", "Toggle_2")]
    assert [(e.name, e.t) for e in result.topology.events] == [("Toggle_1", 1.0)]
    assert [e.name for e in w.undo_last_edit().events] == ["Toggle_1", "Toggle_2"]


def test_a_delete_keeps_the_pending_disturbances_that_act_elsewhere() -> None:
    """A delete builds the System again. The disturbances committed for the next
    run used to be lost in that, silently; they are added to the new System."""
    w = _wrapper("ieee14/ieee14.raw", "ieee14/ieee14.dyr")
    w.add_disturbance(FaultSpec(bus_idx=5, tf=1.0, tc=1.1, xf=0.05))
    w.add_disturbance(ToggleSpec(model="Line", dev_idx="Line_5", t=2.0))

    w.delete_element("Line", "Line_3")

    assert [spec.kind for spec in w.list_disturbances()] == ["fault", "toggle"]
    ss = w._ss
    assert ss is not None
    # The case's own two toggles of Line_1, and the one committed.
    assert list(ss.Fault.bus.v) == [5]
    assert list(ss.Toggle.dev.v) == ["Line_1", "Line_1", "Line_5"]
    tds = w.run_tds(tf=2.5)
    assert tds.converged
    # The toggle fired on the rebuilt System: the line is out at the end.
    assert float(ss.Line.u.v[ss.Line.idx2uid("Line_5")]) == 0.0


def test_a_delete_warns_about_the_pending_disturbances_on_it_and_undo_restores_them() -> None:
    w = _wrapper()
    fault_14 = FaultSpec(bus_idx=14, tf=1.0, tc=1.1)
    trip = ToggleSpec(model="Line", dev_idx="Line_13", t=2.0)
    fault_5 = FaultSpec(bus_idx=5, tf=3.0, tc=3.1)
    # The first is one a bundle import replayed, as ``import_bundle`` records it.
    w.add_disturbance(fault_14)
    w._restored_events.append(event_from_spec(fault_14))
    w.add_disturbance(trip)
    w.add_disturbance(fault_5)
    assert [e.source for e in w.topology_snapshot().events] == ["restored"]

    with pytest.raises(ElementHasDependentsError) as refused:
        w.delete_element("Bus", 14)
    assert [(d["source"], d["kind"], d["dev_idx"]) for d in refused.value.disturbances] == [
        ("restored", "fault", 14), ("committed", "toggle", "Line_13"),
    ]
    assert {d["kind"] for d in refused.value.dependents} == {"Line", "PQ", "Shunt"}
    assert w.list_disturbances() == [fault_14, trip, fault_5]

    result = w.delete_element("Bus", 14, cascade=True)

    assert [(d.source, d.kind) for d in result.disturbances] == [
        ("restored", "fault"), ("committed", "toggle"),
    ]
    assert w.list_disturbances() == [fault_5]
    assert result.topology.events == []
    ss = w._ss
    assert ss is not None
    assert list(ss.Fault.bus.v) == [5] and ss.Toggle.n == 0
    assert w._client_events == [("Fault", "Fault_1")]

    undone = w.undo_last_edit()

    assert w.list_disturbances() == [fault_14, trip, fault_5]
    assert [(e.source, e.kind, e.dev_idx) for e in undone.events] == [("restored", "fault", 14)]
    ss = w._ss
    assert ss is not None
    assert list(ss.Fault.bus.v) == [14, 5] and list(ss.Toggle.dev.v) == ["Line_13"]
    assert 14 in ss.Bus.idx.v

    # Putting the delete back takes the same two with it again.
    redone = w.redo_edit()
    assert w.list_disturbances() == [fault_5]
    assert redone.events == [] and redone.redo is None


def test_a_committed_disturbance_is_not_an_element_to_delete() -> None:
    w = _wrapper()
    idx = w.add_disturbance(ToggleSpec(model="Line", dev_idx="Line_5", t=2.0))

    with pytest.raises(ElementValidationError, match="committed for the next run"):
        w.delete_element("Toggle", idx)

    assert len(w.list_disturbances()) == 1


def test_delete_names_what_it_cannot_find() -> None:
    w = _wrapper()
    with pytest.raises(ElementValidationError, match="unknown model 'config'"):
        w.delete_element("config", "1")
    with pytest.raises(ElementNotFoundError, match="no Line with idx='Line_99'"):
        w.delete_element("Line", "Line_99")
    # A model ANDES has and the case does not.
    with pytest.raises(ElementNotFoundError, match="no GENCLS"):
        w.delete_element("GENCLS", "1")
    assert w._edit_log == []


# ---- Wrapper: undo and redo -------------------------------------------------


def test_undo_takes_back_the_last_edit_and_keeps_the_ones_before_it() -> None:
    """Undo used to drop the last add and, with it, every param edit: the System
    was built again from the adds alone."""
    w = _wrapper()
    w.edit_element("Bus", "3", {"vmax": 1.2})
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.edit_element("Line", "Line_3", {"rate_a": 150.0})
    w.add_element("Bus", {"idx": "101", "name": "B101", "Vn": 69.0})

    topo = w.undo_last_edit()

    assert "101" not in {str(b.idx) for b in topo.buses}
    assert "100" in {str(b.idx) for b in topo.buses}
    ss = w._ss
    assert ss is not None
    assert float(ss.Bus.vmax.v[ss.Bus.idx2uid(3)]) == 1.2
    assert float(ss.Line.rate_a.v[ss.Line.idx2uid("Line_3")]) == 150.0
    assert topo.undo is not None and (topo.undo.op, topo.undo.params) == ("edit", ("rate_a",))
    assert topo.redo is not None and (topo.redo.op, topo.redo.idx) == ("add", "101")

    # The next undo takes back the edit of the line, and only that.
    w.undo_last_edit()
    ss = w._ss
    assert ss is not None
    assert float(ss.Line.rate_a.v[ss.Line.idx2uid("Line_3")]) != 150.0
    assert float(ss.Bus.vmax.v[ss.Bus.idx2uid(3)]) == 1.2
    assert [type(op) for op in w._edit_log] == [EditOp, AddOp]


def test_an_undone_delete_is_the_topology_as_it_was_and_redo_deletes_it_again() -> None:
    w = _wrapper("ieee14/ieee14.raw", "ieee14/ieee14.dyr")
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    before = w.topology_snapshot()

    w.delete_element("Bus", 3, cascade=True)
    after = w.topology_snapshot()
    assert len(after.buses) == len(before.buses) - 1

    undone = w.undo_last_edit()
    for field in ("buses", "lines", "transformers", "generators", "loads", "shunts",
                  "controllers", "events"):
        assert getattr(undone, field) == getattr(before, field), field
    assert undone.undo == before.undo

    redone = w.redo_edit()
    assert redone == after
    assert isinstance(w._edit_log[-1], DeleteOp) and w._redo_log == []


def test_a_new_edit_leaves_nothing_to_redo() -> None:
    w = _wrapper()
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.undo_last_edit()
    assert w.topology_snapshot().redo is not None

    w.edit_element("Bus", "3", {"vmax": 1.2})

    assert w.topology_snapshot().redo is None
    with pytest.raises(ElementValidationError, match="no edits to redo"):
        w.redo_edit()


def test_redoing_a_delete_something_has_come_to_depend_on_is_refused() -> None:
    w = _wrapper()
    w.delete_element("Line", "Line_3")
    w.undo_last_edit()
    w.add_disturbance(ToggleSpec(model="Line", dev_idx="Line_3", t=1.0))

    with pytest.raises(ElementHasDependentsError) as refused:
        w.redo_edit()

    assert refused.value.disturbances_total == 1
    ss = w._ss
    assert ss is not None and "Line_3" in ss.Line.idx.v
    assert len(w._redo_log) == 1 and w._edit_log == []


def test_redoing_a_cascade_takes_what_it_took_before_and_is_refused_over_anything_new() -> None:
    """The cascade a redo makes is the one the delete made. A disturbance committed
    on the element since the undo is not part of it, and would go without a word."""
    w = _wrapper("kundur/kundur_full.xlsx")
    trip = ToggleSpec(model="Line", dev_idx="Line_0", t=2.0)
    w.add_disturbance(trip)
    first = w.delete_element("Bus", 5, cascade=True)
    assert [d.source for d in first.disturbances] == ["committed"]
    assert len(first.deleted) > 1
    w.undo_last_edit()
    fault = FaultSpec(bus_idx=5, tf=1.0, tc=1.1)
    w.add_disturbance(fault)

    with pytest.raises(ElementHasDependentsError) as refused:
        w.redo_edit()

    # Only what is new: the elements and the trip went with the bus before.
    assert refused.value.total == 0 and refused.value.dependents == []
    assert [(d["source"], d["kind"], d["dev_idx"]) for d in refused.value.disturbances] == [
        ("committed", "fault", 5)
    ]
    assert w.list_disturbances() == [trip, fault]
    ss = w._ss
    assert ss is not None and 5 in ss.Bus.idx.v
    assert len(w._redo_log) == 1 and w._edit_log == []


def test_undoing_the_add_of_an_element_a_pending_disturbance_acts_on_is_refused() -> None:
    w = _wrapper()
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.add_disturbance(FaultSpec(bus_idx="100", tf=1.0, tc=1.1))

    with pytest.raises(ElementValidationError, match="1 pending disturbance"):
        w.undo_last_edit()

    ss = w._ss
    assert ss is not None and "100" in ss.Bus.idx.v
    assert len(w._edit_log) == 1 and w._redo_log == []


def test_undo_and_redo_are_refused_once_the_system_is_set_up() -> None:
    w = _wrapper()
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.add_element("Bus", {"idx": "101", "name": "B101", "Vn": 69.0})
    w.undo_last_edit()
    w.run_pflow()

    with pytest.raises(DisturbanceCommitError):
        w.undo_last_edit()
    with pytest.raises(DisturbanceCommitError):
        w.redo_edit()
    with pytest.raises(DisturbanceCommitError):
        w.delete_element("Line", "Line_3")
    assert len(w._edit_log) == 1 and len(w._redo_log) == 1


def test_undo_is_the_way_out_of_an_edit_that_made_setup_fail() -> None:
    w = _wrapper()
    w.add_element("PQ", {"idx": "PQ_x", "name": "PQ_x", "bus": "999", "Vn": 69, "p0": 0.1, "q0": 0.0})
    with pytest.raises(SetupFailedError):
        w.run_pflow()
    with pytest.raises(SetupFailedError):
        w.delete_element("PQ", "PQ_x")

    topo = w.undo_last_edit()

    assert topo.state == "pre-setup" and topo.undo is None
    assert w.run_pflow().converged


def test_a_blank_sessions_reload_keeps_its_edits_and_deletes() -> None:
    """A blank session has no file: a reload used to replay its adds and nothing
    else, so a changed value came back as it was first given."""
    pytest.importorskip("andes")
    w = Wrapper()
    w.create_blank()
    for idx in ("1", "2", "3"):
        w.add_element("Bus", {"idx": idx, "name": f"B{idx}", "Vn": 100.0})
    w.edit_element("Bus", "1", {"Vn": 230.0})
    w.delete_element("Bus", "2")

    topo = w.reload_case()

    assert [(str(b.idx), b.params["Vn"]) for b in topo.buses] == [("1", 230.0), ("3", 100.0)]
    assert topo.undo is not None and topo.undo.op == "delete"
    # And the delete can still be taken back after it.
    assert [str(b.idx) for b in w.undo_last_edit().buses] == ["1", "2", "3"]


def test_a_blank_sessions_reload_drops_the_committed_disturbances() -> None:
    """As a case file's reload does. Left in the log, the next delete, undo or redo
    put them on the System it built, and a client that committed its list again
    after the reload had every disturbance twice: two toggles of one line at one
    time, which leave the line in."""
    pytest.importorskip("andes")
    w = Wrapper()
    w.create_blank()
    w.add_element("Bus", {"idx": "1", "name": "B1", "Vn": 110.0})
    w.add_element("Bus", {"idx": "2", "name": "B2", "Vn": 110.0})
    w.add_element("Slack", {"idx": "S1", "name": "S1", "bus": "1", "Sn": 100, "Vn": 110, "v0": 1.0})
    w.add_element("Line", {"idx": "L1", "name": "L1", "bus1": "1", "bus2": "2", "r": 0.01, "x": 0.06})
    w.add_element("Line", {"idx": "L2", "name": "L2", "bus1": "1", "bus2": "2", "r": 0.01, "x": 0.06})
    w.add_element("PQ", {"idx": "P1", "name": "P1", "bus": "2", "Vn": 110, "p0": 0.3, "q0": 0.1})
    w.add_element("PQ", {"idx": "P2", "name": "P2", "bus": "2", "Vn": 110, "p0": 0.2, "q0": 0.1})
    trip = ToggleSpec(model="Line", dev_idx="L2", t=1.0)
    w.add_disturbance(trip)
    w._restored_events.append(event_from_spec(trip))
    assert w.run_pflow().converged

    topo = w.reload_case()

    assert w.list_disturbances() == [] and topo.events == []

    def toggles() -> int:
        ss = w._ss
        assert ss is not None
        return int(ss.Toggle.n)

    assert toggles() == 0
    # None of the three rebuilds brings the trip back.
    w.delete_element("PQ", "P2")
    assert toggles() == 0
    w.undo_last_edit()
    assert toggles() == 0
    w.redo_edit()
    assert toggles() == 0 and w.list_disturbances() == []
    # Committed again, it is on the System once.
    w.add_disturbance(trip)
    ss = w._ss
    assert ss is not None
    assert list(ss.Toggle.dev.v) == ["L2"] and w.list_disturbances() == [trip]


def test_a_snapshot_restored_onto_a_blank_session_lists_its_disturbances_once(
    tmp_path: Path,
) -> None:
    """The restore reloads and adds the snapshot's disturbances. The reload left
    the session's own in the log, so the list held them twice and the System once."""
    pytest.importorskip("andes")
    w = Wrapper(workspace=tmp_path)
    w.create_blank()
    w.add_element("Bus", {"idx": "1", "name": "B1", "Vn": 110.0})
    w.add_element("Bus", {"idx": "2", "name": "B2", "Vn": 110.0})
    w.add_element("Slack", {"idx": "S1", "name": "S1", "bus": "1", "Sn": 100, "Vn": 110, "v0": 1.0})
    w.add_element("Line", {"idx": "L1", "name": "L1", "bus1": "1", "bus2": "2", "r": 0.01, "x": 0.06})
    w.add_element("PQ", {"idx": "P1", "name": "P1", "bus": "2", "Vn": 110, "p0": 0.3, "q0": 0.1})
    fault = FaultSpec(bus_idx="2", tf=0.2, tc=0.3, xf=0.01, rf=0.0)
    w.add_disturbance(fault)
    assert w.run_pflow().converged
    w.save_snapshot("held")

    w.restore_snapshot("held")

    assert w.list_disturbances() == [fault]
    ss = w._ss
    assert ss is not None and ss.Fault.n == 1
    assert [e.source for e in w.topology_snapshot().events] == ["restored"]


def test_an_element_added_without_an_idx_is_replayed_with_the_one_it_got() -> None:
    w = _wrapper()
    first = w.add_element("PQ", {"bus": "5", "Vn": 69, "p0": 0.1, "q0": 0.0})
    second = w.add_element("PQ", {"bus": "4", "Vn": 69, "p0": 0.2, "q0": 0.0})
    assert first.idx != second.idx

    # The first goes; the second keeps its idx through the rebuild, although
    # ANDES would now hand the first one's out again.
    w.delete_element("PQ", first.idx)

    ss = w._ss
    assert ss is not None
    assert second.idx in ss.PQ.idx.v and first.idx not in ss.PQ.idx.v
    assert ss.PQ.bus.v[ss.PQ.idx2uid(second.idx)] == 4


# ---- Wrapper: the log's limits and failures ---------------------------------


def test_an_edit_the_log_has_no_room_for_is_refused_before_it_is_made(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(wrapper_mod, "EDIT_LOG_MAX", 2)
    w = _wrapper()
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.edit_element("Bus", "100", {"Vn": 138.0})

    for edit in (
        lambda: w.add_element("Bus", {"idx": "101", "name": "B101", "Vn": 69.0}),
        lambda: w.edit_element("Bus", "100", {"Vn": 230.0}),
        lambda: w.delete_element("Line", "Line_3"),
        lambda: w.add_pmu("5"),
    ):
        with pytest.raises(ElementValidationError, match="holds 2 edits"):
            edit()

    ss = w._ss
    assert ss is not None
    assert "101" not in ss.Bus.idx.v and "Line_3" in ss.Line.idx.v and ss.PMU.n == 0
    assert float(ss.Bus.Vn.v[ss.Bus.idx2uid("100")]) == 138.0
    assert len(w._edit_log) == 2
    # Taking one back makes room again.
    w.undo_last_edit()
    w.add_element("Bus", {"idx": "101", "name": "B101", "Vn": 69.0})


def test_an_edit_refused_at_its_second_value_is_recorded_with_the_first() -> None:
    """The first value is on the System by then. An edit that left no entry would
    lose it at the next rebuild, and an undo would take back the edit before it."""
    w = _wrapper()
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.undo_last_edit()
    ss = w._ss
    assert ss is not None
    before = float(ss.Bus.vmin.v[ss.Bus.idx2uid(3)])

    class _Refusing(list[Any]):
        def __setitem__(self, *_args: Any) -> None:
            raise ValueError("synthetic")

    ss.Bus.vmin.v = _Refusing(ss.Bus.vmin.v)

    with pytest.raises(ElementValidationError, match="ANDES rejected Bus.vmin"):
        w.edit_element("Bus", "3", {"vmax": 1.2, "vmin": 0.8})

    assert w._edit_log == [EditOp(model="Bus", idx=3, params={"vmax": 1.2})]
    # A new edit, as far as it went: there is nothing to redo after it.
    assert w._redo_log == []
    # The next rebuild gives what the System held, and an undo takes it back.
    w.delete_element("Line", "Line_3")
    ss = w._ss
    assert ss is not None
    assert float(ss.Bus.vmax.v[ss.Bus.idx2uid(3)]) == 1.2
    assert float(ss.Bus.vmin.v[ss.Bus.idx2uid(3)]) == before
    w.undo_last_edit()
    w.undo_last_edit()
    ss = w._ss
    assert ss is not None
    assert float(ss.Bus.vmax.v[ss.Bus.idx2uid(3)]) != 1.2 and w._edit_log == []


def test_an_edit_refused_at_its_first_value_is_not_recorded() -> None:
    w = _wrapper()
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.undo_last_edit()
    ss = w._ss
    assert ss is not None

    class _Refusing(list[Any]):
        def __setitem__(self, *_args: Any) -> None:
            raise ValueError("synthetic")

    ss.Bus.vmax.v = _Refusing(ss.Bus.vmax.v)

    with pytest.raises(ElementValidationError, match="ANDES rejected Bus.vmax"):
        w.edit_element("Bus", "3", {"vmax": 1.2, "vmin": 0.8})

    # Nothing was written, so nothing is recorded and the redo stands.
    assert w._edit_log == [] and len(w._redo_log) == 1


def test_a_rebuild_a_disturbance_does_not_survive_leaves_the_session_as_it_was(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    w = _wrapper()
    w.add_element("Bus", {"idx": "100", "name": "B100", "Vn": 69.0})
    w.add_disturbance(FaultSpec(bus_idx=5, tf=1.0, tc=1.1))
    w.add_disturbance(ToggleSpec(model="Line", dev_idx="Line_5", t=2.0))
    held = (w._ss, list(w._edit_log), w.list_disturbances(), list(w._client_events),
            list(w._case_events))
    real = Wrapper.add_disturbance
    calls = 0

    def _second_one_fails(self: Wrapper, spec: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise DisturbanceValidationError("ANDES rejected Toggle spec: synthetic")
        return real(self, spec)

    monkeypatch.setattr(Wrapper, "add_disturbance", _second_one_fails)

    for rebuild in (lambda: w.delete_element("Line", "Line_3"), w.undo_last_edit):
        calls = 0
        with pytest.raises(DisturbanceValidationError):
            rebuild()
        assert w._ss is held[0]
        assert w._edit_log == held[1] and w._redo_log == []
        assert w.list_disturbances() == held[2]
        assert w._client_events == held[3] and w._case_events == held[4]
