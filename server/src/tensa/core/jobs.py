"""Per-session in-memory job registry — Unit 1 of v3.1 UX overhaul.

The registry tracks every routine invocation (PF, EIG, CPF, SE, snapshots,
bundles, clone edits, etc.) with a stable ``job_id``, lifecycle status,
started/ended timestamps, and an optional ``ProblemDetails`` dict on failure.

Retention is *semantic*, not pure-FIFO (KTD-19 of the v3.1 plan; sticky-first
failures motivated by the adversarial review):

- Never evict ``pending`` or ``running`` jobs.
- ``mark_failed`` coalesces duplicates by ``(kind, category, detail)``
  signature: a fresh failure matching an existing record collapses into
  that record (the first-occurrence ``started_at`` and problem dict are
  preserved; ``repeated_count`` increments). This defends against cascade
  context loss (failure #1 holds the diagnostic; #21 is the symptom — FIFO
  would silently drop the diagnostic).
- Among successful jobs, FIFO eviction at ``MAX_SUCCESSFUL`` keeps the
  most recent.
- Combined ring buffer caps at ``MAX_TOTAL``; on overflow, oldest terminal
  records evict first, in-flight records are never touched.

The registry is thread-safe (a single ``threading.Lock`` guards every
mutation). All reads return defensive copies so callers can't mutate
internal state through a returned reference.

This module is read-only with respect to the rest of the substrate: no
worker, no FastAPI, no ANDES. Unit 5a (Phase 2) adds the ``/jobs`` routes
that expose the registry over HTTP + WS.
"""

from __future__ import annotations

import threading
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any, Literal

JobKind = Literal[
    # routines
    "pflow",
    "tds-batch",
    "tds-stream",
    "eig",
    "cpf",
    "cpf-qv",
    "se",
    "se-measurements",
    "sweep",
    # state ops
    "snapshot-save",
    "snapshot-restore",
    "snapshot-delete",
    "bundle-export",
    "bundle-import",
    "case-load",
    "case-reload",
    "case-save",
    # edits + addfile
    "element-add",
    "element-edit",
    "element-delete",
    "element-undo",
    "disturbance-commit",
    "pmu-add",
    "pmu-delete",
    "profile-upload",
    "profile-add",
    "profile-delete",
    # clone-on-write (Phase 6)
    "clone-init",
    "clone-edit",
    "clone-undo",
    "clone-redo",
    "clone-save-as",
    "clone-reset",
]


JobStatus = Literal["pending", "running", "done", "failed", "cancelled"]


# Retention knobs (KTD-19). Distinct-failure cap defends against cascade
# context loss; successful FIFO is the "rolling history" the activity panel
# scrolls through; total cap is the safety net.
MAX_FAILED_DISTINCT: int = 20
MAX_SUCCESSFUL: int = 50
MAX_TOTAL: int = 100


@dataclass
class JobRecord:
    """One job's lifecycle row.

    Returned via ``_JobRegistry.get_job`` / ``list_jobs`` as a defensive
    copy; mutating a returned record does not affect the registry.
    """

    id: str
    kind: JobKind
    status: JobStatus
    started_at: float
    updated_at: float
    can_cancel: bool
    request_summary: dict[str, Any] = field(default_factory=dict)
    progress: float | None = None
    ended_at: float | None = None
    result_ref: str | None = None
    problem: dict[str, Any] | None = None
    # Sticky-first coalescing counter. A fresh failure whose signature
    # matches this record bumps the count rather than displacing the
    # first-occurrence diagnostic.
    repeated_count: int = 0
    # Originating session id. Stamped on records that live in the manager-wide
    # global registry (session-mutating jobs, KTD-20) so the per-session HTTP
    # surface can filter the shared registry to the owning session — otherwise
    # every session's ``GET /jobs`` would leak every other session's global
    # jobs. ``None`` for per-session-registry records (no filtering needed
    # there — the registry is already session-scoped). Internal: NOT serialized
    # onto the wire ``JobRecordSchema`` (which only declares its own fields).
    origin_session_id: str | None = None


