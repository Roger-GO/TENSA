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
import multiprocessing as mp
import threading
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from andes_app.core.errors import AndesAppError
from andes_app.core.worker import worker_main

# Default tick for the idle-reaper background task. Smaller = more responsive
# reaping but more wakeups; larger = laggier reaping. 5 s is a fine balance for
# a default 180 s idle timeout.
IDLE_REAP_TICK = 5.0


class SessionExpiredError(AndesAppError):
    """Raised when a caller references a session that has been reaped or
    never existed."""


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
    lock: threading.Lock = field(default_factory=threading.Lock)
    seq: int = 0
    last_active: float = field(default_factory=time.monotonic)
    closed: bool = False


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
        self._closed = False
        # Streaming runs keyed by run_id. Each run's frames + metadata + final
        # state live here for the resume window even after the WS disconnects.
        self._runs: dict[str, _RunBuffer] = {}
        # Background tasks for currently-running streaming runs. We keep
        # references so they aren't garbage-collected mid-run.
        self._run_tasks: dict[str, asyncio.Task[None]] = {}
        # ``spawn`` (vs. fork) is the safe default: ANDES uses numpy/scipy/sympy
        # which are not always fork-safe (BLAS thread pools, signal handlers).
        # ``spawn`` re-imports cleanly per worker.
        # ``Any`` annotation works around incomplete BaseContext stubs (the
        # context exposes Process / Pipe / Event at runtime but mypy's
        # typeshed entry can be narrower than reality on some versions).
        self._spawn_ctx: Any = mp.get_context(spawn_method)

    # ----- lifecycle -----

    async def start(self) -> None:
        """Start the background reaper task. Idempotent."""
        if self._reaper_task is None or self._reaper_task.done():
            self._reaper_task = asyncio.create_task(
                self._reap_loop(), name="session-reaper"
            )

    async def shutdown(self) -> None:
        """Reap all sessions and stop the reaper task. Safe to call multiple times."""
        self._closed = True
        if self._reaper_task is not None:
            self._reaper_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reaper_task
            self._reaper_task = None

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
            args=(child_ctrl, child_data, abort_event, self._workspace),
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

    # ----- request/response -----

    async def invoke(
        self,
        session_id: str,
        op: str,
        args: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        """Send an op to the session's worker and await the response.

        One in-flight invocation per session at a time (per-session
        ``Lock``). Raises:

        - ``SessionExpiredError`` if the session was reaped or never existed.
        - ``WorkerError`` if the worker returned a structured error response.
        - ``asyncio.TimeoutError`` if ``timeout`` is set and exceeded.
        """
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise SessionExpiredError(f"session {session_id!r} is not active")

        loop = asyncio.get_running_loop()

        def _rpc() -> Any:
            with sess.lock:
                sess.seq += 1
                sess.last_active = time.monotonic()
                seq = sess.seq
                sess.ctrl.send({"op": op, "args": args or {}, "seq": seq})
                response = sess.data.recv()
                sess.last_active = time.monotonic()
                return response

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
            raise SessionExpiredError(f"session {session_id!r} is not active")

        loop = asyncio.get_running_loop()

        # Send the request from the executor (Pipe.send is sync); then loop
        # on Pipe.recv (also sync) on the executor for each frame, dispatching
        # callbacks back on the running loop.
        with sess.lock:
            sess.seq += 1
            sess.last_active = time.monotonic()
            seq = sess.seq
            await loop.run_in_executor(
                None,
                lambda: sess.ctrl.send({"op": op, "args": args or {}, "seq": seq}),
            )

            async def _read_one() -> dict[str, Any]:
                msg = await loop.run_in_executor(None, sess.data.recv)
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
            raise SessionExpiredError(f"session {session_id!r} is not active")
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
            raise SessionExpiredError(f"session {session_id!r} is not active")

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


__all__ = [
    "SessionExpiredError",
    "SessionManager",
    "WorkerError",
]


# Type aliases that downstream modules can import without re-typing
SessionInvoke = Callable[..., Awaitable[Any]]
