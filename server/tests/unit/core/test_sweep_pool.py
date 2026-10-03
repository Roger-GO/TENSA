"""The dispatcher behind a parallel sweep, driven by fake workers.

``run_iterations`` hands the iterations of a sweep to a set of workers and reports
the rows. These tests give it workers that are plain objects with a blocking
``call``, so they pin the rules (order, abort, a worker that dies, none left)
without a process or a simulation. The real processes are covered by
``tests/integration/test_sweep_parallel.py``.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest

from tensa.core.sweep_pool import (
    PipeAbortEvent,
    SweepWorkerDiedError,
    SweepWorkerError,
    SweepWorkersLostError,
    run_iterations,
)

pytestmark = pytest.mark.unit

SOURCE = {"case_path": "case.raw", "addfiles": None, "replay": []}

# What a test arranges per iteration index, shared by every worker so that it does not
# matter which worker the dispatcher gives an iteration to.
Hooks = dict[int, Callable[[], None]]


def _tasks(count: int) -> list[dict[str, Any]]:
    return [{"index": i, "value": 1.0 + i / 10} for i in range(count)]


def _row(index: int, value: float) -> dict[str, Any]:
    return {
        "iteration": index,
        "parameter_value": value,
        "converged": True,
        "final_t": 0.2,
        "callpert_count": 7,
        "error": None,
    }


class FakeWorker:
    """A worker the test scripts.

    ``before`` and ``after`` map an iteration index to a function run inside the
    call, ahead of the answer or after it (to block, or to flip a flag), ``skip``
    lists the indices that answer ``skipped``, ``dies_on_run`` makes the worker's
    Nth iteration (counting from 1) raise ``SweepWorkerDiedError``, ``adopt_error``
    makes the first request fail, and ``delay`` is how long an iteration takes.
    """

    def __init__(
        self,
        *,
        before: Hooks | None = None,
        after: Hooks | None = None,
        skip: set[int] | None = None,
        dies_on_run: int | None = None,
        adopt_error: Exception | None = None,
        payload: Any = None,
        delay: float = 0.0,
    ) -> None:
        self.before = before or {}
        self.after = after or {}
        self.skip = skip or set()
        self.delay = delay
        self.dies_on_run = dies_on_run
        self.adopt_error = adopt_error
        self.payload = payload
        self.adopted: list[dict[str, Any]] = []
        self.ran: list[int] = []

    def call(self, op: str, args: dict[str, Any]) -> Any:
        if op == "adopt_sweep_source":
            if self.adopt_error is not None:
                raise self.adopt_error
            self.adopted.append(args["source"])
            return None
        assert op == "run_sweep_iteration"
        index = args["index"]
        self.ran.append(index)
        if index in self.before:
            self.before[index]()
        if self.delay:
            time.sleep(self.delay)
        if self.dies_on_run is not None and len(self.ran) >= self.dies_on_run:
            raise SweepWorkerDiedError("the sweep worker exited (exit code -9)")
        if index in self.skip:
            result: Any = {"skipped": True}
        elif self.payload is not None:
            result = self.payload
        else:
            result = _row(index, args["value"])
        if index in self.after:
            self.after[index]()
        return result


class Collector:
    """Records the rows ``on_row`` receives, in the order it receives them."""

    def __init__(self, on_row: Callable[[int], None] | None = None) -> None:
        self.indices: list[int] = []
        self.rows: dict[int, dict[str, Any]] = {}
        self._on_row = on_row

    async def __call__(self, index: int, row: dict[str, Any]) -> None:
        if self._on_row is not None:
            self._on_row(index)
        self.indices.append(index)
        self.rows[index] = row


async def _run(
    workers: list[FakeWorker],
    count: int,
    collector: Collector,
    *,
    should_stop: Callable[[], bool] = lambda: False,
) -> int:
    return await run_iterations(
        workers,  # type: ignore[arg-type]
        _tasks(count),
        source=SOURCE,
        on_row=collector,
        should_stop=should_stop,
    )


async def test_every_worker_adopts_the_case_and_every_iteration_runs_once() -> None:
    workers = [FakeWorker(), FakeWorker(), FakeWorker()]
    got = Collector()

    done = await _run(workers, 9, got)

    assert done == 9
    assert got.indices == list(range(9))
    assert all(w.adopted == [SOURCE] for w in workers)
    assert sorted(i for w in workers for i in w.ran) == list(range(9))


async def test_rows_carry_the_swept_value_and_what_the_worker_answered() -> None:
    got = Collector()

    await _run([FakeWorker(), FakeWorker()], 3, got)

    assert [got.rows[i]["iteration"] for i in range(3)] == [0, 1, 2]
    assert [got.rows[i]["parameter_value"] for i in range(3)] == [1.0, 1.1, 1.2]


async def test_rows_are_reported_in_index_order_whatever_order_they_finish_in() -> None:
    """Iteration 0 is held until 3 has finished on the other worker. A row reported
    on completion would reach ``on_row`` as 1, 2, 3, 0; it must wait its turn."""
    gate = threading.Event()
    hooks: Hooks = {
        0: lambda: gate.wait(10) or None,
        3: gate.set,
    }
    gate_open_when_reported: list[bool] = []
    got = Collector(lambda _index: gate_open_when_reported.append(gate.is_set()))

    done = await _run([FakeWorker(before=hooks), FakeWorker(before=hooks)], 4, got)

    assert done == 4
    assert got.indices == [0, 1, 2, 3]
    # No row, not even 1, 2 or 3, was reported before iteration 3 had finished and
    # iteration 0 was free to go.
    assert gate_open_when_reported == [True] * 4


async def test_an_abort_stops_handing_out_iterations() -> None:
    stopped = threading.Event()
    worker = FakeWorker(before={0: stopped.set})
    got = Collector()

    done = await _run([worker], 6, got, should_stop=stopped.is_set)

    assert done == 1
    assert got.indices == [0]
    assert worker.ran == [0]


async def test_a_skipped_iteration_ends_the_rows_even_if_a_later_one_finished() -> None:
    """Iteration 1 answers ``skipped`` (the abort reached it before it started),
    after 2, handed out later, ran to its end. Reporting row 2 would leave a hole
    in the results, so only row 0 is reported."""
    two_done = threading.Event()
    before: Hooks = {1: lambda: two_done.wait(10) and None}
    after: Hooks = {2: two_done.set}
    workers = [FakeWorker(before=before, after=after, skip={1}) for _ in range(2)]
    got = Collector()

    done = await _run(workers, 3, got)

    assert got.indices == [0]
    assert done == 1


async def test_a_dead_worker_costs_its_iteration_and_the_rest_carry_on() -> None:
    dying = FakeWorker(dies_on_run=1)
    steady = FakeWorker()
    got = Collector()

    done = await _run([dying, steady], 5, got)

    assert done == 5
    assert got.indices == [0, 1, 2, 3, 4]
    failed = [r for r in got.rows.values() if r["error"] is not None]
    assert len(failed) == 1
    row = failed[0]
    assert row["iteration"] == dying.ran[0]
    assert row["error"].startswith("SweepWorkerDiedError: ")
    assert row["converged"] is False
    assert row["parameter_value"] == 1.0 + row["iteration"] / 10
    # The dead worker is not handed anything else.
    assert len(dying.ran) == 1
    assert sorted([*dying.ran, *steady.ran]) == [0, 1, 2, 3, 4]


async def test_a_worker_error_fails_the_iteration_but_the_worker_stays_in_use() -> None:
    class Flaky(FakeWorker):
        def call(self, op: str, args: dict[str, Any]) -> Any:
            if op == "run_sweep_iteration" and args["index"] == 1:
                self.ran.append(1)
                raise SweepWorkerError("internal-error", "boom")
            return super().call(op, args)

    got = Collector()

    done = await _run([Flaky()], 3, got)

    assert done == 3
    assert got.rows[1]["error"] == "SweepWorkerError: internal-error: boom"
    assert got.rows[2]["error"] is None


async def test_a_result_that_is_not_a_dict_fails_the_iteration() -> None:
    got = Collector()

    done = await _run([FakeWorker(payload=["nonsense"])], 2, got)

    assert done == 2
    assert all(r["error"].startswith("SweepWorkerError: malformed") for r in got.rows.values())


async def test_when_every_worker_dies_the_sweep_fails_after_reporting_what_it_has() -> None:
    workers = [FakeWorker(dies_on_run=1), FakeWorker(dies_on_run=1)]
    got = Collector()

    # Each worker takes one iteration and dies with it, leaving four never handed
    # out; the message counts those, and the two that were lost are failed rows.
    with pytest.raises(SweepWorkersLostError, match="4 of 6 iterations still to run"):
        await _run(workers, 6, got)

    assert got.indices == [0, 1]
    assert all(r["error"] is not None for r in got.rows.values())


async def test_a_worker_that_cannot_take_the_case_is_left_out() -> None:
    broken = FakeWorker(adopt_error=SweepWorkerDiedError("gone"))
    steady = FakeWorker()
    got = Collector()

    done = await _run([broken, steady], 4, got)

    assert done == 4
    assert got.indices == [0, 1, 2, 3]
    assert broken.ran == []
    assert steady.ran == [0, 1, 2, 3]


async def test_a_raising_on_row_propagates_and_stops_handing_out_iterations() -> None:
    def explode(index: int) -> None:
        if index == 0:
            raise RuntimeError("the buffer is gone")

    workers = [FakeWorker(delay=0.02), FakeWorker(delay=0.02)]

    with pytest.raises(RuntimeError, match="the buffer is gone"):
        await _run(workers, 100, Collector(explode))

    handed_out = sum(len(w.ran) for w in workers)
    await asyncio.sleep(0.1)
    # The loops were cancelled rather than left running with nobody waiting.
    assert sum(len(w.ran) for w in workers) == handed_out
    assert handed_out < 100


async def test_cancelling_the_run_cancels_every_worker_loop() -> None:
    entered = threading.Semaphore(0)
    release = threading.Event()

    def hold() -> None:
        entered.release()
        release.wait(10)

    def both_entered() -> bool:
        return entered.acquire(timeout=10) and entered.acquire(timeout=10)

    # Whichever worker is handed iteration 0, the other is handed 1, so each is held
    # inside its first call and neither can run on while the cancel is on its way.
    workers = [FakeWorker(before={0: hold, 1: hold}), FakeWorker(before={0: hold, 1: hold})]
    task = asyncio.ensure_future(_run(workers, 10, Collector()))
    try:
        loop = asyncio.get_running_loop()
        assert await loop.run_in_executor(None, both_entered)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
    await asyncio.sleep(0.05)
    # Nothing keeps handing out iterations once the run is cancelled: each worker
    # finishes the call it was in and takes no more.
    assert sorted(i for w in workers for i in w.ran) == [0, 1]


# ---- PipeAbortEvent ----------------------------------------------------------


def _abort_pipe() -> tuple[Any, Any]:
    reader, writer = multiprocessing.Pipe(duplex=False)
    return reader, writer


def test_a_pipe_abort_is_clear_until_the_other_end_sends() -> None:
    reader, writer = _abort_pipe()
    event = PipeAbortEvent(reader)
    try:
        assert event.is_set() is False
        assert event.wait(0.01) is False
        writer.send(True)
        assert event.wait(2.0) is True
        assert event.is_set() is True
    finally:
        reader.close()
        writer.close()


def test_a_pipe_abort_stays_set() -> None:
    reader, writer = _abort_pipe()
    event = PipeAbortEvent(reader)
    try:
        writer.send(True)
        assert event.is_set() is True
        assert event.is_set() is True
        assert event.wait(0.01) is True
    finally:
        reader.close()
        writer.close()


def test_a_pipe_abort_is_set_when_the_other_end_closes() -> None:
    """A parent that closed its end is tearing the worker down."""
    reader, writer = _abort_pipe()
    event = PipeAbortEvent(reader)
    writer.close()
    try:
        assert event.wait(2.0) is True
    finally:
        reader.close()


def test_a_waiting_thread_does_not_block_is_set() -> None:
    """``is_set`` runs on the main thread while a bridge thread may still be in its
    last ``wait``. It must answer from what is known instead of queueing behind it,
    and the waiting thread picks up the abort within its timeout."""
    reader, writer = _abort_pipe()
    event = PipeAbortEvent(reader)
    waiting = threading.Thread(target=event.wait, args=(5.0,))
    waiting.start()
    try:
        for _ in range(400):
            if event._lock.locked():  # noqa: SLF001
                break
            threading.Event().wait(0.005)
        assert event._lock.locked()  # noqa: SLF001
        assert event.is_set() is False  # answered at once, not after the 5 s wait
        writer.send(True)
        waiting.join(5.0)
        assert not waiting.is_alive()
        assert event.is_set() is True
    finally:
        writer.close()
        waiting.join(5.0)
        reader.close()


def test_a_pipe_abort_survives_the_pickling_a_spawned_worker_gets() -> None:
    """The lock cannot be pickled, so the event is rebuilt around the same pipe end."""
    reader, writer = _abort_pipe()
    try:
        factory, args = PipeAbortEvent(reader).__reduce__()
        rebuilt = factory(*args)
        assert isinstance(rebuilt, PipeAbortEvent)
        writer.send(True)
        assert rebuilt.wait(2.0) is True
    finally:
        reader.close()
        writer.close()
