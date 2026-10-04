"""The ANDES generated-code cache, and warming it while the server starts.

ANDES turns its symbolic model equations into Python source the first time it
needs them and keeps the result in ``~/.andes/pycode``. A machine without it pays
for the generation inside the first case load: about 30 s on a laptop, a minute
or two on a small CI runner. ``tensa warm-cache`` does the work ahead of time, but
a step nobody was told about does not get run, and an ANDES upgrade brings the
cost back unannounced.

``tensa serve`` therefore looks at the cache as it starts. When the code is
missing, or nobody has checked it against the installed ANDES, the server runs
``tensa warm-cache --quick --incremental`` in a child process. It is a child
process because the server never imports ANDES, and the generation keeps every
core busy for a while. The child generates what is missing or stale and, when it
succeeds, leaves a stamp in the cache directory that names the ANDES version it
checked, so the next start skips it.

The stamp is ours, not ANDES's. ANDES writes its version into ``__init__.py``
too, but only when it regenerates something, so after an ANDES patch release
that changes no model that file would look out of date forever. The stamp also
records which ``__init__.py`` it was written for (its mtime and size). The
directory is shared by every Python environment on the machine, and any ANDES
that regenerates code rewrites that file, so a stamp whose file has changed no
longer vouches for anything.

A session that loads a case while the child is still generating waits for it
rather than generating the code itself. Two generations at once would each run
a process per core, so on a small machine the load would end up slower than with
no background child at all. The child's life is announced by a marker file
beside the cache directory that the server keeps fresh while the child runs, and
that ``wait_for_background_warm`` (called by a worker before it builds a System)
watches. The marker is only ever a hint: one nobody has refreshed lately is a
leftover of a server that died, and a wait has an upper bound, after which the
worker generates the code itself as it always has.

Every server on the machine shares that one marker, so the server that finds a
live one leaves the generation to its owner (it is created exclusively, so two
servers starting together cannot both claim it), and each server removes or
refreshes the marker only while it still holds the token it wrote into it. Two
cases still run side by side: a worker that gave up waiting, and a ``tensa warm-cache`` run by hand (it
leaves no marker) while a server is loading. ANDES writes each model file in
place, so a worker that imports one while the other process rewrites it can in
principle fail that load, and loading again fixes it. Nobody has seen that happen.
"""

from __future__ import annotations

import contextlib
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from tensa.core.worker_spawn import attach_kill_on_close_job, worker_spawn_env

_log = logging.getLogger("tensa.codegen_cache")

# Written into the cache directory by ``tensa warm-cache``: the ANDES version
# whose code was last checked, then which ``__init__.py`` it was checked for. It
# lives beside the code, so deleting the cache deletes the stamp with it.
STAMP_NAME = ".tensa-warm"

# Exists while a background child is generating. It sits beside the cache
# directory, not in it, because the directory may not exist yet.
RUNNING_NAME = ".tensa-warm.running"

# A marker nobody has refreshed for this long belongs to a server that died
# without clearing it.
MARKER_STALE_SECONDS = 15.0

# The longest a worker waits for the background child before it generates the
# code itself. Well above a generation on a small CI runner.
WAIT_SECONDS = 300.0

CacheState = Literal["ready", "unchecked", "missing"]


def pycode_dir() -> Path:
    """Where ANDES keeps its generated code unless it is told otherwise."""
    return Path.home() / ".andes" / "pycode"


def _init_fingerprint(directory: Path) -> str | None:
    """Which ``__init__.py`` the cache holds, as its mtime and size.

    ANDES rewrites the file whenever it generates code, so a change means some
    ANDES touched the cache. ``None`` when it cannot be read.
    """
    try:
        stat = (directory / "__init__.py").stat()
    except OSError:
        return None
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def cache_state(andes_version: str, directory: Path | None = None) -> CacheState:
    """Whether the cache in ``directory`` (default: ANDES's) is ready to use.

    ``missing``: ANDES has generated nothing. ``unchecked``: there is code, but no
    stamp for ``andes_version`` and this ``__init__.py``, so ANDES may have
    upgraded, or another ANDES regenerated the code, since it was checked.
    ``ready``: stamped for both.
    """
    directory = pycode_dir() if directory is None else directory
    try:
        has_code = (directory / "__init__.py").is_file()
    except OSError:
        return "unchecked"
    if not has_code:
        return "missing"
    try:
        stamped = (directory / STAMP_NAME).read_text(encoding="utf-8").split()
    except (OSError, ValueError):
        return "unchecked"
    return "ready" if stamped == [andes_version, _init_fingerprint(directory)] else "unchecked"


