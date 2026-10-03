"""How the session manager decides to run a sweep in parallel, and what it does then.

``SessionManager._drive_sweep`` runs a sweep on the session's own worker unless it
is long enough to share, the setting allows more than one worker, and the session's
worker accepts the sweep's plan. These tests replace the worker pipes and the pool
of sub-workers with fakes, so they pin the decisions and the bookkeeping around the
pool (progress, the truncated flag, the abort event, teardown on every exit) without
a process. ``tests/integration/test_sweep_parallel.py`` runs it all for real.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from tensa.core import session as session_module
from tensa.core.session import (
    WORKER_DIED_CATEGORY,
    SessionExpiredError,
    SessionManager,
    WorkerDiedError,
    _Session,
    _SweepBuffer,
)
from tensa.core.sweep_pool import SweepWorkersLostError

pytestmark = pytest.mark.unit

FAULT_TC = "disturbance.fault.tc"
PLAN: dict[str, Any] = {
    "source": {"case_path": "case.raw", "addfiles": None, "replay": []},
    "specs": [{"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1}],
}


class _Pipe:
    """One end of a worker pipe: records what is sent, answers what is queued."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.replies: list[Any] = []
        self.send_error: Exception | None = None
        self.closed = False

    def send(self, message: dict[str, Any]) -> None:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append(message)

    def recv(self) -> Any:
        return self.replies.pop(0)

    def close(self) -> None:
        self.closed = True


def _manager(sweep_workers: int | None = 4) -> tuple[SessionManager, _Session]:
    mgr = SessionManager(workspace="/ws", sweep_workers=sweep_workers)
    sess = _Session(
        session_id="s1",
        process=None,
        ctrl=_Pipe(),
        data=_Pipe(),
        abort_event=mgr._spawn_ctx.Event(),
    )
    mgr._sessions["s1"] = sess
    return mgr, sess


def _sweep_args(total: int) -> dict[str, Any]:
    return {
        "snapshot_name": "base",
        "parameter_kind": FAULT_TC,
        "parameter_target": 0,
        "values": [1.0 + i / 10 for i in range(total)],
        "tf": 0.2,
        "h": 0.01,
    }


def _buffer(mgr: SessionManager, sess: _Session, total: int) -> _SweepBuffer:
    sweep_id = mgr.register_sweep_job("s1", sweep_id="sw1", kind="sweep")
    sess.job_registry.mark_running(sweep_id)
    sess.sweep_in_progress = sweep_id
    return _SweepBuffer(sweep_id=sweep_id, session_id="s1", total=total)


def _row(index: int) -> dict[str, Any]:
    return {
        "iteration": index,
        "parameter_value": 1.0 + index / 10,
        "converged": True,
        "final_t": 0.2,
        "callpert_count": 5,
        "error": None,
    }


# ---- the decision ------------------------------------------------------------


class _Calls:
    """Which of the three ways to run a sweep ``_drive_sweep`` picked."""

    def __init__(self, mgr: SessionManager, *, plan: Any = PLAN, parallel: Any = "ok") -> None:
        self.names: list[str] = []
        self.parallel_workers: list[int] = []
        calls = self

        async def _plan(sess: _Session, sweep_args: dict[str, Any]) -> Any:
            calls.names.append("plan")
            return plan

        async def _parallel(
            sess: _Session,
            sweep_buf: _SweepBuffer,
            sweep_args: dict[str, Any],
            plan: dict[str, Any],
            workers: int,
            on_progress: Callable[[dict[str, Any]], Awaitable[None]],
        ) -> Any:
            calls.names.append("parallel")
            calls.parallel_workers.append(workers)
            if isinstance(parallel, BaseException):
                raise parallel
            if parallel == "ok":
                return {"truncated": False, "total_requested": sweep_buf.total}
            return parallel

        async def _serial(
            sess: _Session,
            sweep_buf: _SweepBuffer,
            sweep_args: dict[str, Any],
            on_progress: Callable[[dict[str, Any]], Awaitable[None]],
        ) -> None:
            calls.names.append("serial")
            await mgr._finish_sweep(sess, sweep_buf, "completed", result={})

        mgr._plan_parallel_sweep = _plan  # type: ignore[method-assign]
        mgr._run_sweep_in_parallel = _parallel  # type: ignore[method-assign]
        mgr._run_sweep_on_session_worker = _serial  # type: ignore[method-assign]


