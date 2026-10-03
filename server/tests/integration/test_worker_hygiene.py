"""Integration tests for worker hygiene (unit 1.7) against real worker processes.

- A worker ignores Ctrl+C (SIGINT) and stays up and responsive.
- The clone scratch dir records the server (pid, pid space, start time), so a later
  server can tell it was abandoned, and closing the session removes it.
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
