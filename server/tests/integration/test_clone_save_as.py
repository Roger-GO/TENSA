"""Integration: clone-on-write save-as round-trip (Unit 21).

Per the plan's scenario: edit → save_as a new workspace name → load it →
edits preserved. Exercises the ``Wrapper`` delegation + a fresh
``andes.load`` of the saved case to prove the edit persisted to the workspace.
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
def kundur_wrapper(tmp_path: Path) -> tuple[Wrapper, Path]:
    cases = _bundled_cases_dir()
    workspace = tmp_path / "ws"
    workspace.mkdir()
    case = workspace / "kundur_full.xlsx"
    shutil.copy2(cases / "kundur" / "kundur_full.xlsx", case)
    w = Wrapper(workspace=workspace, session_id="save-as")
    w.load_case(case)
    return w, workspace


def test_save_as_persists_edit(kundur_wrapper: tuple[Wrapper, Path]) -> None:
    w, workspace = kundur_wrapper
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    result = w.save_clone_as("kundur_tuned")
    assert result["name"] == "kundur_tuned"

    saved = workspace / "kundur_tuned.xlsx"
    assert saved.exists()

    # Load the saved case fresh in a new wrapper → the edit is preserved.
    w2 = Wrapper(workspace=workspace, session_id="verify")
    w2.load_case(saved)
    w2._ensure_setup()
    assert float(list(w2._ss.TGOV1.T1.v)[0]) == pytest.approx(0.6)


def test_save_as_is_idempotent_overwrite(
    kundur_wrapper: tuple[Wrapper, Path],
) -> None:
    w, workspace = kundur_wrapper
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    w.save_clone_as("kundur_tuned")
    # A second edit + re-save overwrites the same name.
    w.apply_clone_edit("TGOV1", "1", "T1", 0.7)
    w.save_clone_as("kundur_tuned")

    w2 = Wrapper(workspace=workspace, session_id="verify2")
    w2.load_case(workspace / "kundur_tuned.xlsx")
    w2._ensure_setup()
    assert float(list(w2._ss.TGOV1.T1.v)[0]) == pytest.approx(0.7)