@pytest.mark.parametrize(
    ("setting", "total", "expected_workers"),
    [(4, 8, 4), (4, 5, 2), (4, 4, 2), (2, 40, 2), (8, 16, 8)],
)
async def test_a_sweep_long_enough_to_share_runs_on_sub_workers(
    setting: int, total: int, expected_workers: int
) -> None:
    mgr, sess = _manager(setting)
    calls = _Calls(mgr)
    buf = _buffer(mgr, sess, total)

    await mgr._drive_sweep(sess, buf, _sweep_args(total))

    assert calls.names == ["plan", "parallel"]
    assert calls.parallel_workers == [expected_workers]
    assert buf.state == "completed"
    assert sess.sweep_in_progress is None


@pytest.mark.parametrize(("setting", "total"), [(4, 2), (4, 3), (1, 8), (1, 200)])
async def test_a_short_sweep_or_a_setting_of_one_runs_on_the_session_worker(
    setting: int, total: int
) -> None:
    mgr, sess = _manager(setting)
    calls = _Calls(mgr)
    buf = _buffer(mgr, sess, total)

    await mgr._drive_sweep(sess, buf, _sweep_args(total))

    # No plan either: the session's worker is not asked anything extra.
    assert calls.names == ["serial"]
    assert buf.state == "completed"


async def test_a_refused_plan_runs_the_sweep_on_the_session_worker() -> None:
    mgr, sess = _manager(4)
    calls = _Calls(mgr, plan=None)
    buf = _buffer(mgr, sess, 8)

    await mgr._drive_sweep(sess, buf, _sweep_args(8))

    assert calls.names == ["plan", "serial"]


async def test_sub_workers_that_cannot_start_fall_back_to_the_session_worker() -> None:
    mgr, sess = _manager(4)
    calls = _Calls(mgr, parallel=None)
    buf = _buffer(mgr, sess, 8)

    await mgr._drive_sweep(sess, buf, _sweep_args(8))

    assert calls.names == ["plan", "parallel", "serial"]
    assert buf.state == "completed"


async def test_the_parallel_result_decides_the_truncated_flag() -> None:
    mgr, sess = _manager(4)
    _Calls(mgr, parallel={"truncated": True, "total_requested": 8})
    buf = _buffer(mgr, sess, 8)

    await mgr._drive_sweep(sess, buf, _sweep_args(8))

    assert buf.state == "completed"
    assert buf.truncated is True


async def test_losing_every_sub_worker_fails_the_sweep_as_a_worker_death() -> None:
    mgr, sess = _manager(4)
    _Calls(mgr, parallel=SweepWorkersLostError("every sweep worker exited"))
    buf = _buffer(mgr, sess, 8)

    await mgr._drive_sweep(sess, buf, _sweep_args(8))

    assert buf.state == "error"
    assert buf.error == (WORKER_DIED_CATEGORY, "every sweep worker exited")
    assert sess.sweep_in_progress is None
    record = sess.job_registry.get_job(buf.sweep_id)
    assert record is not None and record.status == "failed"


async def test_cancelling_a_parallel_sweep_finishes_it_aborted_and_propagates() -> None:
    mgr, sess = _manager(4)
    _Calls(mgr, parallel=asyncio.CancelledError())
    buf = _buffer(mgr, sess, 8)

    with pytest.raises(asyncio.CancelledError):
        await mgr._drive_sweep(sess, buf, _sweep_args(8))

    assert buf.state == "aborted"
    assert sess.sweep_in_progress is None


def test_the_setting_defaults_to_the_cpu_bound_and_refuses_less_than_one() -> None:
    from tensa.core.sweep import default_sweep_workers

    assert SessionManager()._sweep_workers == default_sweep_workers()
    assert SessionManager(sweep_workers=3)._sweep_workers == 3
    with pytest.raises(ValueError, match="at least 1"):
        SessionManager(sweep_workers=0)