def _failure_signature(record: JobRecord) -> tuple[str, str, str] | None:
    """Stable signature for a failed job's error.

    Two records with the same ``(kind, category, detail)`` are treated
    as repeats of the same underlying problem. Returns ``None`` for
    records that aren't ``failed``.
    """
    if record.status != "failed" or record.problem is None:
        return None
    category = str(record.problem.get("category") or "")
    detail = str(record.problem.get("detail") or "")
    return (record.kind, category, detail)


class _JobRegistry:
    """Per-session in-memory job log."""

    def __init__(self) -> None:
        self._records: dict[str, JobRecord] = {}
        self._lock = threading.Lock()

    def register_job(
        self,
        *,
        kind: JobKind,
        can_cancel: bool,
        request_summary: dict[str, Any] | None = None,
        job_id: str | None = None,
        origin_session_id: str | None = None,
    ) -> str:
        """Register a fresh ``pending`` job. Returns the new ``job_id``.

        ``job_id`` defaults to a freshly-minted uuid. v3.1 Unit 5c passes an
        explicit id so the streaming-TDS / sweep jobs can alias the registry
        ``job_id`` onto the pre-existing ``run_id`` / ``sweep_id`` (same value
        across both fields). Re-registering an already-present id is a no-op
        that returns the existing id rather than clobbering its lifecycle.

        ``origin_session_id`` stamps the owning session onto the record. It is
        passed for records that land in the manager-wide global registry
        (session-mutating jobs) so the per-session HTTP surface can filter the
        shared registry to its own session.
        """
        now = time.monotonic()
        if job_id is None:
            job_id = str(uuid.uuid4())
        with self._lock:
            if job_id in self._records:
                return job_id
            self._records[job_id] = JobRecord(
                id=job_id,
                kind=kind,
                status="pending",
                started_at=now,
                updated_at=now,
                can_cancel=can_cancel,
                request_summary=dict(request_summary or {}),
                origin_session_id=origin_session_id,
            )
            self._evict_if_over_cap()
        return job_id

    def mark_running(self, job_id: str) -> None:
        with self._lock:
            record = self._records.get(job_id)
            if record is None or record.status != "pending":
                return
            record.status = "running"
            record.updated_at = time.monotonic()

    def mark_done(self, job_id: str, *, result_ref: str | None = None) -> None:
        with self._lock:
            record = self._records.get(job_id)
            if record is None or record.status in ("done", "failed", "cancelled"):
                return
            now = time.monotonic()
            record.status = "done"
            record.result_ref = result_ref
            record.updated_at = now
            record.ended_at = now
            self._evict_if_over_cap()

    def mark_failed(self, job_id: str, *, problem: dict[str, Any]) -> str:
        """Mark the job failed and apply sticky-first signature coalescing.

        Returns the ``job_id`` of the SURVIVING record — equal to the passed
        ``job_id`` normally, or (on coalescing) the id of the PRIOR record the
        failure collapsed into. Callers MUST broadcast the RETURNED id (not the
        passed one) so the live ``/jobs/events`` feed always reflects the
        transition: when the passed id is coalesced away the surviving prior
        record (with its bumped ``repeated_count``) is the authoritative one,
        and re-reading the deleted passed id would yield ``None`` → a dropped
        terminal envelope leaving WS-only panels spinning forever.

        If an existing failed record shares this record's
        ``(kind, category, detail)`` signature, the new record is
        discarded and the prior record's ``repeated_count`` is
        incremented (preserving the original ``started_at`` and problem
        dict so the diagnostic isn't lost).

        A no-op (returns the passed ``job_id``) when the record is already
        terminal — guarding against a post-cancel driver error flipping a
        ``cancelled`` / ``done`` record back to ``failed`` (the cancel path
        does NOT abort the underlying work synchronously, so a late driver
        error can race the cancel transition).
        """
        with self._lock:
            record = self._records.get(job_id)
            if record is None:
                return job_id
            if record.status in ("done", "failed", "cancelled"):
                # Already terminal: do not overwrite. Symmetric with
                # ``mark_done`` / ``mark_cancelled``; closes the race where a
                # late driver error flips a ``cancelled`` record to ``failed``.
                return job_id
            now = time.monotonic()
            record.problem = dict(problem)
            record.status = "failed"
            record.updated_at = now
            record.ended_at = now
            signature = _failure_signature(record)
            survivor_id = job_id
            if signature is not None:
                for prior_id, prior in list(self._records.items()):
                    if prior_id == job_id:
                        continue
                    if _failure_signature(prior) == signature:
                        prior.repeated_count += 1
                        prior.updated_at = now
                        del self._records[job_id]
                        # The prior record is the survivor; callers broadcast
                        # it so the coalesced failure still reaches subscribers.
                        survivor_id = prior_id
                        break
            self._evict_if_over_cap()
        return survivor_id

    def mark_cancelled(self, job_id: str) -> None:
        with self._lock:
            record = self._records.get(job_id)
            if record is None or record.status in ("done", "failed", "cancelled"):
                return
            now = time.monotonic()
            record.status = "cancelled"
            record.updated_at = now
            record.ended_at = now
            self._evict_if_over_cap()

    def update_progress(self, job_id: str, progress: float) -> None:
        """Update an in-flight job's progress. Clamps to ``[0.0, 1.0]``;
        no-op when the job is terminal."""
        clamped = max(0.0, min(1.0, progress))
        with self._lock:
            record = self._records.get(job_id)
            if record is None or record.status not in ("pending", "running"):
                return
            record.progress = clamped
            record.updated_at = time.monotonic()

    def get_job(self, job_id: str) -> JobRecord | None:
        with self._lock:
            record = self._records.get(job_id)
            if record is None:
                return None
            return _copy_record(record)

    def list_jobs(
        self,
        *,
        kind: JobKind | None = None,
        status: JobStatus | None = None,
    ) -> list[JobRecord]:
        """Return jobs matching the optional filters, in insertion order."""
        with self._lock:
            out: list[JobRecord] = []
            for record in self._records.values():
                if kind is not None and record.kind != kind:
                    continue
                if status is not None and record.status != status:
                    continue
                out.append(_copy_record(record))
            return out

    def _evict_if_over_cap(self) -> None:
        """Apply KTD-19 retention. Must be called with ``self._lock`` held.

        Sequence (each step preserves the never-evict-in-flight invariant):

        1. Among ``done`` records, evict oldest until ``MAX_SUCCESSFUL``.
        2. Among ``failed`` records, evict oldest until ``MAX_FAILED_DISTINCT``.
           (Sticky-first coalescing in ``mark_failed`` already collapses
           duplicates by signature, so this only fires when ≥21 distinct
           error signatures have accumulated.)
        3. If the overall record count still exceeds ``MAX_TOTAL``, evict
           the oldest terminal records (any bucket) until at cap.
        """
        done_ids = [k for k, r in self._records.items() if r.status == "done"]
        if len(done_ids) > MAX_SUCCESSFUL:
            for stale in done_ids[: len(done_ids) - MAX_SUCCESSFUL]:
                del self._records[stale]

        failed_ids = [k for k, r in self._records.items() if r.status == "failed"]
        if len(failed_ids) > MAX_FAILED_DISTINCT:
            for stale in failed_ids[: len(failed_ids) - MAX_FAILED_DISTINCT]:
                del self._records[stale]

        if len(self._records) > MAX_TOTAL:
            terminal_ids = [
                k
                for k, r in self._records.items()
                if r.status in ("done", "failed", "cancelled")
            ]
            overflow = len(self._records) - MAX_TOTAL
            for stale in terminal_ids[:overflow]:
                del self._records[stale]


def _copy_record(record: JobRecord) -> JobRecord:
    return JobRecord(
        id=record.id,
        kind=record.kind,
        status=record.status,
        started_at=record.started_at,
        updated_at=record.updated_at,
        can_cancel=record.can_cancel,
        request_summary=deepcopy(record.request_summary),
        progress=record.progress,
        ended_at=record.ended_at,
        result_ref=record.result_ref,
        problem=deepcopy(record.problem) if record.problem else None,
        repeated_count=record.repeated_count,
        origin_session_id=record.origin_session_id,
    )
