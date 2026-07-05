"""Part A — worker-death detection + structured ``WorkerDiedError``.

When a per-session worker subprocess dies mid-RPC, the parent's
``sess.ctrl.send`` / ``sess.data.recv`` raises a raw IPC error (``EOFError`` /
``BrokenPipeError`` / ``ConnectionResetError`` / ``OSError``). Before the fix
this propagated uncaught → a bare HTTP 500, and the session stayed marked
active so EVERY subsequent call ALSO 500'd (a zombie session with no guidance).

These tests pin the fix:

- ``invoke`` translates the torn-pipe error into ``WorkerDiedError``.
- The session is marked ``closed`` + dropped from the registry, and stamped
  with a ``death_reason``.
- A SECOND ``invoke`` on the now-dead session fast-fails as
  ``SessionExpiredError`` carrying the worker-death message (not the generic
  "not active" one).
- ``WorkerDiedError`` exposes the 503 / ``reload-case`` class attributes and
  the exact actionable user-facing message.

Driven via ``asyncio.run`` rather than ``async def`` test functions so they run
without pytest-asyncio (not installed in the lean ``PYTHONPATH=src`` env) —
mirrors ``tests/unit/test_session_busy.py``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from tensa.core.errors import WorkerDiedError
from tensa.core.session import SessionExpiredError, SessionManager, _Session

# --- fakes -------------------------------------------------------------------


class _FakeCtrl:
    """Stand-in for the worker control Pipe end; records what was sent."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed = False

    def send(self, msg: dict[str, Any]) -> None:
        self.sent.append(msg)

    def close(self) -> None:
        self.closed = True


class _DeadData:
    """``recv`` raises a torn-pipe error, simulating a worker that died."""

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc
        self.closed = False

    def recv(self) -> dict[str, Any]:
        raise self._exc

    def close(self) -> None:
        self.closed = True


class _FakeProc:
    """Minimal ``mp.Process`` stand-in for the teardown path."""

    def __init__(self, alive: bool = False) -> None:
        self._alive = alive
        self.terminated = False
        self.killed = False

    def is_alive(self) -> bool:
        return self._alive

    def terminate(self) -> None:
        self.terminated = True
        self._alive = False

    def kill(self) -> None:
        self.killed = True
        self._alive = False

    def join(self, timeout: float | None = None) -> None:
        self._alive = False


def _make_dead_session(
    session_id: str = "s1",
    *,
    exc: BaseException | None = None,
    proc: _FakeProc | None = None,
) -> _Session:
    ctrl = _FakeCtrl()
    data = _DeadData(exc if exc is not None else EOFError("worker gone"))
    return _Session(
        session_id=session_id,
        process=proc if proc is not None else _FakeProc(),
        ctrl=ctrl,
        data=data,
        abort_event=None,
    )


# --- WorkerDiedError class contract ------------------------------------------


def test_worker_died_error_class_attrs() -> None:
    assert WorkerDiedError.recovery_kind == "reload-case"
    assert WorkerDiedError.http_status == 503


def test_worker_died_error_default_message_is_actionable() -> None:
    err = WorkerDiedError()
    msg = str(err)
    # The exact user-facing message: names the likely cause AND the recovery.
    assert "worker stopped unexpectedly" in msg
    assert "safe on disk" in msg
    assert "reload it" in msg
    assert err.detail == msg


def test_worker_died_error_custom_detail() -> None:
    err = WorkerDiedError("custom boom")
    assert str(err) == "custom boom"
    assert err.detail == "custom boom"


# --- invoke detects worker death ---------------------------------------------


def test_invoke_raises_worker_died_on_eof() -> None:
    async def _run() -> None:
        mgr = SessionManager()
        sess = _make_dead_session("s1", exc=EOFError("worker gone"))
        mgr._sessions["s1"] = sess

        with pytest.raises(WorkerDiedError):
            await mgr.invoke("s1", "reload")

        # Session marked dead, dropped from the registry, death reason stamped.
        assert sess.closed is True
        assert sess.death_reason is not None
        assert "s1" not in mgr._sessions
        # Lock released even though _rpc raised (finally arm).
        assert sess.lock.acquire(blocking=False)
        sess.lock.release()

    asyncio.run(_run())


