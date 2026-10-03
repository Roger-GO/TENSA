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

macOS volumes are normally case- and Unicode-normalization-insensitive, and
``Path.resolve()`` keeps whatever spelling the caller typed. Directories
(the workspace root, parents of write targets) are therefore canonicalized
with the same ``fcntl(F_GETPATH)`` mechanism as files, so ``--workspace
~/Cases`` on a directory stored as ``~/cases`` still matches the paths the
kernel reports for the files inside it.

Every resolution failure (missing path, permission denied, Windows
``WinError 123`` invalid names) surfaces as ``WorkspacePathError``, never a
bare ``OSError``, so routes answer 4xx.
"""

from __future__ import annotations

import contextlib
import errno
import os
import re
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from tensa.core.errors import AndesAppError
from tensa.security.names import portable_name_problem


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
    return canonical_directory(directory)


def canonical_directory(directory: Path) -> Path:
    """Canonical absolute form of an existing directory, symlinks resolved.

    macOS: opens the directory and asks the kernel for its on-disk spelling
    via ``fcntl(F_GETPATH)`` (see ``_canonical_path_from_fd``), the same way
    file paths are canonicalized. Elsewhere ``Path.resolve(strict=True)`` is
    already canonical.

    Raises ``WorkspacePathError`` when the directory is missing, is not a
    directory, or cannot be resolved (permissions, Windows ``WinError 123``).
    """
    try:
        if sys.platform == "darwin":
            fd = os.open(directory, os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY)
            try:
                return _canonical_path_from_fd(fd)
            finally:
                os.close(fd)
        resolved = directory.resolve(strict=True)
        if not resolved.is_dir():
            # ``resolve`` is content with a regular file (macOS refuses it
            # above through ``O_DIRECTORY``), so ``case.raw/x.raw`` would pass
            # as a path under a directory and only fail later at the write.
            raise NotADirectoryError(
                errno.ENOTDIR, os.strerror(errno.ENOTDIR), str(directory)
            )
        return resolved
    except FileNotFoundError as exc:
        raise WorkspacePathError(f"directory does not exist: {directory!s}") from exc
    except NotADirectoryError as exc:
        raise WorkspacePathError(f"path is not a directory: {directory!s}") from exc
    except OSError as exc:
        raise WorkspacePathError(
            f"cannot resolve directory {directory!s}: {exc}"
        ) from exc


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
        try:
            canonical = candidate.resolve(strict=True)
        except FileNotFoundError as exc:
            raise WorkspacePathError(
                f"workspace file does not exist: {client_path!r}"
            ) from exc
        except OSError as exc:
            # e.g. WinError 123 (invalid file name) for reserved characters.
            raise WorkspacePathError(
                f"path rejected (cannot resolve): {client_path!r}: {exc}"
            ) from exc
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
        try:
            canonical = _canonical_path_from_fd(fd)
        except OSError as exc:
            raise WorkspacePathError(
                f"path rejected (cannot canonicalize): {client_path!r}: {exc}"
            ) from exc
        _check_within_workspace(workspace, canonical)
        yield canonical
    finally:
        os.close(fd)


def _canonical_path_from_fd(fd: int) -> Path:
    """Resolve the canonical path of an open file descriptor.

    Linux: ``os.readlink('/proc/self/fd/<n>')``.
    macOS: ``fcntl.fcntl(fd, F_GETPATH, ...)``, which also reports the
    on-disk case and Unicode normalization of every component.
    """
    if sys.platform == "linux":
        target = os.readlink(f"/proc/self/fd/{fd}")
        return Path(target).resolve(strict=True)
    if sys.platform == "darwin":
        return _macos_fcntl_getpath(fd)
    # Other POSIX (BSD, etc.): fall back to readlink which may exist
    target = os.readlink(f"/proc/self/fd/{fd}")  # pragma: no cover
    return Path(target).resolve(strict=True)


_MACOS_PATH_MAX = 1024  # <sys/syslimits.h>; F_GETPATH needs a buffer this large
_MACOS_F_GETPATH = 50  # <fcntl.h>; only used if ``fcntl`` lacks the constant


def _macos_fcntl_getpath(fd: int) -> Path:
    """Return the on-disk path of ``fd`` via ``fcntl(F_GETPATH)``.

    Uses the stdlib ``fcntl`` module on purpose: libc's ``fcntl`` is variadic,
    and calling it through ctypes without a prototype puts the third argument
    where the callee does not look on arm64 macOS (Apple passes variadic
    arguments on the stack), so the buffer pointer was garbage there.
    """
    import fcntl

    cmd = getattr(fcntl, "F_GETPATH", _MACOS_F_GETPATH)
    raw = fcntl.fcntl(fd, cmd, bytes(_MACOS_PATH_MAX))
    path = raw.split(b"\0", 1)[0]
    if not path:
        raise OSError(errno.ENOENT, "fcntl F_GETPATH returned an empty path")
    return Path(os.fsdecode(path)).resolve(strict=True)


def _check_within_workspace(workspace: Path, canonical: Path) -> None:
    workspace = canonical_directory(workspace)
    try:
        canonical.relative_to(workspace)
    except ValueError as exc:
        raise WorkspacePathError(
            f"path resolves outside the workspace: "
            f"{canonical!s} not under {workspace!s}"
        ) from exc


def list_workspace_files(
    workspace: Path,
    allowed_extensions: frozenset[str],
) -> list[Path]:
    """Enumerate workspace files matching ``allowed_extensions``.

    Non-recursive (workspace root only in v0.1). Excludes:

    - hidden files (names starting with ``.``)
    - symlinks (``entry.is_symlink()`` true)
    - directories
    - files whose extension (lowercased) is not in ``allowed_extensions``

    Returns absolute paths sorted alphabetically by name. ``allowed_extensions``
    entries should include the leading dot (e.g., ``frozenset({".xlsx",
    ".raw"})``); comparison is case-insensitive on the suffix.
    """
    workspace = canonical_directory(workspace)
    if not workspace.is_dir():
        raise WorkspacePathError(f"workspace path is not a directory: {workspace!s}")
    results: list[Path] = []
    with os.scandir(workspace) as it:
        for entry in it:
            if entry.name.startswith("."):
                continue
            # ``is_symlink`` does not follow; ``is_file(follow_symlinks=False)``
            # rejects symlinks too. Belt + suspenders.
            if entry.is_symlink():
                continue
            try:
                if not entry.is_file(follow_symlinks=False):
                    continue
            except OSError:
                continue
            suffix = Path(entry.name).suffix.lower()
            if suffix not in allowed_extensions:
                continue
            results.append(Path(entry.path))
    results.sort(key=lambda p: p.name)
    return results


@contextmanager
def open_workspace_file_for_write(
    workspace: Path,
    client_path: str,
    *,
    require_portable_name: bool = True,
) -> Iterator[Path]:
    """Validate ``client_path`` for a write operation under ``workspace`` and
    yield the canonical target Path. The caller is responsible for the actual
    write (typically via ``tempfile.NamedTemporaryFile`` in the parent
    directory followed by ``os.replace``).

    Validation:

    - ``_reject_unsafe_input`` — refuses absolute paths and NUL bytes.
    - The file name (last component) must be portable: no Windows device
      names (``CON``, ``nul.txt``), ``:`` (drive prefix / NTFS stream),
      trailing dot or space, or other characters Windows rejects. Enforced
      on every platform so a workspace stays usable when it is copied to
      Windows. ``require_portable_name=False`` waives only this check, for a
      file named after one already in the workspace (the layout sidecar of an
      existing case); every other check below still applies.
    - The target's parent directory must exist and not be a symlink (so a
      symlink-races attack at the directory level is defeated).
    - The resolved target must be inside the workspace.

    The target file itself MAY be missing (this is a write — the file is
    being created or replaced). It must not be a symlink, including one whose
    destination does not exist yet.

    Any failure to resolve the path (permissions, invalid names) is raised as
    ``WorkspacePathError``, never a bare ``OSError``.
    """
    try:
        target = _resolve_write_target(
            workspace, client_path, require_portable_name=require_portable_name
        )
    except OSError as exc:
        # Permission denied on an ancestor, WinError 123, a path component
        # that is a file: a client error, not a server fault.
        raise WorkspacePathError(
            f"path rejected (cannot resolve): {client_path!r}: {exc}"
        ) from exc
    yield target


def _reject_unportable_leaf(client_path: str) -> None:
    # Validate the RAW last component: on Windows ``Path("C:x.raw").name`` is
    # ``x.raw``, which would hide the drive prefix that must be refused.
    leaf = re.split(r"[\\/]", client_path)[-1]
    problem = portable_name_problem(leaf)
    if problem is not None:
        raise WorkspacePathError(
            f"unsafe file name in {client_path!r}: the name {problem}"
        )


def _resolve_write_target(
    workspace: Path, client_path: str, *, require_portable_name: bool = True
) -> Path:
    _reject_unsafe_input(client_path)
    if require_portable_name:
        _reject_unportable_leaf(client_path)

    workspace = canonical_directory(workspace)
    candidate = (workspace / client_path).expanduser()
    parent = candidate.parent

    # The parent dir must exist (we don't auto-mkdir for writes — the case
    # file already lives in a real directory in the workspace).
    if not parent.exists():
        raise WorkspacePathError(
            f"parent directory does not exist for write: {client_path!r}"
        )

    if sys.platform != "win32" and parent.is_symlink():
        raise WorkspacePathError(
            f"refusing to write under a symlinked parent directory: {client_path!r}"
        )

    canonical_parent = canonical_directory(parent)
    _check_within_workspace(workspace, canonical_parent)

    # ``is_symlink`` uses ``lstat``, so it also catches a dangling link, whose
    # ``exists()`` is False because that follows the link. A write through it
    # would create the file wherever it points, outside the workspace or not.
    if candidate.is_symlink():
        raise WorkspacePathError(
            f"refusing to overwrite a symlink: {client_path!r}"
        )

    # Re-check the final target is within workspace (covers the case where
    # the file exists already and resolves elsewhere).
    if candidate.exists():
        canonical_target = candidate.resolve(strict=True)
        _check_within_workspace(workspace, canonical_target)
        return canonical_target
    # File does not yet exist — return the canonical-parent + name so the
    # caller can write atomically.
    return canonical_parent / candidate.name
