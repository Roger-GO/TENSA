"""Parent-side hygiene around spawning a worker subprocess.

Two things have to be arranged by the server, because the worker cannot do them
for itself in time:

- **BLAS thread caps.** Every worker imports numpy, and numpy's BLAS starts one
  thread per core unless told otherwise. A few workers on a many-core machine
  then fight over the cores. ``worker_spawn_env`` puts a cap in the environment
  of a worker as it starts. It has to be there from the child's first
  instruction: the child reads these variables when numpy loads, and under the
  ``spawn`` start method numpy loads while the child is still re-importing the
  parent's modules, before ``worker_main`` runs.
- **A Windows Job Object.** On Linux a worker asks the kernel to SIGTERM it when
  the server dies (``PR_SET_PDEATHSIG``) and on macOS it polls its parent. Windows
  has neither, so a server that is killed leaves its workers running.
  ``attach_kill_on_close_job`` puts each worker in a Job Object that Windows
  tears down, workers included, when the server process goes away.

Capping threads
---------------
Each of ``OMP_NUM_THREADS``, ``OPENBLAS_NUM_THREADS``, ``MKL_NUM_THREADS``,
``VECLIB_MAXIMUM_THREADS`` and ``NUMEXPR_NUM_THREADS`` defaults to 4 in the
worker. A variable already set in the server's environment is left as it is.
``TENSA_WORKER_THREADS=N`` sets all five to ``N`` whatever else is set.
"""

from __future__ import annotations

import contextlib
import ctypes
import logging
import os
import sys
import threading
from collections.abc import Callable, Iterator, Mapping
from typing import Any

log = logging.getLogger("tensa.worker_spawn")

THREAD_ENV_VARS = (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)
DEFAULT_WORKER_THREADS = 4
WORKER_THREADS_ENV = "TENSA_WORKER_THREADS"

# ``os.environ`` is process-wide, so two spawns must not interleave their edits.
_spawn_env_lock = threading.Lock()


def worker_thread_env(environ: Mapping[str, str]) -> dict[str, str]:
    """The variables to add to ``environ`` for a new worker.

    ``TENSA_WORKER_THREADS`` (a positive integer) wins over everything and
    returns all five variables. Without it, only the variables ``environ`` does
    not already set get the default. A bad ``TENSA_WORKER_THREADS`` is logged and
    ignored.
    """
    raw = environ.get(WORKER_THREADS_ENV)
    if raw is not None:
        try:
            threads = int(raw)
        except ValueError:
            threads = 0
        if threads >= 1:
            return dict.fromkeys(THREAD_ENV_VARS, str(threads))
        log.warning(
            "ignoring %s=%r: expected a positive integer; using the default of %d",
            WORKER_THREADS_ENV,
            raw,
            DEFAULT_WORKER_THREADS,
        )
    return {
        name: str(DEFAULT_WORKER_THREADS) for name in THREAD_ENV_VARS if name not in environ
    }


@contextlib.contextmanager
def worker_spawn_env() -> Iterator[None]:
    """Start a worker inside this block and it gets the thread caps.

    ``multiprocessing`` copies ``os.environ`` when ``Process.start()`` runs. The
    block adds the caps to ``os.environ`` and restores it on exit, so the server's
    own environment is unchanged afterwards (its numpy is long loaded, and nothing
    else it spawns should inherit a cap meant for workers).
    """
    with _spawn_env_lock:
        added = worker_thread_env(os.environ)
        previous = {name: os.environ.get(name) for name in added}
        os.environ.update(added)
        try:
            yield
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value


# ---- Windows Job Object -----------------------------------------------------

_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
_PROCESS_TERMINATE = 0x0001
_PROCESS_SET_QUOTA = 0x0100


class _JobObjectBasicLimitInformation(ctypes.Structure):
    # Fixed-width integers rather than ``wintypes``: ``DWORD`` is ``c_ulong``, which
    # is 8 bytes on LP64 and would make this layout differ from the Windows one.
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JobObjectExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobObjectBasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _load_kernel32() -> Any:
    """``kernel32`` with the prototypes the Job Object calls need (Windows only).

    The prototypes matter: a HANDLE is pointer-sized, and ctypes would pass and
    return it as a 32-bit int by default.
    """
    if sys.platform != "win32":
        raise OSError("Job Objects are only available on Windows")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    kernel32.SetInformationJobObject.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    kernel32.SetInformationJobObject.restype = ctypes.c_int
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.AssignProcessToJobObject.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    return kernel32


def _last_error() -> int:
    if sys.platform != "win32":
        return 0
    return int(ctypes.get_last_error())


class KillOnCloseJob:
    """A Windows Job Object that kills every process in it when its last handle
    closes.

    The handle is held for the life of the server and never closed explicitly:
    when the server process ends, however it ends, Windows closes the handle and
    kills the workers. ``kernel32`` and ``get_last_error`` are injectable so the
    call sequence can be tested on any OS.
    """

    def __init__(
        self,
        kernel32: Any,
        get_last_error: Callable[[], int] = _last_error,
    ) -> None:
        self._kernel32 = kernel32
        self._get_last_error = get_last_error
        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise OSError(f"CreateJobObjectW failed (Windows error {get_last_error()})")
        info = _JobObjectExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            handle,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            error = get_last_error()
            kernel32.CloseHandle(handle)
            raise OSError(f"SetInformationJobObject failed (Windows error {error})")
        self._handle = handle

    def assign(self, pid: int) -> None:
        """Put the process ``pid`` in the job. Raises ``OSError`` on failure."""
        kernel32 = self._kernel32
        process = kernel32.OpenProcess(_PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, pid)
        if not process:
            raise OSError(f"OpenProcess({pid}) failed (Windows error {self._get_last_error()})")
        try:
            if not kernel32.AssignProcessToJobObject(self._handle, process):
                raise OSError(
                    f"AssignProcessToJobObject({pid}) failed "
                    f"(Windows error {self._get_last_error()})"
                )
        finally:
            kernel32.CloseHandle(process)


_job_lock = threading.Lock()
_shared_job: KillOnCloseJob | None = None


def attach_kill_on_close_job(pid: int) -> bool:
    """Make the worker ``pid`` die with the server (Windows only).

    Every worker joins one job shared by the whole server. Returns whether the
    worker was attached. Anywhere but Windows that is ``False`` and nothing
    happens. On Windows any failure (no permission, the server already inside a
    job that forbids nesting) is logged and swallowed: the worker then just lacks
    the safety net, and a failure here must never stop a session from starting.
    """
    if sys.platform != "win32":
        return False
    global _shared_job
    try:
        with _job_lock:
            if _shared_job is None:
                _shared_job = KillOnCloseJob(_load_kernel32(), _last_error)
            job = _shared_job
        job.assign(pid)
    except Exception as exc:  # noqa: BLE001 — never block a session on this
        log.warning(
            "could not put worker %s in a Job Object (%s); it will not be "
            "killed automatically if the server is killed",
            pid,
            exc,
        )
        return False
    return True
