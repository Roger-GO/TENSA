"""Unit tests for workspace path canonicalization."""

from __future__ import annotations

import errno
import os
import sys
import types
from collections.abc import Callable
from pathlib import Path

import pytest

from tensa.security import paths
from tensa.security.paths import (
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
@pytest.mark.parametrize(
    "client_path",
    [
        "CON.xlsx",  # DOS device, any extension
        "nul.json",
        "Aux",
        "com1.raw",
        "sub/LPT3.raw",  # only the leaf matters, whichever separator is used
        "sub\\prn.raw",
        "C:evil.xlsx",  # drive-relative on Windows
        "case.xlsx:stream",  # NTFS alternate data stream
        "a:b.xlsx",
        "ieee14.raw.",  # Windows strips trailing dots and spaces
        "ieee14.raw ",
        "a?b.json",
        "a*b.json",
        "sub/",  # no file name at all
    ],
)
def test_open_workspace_file_for_write_rejects_unportable_file_names(
    tmp_path: Path, client_path: str
) -> None:
    """The write choke point refuses names Windows would misread, on every platform,
    so a workspace saved on Linux/macOS stays usable when copied to Windows."""
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "sub").mkdir()
    with (
        pytest.raises(WorkspacePathError, match="unsafe file name"),
        open_workspace_file_for_write(workspace, client_path),
    ):
        pass
    assert not any(p.name != "sub" for p in workspace.iterdir())


@pytest.mark.unit
def test_open_workspace_file_for_write_still_accepts_ordinary_names(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "sub").mkdir()
    for client_path in ("My Case (v2).xlsx", "console.raw", "sub/ieee14.raw.layout.json"):
        with open_workspace_file_for_write(workspace, client_path) as target:
            assert target.parent in (workspace, workspace / "sub")


