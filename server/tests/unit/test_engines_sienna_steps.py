"""A Sienna topology names the edits undo and redo would act on, as an ANDES
topology does (``undo`` and ``redo``, ``tensa.core.edit_log.EditStep``), with
the fake bridge of ``test_engines_sienna_edits.py``. No Julia.
"""

from __future__ import annotations

from tensa.core.edit_log import EditStep
from tensa.engines.sienna.state import SiennaState
from tests.unit.test_engines_sienna_edits import loaded, state, workspace  # noqa: F401 - the fixtures

__all__ = ["loaded", "state", "workspace"]


def test_a_fresh_case_has_nothing_to_undo_or_redo(loaded: SiennaState) -> None:  # noqa: F811
    topology = loaded.topology()
    assert topology.undo is None
    assert topology.redo is None


def test_an_edit_is_named_by_model_idx_and_andes_param(loaded: SiennaState) -> None:  # noqa: F811
    answered = loaded.edit_element("load:7-1", "p_mw", 500.0)
    expected = EditStep(op="edit", model="PQ", idx="load71", params=("p0",))
    assert answered.undo == expected
    assert answered.redo is None
    assert loaded.topology().undo == expected


def test_undo_and_redo_move_the_steps(loaded: SiennaState) -> None:  # noqa: F811
    loaded.edit_element("load:7-1", "p_mw", 500.0)
    loaded.edit_element("load:7-1", "q_mvar", 50.0)
    after_undo = loaded.undo_last_edit()
    assert after_undo.undo == EditStep(op="edit", model="PQ", idx="load71", params=("p0",))
    assert after_undo.redo == EditStep(op="edit", model="PQ", idx="load71", params=("q0",))
    after_redo = loaded.redo_edit()
    assert after_redo.undo == EditStep(op="edit", model="PQ", idx="load71", params=("q0",))
    assert after_redo.redo is None


def test_a_delete_names_the_element_it_took_out(loaded: SiennaState) -> None:  # noqa: F811
    answered = loaded.delete_element("shunt:7-1")
    assert answered.undo is not None
    assert answered.undo.op == "delete"
    assert answered.undo.model == "Shunt"
    assert answered.undo.idx == "7-1"
    undone = loaded.undo_last_edit()
    assert undone.undo is None
    assert undone.redo is not None and undone.redo.op == "delete"