# ---- the plan request --------------------------------------------------------


async def test_the_plan_is_asked_of_the_session_worker_with_the_sweeps_target() -> None:
    mgr, sess = _manager()
    sess.data.replies.append({"type": "result", "seq": 1, "payload": PLAN})

    plan = await mgr._plan_parallel_sweep(sess, _sweep_args(8))

    assert plan == PLAN
    assert sess.ctrl.sent == [
        {
            "op": "sweep_plan",
            "args": {
                "snapshot_name": "base",
                "parameter_kind": FAULT_TC,
                "parameter_target": 0,
            },
            "seq": 1,
        }
    ]


@pytest.mark.parametrize(
    "reply",
    [
        {"type": "error", "seq": 1, "category": "SnapshotNotFoundError", "detail": "no such"},
        {"type": "result", "seq": 1, "payload": None},
        "garbage",
    ],
)
async def test_a_plan_the_worker_refuses_is_none(reply: Any) -> None:
    mgr, sess = _manager()
    sess.data.replies.append(reply)

    assert await mgr._plan_parallel_sweep(sess, _sweep_args(8)) is None
    assert sess.closed is False


async def test_a_worker_that_dies_during_the_plan_request_kills_the_session() -> None:
    mgr, sess = _manager()
    sess.ctrl.send_error = BrokenPipeError()

    with pytest.raises(WorkerDiedError):
        await mgr._plan_parallel_sweep(sess, _sweep_args(8))

    assert sess.closed is True
    assert "s1" not in mgr._sessions


# ---- running on the pool -----------------------------------------------------


class FakePool:
    """Stands in for ``SweepWorkerPool``: records how it was used, reports scripted rows."""

    instances: list[FakePool] = []
    fail_start: Exception | None = None
    rows_reported = 8
    run_error: BaseException | None = None
    during_run: Callable[[FakePool], None] | None = None

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.tasks: list[dict[str, Any]] = []
        self.source: dict[str, Any] | None = None
        self.should_stop: Callable[[], bool] | None = None
        self.closed: list[bool] = []
        self.started = False
        FakePool.instances.append(self)

    async def start(self) -> None:
        if FakePool.fail_start is not None:
            raise FakePool.fail_start
        self.started = True

    async def run(
        self,
        tasks: list[dict[str, Any]],
        *,
        source: dict[str, Any],
        on_row: Callable[[int, dict[str, Any]], Awaitable[None]],
        should_stop: Callable[[], bool],
    ) -> int:
        self.tasks, self.source, self.should_stop = tasks, source, should_stop
        for index in range(FakePool.rows_reported):
            await on_row(index, _row(index))
        if FakePool.during_run is not None:
            FakePool.during_run(self)
        if FakePool.run_error is not None:
            raise FakePool.run_error
        return FakePool.rows_reported

    async def close(self, *, graceful: bool) -> None:
        self.closed.append(graceful)


@pytest.fixture(autouse=True)
def fake_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    FakePool.instances = []
    FakePool.fail_start = None
    FakePool.rows_reported = 8
    FakePool.run_error = None
    FakePool.during_run = None
    monkeypatch.setattr(session_module, "SweepWorkerPool", FakePool)


