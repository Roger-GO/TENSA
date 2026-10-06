"""The edit log's own logic, on a stand-in for an ANDES System.

What it does to a real System (and that the lists it edits are the ones ANDES
keeps) is in ``tests/integration/test_edit_log.py``. These tests need no ANDES:
the stand-in has the handful of attributes ``edit_log`` reads.
"""

from __future__ import annotations

from collections import OrderedDict, defaultdict
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from tensa.core.edit_log import (
    AddOp,
    DeleteOp,
    DroppedDisturbance,
    EditOp,
    EditStep,
    apply_op,
    dependents,
    device_position,
    held_idx,
    is_event,
    ops_from_dicts,
    ops_to_dicts,
    plain_idx,
    referrers,
    remove_device,
    spec_targets,
    step_of,
)

pytestmark = pytest.mark.unit


class _Param:
    def __init__(self, values: Any, model: str | None = None) -> None:
        self.v = values
        self.model = model


class _Model:
    """One model: params, of which ``refs`` (name -> target) are ``IdxParam``."""

    def __init__(self, group: str, refs: dict[str, str | None] | None = None, **columns: Any) -> None:
        self.group = group
        self.params: dict[str, _Param] = {}
        self.idx_params: dict[str, _Param] = {}
        for name, values in columns.items():
            param = _Param(values, (refs or {}).get(name))
            self.params[name] = param
            setattr(self, name, param)
            if refs is not None and name in refs:
                self.idx_params[name] = param
        self.n = len(self.params["idx"].v)
        self.uid = {idx: position for position, idx in enumerate(self.params["idx"].v)}
        self._param_corrections: dict[tuple[str, str], list[Any]] = defaultdict(list)


class _System:
    """Models in groups, with ``add`` the way ANDES does it for the columns given."""

    def __init__(self, **models: _Model) -> None:
        self.is_setup = False
        self.models = dict(models)
        self.model_aliases: dict[str, _Model] = {}
        self.groups: dict[str, Any] = {}
        for name, model in models.items():
            group = self.groups.setdefault(
                model.group, SimpleNamespace(_idx2model=OrderedDict(), uid={})
            )
            for idx in model.idx.v:  # type: ignore[attr-defined]
                group.uid[idx] = len(group._idx2model)
                group._idx2model[idx] = model
            setattr(self, name, model)

    def add(self, model: str, params: dict[str, Any]) -> Any:
        target = self.models[model]
        idx = params.pop("idx")
        target.uid[idx] = target.n
        target.n += 1
        for name, param in target.params.items():
            param.v.append(idx if name == "idx" else params.get(name))
        group = self.groups[target.group]
        group.uid[idx] = len(group._idx2model)
        group._idx2model[idx] = target
        return idx


def _system() -> _System:
    """Three buses, two lines, a generator with a machine and an exciter, and
    the events of a case: a fault on bus 2 and a trip of line L1."""
    return _System(
        Bus=_Model("ACNode", idx=[1, 2, 3], Vn=[110.0, 110.0, 20.0]),
        Line=_Model(
            "ACLine",
            refs={"bus1": "ACNode", "bus2": "ACNode"},
            idx=["L1", "L2"],
            bus1=[1, 2],
            bus2=[2, 3],
            r=[0.01, 0.02],
        ),
        PV=_Model("StaticGen", refs={"bus": "ACNode"}, idx=[1], bus=[3]),
        GENROU=_Model(
            "SynGen", refs={"bus": "ACNode", "gen": "StaticGen"}, idx=["G1"], bus=[3], gen=[1]
        ),
        EXST1=_Model("Exciter", refs={"syn": "SynGen"}, idx=["X1"], syn=["G1"]),
        Fault=_Model("TimedEvent", refs={"bus": "Bus"}, idx=["Fault_1"], bus=[2]),
        Toggle=_Model(
            "TimedEvent", refs={"dev": None}, idx=["Toggle_1"], model=["Line"], dev=["L1"]
        ),
        Alter=_Model(
            "TimedEvent",
            refs={"dev": None, "src": None},
            idx=["Alter_1"],
            model=["PV"],
            dev=[1],
            src=["L2"],
        ),
    )


# ---- devices ----------------------------------------------------------------


def test_a_device_is_found_as_the_model_holds_it_or_by_its_text() -> None:
    ss = _system()
    assert device_position(ss.models["Bus"], 2) == 1
    assert device_position(ss.models["Bus"], "2") == 1
    assert device_position(ss.models["Line"], "L2") == 1
    assert device_position(ss.models["Bus"], 9) is None
    assert held_idx(ss.models["Bus"], "3") == 3
    assert held_idx(ss.models["Bus"], "9") is None


