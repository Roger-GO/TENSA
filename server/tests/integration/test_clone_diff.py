"""Integration: clone-vs-original diff against a real ANDES System (Unit 23).

Per the plan's Unit 23 scenario: load kundur_full → init clone → edit a
controller param → ``clone_diff`` reports ``{param: {original, current}}`` for
that param; unedited params are absent. Undoing the edit empties the diff again.

Exercises the ``Wrapper.clone_diff`` delegation method — the exact surface the
worker dispatches to via the ``clone_diff`` handler — without spinning a server.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from andes_app.core.wrapper import Wrapper

pytestmark = pytest.mark.integration


def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
def kundur_wrapper(tmp_path: Path) -> Wrapper:
    cases = _bundled_cases_dir()
    workspace = tmp_path / "ws"
    workspace.mkdir()
    case = workspace / "kundur_full.xlsx"
    shutil.copy2(cases / "kundur" / "kundur_full.xlsx", case)
    w = Wrapper(workspace=workspace, session_id="diff-flow")
    w.load_case(case)
    return w


def test_diff_reports_edited_param(kundur_wrapper: Wrapper) -> None:
    w = kundur_wrapper
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)

    diff = w.clone_diff("TGOV1", "1")
    params = diff["params"]
    assert "T1" in params
    assert params["T1"]["original"] == pytest.approx(0.49)
    assert params["T1"]["current"] == pytest.approx(0.6)


def test_diff_omits_unedited_params(kundur_wrapper: Wrapper) -> None:
    w = kundur_wrapper
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)

    diff = w.clone_diff("TGOV1", "1")
    # Only the edited param appears — every other whitelisted param is absent.
    assert list(diff["params"].keys()) == ["T1"]


def test_diff_empty_before_any_edit(kundur_wrapper: Wrapper) -> None:
    w = kundur_wrapper
    w.init_clone()
    # A fresh clone (no edits) byte-matches the original — empty diff.
    diff = w.clone_diff("TGOV1", "1")
    assert diff["params"] == {}


def test_diff_empty_without_clone(kundur_wrapper: Wrapper) -> None:
    w = kundur_wrapper
    # No init_clone called — nothing to diff.
    diff = w.clone_diff("TGOV1", "1")
    assert diff["params"] == {}


def test_diff_empty_after_undo(kundur_wrapper: Wrapper) -> None:
    w = kundur_wrapper
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    assert "T1" in w.clone_diff("TGOV1", "1")["params"]

    w.undo_clone_edit()
    assert w.clone_diff("TGOV1", "1")["params"] == {}


def test_diff_unknown_idx_is_empty(kundur_wrapper: Wrapper) -> None:
    w = kundur_wrapper
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    # An idx with no matching device yields an empty diff (not an error).
    diff = w.clone_diff("TGOV1", "does-not-exist")
    assert diff["params"] == {}


def test_diff_rejects_non_controller_model(kundur_wrapper: Wrapper) -> None:
    from andes_app.core.errors import ElementValidationError

    w = kundur_wrapper
    w.init_clone()
    with pytest.raises(ElementValidationError):
        w.clone_diff("Bus", "1")