def mark_cache_checked(andes_version: str, directory: Path | None = None) -> None:
    """Record that the cache in ``directory`` was checked against ``andes_version``.

    A directory without generated code, or one that cannot be written, is left
    unstamped, so the next start checks again.
    """
    directory = pycode_dir() if directory is None else directory
    fingerprint = _init_fingerprint(directory)
    if fingerprint is None:
        return
    with contextlib.suppress(OSError):
        (directory / STAMP_NAME).write_text(f"{andes_version}\n{fingerprint}\n", encoding="utf-8")


def running_marker(directory: Path | None = None) -> Path:
    """The marker file that says a background child is generating the code in
    ``directory`` (default: ANDES's)."""
    directory = pycode_dir() if directory is None else directory
    return directory.parent / RUNNING_NAME


def background_warm_running(directory: Path | None = None) -> bool:
    """Whether a background child is generating the code right now.

    True while the marker exists and was refreshed within
    ``MARKER_STALE_SECONDS``. Never raises: this runs on the case-load path.
    """
    try:
        age = time.time() - running_marker(directory).stat().st_mtime
    except (OSError, RuntimeError):  # RuntimeError: no home directory to look in
        return False
    return age < MARKER_STALE_SECONDS


def wait_for_background_warm(
    directory: Path | None = None, *, timeout: float = WAIT_SECONDS, poll: float = 0.2
) -> float:
    """Block while a background child is generating the code, so that the caller's
    own generation does not compete with it for the cores.

    A worker calls this before it builds a System (building one is what makes
    ANDES generate missing code). Returns how many seconds it waited: ``0.0``
    when nothing was running, which costs one ``stat``. After ``timeout`` it
    stops waiting and returns, and the caller generates the code itself.
    """
    if not background_warm_running(directory):
        return 0.0
    _log.info("waiting for the background ANDES code generation to finish")
    started = time.monotonic()
    while background_warm_running(directory):
        waited = time.monotonic() - started
        if waited >= timeout:
            _log.warning(
                "the background ANDES code generation is still running after %.0f s; "
                "generating the code here instead",
                waited,
            )
            return waited
        time.sleep(poll)
    return time.monotonic() - started


class BackgroundWarm:
    """A running ``warm-cache`` child, and the thread that says how it ended.

    While the child runs, a second thread keeps ``marker`` fresh (see
    ``wait_for_background_warm``); the marker is removed when the child ends or is
    stopped. ``token`` is what this server wrote into the marker: with one, the
    marker is touched and removed only while the file still holds it, so a server
    that took over a marker it thought dead is not undone by the original owner.
    """

    # How long ``stop`` waits for the child to end before it kills it.
    _STOP_GRACE_SECONDS = 5.0
    # How often the marker is touched. Far below ``MARKER_STALE_SECONDS``, so a
    # server busy with the generation's CPU load still keeps it fresh.
    _HEARTBEAT_SECONDS = 1.0

    def __init__(
        self,
        process: subprocess.Popen[bytes],
        log: logging.Logger,
        marker: Path | None = None,
        token: str | None = None,
    ) -> None:
        self._process = process
        self._log = log
        self._marker = marker
        self._token = token
        self._started = time.monotonic()
        self._stopping = False
        self._ended = threading.Event()
        self._beater: threading.Thread | None = None
        if marker is not None:
            self._beater = threading.Thread(
                target=self._beat, args=(marker,), name="codegen-warm-marker", daemon=True
            )
            self._beater.start()
        self._watcher = threading.Thread(
            target=self._watch, name="codegen-warm-watcher", daemon=True
        )
        self._watcher.start()

    def _owns_marker(self, marker: Path) -> bool:
        """Whether ``marker`` still holds this server's token (always, without one)."""
        if self._token is None:
            return True
        try:
            return marker.read_text(encoding="utf-8") == self._token
        except (OSError, ValueError):
            return False

    def _beat(self, marker: Path) -> None:
        while not self._ended.wait(self._HEARTBEAT_SECONDS):
            try:
                if not self._owns_marker(marker):
                    return
                # Refreshes the marker without ever creating it, so a beat that
                # lands after ``_clear_marker`` cannot bring it back.
                os.utime(marker)
            except OSError:
                return

    def _clear_marker(self) -> None:
        """Stop refreshing the marker and remove it. Safe to call more than once."""
        self._ended.set()
        if self._marker is None:
            return
        # Joined first: Windows refuses to delete a file a thread has open.
        if self._beater is not None:
            self._beater.join(self._STOP_GRACE_SECONDS)
        with contextlib.suppress(OSError):
            if self._owns_marker(self._marker):
                self._marker.unlink(missing_ok=True)

    def _watch(self) -> None:
        # Draining stderr here also keeps the child from blocking on a full pipe.
        _, stderr = self._process.communicate()
        self._clear_marker()
        if self._stopping:
            return
        code = self._process.returncode
        if code == 0:
            self._log.info(
                "ANDES generated code is ready (%.1f s in the background)",
                time.monotonic() - self._started,
            )
            return
        lines = stderr.decode("utf-8", errors="replace").strip().splitlines()
        if _was_interrupted(code, lines):
            # Ctrl+C reaches the child with the server, ahead of the server's own
            # shutdown, and so can a service manager's SIGTERM. Someone stopped it
            # on purpose, which is not a failure to warn about.
            self._log.info(
                "the background ANDES code generation was interrupted (exit code %s); "
                "the first case load will generate the code instead",
                code,
            )
            return
        self._log.warning(
            "the background ANDES code generation stopped with exit code %s; "
            "the first case load will generate the code instead.\n%s",
            code,
            "\n".join(lines[-10:]),
        )

    def stop(self) -> None:
        """End the child if it is still running. Safe to call more than once."""
        self._stopping = True
        if self._process.poll() is None:
            with contextlib.suppress(OSError):
                self._process.terminate()
        self._watcher.join(self._STOP_GRACE_SECONDS)
        if self._watcher.is_alive():
            # It ignored the request to end.
            with contextlib.suppress(OSError):
                self._process.kill()
            self._watcher.join(self._STOP_GRACE_SECONDS)
        # The watcher clears it when the child is gone; this covers one that is not.
        self._clear_marker()


