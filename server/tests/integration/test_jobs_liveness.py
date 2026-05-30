"""Unit 5a — job-liveness sweeper (KTD-18).

A ``running`` job whose worker process is no longer alive transitions to
``failed`` (category ``WorkerDied``) when the liveness sweep runs.

We drive a single deterministic sweep via ``SessionManager.sweep_dead_worker_jobs``
(the same per-tick body the 10s ``_liveness_loop`` calls) rather than waiting on
the timer, and additionally prove the timer path fires by shortening the tick.

Idle sessions and sessions whose worker is alive are left untouched — the sweep
only orphans running jobs on dead workers.
"""

from __future__ import annotations

import asyncio

import pytest

from andes_app.core.session import (
    WORKER_DIED_CATEGORY,
    SessionManager,
    _Session,
)


class _FakeProcess:
    def __init__(self, alive: bool) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive


def _session(session_id: str, *, alive: bool) -> _Session:
    return _Session(
        session_id=session_id,
        process=_FakeProcess(alive=alive),
        ctrl=None,
        data=None,
        abort_event=None,
    )


@pytest.mark.integration
def test_dead_worker_running_job_marked_failed() -> None:
    mgr = SessionManager()
    sess = _session("s1", alive=False)
    job_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    sess.job_registry.mark_running(job_id)
    mgr._sessions["s1"] = sess

    failed = mgr.sweep_dead_worker_jobs()
    assert failed == 1

    record = sess.job_registry.get_job(job_id)
    assert record is not None
    assert record.status == "failed"
    assert record.problem is not None
    assert record.problem["category"] == WORKER_DIED_CATEGORY
    assert record.problem["status"] == 500


@pytest.mark.integration
def test_alive_worker_running_job_is_untouched() -> None:
    mgr = SessionManager()
    sess = _session("s1", alive=True)
    job_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    sess.job_registry.mark_running(job_id)
    mgr._sessions["s1"] = sess

    failed = mgr.sweep_dead_worker_jobs()
    assert failed == 0
    assert sess.job_registry.get_job(job_id).status == "running"


@pytest.mark.integration
def test_idle_session_with_dead_worker_is_skipped() -> None:
    """A session whose worker is dead but holds NO running jobs is skipped
    (the sweep only iterates sessions with at least one running job)."""
    mgr = SessionManager()
    sess = _session("s1", alive=False)
    # A terminal (done) job, no running ones.
    done_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    sess.job_registry.mark_running(done_id)
    sess.job_registry.mark_done(done_id)
    mgr._sessions["s1"] = sess

    failed = mgr.sweep_dead_worker_jobs()
    assert failed == 0
    assert sess.job_registry.get_job(done_id).status == "done"


@pytest.mark.integration
def test_dead_worker_global_registry_running_job_marked_failed() -> None:
    """KTD-20: session-mutating jobs live in the manager-wide global registry,
    so the per-session pass never sees them. The sweeper must also orphan a
    ``running`` global record whose originating session's worker is dead —
    otherwise a snapshot-restore / bundle-import / case-reload that outlives a
    crashed worker stays stuck ``running`` forever."""
    mgr = SessionManager()
    sess = _session("s1", alive=False)
    mgr._sessions["s1"] = sess
    job_id = mgr.global_job_registry.register_job(
        kind="snapshot-restore", can_cancel=False, origin_session_id="s1"
    )
    mgr.global_job_registry.mark_running(job_id)

    failed = mgr.sweep_dead_worker_jobs()
    assert failed == 1

    record = mgr.global_job_registry.get_job(job_id)
    assert record is not None
    assert record.status == "failed"
    assert record.problem is not None
    assert record.problem["category"] == WORKER_DIED_CATEGORY


@pytest.mark.integration
def test_global_registry_job_with_live_worker_is_untouched() -> None:
    """A global-registry ``running`` job whose originating session's worker is
    alive is legitimately in flight and must NOT be orphaned."""
    mgr = SessionManager()
    sess = _session("s1", alive=True)
    mgr._sessions["s1"] = sess
    job_id = mgr.global_job_registry.register_job(
        kind="bundle-import", can_cancel=False, origin_session_id="s1"
    )
    mgr.global_job_registry.mark_running(job_id)

    failed = mgr.sweep_dead_worker_jobs()
    assert failed == 0
    rec = mgr.global_job_registry.get_job(job_id)
    assert rec is not None and rec.status == "running"


@pytest.mark.integration
def test_liveness_loop_fires_within_short_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    """The 10s ``_liveness_loop`` body runs on its tick — shorten the tick to
    keep the test fast and assert the running job is failed within the
    interval."""

    async def _run() -> None:
        import andes_app.core.session as session_mod

        monkeypatch.setattr(session_mod, "JOB_LIVENESS_TICK", 0.05)
        mgr = SessionManager()
        sess = _session("s1", alive=False)
        job_id = sess.job_registry.register_job(kind="eig", can_cancel=False)
        sess.job_registry.mark_running(job_id)
        mgr._sessions["s1"] = sess

        await mgr.start()
        try:
            deadline = asyncio.get_event_loop().time() + 5.0
            while True:
                record = sess.job_registry.get_job(job_id)
                assert record is not None
                if record.status == "failed":
                    break
                if asyncio.get_event_loop().time() > deadline:
                    pytest.fail(f"job never failed; status={record.status}")
                await asyncio.sleep(0.05)
            assert record.problem is not None
            assert record.problem["category"] == WORKER_DIED_CATEGORY
        finally:
            # Drop the synthesized session (its pipes are ``None``) so
            # ``shutdown`` doesn't try to drive the real close path on it; we
            # only need shutdown to cancel the background tasks here.
            mgr._sessions.clear()
            await mgr.shutdown()

    asyncio.run(_run())