@pytest.mark.parametrize(
    "exc",
    [
        EOFError("worker gone"),
        BrokenPipeError("pipe"),
        ConnectionResetError("reset"),
        OSError(9, "Bad file descriptor"),
    ],
)
def test_invoke_raises_worker_died_for_all_ipc_errors(exc: BaseException) -> None:
    async def _run() -> None:
        mgr = SessionManager()
        sess = _make_dead_session("s1", exc=exc)
        mgr._sessions["s1"] = sess
        with pytest.raises(WorkerDiedError):
            await mgr.invoke("s1", "reload")
        assert sess.closed is True

    asyncio.run(_run())


def test_second_invoke_after_death_fast_fails_with_death_reason() -> None:
    """The zombie-session fix: after the worker dies, the session is gone from
    the registry so a follow-up call fast-fails as ``SessionExpiredError`` (NOT
    another raw 500), and — because we stamped ``death_reason`` — the message
    names the crash + recovery rather than the generic 'not active'."""

    async def _run() -> None:
        mgr = SessionManager()
        sess = _make_dead_session("s1", exc=EOFError("worker gone"))
        mgr._sessions["s1"] = sess

        with pytest.raises(WorkerDiedError):
            await mgr.invoke("s1", "reload")

        # Second call: the registry no longer holds the session, but the
        # _Session object still carries death_reason. We re-register it under the
        # same id to prove the death-reason message is surfaced when the closed
        # session is still discoverable (the in-registry-but-closed race).
        mgr._sessions["s1"] = sess
        with pytest.raises(SessionExpiredError) as excinfo:
            await mgr.invoke("s1", "snapshots")
        assert "worker stopped unexpectedly" in str(excinfo.value)

    asyncio.run(_run())


def test_second_invoke_after_death_when_dropped_is_session_expired() -> None:
    """When the dead session has been fully dropped from the registry, a
    follow-up call still fast-fails cleanly (generic not-active message) rather
    than 500'ing — the un-reregistered path."""

    async def _run() -> None:
        mgr = SessionManager()
        sess = _make_dead_session("s1", exc=EOFError("worker gone"))
        mgr._sessions["s1"] = sess

        with pytest.raises(WorkerDiedError):
            await mgr.invoke("s1", "reload")

        # Not re-registered: the session is gone from the registry entirely.
        with pytest.raises(SessionExpiredError) as excinfo:
            await mgr.invoke("s1", "snapshots")
        assert "not active" in str(excinfo.value)

    asyncio.run(_run())


def test_invoke_terminates_live_zombie_worker() -> None:
    """A worker that tore its pipe but is still 'alive' (a half-dead zombie) is
    terminated/killed during cleanup so no orphan process lingers."""

    async def _run() -> None:
        mgr = SessionManager()
        proc = _FakeProc(alive=True)
        sess = _make_dead_session("s1", exc=EOFError("worker gone"), proc=proc)
        mgr._sessions["s1"] = sess

        with pytest.raises(WorkerDiedError):
            await mgr.invoke("s1", "reload")

        assert proc.terminated is True
        # Pipes closed during teardown.
        assert sess.ctrl.closed is True
        assert sess.data.closed is True

    asyncio.run(_run())


def test_invoke_on_already_dead_session_does_not_500() -> None:
    """``invoke`` on a session already flagged ``closed`` raises the structured
    ``SessionExpiredError`` (the death-reason variant), never a raw error."""

    async def _run() -> None:
        mgr = SessionManager()
        sess = _make_dead_session("s1")
        sess.closed = True
        sess.death_reason = WorkerDiedError().detail
        mgr._sessions["s1"] = sess

        with pytest.raises(SessionExpiredError) as excinfo:
            await mgr.invoke("s1", "reload")
        assert "worker stopped unexpectedly" in str(excinfo.value)

    asyncio.run(_run())
