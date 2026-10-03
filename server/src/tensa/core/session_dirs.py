"""Per-session scratch directories under ``<workspace>/.sessions/``.

Clone-on-write editing (Unit 21) keeps each session's working copies in
``<workspace>/.sessions/<session_id>/``. The server removes that directory when
the session closes, but a server that is killed (SIGKILL, a crash, power loss)
leaves it behind. This module holds the bookkeeping that lets the next server
clean up after it without touching a directory a live server is still using:

- **Owner marker.** ``owner.pid`` in the session root, written when the
  directory is created, names the server process that owns it.
- **Startup sweep.** ``sweep_stale_session_dirs`` removes a directory only when
  its recorded owner is gone, or (no usable marker) when nothing in it has
  changed for a day.
- **Robust removal.** ``remove_tree`` is ``shutil.rmtree`` that clears the
  read-only bit Windows refuses to delete through.

``core/session.py`` (the parent) and ``core/clone_manager.py`` (inside the
worker) both import from here, so this module stays free of heavy imports.
"""

from __future__ import annotations

import ctypes
import logging
import os
import re
import shutil
import stat
import sys
import time
from collections.abc import Callable, Collection
from pathlib import Path
from typing import Any

log = logging.getLogger("tensa.session_dirs")

# The scratch root inside the workspace, and the file in each session dir that
# names its owner.
SESSIONS_DIRNAME = ".sessions"
OWNER_MARKER_NAME = "owner.pid"

# A directory with no usable owner marker (made before markers existed, or the
# marker could not be written) is only removed once nothing in it has changed
# for this long.
UNMARKED_MAX_AGE_SECONDS = 24 * 60 * 60

# Largest pid a marker may name: ``os.kill`` takes a C int, and no OS hands out
# pids anywhere near this. A bigger number is a damaged marker, not an owner.
_MAX_PID = 2**31 - 1

# The sweep only ever touches directories named like a session id
# (``uuid.uuid4().hex`` in ``SessionManager.create_session``), so a folder a
# user dropped into ``.sessions`` is never deleted.
_SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Windows API values used by ``pid_is_alive``.
_WIN_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_WIN_STILL_ACTIVE = 259
_WIN_ERROR_ACCESS_DENIED = 5


# ---- owner marker -----------------------------------------------------------


def write_owner_marker(session_root: Path, owner_pid: int | None = None) -> None:
    """Record which server process owns ``session_root`` (best effort).

    ``owner_pid`` is the server's pid; the worker is handed it at spawn so the
    marker names the server, not the worker. Defaults to this process. A failed
    write only means the directory falls back to the age rule in the sweep, so
    it is logged rather than raised.
    """
    pid = os.getpid() if owner_pid is None else owner_pid
    try:
        (session_root / OWNER_MARKER_NAME).write_text(f"{pid}\n", encoding="utf-8")
    except OSError as exc:
        log.warning("could not write the owner marker in %s: %s", session_root, exc)


def read_owner_pid(session_root: Path) -> int | None:
    """The pid recorded in ``session_root``'s marker, or ``None`` when the
    marker is missing, unreadable, or not a plausible pid."""
    try:
        with open(session_root / OWNER_MARKER_NAME, encoding="utf-8") as fh:
            text = fh.read(32)
        pid = int(text.strip())
    except (OSError, ValueError):  # ValueError covers bad UTF-8 and bad int
        return None
    return pid if 0 < pid <= _MAX_PID else None


# ---- process liveness -------------------------------------------------------


def _load_kernel32() -> Any:
    """``kernel32`` with the prototypes ``pid_is_alive`` needs (Windows only)."""
    if sys.platform != "win32":
        raise OSError("kernel32 is only available on Windows")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
    ]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    return kernel32


def _last_error() -> int:
    if sys.platform != "win32":
        return 0
    return int(ctypes.get_last_error())