def test_an_idx_held_as_text_is_not_taken_for_the_number_of_another_device() -> None:
    mixed = _Model("ACNode", idx=["1", 1])
    assert device_position(mixed, 1) == 1
    assert device_position(mixed, "1") == 0
    # A number is the same number in whatever integer type it was read into.
    assert device_position(mixed, np.int64(1)) == 1
    assert device_position(_Model("ACNode", idx=["1", np.int64(1)]), 1) == 1


def test_plain_idx_turns_a_numpy_scalar_into_what_json_takes() -> None:
    assert plain_idx(np.int64(5)) == 5 and type(plain_idx(np.int64(5))) is int
    assert plain_idx(np.str_("Line_3")) == "Line_3"
    assert plain_idx(7) == 7 and plain_idx("7") == "7" and plain_idx(None) is None
    assert plain_idx(2.0) == "2.0"


def test_remove_device_takes_the_entry_out_of_every_list_and_numbers_the_rest() -> None:
    ss = _system()
    line = ss.models["Line"]
    line._param_corrections[("r", "zero")].extend(["L1", "L2"])

    remove_device(ss, "Line", "L1")

    assert line.n == 1 and line.uid == {"L2": 0}
    assert {name: param.v for name, param in line.params.items()} == {
        "idx": ["L2"], "bus1": [2], "bus2": [3], "r": [0.02],
    }
    assert line._param_corrections[("r", "zero")] == ["L2"]
    group = ss.groups["ACLine"]
    assert list(group._idx2model) == ["L2"] and group.uid == {"L2": 0}
    # The other models are as they were.
    assert ss.models["Bus"].n == 3 and list(ss.groups["ACNode"]._idx2model) == [1, 2, 3]


def test_remove_device_cuts_arrays_too_and_leaves_what_is_not_per_device() -> None:
    """A param a parser linked early holds arrays, and one that holds nothing
    yet (or a scalar) is not the device's to lose."""
    ss = _system()
    bus = ss.models["Bus"]
    bus.params["ue"] = _Param(np.array([1.0, 0.0, 1.0]))
    bus.params["ue"].vin = np.array([1.0, 0.0, 1.0])  # type: ignore[attr-defined]
    bus.params["ue"].pu_coeff = np.array(1.0)  # type: ignore[attr-defined]
    bus.params["late"] = _Param([])

    remove_device(ss, "Bus", "2")

    assert list(bus.params["ue"].v) == [1.0, 1.0]
    assert list(bus.params["ue"].vin) == [1.0, 1.0]  # type: ignore[attr-defined]
    assert bus.params["ue"].pu_coeff.ndim == 0  # type: ignore[attr-defined]
    assert bus.params["late"].v == []
    assert bus.Vn.v == [110.0, 20.0] and bus.uid == {1: 0, 3: 1}  # type: ignore[attr-defined]


def test_remove_device_keeps_the_group_order_of_the_other_models() -> None:
    ss = _System(
        PV=_Model("StaticGen", idx=[2, 3]),
        Slack=_Model("StaticGen", idx=[1]),
    )
    remove_device(ss, "PV", 2)
    group = ss.groups["StaticGen"]
    assert list(group._idx2model) == [3, 1] and group.uid == {3: 0, 1: 1}
    assert group._idx2model[1] is ss.models["Slack"]


def test_remove_device_refuses_a_missing_device_and_a_system_that_is_set_up() -> None:
    ss = _system()
    with pytest.raises(KeyError, match="no Bus with idx=9"):
        remove_device(ss, "Bus", 9)
    ss.is_setup = True
    with pytest.raises(RuntimeError, match="set up"):
        remove_device(ss, "Bus", 1)
    assert ss.models["Bus"].n == 3


# ---- references -------------------------------------------------------------


def test_referrers_are_the_devices_that_name_a_target() -> None:
    ss = _system()
    # Bus 3: the second line, the generator and the machine. The Alter's ``src``
    # holds "L2" and is no reference; its ``dev`` names PV 1, not bus 1.
    assert referrers(ss, [("Bus", 3)]) == [("Line", "L2"), ("PV", 1), ("GENROU", "G1")]
    assert referrers(ss, [("Bus", 1)]) == [("Line", "L1")]
    assert referrers(ss, [("PV", 1)]) == [("GENROU", "G1"), ("Alter", "Alter_1")]
    assert referrers(ss, [("Line", "L2")]) == []
    # A device named by two of a referrer's params is listed once.
    assert referrers(ss, [("Bus", 1), ("Bus", 2)]) == [
        ("Line", "L1"), ("Line", "L2"), ("Fault", "Fault_1"),
    ]


def test_a_reference_is_matched_the_way_andes_looks_it_up() -> None:
    ss = _system()
    # The case holds bus 3 as a number; "3" names no bus to ANDES.
    assert referrers(ss, [("Bus", "3")]) == []


