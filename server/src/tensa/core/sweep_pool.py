"""Sub-workers that run the iterations of one sensitivity sweep in parallel.

A sweep is a list of independent simulations: each iteration reloads the case,
adds the snapshot's disturbances with one value swept, and runs TDS. Run on the
session's worker they go one after another. ``SweepWorkerPool`` spawns up to N
more workers (the same ``worker_main`` a session uses, started through the same
``worker_spawn_env`` and Windows Job Object path, so the BLAS thread caps and the
kill-with-the-server guarantee apply to them) and spreads the iterations over them.

How an iteration travels
------------------------
The server asks the session's worker for the sweep's plan (``sweep_plan``: the
snapshot's disturbance log, checked, and the case to reload). Each sub-worker is
told the case once (``adopt_sweep_source``), then is handed one iteration at a
time (``run_sweep_iteration``) by whichever loop below finds it idle, so a slow
iteration does not hold up the others. A sub-worker keeps no sweep state of its
own: everything an iteration needs is in the request.

Order, progress and cancel
--------------------------
Iterations finish in any order, but ``on_row`` is called in index order, each
row only after every lower one, so the sweep buffer, the WebSocket events and the
progress fraction read as they do for a sequential sweep (a client that resumes
from ``last_iteration`` relies on that). A sweep that is aborted stops handing
out iterations. The pool forwards the abort to every sub-worker over a pipe of its
own (:class:`PipeAbortEvent`), so a worker that has already been given an iteration
stops it mid-run, and one that had not yet started it answers ``skipped``. The rows
are then the run of iterations that were actually started, up to the first one that
was not.

Why the abort is a pipe and not the session's ``multiprocessing.Event``
-----------------------------------------------------------------------
A worker's abort bridge sits in ``Event.wait``, and ``Event.set`` does not return
until every process waiting on the event has woken. A process that is killed while
waiting never does, and a sub-worker is killed routinely (a cancelled sweep stops
its workers at once). An event shared with the session would be left with a dead
waiter, and the next abort of the session, or closing it, would block forever. A
pipe holds no such state: writing to a dead worker's pipe just fails.

A sub-worker that dies loses only the iteration it was running, which is recorded
as a failed iteration like one that diverged. The sweep carries on with the
others, and fails only when none is left.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import multiprocessing.connection
import threading
import time
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from concurrent.futures import Executor, ThreadPoolExecutor
from typing import Any, Protocol

from tensa.core.errors import AndesAppError
from tensa.core.worker import worker_main
from tensa.core.worker_spawn import attach_kill_on_close_job, worker_spawn_env

log = logging.getLogger("tensa.sweep_pool")

# How long a worker gets to exit after it is asked to, and again after SIGTERM,
# before the next, harder step.
_EXIT_GRACE_SECONDS = 2.0

# How often a running sweep looks for an abort to forward to its workers.
_ABORT_POLL_SECONDS = 0.05


class SweepWorkerDiedError(AndesAppError):
    """A sub-worker's pipe tore while it was asked to do something."""


class SweepWorkerError(AndesAppError):
    """A sub-worker answered a request with an error instead of a result."""

    def __init__(self, category: str, detail: str) -> None:
        super().__init__(f"{category}: {detail}")
        self.category = category
        self.detail = detail


class SweepWorkersLostError(AndesAppError):
    """Every sub-worker is gone and the sweep still has iterations to run."""


class SweepWorker(Protocol):
    """What the dispatcher needs of a sub-worker (tests supply their own)."""

    def call(self, op: str, args: dict[str, Any]) -> Any:
        """Send one request and block for its payload.

        Raises :class:`SweepWorkerDiedError` if the worker is gone and
        :class:`SweepWorkerError` if it answered with an error.
        """
        ...


