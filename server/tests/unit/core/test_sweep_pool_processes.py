"""``SweepWorkerPool``'s process handling, with fake processes and fake pipes.

What is checked here is what a real sweep cannot easily show: that sub-workers are
spawned the way sessions' workers are (the BLAS caps in their environment, the
Windows Job Object, the parent's pipe ends closed), that each way of stopping them
escalates as far as it has to and closes every pipe, and that nothing spawned after
a cancel is left behind. ``tests/integration/test_sweep_parallel.py`` runs real
processes.
"""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import Callable
from typing import Any

import pytest

from tensa.core import sweep_pool
from tensa.core.sweep_pool import (
    PipeAbortEvent,
    SweepWorkerDiedError,
    SweepWorkerError,
    SweepWorkerPool,
    _ProcessWorker,
)
from tensa.core.worker import worker_main
from tensa.core.worker_spawn import THREAD_ENV_VARS, WORKER_THREADS_ENV

pytestmark = pytest.mark.unit


class FakeConn:
    """One end of a pipe. What it sends is recorded in ``sent`` and shows up in the
    other end's ``received``; what ``recv`` answers is queued in ``replies``. A
    queued callable is called for the answer, so a test can hold a reply back until
    something has happened, and ``on_send`` is told of every message sent."""

    def __init__(self) -> None:
        self.sent: list[Any] = []
        self.received: list[Any] = []
        self.peer: FakeConn | None = None
        self.replies: list[Any] = []
        self.closed = False
        self.send_error: Exception | None = None
        self.on_send: Callable[[Any], None] | None = None

    def send(self, message: Any) -> None:
        if self.send_error is not None:
            raise self.send_error
        self.sent.append(message)
        if self.peer is not None:
            self.peer.received.append(message)
        if self.on_send is not None:
            self.on_send(message)

    def recv(self) -> Any:
        if not self.replies:
            raise EOFError
        reply = self.replies.pop(0)
        if callable(reply):
            reply = reply()
        if isinstance(reply, BaseException):
            raise reply
        return reply

    def poll(self, timeout: float | None = None) -> bool:
        return False

    def close(self) -> None:
        self.closed = True


class FakeProcess:
    """A worker process the test controls: which step of stopping it takes to die."""

    instances: list[FakeProcess] = []
    start_error: Exception | None = None

    def __init__(self, *, target: Any, args: tuple[Any, ...], name: str, daemon: bool) -> None:
        self.target, self.args, self.name, self.daemon = target, args, name, daemon
        self.pid: int | None = None
        self.alive = False
        self.env_at_start: dict[str, str] = {}
        self.steps: list[str] = []
        self.dies_on = "shutdown"  # "shutdown" | "terminate" | "kill"
        self.exitcode: int | None = None
        number = len(FakeProcess.instances)
        self.number = number
        FakeProcess.instances.append(self)

    def start(self) -> None:
        if FakeProcess.start_error is not None and self.number >= 1:
            raise FakeProcess.start_error
        self.pid = 5000 + self.number
        self.alive = True
        self.env_at_start = dict(os.environ)

    def is_alive(self) -> bool:
        return self.alive

    def join(self, timeout: float | None = None) -> None:
        self.steps.append("join")
        # A graceful close sends the shutdown request first; a process that honours
        # it has exited by the time it is joined.
        ctrl = self.args[0]
        asked = any(isinstance(m, dict) and m.get("op") == "shutdown" for m in ctrl.received)
        if self.dies_on == "shutdown" and asked:
            self.alive = False

    def terminate(self) -> None:
        self.steps.append("terminate")
        if self.dies_on in {"shutdown", "terminate"}:
            self.alive = False

    def kill(self) -> None:
        self.steps.append("kill")
        self.alive = False


class FakeContext:
    """Stands in for the ``multiprocessing`` context the session manager spawns with."""

    def __init__(self) -> None:
        self.pipes: list[tuple[FakeConn, FakeConn]] = []

    def Pipe(self, duplex: bool = True) -> tuple[FakeConn, FakeConn]:  # noqa: N802
        first, second = FakeConn(), FakeConn()
        first.peer, second.peer = second, first
        self.pipes.append((first, second))
        return first, second

    def Process(self, **kwargs: Any) -> FakeProcess:  # noqa: N802
        return FakeProcess(**kwargs)


