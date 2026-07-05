"""Unit 2 — non-blocking session gate + ``SessionBusyError``.

Substrate-level coverage of the v3.1 UX-overhaul Unit 2 contract:

- ``SessionBusyError`` carries the in-flight ``JobRecord`` (or ``None``) and
  exposes the ``recovery_kind`` / ``http_status`` class attributes the routes
  layer (Unit 4a) keys off.
- ``_current_inflight_job`` resolves the running/pending job from a session's
  registry, or ``None`` when empty.
- ``SessionManager.invoke`` try-acquires the per-session ``RLock``: a second
  concurrent invocation fails fast with ``SessionBusyError`` while the first
  holds the lock; ``bypass_session_gate=True`` re-enters without raising.

The HTTP 409 mapping (and ``current_job`` population from per-route
registration) land in Unit 4a / Unit 5 respectively; this module proves the
substrate behaviour those layers build on.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from tensa.core.errors import SessionBusyError
from tensa.core.jobs import _JobRegistry
from tensa.core.session import SessionManager, _current_inflight_job, _Session

# --- fakes -------------------------------------------------------------------


class _FakeCtrl:
    """Stand-in for the worker control Pipe end; records what was sent."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send(self, msg: dict[str, Any]) -> None:
        self.sent.append(msg)


class _BlockingData:
    """``recv`` signals the lock is held, then blocks until the test releases."""

    def __init__(self, entered: threading.Event, release: threading.Event) -> None:
        self._entered = entered
        self._release = release

    def recv(self) -> dict[str, Any]:
        self._entered.set()
        if not self._release.wait(timeout=5.0):
            raise TimeoutError("test never released the blocking recv")
        return {"type": "result", "payload": {"ok": True}}


class _ImmediateData:
    """``recv`` returns a result payload immediately."""

    def __init__(self, payload: dict[str, Any] | None = None) -> None:
        self._payload = payload if payload is not None else {"ok": True}

    def recv(self) -> dict[str, Any]:
        return {"type": "result", "payload": self._payload}


def _make_session(
    session_id: str = "s1", *, ctrl: Any = None, data: Any = None
) -> _Session:
    """Build a real ``_Session`` with stubbed Pipe ends. ``process`` and
    ``abort_event`` are not touched by ``invoke`` so ``None`` is safe."""
    return _Session(
        session_id=session_id,
        process=None,
        ctrl=ctrl if ctrl is not None else _FakeCtrl(),
        data=data if data is not None else _ImmediateData(),
        abort_event=None,
    )


# --- SessionBusyError --------------------------------------------------------


def test_session_busy_error_class_attrs() -> None:
    assert SessionBusyError.recovery_kind == "wait-for-job"
    assert SessionBusyError.http_status == 409


def test_session_busy_error_default_current_job_is_none() -> None:
    err = SessionBusyError()
    assert err.current_job is None
    assert "busy" in str(err)


def test_session_busy_error_carries_current_job() -> None:
    reg = _JobRegistry()
    job_id = reg.register_job(kind="eig", can_cancel=False)
    reg.mark_running(job_id)
    job = reg.get_job(job_id)
    assert job is not None
    err = SessionBusyError(current_job=job)
    assert err.current_job is job
    assert "eig" in str(err)
    assert job_id in str(err)


# --- _current_inflight_job ---------------------------------------------------


def test_current_inflight_job_empty_registry_returns_none() -> None:
    sess = _make_session()
    assert _current_inflight_job(sess) is None


def test_current_inflight_job_prefers_running_over_pending() -> None:
    sess = _make_session()
    reg = sess.job_registry
    pending_id = reg.register_job(kind="pflow", can_cancel=False)
    running_id = reg.register_job(kind="tds-stream", can_cancel=True)
    reg.mark_running(running_id)
    job = _current_inflight_job(sess)
    assert job is not None
    assert job.id == running_id
    assert job.status == "running"
    assert job.id != pending_id


def test_current_inflight_job_returns_pending_when_no_running() -> None:
    sess = _make_session()
    pending_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    job = _current_inflight_job(sess)
    assert job is not None
    assert job.id == pending_id


def test_current_inflight_job_returns_most_recently_updated_within_bucket() -> None:
    """The within-bucket tie-break is ``max(updated_at)``, not insertion
    order. Three running jobs, with the middle-inserted one updated last —
    the helper must return that one, not the first- or last-inserted."""
    sess = _make_session()
    reg = sess.job_registry
    first = reg.register_job(kind="pflow", can_cancel=False)
    middle = reg.register_job(kind="eig", can_cancel=False)
    last = reg.register_job(kind="cpf", can_cancel=False)
    reg.mark_running(first)
    reg.mark_running(last)
    reg.mark_running(middle)
    reg.update_progress(middle, 0.5)  # 'middle' is now the most-recently-updated
    job = _current_inflight_job(sess)
    assert job is not None
    assert job.id == middle  # most-recently-updated, not insertion first/last


# --- RLock re-entrancy (bypass_session_gate relies on it) --------------------