async def _run_parallel(
    mgr: SessionManager,
    sess: _Session,
    total: int = 8,
    workers: int = 4,
    progress: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    buf = _buffer(mgr, sess, total)

    async def _on_progress(envelope: dict[str, Any]) -> None:
        if progress is not None:
            progress.append(envelope)

    return await mgr._run_sweep_in_parallel(
        sess, buf, _sweep_args(total), PLAN, workers, _on_progress
    )


async def test_the_pool_is_sized_named_and_given_one_task_per_value() -> None:
    mgr, sess = _manager()

    result = await _run_parallel(mgr, sess, total=8, workers=3)

    pool = FakePool.instances[0]
    assert pool.kwargs["size"] == 3
    assert pool.kwargs["workspace"] == "/ws"
    assert pool.kwargs["name"] == "andes-sweep-sw1"
    assert pool.source == PLAN["source"]
    assert [t["index"] for t in pool.tasks] == list(range(8))
    assert [t["value"] for t in pool.tasks] == [1.0 + i / 10 for i in range(8)]
    for task in pool.tasks:
        assert task["specs"] == PLAN["specs"]
        assert task["parameter_kind"] == FAULT_TC
        assert task["parameter_target"] == 0
        assert task["tf"] == 0.2
        assert task["h"] == 0.01
    assert result == {"truncated": False, "total_requested": 8, "workers": 3}


async def test_every_row_becomes_a_progress_envelope_and_refreshes_the_session() -> None:
    mgr, sess = _manager()
    sess.last_active = 0.0
    progress: list[dict[str, Any]] = []

    await _run_parallel(mgr, sess, progress=progress)

    assert [p["iteration"] for p in progress] == list(range(8))
    assert progress[3] == {"iteration": 3, "value": 1.3, "result": _row(3)}
    assert sess.last_active > 0.0


async def test_a_pool_that_ends_early_makes_the_sweep_truncated() -> None:
    mgr, sess = _manager()
    FakePool.rows_reported = 5

    result = await _run_parallel(mgr, sess)

    assert result is not None and result["truncated"] is True


async def test_an_abort_makes_the_sweep_truncated_and_is_cleared_afterwards() -> None:
    mgr, sess = _manager()
    sess.abort_event.set()

    result = await _run_parallel(mgr, sess)

    assert result is not None and result["truncated"] is True
    # The session's worker would clear it at the end of a sweep it ran itself.
    assert not sess.abort_event.is_set()


async def test_the_pool_stops_when_the_session_is_aborted_or_closed() -> None:
    mgr, sess = _manager()
    seen: list[bool] = []

    def _probe(pool: FakePool) -> None:
        assert pool.should_stop is not None
        seen.append(pool.should_stop())
        sess.abort_event.set()
        seen.append(pool.should_stop())
        sess.abort_event.clear()
        sess.closed = True
        seen.append(pool.should_stop())

    FakePool.during_run = _probe

    with pytest.raises(SessionExpiredError):
        await _run_parallel(mgr, sess)

    assert seen == [False, True, True]


async def test_a_session_closed_during_the_sweep_ends_it_as_expired() -> None:
    mgr, sess = _manager()

    def _close(_pool: FakePool) -> None:
        sess.closed = True

    FakePool.during_run = _close

    with pytest.raises(SessionExpiredError):
        await _run_parallel(mgr, sess)

    assert FakePool.instances[0].closed == [True]


async def test_the_pool_is_closed_gracefully_after_a_normal_run() -> None:
    mgr, sess = _manager()

    await _run_parallel(mgr, sess)

    assert FakePool.instances[0].closed == [True]


@pytest.mark.parametrize(
    "error",
    [SweepWorkersLostError("none left"), RuntimeError("buffer"), asyncio.CancelledError()],
    ids=["workers-lost", "other-error", "cancelled"],
)
async def test_the_pool_is_terminated_when_the_run_fails_or_is_cancelled(
    error: BaseException,
) -> None:
    mgr, sess = _manager()
    FakePool.run_error = error
    sess.abort_event.set()

    with pytest.raises(type(error)):
        await _run_parallel(mgr, sess)

    # Its workers are mid-iteration, so there is no asking them to shut down.
    assert FakePool.instances[0].closed == [False]
    assert not sess.abort_event.is_set()


async def test_sub_workers_that_cannot_start_leave_the_abort_alone_and_return_none() -> None:
    mgr, sess = _manager()
    FakePool.fail_start = OSError("too many open files")
    sess.abort_event.set()

    result = await _run_parallel(mgr, sess)

    assert result is None
    assert FakePool.instances[0].closed == [False]
    # Not consumed: the sweep now runs on the session's worker, which honours it.
    assert sess.abort_event.is_set()
