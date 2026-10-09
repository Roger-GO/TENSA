"""``SessionManager.shutdown`` hands back what the sessions it reaped held.

``shutdown`` used to close every session but leave it in the registry. A session
holds its worker handle and its abort ``multiprocessing.Event``, which is five POSIX
semaphores, so they stayed alive for as long as the manager did. A manager that a
reference cycle keeps (an app object that held it, a test's fixture) outlives its
shutdown until the cycle collector runs, and the collector freed those semaphores
at an arbitrary moment: if that moment fell inside the resource tracker's own
start-up, CPython warned "ResourceTracker called reentrantly ... might leak".

It also closes the sessions at the same time. One after the other, a server that
was asked to stop spent the two seconds a busy worker is given once per session.
And it ends the stream of a run it cancels: a client attached to one waits for the
event that ends the stream, and its handler held the server's shutdown up until
uvicorn gave up on it.
"""

from __future__ import annotations

import asyncio
import time
import weakref
from typing import Any

import pytest

from tensa.core.session import SessionManager, _RunBuffer, _Session


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


class _SlowProcess:
    """A worker that takes ``seconds`` to go, or that cannot be waited for."""

    def __init__(self, seconds: float, *, fails: bool = False) -> None:
        self._seconds = seconds
        self._fails = fails

    def join(self, timeout: float | None = None) -> None:
        if self._fails:
            raise RuntimeError("the worker cannot be waited for")
        time.sleep(self._seconds)

    def is_alive(self) -> bool:
        return False


def _manager_with_slow_sessions(processes: list[_SlowProcess]) -> tuple[SessionManager, list[_Pipe]]:
    mgr = SessionManager()
    pipes: list[_Pipe] = []
    for number, process in enumerate(processes):
        pipes.append(_Pipe())
        mgr._sessions[f"s{number}"] = _Session(
            session_id=f"s{number}",
            process=process,
            ctrl=pipes[-1],
            data=_Pipe(),
            abort_event=None,
        )
    return mgr, pipes


def test_shutdown_closes_the_sessions_at_the_same_time() -> None:
    mgr, pipes = _manager_with_slow_sessions([_SlowProcess(0.4) for _ in range(4)])

    started = time.monotonic()
    asyncio.run(mgr.shutdown())
    elapsed = time.monotonic() - started

    assert all(pipe.closed for pipe in pipes)
    # One after the other they take 1.6 s.
    assert elapsed < 1.2, f"four sessions took {elapsed:.2f} s to close"


def test_a_session_that_cannot_be_closed_does_not_keep_the_others_open(
    caplog: pytest.LogCaptureFixture,
) -> None:
    mgr, pipes = _manager_with_slow_sessions(
        [_SlowProcess(0.0, fails=True), _SlowProcess(0.0), _SlowProcess(0.0)]
    )

    with caplog.at_level("WARNING", logger="tensa.session"):
        asyncio.run(mgr.shutdown())

    assert [pipe.closed for pipe in pipes] == [False, True, True]
    assert mgr._sessions == {}
    assert "could not close session s0 at shutdown" in caplog.text


async def test_shutdown_ends_the_stream_of_a_run_it_cancels(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mgr = SessionManager()
    in_the_worker = asyncio.Event()

    async def _never_answers(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        in_the_worker.set()
        await asyncio.Event().wait()
        return {}

    monkeypatch.setattr(mgr, "invoke_streaming", _never_answers)
    run_buf = _RunBuffer(run_id="run-1", session_id="s1", state="running")
    mgr._runs["run-1"] = run_buf
    task = asyncio.create_task(mgr._drive_streaming_run(run_buf, "run_tds_streaming", {}))
    mgr._run_tasks["run-1"] = task
    await in_the_worker.wait()
    # A client attached to the run, parked on its inbox.
    events = mgr.attach_to_run("s1", "run-1", 0)
    first = asyncio.ensure_future(anext(events))
    while not run_buf.consumers:
        await asyncio.sleep(0)

    await mgr.shutdown()

    assert task.cancelled()
    assert await asyncio.wait_for(first, 1) == {
        "type": "error",
        "category": "session-expired",
        "detail": "the server is shutting down",
    }
    with pytest.raises(StopAsyncIteration):
        await anext(events)
