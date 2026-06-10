"""SessionManager: spawns one worker subprocess per session, marshals
request/response over Pipes, owns idle-timeout reaping and watchdog
escalation.

The SessionManager runs in the FastAPI parent process. It is the only place
where worker subprocesses are spawned. The FastAPI routers (Unit 4+) call its
async methods; the SessionManager handles the synchronous Pipe IPC via a
thread pool.

Concurrency model:

- One ``multiprocessing.Process`` per session.
- One ``Lock`` per session — only one in-flight ``invoke`` at a time per
  session (per-session run-cap is also enforced at the API layer).
- A background reaper task scans for idle sessions every ``IDLE_REAP_TICK``
  seconds and calls ``close()`` on any session whose ``last_active`` is
  older than ``idle_timeout``.

Watchdog escalation for streaming TDS lands in Unit 6 alongside the
WebSocket plumbing — Phase A's Unit 2 gives us the foundation: clean spawn,
batch RPC, abort, and reap. That's enough to satisfy Units 4-5 (PF + TDS
batch) directly.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import multiprocessing as mp
import shutil
import threading
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from andes_app.core.errors import AndesAppError, SessionBusyError, WorkerDiedError
from andes_app.core.jobs import JobKind, JobRecord, JobStatus, _JobRegistry
from andes_app.core.worker import worker_main

log = logging.getLogger("andes-app.session")

# Default tick for the idle-reaper background task. Smaller = more responsive
# reaping but more wakeups; larger = laggier reaping. 5 s is a fine balance for
# a default 180 s idle timeout.
IDLE_REAP_TICK = 5.0

# v3.1 Unit 5a: tick for the job-liveness sweeper (KTD-18). Every tick the
# sweeper scans sessions that have at least one ``running`` job and marks any
# whose worker process has died as ``failed`` (category ``WorkerDied``). 10 s
# keeps the cost proportional to active work while bounding how long a job can
# sit ``running`` against a dead worker before the activity panel reflects it.
JOB_LIVENESS_TICK = 10.0

# Category string the liveness sweeper stamps onto the synthesized
# ``ProblemDetails`` of a job orphaned by a dead worker.
WORKER_DIED_CATEGORY = "WorkerDied"


class SessionExpiredError(AndesAppError):
    """Raised when a caller references a session that has been reaped or
    never existed."""


class SweepInProgressError(AndesAppError):
    """Raised by ``SessionManager.invoke`` when a sweep holds the session
    lock — Unit 18.

    Carries the sweep_id + iteration progress so the routes layer can
    build a ``503 Service Unavailable`` response with a ``Retry-After``
    header and a useful detail string (``"Sweep <id> in progress;
    <N>/<total> iterations complete"``).

    ``recovery_kind`` is a plain ``str`` (matching the ``RecoveryKind``
    Literal in ``api/schemas.py`` without importing it — see
    :class:`~andes_app.core.errors.AndesAppError`) so the shared error mapper
    (Unit 4a) can attach a ``wait-for-sweep`` recovery descriptor.
    """

    recovery_kind: str | None = "wait-for-sweep"

    def __init__(
        self, sweep_id: str, *, iter_done: int, iter_total: int
    ) -> None:
        super().__init__(
            f"Sweep {sweep_id} in progress; {iter_done}/{iter_total} "
            "iterations complete"
        )
        self.sweep_id = sweep_id
        self.iter_done = iter_done
        self.iter_total = iter_total


class WorkerError(AndesAppError):
    """Raised when the worker reports a structured error response. The
    ``category`` field maps onto specific HTTP status codes at the API layer
    (Unit 4 / Unit 5).

    ``extra`` carries an optional structured payload (e.g., the dependents
    list for ``ElementHasDependentsError``). Routes that need the extra
    fields (currently only the DELETE elements endpoint) read them off
    this attribute; everyone else can ignore it.
    """

    def __init__(
        self,
        category: str,
        detail: str,
        *,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(f"{category}: {detail}")
        self.category = category
        self.detail = detail
        self.extra = extra or {}


@dataclass
class _Session:
    """Bookkeeping for a single live session."""

    session_id: str
    process: mp.Process
    ctrl: Any  # multiprocessing.connection.Connection (no Generic in 3.12 stdlib)
    data: Any
    abort_event: Any  # multiprocessing.synchronize.Event
    lock: threading.RLock = field(default_factory=threading.RLock)
    seq: int = 0
    last_active: float = field(default_factory=time.monotonic)
    closed: bool = False
    # Set when the session was closed because its worker subprocess crashed
    # mid-RPC (torn IPC pipe). Lets ``invoke`` distinguish a crashed worker
    # from an idle-reaped / never-existed session in the ``SessionExpiredError``
    # it raises for a follow-up call. ``None`` for a clean / idle close.
    death_reason: str | None = None
    # Unit 18: sweep gate. When non-None, a sweep is running and the
    # session-scoped routes return 503 + Retry-After. The string holds
    # the sweep_id for the route's error detail. Set inside
    # ``start_sweep`` BEFORE the background task is scheduled and
    # cleared in the task's ``finally``. Read by ``invoke`` (and the
    # routes layer can read it directly via ``sweep_in_progress``).
    sweep_in_progress: str | None = None
    # Iteration counter the routes layer surfaces in the 503 detail.
    # Updated by the sweep task as each iteration completes.
    sweep_iter_done: int = 0
    sweep_iter_total: int = 0
    # v3.1 Unit 1: per-session job registry. Mirrors every routine
    # invocation so the activity panel (Unit 11) can render in-flight +
    # historical jobs across all kinds (PF/EIG/CPF/SE/sweep/clone-edit/...).
    # Population is wired in Unit 5 (per-routine route migration); Unit 1
    # only instantiates the per-session container.
    job_registry: _JobRegistry = field(default_factory=_JobRegistry)
    # v3.1 Unit 5a: live job-event subscribers for the per-session multiplexed
    # ``/jobs/events`` WebSocket. Each connected client owns an asyncio Queue;
    # every registry transition (register/running/done/failed/cancelled/
    # progress) is broadcast as a JSON envelope to all queues so multiple
    # subscribers see every event with no loss. Attach/detach is managed by
    # ``SessionManager.subscribe_job_events``.
    job_event_subscribers: list[asyncio.Queue[dict[str, Any]]] = field(
        default_factory=list
    )


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


def _job_event_envelope(record: JobRecord) -> dict[str, Any]:
    """Build the per-session WS envelope for a job transition (Unit 5a).

    Shape: ``{job_id, kind, status, progress?, problem?}`` — ``progress`` and
    ``problem`` are included only when populated so the wire stays lean and the
    client can treat their absence as "unchanged / indeterminate".
    """
    envelope: dict[str, Any] = {
        "job_id": record.id,
        "kind": record.kind,
        "status": record.status,
    }
    if record.progress is not None:
        envelope["progress"] = record.progress
    if record.problem is not None:
        envelope["problem"] = record.problem
    return envelope


RunState = Literal["pending", "running", "completed", "error"]


@dataclass
class _RunBuffer:
    """Server-side buffer for an active or recently-completed streaming run.

    The run survives WebSocket disconnect: as long as the buffer is retained,
    a client can reconnect with a ``resume`` message and replay any frames
    still in the buffer plus any frames that arrived while disconnected.

    The buffer's deque is bounded so memory is fixed regardless of run length.
    Default size is 30 seconds of frames at the configured output rate, with
    a safety floor of 1000 frames when no rate is configured (``decimation="none"``
    + no ``max_rate_hz``).
    """

    run_id: str
    session_id: str
    metadata: dict[str, Any] | None = None
    frames: deque[tuple[int, bytes]] = field(default_factory=lambda: deque(maxlen=1000))
    state: RunState = "pending"
    result_payload: dict[str, Any] | None = None
    error: tuple[str, str] | None = None  # (category, detail)
    consumers: list[asyncio.Queue[dict[str, Any]]] = field(default_factory=list)
    finished_at: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


# Retention window for completed run buffers. After this many seconds since
# completion, the buffer is eligible for cleanup by the reaper. The window
# matches the plan's 30-second resume horizon.
RUN_BUFFER_RETENTION_SECONDS = 30.0


SweepState = Literal["pending", "running", "completed", "error", "aborted"]


@dataclass
class _SweepBuffer:
    """Server-side buffer for an active or recently-completed sweep — Unit 18.

    Per-iteration progress events flow into ``events`` (an asyncio Queue
    snapshot deque mirror, similar to ``_RunBuffer.frames`` but JSON-shaped
    rather than binary). Consumers attach via
    ``SessionManager.attach_to_sweep`` and replay any buffered events
    older than their last-seen iteration index, then receive live events.

    Sweep iterations are bounded (Unit 18 plan caps at 200) so the deque
    is unbounded — we keep every iteration's event for the sweep
    lifetime + ``RUN_BUFFER_RETENTION_SECONDS`` post-completion.
    """

    sweep_id: str
    session_id: str
    parameter_kind: str = ""
    parameter_target: int = 0
    snapshot_name: str = ""
    total: int = 0
    completed_iterations: int = 0
    iterations: list[dict[str, Any]] = field(default_factory=list)
    state: SweepState = "pending"
    error: tuple[str, str] | None = None  # (category, detail)
    truncated: bool = False
    consumers: list[asyncio.Queue[dict[str, Any]]] = field(default_factory=list)
    finished_at: float | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class SessionManager:
    """Owns the registry of live sessions and the reaper task.

    Public methods are async to integrate cleanly with FastAPI dependency
    injection. Synchronous IPC (Pipe send/recv) is offloaded to a default
    asyncio executor.
    """

    def __init__(
        self,
        *,
        max_sessions: int = 4,
        idle_timeout: float = 180.0,
        spawn_method: str = "spawn",
        workspace: str | None = None,
    ) -> None:
        self._max_sessions = max_sessions
        self._idle_timeout = idle_timeout
        self._workspace = workspace  # for the worker's strict-fs audit hook
        self._sessions: dict[str, _Session] = {}
        self._registry_lock = threading.Lock()
        self._reaper_task: asyncio.Task[None] | None = None
        # v3.1 Unit 5a: job-liveness sweeper task (KTD-18). Started alongside
        # the reaper in ``start`` and cancelled in ``shutdown``.
        self._liveness_task: asyncio.Task[None] | None = None
        self._closed = False
        # v3.1 Unit 5a (KTD-20): registry for *session-mutating* jobs whose
        # lifecycle spans more than one worker session (snapshot restore,
        # bundle import, case reload). A per-session registry would be lost
        # when the session it mutated INTO is replaced, so these records live
        # on the manager itself and are surfaced through every session's
        # ``GET /jobs`` view (see ``list_session_jobs``). Population lands in
        # Unit 5b; Unit 5a only instantiates the container + the read path.
        self._global_job_registry = _JobRegistry()
        # Streaming runs keyed by run_id. Each run's frames + metadata + final
        # state live here for the resume window even after the WS disconnects.
        self._runs: dict[str, _RunBuffer] = {}
        # Background tasks for currently-running streaming runs. We keep
        # references so they aren't garbage-collected mid-run.
        self._run_tasks: dict[str, asyncio.Task[None]] = {}
        # Unit 18: sweeps keyed by sweep_id. A sweep buffer outlives its
        # background task by ``RUN_BUFFER_RETENTION_SECONDS`` so a late
        # WS attach can still replay the iteration history.
        self._sweeps: dict[str, _SweepBuffer] = {}
        self._sweep_tasks: dict[str, asyncio.Task[None]] = {}
        # ``spawn`` (vs. fork) is the safe default: ANDES uses numpy/scipy/sympy
        # which are not always fork-safe (BLAS thread pools, signal handlers).
        # ``spawn`` re-imports cleanly per worker.
        # ``Any`` annotation works around incomplete BaseContext stubs (the
        # context exposes Process / Pipe / Event at runtime but mypy's
        # typeshed entry can be narrower than reality on some versions).
        self._spawn_ctx: Any = mp.get_context(spawn_method)

    # ----- lifecycle -----

    async def start(self) -> None:
        """Start the background reaper + job-liveness sweeper tasks. Idempotent."""
        if self._reaper_task is None or self._reaper_task.done():
            self._reaper_task = asyncio.create_task(
                self._reap_loop(), name="session-reaper"
            )
        if self._liveness_task is None or self._liveness_task.done():
            self._liveness_task = asyncio.create_task(
                self._liveness_loop(), name="job-liveness-sweeper"
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

        with self._registry_lock:
            sessions = list(self._sessions.values())
        for sess in sessions:
            await self._close_session(sess, reason="shutdown")

    # ----- session creation / removal -----

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
            args=(child_ctrl, child_data, abort_event, self._workspace, session_id),
            name=f"andes-worker-{session_id[:8]}",
            daemon=False,
        )
        process.start()

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
        clone_root = Path(self._workspace) / ".sessions" / session_id
        if clone_root.exists():
            with contextlib.suppress(OSError):
                shutil.rmtree(clone_root)

    # ----- request/response -----

    def _session_expired_error(
        self, session_id: str, sess: _Session | None
    ) -> SessionExpiredError:
        """Build the ``SessionExpiredError`` for a missing / closed session.

        When the session was closed because its worker crashed (``death_reason``
        set by :meth:`_raise_worker_died`), the message names that cause so the
        caller is told the case is safe and to reload — distinct from the
        generic "reaped or never existed" idle / unknown-session case.
        """
        if sess is not None and sess.death_reason is not None:
            return SessionExpiredError(sess.death_reason)
        return SessionExpiredError(f"session {session_id!r} is not active")

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

        - ``SessionExpiredError`` if the session was reaped or never existed.
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

    # ----- streaming runs (resume-capable) --------------------------------

    async def start_streaming_run(
        self,
        session_id: str,
        op: str,
        args: dict[str, Any],
    ) -> str:
        """Start a streaming run as a background task; return its ``run_id``.

        The run continues even if no client is currently attached. Frames
        flow into a per-run buffer (capacity sized from
        ``args["max_rate_hz"]`` × the retention window, falling back to
        1000 frames when no rate is configured). Clients attach via
        ``attach_to_run`` to replay buffered frames + receive live frames.

        Raises ``SessionExpiredError`` if the session is gone.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)

        run_id = uuid.uuid4().hex
        max_rate_hz = args.get("max_rate_hz")
        if isinstance(max_rate_hz, (int, float)) and max_rate_hz > 0:
            max_frames = max(int(max_rate_hz * RUN_BUFFER_RETENTION_SECONDS), 64)
        else:
            max_frames = 1000

        run_buf = _RunBuffer(
            run_id=run_id,
            session_id=session_id,
            frames=deque(maxlen=max_frames),
        )
        self._runs[run_id] = run_buf

        # v3.1 Unit 5c: register the streaming run as a first-class job whose
        # ``job_id`` EQUALS the ``run_id`` (same value across both fields). The
        # ``_drive_streaming_run`` driver below transitions it running → done /
        # failed; cancellation is cooperative via the abort event so the record
        # is ``can_cancel=True``.
        self.register_streaming_job(
            session_id,
            run_id=run_id,
            kind="tds-stream",
            request_summary=_streaming_request_summary(args),
        )

        task = asyncio.create_task(
            self._drive_streaming_run(run_buf, op, args),
            name=f"andes-app-run-{run_id[:8]}",
        )
        self._run_tasks[run_id] = task

        # Cleanup the task ref when it finishes (the buffer outlives the
        # task by RUN_BUFFER_RETENTION_SECONDS for resume).
        def _on_run_done(_task: asyncio.Task[None], rid: str = run_id) -> None:
            self._run_tasks.pop(rid, None)

        task.add_done_callback(_on_run_done)
        return run_id

    async def _drive_streaming_run(
        self,
        run_buf: _RunBuffer,
        op: str,
        args: dict[str, Any],
    ) -> None:
        """Background task: drives ``invoke_streaming`` against the worker
        and routes frames into the run buffer + connected consumers."""
        frame_seq_counter = 0

        async def _on_metadata(meta: dict[str, Any]) -> None:
            async with run_buf.lock:
                run_buf.metadata = meta
                run_buf.state = "running"
                event = {"type": "metadata", "data": meta}
                for q in run_buf.consumers:
                    with contextlib.suppress(asyncio.QueueFull):
                        q.put_nowait(event)
            # v3.1 Unit 5c: the worker has begun emitting frames — flip the
            # registry record running so the activity panel shows the spinner.
            self._mark_streaming_job_running(run_buf)

        async def _on_frame(payload: bytes) -> None:
            nonlocal frame_seq_counter
            async with run_buf.lock:
                frame_seq_counter += 1
                seq = frame_seq_counter
                run_buf.frames.append((seq, payload))
                event = {"type": "frame", "seq": seq, "payload": payload}
                for q in run_buf.consumers:
                    with contextlib.suppress(asyncio.QueueFull):
                        q.put_nowait(event)

        try:
            result = await self.invoke_streaming(
                run_buf.session_id,
                op,
                args,
                on_metadata=_on_metadata,
                on_frame=_on_frame,
                timeout=300.0,
            )
        except WorkerDiedError as exc:
            # The worker crashed mid-stream; ``invoke_streaming`` already marked
            # the session dead. Finish the buffer as a recoverable error carrying
            # the ``WorkerDied`` category so the WS terminal frame is actionable.
            await self._finish_run_buffer(
                run_buf, "error", error=(WORKER_DIED_CATEGORY, exc.detail)
            )
            return
        except SessionExpiredError as exc:
            await self._finish_run_buffer(
                run_buf, "error", error=("session-expired", str(exc))
            )
            return
        except WorkerError as exc:
            await self._finish_run_buffer(
                run_buf, "error", error=(exc.category, exc.detail)
            )
            return
        except Exception as exc:  # noqa: BLE001 — last-resort
            await self._finish_run_buffer(
                run_buf, "error", error=("internal-error", str(exc))
            )
            return

        await self._finish_run_buffer(run_buf, "completed", result=result)

    async def _finish_run_buffer(
        self,
        run_buf: _RunBuffer,
        state: RunState,
        *,
        result: dict[str, Any] | None = None,
        error: tuple[str, str] | None = None,
    ) -> None:
        async with run_buf.lock:
            run_buf.state = state
            run_buf.result_payload = result
            run_buf.error = error
            run_buf.finished_at = time.monotonic()
            event = {"type": "finished"}
            for q in run_buf.consumers:
                with contextlib.suppress(asyncio.QueueFull):
                    q.put_nowait(event)
        # v3.1 Unit 5c: reconcile the registry record (job_id == run_id) to its
        # terminal status so the activity panel resolves the spinner. Done
        # outside the buffer lock since it touches a different lock (the
        # registry's) and broadcasts.
        self._finish_streaming_job(run_buf, state, error=error)

    async def attach_to_run(
        self,
        session_id: str,
        run_id: str,
        last_seq: int,
    ) -> AsyncIterator[dict[str, Any]]:
        """Attach to a streaming run and yield its events. Replays buffered
        frames after ``last_seq`` (use 0 to receive everything from the
        start), then streams live frames + the final ``done`` or ``error``
        event.

        Yields events shaped:

          {"type": "metadata", "data": {...}}      (always once at start)
          {"type": "frame", "seq": N, "payload": <bytes>}   (one per frame)
          {"type": "done", "result": {...}}        (terminal)
          {"type": "error", "category": "...", "detail": "..."}  (terminal)
          {"type": "resync", "current_seq": N}     (terminal; client must
                                                    re-fetch via batch endpoint)
          {"type": "not_found"}                    (terminal; unknown run_id
                                                    or wrong session)
        """
        run_buf = self._runs.get(run_id)
        if run_buf is None or run_buf.session_id != session_id:
            yield {"type": "not_found"}
            return

        consumer: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10000)
        last_yielded_seq = last_seq

        async with run_buf.lock:
            # Validate the resume request against the buffer's current range.
            if last_seq > 0 and run_buf.frames:
                min_seq = run_buf.frames[0][0]
                max_seq = run_buf.frames[-1][0]
                if last_seq + 1 < min_seq:
                    # Frame last_seq+1 has been evicted from the ring buffer.
                    yield {"type": "resync", "current_seq": max_seq}
                    return

            # Subscribe FIRST so any new frame goes to the queue, then snapshot.
            run_buf.consumers.append(consumer)
            snapshot_metadata = run_buf.metadata
            snapshot_frames = list(run_buf.frames)
            snapshot_state = run_buf.state
            snapshot_result = run_buf.result_payload
            snapshot_error = run_buf.error

        try:
            # Replay metadata (only if we don't already have it; resume after
            # buffered metadata still re-yields it so the client can rebuild
            # its decoder).
            if snapshot_metadata is not None:
                yield {"type": "metadata", "data": snapshot_metadata}

            # Replay buffered frames after last_seq.
            for seq, payload in snapshot_frames:
                if seq > last_seq:
                    yield {"type": "frame", "seq": seq, "payload": payload}
                    last_yielded_seq = seq

            # If the run already finished by the time we attached, yield the
            # terminal event from the snapshot and exit.
            if snapshot_state == "completed":
                yield {"type": "done", "result": snapshot_result}
                return
            if snapshot_state == "error":
                assert snapshot_error is not None
                yield {
                    "type": "error",
                    "category": snapshot_error[0],
                    "detail": snapshot_error[1],
                }
                return

            # Live phase: drain queue. Skip events whose seq we already
            # yielded from the snapshot (race-window dedup).
            while True:
                event = await consumer.get()
                event_type = event.get("type")

                if event_type == "frame":
                    seq = int(event["seq"])
                    if seq <= last_yielded_seq:
                        continue
                    last_yielded_seq = seq
                    yield event
                elif event_type == "metadata":
                    if snapshot_metadata is None:
                        yield event
                elif event_type == "finished":
                    # Re-read run state — _finish_run_buffer set it before
                    # delivering this event.
                    if run_buf.state == "completed":
                        yield {"type": "done", "result": run_buf.result_payload}
                    elif run_buf.state == "error":
                        assert run_buf.error is not None
                        yield {
                            "type": "error",
                            "category": run_buf.error[0],
                            "detail": run_buf.error[1],
                        }
                    return
        finally:
            async with run_buf.lock:
                with contextlib.suppress(ValueError):
                    run_buf.consumers.remove(consumer)

    # ----- sweep orchestration (Unit 18) ----------------------------------

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
            name=f"andes-app-sweep-{sweep_id[:8]}",
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
        """Background task: pumps sweep_progress events from the worker
        pipe into the sweep buffer + connected consumers.

        Lifecycle parity with ``_drive_streaming_run``: send the op +
        loop on data_pipe.recv. Per-iteration ``sweep_progress`` events
        update the buffer's iteration list and any attached consumer
        queues. The terminal ``result`` envelope flips state to
        ``completed`` + clears the session gate.
        """
        loop = asyncio.get_running_loop()

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

        # Send the request from the executor (Pipe.send is sync), then
        # loop on Pipe.recv for sweep_progress envelopes + the final
        # result envelope.
        sweep_args_with_id = {**sweep_args, "sweep_id": sweep_buf.sweep_id}
        try:
            with sess.lock:
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
                        raise WorkerError(
                            "malformed", f"non-dict response: {msg!r}"
                        )
                    return msg

                while True:
                    msg = await _read_one()
                    msg_type = msg.get("type")
                    if msg_type == "sweep_progress":
                        await _on_progress(msg)
                        continue
                    if msg_type == "result":
                        result = msg.get("payload") or {}
                        await self._finish_sweep(
                            sess, sweep_buf, "completed", result=result
                        )
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
        except Exception as exc:  # noqa: BLE001
            await self._finish_sweep(
                sess, sweep_buf, "error", error=("internal-error", str(exc))
            )

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

    # ----- jobs surface (v3.1 Unit 5a) ------------------------------------

    def _require_session(self, session_id: str) -> _Session:
        """Return the live ``_Session`` or raise ``SessionExpiredError``."""
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)
        return sess

    def session_job_registry(self, session_id: str) -> _JobRegistry:
        """Return the session's per-session ``_JobRegistry``.

        The lifecycle hook ``_run_as_job`` (Unit 5a) drives transitions through
        this handle. Raises ``SessionExpiredError`` for an unknown / closed
        session. For session-MUTATING jobs (KTD-20), Unit 5b uses
        ``global_job_registry`` instead.
        """
        return self._require_session(session_id).job_registry

    @property
    def global_job_registry(self) -> _JobRegistry:
        """The manager-wide registry for session-mutating jobs (KTD-20).

        Read-only accessor; the registry's own thread-safe API mutates it.
        Snapshot restore / bundle import / case reload register here in Unit 5b
        so a record survives the session it mutated INTO being replaced.
        """
        return self._global_job_registry

    def list_session_jobs(
        self,
        session_id: str,
        *,
        kind: JobKind | None = None,
        status: JobStatus | None = None,
    ) -> list[JobRecord]:
        """Return the session's jobs for ``GET /sessions/{id}/jobs``.

        Surfaces BOTH the per-session registry AND the manager-wide
        ``_global_job_registry`` (KTD-20): session-mutating jobs (snapshot
        restore, bundle import, case reload) live in the global registry so a
        record survives the session it mutated INTO being replaced, yet must
        still appear in the activity panel of the session that started it.
        Records are returned newest-last by ``started_at`` so the panel scrolls
        in chronological order across both registries.

        Raises ``SessionExpiredError`` for an unknown / closed session.
        """
        sess = self._require_session(session_id)
        records = sess.job_registry.list_jobs(kind=kind, status=status)
        # Only this session's global-registry jobs (filtered by the stamped
        # ``origin_session_id``) — the global registry is manager-wide and
        # blending all sessions' records would leak them cross-session.
        records += [
            r
            for r in self._global_job_registry.list_jobs(kind=kind, status=status)
            if r.origin_session_id == session_id
        ]
        records.sort(key=lambda r: r.started_at)
        return records

    def get_session_job(self, session_id: str, job_id: str) -> JobRecord | None:
        """Return one job for ``GET /sessions/{id}/jobs/{job_id}``.

        Checks the per-session registry first, then the global registry
        (KTD-20). Returns ``None`` when neither holds the id. Raises
        ``SessionExpiredError`` for an unknown / closed session.
        """
        sess = self._require_session(session_id)
        record = sess.job_registry.get_job(job_id)
        if record is not None:
            return record
        # Global registry is manager-wide; only resolve a global job that
        # belongs to THIS session (stamped ``origin_session_id``) so session B
        # can't read session A's session-mutating jobs by id.
        global_record = self._global_job_registry.get_job(job_id)
        if global_record is not None and global_record.origin_session_id == session_id:
            return global_record
        return None

    def cancel_session_job(
        self, session_id: str, job_id: str
    ) -> JobRecord | None:
        """Cancel a job for ``DELETE /sessions/{id}/jobs/{job_id}``.

        Resolves the owning registry (per-session first, then global), calls
        ``mark_cancelled`` (a no-op if the job is already terminal), broadcasts
        the transition to ``/jobs/events`` subscribers, and returns the updated
        record. Returns ``None`` when the job is unknown OR was already terminal
        (the route surfaces that as 404 / a no-longer-cancellable race).

        The route enforces the ``can_cancel`` policy (409 for non-cancellable);
        this method assumes the caller has already decided cancellation is
        permitted.

        For the three genuinely long-lived cancellable kinds — ``tds-stream``,
        ``tds-batch`` (both driven by an in-worker ``run_tds``) and ``sweep`` —
        this ALSO triggers the real abort, not just the record flip: the
        session abort event is set (cooperatively halts ``run_tds`` at the next
        ``callpert`` tick) and the backing ``sweep`` task is cancelled (its
        driver maps ``CancelledError`` → ``aborted`` → ``cancelled``). Without
        this, ``mark_cancelled`` alone would be cosmetic — the worker would run
        to completion while the record falsely reads ``cancelled``.

        Raises ``SessionExpiredError`` for an unknown / closed session.
        """
        sess = self._require_session(session_id)
        registry = sess.job_registry
        if registry.get_job(job_id) is None:
            registry = self._global_job_registry
            global_record = registry.get_job(job_id)
            # Only the owning session may cancel a global (session-mutating)
            # job — otherwise session B could cancel session A's job by id.
            if global_record is None or global_record.origin_session_id != session_id:
                return None

        # Trigger the REAL abort for in-flight long-lived runs before flipping
        # the record, so the cancel affordance actually stops the work.
        target = registry.get_job(job_id)
        if target is not None and target.status in ("pending", "running"):
            if target.kind in ("tds-stream", "tds-batch"):
                # Cooperative abort: set the session abort event. ``run_tds``
                # checks it each ``callpert`` tick and exits early. Setting the
                # multiprocessing Event is non-blocking, safe to call inline.
                with contextlib.suppress(Exception):
                    sess.abort_event.set()
            elif target.kind == "sweep":
                # Cancel the backing sweep task; ``_drive_sweep``'s
                # ``CancelledError`` arm finishes the sweep ``aborted`` and
                # reconciles the record. ``task.cancel()`` is safe from the
                # event loop (the cancel route runs there).
                task = self._sweep_tasks.get(job_id)
                if task is not None and not task.done():
                    task.cancel()

        registry.mark_cancelled(job_id)
        updated = registry.get_job(job_id)
        if updated is None or updated.status != "cancelled":
            # Was already terminal (done/failed/cancelled) — mark_cancelled is
            # a no-op in that case. Treat as "not cancellable any more".
            return None
        self.broadcast_job_event(session_id, updated)
        return updated

    async def subscribe_job_events(
        self, session_id: str
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield this session's live job-event envelopes for the WS handler.

        Each yielded envelope is shaped
        ``{"job_id", "kind", "status", "progress"?, "problem"?}`` — one per
        registry transition (register/running/done/failed/cancelled/progress)
        for any job in the session. Multiple concurrent subscribers each get
        their own queue, so every subscriber receives every broadcast with no
        loss.

        This is a *live* feed — it does not replay history. The WS route sends
        the current job list as an HTTP-style snapshot first (or the client
        GETs ``/jobs``), then opens this stream for subsequent transitions.

        Raises ``SessionExpiredError`` for an unknown / closed session.
        """
        sess = self._require_session(session_id)
        consumer: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10000)
        sess.job_event_subscribers.append(consumer)
        try:
            while True:
                envelope = await consumer.get()
                if envelope.get("__closed__"):
                    # Session was reaped / closed: ``_close_session`` pushed a
                    # terminal sentinel so this awaiting generator unblocks
                    # instead of parking on ``consumer.get()`` forever (a
                    # half-open-socket leak across reaps). The WS handler maps
                    # ``SessionExpiredError`` to a 4404 close.
                    raise SessionExpiredError(
                        f"session {session_id!r} was closed"
                    )
                yield envelope
        finally:
            with contextlib.suppress(ValueError):
                sess.job_event_subscribers.remove(consumer)

    def broadcast_job_event(self, session_id: str, record: JobRecord) -> None:
        """Push a job-transition envelope to every subscriber of the session.

        Synchronous + non-blocking: it never awaits and silently drops on a
        full queue (a subscriber that can't keep up loses live events but can
        re-fetch via ``GET /jobs``). Safe to call from any thread or the event
        loop. A no-op when the session is gone or has no subscribers.

        ``_run_as_job`` (and Unit 5c's streaming/sweep hooks) call this after
        each registry transition so connected activity panels update live.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None:
            return
        envelope = _job_event_envelope(record)
        for queue in list(sess.job_event_subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(dict(envelope))

    # ----- streaming / sweep job registration (v3.1 Unit 5c) --------------

    def register_streaming_job(
        self,
        session_id: str,
        *,
        run_id: str,
        kind: JobKind = "tds-stream",
        request_summary: dict[str, Any] | None = None,
    ) -> str:
        """Register a streaming TDS run as a first-class job (Unit 5c).

        The registry ``job_id`` is aliased onto the caller-minted ``run_id`` —
        the same value is reused so the wire shape gains a ``job_id`` field
        equal to the legacy ``run_id`` with nothing removed. The record is
        created ``pending`` + ``can_cancel=True`` (the run has a cooperative
        abort via the session's abort event) and broadcast to ``/jobs/events``
        subscribers. ``_drive_streaming_run`` flips it running → done / failed.

        A no-op-on-duplicate (returns the existing id) so a resume that re-runs
        ``start_streaming_run`` plumbing never clobbers the live record. Returns
        the ``job_id`` ( == ``run_id``). Silently no-ops when the session is
        already gone.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            return run_id
        sess.job_registry.register_job(
            kind=kind,
            can_cancel=True,
            request_summary=request_summary or {},
            job_id=run_id,
        )
        record = sess.job_registry.get_job(run_id)
        if record is not None:
            self.broadcast_job_event(session_id, record)
        return run_id

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

    def _mark_streaming_job_running(self, run_buf: _RunBuffer) -> None:
        """Flip the streaming run's registry record running + broadcast."""
        with self._registry_lock:
            sess = self._sessions.get(run_buf.session_id)
        if sess is None:
            return
        sess.job_registry.mark_running(run_buf.run_id)
        record = sess.job_registry.get_job(run_buf.run_id)
        if record is not None:
            self.broadcast_job_event(run_buf.session_id, record)

    def _finish_streaming_job(
        self,
        run_buf: _RunBuffer,
        state: RunState,
        *,
        error: tuple[str, str] | None,
    ) -> None:
        """Reconcile the streaming run's registry record to terminal (Unit 5c).

        ``completed`` → ``done``; ``error`` → ``failed`` with a synthesized
        ``ProblemDetails`` built from the ``(category, detail)`` error tuple.
        The ``pending`` / ``running`` states are non-terminal and never reach
        here. Broadcasts the transition. A no-op when the session is gone.
        """
        with self._registry_lock:
            sess = self._sessions.get(run_buf.session_id)
        if sess is None:
            return
        registry = sess.job_registry
        terminal_id = run_buf.run_id
        if state == "completed":
            registry.mark_done(run_buf.run_id)
        elif state == "error":
            # ``mark_failed`` may coalesce into a prior same-signature record
            # (deleting ``run_id``); broadcast the survivor it returns so the
            # terminal transition is not dropped.
            terminal_id = registry.mark_failed(
                run_buf.run_id,
                problem=_stream_error_problem("tds-stream", error),
            )
        record = registry.get_job(terminal_id)
        if record is not None:
            self.broadcast_job_event(run_buf.session_id, record)

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

    # ----- introspection -----

    def list_sessions(self) -> list[str]:
        """Return a snapshot of currently-active session IDs."""
        with self._registry_lock:
            return [s for s, sess in self._sessions.items() if not sess.closed]

    def is_alive(self, session_id: str) -> bool:
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        return sess is not None and not sess.closed and sess.process.is_alive()

    # ----- internals -----

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

    async def _liveness_loop(self) -> None:
        """Background task: every ``JOB_LIVENESS_TICK`` seconds, fail jobs whose
        worker has died (KTD-18). Wraps the per-tick body in a broad guard so a
        single bad sweep never kills the loop."""
        while not self._closed:
            try:
                await asyncio.sleep(JOB_LIVENESS_TICK)
            except asyncio.CancelledError:
                return
            try:
                self.sweep_dead_worker_jobs()
            except Exception:  # noqa: BLE001 — the loop must outlive any one tick
                log.exception("job-liveness sweep tick failed")

    def sweep_dead_worker_jobs(self) -> int:
        """One liveness pass (KTD-18). Returns the number of jobs failed.

        Iterates ONLY sessions that have at least one ``running`` job (idle
        sessions are skipped so cost is proportional to active work). For each
        ``running`` job whose worker process is not alive, marks it ``failed``
        with a synthesized ``WorkerDied`` ``ProblemDetails`` and broadcasts the
        transition to any ``/jobs/events`` subscribers. Also scans the
        manager-wide global registry (session-mutating jobs, KTD-20) and
        orphans ``running`` records whose originating session's worker is dead
        — the per-session pass never sees those because they live in the
        global registry.

        Exposed (not just the 10 s loop) so tests can drive a single tick
        deterministically without shortening the interval or sleeping.
        """
        with self._registry_lock:
            sessions = list(self._sessions.items())
        sessions_by_id = dict(sessions)

        def _worker_dead(session_id: str | None) -> bool:
            """True when the session is gone/closed or its worker is not alive."""
            if session_id is None:
                return False
            sess = sessions_by_id.get(session_id)
            if sess is None or sess.closed:
                return True
            return not (sess.process is not None and sess.process.is_alive())

        failed = 0
        for session_id, sess in sessions:
            if sess.closed:
                continue
            running = sess.job_registry.list_jobs(status="running")
            if not running:
                # Skip idle sessions entirely — the common case.
                continue
            if sess.process is not None and sess.process.is_alive():
                # Worker is healthy; its running jobs are legitimately in
                # flight. Nothing to fail.
                continue
            # Worker is dead (or absent) but the session still carries
            # ``running`` jobs — orphan them so the activity panel reflects
            # reality instead of a spinner that never resolves.
            for job in running:
                problem = _worker_died_problem(job)
                survivor_id = sess.job_registry.mark_failed(job.id, problem=problem)
                updated = sess.job_registry.get_job(survivor_id)
                if updated is not None:
                    self.broadcast_job_event(session_id, updated)
                failed += 1

        # Global-registry pass (KTD-20): session-mutating jobs live here, so the
        # per-session loop above never inspects them. Orphan any ``running``
        # global record whose originating session's worker has died.
        for job in self._global_job_registry.list_jobs(status="running"):
            origin = job.origin_session_id
            if not _worker_dead(origin):
                continue
            problem = _worker_died_problem(job)
            survivor_id = self._global_job_registry.mark_failed(job.id, problem=problem)
            updated = self._global_job_registry.get_job(survivor_id)
            if updated is not None and origin is not None:
                self.broadcast_job_event(origin, updated)
            failed += 1
        return failed


def _streaming_request_summary(args: dict[str, Any]) -> dict[str, Any]:
    """User-facing variables captured for a streaming-TDS job's retry (Unit 5c).

    Mirrors the routine routes' ``request.model_dump()`` summaries: the fields a
    Retry button (Unit 11) would replay. Internal plumbing flags (``stream``)
    are dropped; only the user-meaningful run parameters are kept.
    """
    summary: dict[str, Any] = {}
    for key in ("tf", "h", "integrator", "decimation", "max_rate_hz", "vars"):
        if key in args and args[key] is not None:
            summary[key] = args[key]
    if args.get("tds_config_overrides") is not None:
        summary["tds_config_overrides"] = args["tds_config_overrides"]
    return summary


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


def _stream_error_problem(
    kind: JobKind, error: tuple[str, str] | None
) -> dict[str, Any]:
    """Synthesize a ``ProblemDetails`` for a failed streaming / sweep job.

    Built from the driver's ``(category, detail)`` error tuple so the failed
    record carries the same diagnostic the WS terminal ``error`` frame ships.
    Falls back to an indeterminate ``internal-error`` when the tuple is absent.
    """
    category, detail = error if error is not None else ("internal-error", "")
    return {
        "type": "about:blank",
        "title": "Internal Server Error",
        "status": 500,
        "category": category,
        "detail": detail,
        "recovery": None,
    }


def _worker_died_problem(record: JobRecord) -> dict[str, Any]:
    """Synthesize the ``WorkerDied`` ProblemDetails for an orphaned job."""
    return {
        "type": "about:blank",
        "title": "Internal Server Error",
        "status": 500,
        "category": WORKER_DIED_CATEGORY,
        "detail": (
            f"the worker process for the {record.kind} job died while the "
            "job was still running; the session must be recreated"
        ),
        "recovery": None,
    }


__all__ = [
    "SessionExpiredError",
    "SessionManager",
    "SweepInProgressError",
    "WorkerDiedError",
    "WorkerError",
]


# Type aliases that downstream modules can import without re-typing
SessionInvoke = Callable[..., Awaitable[Any]]
