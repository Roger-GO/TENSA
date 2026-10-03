"""A real worker imports ANDES's libraries on its own, before any command.

The check reads the worker's memory map for pandas' compiled modules, which the
worker only loads once it warms up: nothing sends it a command here. Linux only,
because it needs ``/proc/<pid>/maps``.
"""

from __future__ import annotations

import asyncio
import sys
import time
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tensa.core.session import SessionManager

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform != "linux", reason="reads /proc/<pid>/maps"),
]

_TIMEOUT_S = 30.0


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


def _maps(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/maps").read_text(encoding="utf-8")
    except OSError:
        return ""


async def test_an_idle_worker_imports_pandas_before_it_gets_a_command(
    manager: SessionManager,
) -> None:
    sid = await manager.create_session()
    pid = manager._sessions[sid].process.pid
    assert pid is not None

    deadline = time.monotonic() + _TIMEOUT_S
    while "pandas/_libs" not in _maps(pid):
        assert time.monotonic() < deadline, "the idle worker never imported pandas"
        assert manager._sessions[sid].process.is_alive(), "the worker died while warming up"
        await asyncio.sleep(0.1)

    # And it still serves: the warm-up ended and the command loop is running.
    assert await manager.invoke(sid, "list_disturbances", {}) == []
