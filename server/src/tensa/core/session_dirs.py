"""Per-session scratch directories under ``<workspace>/.sessions/``.

Clone-on-write editing (Unit 21) keeps each session's working copies in
``<workspace>/.sessions/<session_id>/``. The server removes that directory when
the session closes, but a server that is killed (SIGKILL, a crash, power loss)
leaves it behind. This module holds the bookkeeping that lets the next server
clean up after it without touching a directory a live server is still using:

- **Owner marker.** ``owner.pid`` in the session root, written when the
  directory is created, names the server process that owns it: its pid, the
  machine and pid namespace the pid belongs to, and when it started. A bare pid
  means nothing to a server on another host or in another container sharing the
  workspace, and the same pid comes back after a container restart.
- **Startup sweep.** ``sweep_stale_session_dirs`` removes a directory only when
  its recorded owner is gone, or (no usable marker, or one that cannot be tied to
  this host) when nothing in it has changed for a day.
- **Robust removal.** ``remove_tree`` is ``shutil.rmtree`` that clears the
  read-only bit Windows refuses to delete through.

``core/session/`` (the parent) and ``core/clone_manager.py`` (inside the
worker) both import from here, so this module stays free of heavy imports.
"""

from __future__ import annotations

import ctypes
import logging
import os
import re
import shutil
import socket
import stat
import sys
import time
from collections.abc import Callable, Collection
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tensa.core.win32 import FileTime, last_error, load_kernel32

# ``_load_kernel32`` and ``_last_error`` stay module names so tests (and callers
# that inject fakes) can replace them here.
_load_kernel32 = load_kernel32
_last_error = last_error

log = logging.getLogger("tensa.session_dirs")

# The scratch root inside the workspace, and the file in each session dir that
# names its owner.
SESSIONS_DIRNAME = ".sessions"
OWNER_MARKER_NAME = "owner.pid"

# A directory with no owner marker this server can check (made before markers
# existed, the marker could not be written, it names no host, or it was written
# on another host or in another pid namespace) is only removed once nothing in
# it has changed for this long.
UNMARKED_MAX_AGE_SECONDS = 24 * 60 * 60

# Keys after the pid on the marker's first line. Unknown keys are ignored, so
# the marker can grow.
_SPACE_KEY = "space"
_START_KEY = "start"
# More than the longest hostname plus the namespace and start-time fields.
_MARKER_MAX_BYTES = 1024

# Largest pid a marker may name: ``os.kill`` takes a C int, and no OS hands out
# pids anywhere near this. A bigger number is a damaged marker, not an owner.
_MAX_PID = 2**31 - 1

# The sweep only ever touches directories named like a session id
# (``uuid.uuid4().hex`` in ``SessionManager.create_session``), so a folder a
# user dropped into ``.sessions`` is never deleted.
_SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")

# Windows API values used by ``pid_is_alive`` and ``process_start_time``.
_WIN_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_WIN_STILL_ACTIVE = 259
_WIN_ERROR_ACCESS_DENIED = 5


# ---- owner marker -----------------------------------------------------------


@dataclass(frozen=True)
class OwnerMarker:
    """What ``owner.pid`` says about the server that owns a session dir.

    ``space`` and ``start`` are ``None`` for a marker written before they were
    recorded, or when this OS could not provide them. A ``None`` ``start`` only
    means the check for a reused pid is skipped. A ``None`` ``space`` means the
    pid cannot be tied to this host, so the sweep does not probe it and judges the
    directory by its age, as it does for a marker from another host.
    """

    pid: int
    space: str | None = None
    start: str | None = None


def pid_space() -> str | None:
    """Names the set of pids this process shares with the processes that can see
    its pid: the hostname, plus on Linux the id of the pid namespace.

    Two servers on different hosts, or in different containers on a shared
    volume, each have a pid that means nothing in the other's table, so one may
    only probe a pid recorded in the same space. ``None`` when the OS will not
    say.
    """
    try:
        host = socket.gethostname()
    except OSError:
        return None
    try:
        namespace = os.readlink("/proc/self/ns/pid")  # e.g. ``pid:[4026531836]``
    except OSError:
        return host
    return f"{host} {namespace}"