def test_dependents_go_down_to_whatever_names_a_dependent() -> None:
    ss = _system()
    assert dependents(ss, "PV", 1) == [
        ("GENROU", "G1"), ("Alter", "Alter_1"), ("EXST1", "X1"),
    ]
    found = dependents(ss, "Bus", 2)
    assert found == [
        ("Line", "L1"), ("Line", "L2"), ("Fault", "Fault_1"), ("Toggle", "Toggle_1"),
    ]
    assert [ref for ref in found if is_event(ss, ref[0])] == [
        ("Fault", "Fault_1"), ("Toggle", "Toggle_1"),
    ]
    assert dependents(ss, "EXST1", "X1") == []


def test_a_pending_disturbance_targets_a_device_by_model_or_group_and_text() -> None:
    ss = _system()
    fault = FaultSpec(bus_idx="2", tf=1.0, tc=1.1)
    trip = ToggleSpec(model="Line", dev_idx="L2", t=1.0)
    by_group = ToggleSpec(model="ACLine", dev_idx="L2", t=1.0)
    alter = AlterSpec(model="PV", dev_idx="1", src="p0", t=1.0, method="+", amount=0.1)

    assert spec_targets(ss, fault, [("Bus", 2)])
    assert not spec_targets(ss, fault, [("Bus", 1), ("Line", "L1")])
    assert spec_targets(ss, trip, [("Bus", 1), ("Line", "L2")])
    assert spec_targets(ss, by_group, [("Line", "L2")])
    assert not spec_targets(ss, trip, [("Line", "L1")])
    assert spec_targets(ss, alter, [("PV", 1)])
    # The same idx in another model is another device.
    assert not spec_targets(ss, alter, [("Bus", 1)])


# ---- the log ----------------------------------------------------------------


def test_replaying_the_log_does_each_edit_in_turn() -> None:
    ss = _system()
    params = {"idx": "L3", "bus1": 1, "bus2": 3, "r": 0.03}
    ops = [
        AddOp("Line", params),
        EditOp("Line", "L3", {"r": 0.5, "bus2": 2}),
        DeleteOp("Line", "L1", devices=(("Toggle", "Toggle_1"), ("Line", "L1"))),
    ]

    for op in ops:
        apply_op(ss, op)

    line = ss.models["Line"]
    assert line.idx.v == ["L2", "L3"] and line.r.v == [0.02, 0.5]  # type: ignore[attr-defined]
    assert line.bus2.v == [3, 2]  # type: ignore[attr-defined]
    assert ss.models["Toggle"].n == 0
    # The log's own copy of the params is not the dict ANDES emptied.
    assert params == {"idx": "L3", "bus1": 1, "bus2": 3, "r": 0.03}


def test_replaying_an_edit_of_a_device_that_is_not_there_says_so() -> None:
    with pytest.raises(KeyError, match="no Line with idx='L9'"):
        apply_op(_system(), EditOp("Line", "L9", {"r": 0.5}))


def test_each_entry_names_what_it_did() -> None:
    assert step_of(AddOp("Bus", {"idx": np.int64(4), "Vn": 110})) == EditStep(
        op="add", model="Bus", idx=4
    )
    assert step_of(EditOp("Line", "L1", {"r": 0.1, "x": 0.2})) == EditStep(
        op="edit", model="Line", idx="L1", params=("r", "x")
    )
    assert step_of(
        DeleteOp("Bus", 2, devices=(("Line", "L1"), ("Line", "L2"), ("Bus", 2)))
    ) == EditStep(op="delete", model="Bus", idx=2, also=2)


def test_the_log_crosses_a_pipe_as_plain_dicts_without_what_is_not_replayed() -> None:
    dropped = DroppedDisturbance(position=0, spec=FaultSpec(bus_idx=2, tf=1.0, tc=1.1))
    ops = [
        AddOp("Bus", {"idx": 4, "Vn": 110.0}),
        EditOp("Bus", 4, {"Vn": 230.0}),
        DeleteOp("Bus", 2, devices=(("Line", "L1"), ("Bus", 2)), dropped=(dropped,)),
    ]

    rows = ops_to_dicts(ops)

    assert rows == [
        {"op": "add", "model": "Bus", "params": {"idx": 4, "Vn": 110.0}},
        {"op": "edit", "model": "Bus", "idx": 4, "params": {"Vn": 230.0}},
        {"op": "delete", "model": "Bus", "idx": 2, "devices": [["Line", "L1"], ["Bus", 2]]},
    ]
    back = ops_from_dicts(rows)
    assert back[:2] == ops[:2]
    assert back[2] == DeleteOp("Bus", 2, devices=(("Line", "L1"), ("Bus", 2)))
    # Copies: a row edited afterwards does not reach the log it came from.
    rows[0]["params"]["Vn"] = 0.0
    assert ops[0].params["Vn"] == 110.0

    with pytest.raises(ValueError, match="unknown edit 'rename'"):
        ops_from_dicts([{"op": "rename"}])
