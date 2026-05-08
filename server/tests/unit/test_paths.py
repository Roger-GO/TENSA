"""Unit tests for workspace path canonicalization."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from andes_app.security.paths import (
    WorkspacePathError,
    ensure_workspace,
    list_workspace_files,
    open_workspace_file_for_andes,
    open_workspace_file_for_write,
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


# ---- list_workspace_files ----------------------------------------------------


_ALLOWED = frozenset({".xlsx", ".raw", ".dyr", ".json", ".m"})


@pytest.mark.unit
def test_list_workspace_files_filters_extensions(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "a.raw").write_text("x")
    (workspace / "b.dyr").write_text("x")
    (workspace / "c.txt").write_text("x")  # excluded
    (workspace / "d.JSON").write_text("x")  # uppercase suffix; case-insensitive
    results = list_workspace_files(workspace, _ALLOWED)
    names = [p.name for p in results]
    assert names == ["a.raw", "b.dyr", "d.JSON"]


@pytest.mark.unit
def test_list_workspace_files_excludes_hidden(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / ".hidden.raw").write_text("x")
    (workspace / "visible.raw").write_text("x")
    results = list_workspace_files(workspace, _ALLOWED)
    assert [p.name for p in results] == ["visible.raw"]


@pytest.mark.unit
def test_list_workspace_files_excludes_subdirs(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "a.raw").write_text("x")
    sub = workspace / "sub"
    sub.mkdir()
    (sub / "b.raw").write_text("x")
    results = list_workspace_files(workspace, _ALLOWED)
    assert [p.name for p in results] == ["a.raw"]


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only symlink test")
def test_list_workspace_files_excludes_symlinks(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    real = workspace / "real.raw"
    real.write_text("x")
    outside = tmp_path / "outside.raw"
    outside.write_text("y")
    (workspace / "link.raw").symlink_to(outside)
    (workspace / "selflink.raw").symlink_to(real)  # symlink to in-workspace file
    results = list_workspace_files(workspace, _ALLOWED)
    assert [p.name for p in results] == ["real.raw"]


@pytest.mark.unit
def test_list_workspace_files_alphabetical(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    for name in ("z.raw", "a.raw", "m.raw"):
        (workspace / name).write_text("x")
    results = list_workspace_files(workspace, _ALLOWED)
    assert [p.name for p in results] == ["a.raw", "m.raw", "z.raw"]


@pytest.mark.unit
def test_list_workspace_files_empty_workspace(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    assert list_workspace_files(workspace, _ALLOWED) == []


# ---- open_workspace_file_for_write -------------------------------------------


@pytest.mark.unit
def test_open_workspace_file_for_write_happy_path(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    with open_workspace_file_for_write(workspace, "ieee14.layout.json") as target:
        assert target.parent == workspace.resolve(strict=True)
        assert target.name == "ieee14.layout.json"
        target.write_text("{}", encoding="utf-8")
    assert (workspace / "ieee14.layout.json").read_text() == "{}"


@pytest.mark.unit
def test_open_workspace_file_for_write_rejects_traversal(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    with (
        pytest.raises(WorkspacePathError),
        open_workspace_file_for_write(workspace, "../escape.json"),
    ):
        pass


@pytest.mark.unit
def test_open_workspace_file_for_write_rejects_absolute(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    abs_path = "C:\\bad.json" if sys.platform == "win32" else "/etc/bad.json"
    with (
        pytest.raises(WorkspacePathError),
        open_workspace_file_for_write(workspace, abs_path),
    ):
        pass


@pytest.mark.unit
def test_open_workspace_file_for_write_rejects_nul(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    with (
        pytest.raises(WorkspacePathError, match="NUL"),
        open_workspace_file_for_write(workspace, "bad\x00.json"),
    ):
        pass


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only symlink test")
def test_open_workspace_file_for_write_rejects_symlinked_parent(tmp_path: Path) -> None:
    """If the parent directory itself is a symlink (e.g., a malicious user
    swapped a workspace subdirectory for a symlink to /etc), refuse to
    write into it."""
    workspace = ensure_workspace(tmp_path / "ws")
    # Real outside dir
    target_dir = tmp_path / "outside-dir"
    target_dir.mkdir()
    # Symlink inside workspace pointing to outside
    (workspace / "subdir").symlink_to(target_dir)
    with (
        pytest.raises(WorkspacePathError, match="symlink|outside"),
        open_workspace_file_for_write(workspace, "subdir/foo.json"),
    ):
        pass


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only symlink test")
def test_open_workspace_file_for_write_rejects_existing_symlink_target(
    tmp_path: Path,
) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    outside = tmp_path / "outside.json"
    outside.write_text("secret")
    (workspace / "ieee14.layout.json").symlink_to(outside)
    with (
        pytest.raises(WorkspacePathError, match="symlink"),
        open_workspace_file_for_write(workspace, "ieee14.layout.json"),
    ):
        pass


@pytest.mark.unit
def test_open_workspace_file_for_write_atomic_rollback(tmp_path: Path) -> None:
    """If the caller raises mid-write while using ``tempfile + os.replace``,
    no partially-written target should remain. The helper itself yields a
    Path but doesn't manage the temp-file lifecycle — the caller does. This
    test exercises the documented usage pattern: tempfile + atomic rename
    in the same parent dir, with cleanup on exception.
    """
    import os
    import tempfile

    workspace = ensure_workspace(tmp_path / "ws")
    target_rel = "ieee14.layout.json"
    pre_existing = (workspace / target_rel)
    pre_existing.write_text('{"old": true}', encoding="utf-8")

    class WriterBoom(RuntimeError):
        pass

    with pytest.raises(WriterBoom):  # noqa: PT012 — multi-statement intentional
        with open_workspace_file_for_write(workspace, target_rel) as target:
            tmp = tempfile.NamedTemporaryFile(  # noqa: SIM115
                mode="w",
                encoding="utf-8",
                dir=target.parent,
                delete=False,
            )
            tmp_path_obj = Path(tmp.name)
            try:
                tmp.write("{half-written")
                # Simulate a failure mid-stream BEFORE os.replace.
                raise WriterBoom("simulated")
            finally:
                tmp.close()
                if tmp_path_obj.exists():
                    os.unlink(tmp_path_obj)

    # Pre-existing file is unchanged because os.replace never ran.
    assert pre_existing.read_text() == '{"old": true}'
    # No leftover temp files (caller cleaned up in the except branch above).
    leftovers = [p.name for p in workspace.iterdir() if p.name != target_rel]
    assert leftovers == []
