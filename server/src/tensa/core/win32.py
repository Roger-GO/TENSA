"""Windows ``kernel32`` access shared by the scratch-dir and worker-spawn code.

``core/session_dirs.py`` asks Windows whether a pid is alive and when it started;
``core/worker_spawn.py`` puts workers in a Job Object. Both call ``kernel32``
through ``ctypes``, and both need its prototypes declared: a HANDLE is
pointer-sized, and ctypes would pass and return it as a 32-bit int by default.
They used to load and annotate a copy each. This module loads the DLL once and
declares every prototype either of them uses.

Importing it is safe on any OS: nothing touches ``WinDLL`` until
``load_kernel32`` runs, and that raises ``OSError`` anywhere but Windows.
"""

from __future__ import annotations

import ctypes
import sys
import threading
from typing import Any


class FileTime(ctypes.Structure):
    """``FILETIME``: 100 ns ticks since 1601, as two 32-bit halves."""

    _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]


_kernel32: Any = None
_kernel32_lock = threading.Lock()


def load_kernel32() -> Any:
    """The process-wide ``kernel32`` with its prototypes declared (Windows only).

    Loaded on first use and then shared, so every caller sees one set of
    prototypes. Raises ``OSError`` on any other OS.
    """
    global _kernel32
    if sys.platform != "win32":
        raise OSError("kernel32 is only available on Windows")
    with _kernel32_lock:
        if _kernel32 is None:
            _kernel32 = _declare_prototypes(ctypes.WinDLL("kernel32", use_last_error=True))
        return _kernel32


def _declare_prototypes(kernel32: Any) -> Any:
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    # Process liveness and start time (``core/session_dirs.py``).
    kernel32.GetExitCodeProcess.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_uint32),
    ]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p, *[ctypes.POINTER(FileTime)] * 4]
    kernel32.GetProcessTimes.restype = ctypes.c_int
    # Job Objects (``core/worker_spawn.py``).
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    kernel32.SetInformationJobObject.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    kernel32.SetInformationJobObject.restype = ctypes.c_int
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.AssignProcessToJobObject.restype = ctypes.c_int
    return kernel32


def last_error() -> int:
    """``GetLastError`` for the calling thread, as captured by ``use_last_error``.

    ``0`` anywhere but Windows, where there is no such thing.
    """
    if sys.platform != "win32":
        return 0
    return int(ctypes.get_last_error())
