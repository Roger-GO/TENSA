"""Integration: clone-on-write save-as round-trip (Unit 21).

Per the plan's scenario: edit → save_as a new workspace name → load it →
edits preserved. Exercises the ``Wrapper`` delegation + a fresh
``andes.load`` of the saved case to prove the edit persisted to the workspace.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from tensa.core.errors import CloneEditError
from tensa.core.layout import parse_layout, read_layout_sidecar, write_layout_sidecar
from tensa.core.wrapper import Wrapper

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


def test_save_as_refuses_collision_then_overwrites_with_flag(
    kundur_wrapper: tuple[Wrapper, Path],
) -> None:
    w, workspace = kundur_wrapper
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    w.save_clone_as("kundur_tuned")

    # A second re-save to the SAME name is refused by default (data-loss guard).
    w.apply_clone_edit("TGOV1", "1", "T1", 0.7)
    with pytest.raises(CloneEditError, match="already exists"):
        w.save_clone_as("kundur_tuned")
    # The first save is intact (not half-clobbered): still the 0.6 edit.
    w_check = Wrapper(workspace=workspace, session_id="check")
    w_check.load_case(workspace / "kundur_tuned.xlsx")
    w_check._ensure_setup()
    assert float(list(w_check._ss.TGOV1.T1.v)[0]) == pytest.approx(0.6)

    # An explicit overwrite=True re-save succeeds.
    w.save_clone_as("kundur_tuned", overwrite=True)
    w2 = Wrapper(workspace=workspace, session_id="verify2")
    w2.load_case(workspace / "kundur_tuned.xlsx")
    w2._ensure_setup()
    assert float(list(w2._ss.TGOV1.T1.v)[0]) == pytest.approx(0.7)


def test_save_as_refuses_to_clobber_the_loaded_original(
    kundur_wrapper: tuple[Wrapper, Path],
) -> None:
    # The headline invariant: a save-as named after the loaded original must
    # NOT silently destroy it.
    w, workspace = kundur_wrapper
    original = workspace / "kundur_full.xlsx"
    original_bytes = original.read_bytes()
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    with pytest.raises(CloneEditError, match="already exists"):
        w.save_clone_as("kundur_full")
    # The original is byte-for-byte untouched.
    assert original.read_bytes() == original_bytes


def _kundur_layout() -> dict[str, object]:
    return {
        "schema_version": "2",
        "andes_version": "2.0.0",
        "coordinates": {str(i): {"x": 80.0 * i, "y": 40.0 * (i % 2)} for i in range(1, 11)},
        "non_bus_coordinates": {"generator": {"1": {"x": 60.0, "y": -70.0}}},
        "units": {"1": {"expanded": True, "bus": "1"}},
        "last_modified": "2026-10-06T08:00:00+00:00",
    }


def test_save_as_takes_the_diagram_layout_to_the_new_case(
    kundur_wrapper: tuple[Wrapper, Path],
) -> None:
    """The saved case is the open one with edited parameters, so it opens with
    the diagram as it was placed. Before, the copy came up in the automatic
    layout because nothing wrote a layout beside it."""
    w, workspace = kundur_wrapper
    placed = parse_layout(_kundur_layout())
    write_layout_sidecar(workspace / "kundur_full.xlsx", placed)

    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    w.save_clone_as("kundur_tuned")

    carried = read_layout_sidecar(workspace / "kundur_tuned.xlsx")
    assert carried is not None
    assert carried.model_dump() == placed.model_dump()
    # The original keeps its own.
    assert read_layout_sidecar(workspace / "kundur_full.xlsx") == placed


def test_save_as_of_a_case_with_no_layout_writes_none(
    kundur_wrapper: tuple[Wrapper, Path],
) -> None:
    w, workspace = kundur_wrapper
    # A layout left behind by an earlier file of the name the save is about to take.
    (workspace / "kundur_tuned.xlsx.layout.json").write_text(
        json.dumps(_kundur_layout()), encoding="utf-8"
    )
    w.init_clone()
    w.apply_clone_edit("TGOV1", "1", "T1", 0.6)
    w.save_clone_as("kundur_tuned")
    assert (workspace / "kundur_tuned.xlsx").exists()
    assert not (workspace / "kundur_tuned.xlsx.layout.json").exists()
