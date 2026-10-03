"""``SessionManager.shutdown`` hands back what the sessions it reaped held.

``shutdown`` used to close every session but leave it in the registry. A session
holds its worker handle and its abort ``multiprocessing.Event``, which is five POSIX
semaphores, so they stayed alive for as long as the manager did. A manager that a
reference cycle keeps (an app object that held it, a test's fixture) outlives its
shutdown until the cycle collector runs, and the collector freed those semaphores
at an arbitrary moment: if that moment fell inside the resource tracker's own
start-up, CPython warned "ResourceTracker called reentrantly ... might leak".
"""

from __future__ import annotations

import asyncio
import weakref
from typing import Any

from tensa.core.session import SessionManager, _Session


class _ExitedProcess:
    """A worker that is already gone."""

    def join(self, timeout: float | None = None) -> None:
        return None

    def is_alive(self) -> bool:
        return False


class _Pipe:
    """One end of a worker pipe."""

    def __init__(self) -> None:
        self.closed = False

    def send(self, message: dict[str, Any]) -> None:
        return None

    def close(self) -> None:
        self.closed = True


def _manager_with_one_session() -> tuple[SessionManager, weakref.ref[Any], _Pipe]:
    mgr = SessionManager()
    ctrl = _Pipe()
    abort_event = mgr._spawn_ctx.Event()
    mgr._sessions["s1"] = _Session(
        session_id="s1",
        process=_ExitedProcess(),
        ctrl=ctrl,
        data=_Pipe(),
        abort_event=abort_event,
    )
    return mgr, weakref.ref(abort_event), ctrl


def test_shutdown_closes_the_sessions_and_drops_them_from_the_registry() -> None:
    mgr, _, ctrl = _manager_with_one_session()

    asyncio.run(mgr.shutdown())

    assert ctrl.closed
    assert mgr._sessions == {}
    assert mgr.list_sessions() == []


def test_shutdown_frees_the_abort_event_while_the_manager_is_still_referenced() -> None:
    mgr, abort_event, _ = _manager_with_one_session()
    assert abort_event() is not None

    asyncio.run(mgr.shutdown())

    # ``mgr`` is still in scope, as it is while something else points at it. No
    # ``gc.collect()`` here: reference counting alone must have released the Event.
    assert abort_event() is None


def test_shutdown_twice_is_harmless() -> None:
    mgr, _, _ = _manager_with_one_session()

    async def twice() -> None:
        await mgr.shutdown()
        await mgr.shutdown()

    asyncio.run(twice())

    assert mgr._sessions == {}
