"""Unit tests of the neutral edit log of a Sienna session.

Pure Python, no Julia: the log's validation, key assignment, undo and redo
are driven against a ``KeyBook`` built by hand.
"""

from __future__ import annotations

import pytest

from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.sienna.edit_log import (
    AddElementOp,
    RemoveElementOp,
    SetFieldOp,
    bucket_of_key,
    make_add,
    make_remove,
    make_set_field,
    ops_to_json,
    step_of,
)


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("bus:7", "bus", "Bus", 7, "engine"))
    book.assign(KeyEntry("bus:1", "bus", "Bus", 1, "engine"))
    book.assign(KeyEntry("load:7-1", "load", "PQ", "load71", "file"))
    book.assign(KeyEntry("gen:1-1", "generator", "PV", "generator-1-1", "file"))
    book.assign(KeyEntry("branch:1-7-1", "line", "Line", "1-7-i_1", "file"))
    book.assign(KeyEntry("shunt:7-1", "shunt", "Shunt", "7-1", "file"))
    return book


def test_bucket_of_key() -> None:
    assert bucket_of_key("load:7-1") == "load"
    assert bucket_of_key("shunt:7-1") == "shunt"
    assert bucket_of_key("gen:1-1") == "generator"
    assert bucket_of_key("branch:1-7-1") == "branch"
    assert bucket_of_key("bus:7") == "bus"
    assert bucket_of_key("gen:1-1/machine") is None
    assert bucket_of_key("engine:andes:PMU:3") is None
    assert bucket_of_key("not-a-key") is None


def test_make_set_field_stores_float() -> None:
    op = make_set_field(_book(), "load:7-1", "p_mw", 500)
    assert op == SetFieldOp(key="load:7-1", name="load71", field="p_mw", value=500.0)
    assert isinstance(op.value, float)


def test_make_set_field_unknown_key() -> None:
    with pytest.raises(ValueError, match=r"no element with key 'load:9-1' in the loaded case"):
        make_set_field(_book(), "load:9-1", "p_mw", 1.0)


def test_make_set_field_wrong_field_for_bucket() -> None:
    with pytest.raises(
        ValueError,
        match=r"the branch fields that can be edited are in_service; 'branch:1-7-1' is a branch",
    ):
        make_set_field(_book(), "branch:1-7-1", "p_mw", 1.0)


def test_make_set_field_bool_into_number() -> None:
    with pytest.raises(ValueError, match=r"p_mw of 'load:7-1' must be a number; got True"):
        make_set_field(_book(), "load:7-1", "p_mw", True)


def test_make_set_field_non_finite() -> None:
    with pytest.raises(ValueError, match=r"p_mw of 'load:7-1' must be a finite number"):
        make_set_field(_book(), "load:7-1", "p_mw", float("nan"))
    with pytest.raises(ValueError, match=r"p_mw of 'load:7-1' must be a finite number"):
        make_set_field(_book(), "load:7-1", "p_mw", float("inf"))


def test_make_set_field_in_service_requires_bool() -> None:
    with pytest.raises(ValueError, match=r"in_service of 'gen:1-1' must be true or false; got 1"):
        make_set_field(_book(), "gen:1-1", "in_service", 1)
    op = make_set_field(_book(), "gen:1-1", "in_service", False)
    assert op.value is False


def test_make_add_load_takes_smallest_free_ordinal() -> None:
    book = _book()
    op = make_add(book, "load", {"bus": 7, "p_mw": 10.0, "q_mvar": 1.0})
    assert op.key == "load:7-2"
    assert op.fields == {"bus": 7, "p_mw": 10.0, "q_mvar": 1.0}
    # A second add on the same book (with the first key now held) takes 7-3.
    book.assign(KeyEntry("load:7-2", "load", "PQ", "load72", "ordinal"))
    op2 = make_add(book, "load", {"bus": 7, "p_mw": 1.0, "q_mvar": 0.5})
    assert op2.key == "load:7-3"


def test_make_add_shunt() -> None:
    op = make_add(_book(), "shunt", {"bus": 7, "g_mw": 1.0, "b_mvar": 2.0, "in_service": False})
    assert op.key == "shunt:7-2"
    assert op.fields == {"bus": 7, "g_mw": 1.0, "b_mvar": 2.0, "in_service": False}


def test_make_add_rejects_other_kind() -> None:
    with pytest.raises(ValueError, match=r"only a load or a shunt can be added; got 'generator'"):
        make_add(_book(), "generator", {"bus": 7})


def test_make_add_missing_field() -> None:
    with pytest.raises(ValueError, match=r"a load needs bus, p_mw, q_mvar; got \['bus', 'p_mw'\]"):
        make_add(_book(), "load", {"bus": 7, "p_mw": 1.0})


def test_make_add_unknown_field() -> None:
    with pytest.raises(ValueError, match=r"a load needs bus, p_mw, q_mvar"):
        make_add(_book(), "load", {"bus": 7, "p_mw": 1.0, "q_mvar": 1.0, "Vn": 20.0})


def test_make_add_bus_not_int() -> None:
    with pytest.raises(ValueError, match=r"bus of the new load must be a bus number; got True"):
        make_add(_book(), "load", {"bus": True, "p_mw": 1.0, "q_mvar": 1.0})
    with pytest.raises(ValueError, match=r"bus of the new load must be a bus number; got '7'"):
        make_add(_book(), "load", {"bus": "7", "p_mw": 1.0, "q_mvar": 1.0})


def test_make_add_missing_bus() -> None:
    with pytest.raises(ValueError, match=r"no bus 9 in the loaded case"):
        make_add(_book(), "load", {"bus": 9, "p_mw": 1.0, "q_mvar": 1.0})


def test_make_remove_shunt() -> None:
    op = make_remove(_book(), "shunt:7-1")
    assert op == RemoveElementOp(key="shunt:7-1", name="7-1")


def test_make_remove_unknown_key() -> None:
    with pytest.raises(ValueError, match=r"no element with key 'load:9-1' in the loaded case"):
        make_remove(_book(), "load:9-1")


def test_make_remove_branch_refused() -> None:
    with pytest.raises(
        ValueError,
        match=r"only a load or a shunt can be removed; 'branch:1-7-1' is a line",
    ):
        make_remove(_book(), "branch:1-7-1")


def test_ops_to_json() -> None:
    import json

    ops = [
        SetFieldOp(key="load:7-1", name="load71", field="p_mw", value=500.0),
        AddElementOp(key="load:7-2", fields={"bus": 7, "p_mw": 10.0, "q_mvar": 1.0}),
        RemoveElementOp(key="shunt:7-1", name="7-1"),
    ]
    assert json.loads(ops_to_json(ops)) == [
        {"op": "set", "key": "load:7-1", "name": "load71", "field": "p_mw", "value": 500.0},
        {"op": "add", "key": "load:7-2", "fields": {"bus": 7, "p_mw": 10.0, "q_mvar": 1.0}},
        {"op": "remove", "key": "shunt:7-1", "name": "7-1"},
    ]


def test_step_of() -> None:
    assert step_of(SetFieldOp(key="load:7-1", name="load71", field="p_mw", value=1.0)) == {
        "op": "set",
        "key": "load:7-1",
        "field": "p_mw",
    }
    assert step_of(AddElementOp(key="load:7-2", fields={})) == {"op": "add", "key": "load:7-2"}
    assert step_of(RemoveElementOp(key="shunt:7-1", name="7-1")) == {
        "op": "remove",
        "key": "shunt:7-1",
    }
