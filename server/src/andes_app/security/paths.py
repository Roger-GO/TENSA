"""Workspace path canonicalization.

Every client-supplied case-file path is resolved relative to a configured
workspace root, opened with ``O_NOFOLLOW | O_CLOEXEC`` to refuse symlink
races, canonicalized via the file's resolved real path (preserving the
extension so ANDES's format-detection in ``andes/io/__init__.py`` works), and
rejected if the canonical target is not within the workspace.

The canonical real path (with extension) is what we hand to ANDES — *not*
``/proc/self/fd/N``, because ANDES uses ``os.path.splitext`` on the path
string to pick the format reader, and fd-paths have no extension.

POSIX-only (Linux + macOS). On Windows, we fall back to ``Path.resolve()``
with no symlink-race protection — see the trust-model docstring (R23 is
best-effort on Windows in v0.1).
"""

from __future__ import annotations

import contextlib
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from andes_app.core.errors import AndesAppError


class WorkspacePathError(AndesAppError):
    """Raised when a client-supplied path fails the workspace boundary check.

    The API layer maps this to HTTP 400 with a ``ProblemDetails`` body.
    """


def ensure_workspace(directory: Path) -> Path:
    """Resolve ``directory`` to an absolute, canonical path; create it with
    mode ``0700`` if missing. Returns the canonical workspace path that all
    subsequent canonicalize() calls validate against.
    """
    directory = directory.expanduser()
    if not directory.exists():
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        with contextlib.suppress(OSError):  # Windows / non-POSIX has no chmod
            os.chmod(directory, 0o700)
    canonical = directory.resolve(strict=True)
    if not canonical.is_dir():
        raise WorkspacePathError(f"workspace path is not a directory: {canonical}")
    return canonical


def _reject_unsafe_input(client_path: str) -> None:
    if "\x00" in client_path:
        raise WorkspacePathError("path contains a NUL byte")
    if Path(client_path).is_absolute():
        raise WorkspacePathError(
            f"absolute paths are not accepted from clients: {client_path!r}"
        )


@contextmanager
def open_workspace_file_for_andes(
    workspace: Path,
    client_path: str,
) -> Iterator[Path]:
    """Validate ``client_path`` against ``workspace``, open with
    ``O_NOFOLLOW | O_CLOEXEC`` to defeat TOCTOU symlink races, and yield the
    canonical real path (with extension preserved) that the caller hands to
    ANDES.

    The opened fd is closed when the context exits — but we do NOT pass the
    fd to ANDES. ANDES's format detection uses ``os.path.splitext`` on the
    path string; an fd-path has no extension. The TOCTOU window between this
    canonicalization and ANDES's own ``open()`` call is bounded by the
    workspace directory's ``0700`` permissions: only the same OS user can
    swap symlinks, and the v0.1 trust model already trusts that user.
    """
    _reject_unsafe_input(client_path)

    candidate = (workspace / client_path).expanduser()

    if sys.platform == "win32":
        # Windows: best-effort. resolve() follows symlinks but has no
        # O_NOFOLLOW equivalent. Trust-model docstring names this gap.
        canonical = candidate.resolve(strict=True)
        _check_within_workspace(workspace, canonical)
        yield canonical
        return

    # POSIX: open with O_NOFOLLOW so a symlink at the leaf is rejected
    # outright (ELOOP). Then canonicalize via the open fd's path (Linux:
    # /proc/self/fd/<n> -> readlink; macOS: fcntl F_GETPATH).
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    try:
        fd = os.open(str(candidate), flags)
    except FileNotFoundError as exc:
        raise WorkspacePathError(
            f"workspace file does not exist: {client_path!r}"
        ) from exc
    except OSError as exc:
        # ELOOP from O_NOFOLLOW = symlink at the leaf
        raise WorkspacePathError(
            f"path rejected (symlink at leaf or open error): {client_path!r}: {exc}"
        ) from exc
    try:
        canonical = _canonical_path_from_fd(fd)
        _check_within_workspace(workspace, canonical)
        yield canonical
    finally:
        os.close(fd)


def _canonical_path_from_fd(fd: int) -> Path:
    """Resolve the canonical path of an open file descriptor.

    Linux: ``os.readlink('/proc/self/fd/<n>')``.
    macOS: ``fcntl(F_GETPATH)`` via ctypes (no Python builtin).
    """
    if sys.platform == "linux":
        target = os.readlink(f"/proc/self/fd/{fd}")
        return Path(target).resolve(strict=True)
    if sys.platform == "darwin":
        return _macos_fcntl_getpath(fd)
    # Other POSIX (BSD, etc.): fall back to readlink which may exist
    target = os.readlink(f"/proc/self/fd/{fd}")  # pragma: no cover
    return Path(target).resolve(strict=True)


def _macos_fcntl_getpath(fd: int) -> Path:  # pragma: no cover — macOS only
    import ctypes

    F_GETPATH = 50  # macOS fcntl.h
    PATH_MAX = 1024
    libc = ctypes.CDLL("libc.dylib", use_errno=True)
    buf = ctypes.create_string_buffer(PATH_MAX)
    if libc.fcntl(fd, F_GETPATH, buf) == -1:
        err = ctypes.get_errno()
        raise OSError(err, f"fcntl F_GETPATH failed: {os.strerror(err)}")
    return Path(os.fsdecode(buf.value)).resolve(strict=True)


def _check_within_workspace(workspace: Path, canonical: Path) -> None:
    workspace = workspace.resolve(strict=True)
    try:
        canonical.relative_to(workspace)
    except ValueError as exc:
        raise WorkspacePathError(
            f"path resolves outside the workspace: "
            f"{canonical!s} not under {workspace!s}"
        ) from exc
