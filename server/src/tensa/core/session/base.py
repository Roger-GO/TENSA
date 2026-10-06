"""The state the session manager's parts share, and the bookkeeping of one session."""

from __future__ import annotations

import asyncio
import multiprocessing as mp
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from tensa.core.jobs import _JobRegistry
from tensa.core.messages import MessageLog
from tensa.core.session.buffers import _RunBuffer, _SweepBuffer
from tensa.core.session.errors import SessionExpiredError
from tensa.core.sweep import default_sweep_workers


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
    # What ANDES logged while this session's worker ran commands, as the worker
    # attached it to its replies (see ``tensa.core.messages``). Filled by
    # ``_absorb_log`` wherever a reply is read; read by ``GET /sessions/{id}/messages``.
    messages: MessageLog = field(default_factory=MessageLog)


class SessionManagerBase:
    """The state every part of the session manager shares, and the two lookups the
    parts begin with: the error for a session that is gone, and the live session
    for an id.

    The parts live in the sibling modules as mixins over this class;
    ``SessionManager`` (``tensa.core.session``) puts them together."""

    def __init__(
        self,
        *,
        max_sessions: int = 4,
        idle_timeout: float = 180.0,
        spawn_method: str = "spawn",
        workspace: str | None = None,
        sweep_workers: int | None = None,
    ) -> None:
        if sweep_workers is not None and sweep_workers < 1:
            raise ValueError(f"sweep_workers must be at least 1, got {sweep_workers}")
        self._max_sessions = max_sessions
        self._idle_timeout = idle_timeout
        self._workspace = workspace  # for the worker's strict-fs audit hook
        # The most sub-workers one sweep may spread its iterations over (see
        # ``sweep_worker_count``); 1 runs every sweep on the session's own worker.
        # It is per sweep: sweeps in several sessions at once add up.
        self._sweep_workers = default_sweep_workers() if sweep_workers is None else sweep_workers
        self._sessions: dict[str, _Session] = {}
        self._registry_lock = threading.Lock()
        self._reaper_task: asyncio.Task[None] | None = None
        # v3.1 Unit 5a: job-liveness sweeper task (KTD-18). Started alongside
        # the reaper in ``start`` and cancelled in ``shutdown``.
        self._liveness_task: asyncio.Task[None] | None = None
        self._closed = False
        # The startup sweep of abandoned ``.sessions/`` dirs runs once, in ``start``.
        self._scratch_swept = False
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

    def _require_session(self, session_id: str) -> _Session:
        """Return the live ``_Session`` or raise ``SessionExpiredError``."""
        with self._registry_lock:
            sess = self._sessions.get(session_id)
        if sess is None or sess.closed:
            raise self._session_expired_error(session_id, sess)
        return sess