class PipeAbortEvent:
    """A sub-worker's abort flag: the read end of a pipe, shaped like an ``Event``.

    It has the two methods the worker's abort bridge uses (``is_set`` and
    ``wait``). The flag is set when the other end sends anything, and also when it
    is closed, because a parent that closed its end is tearing the worker down.
    Once set it stays set.

    Two threads can ask at once (an iteration's bridge may still be in its last
    ``wait`` when the next iteration starts), and two readers on one pipe could
    both wait for the same message. ``wait`` takes a lock to read; ``is_set`` only
    reads when the lock is free and otherwise answers from what is known, which the
    waiting thread will update within its timeout.
    """

    def __init__(self, conn: multiprocessing.connection.Connection) -> None:
        self._conn = conn
        self._is_set = False
        self._lock = threading.Lock()

    def __reduce__(self) -> tuple[Any, ...]:
        # A ``Lock`` cannot be pickled; the pipe end can, while a worker is spawned.
        return (PipeAbortEvent, (self._conn,))

    def _read(self, timeout: float | None) -> None:
        try:
            if self._conn.poll(timeout):
                self._conn.recv()
                self._is_set = True
        except (EOFError, OSError):
            self._is_set = True

    def is_set(self) -> bool:
        if not self._is_set and self._lock.acquire(blocking=False):
            try:
                self._read(0)
            finally:
                self._lock.release()
        return self._is_set

    def wait(self, timeout: float | None = None) -> bool:
        if not self._is_set:
            with self._lock:
                self._read(timeout)
        return self._is_set


def _failed_row(task: dict[str, Any], exc: Exception) -> dict[str, Any]:
    """The result of an iteration that could not run, shaped like any other."""
    return {
        "iteration": int(task["index"]),
        "parameter_value": float(task["value"]),
        "converged": False,
        "final_t": 0.0,
        "callpert_count": 0,
        "error": f"{type(exc).__name__}: {exc}",
    }


async def run_iterations(
    workers: Sequence[SweepWorker],
    tasks: Sequence[dict[str, Any]],
    *,
    source: dict[str, Any],
    on_row: Callable[[int, dict[str, Any]], Awaitable[None]],
    should_stop: Callable[[], bool],
    executor: Executor | None = None,
) -> int:
    """Run ``tasks`` on ``workers``, one in flight per worker, and report rows in order.

    ``tasks[i]`` is the ``run_sweep_iteration`` request for iteration ``i``
    (``index`` and ``value`` among its keys). Each worker first adopts ``source``,
    then takes the next unstarted iteration whenever it is idle. ``on_row(i, row)``
    is awaited once per reported iteration, in increasing ``i``, and never
    concurrently with itself. ``should_stop`` is asked before an iteration is
    handed out. The blocking worker calls run on ``executor``.

    Returns how many rows were reported. That is ``len(tasks)`` unless
    ``should_stop`` ended the run early. Raises :class:`SweepWorkersLostError` when
    every worker died with iterations left and nothing asked to stop.
    """
    loop = asyncio.get_running_loop()
    pending: deque[int] = deque(range(len(tasks)))
    # index -> its row, or None for an iteration that answered ``skipped``
    finished: dict[int, dict[str, Any] | None] = {}
    cursor = 0
    gap = False  # a skipped iteration ends the run of rows that can be reported
    release_lock = asyncio.Lock()

    async def release() -> None:
        nonlocal cursor, gap
        async with release_lock:
            while not gap and cursor in finished:
                row = finished.pop(cursor)
                if row is None:
                    gap = True
                    break
                await on_row(cursor, row)
                cursor += 1

    async def drive(worker: SweepWorker) -> None:
        try:
            await loop.run_in_executor(
                executor, worker.call, "adopt_sweep_source", {"source": source}
            )
        except (SweepWorkerDiedError, SweepWorkerError) as exc:
            log.warning("a sweep worker could not take the case and is not used: %s", exc)
            return
        while pending and not should_stop():
            idx = pending.popleft()
            try:
                payload = await loop.run_in_executor(
                    executor, worker.call, "run_sweep_iteration", tasks[idx]
                )
            except SweepWorkerDiedError as exc:
                log.warning("sweep iteration %d lost its worker: %s", idx, exc)
                finished[idx] = _failed_row(tasks[idx], exc)
                await release()
                return  # this worker is gone; the others take what is left
            except SweepWorkerError as exc:
                finished[idx] = _failed_row(tasks[idx], exc)
                await release()
                continue
            if not isinstance(payload, dict):
                bad = SweepWorkerError("malformed", f"non-dict result: {payload!r}")
                finished[idx] = _failed_row(tasks[idx], bad)
            else:
                finished[idx] = None if payload.get("skipped") is True else payload
            await release()

    drivers = [asyncio.ensure_future(drive(worker)) for worker in workers]
    try:
        await asyncio.gather(*drivers)
    except BaseException:
        # One loop failing (a raising ``on_row``) or this task being cancelled:
        # stop the rest rather than leave them dispatching with nobody waiting.
        for driver in drivers:
            driver.cancel()
        await asyncio.gather(*drivers, return_exceptions=True)
        raise

    if pending and not should_stop():
        raise SweepWorkersLostError(
            f"every sweep worker exited with {len(pending)} of {len(tasks)} "
            "iterations still to run"
        )
    return cursor


