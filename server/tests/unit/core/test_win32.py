"""Unit tests for the shared Windows ``kernel32`` loader (``tensa.core.win32``).

The real DLL only exists on Windows, so a recording fake stands in for
``ctypes.WinDLL`` and the platform check is stubbed; what is verified is that the
DLL is loaded once, that every prototype either caller needs is declared on it,
and that both callers use this loader rather than a copy of their own.
"""

from __future__ import annotations

import ctypes
import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest

from tensa.core import session_dirs, win32, worker_spawn

# Every kernel32 function ``core/session_dirs.py`` or ``core/worker_spawn.py`` calls.
_USED_BY_SESSION_DIRS = {"OpenProcess", "CloseHandle", "GetExitCodeProcess", "GetProcessTimes"}
_USED_BY_WORKER_SPAWN = {
    "OpenProcess",
    "CloseHandle",
    "CreateJobObjectW",
    "SetInformationJobObject",
    "AssignProcessToJobObject",
}


@pytest.fixture
def fake_windows(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """Pretend to be Windows; returns the list of DLLs ``WinDLL`` was asked for."""
    loaded: list[Any] = []

    def fake_windll(name: str, use_last_error: bool = False) -> Any:
        dll = MagicMock(name=f"WinDLL({name})")
        dll.use_last_error = use_last_error
        loaded.append(dll)
        return dll

    monkeypatch.setattr(win32, "sys", types.SimpleNamespace(platform="win32"))
    monkeypatch.setattr(win32, "_kernel32", None)
    # ``WinDLL`` exists in ``ctypes`` only on Windows.
    monkeypatch.setattr(ctypes, "WinDLL", fake_windll, raising=False)
    return loaded


@pytest.mark.skipif(sys.platform == "win32", reason="the guard is for other platforms")
def test_load_kernel32_refuses_to_run_off_windows() -> None:
    with pytest.raises(OSError, match="only available on Windows"):
        win32.load_kernel32()


@pytest.mark.skipif(sys.platform == "win32", reason="the guard is for other platforms")
def test_last_error_is_zero_off_windows() -> None:
    assert win32.last_error() == 0


def test_the_dll_is_loaded_once_and_shared(fake_windows: list[Any]) -> None:
    first = win32.load_kernel32()
    second = win32.load_kernel32()
    assert first is second
    assert len(fake_windows) == 1
    assert fake_windows[0].use_last_error is True


def test_every_prototype_either_caller_needs_is_declared(fake_windows: list[Any]) -> None:
    kernel32 = win32.load_kernel32()
    for name in _USED_BY_SESSION_DIRS | _USED_BY_WORKER_SPAWN:
        function = getattr(kernel32, name)
        # The fake DLL is a MagicMock, so an attribute nobody assigned reads back as
        # a MagicMock, never as None: test for that rather than for ``is not None``.
        assert isinstance(function.argtypes, list), f"{name} has no argtypes"
        assert not isinstance(function.restype, MagicMock), f"{name} has no restype"
    # A HANDLE is pointer-sized; the default int conversion would truncate it.
    assert kernel32.OpenProcess.restype is ctypes.c_void_p
    assert kernel32.CreateJobObjectW.restype is ctypes.c_void_p
    assert kernel32.CloseHandle.argtypes == [ctypes.c_void_p]
    assert len(kernel32.GetProcessTimes.argtypes) == 5


def test_both_callers_use_the_shared_loader() -> None:
    assert session_dirs._load_kernel32 is win32.load_kernel32
    assert worker_spawn._load_kernel32 is win32.load_kernel32
    assert session_dirs._last_error is win32.last_error
    assert worker_spawn._last_error is win32.last_error
    assert not hasattr(session_dirs, "_FileTime")


def test_filetime_is_two_32_bit_halves() -> None:
    assert ctypes.sizeof(win32.FileTime) == 8
    ticks = win32.FileTime()
    ticks.dwLowDateTime = 0xFFFFFFFF
    ticks.dwHighDateTime = 1
    assert (ticks.dwHighDateTime << 32) | ticks.dwLowDateTime == 0x1FFFFFFFF