def test_session_lock_is_reentrant() -> None:
    """Regression guard pinning the KTD-2b ``Lock`` -> ``RLock`` migration:
    the per-session lock must be re-entrant so a same-thread holder (the
    ``bypass_session_gate`` path) acquires without deadlocking. If ``_Session``
    ever reverts to a plain ``threading.Lock``, the second non-blocking
    acquire below returns ``False`` and this test fails."""
    sess = _make_session()
    assert sess.lock.acquire(blocking=False)
    try:
        assert sess.lock.acquire(blocking=False)  # same thread re-enters
        sess.lock.release()
    finally:
        sess.lock.release()


# --- invoke try-acquire ------------------------------------------------------
#
# Driven via ``asyncio.run`` rather than ``async def`` test functions so they
# run without pytest-asyncio (not installed in the lean PYTHONPATH=src env).


def test_invoke_happy_path_releases_lock() -> None:
    async def _run() -> None:
        mgr = SessionManager()
        sess = _make_session("s1", data=_ImmediateData({"value": 42}))
        mgr._sessions["s1"] = sess
        result = await mgr.invoke("s1", "noop")
        assert result == {"value": 42}
        # lock fully released after a clean invoke
        assert sess.lock.acquire(blocking=False)
        sess.lock.release()

    asyncio.run(_run())


def test_invoke_second_concurrent_call_raises_session_busy() -> None:
    async def _run() -> None:
        mgr = SessionManager()
        entered = threading.Event()
        release = threading.Event()
        sess = _make_session("s1", data=_BlockingData(entered, release))
        mgr._sessions["s1"] = sess

        task1 = asyncio.create_task(mgr.invoke("s1", "op1"))
        loop = asyncio.get_running_loop()
        # Wait until invoke #1 is inside _rpc holding the lock (recv reached).
        await loop.run_in_executor(None, entered.wait, 5.0)
        assert entered.is_set()

        try:
            with pytest.raises(SessionBusyError) as excinfo:
                await mgr.invoke("s1", "op2")
            # Registry is empty (routes don't register until Unit 5), so the
            # busy path resolves current_job to None without crashing.
            assert excinfo.value.current_job is None
        finally:
            release.set()

        result = await task1
        assert result == {"ok": True}
        # after #1 drains, the lock is free again
        assert sess.lock.acquire(blocking=False)
        sess.lock.release()

    asyncio.run(_run())


def test_invoke_busy_error_reports_inflight_job_from_registry() -> None:
    """Proves invoke wires the live session registry through
    ``_current_inflight_job``: with a running job pre-registered, the 409's
    ``current_job`` is that job (not None)."""

    async def _run() -> None:
        mgr = SessionManager()
        entered = threading.Event()
        release = threading.Event()
        sess = _make_session("s1", data=_BlockingData(entered, release))
        job_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
        sess.job_registry.mark_running(job_id)
        mgr._sessions["s1"] = sess

        task1 = asyncio.create_task(mgr.invoke("s1", "op1"))
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, entered.wait, 5.0)

        try:
            with pytest.raises(SessionBusyError) as excinfo:
                await mgr.invoke("s1", "op2")
            assert excinfo.value.current_job is not None
            assert excinfo.value.current_job.id == job_id
        finally:
            release.set()

        await task1

    asyncio.run(_run())


def test_invoke_bypass_session_gate_does_not_raise_on_free_lock() -> None:
    """Smoke: bypass on an uncontended session completes normally."""

    async def _run() -> None:
        mgr = SessionManager()
        sess = _make_session("s1", data=_ImmediateData({"ok": 1}))
        mgr._sessions["s1"] = sess
        result = await mgr.invoke("s1", "noop", bypass_session_gate=True)
        assert result == {"ok": 1}
        assert sess.lock.acquire(blocking=False)
        sess.lock.release()

    asyncio.run(_run())


def test_invoke_bypass_blocks_then_succeeds_instead_of_raising() -> None:
    """The distinct bypass contract vs the fail-fast gate: under cross-thread
    contention, bypass does NOT raise ``SessionBusyError`` — it queues on a
    blocking acquire and proceeds once the holder releases."""

    async def _run() -> None:
        mgr = SessionManager()
        entered = threading.Event()
        release = threading.Event()
        sess = _make_session("s1", data=_BlockingData(entered, release))
        mgr._sessions["s1"] = sess

        task1 = asyncio.create_task(mgr.invoke("s1", "op1"))
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, entered.wait, 5.0)

        # bypass must NOT fail-fast; it blocks on acquire rather than 409.
        task2 = asyncio.create_task(
            mgr.invoke("s1", "op2", bypass_session_gate=True)
        )
        await asyncio.sleep(0.05)
        assert not task2.done()  # blocked on the acquire, not raised

        release.set()  # op1 finishes -> releases lock -> op2's acquire proceeds
        result1 = await task1
        result2 = await task2
        assert result1 == {"ok": True}
        assert result2 == {"ok": True}

    asyncio.run(_run())
