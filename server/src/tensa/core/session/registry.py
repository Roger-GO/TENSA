"""The live sessions: a worker subprocess for each, one request at a time to it, the
idle reaper and the shutdown."""

from __future__ import annotations

import asyncio
import contextlib
import functools
import logging
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from tensa.core.errors import SessionBusyError, WorkerDiedError
from tensa.core.jobs import JobRecord, JobStatus
from tensa.core.messages import MessageLog
from tensa.core.session.base import _Session
from tensa.core.session.buffers import RUN_BUFFER_RETENTION_SECONDS
from tensa.core.session.errors import SweepInProgressError, WorkerError
from tensa.core.session.jobs import JobsMixin
from tensa.core.session_dirs import SESSIONS_DIRNAME, remove_tree, sweep_stale_session_dirs
from tensa.core.worker import worker_main
from tensa.core.worker_spawn import attach_kill_on_close_job, worker_spawn_env

log = logging.getLogger("tensa.session")

# Default tick for the idle-reaper background task. Smaller = more responsive
# reaping but more wakeups; larger = laggier reaping. 5 s is a fine balance for
# a default 180 s idle timeout.
IDLE_REAP_TICK = 5.0


def _current_inflight_job(sess: _Session) -> JobRecord | None:
    """Return the session's current in-flight job for ``SessionBusyError``.

    Prefers a ``running`` job over a ``pending`` one, and the
    most-recently-updated within each bucket. Returns ``None`` when the
    registry holds no in-flight record — the race window where the lock is
    held but the row has not yet been inserted, and (until Unit 5 wires
    per-route registration) the common case.
    """
    statuses: tuple[JobStatus, ...] = ("running", "pending")
    for status in statuses:
        jobs = sess.job_registry.list_jobs(status=status)
        if jobs:
            return max(jobs, key=lambda job: job.updated_at)
    return None


def _absorb_log(sess: _Session, message: object) -> None:
    """Move what ANDES logged, carried on a worker message as ``log`` (and
    ``log_dropped``), into the session's message log. Any message may carry it:
    a result, an error, a streamed frame."""
    if not isinstance(message, dict):
        return
    entries = message.get("log")
    dropped = message.get("log_dropped")
    if entries or dropped:
        sess.messages.extend(
            entries if isinstance(entries, list) else [],
            dropped if isinstance(dropped, int) else 0,
        )


def _answers_a_close(sess: _Session, message: object, seq: int) -> bool:
    """Whether ``message`` is the worker's answer to the ``shutdown`` of a close,
    read by the request ``seq`` in place of its own reply.

    A close does not wait for the request a session has in flight: it marks the
    session closed and sends ``shutdown`` at once (``_close_session``). A request
    that found the session open a moment before can then reach the worker after
    the ``shutdown``, and what it reads back is the worker's last word, the answer
    to that (``seq`` -1, no payload). Handed on as the request's own reply it is a
    result of ``None``, which a route fails on with a 500. The caller raises
    ``SessionExpiredError`` for it, as for a request that came after the close. A
    reply with the request's own ``seq`` is its own, closed session or not.
    """
    return sess.closed and isinstance(message, dict) and message.get("seq") != seq


