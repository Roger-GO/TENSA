"""Unit tests for the starter example-case seeder (``core.examples``).

All filesystem interaction happens under ``tmp_path``; the andes cases
directory is monkeypatched so the tests never depend on a real andes
install.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tensa.core import examples
from tensa.core.examples import seed_example_cases


@pytest.fixture
def fake_cases_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake ``andes/cases`` tree holding the three bundled examples."""
    cases = tmp_path / "andes_pkg" / "cases"
    for rel in ("ieee14/ieee14_full.xlsx", "kundur/kundur_full.xlsx", "wscc9/wscc9.xlsx"):
        target = cases / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"fake-xlsx:" + rel.encode())
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: cases)
    return cases


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    return ws


def test_seeds_empty_workspace(fake_cases_dir: Path, workspace: Path) -> None:
    """An empty workspace receives all three bundled examples."""
    copied = seed_example_cases(workspace)
    assert sorted(copied) == [
        "ieee14_full.xlsx",
        "kundur_full.xlsx",
        "wscc9.xlsx",
    ]
    for name in copied:
        dest = workspace / name
        assert dest.is_file()
        # copy2 content fidelity
        src_rel = next(
            rel for rel in ("ieee14/ieee14_full.xlsx", "kundur/kundur_full.xlsx", "wscc9/wscc9.xlsx")
            if rel.endswith(name)
        )
        assert dest.read_bytes() == (fake_cases_dir / src_rel).read_bytes()


def test_does_not_seed_when_case_files_exist(
    fake_cases_dir: Path, workspace: Path
) -> None:
    """A workspace with ANY supported case file is left untouched."""
    existing = workspace / "mycase.raw"
    existing.write_text("user data")
    assert seed_example_cases(workspace) == []
    assert sorted(p.name for p in workspace.iterdir()) == ["mycase.raw"]
    assert existing.read_text() == "user data"


def test_does_not_reseed_after_first_seed(
    fake_cases_dir: Path, workspace: Path
) -> None:
    """A second call sees the seeded files as case files and is a no-op."""
    first = seed_example_cases(workspace)
    assert len(first) == 3
    # User deletes two of the three; the survivor still blocks re-seeding.
    (workspace / "kundur_full.xlsx").unlink()
    (workspace / "wscc9.xlsx").unlink()
    assert seed_example_cases(workspace) == []
    assert sorted(p.name for p in workspace.iterdir()) == ["ieee14_full.xlsx"]


def test_non_case_files_do_not_block_seeding(
    fake_cases_dir: Path, workspace: Path
) -> None:
    """Unsupported extensions, hidden files, and directories don't count as
    case files — the workspace is still 'empty' for seeding purposes."""
    (workspace / "notes.txt").write_text("hi")
    (workspace / ".hidden.xlsx").write_text("hidden")
    (workspace / "subdir").mkdir()
    copied = seed_example_cases(workspace)
    assert len(copied) == 3


def test_missing_andes_cases_dir_is_a_warning_not_a_crash(
    workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When andes's bundled cases can't be located, seeding logs and skips."""
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: None)
    with caplog.at_level("WARNING", logger="tensa.examples"):
        assert seed_example_cases(workspace) == []
    assert any("skipping example-case seeding" in r.message for r in caplog.records)
    assert list(workspace.iterdir()) == []


def test_partial_bundle_copies_what_exists(
    fake_cases_dir: Path,
    workspace: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A missing individual bundled case is skipped with a warning; the
    remaining cases are still seeded."""
    (fake_cases_dir / "wscc9" / "wscc9.xlsx").unlink()
    with caplog.at_level("WARNING", logger="tensa.examples"):
        copied = seed_example_cases(workspace)
    assert sorted(copied) == ["ieee14_full.xlsx", "kundur_full.xlsx"]
    assert any("bundled example case missing" in r.message for r in caplog.records)


def test_seeder_never_raises(
    fake_cases_dir: Path, tmp_path: Path
) -> None:
    """A bogus workspace path (resolve fails inside list_workspace_files)
    is swallowed into an empty result — startup must never crash."""
    assert seed_example_cases(tmp_path / "does-not-exist") == []