@pytest.fixture(autouse=True)
def fakes(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    FakeProcess.instances = []
    FakeProcess.start_error = None
    for name in (*THREAD_ENV_VARS, WORKER_THREADS_ENV):
        monkeypatch.delenv(name, raising=False)
    attached: list[int] = []
    monkeypatch.setattr(sweep_pool, "attach_kill_on_close_job", lambda pid: attached.append(pid))
    return attached


# How long a test waits for something another thread is due to do. Far longer than
# any step here takes, so reaching it means the step never happened.
_SIGNAL_TIMEOUT = 10.0


def _pool(ctx: FakeContext, size: int = 2) -> SweepWorkerPool:
    return SweepWorkerPool(
        ctx=ctx, size=size, workspace="/ws", owner_pid=1234, name="andes-sweep-ab12cd34"
    )


# ---- spawning ------------------------------------------------------------------


async def test_workers_are_spawned_like_a_sessions_with_their_own_abort_pipe(
    fakes: list[int],
) -> None:
    ctx = FakeContext()
    pool = _pool(ctx, size=3)

    await pool.start()

    assert [p.name for p in FakeProcess.instances] == [f"andes-sweep-ab12cd34-{i}" for i in range(3)]
    for process in FakeProcess.instances:
        assert process.target is worker_main
        assert process.daemon is False
        ctrl, data, abort, workspace, session_id, owner_pid = process.args
        assert isinstance(ctrl, FakeConn) and isinstance(data, FakeConn)
        # The abort is a pipe, not the session's ``multiprocessing.Event``.
        assert isinstance(abort, PipeAbortEvent)
        assert (workspace, session_id, owner_pid) == ("/ws", None, 1234)
    assert fakes == [5000, 5001, 5002]


async def test_the_blas_caps_are_in_the_environment_only_while_a_worker_starts() -> None:
    before = {name: os.environ.get(name) for name in THREAD_ENV_VARS}
    pool = _pool(FakeContext(), size=1)

    await pool.start()

    started = FakeProcess.instances[0].env_at_start
    assert {name: started.get(name) for name in THREAD_ENV_VARS} == dict.fromkeys(THREAD_ENV_VARS, "4")
    # The server's own environment is left as it was.
    assert {name: os.environ.get(name) for name in THREAD_ENV_VARS} == before
    await pool.close(graceful=False)


async def test_a_users_thread_cap_is_left_alone_for_a_sub_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(WORKER_THREADS_ENV, "2")
    pool = _pool(FakeContext(), size=1)

    await pool.start()

    started = FakeProcess.instances[0].env_at_start
    assert all(started[name] == "2" for name in THREAD_ENV_VARS)
    await pool.close(graceful=False)


async def test_the_parents_copies_of_the_workers_pipe_ends_are_closed_after_the_start() -> None:
    ctx = FakeContext()
    pool = _pool(ctx, size=1)

    await pool.start()

    # Pipes in creation order: ctrl, data, abort. For ctrl and data the first end is the
    # parent's; for the abort pipe (``duplex=False``) the first end is the child's.
    (parent_ctrl, child_ctrl), (parent_data, child_data), (child_abort, parent_abort) = ctx.pipes
    assert child_ctrl.closed and child_data.closed and child_abort.closed
    assert not (parent_ctrl.closed or parent_data.closed or parent_abort.closed)
    await pool.close(graceful=False)


async def test_a_worker_that_cannot_start_closes_its_pipes_and_leaves_the_pool_closable() -> None:
    ctx = FakeContext()
    pool = _pool(ctx, size=3)
    FakeProcess.start_error = OSError("cannot fork")

    with pytest.raises(OSError, match="cannot fork"):
        await pool.start()

    # The second worker failed before it ran: all of its pipe ends are closed.
    failed_pipes = ctx.pipes[3:6]
    assert all(conn.closed for pair in failed_pipes for conn in pair)
    # The first is running and is stopped by the close the caller makes.
    assert FakeProcess.instances[0].alive
    await pool.close(graceful=False)
    assert not FakeProcess.instances[0].alive
    assert len(FakeProcess.instances) == 2  # the third was never attempted


# ---- stopping --------------------------------------------------------------------


async def test_a_graceful_close_asks_each_worker_to_shut_down_and_closes_every_pipe() -> None:
    ctx = FakeContext()
    pool = _pool(ctx, size=2)
    await pool.start()

    await pool.close(graceful=True)

    for process in FakeProcess.instances:
        ctrl = process.args[0]
        assert ctrl.received == [{"op": "shutdown", "args": {}, "seq": -1}]
        assert "terminate" not in process.steps
        assert not process.alive
    assert all(conn.closed for pair in ctx.pipes for conn in pair)


async def test_a_graceful_close_escalates_for_a_worker_that_ignores_the_request() -> None:
    pool = _pool(FakeContext(), size=2)
    await pool.start()
    FakeProcess.instances[1].dies_on = "kill"

    await pool.close(graceful=True)

    assert "terminate" not in FakeProcess.instances[0].steps
    assert FakeProcess.instances[1].steps.count("terminate") == 1
    assert FakeProcess.instances[1].steps.count("kill") == 1
    assert not any(p.alive for p in FakeProcess.instances)


async def test_a_forced_close_terminates_without_asking() -> None:
    ctx = FakeContext()
    pool = _pool(ctx, size=2)
    await pool.start()
    FakeProcess.instances[1].dies_on = "kill"

    await pool.close(graceful=False)

    for process in FakeProcess.instances:
        assert process.args[0].received == []  # nobody was asked: a mid-iteration worker would not read it
        assert "terminate" in process.steps
    assert "kill" in FakeProcess.instances[1].steps
    assert "kill" not in FakeProcess.instances[0].steps
    assert all(conn.closed for pair in ctx.pipes for conn in pair)


async def test_closing_twice_is_harmless() -> None:
    pool = _pool(FakeContext(), size=1)
    await pool.start()

    await pool.close(graceful=False)
    steps = list(FakeProcess.instances[0].steps)
    await pool.close(graceful=True)

    assert FakeProcess.instances[0].steps == steps


async def test_a_worker_that_finishes_starting_after_the_close_is_stopped_at_once() -> None:
    """A cancel arrives while the spawn thread is still starting workers. The close
    has already taken its list, so the late worker must stop itself, and no more are
    started."""
    ctx = FakeContext()
    pool = _pool(ctx, size=3)
    await pool.close(graceful=False)  # the cancel got there first

    pool._spawn_one(0)  # noqa: SLF001 — the thread was mid-spawn when close ran
    pool._spawn_all()  # noqa: SLF001 — and would carry on with the rest

    assert [p.number for p in FakeProcess.instances] == [0]
    late = FakeProcess.instances[0]
    assert "terminate" in late.steps and not late.alive
    assert all(conn.closed for pair in ctx.pipes for conn in pair)
    assert pool._workers == []  # noqa: SLF001


async def test_closing_waits_for_a_worker_that_is_still_starting() -> None:
    """A cancel can land while the spawn thread is inside ``Process.start``. The
    close must not return before that worker has been started and stopped, or the
    sweep would be reported over while one of its workers is still coming up."""
    entered = threading.Event()
    release = threading.Event()

    class SlowStart(FakeProcess):
        def start(self) -> None:
            entered.set()
            assert release.wait(10), "the close never let the worker finish starting"
            super().start()

    ctx = FakeContext()
    ctx.Process = lambda **kwargs: SlowStart(**kwargs)  # type: ignore[method-assign]
    pool = _pool(ctx, size=3)
    loop = asyncio.get_running_loop()
    starting = asyncio.ensure_future(pool.start())
    assert await loop.run_in_executor(None, entered.wait, 10)

    closing = asyncio.ensure_future(pool.close(graceful=False))
    await asyncio.sleep(0.2)
    assert not closing.done(), "close returned while a worker was still starting"

    release.set()
    await closing
    await starting
    # The worker that was starting is stopped, and the other two never began.
    assert len(FakeProcess.instances) == 1
    assert not FakeProcess.instances[0].alive
    assert all(conn.closed for pair in ctx.pipes for conn in pair)


# ---- talking to a worker ----------------------------------------------------------


def _worker(
    process: FakeProcess | None = None,
) -> tuple[_ProcessWorker, FakeConn, FakeConn, FakeConn]:
    ctrl, data, abort = FakeConn(), FakeConn(), FakeConn()
    process = process or FakeProcess(target=None, args=(ctrl,), name="w", daemon=False)
    return _ProcessWorker(process, ctrl, data, abort), ctrl, data, abort  # type: ignore[arg-type]


def test_a_call_sends_the_request_and_returns_the_payload() -> None:
    worker, ctrl, data, _ = _worker()
    data.replies = [
        {"type": "result", "seq": 1, "payload": {"a": 1}},
        {"type": "result", "seq": 2, "payload": None},
    ]

    assert worker.call("run_sweep_iteration", {"index": 0}) == {"a": 1}
    assert worker.call("adopt_sweep_source", {"source": {}}) is None

    assert ctrl.sent == [
        {"op": "run_sweep_iteration", "args": {"index": 0}, "seq": 1},
        {"op": "adopt_sweep_source", "args": {"source": {}}, "seq": 2},
    ]


def test_a_call_that_meets_a_dead_pipe_says_how_the_worker_exited() -> None:
    process = FakeProcess(target=None, args=(FakeConn(),), name="w", daemon=False)
    process.exitcode = -9
    worker, _, data, _ = _worker(process)
    data.replies = [EOFError()]

    with pytest.raises(SweepWorkerDiedError, match=r"exit code -9\) while it ran run_sweep_iteration"):
        worker.call("run_sweep_iteration", {})


def test_a_call_whose_pipe_is_closed_on_send_is_a_death_too() -> None:
    worker, ctrl, _, _ = _worker()
    ctrl.send_error = BrokenPipeError()

    with pytest.raises(SweepWorkerDiedError):
        worker.call("adopt_sweep_source", {})


def test_an_error_answer_is_raised_with_its_category() -> None:
    worker, _, data, _ = _worker()
    data.replies = [{"type": "error", "seq": 1, "category": "internal-error", "detail": "boom"}]

    with pytest.raises(SweepWorkerError) as caught:
        worker.call("run_sweep_iteration", {})

    assert (caught.value.category, caught.value.detail) == ("internal-error", "boom")


def test_an_answer_that_is_not_a_dict_is_malformed() -> None:
    worker, _, data, _ = _worker()
    data.replies = ["garbage"]

    with pytest.raises(SweepWorkerError, match="malformed"):
        worker.call("run_sweep_iteration", {})


def test_aborting_a_worker_whose_pipe_is_gone_does_not_raise() -> None:
    worker, _, _, abort = _worker()
    worker.abort()
    assert abort.sent == [True]

    abort.send_error = BrokenPipeError()
    worker.abort()  # a dead worker has nothing left to stop


# ---- running ------------------------------------------------------------------------


async def test_an_abort_is_forwarded_to_every_worker_while_the_sweep_runs() -> None:
    """The abort comes while every worker is inside its first iteration. Nothing
    here is timed: the sweep is aborted by the last worker to be handed an
    iteration, and each worker holds its answer until its abort pipe has been
    written to, so the run cannot end before the pool has forwarded the abort."""
    pool = _pool(FakeContext(), size=2)
    await pool.start()
    process_workers = list(pool._workers)  # noqa: SLF001
    stop = threading.Event()
    in_iteration: list[int] = []

    def handed_out(message: Any) -> None:
        if message["op"] == "run_sweep_iteration":
            in_iteration.append(message["args"]["index"])
            if len(in_iteration) == len(process_workers):
                stop.set()

    def held_until(aborted: threading.Event) -> Callable[[], dict[str, Any]]:
        def answer() -> dict[str, Any]:
            assert aborted.wait(_SIGNAL_TIMEOUT), "the abort never reached this worker"
            return {"type": "result", "seq": 2, "payload": _row(0)}

        return answer

    for worker in process_workers:
        aborted = threading.Event()
        worker.ctrl.on_send = handed_out
        worker.abort_conn.on_send = lambda _message, aborted=aborted: aborted.set()
        worker.data.replies = [
            {"type": "result", "seq": 1, "payload": None},
            held_until(aborted),
        ]
    rows: list[int] = []

    async def on_row(index: int, _row_: dict[str, Any]) -> None:
        rows.append(index)

    tasks = [{"index": i, "value": float(i)} for i in range(8)]
    done = await pool.run(tasks, source={}, on_row=on_row, should_stop=stop.is_set)

    # Both iterations in flight were stopped and answered; no other was handed out.
    assert done == 2 and rows == [0, 1]
    assert sorted(in_iteration) == [0, 1]
    for worker in process_workers:
        assert worker.abort_conn.sent == [True]
        assert [message["op"] for message in worker.ctrl.sent] == [
            "adopt_sweep_source",
            "run_sweep_iteration",
        ]
    await pool.close(graceful=False)


async def test_an_abort_before_any_iteration_is_handed_out_runs_none() -> None:
    """The abort lands while the workers are still taking the case. No iteration is
    started, so there are no rows, and that is not a failure of the workers."""
    pool = _pool(FakeContext(), size=2)
    await pool.start()
    process_workers = list(pool._workers)  # noqa: SLF001
    stop = threading.Event()

    def adopted() -> dict[str, Any]:
        stop.set()
        return {"type": "result", "seq": 1, "payload": None}

    for worker in process_workers:
        worker.data.replies = [adopted]
    rows: list[int] = []

    async def on_row(index: int, _row_: dict[str, Any]) -> None:
        rows.append(index)

    tasks = [{"index": i, "value": float(i)} for i in range(8)]
    done = await pool.run(tasks, source={}, on_row=on_row, should_stop=stop.is_set)

    assert done == 0 and rows == []
    for worker in process_workers:
        assert [message["op"] for message in worker.ctrl.sent] == ["adopt_sweep_source"]
    await pool.close(graceful=False)


async def test_a_sweep_that_is_never_aborted_forwards_nothing() -> None:
    pool = _pool(FakeContext(), size=1)
    await pool.start()
    (worker,) = pool._workers  # noqa: SLF001
    worker.data.replies = [
        {"type": "result", "seq": 1, "payload": None},
        {"type": "result", "seq": 2, "payload": _row(0)},
    ]
    collected: list[int] = []

    async def on_row(index: int, _row_: dict[str, Any]) -> None:
        collected.append(index)

    done = await pool.run(
        [{"index": 0, "value": 1.0}], source={}, on_row=on_row, should_stop=lambda: False
    )

    assert done == 1 and collected == [0]
    assert worker.abort_conn.sent == []
    await pool.close(graceful=True)


def _row(index: int) -> dict[str, Any]:
    return {
        "iteration": index,
        "parameter_value": float(index),
        "converged": True,
        "final_t": 0.2,
        "callpert_count": 5,
        "error": None,
    }


async def test_the_pool_has_its_own_io_threads(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each worker's blocking pipe read gets a thread of the pool's own, so a sweep
    cannot starve the event loop's default executor, which every request uses."""
    seen: list[Any] = []
    real = asyncio.get_running_loop().run_in_executor

    pool = _pool(FakeContext(), size=1)
    await pool.start()
    (worker,) = pool._workers  # noqa: SLF001
    worker.data.replies = [
        {"type": "result", "seq": 1, "payload": None},
        {"type": "result", "seq": 2, "payload": _row(0)},
    ]

    loop = asyncio.get_running_loop()

    def _spy(executor: Any, func: Callable[..., Any], *args: Any) -> Any:
        seen.append(executor)
        return real(executor, func, *args)

    monkeypatch.setattr(loop, "run_in_executor", _spy)

    async def on_row(_index: int, _row_: dict[str, Any]) -> None:
        return None

    await pool.run([{"index": 0, "value": 1.0}], source={}, on_row=on_row, should_stop=lambda: False)

    assert seen and all(executor is pool._io for executor in seen)  # noqa: SLF001
    await pool.close(graceful=False)