class _ProcessWorker:
    """One sub-worker process and the two pipes that talk to it."""

    def __init__(
        self,
        process: Any,
        ctrl: multiprocessing.connection.Connection,
        data: multiprocessing.connection.Connection,
        abort: multiprocessing.connection.Connection,
    ) -> None:
        self.process = process
        self.ctrl = ctrl
        self.data = data
        self.abort_conn = abort
        self._seq = 0

    def abort(self) -> None:
        """Tell the worker to stop the iteration it is running (a no-op if it is gone)."""
        with contextlib.suppress(EOFError, BrokenPipeError, OSError):
            self.abort_conn.send(True)

    def call(self, op: str, args: dict[str, Any]) -> Any:
        self._seq += 1
        try:
            self.ctrl.send({"op": op, "args": args, "seq": self._seq})
            message = self.data.recv()
        except (EOFError, BrokenPipeError, ConnectionResetError, OSError) as exc:
            # The pipe tears when the process exits; its exit code, once reaped,
            # says whether it was killed (a negative signal number) or crashed.
            self.process.join(timeout=1.0)
            raise SweepWorkerDiedError(
                f"the sweep worker exited (exit code {self.process.exitcode}) "
                f"while it ran {op}"
            ) from exc
        if not isinstance(message, dict):
            raise SweepWorkerError("malformed", f"non-dict response: {message!r}")
        if message.get("type") == "error":
            raise SweepWorkerError(
                str(message.get("category", "unknown")), str(message.get("detail", ""))
            )
        return message.get("payload")


