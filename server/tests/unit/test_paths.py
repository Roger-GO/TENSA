"""Unit tests for workspace path canonicalization."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from andes_app.security.paths import (
    WorkspacePathError,
    ensure_workspace,
    open_workspace_file_for_andes,
)


@pytest.mark.unit
def test_ensure_workspace_creates_directory_with_safe_mode(tmp_path: Path) -> None:
    target = tmp_path / "fresh-workspace"
    workspace = ensure_workspace(target)
    assert workspace.is_dir()
    if sys.platform != "win32":
        import stat

        mode = stat.S_IMODE(os.stat(workspace).st_mode)
        assert mode == 0o700, f"expected 0700, got {oct(mode)}"


@pytest.mark.unit
def test_ensure_workspace_existing_dir_is_idempotent(tmp_path: Path) -> None:
    canonical_a = ensure_workspace(tmp_path)
    canonical_b = ensure_workspace(tmp_path)
    assert canonical_a == canonical_b


@pytest.mark.unit
def test_open_workspace_file_happy_path(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path)
    case = workspace / "ieee14.raw"
    case.write_text("dummy content")
    with open_workspace_file_for_andes(workspace, "ieee14.raw") as canonical:
        assert canonical == case
        assert canonical.suffix == ".raw"  # extension preserved


@pytest.mark.unit
def test_open_workspace_file_rejects_traversal(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    # Create a file outside the workspace
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    with (
        pytest.raises(WorkspacePathError),
        open_workspace_file_for_andes(workspace, "../outside.txt"),
    ):
        pass


@pytest.mark.unit
def test_open_workspace_file_rejects_absolute_path(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    # ``/etc/passwd`` is the canonical bad-input test on POSIX. On Windows
    # use a clearly-absolute path.
    abs_path = "C:\\Windows\\system.ini" if sys.platform == "win32" else "/etc/passwd"
    with pytest.raises(WorkspacePathError), open_workspace_file_for_andes(workspace, abs_path):
        pass


@pytest.mark.unit
def test_open_workspace_file_rejects_nul_byte(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    with (
        pytest.raises(WorkspacePathError, match="NUL"),
        open_workspace_file_for_andes(workspace, "case\x00.raw"),
    ):
        pass


@pytest.mark.unit
def test_open_workspace_file_rejects_missing_file(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    with (
        pytest.raises(WorkspacePathError, match="does not exist"),
        open_workspace_file_for_andes(workspace, "missing.xlsx"),
    ):
        pass


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only symlink test")
def test_open_workspace_file_rejects_symlink_at_leaf(tmp_path: Path) -> None:
    """``O_NOFOLLOW`` rejects a symlink at the final component, defeating
    a symlink-race attack where a file inside the workspace is a symlink to
    a target outside it."""
    workspace = ensure_workspace(tmp_path / "ws")
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    link = workspace / "link.raw"
    link.symlink_to(outside)
    with (
        pytest.raises(WorkspacePathError, match="symlink|open error"),
        open_workspace_file_for_andes(workspace, "link.raw"),
    ):
        pass