def _was_interrupted(code: int | None, stderr_lines: Sequence[str]) -> bool:
    """Whether a child that exited with ``code`` was ended by Ctrl+C or SIGTERM.

    On POSIX that is a death by the signal (a negative code); the traceback's last
    line covers Windows, where Ctrl+C gives an ordinary exit code.
    """
    if code in (-signal.SIGINT, -signal.SIGTERM):
        return True
    return bool(stderr_lines) and stderr_lines[-1].strip().startswith("KeyboardInterrupt")


class _MarkerHeldError(Exception):
    """A live marker already exists: another server's child is generating the code."""


def _claim_running_marker(directory: Path | None) -> tuple[Path, str] | None:
    """Create the marker, with a token of this claim written into it.

    The file is created exclusively, so of two servers starting together only one
    gets it. A marker nobody has refreshed lately is a leftover of a server that
    died, and is replaced.

    Returns ``None`` when the marker cannot be created (the child then runs
    unannounced, and a loading worker does not wait for it).

    Raises:
        _MarkerHeldError: a live marker exists, so someone else is generating.
    """
    marker = running_marker(directory)
    token = f"{os.getpid()}-{uuid.uuid4().hex}"
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    for _ in range(2):
        try:
            fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if not marker.is_file():
                return None  # something else sits there; the child runs unannounced
            if background_warm_running(directory):
                raise _MarkerHeldError from None
            with contextlib.suppress(OSError):
                marker.unlink(missing_ok=True)
            continue
        except OSError:
            return None
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(token)
        except OSError:
            with contextlib.suppress(OSError):
                marker.unlink(missing_ok=True)
            return None
        return marker, token
    return None


def start_background_warm(
    andes_version: str,
    log: logging.Logger,
    *,
    directory: Path | None = None,
    command: Sequence[str] | None = None,
) -> BackgroundWarm | None:
    """Start ``tensa warm-cache`` in a child process unless the cache is ready.

    Returns ``None`` when there is nothing to do, or when the child cannot be
    started: warming is an optimisation, so neither stops the server. ``command``
    replaces the child's command line (for tests).
    """
    state = cache_state(andes_version, directory)
    if state == "ready":
        return None
    # Before the child exists, so a case loaded in the meantime already sees it.
    # A live marker belongs to another server's child, which is doing this work:
    # a second one would only share its cores and, finishing first, take away
    # the marker its owner still needs.
    try:
        claim = _claim_running_marker(directory)
    except _MarkerHeldError:
        log.info(
            "another tensa serve is already generating the ANDES code; "
            "a case loaded meanwhile waits for it"
        )
        return None
    marker, token = claim if claim is not None else (None, None)
    if state == "missing":
        log.info(
            "ANDES generated code not found; generating it in the background "
            "so that the first case load does not wait for it"
        )
    else:
        log.info("checking the ANDES generated code in the background")
    argv = (
        list(command)
        if command is not None
        else [sys.executable, "-m", "tensa", "warm-cache", "--quick", "--incremental"]
    )
    try:
        # The same thread caps a worker gets: ANDES spawns a process per core.
        with worker_spawn_env():
            process = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
    except OSError as exc:
        if marker is not None:
            # Ours, since the claim just wrote it.
            with contextlib.suppress(OSError):
                marker.unlink(missing_ok=True)
        log.warning(
            "could not start the background ANDES code generation (%s); "
            "the first case load will generate the code instead",
            exc,
        )
        return None
    # Windows only: end it with the server, as a worker does. Nothing elsewhere.
    attach_kill_on_close_job(process.pid)
    return BackgroundWarm(process, log, marker, token)
