"""Sensitivity sweeps: started as a background task, buffered for the clients that
attach, and mirrored as a job."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from tensa.core.errors import WorkerDiedError
from tensa.core.jobs import JobKind
from tensa.core.session.base import _Session
from tensa.core.session.buffers import SweepState, _SweepBuffer
from tensa.core.session.errors import (
    WORKER_DIED_CATEGORY,
    SessionExpiredError,
    SweepInProgressError,
    WorkerError,
)
from tensa.core.session.jobs import _stream_error_problem
from tensa.core.session.registry import RegistryMixin
from tensa.core.sweep import sweep_worker_count
from tensa.core.sweep_pool import (
    SweepWorkerPool,
    SweepWorkersLostError,
    SweepWorkersUnavailableError,
)

log = logging.getLogger("tensa.session")

# Category of a sweep that ended because every one of its sub-workers died. The
# session's own worker is alive then, which is what sets this apart from
# ``WorkerDied`` (the session is gone and the case must be reloaded).
SWEEP_WORKERS_LOST_CATEGORY = SweepWorkersLostError.__name__


class SweepsMixin(RegistryMixin):
    """A sweep runs as a background task, on sub-workers when it is long enough to
    share and on the session's own worker otherwise. It holds the session's sweep
    gate, fills a sweep buffer that clients attach to, and has a job record (its
    ``job_id`` is the ``sweep_id``)."""

    async def start_sweep(
        self,
        session_id: str,
        sweep_args: dict[str, Any],
    ) -> str:
        """Start a sweep as a background task; return its ``sweep_id``.

        Sets the ``sweep_in_progress`` gate on the session BEFORE the
        background task is scheduled so any racing ``invoke`` immediately
        observes the flag and returns 503. The gate is cleared in the
        task's ``finally`` after the worker returns or errors out.

        ``sweep_args`` is the dict the worker's ``_handle_run_sweep``
        consumes (``snapshot_name`` / ``parameter_kind`` /
        ``parameter_target`` / ``values`` / ``tf`` / ``h``). The
        ``sweep_id`` is appended here so the worker echoes it back in
        progress envelopes.

        Raises ``SessionExpiredError`` if the session is gone, or
        ``SweepInProgressError`` if a sweep is already running on the
        session.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)
        if sess.sweep_in_progress is not None:
            raise SweepInProgressError(
                sess.sweep_in_progress,
                iter_done=sess.sweep_iter_done,
                iter_total=sess.sweep_iter_total,
            )

        sweep_id = uuid.uuid4().hex
        values_raw = sweep_args.get("values")
        total = len(values_raw) if isinstance(values_raw, list) else 0

        sweep_buf = _SweepBuffer(
            sweep_id=sweep_id,
            session_id=session_id,
            parameter_kind=str(sweep_args.get("parameter_kind", "")),
            parameter_target=int(sweep_args.get("parameter_target", 0) or 0),
            snapshot_name=str(sweep_args.get("snapshot_name", "")),
            total=total,
        )
        self._sweeps[sweep_id] = sweep_buf

        # Set the gate BEFORE scheduling — the background task may yield
        # before its first await on the worker pipe, so a racing route
        # call needs to see the flag immediately.
        sess.sweep_in_progress = sweep_id
        sess.sweep_iter_done = 0
        sess.sweep_iter_total = total

        # v3.1 Unit 5c: register the sweep as a first-class job whose ``job_id``
        # EQUALS the ``sweep_id`` (same value across both fields). The sweep has
        # a cooperative abort path (the shared abort event), so the record is
        # ``can_cancel=True``. ``_drive_sweep`` / ``_finish_sweep`` flip it
        # running → done / failed.
        self.register_sweep_job(
            session_id,
            sweep_id=sweep_id,
            kind="sweep",
            request_summary=_sweep_request_summary(sweep_args, total),
        )
        sess.job_registry.mark_running(sweep_id)
        running_record = sess.job_registry.get_job(sweep_id)
        if running_record is not None:
            self.broadcast_job_event(session_id, running_record)

        task = asyncio.create_task(
            self._drive_sweep(sess, sweep_buf, sweep_args),
            name=f"tensa-sweep-{sweep_id[:8]}",
        )
        self._sweep_tasks[sweep_id] = task

        def _on_sweep_done(_task: asyncio.Task[None], sid: str = sweep_id) -> None:
            self._sweep_tasks.pop(sid, None)

        task.add_done_callback(_on_sweep_done)
        return sweep_id

    async def _drive_sweep(
        self,
        sess: _Session,
        sweep_buf: _SweepBuffer,
        sweep_args: dict[str, Any],
    ) -> None:
        """Background task: pumps per-iteration progress into the sweep buffer +
        connected consumers.

        A sweep long enough to share runs its iterations on sub-workers
        (``_run_sweep_in_parallel``); any other, or one whose sub-workers cannot be
        used, runs on the session's own worker (``_run_sweep_on_session_worker``).
        Both feed ``_on_progress`` the same way, so the buffer, its WS events, and
        the job record cannot tell them apart. The terminal result flips state to
        ``completed`` + clears the session gate.
        """

        async def _on_progress(envelope: dict[str, Any]) -> None:
            iteration = int(envelope.get("iteration", 0))
            value = float(envelope.get("value", 0.0))
            iter_dict = envelope.get("result")
            if not isinstance(iter_dict, dict):
                iter_dict = {}
            async with sweep_buf.lock:
                sweep_buf.iterations.append(iter_dict)
                sweep_buf.completed_iterations = iteration + 1
                sweep_buf.state = "running"
                event = {
                    "type": "iteration",
                    "iteration": iteration,
                    "total": sweep_buf.total,
                    "value": value,
                    "result": iter_dict,
                }
                for q in sweep_buf.consumers:
                    with contextlib.suppress(asyncio.QueueFull):
                        q.put_nowait(event)
            sess.sweep_iter_done = sweep_buf.completed_iterations
            # v3.1 Unit 5c: surface fractional progress on the registry record
            # (job_id == sweep_id) so the activity panel renders a bar.
            if sweep_buf.total > 0:
                sess.job_registry.update_progress(
                    sweep_buf.sweep_id,
                    sweep_buf.completed_iterations / sweep_buf.total,
                )
                progressed = sess.job_registry.get_job(sweep_buf.sweep_id)
                if progressed is not None:
                    self.broadcast_job_event(sess.session_id, progressed)

        try:
            with sess.lock:
                workers = sweep_worker_count(self._sweep_workers, sweep_buf.total)
                if workers:
                    plan = await self._plan_parallel_sweep(sess, sweep_args)
                    if plan is not None:
                        result = await self._run_sweep_in_parallel(
                            sess, sweep_buf, sweep_args, plan, workers, _on_progress
                        )
                        if result is not None:
                            await self._finish_sweep(
                                sess, sweep_buf, "completed", result=result
                            )
                            return
                await self._run_sweep_on_session_worker(
                    sess, sweep_buf, sweep_args, _on_progress
                )
        except asyncio.CancelledError:
            await self._finish_sweep(
                sess, sweep_buf, "aborted", error=("cancelled", "sweep cancelled")
            )
            raise
        except WorkerDiedError as exc:
            # Worker crashed mid-sweep; the session is already marked dead.
            await self._finish_sweep(
                sess, sweep_buf, "error", error=(WORKER_DIED_CATEGORY, exc.detail)
            )
        except SessionExpiredError as exc:
            await self._finish_sweep(
                sess, sweep_buf, "error", error=("session-expired", str(exc))
            )
        except WorkerError as exc:
            await self._finish_sweep(
                sess, sweep_buf, "error", error=(exc.category, exc.detail)
            )
        except SweepWorkersLostError as exc:
            # The sub-workers died; the session's own worker is fine, so this is
            # not a ``WorkerDied`` (which tells the client to reload the case).
            await self._finish_sweep(
                sess, sweep_buf, "error", error=(SWEEP_WORKERS_LOST_CATEGORY, str(exc))
            )
        except Exception as exc:  # noqa: BLE001
            await self._finish_sweep(
                sess, sweep_buf, "error", error=("internal-error", str(exc))
            )

    async def _run_sweep_on_session_worker(
        self,
        sess: _Session,
        sweep_buf: _SweepBuffer,
        sweep_args: dict[str, Any],
        on_progress: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        """Run the whole sweep as one ``run_sweep`` op on the session's worker.

        Sends the request from the executor (Pipe.send is sync), then loops on
        Pipe.recv for ``sweep_progress`` envelopes and the final result envelope.
        The caller holds the session lock.
        """
        loop = asyncio.get_running_loop()
        sweep_args_with_id = {**sweep_args, "sweep_id": sweep_buf.sweep_id}
        sess.seq += 1
        sess.last_active = time.monotonic()
        seq = sess.seq
        try:
            await loop.run_in_executor(
                None,
                lambda: sess.ctrl.send(
                    {
                        "op": "run_sweep",
                        "args": sweep_args_with_id,
                        "seq": seq,
                    }
                ),
            )
        except (
            EOFError,
            BrokenPipeError,
            ConnectionResetError,
            OSError,
        ) as exc:
            raise self._raise_worker_died(sess, exc) from exc

        async def _read_one() -> dict[str, Any]:
            try:
                msg = await loop.run_in_executor(None, sess.data.recv)
            except (
                EOFError,
                BrokenPipeError,
                ConnectionResetError,
                OSError,
            ) as exc:
                raise self._raise_worker_died(sess, exc) from exc
            sess.last_active = time.monotonic()
            if not isinstance(msg, dict):
                raise WorkerError("malformed", f"non-dict response: {msg!r}")
            return msg

        while True:
            msg = await _read_one()
            msg_type = msg.get("type")
            if msg_type == "sweep_progress":
                await on_progress(msg)
                continue
            if msg_type == "result":
                result = msg.get("payload") or {}
                await self._finish_sweep(sess, sweep_buf, "completed", result=result)
                return
            if msg_type == "error":
                await self._finish_sweep(
                    sess,
                    sweep_buf,
                    "error",
                    error=(
                        str(msg.get("category", "unknown")),
                        str(msg.get("detail", "")),
                    ),
                )
                return
            # Unknown message type — surface as an error so the
            # WS client sees it rather than silently hanging.
            await self._finish_sweep(
                sess,
                sweep_buf,
                "error",
                error=("malformed", f"unexpected message type: {msg_type!r}"),
            )
            return

    async def _plan_parallel_sweep(
        self, sess: _Session, sweep_args: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Have the session's worker read and check the sweep's snapshot.

        Returns the plan the sub-workers run from (see ``Wrapper.sweep_plan``), or
        ``None`` when the worker refuses it: a missing or corrupt snapshot, a bad
        target, no case. The sweep then runs on the session's worker, where every
        iteration reports that same problem, instead of starting workers that
        could do nothing. The caller holds the session lock.
        """
        loop = asyncio.get_running_loop()
        sess.seq += 1
        sess.last_active = time.monotonic()
        request = {
            "op": "sweep_plan",
            "args": {
                key: sweep_args[key]
                for key in ("snapshot_name", "parameter_kind", "parameter_target")
            },
            "seq": sess.seq,
        }

        def _rpc() -> Any:
            sess.ctrl.send(request)
            return sess.data.recv()

        try:
            response = await loop.run_in_executor(None, _rpc)
        except (EOFError, BrokenPipeError, ConnectionResetError, OSError) as exc:
            raise self._raise_worker_died(sess, exc) from exc
        sess.last_active = time.monotonic()
        if isinstance(response, dict) and response.get("type") == "result":
            plan = response.get("payload")
            if isinstance(plan, dict):
                return plan
        detail = response.get("detail") if isinstance(response, dict) else response
        log.info(
            "sweep on session %s runs on the session's worker: its plan was refused (%s)",
            sess.session_id,
            detail,
        )
        return None

    async def _run_sweep_in_parallel(
        self,
        sess: _Session,
        sweep_buf: _SweepBuffer,
        sweep_args: dict[str, Any],
        plan: dict[str, Any],
        workers: int,
        on_progress: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> dict[str, Any] | None:
        """Run the sweep's iterations on ``workers`` freshly spawned sub-workers.

        Returns the sweep's result (``truncated`` and the counts), or ``None``
        when the sub-workers could not be started or none of them could take the
        case, so that the caller runs the sweep on the session's worker instead.
        The session's own worker is not involved, so its System is left as it was.
        The session's abort event is watched here and forwarded to the sub-workers,
        so an abort (or closing the session) stops them all; the event is cleared
        once they have exited, which is what the worker does at the end of a sweep
        it runs itself. The sub-workers are stopped whatever happens, including
        when this task is cancelled. The caller holds the session lock.
        """
        tasks = [
            {
                "index": index,
                "value": float(value),
                "specs": plan["specs"],
                "parameter_kind": sweep_args["parameter_kind"],
                "parameter_target": sweep_args["parameter_target"],
                "tf": sweep_args["tf"],
                "h": sweep_args["h"],
            }
            for index, value in enumerate(sweep_args["values"])
        ]
        pool = SweepWorkerPool(
            ctx=self._spawn_ctx,
            size=workers,
            workspace=self._workspace,
            owner_pid=os.getpid(),
            name=f"andes-sweep-{sweep_buf.sweep_id[:8]}",
        )
        started = False
        graceful = False
        truncated = False
        try:
            try:
                await pool.start()
            except Exception:  # noqa: BLE001 — fall back rather than fail the sweep
                log.warning(
                    "could not start the workers for sweep %s; running it on the "
                    "session's worker instead",
                    sweep_buf.sweep_id,
                    exc_info=True,
                )
                return None
            started = True
            log.info(
                "sweep %s: %d iterations on %d workers",
                sweep_buf.sweep_id,
                len(tasks),
                workers,
            )

            def _should_stop() -> bool:
                return sess.closed or bool(sess.abort_event.is_set())

            async def _on_row(index: int, row: dict[str, Any]) -> None:
                sess.last_active = time.monotonic()
                await on_progress(
                    {"iteration": index, "value": row["parameter_value"], "result": row}
                )

            try:
                reported = await pool.run(
                    tasks, source=plan["source"], on_row=_on_row, should_stop=_should_stop
                )
            except SweepWorkersUnavailableError:
                log.warning(
                    "no worker could take the case for sweep %s; running it on the "
                    "session's worker instead",
                    sweep_buf.sweep_id,
                    exc_info=True,
                )
                # The abort event is not cleared (as when the workers cannot start):
                # an abort that lands while these workers are being stopped must
                # still reach the sweep that now runs on the session's worker.
                started = False
                return None
            truncated = reported < len(tasks) or bool(sess.abort_event.is_set())
            graceful = True
        finally:
            await pool.close(graceful=graceful)
            if started:
                sess.abort_event.clear()
        if sess.closed:
            raise self._session_expired_error(sess.session_id, sess)
        return {"truncated": truncated, "total_requested": len(tasks), "workers": workers}

    async def _finish_sweep(
        self,
        sess: _Session,
        sweep_buf: _SweepBuffer,
        state: SweepState,
        *,
        result: dict[str, Any] | None = None,
        error: tuple[str, str] | None = None,
    ) -> None:
        async with sweep_buf.lock:
            sweep_buf.state = state
            if result is not None:
                sweep_buf.truncated = bool(result.get("truncated", False))
            sweep_buf.error = error
            sweep_buf.finished_at = time.monotonic()
            event: dict[str, Any] = {"type": "finished", "state": state}
            if error is not None:
                event["error"] = {"category": error[0], "detail": error[1]}
            for q in sweep_buf.consumers:
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(event)
        # Clear the session-wide sweep gate so subsequent invocations
        # are no longer 503'd. The buffer survives until the reaper
        # cleans it up (so late WS reconnects can read iteration
        # results back).
        sess.sweep_in_progress = None
        # v3.1 Unit 5c: reconcile the registry record (job_id == sweep_id) to
        # its terminal status. completed → done, aborted → cancelled, error →
        # failed (with a synthesized ProblemDetails from the sweep's error
        # tuple).
        self._finish_sweep_job(sess, sweep_buf.sweep_id, state, error=error)

    async def attach_to_sweep(
        self,
        session_id: str,
        sweep_id: str,
        last_iteration: int,
    ) -> AsyncIterator[dict[str, Any]]:
        """Attach to a sweep and yield its events — Unit 18.

        Replays any iterations after ``last_iteration`` (use ``-1`` for
        all), then streams live iteration + finished events.

        Yields events shaped:

          {"type": "snapshot", "buffer": {...}}      (always once at start)
          {"type": "iteration", "iteration": N, "total": M, "value": V,
           "result": {...}}
          {"type": "finished", "state": "completed" | "error" | "aborted",
           "error": {"category": ..., "detail": ...} | None}
          {"type": "not_found"}                       (terminal; unknown
                                                       sweep_id or wrong
                                                       session)
        """
        sweep_buf = self._sweeps.get(sweep_id)
        if sweep_buf is None or sweep_buf.session_id != session_id:
            yield {"type": "not_found"}
            return

        consumer: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10000)

        async with sweep_buf.lock:
            sweep_buf.consumers.append(consumer)
            snapshot_state = sweep_buf.state
            snapshot_iters = list(sweep_buf.iterations)
            snapshot_total = sweep_buf.total
            snapshot_error = sweep_buf.error

        try:
            # Initial snapshot envelope so the client can render the
            # already-completed iterations on attach.
            yield {
                "type": "snapshot",
                "sweep_id": sweep_id,
                "total": snapshot_total,
                "iterations_so_far": snapshot_iters,
                "state": snapshot_state,
            }

            # Replay missed iterations after the caller's cursor.
            for iter_dict in snapshot_iters:
                idx = int(iter_dict.get("iteration", -1))
                if idx <= last_iteration:
                    continue
                yield {
                    "type": "iteration",
                    "iteration": idx,
                    "total": snapshot_total,
                    "value": float(iter_dict.get("parameter_value", 0.0)),
                    "result": iter_dict,
                }

            # If the sweep already finished by the time we attached,
            # ship the terminal event from the snapshot.
            if snapshot_state in {"completed", "error", "aborted"}:
                terminal: dict[str, Any] = {
                    "type": "finished",
                    "state": snapshot_state,
                }
                if snapshot_error is not None:
                    terminal["error"] = {
                        "category": snapshot_error[0],
                        "detail": snapshot_error[1],
                    }
                yield terminal
                return

            # Live phase: drain queue.
            while True:
                event = await consumer.get()
                event_type = event.get("type")
                if event_type == "iteration":
                    idx = int(event.get("iteration", -1))
                    if idx <= last_iteration:
                        continue
                    yield event
                elif event_type == "finished":
                    yield event
                    return
        finally:
            async with sweep_buf.lock:
                with contextlib.suppress(ValueError):
                    sweep_buf.consumers.remove(consumer)

    def get_sweep_buffer(self, sweep_id: str) -> _SweepBuffer | None:
        """Return the sweep buffer (read-only access for the routes layer)."""
        return self._sweeps.get(sweep_id)

    def register_sweep_job(
        self,
        session_id: str,
        *,
        sweep_id: str,
        kind: JobKind = "sweep",
        request_summary: dict[str, Any] | None = None,
    ) -> str:
        """Register a sweep as a first-class job (Unit 5c).

        Mirror of :meth:`register_streaming_job` for sweeps: the registry
        ``job_id`` is aliased onto the caller-minted ``sweep_id`` (same value),
        ``can_cancel=True`` (the sweep cooperatively aborts via the shared abort
        event / task cancellation). Returns the ``job_id`` ( == ``sweep_id``).
        Silently no-ops when the session is already gone.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            return sweep_id
        sess.job_registry.register_job(
            kind=kind,
            can_cancel=True,
            request_summary=request_summary or {},
            job_id=sweep_id,
        )
        record = sess.job_registry.get_job(sweep_id)
        if record is not None:
            self.broadcast_job_event(session_id, record)
        return sweep_id

    def _finish_sweep_job(
        self,
        sess: _Session,
        sweep_id: str,
        state: SweepState,
        *,
        error: tuple[str, str] | None,
    ) -> None:
        """Reconcile the sweep's registry record to terminal (Unit 5c).

        ``completed`` → ``done``; ``aborted`` → ``cancelled``; ``error`` →
        ``failed`` with a synthesized ``ProblemDetails``. Broadcasts the
        transition.
        """
        registry = sess.job_registry
        terminal_id = sweep_id
        if state == "completed":
            registry.mark_done(sweep_id)
        elif state == "aborted":
            registry.mark_cancelled(sweep_id)
        elif state == "error":
            # ``mark_failed`` may coalesce into a prior same-signature record
            # (deleting ``sweep_id``); broadcast the survivor it returns.
            terminal_id = registry.mark_failed(
                sweep_id, problem=_stream_error_problem("sweep", error)
            )
        record = registry.get_job(terminal_id)
        if record is not None:
            self.broadcast_job_event(sess.session_id, record)


def _sweep_request_summary(
    sweep_args: dict[str, Any], total: int
) -> dict[str, Any]:
    """User-facing variables captured for a sweep job's retry (Unit 5c)."""
    summary: dict[str, Any] = {
        "snapshot_name": sweep_args.get("snapshot_name", ""),
        "parameter_kind": sweep_args.get("parameter_kind", ""),
        "parameter_target": sweep_args.get("parameter_target", 0),
        "tf": sweep_args.get("tf"),
        "h": sweep_args.get("h"),
        "total": total,
    }
    return summary
