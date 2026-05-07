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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

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
    (Unit 4 / Unit 5)."""

    def __init__(self, category: str, detail: str) -> None:
        super().__init__(f"{category}: {detail}")
        self.category = category
        self.detail = detail


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
    ) -> None:
        self._max_sessions = max_sessions
        self._idle_timeout = idle_timeout
        self._sessions: dict[str, _Session] = {}
        self._registry_lock = threading.Lock()
        self._reaper_task: asyncio.Task[None] | None = None
        self._closed = False
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
            args=(child_ctrl, child_data, abort_event),
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
            )
        return response.get("payload")

    async def signal_abort(self, session_id: str) -> None:
        """Set the worker's abort event. Cooperatively terminates an active
        ``run_tds`` invocation. No-op if no TDS is running."""
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise SessionExpiredError(f"session {session_id!r} is not active")
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, sess.abort_event.set)

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
        sessions and close them."""
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


__all__ = [
    "SessionExpiredError",
    "SessionManager",
    "WorkerError",
]


# Type aliases that downstream modules can import without re-typing
SessionInvoke = Callable[..., Awaitable[Any]]
