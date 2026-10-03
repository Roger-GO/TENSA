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

A session that loads a case before the child finishes does not wait for it: its
worker generates the code itself, as it always has. Both write the same files.
"""

from __future__ import annotations

import contextlib
import logging
import subprocess
import sys
import threading
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from tensa.core.worker_spawn import attach_kill_on_close_job, worker_spawn_env

# Written into the cache directory by ``tensa warm-cache``: the ANDES version
# whose code was last checked, then which ``__init__.py`` it was checked for. It
# lives beside the code, so deleting the cache deletes the stamp with it.
STAMP_NAME = ".tensa-warm"

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


class BackgroundWarm:
    """A running ``warm-cache`` child, and the thread that says how it ended."""

    # How long ``stop`` waits for the child to end before it kills it.
    _STOP_GRACE_SECONDS = 5.0

    def __init__(self, process: subprocess.Popen[bytes], log: logging.Logger) -> None:
        self._process = process
        self._log = log
        self._started = time.monotonic()
        self._stopping = False
        self._watcher = threading.Thread(
            target=self._watch, name="codegen-warm-watcher", daemon=True
        )
        self._watcher.start()

    def _watch(self) -> None:
        # Draining stderr here also keeps the child from blocking on a full pipe.
        _, stderr = self._process.communicate()
        if self._stopping:
            return
        code = self._process.returncode
        if code == 0:
            self._log.info(
                "ANDES generated code is ready (%.1f s in the background)",
                time.monotonic() - self._started,
            )
            return
        tail = "\n".join(stderr.decode("utf-8", errors="replace").strip().splitlines()[-10:])
        self._log.warning(
            "the background ANDES code generation stopped with exit code %s; "
            "the first case load will generate the code instead.\n%s",
            code,
            tail,
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
        log.warning(
            "could not start the background ANDES code generation (%s); "
            "the first case load will generate the code instead",
            exc,
        )
        return None
    # Windows only: end it with the server, as a worker does. Nothing elsewhere.
    attach_kill_on_close_job(process.pid)
    return BackgroundWarm(process, log)
