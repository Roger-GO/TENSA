"""Integration tests for worker hygiene against real worker processes.

- A worker ignores Ctrl+C (SIGINT) and stays up and responsive.
- A worker that dies in native code leaves the Python stack of its threads on stderr.
- The clone scratch dir records the server (pid, pid space, start time), so a later
  server can tell it was abandoned, and closing the session removes it.
- A worker's ordinary work, a power flow, a report and the bundle of an edited case, prints
  no out-of-workspace warning: its libraries, its own scratch directories and TENSA's own
  files are not strays.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tensa.core.session import SessionManager
from tensa.core.session_dirs import (
    OWNER_MARKER_NAME,
    SESSIONS_DIRNAME,
    pid_space,
    process_start_time,
    read_owner_marker,
)
from tests._crash import without_core_dump

pytestmark = pytest.mark.integration


@pytest.fixture
async def manager(tmp_path: Path) -> AsyncIterator[SessionManager]:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    try:
        yield mgr
    finally:
        await mgr.shutdown()


@pytest.mark.skipif(sys.platform == "win32", reason="os.kill cannot deliver SIGINT on Windows")
async def test_a_worker_ignores_sigint_and_keeps_serving(manager: SessionManager) -> None:
    """Ctrl+C in the terminal reaches every process in the foreground group. Before
    the fix each worker raised KeyboardInterrupt out of its command loop, printed a
    traceback, and exited, so the session was dead."""
    sid = await manager.create_session()
    # A first round trip proves the worker has finished importing and is serving
    # (SIGINT is ignored from the moment worker_main starts).
    assert await manager.invoke(sid, "list_disturbances", {}) == []

    proc = manager._sessions[sid].process
    assert proc.pid is not None
    os.kill(proc.pid, signal.SIGINT)
    await asyncio.sleep(0.5)

    assert proc.is_alive(), f"worker died on SIGINT (exit code {proc.exitcode})"
    assert await manager.invoke(sid, "list_disturbances", {}) == []


async def test_the_clone_dir_records_the_server_as_its_owner(
    manager: SessionManager, tmp_path: Path
) -> None:
    import andes

    raw = Path(andes.__file__).parent / "cases" / "ieee14" / "ieee14.raw"
    case = tmp_path / "ws" / "ieee14.raw"
    shutil.copy2(raw, case)
    sid = await manager.create_session()
    await manager.invoke(sid, "load_case", {"path": str(case)})
    await manager.invoke(sid, "init_clone", {})

    session_root = tmp_path / "ws" / SESSIONS_DIRNAME / sid
    # The worker wrote the marker, but it names this process (the server), with
    # the pid space and start time a later server needs to tell it from a stranger
    # that happens to have the same pid.
    marker = read_owner_marker(session_root)
    assert marker is not None
    assert marker.pid == os.getpid()
    assert marker.space == pid_space()
    assert marker.start == process_start_time(os.getpid())
    # It sits beside ``clone/``, so resetting the clone does not delete it.
    assert (session_root / OWNER_MARKER_NAME).is_file()
    await manager.invoke(sid, "reset_clone", {})
    assert (session_root / OWNER_MARKER_NAME).is_file()

    await manager.close_session(sid)
    assert not session_root.exists()


@pytest.mark.skipif(sys.platform == "win32", reason="os.kill cannot deliver SIGSEGV on Windows")
async def test_a_worker_that_crashes_natively_prints_its_stack(
    manager: SessionManager, capfd: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A segfault in a C extension kills the process outright; before the worker
    enabled ``faulthandler`` the server's log said nothing about why a session's
    worker was gone. SIGSEGV is sent from outside, which the handler cannot tell from
    a crash, and the worker inherits this test's stderr, which ``capfd`` reads."""
    monkeypatch.delenv("PYTHONFAULTHANDLER", raising=False)  # the worker must enable it itself
    sid = await manager.create_session()
    # A round trip proves the worker is serving, so ``worker_main`` has run its setup.
    assert await manager.invoke(sid, "list_disturbances", {}) == []

    proc = manager._sessions[sid].process
    assert proc.pid is not None
    # The signal is real and so would its core dump be: a crash report on the
    # machine that runs the suite, of a crash that never happened.
    without_core_dump(proc.pid)
    os.kill(proc.pid, signal.SIGSEGV)
    proc.join(30)

    assert proc.exitcode == -signal.SIGSEGV
    err = capfd.readouterr().err
    assert "Fatal Python error: Segmentation fault" in err
    assert "most recent call first" in err


async def test_a_worker_prints_no_out_of_workspace_warning_for_its_ordinary_work(
    manager: SessionManager, tmp_path: Path, capfd: pytest.CaptureFixture[str]
) -> None:
    """Every worker logged about eleven warnings before its first power flow finished (the
    null device ``dill`` opens when it is imported, the system's MIME maps, the probe the
    standard library makes for a temporary directory), and three more for every report: the
    files and the directory ANDES wrote into. A user who read the server's console took them
    for something a case file had done. The worker inherits this test's stderr, which
    ``capfd`` reads."""
    import andes

    shutil.copy2(
        Path(andes.__file__).parent / "cases" / "ieee14" / "ieee14_full.xlsx",
        tmp_path / "ws" / "ieee14_full.xlsx",
    )
    sid = await manager.create_session()
    await manager.invoke(sid, "load_case", {"path": str(tmp_path / "ws" / "ieee14_full.xlsx")})
    assert (await manager.invoke(sid, "run_pflow", {}))["converged"] is True
    report = await manager.invoke(sid, "generate_report", {"routine": "pflow"})
    assert report["routine"] == "pflow"
    await manager.close_session(sid)
    # A case that was edited is exported through a scratch directory of its own.
    edited = await manager.create_session()
    await manager.invoke(edited, "load_case", {"path": str(tmp_path / "ws" / "ieee14_full.xlsx")})
    await manager.invoke(edited, "edit_element", {"model": "Bus", "idx": 1, "params": {"Vn": 138}})
    bundle = await manager.invoke(edited, "export_bundle", {})
    assert isinstance(bundle, bytes)
    await manager.close_session(edited)

    err = capfd.readouterr().err
    assert "strict-fs" not in err, err