class SweepWorkerPool:
    """The sub-workers of one parallel sweep: spawn them, run on them, stop them.

    ``ctx`` is the ``multiprocessing`` context the session manager spawns workers
    with. ``name`` prefixes the worker processes' names.
    """

    def __init__(
        self,
        *,
        ctx: Any,
        size: int,
        workspace: str | None,
        owner_pid: int,
        name: str,
    ) -> None:
        self._ctx = ctx
        self._size = size
        self._workspace = workspace
        self._owner_pid = owner_pid
        self._name = name
        self._lock = threading.Lock()
        self._workers: list[_ProcessWorker] = []
        self._closed = False
        # Clear while the spawn thread is running, so that ``close`` can wait for it.
        self._spawned = threading.Event()
        self._spawned.set()
        # Each worker has one call in flight, blocked in a pipe read. A pool of
        # their own keeps those threads out of the event loop's default executor,
        # which every other request's pipe I/O shares.
        self._io = ThreadPoolExecutor(max_workers=size, thread_name_prefix="tensa-sweep-io")

    async def start(self) -> None:
        """Spawn the workers. Raises if one cannot be started; the caller closes the pool."""
        self._spawned.clear()
        await asyncio.get_running_loop().run_in_executor(None, self._spawn_all)

    def _spawn_all(self) -> None:
        try:
            for number in range(self._size):
                if self._closed:  # the sweep was cancelled while workers were starting
                    return
                self._spawn_one(number)
        finally:
            self._spawned.set()

    def _spawn_one(self, number: int) -> None:
        conns: list[multiprocessing.connection.Connection] = []
        try:
            parent_ctrl, child_ctrl = self._ctx.Pipe(duplex=True)
            conns += [parent_ctrl, child_ctrl]
            parent_data, child_data = self._ctx.Pipe(duplex=True)
            conns += [parent_data, child_data]
            child_abort, parent_abort = self._ctx.Pipe(duplex=False)
            conns += [child_abort, parent_abort]
            process = self._ctx.Process(
                target=worker_main,
                args=(
                    child_ctrl,
                    child_data,
                    PipeAbortEvent(child_abort),
                    self._workspace,
                    None,  # no session id: a sub-worker never uses the clone scratch dir
                    self._owner_pid,
                ),
                name=f"{self._name}-{number}",
                daemon=False,
            )
            # The thread caps must be in the environment before the child loads numpy.
            with worker_spawn_env():
                process.start()
        except BaseException:
            _close_all(conns)
            raise
        # Windows only: tie the worker's life to the server's. No-op elsewhere.
        if process.pid is not None:
            attach_kill_on_close_job(process.pid)
        # The parent only writes to ``parent_ctrl`` and ``parent_abort`` and reads
        # from ``parent_data``.
        child_ctrl.close()
        child_data.close()
        child_abort.close()
        worker = _ProcessWorker(process, parent_ctrl, parent_data, parent_abort)
        with self._lock:
            if not self._closed:
                self._workers.append(worker)
                return
        # ``close`` ran while this worker was starting (the sweep was cancelled).
        _terminate([worker], graceful=False)
        _close_all([worker.ctrl, worker.data, worker.abort_conn])

    async def run(
        self,
        tasks: Sequence[dict[str, Any]],
        *,
        source: dict[str, Any],
        on_row: Callable[[int, dict[str, Any]], Awaitable[None]],
        should_stop: Callable[[], bool],
    ) -> int:
        """Run ``tasks`` on the workers; see :func:`run_iterations`.

        While it runs, ``should_stop`` is also watched, and the first time it is
        true every worker is told to stop the iteration it is on.
        """
        with self._lock:
            workers = list(self._workers)

        async def forward_abort() -> None:
            while not should_stop():
                await asyncio.sleep(_ABORT_POLL_SECONDS)
            for worker in workers:
                worker.abort()

        watcher = asyncio.ensure_future(forward_abort())
        try:
            return await run_iterations(
                workers,
                tasks,
                source=source,
                on_row=on_row,
                should_stop=should_stop,
                executor=self._io,
            )
        finally:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    async def close(self, *, graceful: bool) -> None:
        """Stop every worker and release the pipes. Safe to call twice.

        ``graceful`` asks idle workers to shut down and gives them a moment to
        exit (the end of a sweep). Otherwise they are terminated at once, which
        is what a cancelled or failed sweep needs: its workers are mid-iteration
        and would not read a shutdown request for a long time.
        """
        with self._lock:
            self._closed = True
        await asyncio.get_running_loop().run_in_executor(None, self._shutdown, graceful)

    def _shutdown(self, graceful: bool) -> None:
        # A cancel can arrive while the spawn thread is inside ``Process.start``. It
        # finishes that worker (and stops it, seeing the pool closed) and starts no
        # more; wait for it, so that no worker comes up after the close returns.
        self._spawned.wait()
        with self._lock:
            workers = list(self._workers)
            self._workers.clear()
        _terminate(workers, graceful=graceful)
        # The processes are gone, so a thread still blocked reading one of their
        # pipes has seen end-of-file and returns. Wait for those before closing the
        # pipe ends, so that a close cannot pull a descriptor out from under a read.
        self._io.shutdown(wait=True, cancel_futures=True)
        for worker in workers:
            _close_all([worker.ctrl, worker.data, worker.abort_conn])


def _terminate(workers: list[_ProcessWorker], *, graceful: bool) -> None:
    """Get every worker's process to exit: ask, then SIGTERM, then SIGKILL."""
    if graceful:
        for worker in workers:
            with contextlib.suppress(EOFError, BrokenPipeError, OSError):
                worker.ctrl.send({"op": "shutdown", "args": {}, "seq": -1})
        deadline = time.monotonic() + _EXIT_GRACE_SECONDS
        for worker in workers:
            worker.process.join(max(0.0, deadline - time.monotonic()))
    for worker in workers:
        if worker.process.is_alive():
            worker.process.terminate()
    for worker in workers:
        worker.process.join(_EXIT_GRACE_SECONDS)
        if worker.process.is_alive():
            worker.process.kill()
            worker.process.join()


def _close_all(conns: Sequence[multiprocessing.connection.Connection]) -> None:
    for conn in conns:
        with contextlib.suppress(OSError):
            conn.close()
