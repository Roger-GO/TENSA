"""The jobs surface: what the routes read of the job registries, and the live feed of
their transitions."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from typing import Any

from tensa.core.jobs import JobKind, JobRecord, JobStatus, _JobRegistry
from tensa.core.session.base import SessionManagerBase
from tensa.core.session.errors import WORKER_DIED_CATEGORY, SessionExpiredError

log = logging.getLogger("tensa.session")

# v3.1 Unit 5a: tick for the job-liveness sweeper (KTD-18). Every tick the
# sweeper scans sessions that have at least one ``running`` job and marks any
# whose worker process has died as ``failed`` (category ``WorkerDied``). 10 s
# keeps the cost proportional to active work while bounding how long a job can
# sit ``running`` against a dead worker before the activity panel reflects it.
JOB_LIVENESS_TICK = 10.0


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


class JobsMixin(SessionManagerBase):
    """The per-session registries and the manager-wide one as ``/jobs`` reads them,
    cancelling a job, the live feed of job transitions (``/jobs/events``), and the
    sweeper that fails the jobs of a worker that has died."""

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