@pytest.mark.unit
@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot hold these as plain files")
def test_open_workspace_file_for_write_can_skip_only_the_portable_name_check(
    tmp_path: Path,
) -> None:
    """A sidecar derived from a case file already in the workspace inherits that
    file's name, so the caller may waive the name rule; containment still holds."""
    workspace = ensure_workspace(tmp_path / "ws")
    leaf = "case_12:30.raw.layout.json"
    with (
        pytest.raises(WorkspacePathError, match="unsafe file name"),
        open_workspace_file_for_write(workspace, leaf),
    ):
        pass
    with open_workspace_file_for_write(
        workspace, leaf, require_portable_name=False
    ) as target:
        assert target == workspace / leaf
    for escape in ("../outside:1.json", "/abs:1.json"):
        with (
            pytest.raises(WorkspacePathError),
            open_workspace_file_for_write(workspace, escape, require_portable_name=False),
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
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only symlink test")
@pytest.mark.parametrize("target", ["../outside/pwned.dyr", "not-yet.dyr"])
def test_open_workspace_file_for_write_rejects_dangling_symlink_target(
    tmp_path: Path, target: str
) -> None:
    """A symlink whose target does not exist yet is still a symlink: ``exists()``
    follows it and reports False, so it must be caught with ``lstat``.
    Otherwise a write through it would create the file wherever it points."""
    workspace = ensure_workspace(tmp_path / "ws")
    (tmp_path / "outside").mkdir()
    (workspace / "ieee14.dyr").symlink_to(target)
    with (
        pytest.raises(WorkspacePathError, match="symlink"),
        open_workspace_file_for_write(workspace, "ieee14.dyr"),
    ):
        pass
    assert not (tmp_path / "outside" / "pwned.dyr").exists()
    assert not (workspace / "not-yet.dyr").exists()


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

    with (  # noqa: PT012 — multi-statement intentional
        pytest.raises(WriterBoom),
        open_workspace_file_for_write(workspace, target_rel) as target,
    ):
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


# ---- macOS F_GETPATH + workspace-root canonicalization ------------------------
#
# The macOS branches cannot run for real on Linux, so these tests swap in a
# fake ``fcntl`` module (whose F_GETPATH answers come from /proc/self/fd, with
# an optional "on-disk spelling" rewrite) and make the module believe it is on
# darwin. They pin the call shape handed to the stdlib and the decisions made
# on its answers.

_PATH_MAX = 1024
_linux_only = pytest.mark.skipif(
    sys.platform != "linux", reason="fake F_GETPATH reads /proc/self/fd"
)


class _FakeMacos:
    """Stand-in macOS: ``paths.sys.platform == 'darwin'`` plus a fake ``fcntl``."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, respell: Callable[[str], str]) -> None:
        self.calls: list[tuple[int, int, int]] = []
        self._respell = respell
        fake_fcntl = types.SimpleNamespace(F_GETPATH=50, fcntl=self._fcntl)
        monkeypatch.setitem(sys.modules, "fcntl", fake_fcntl)
        monkeypatch.setattr(paths, "sys", types.SimpleNamespace(platform="darwin"))

    def _fcntl(self, fd: int, cmd: int, buf: bytes) -> bytes:
        self.calls.append((fd, cmd, len(buf)))
        real = os.readlink(f"/proc/self/fd/{fd}")
        return self._respell(real).encode().ljust(len(buf), b"\0")


@pytest.fixture
def fake_macos(monkeypatch: pytest.MonkeyPatch) -> Callable[..., _FakeMacos]:
    def install(respell: Callable[[str], str] = lambda p: p) -> _FakeMacos:
        return _FakeMacos(monkeypatch, respell)

    return install


@pytest.mark.unit
@_linux_only
def test_macos_getpath_goes_through_stdlib_fcntl(
    tmp_path: Path, fake_macos: Callable[..., _FakeMacos]
) -> None:
    """The old ctypes call into variadic libc ``fcntl`` is gone: the stdlib
    ``fcntl.fcntl(fd, F_GETPATH, <PATH_MAX-byte buffer>)`` is used, and the
    NUL padding the kernel leaves in the buffer is stripped."""
    target = tmp_path / "ieee14.raw"
    target.write_text("x", encoding="utf-8")
    fake = fake_macos()
    fd = os.open(target, os.O_RDONLY)
    try:
        result = paths._macos_fcntl_getpath(fd)
    finally:
        os.close(fd)
    assert result == target.resolve()
    assert fake.calls == [(fd, 50, _PATH_MAX)]


@pytest.mark.unit
@_linux_only
def test_macos_getpath_empty_answer_is_an_oserror(
    tmp_path: Path, fake_macos: Callable[..., _FakeMacos]
) -> None:
    fake_macos(respell=lambda _p: "")
    fd = os.open(tmp_path, os.O_RDONLY)
    try:
        with pytest.raises(OSError, match="empty path"):
            paths._macos_fcntl_getpath(fd)
    finally:
        os.close(fd)


def _two_spellings(tmp_path: Path) -> tuple[Path, Path, Callable[[str], str]]:
    """Two real directories standing in for one case-insensitive directory:
    the spelling the user typed and the spelling the kernel reports."""
    typed = tmp_path / "Cases"
    on_disk = tmp_path / "cases_on_disk"
    for d in (typed, on_disk):
        d.mkdir()
        (d / "ieee14.raw").write_text("x", encoding="utf-8")
        (d / "sub").mkdir()

    def respell(path: str) -> str:
        return path.replace(str(typed), str(on_disk))

    return typed, on_disk, respell


@pytest.mark.unit
@_linux_only
def test_ensure_workspace_returns_the_on_disk_spelling_on_macos(
    tmp_path: Path, fake_macos: Callable[..., _FakeMacos]
) -> None:
    """``--workspace ~/Cases`` for a directory stored as ``~/cases``: the
    canonical workspace must carry the stored spelling, otherwise every file
    (reported in the stored spelling) falls outside it."""
    typed, on_disk, respell = _two_spellings(tmp_path)
    fake_macos(respell)
    workspace = ensure_workspace(typed)
    assert workspace == on_disk
    with open_workspace_file_for_andes(workspace, "ieee14.raw") as canonical:
        assert canonical == on_disk / "ieee14.raw"


@pytest.mark.unit
@_linux_only
def test_open_file_accepts_a_workspace_spelled_differently_on_macos(
    tmp_path: Path, fake_macos: Callable[..., _FakeMacos]
) -> None:
    """Callers that skip ``ensure_workspace`` still match: the boundary check
    canonicalizes the workspace the same way it canonicalizes the file."""
    typed, on_disk, respell = _two_spellings(tmp_path)
    fake_macos(respell)
    with open_workspace_file_for_andes(typed, "ieee14.raw") as canonical:
        assert canonical == on_disk / "ieee14.raw"


@pytest.mark.unit
@_linux_only
def test_macos_still_rejects_files_outside_the_workspace(
    tmp_path: Path, fake_macos: Callable[..., _FakeMacos]
) -> None:
    typed, _on_disk, respell = _two_spellings(tmp_path)
    (tmp_path / "outside.raw").write_text("x", encoding="utf-8")
    fake_macos(respell)
    with (
        pytest.raises(WorkspacePathError, match="outside the workspace"),
        open_workspace_file_for_andes(typed, "../outside.raw"),
    ):
        pass


@pytest.mark.unit
@_linux_only
def test_write_target_uses_the_on_disk_spelling_on_macos(
    tmp_path: Path, fake_macos: Callable[..., _FakeMacos]
) -> None:
    typed, on_disk, respell = _two_spellings(tmp_path)
    fake_macos(respell)
    with open_workspace_file_for_write(typed, "sub/ieee14.layout.json") as target:
        assert target == on_disk / "sub" / "ieee14.layout.json"


@pytest.mark.unit
@_linux_only
def test_layout_sidecar_path_uses_the_on_disk_spelling_on_macos(
    tmp_path: Path, fake_macos: Callable[..., _FakeMacos]
) -> None:
    from tensa.api.routes.workspace import _layout_sidecar_path

    typed, on_disk, respell = _two_spellings(tmp_path)
    fake_macos(respell)
    assert _layout_sidecar_path(typed, "sub/ieee14.raw") == (
        on_disk / "sub" / "ieee14.raw.layout.json"
    )


@pytest.mark.unit
@pytest.mark.skipif(sys.platform != "darwin", reason="real F_GETPATH needs macOS")
def test_real_macos_canonical_directory_reports_the_stored_spelling(tmp_path: Path) -> None:
    stored = tmp_path / "MixedCase"
    stored.mkdir()
    typed = tmp_path / "mixedcase"
    if not typed.exists():
        pytest.skip("volume is case-sensitive")
    assert paths.canonical_directory(typed) == stored.resolve()
    assert paths.canonical_directory(stored) == stored.resolve()


# ---- resolution failures are WorkspacePathError, not OSError -------------------


@pytest.mark.unit
def test_canonical_directory_wraps_missing_directory(tmp_path: Path) -> None:
    with pytest.raises(WorkspacePathError, match="does not exist"):
        paths.canonical_directory(tmp_path / "nope")


@pytest.mark.unit
def test_canonical_directory_rejects_a_regular_file(tmp_path: Path) -> None:
    """``Path.resolve(strict=True)`` is content with a file (macOS refuses it
    through ``O_DIRECTORY``); the check must hold on every platform."""
    a_file = tmp_path / "ieee14.raw"
    a_file.write_text("dummy")
    with pytest.raises(WorkspacePathError, match="not a directory"):
        paths.canonical_directory(a_file)


@pytest.mark.unit
def test_ensure_workspace_rejects_a_regular_file(tmp_path: Path) -> None:
    a_file = tmp_path / "ws"
    a_file.write_text("dummy")
    with pytest.raises(WorkspacePathError, match="not a directory"):
        ensure_workspace(a_file)


@pytest.mark.unit
def test_write_target_below_a_regular_file_is_a_path_error(tmp_path: Path) -> None:
    """``case.raw/x.raw`` made ``case.raw`` the 'parent directory', which the
    old check accepted; the write then failed with a bare NotADirectoryError."""
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "ieee14.raw").write_text("dummy")
    with (
        pytest.raises(WorkspacePathError, match="not a directory"),
        open_workspace_file_for_write(workspace, "ieee14.raw/x.raw"),
    ):
        pass
    assert [p.name for p in workspace.iterdir()] == ["ieee14.raw"]


@pytest.mark.unit
def test_read_below_a_regular_file_is_a_path_error(tmp_path: Path) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "ieee14.raw").write_text("dummy")
    with (
        pytest.raises(WorkspacePathError),
        open_workspace_file_for_andes(workspace, "ieee14.raw/x.raw"),
    ):
        pass


@pytest.mark.unit
def test_canonical_directory_wraps_os_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(self: Path, strict: bool = False) -> Path:
        raise OSError(errno.EINVAL, "invalid name (WinError 123 on Windows)")

    monkeypatch.setattr(Path, "resolve", boom)
    with pytest.raises(WorkspacePathError, match="cannot resolve directory"):
        paths.canonical_directory(tmp_path)


@pytest.mark.unit
def test_open_workspace_file_windows_branch_wraps_missing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows resolves with ``Path.resolve(strict=True)``; a missing file
    raised a bare FileNotFoundError (a 500) instead of WorkspacePathError."""
    workspace = ensure_workspace(tmp_path / "ws")
    monkeypatch.setattr(paths, "sys", types.SimpleNamespace(platform="win32"))
    with (
        pytest.raises(WorkspacePathError, match="does not exist"),
        open_workspace_file_for_andes(workspace, "missing.xlsx"),
    ):
        pass


@pytest.mark.unit
def test_open_workspace_file_windows_branch_wraps_invalid_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """WinError 123 (invalid file name) from ``resolve`` is an OSError that is
    not FileNotFoundError."""
    workspace = ensure_workspace(tmp_path / "ws")
    real_resolve = Path.resolve

    def resolve(self: Path, strict: bool = False) -> Path:
        if self.name == "bad<name>.raw":
            raise OSError(errno.EINVAL, "invalid file name", str(self))
        return real_resolve(self, strict=strict)

    monkeypatch.setattr(paths, "sys", types.SimpleNamespace(platform="win32"))
    monkeypatch.setattr(Path, "resolve", resolve)
    with (
        pytest.raises(WorkspacePathError, match="cannot resolve"),
        open_workspace_file_for_andes(workspace, "bad<name>.raw"),
    ):
        pass


@pytest.mark.unit
@pytest.mark.skipif(
    sys.platform == "win32",
    reason="Windows canonicalizes through Path.resolve, with no fd to resolve",
)
def test_open_workspace_file_wraps_canonicalization_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fd was opened, but resolving its path then failed (file removed
    mid-flight, /proc unavailable): still a WorkspacePathError, and the fd is
    closed."""
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "ieee14.raw").write_text("x", encoding="utf-8")
    seen_fds: list[int] = []

    def boom(fd: int) -> Path:
        seen_fds.append(fd)
        raise FileNotFoundError(errno.ENOENT, "gone")

    monkeypatch.setattr(paths, "_canonical_path_from_fd", boom)
    with (
        pytest.raises(WorkspacePathError, match="cannot canonicalize"),
        open_workspace_file_for_andes(workspace, "ieee14.raw"),
    ):
        pass
    with pytest.raises(OSError):  # EBADF: the fd was closed
        os.fstat(seen_fds[0])


@pytest.mark.unit
@pytest.mark.skipif(
    sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0),
    reason="needs POSIX permission bits and a non-root user",
)
def test_write_under_unsearchable_ancestor_is_workspace_path_error(tmp_path: Path) -> None:
    """``Path.exists`` re-raises EACCES; the write validator must turn that
    into WorkspacePathError so routes answer 4xx, not 500."""
    workspace = ensure_workspace(tmp_path / "ws")
    locked = workspace / "locked"
    (locked / "inner").mkdir(parents=True)
    locked.chmod(0o000)
    try:
        with (
            pytest.raises(WorkspacePathError, match="cannot resolve"),
            open_workspace_file_for_write(workspace, "locked/inner/ieee14.layout.json"),
        ):
            pass
    finally:
        locked.chmod(0o700)


# ---- the workspace is canonicalized once per request -------------------------


@pytest.fixture
def canonicalized(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """Every directory ``canonical_directory`` is asked about."""
    seen: list[Path] = []
    real = paths.canonical_directory

    def counting(directory: Path) -> Path:
        seen.append(directory)
        return real(directory)

    monkeypatch.setattr(paths, "canonical_directory", counting)
    return seen


@pytest.mark.unit
def test_opening_a_file_canonicalizes_the_workspace_once(
    tmp_path: Path, canonicalized: list[Path]
) -> None:
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "ieee14.raw").write_text("x", encoding="utf-8")
    canonicalized.clear()
    with open_workspace_file_for_andes(workspace, "ieee14.raw"):
        pass
    assert canonicalized == [workspace]


@pytest.mark.unit
@pytest.mark.parametrize("existing_target", [False, True])
def test_a_write_target_canonicalizes_the_workspace_once(
    tmp_path: Path, canonicalized: list[Path], existing_target: bool
) -> None:
    """The boundary check runs for the parent and again for an existing target,
    and used to canonicalize the workspace each time: three times a request."""
    workspace = ensure_workspace(tmp_path / "ws")
    (workspace / "sub").mkdir()
    if existing_target:
        (workspace / "sub" / "out.json").write_text("{}", encoding="utf-8")
    canonicalized.clear()
    with open_workspace_file_for_write(workspace, "sub/out.json") as target:
        assert target == workspace / "sub" / "out.json"
    # Once for the workspace, once for the parent directory.
    assert canonicalized == [workspace, workspace / "sub"]


@pytest.mark.unit
def test_the_boundary_check_trusts_the_workspace_it_is_given(tmp_path: Path) -> None:
    """``_check_within_workspace`` compares what it is handed; making the
    workspace canonical is the caller's job, done once per request."""
    workspace = ensure_workspace(tmp_path / "ws")
    inside = workspace / "a.raw"
    inside.write_text("x", encoding="utf-8")
    paths._check_within_workspace(workspace, inside)  # noqa: SLF001
    with pytest.raises(WorkspacePathError, match="outside the workspace"):
        paths._check_within_workspace(workspace, tmp_path)  # noqa: SLF001
    # A directory that does not exist is not canonicalized here, so it is not
    # an error of its own: it simply contains nothing.
    with pytest.raises(WorkspacePathError, match="outside the workspace"):
        paths._check_within_workspace(tmp_path / "nope", inside)  # noqa: SLF001