def _linux_process_start_time(pid: int, proc_root: str = "/proc") -> str | None:
    """Field 22 of ``/proc/<pid>/stat``: start time in clock ticks after boot."""
    try:
        with open(f"{proc_root}/{pid}/stat", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        # The command name (field 2) sits in parentheses and may hold spaces and
        # parentheses of its own, so split after the last one: field 3 comes next.
        ticks = text.rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None
    return ticks if ticks.isdigit() else None


def _windows_process_start_time(pid: int, kernel32: Any) -> str | None:
    handle = kernel32.OpenProcess(_WIN_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = (FileTime() for _ in range(4))
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        return str((created.dwHighDateTime << 32) | created.dwLowDateTime)
    finally:
        kernel32.CloseHandle(handle)


def process_start_time(
    pid: int, *, kernel32: Any = None, platform: str | None = None
) -> str | None:
    """When the process ``pid`` started, as an opaque string that is equal for
    the same process and (all but certainly) different for a later process that
    reuses the pid. ``None`` where the OS gives no way to read it (macOS) or the
    read fails.

    Windows reuses pids quickly, and a server restarted in the same container is
    pid 1 again, so a pid alone can name the wrong process.
    """
    if pid <= 0:
        return None
    system = platform or sys.platform
    if system.startswith("linux"):
        return _linux_process_start_time(pid)
    if system == "win32":
        try:
            if kernel32 is None:
                kernel32 = _load_kernel32()
            return _windows_process_start_time(pid, kernel32)
        except Exception as exc:  # noqa: BLE001 — unknown means no check
            log.debug("could not read the start time of pid %s: %s", pid, exc)
    return None


def write_owner_marker(session_root: Path, owner_pid: int | None = None) -> None:
    """Record which server process owns ``session_root`` (best effort).

    ``owner_pid`` is the server's pid; the worker is handed it at spawn so the
    marker names the server, not the worker. Defaults to this process. The first
    line is the pid; ``space=`` and ``start=`` lines follow when they could be
    read. A failed write only means the directory falls back to the age rule in
    the sweep, so it is logged rather than raised.
    """
    pid = os.getpid() if owner_pid is None else owner_pid
    lines = [str(pid)]
    space = pid_space()
    if space is not None:
        lines.append(f"{_SPACE_KEY}={space}")
    start = process_start_time(pid)
    if start is not None:
        lines.append(f"{_START_KEY}={start}")
    try:
        (session_root / OWNER_MARKER_NAME).write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError as exc:
        log.warning("could not write the owner marker in %s: %s", session_root, exc)


def read_owner_marker(session_root: Path) -> OwnerMarker | None:
    """The marker in ``session_root``, or ``None`` when it is missing,
    unreadable, or does not start with a plausible pid. A marker that holds only
    a pid (the first format) reads with no ``space`` and no ``start``."""
    try:
        with open(session_root / OWNER_MARKER_NAME, encoding="utf-8") as fh:
            text = fh.read(_MARKER_MAX_BYTES)
        first, *rest = text.splitlines() or [""]
        pid = int(first.strip())
    except (OSError, ValueError):  # ValueError covers bad UTF-8 and bad int
        return None
    if not 0 < pid <= _MAX_PID:
        return None
    fields: dict[str, str] = {}
    for line in rest:
        key, sep, value = line.partition("=")
        if sep and value:
            fields[key.strip()] = value.strip()
    return OwnerMarker(pid, fields.get(_SPACE_KEY), fields.get(_START_KEY))


def read_owner_pid(session_root: Path) -> int | None:
    """The pid recorded in ``session_root``'s marker, or ``None`` (see
    ``read_owner_marker``)."""
    marker = read_owner_marker(session_root)
    return None if marker is None else marker.pid


# ---- process liveness -------------------------------------------------------


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
    local_space: str | None,
    start_time: Callable[[int], str | None],
) -> bool:
    marker = read_owner_marker(path)
    if (
        marker is not None
        and marker.space is not None
        and (local_space is None or marker.space == local_space)
    ):
        # The pid is meaningful here. A live owner keeps the directory, this
        # process's own pid included, unless the pid has since been reused by a
        # different process (a server restarted in a container is pid 1 again).
        if not pid_alive(marker.pid):
            return True
        if marker.start is None:
            return False
        current = start_time(marker.pid)
        return current is not None and current != marker.start
    # No marker, or one that names no host or comes from another host or pid
    # namespace: its pid proves nothing here, so only a long-untouched directory
    # is taken to be abandoned.
    return now - _newest_mtime(path) > max_unmarked_age


def sweep_stale_session_dirs(
    workspace: str | os.PathLike[str],
    *,
    keep: Collection[str] = (),
    now: float | None = None,
    max_unmarked_age: float = UNMARKED_MAX_AGE_SECONDS,
    pid_alive: Callable[[int], bool] = pid_is_alive,
    local_space: Callable[[], str | None] = pid_space,
    start_time: Callable[[int], str | None] = process_start_time,
) -> list[str]:
    """Remove session scratch dirs left behind by a server that is gone.

    A directory under ``<workspace>/.sessions/`` is removed when its owner
    marker names a process on this host that is dead, or whose pid a different
    process has since taken over (the recorded start time no longer matches).
    When it has no usable marker, or the marker names no host, or was written on
    another host or in another pid namespace (so its pid cannot be probed here),
    it is removed only if nothing in it has changed for ``max_unmarked_age``
    seconds. A
    directory whose owner is alive, a name in ``keep``, anything not named like a
    session id, and anything that is not a plain directory (a symlink is never
    followed) are left alone. Returns the names removed.

    Call it once at startup, before this server creates a session: a directory
    that is live right now but missing from ``keep`` is judged by its marker
    alone. One that cannot be removed is logged and skipped, never raised.
    ``pid_alive``, ``local_space`` and ``start_time`` exist for tests.
    """
    root = Path(workspace) / SESSIONS_DIRNAME
    if root.is_symlink():
        return []
    try:
        entries = list(os.scandir(root))
    except OSError:  # no .sessions yet, or unreadable
        return []
    current = time.time() if now is None else now
    space = local_space()
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
                path,
                now=current,
                max_unmarked_age=max_unmarked_age,
                pid_alive=pid_alive,
                local_space=space,
                start_time=start_time,
            ):
                continue
            remove_tree(path)
        except Exception as exc:  # noqa: BLE001 — one bad dir must not stop the sweep
            log.warning("could not remove stale session dir %s: %s", path, exc)
            continue
        removed.append(entry.name)
    return removed
