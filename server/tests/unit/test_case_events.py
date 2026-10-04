"""Unit tests for the timed events a case defines, read off a System.

``events_in_case`` lists the ``Fault``, ``Toggle`` and ``Alter`` devices of a System
just loaded from a case file, so a client can say what a run will do besides what it
scheduled itself. A device that cannot act must not be listed, and a listed one must
be plain JSON-able data (ANDES hands back numpy scalars).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core.case_events import CaseEvent, event_from_spec, events_in_case
from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec

pytestmark = pytest.mark.unit


def _model(**columns: Any) -> Any:
    """A stand-in ANDES model: each column is a param whose ``.v`` holds the values."""
    return SimpleNamespace(**{name: SimpleNamespace(v=values) for name, values in columns.items()})


def _system(**models: Any) -> Any:
    return SimpleNamespace(**models)


def test_a_system_without_events_lists_none() -> None:
    empty = _model(idx=[], u=[], name=[], model=[], dev=[], t=[])
    assert events_in_case(_system(Toggle=empty, Fault=_model(idx=[]), Alter=None)) == []
    assert events_in_case(_system()) == []


def test_a_toggle_names_the_device_it_flips_and_when() -> None:
    toggle = _model(
        idx=[1], u=np.array([1.0]), name=["Toggler_1"], model=["Line"], dev=["Line_8"], t=np.array([2.0])
    )
    assert events_in_case(_system(Toggle=toggle)) == [
        CaseEvent(
            source="case", kind="toggle", t=2.0, name="Toggler_1", model="Line", dev_idx="Line_8"
        )
    ]


def test_a_fault_names_its_bus_and_when_it_starts_and_clears() -> None:
    fault = _model(
        idx=["F1"], u=[1], name=["Fault_1"], bus=[np.int64(7)], tf=[1.0], tc=[1.1], xf=[0.05], rf=[0]
    )
    (event,) = events_in_case(_system(Fault=fault))
    assert event == CaseEvent(
        source="case", kind="fault", t=1.0, name="Fault_1", tc=1.1, model="Bus", dev_idx=7
    )
    # A numpy idx is a plain int, so the event serialises.
    assert type(event.dev_idx) is int


def test_a_fault_with_no_clearing_time_is_never_cleared() -> None:
    # ANDES gives a TimerParam -1 when the case leaves it out.
    fault = _model(idx=[1], u=[1], name=["F"], bus=[3], tf=[1.0], tc=[-1.0])
    (event,) = events_in_case(_system(Fault=fault))
    assert event.tc is None


def test_an_alter_carries_what_it_changes() -> None:
    alter = _model(
        idx=[1],
        u=[1],
        name=["Alter_1"],
        model=["PQ"],
        dev=["PQ_1"],
        src=["Ppf"],
        t=[3.0],
        method=["*"],
        amount=[1.2],
    )
    assert events_in_case(_system(Alter=alter)) == [
        CaseEvent(
            source="case",
            kind="alter",
            t=3.0,
            name="Alter_1",
            model="PQ",
            dev_idx="PQ_1",
            src="Ppf",
            method="*",
            amount=1.2,
        )
    ]


def test_a_device_that_cannot_act_is_left_out() -> None:
    toggle = _model(
        idx=[1, 2, 3, 4],
        u=[1, 0, 1, 1],  # the second is switched off
        name=["on", "off", "never", "nan"],
        model=["Line"] * 4,
        dev=["L1", "L2", "L3", "L4"],
        t=[2.0, 2.0, -1.0, float("nan")],  # the third has no time (-1), the fourth a bad one
    )
    assert [e.name for e in events_in_case(_system(Toggle=toggle))] == ["on"]


def test_events_come_out_in_time_order_across_models() -> None:
    toggle = _model(idx=[1], u=[1], name=["T"], model=["Line"], dev=["L1"], t=[2.0])
    fault = _model(idx=[1], u=[1], name=["F"], bus=[1], tf=[0.5], tc=[0.6])
    alter = _model(
        idx=[1], u=[1], name=["A"], model=["PQ"], dev=["P"], src=["Ppf"], t=[1.0], method=["="], amount=[0]
    )
    events = events_in_case(_system(Toggle=toggle, Fault=fault, Alter=alter))
    assert [(e.kind, e.t) for e in events] == [("fault", 0.5), ("alter", 1.0), ("toggle", 2.0)]


def test_a_replayed_fault_is_a_restored_event() -> None:
    assert event_from_spec(FaultSpec(bus_idx=5, tf=1.0, tc=1.1)) == CaseEvent(
        source="restored", kind="fault", t=1.0, tc=1.1, model="Bus", dev_idx=5
    )


def test_a_replayed_toggle_and_alter_are_restored_events() -> None:
    assert event_from_spec(ToggleSpec(model="Line", dev_idx="Line_2", t=1.5)) == CaseEvent(
        source="restored", kind="toggle", t=1.5, model="Line", dev_idx="Line_2"
    )
    assert event_from_spec(
        AlterSpec(model="PQ", dev_idx=4, src="Ppf", t=2.0, method="+", amount=0.2)
    ) == CaseEvent(
        source="restored",
        kind="alter",
        t=2.0,
        model="PQ",
        dev_idx=4,
        src="Ppf",
        method="+",
        amount=0.2,
    )