class RegistryMixin(JobsMixin):
    """Spawning, closing and reaping sessions, and the requests to a session's worker
    (``invoke`` for one reply, ``invoke_streaming`` for a stream of them)."""

    async def start(self) -> None:
        """Clear abandoned scratch dirs, then start the background reaper +
        job-liveness sweeper tasks. Idempotent."""
        if not self._scratch_swept:
            self._scratch_swept = True
            await self._sweep_stale_scratch_dirs()
        if self._reaper_task is None or self._reaper_task.done():
            self._reaper_task = asyncio.create_task(
                self._reap_loop(), name="session-reaper"
            )
        if self._liveness_task is None or self._liveness_task.done():
            self._liveness_task = asyncio.create_task(
                self._liveness_loop(), name="job-liveness-sweeper"
            )

    async def _sweep_stale_scratch_dirs(self) -> None:
        """Remove ``<workspace>/.sessions/<id>/`` dirs a killed server left behind.

        Only dirs whose recorded owner process is gone (or, with no marker, that
        have sat untouched for a day) go; a live server sharing the workspace keeps
        its own. Runs before any session exists, so ``keep`` is just a guard.
        Never raises: a failed sweep must not stop the server from starting.
        """
        if self._workspace is None:
            return
        with self._registry_lock:
            keep = set(self._sessions)
        loop = asyncio.get_running_loop()
        try:
            removed = await loop.run_in_executor(
                None,
                functools.partial(sweep_stale_session_dirs, self._workspace, keep=keep),
            )
        except Exception:  # noqa: BLE001 — startup must not fail on housekeeping
            log.warning("could not sweep stale session dirs", exc_info=True)
            return
        if removed:
            log.info(
                "removed %d abandoned session scratch dir(s) from %s",
                len(removed),
                Path(self._workspace) / SESSIONS_DIRNAME,
            )

    async def shutdown(self) -> None:
        """Reap all sessions and stop the reaper task. Safe to call multiple times."""
        self._closed = True
        if self._reaper_task is not None:
            self._reaper_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reaper_task
            self._reaper_task = None
        if self._liveness_task is not None:
            self._liveness_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._liveness_task
            self._liveness_task = None

        # Cancel any in-flight streaming run tasks so they release their
        # per-session locks and the worker subprocesses can be torn down.
        run_tasks = list(self._run_tasks.values())
        for task in run_tasks:
            task.cancel()
        for task in run_tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._run_tasks.clear()
        self._runs.clear()

        # Unit 18: same teardown for sweeps. Cancel the background
        # tasks, await them, then drop the buffers.
        sweep_tasks = list(self._sweep_tasks.values())
        for task in sweep_tasks:
            task.cancel()
        for task in sweep_tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._sweep_tasks.clear()
        self._sweeps.clear()

        # Take the sessions out of the registry, as ``close_session`` does. A reaped
        # session left in it would keep its worker handle and its abort Event (five
        # POSIX semaphores) alive for as long as the manager is, which can be long
        # after the shutdown when something else still points at the manager.
        with self._registry_lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for sess in sessions:
            await self._close_session(sess, reason="shutdown")

    async def create_session(self) -> str:
        """Spawn a new worker subprocess and register it. Returns the session_id.

        Raises ``RuntimeError`` if at the ``max_sessions`` cap (the API layer
        translates this to HTTP 429).
        """
        with self._registry_lock:
            if len(self._sessions) >= self._max_sessions:
                raise RuntimeError(
                    f"max_sessions cap reached ({self._max_sessions} active)"
                )
            session_id = uuid.uuid4().hex

        # Allocate the IPC primitives outside the lock — Pipe creation can be
        # slow on macOS. ``duplex=True`` so each end can both read and write;
        # we still use ctrl for parent→worker commands and data for
        # worker→parent responses by convention, but this keeps the ends
        # symmetrical and avoids accidental direction bugs.
        parent_ctrl, child_ctrl = self._spawn_ctx.Pipe(duplex=True)
        parent_data, child_data = self._spawn_ctx.Pipe(duplex=True)
        abort_event = self._spawn_ctx.Event()

        process = self._spawn_ctx.Process(
            target=worker_main,
            args=(
                child_ctrl,
                child_data,
                abort_event,
                self._workspace,
                session_id,
                os.getpid(),
            ),
            name=f"andes-worker-{session_id[:8]}",
            daemon=False,
        )
        # The thread caps must be in the environment before the child loads numpy.
        with worker_spawn_env():
            process.start()
        # Windows only: tie the worker's life to the server's. No-op elsewhere.
        if process.pid is not None:
            attach_kill_on_close_job(process.pid)

        # Close the child ends in the parent — the parent only writes to ``parent_ctrl``
        # and reads from ``parent_data``.
        child_ctrl.close()
        child_data.close()

        sess = _Session(
            session_id=session_id,
            process=process,
            ctrl=parent_ctrl,
            data=parent_data,
            abort_event=abort_event,
        )
        with self._registry_lock:
            self._sessions[session_id] = sess
        return session_id

    async def close_session(self, session_id: str) -> None:
        """Cleanly terminate a session. Idempotent — closing an unknown
        session is a no-op."""
        with self._registry_lock:
            sess = self._sessions.pop(session_id, None)
        if sess is None:
            return
        await self._close_session(sess, reason="user-requested")

    async def _close_session(self, sess: _Session, *, reason: str) -> None:
        if sess.closed:
            return
        sess.closed = True
        # Wake any /jobs/events subscribers parked on ``consumer.get()`` with a
        # terminal sentinel so their generator unblocks and the WS closes,
        # instead of leaking a half-open socket + parked task across reaps.
        for queue in list(sess.job_event_subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait({"__closed__": True})
        # Best-effort graceful shutdown
        with contextlib.suppress(BrokenPipeError, OSError):
            sess.ctrl.send({"op": "shutdown", "args": {}, "seq": -1})

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, sess.process.join, 2.0)
        if sess.process.is_alive():
            sess.process.terminate()
            await loop.run_in_executor(None, sess.process.join, 2.0)
            if sess.process.is_alive():
                sess.process.kill()
                await loop.run_in_executor(None, sess.process.join, None)

        for conn in (sess.ctrl, sess.data):
            with contextlib.suppress(OSError):
                conn.close()

        # Unit 21 (KTD-9): delete the session's clone-on-write scratch dir
        # ``<workspace>/.sessions/<session_id>/`` on reap. The clone files live
        # on the parent-visible filesystem, so cleanup does not require the
        # (now-dead) worker. Best-effort — a missing dir is fine.
        self._cleanup_clone_dir(sess.session_id)

    def _cleanup_clone_dir(self, session_id: str) -> None:
        """Remove the per-session clone scratch dir, if any (Unit 21)."""
        if self._workspace is None:
            return
        clone_root = Path(self._workspace) / SESSIONS_DIRNAME / session_id
        if clone_root.exists():
            with contextlib.suppress(OSError):
                remove_tree(clone_root)

    def _raise_worker_died(
        self, sess: _Session, exc: BaseException
    ) -> WorkerDiedError:
        """Mark a session dead after its worker crashed mid-RPC, then return the
        :class:`WorkerDiedError` to raise.

        Runs on the executor thread inside ``_rpc`` (the session ``RLock`` is
        held), so it only touches thread-safe state: flips ``closed`` + stamps
        ``death_reason``, drops the session from the registry so follow-up
        ``invoke`` calls fast-fail, and best-effort terminates the worker process
        + closes the pipes. It deliberately does NOT call the async
        ``_close_session`` (no event loop here); the idle reaper / shutdown path
        tolerates an already-dead, already-popped session.
        """
        err = WorkerDiedError()
        sess.closed = True
        sess.death_reason = err.detail
        log.warning(
            "session %s worker died mid-RPC (%s: %s); marking session dead",
            sess.session_id,
            type(exc).__name__,
            exc,
        )
        # Drop from the registry so subsequent invoke() calls fast-fail with the
        # death-reason SessionExpiredError rather than racing on the dead pipe.
        with self._registry_lock:
            self._sessions.pop(sess.session_id, None)
        # Best-effort process teardown — the worker is presumed gone, but if it
        # is a zombie/half-dead, terminate then kill so no orphan lingers.
        proc = sess.process
        if proc is not None:
            with contextlib.suppress(Exception):
                if proc.is_alive():
                    proc.terminate()
                    proc.join(timeout=1.0)
                    if proc.is_alive():
                        proc.kill()
        for conn in (sess.ctrl, sess.data):
            with contextlib.suppress(Exception):
                conn.close()
        # Clean up the per-session clone scratch dir (mirrors _close_session).
        self._cleanup_clone_dir(sess.session_id)
        return err

    async def invoke(
        self,
        session_id: str,
        op: str,
        args: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
        bypass_sweep_gate: bool = False,
        bypass_session_gate: bool = False,
    ) -> Any:
        """Send an op to the session's worker and await the response.

        At most one in-flight invocation per session at a time (per-session
        ``RLock``). The gate is now *non-blocking*: a second concurrent
        request fails fast rather than queueing behind the in-flight op.
        Raises:

        - ``SessionExpiredError`` if the session was reaped or never existed, or
          was closed while this request was on its way to the worker.
        - ``SweepInProgressError`` if a sweep is holding the session lock
          (Unit 18). Skip this check by passing ``bypass_sweep_gate=True``
          — only the sweep's own background-task path uses this escape.
        - ``SessionBusyError`` if another operation already holds the session
          ``RLock`` (the non-blocking try-acquire failed). The routes layer
          maps this to 409. ``bypass_session_gate=True`` skips this fail-fast
          gate and acquires with a blocking wait instead (re-entrant on the
          same thread); it is reserved for future internal callers and is
          unused in v3.1.
        - ``WorkerError`` if the worker returned a structured error response.
        - ``asyncio.TimeoutError`` if ``timeout`` is set and exceeded.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)
        if not bypass_sweep_gate and sess.sweep_in_progress is not None:
            raise SweepInProgressError(
                sess.sweep_in_progress,
                iter_done=sess.sweep_iter_done,
                iter_total=sess.sweep_iter_total,
            )

        loop = asyncio.get_running_loop()

        def _rpc() -> Any:
            # Non-blocking session gate (KTD-2a/2b). The RLock is acquired and
            # released on this executor thread (never the event loop), so it
            # provides true mutual exclusion between distinct concurrent
            # invocations. A second request whose op is already in flight fails
            # fast with SessionBusyError instead of blocking the executor.
            # bypass_session_gate (see the docstring) takes a blocking acquire.
            if bypass_session_gate:
                sess.lock.acquire()
            elif not sess.lock.acquire(blocking=False):
                raise SessionBusyError(current_job=_current_inflight_job(sess))
            try:
                sess.seq += 1
                sess.last_active = time.monotonic()
                seq = sess.seq
                try:
                    sess.ctrl.send({"op": op, "args": args or {}, "seq": seq})
                    response = sess.data.recv()
                    # Here, not after the await: a caller that timed out still
                    # reads the reply on this thread, and its messages are kept.
                    _absorb_log(sess, response)
                except (
                    EOFError,
                    BrokenPipeError,
                    ConnectionResetError,
                    OSError,
                ) as exc:
                    # The worker subprocess died mid-RPC: the pipe is torn, so
                    # send/recv raises a raw IPC error. Translate it into a
                    # structured, recoverable ``WorkerDiedError`` and flag the
                    # session dead so EVERY subsequent invoke fast-fails as a
                    # SessionExpiredError instead of re-bubbling a bare 500.
                    raise self._raise_worker_died(sess, exc) from exc
                sess.last_active = time.monotonic()
                if _answers_a_close(sess, response, seq):
                    raise self._session_expired_error(session_id, sess)
                return response
            finally:
                sess.lock.release()

        if timeout is not None:
            response = await asyncio.wait_for(
                loop.run_in_executor(None, _rpc), timeout=timeout
            )
        else:
            response = await loop.run_in_executor(None, _rpc)

        if response.get("type") == "error":
            raise WorkerError(
                category=response.get("category", "unknown"),
                detail=response.get("detail", ""),
                extra=response.get("extra"),
            )
        return response.get("payload")

    async def invoke_streaming(
        self,
        session_id: str,
        op: str,
        args: dict[str, Any] | None = None,
        *,
        on_metadata: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
        on_frame: Callable[[bytes], Awaitable[None]] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """Like ``invoke``, but the worker may emit ``stream_start`` and
        ``stream_frame`` messages before the final ``result``. The caller
        supplies async callbacks to forward each frame to a downstream
        consumer (typically a WebSocket sender task).

        Returns the final result payload (the same shape ``invoke`` would
        return). Raises ``WorkerError`` on a structured error response,
        ``SessionExpiredError`` if the session was reaped, or
        ``asyncio.TimeoutError`` on overall timeout.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)

        loop = asyncio.get_running_loop()

        # Send the request from the executor (Pipe.send is sync); then loop
        # on Pipe.recv (also sync) on the executor for each frame, dispatching
        # callbacks back on the running loop.
        with sess.lock:
            sess.seq += 1
            sess.last_active = time.monotonic()
            seq = sess.seq
            try:
                await loop.run_in_executor(
                    None,
                    lambda: sess.ctrl.send(
                        {"op": op, "args": args or {}, "seq": seq}
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
                    # Same hazard as the batch ``invoke``: a worker that dies
                    # mid-stream tears the pipe and ``recv`` raises raw. Mark the
                    # session dead and surface the structured WorkerDiedError so
                    # the run driver finishes the buffer as a recoverable error
                    # rather than letting an EOFError escape uncaught.
                    raise self._raise_worker_died(sess, exc) from exc
                sess.last_active = time.monotonic()
                if not isinstance(msg, dict):
                    raise WorkerError("malformed", f"non-dict response: {msg!r}")
                _absorb_log(sess, msg)
                return msg

            deadline = (
                None if timeout is None else asyncio.get_event_loop().time() + timeout
            )
            while True:
                if deadline is not None:
                    remaining = deadline - asyncio.get_event_loop().time()
                    if remaining <= 0:
                        raise TimeoutError(
                            f"streaming invoke timed out after {timeout}s"
                        )
                    msg = await asyncio.wait_for(_read_one(), timeout=remaining)
                else:
                    msg = await _read_one()

                msg_type = msg.get("type")
                if msg_type == "stream_start":
                    if on_metadata is not None:
                        metadata = msg.get("metadata") or {}
                        await on_metadata(metadata)
                    continue
                if msg_type == "stream_frame":
                    if on_frame is not None:
                        payload = msg.get("payload")
                        if isinstance(payload, (bytes, bytearray)):
                            await on_frame(bytes(payload))
                    continue
                if msg_type == "result":
                    if _answers_a_close(sess, msg, seq):
                        raise self._session_expired_error(session_id, sess)
                    return msg.get("payload")
                if msg_type == "error":
                    raise WorkerError(
                        category=msg.get("category", "unknown"),
                        detail=msg.get("detail", ""),
                        extra=msg.get("extra"),
                    )
                # Unknown — ignore but log via raising a structured error so
                # the test suite catches it.
                raise WorkerError("malformed", f"unexpected message type: {msg_type!r}")

    async def signal_abort(self, session_id: str) -> None:
        """Set the worker's abort event. Cooperatively terminates an active
        ``run_tds`` invocation. No-op if no TDS is running."""
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, sess.abort_event.set)

    def session_messages(self, session_id: str) -> MessageLog:
        """Return the session's log of what ANDES said while its worker ran commands.

        Raises ``SessionExpiredError`` for an unknown / closed session.
        """
        return self._require_session(session_id).messages

    def list_sessions(self) -> list[str]:
        """Return a snapshot of currently-active session IDs."""
        with self._registry_lock:
            return [s for s, sess in self._sessions.items() if not sess.closed]

    def is_alive(self, session_id: str) -> bool:
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        return sess is not None and not sess.closed and sess.process.is_alive()

    def touch(self, session_id: str) -> bool:
        """Count a client's check-in as activity, so the idle reaper leaves the
        session alone for another ``idle_timeout``.

        Returns ``False`` when the session is gone (reaped, closed, never
        existed) and ``True`` once it has been stamped. Cheap and lock-free:
        it never talks to the worker, so it works while a job holds the session.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            return False
        sess.last_active = time.monotonic()
        return True

    async def _reap_loop(self) -> None:
        """Background task: every ``IDLE_REAP_TICK`` seconds, sweep for idle
        sessions and stale run buffers."""
        while not self._closed:
            try:
                await asyncio.sleep(IDLE_REAP_TICK)
            except asyncio.CancelledError:
                return

            now = time.monotonic()
            stale: list[_Session] = []
            with self._registry_lock:
                for sid, sess in list(self._sessions.items()):
                    if sess.closed:
                        del self._sessions[sid]
                        continue
                    if now - sess.last_active > self._idle_timeout:
                        del self._sessions[sid]
                        stale.append(sess)
            for sess in stale:
                await self._close_session(sess, reason="idle-reaped")

            # Clean up run buffers whose retention window has elapsed.
            for run_id, run_buf in list(self._runs.items()):
                if run_buf.finished_at is None:
                    continue
                if now - run_buf.finished_at > RUN_BUFFER_RETENTION_SECONDS:
                    self._runs.pop(run_id, None)
            # Same retention for sweep buffers (Unit 18). Iterations are
            # bounded so memory pressure is moderate; we still drop the
            # buffer after the retention window so a never-attached
            # sweep doesn't leak.
            for sweep_id, sweep_buf in list(self._sweeps.items()):
                if sweep_buf.finished_at is None:
                    continue
                if now - sweep_buf.finished_at > RUN_BUFFER_RETENTION_SECONDS:
                    self._sweeps.pop(sweep_id, None)