def _windows_pid_is_alive(
    pid: int, kernel32: Any, get_last_error: Callable[[], int]
) -> bool:
    handle = kernel32.OpenProcess(_WIN_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        # ERROR_ACCESS_DENIED: the process exists but belongs to someone else.
        # ERROR_INVALID_PARAMETER (87): there is no such process.
        return get_last_error() == _WIN_ERROR_ACCESS_DENIED
    try:
        code = ctypes.c_uint32()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return True
        return bool(code.value == _WIN_STILL_ACTIVE)
    finally:
        kernel32.CloseHandle(handle)


def pid_is_alive(
    pid: int,
    *,
    kernel32: Any = None,
    get_last_error: Callable[[], int] | None = None,
    platform: str | None = None,
) -> bool:
    """Whether a process with this pid exists.

    Errs towards ``True``: a session directory is only deleted on positive
    evidence that its owner is gone. ``kernel32``, ``get_last_error`` and
    ``platform`` exist so the Windows branch can be exercised on any OS.

    ``os.kill(pid, 0)`` is the POSIX probe, but on Windows any signal other than
    ``CTRL_C_EVENT`` / ``CTRL_BREAK_EVENT`` terminates the target, so the Windows
    branch asks the kernel for the exit code instead.
    """
    if pid <= 0:
        return False
    if (platform or sys.platform) == "win32":
        try:
            if kernel32 is None:
                kernel32 = _load_kernel32()
            return _windows_pid_is_alive(pid, kernel32, get_last_error or _last_error)
        except Exception as exc:  # noqa: BLE001 — unsure means alive
            log.debug("could not probe pid %s: %s", pid, exc)
            return True
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):  # OverflowError: no such pid can exist
        return False
    except OSError:
        # PermissionError: the pid exists and belongs to another user.
        return True
    return True


# ---- removal ----------------------------------------------------------------


def _clear_readonly_and_retry(
    func: Callable[..., Any], path: str, exc: BaseException
) -> None:
    """``shutil.rmtree`` ``onexc`` handler.

    Windows refuses to delete a read-only file (or a directory holding one), and
    a case file copied into a clone keeps the source's read-only bit. Clear the
    bit and run the failed call once more. Any other failure, and a retry that
    fails again, is raised as it happened.
    """
    if not isinstance(exc, PermissionError):
        raise exc
    try:
        os.chmod(path, stat.S_IRWXU)
    except OSError:
        raise exc from None
    func(path)


def remove_tree(path: str | os.PathLike[str]) -> None:
    """``shutil.rmtree`` that also deletes read-only files (see above)."""
    shutil.rmtree(path, onexc=_clear_readonly_and_retry)


# ---- startup sweep ----------------------------------------------------------


def _newest_mtime(path: Path) -> float:
    """The most recent modification time of ``path`` or anything beneath it."""
    newest = path.stat().st_mtime
    for dirpath, dirnames, filenames in os.walk(path):
        for name in (*dirnames, *filenames):
            try:
                newest = max(newest, os.lstat(os.path.join(dirpath, name)).st_mtime)
            except OSError:
                continue
    return newest


def _is_stale(
    path: Path,
    *,
    now: float,
    max_unmarked_age: float,
    pid_alive: Callable[[int], bool],
) -> bool:
    owner = read_owner_pid(path)
    if owner is not None:
        # A live owner keeps the directory, this process included: two servers
        # in different containers can both be pid 1, so a matching pid is no
        # proof of staleness. A reused pid only delays cleanup to a later start.
        return not pid_alive(owner)
    return now - _newest_mtime(path) > max_unmarked_age


def sweep_stale_session_dirs(
    workspace: str | os.PathLike[str],
    *,
    keep: Collection[str] = (),
    now: float | None = None,
    max_unmarked_age: float = UNMARKED_MAX_AGE_SECONDS,
    pid_alive: Callable[[int], bool] = pid_is_alive,
) -> list[str]:
    """Remove session scratch dirs left behind by a server that is gone.

    A directory under ``<workspace>/.sessions/`` is removed when its owner
    marker names a dead process, or when it has no usable marker and nothing in
    it has changed for ``max_unmarked_age`` seconds. A directory whose owner is
    alive, a name in ``keep``, anything not named like a session id, and
    anything that is not a plain directory (a symlink is never followed) are
    left alone. Returns the names removed.

    Call it once at startup, before this server creates a session: a directory
    that is live right now but missing from ``keep`` is judged by its marker
    alone. One that cannot be removed is logged and skipped, never raised.
    """
    root = Path(workspace) / SESSIONS_DIRNAME
    if root.is_symlink():
        return []
    try:
        entries = list(os.scandir(root))
    except OSError:  # no .sessions yet, or unreadable
        return []
    current = time.time() if now is None else now
    removed: list[str] = []
    for entry in entries:
        if entry.name in keep or not _SESSION_ID_RE.match(entry.name):
            continue
        path = Path(entry.path)
        try:
            if entry.is_symlink() or entry.is_junction() or not entry.is_dir(
                follow_symlinks=False
            ):
                continue
            if not _is_stale(
                path, now=current, max_unmarked_age=max_unmarked_age, pid_alive=pid_alive
            ):
                continue
            remove_tree(path)
        except Exception as exc:  # noqa: BLE001 — one bad dir must not stop the sweep
            log.warning("could not remove stale session dir %s: %s", path, exc)
            continue
        removed.append(entry.name)
    return removed
