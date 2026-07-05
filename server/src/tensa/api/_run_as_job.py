r"""``_run_as_job`` — the per-routine job-lifecycle context manager (v3.1 Unit 5a).

This is the migration target Unit 5b wraps every routine route's
``mgr.invoke`` call in::

    async with _run_as_job(mgr, session_id, "pflow", request.model_dump()) as job_id:
        result = await mgr.invoke(session_id, "run_pflow", ...)
        return {**result, "job_id": job_id}

It drives the registry lifecycle around the wrapped block:

    register_job(pending) -> mark_running -> mark_done       (success)
                                          \-> mark_failed     (exception)

and broadcasts the per-session ``/jobs/events`` WS envelope on each
transition so connected activity panels update live.

Scope (feasibility F3): ``_run_as_job`` covers ``mgr.invoke`` ONLY. Streaming
TDS (``start_streaming_run``) and sweeps (``start_sweep``) are long-lived
background tasks whose ``mark_done`` / ``mark_failed`` fire from their own
drivers; Unit 5c wires those via ``register_streaming_job`` /
``register_sweep_job``. Do NOT wrap those calls in this context manager.

Exception handling (adversarial F4): the catch clause is ``except Exception``,
NOT ``BaseException``. ``KeyboardInterrupt`` / ``SystemExit`` /
``asyncio.CancelledError`` are deliberately left to propagate untouched for the
server's lifecycle handling. On a caught ``Exception`` we synthesize a 500
``ProblemDetails`` (category ``WorkerInternalError``, ``detail=str(exc)``),
``mark_failed`` the job, broadcast the transition, THEN re-raise. This closes
the "stuck ``running`` because the exception escaped the registry transitions"
trap that the liveness sweeper would NOT catch — the worker is still alive (it
raised and returned to idle), so the dead-worker check never fires.
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from tensa.api.error_mapping import WORKER_ERROR_HTTP_MAP
from tensa.core.errors import WorkerDiedError
from tensa.core.session import WORKER_DIED_CATEGORY, WorkerError

if TYPE_CHECKING:
    from tensa.core.jobs import JobKind, _JobRegistry
    from tensa.core.session import SessionManager

# Wire category stamped onto the synthesized ProblemDetails when a NON-WorkerError
# exception escapes the wrapped block. Distinct from the liveness sweeper's
# ``WorkerDied`` (the worker is alive here; it raised).
WORKER_INTERNAL_CATEGORY = "WorkerInternalError"


def _internal_error_problem(kind: JobKind, exc: Exception) -> dict[str, Any]:
    """Synthesize the ProblemDetails for an exception escaping the block.

    For a :class:`WorkerError` the record carries the REAL ``category`` and the
    mapped HTTP status (e.g. ``no-case-loaded`` → 409, ``ElementHasDependentsError``
    → 422) so the activity-panel failure log and the failure-signature
    coalescing key off the true error, not a blanket ``WorkerInternalError``/500.
    A business-conflict like a blocked delete is thus recorded as its own 422
    category rather than masquerading as a 500 server error. Everything else
    (genuinely unexpected exceptions) keeps the synthesized 500.
    """
    if isinstance(exc, WorkerDiedError):
        # The worker subprocess crashed mid-RPC (torn pipe). Stamp the same
        # ``WorkerDied`` category + 503 + ``reload-case`` recovery the HTTP
        # handler returns so the activity-panel failure record matches the
        # response the user sees, rather than masquerading as a generic 500.
        return {
            "type": "about:blank",
            "title": "Service Unavailable",
            "status": 503,
            "category": WORKER_DIED_CATEGORY,
            "detail": exc.detail,
            "recovery": {"kind": "reload-case", "label": "Reload the case"},
        }
    if isinstance(exc, WorkerError):
        category = exc.category or WORKER_INTERNAL_CATEGORY
        http_status = WORKER_ERROR_HTTP_MAP.get(category, 500)
        return {
            "type": "about:blank",
            "title": "Internal Server Error" if http_status >= 500 else "Request Failed",
            "status": http_status,
            "category": category,
            "detail": exc.detail,
            "recovery": None,
        }
    return {
        "type": "about:blank",
        "title": "Internal Server Error",
        "status": 500,
        "category": WORKER_INTERNAL_CATEGORY,
        "detail": str(exc),
        "recovery": None,
    }


@contextlib.asynccontextmanager
async def _run_as_job(
    mgr: SessionManager,
    session_id: str,
    kind: JobKind,
    request_summary: dict[str, Any] | None = None,
    *,
    can_cancel: bool = False,
    result_ref: str | None = None,
    use_global_registry: bool = False,
) -> AsyncIterator[str]:
    """Register a job, run the wrapped block, and drive its lifecycle.

    Yields the new ``job_id``. The block performs the actual ``mgr.invoke``.

    - On normal exit: ``mark_done`` (with ``result_ref`` if supplied).
    - On a caught ``Exception``: ``mark_failed`` with a synthesized 500
      ``ProblemDetails`` then re-raise. ``BaseException`` (KeyboardInterrupt /
      SystemExit / CancelledError) propagates WITHOUT marking the job — those
      are lifecycle signals, not job failures.

    Every transition (running / done / failed) is broadcast to the session's
    ``/jobs/events`` subscribers via ``mgr.broadcast_job_event``.

    ``can_cancel`` defaults to ``False`` because every ``mgr.invoke`` routine
    is synchronous from the caller's view (PF / EIG / CPF / SE) — the cancel
    affordance belongs to streaming / sweep jobs (Unit 5c). Pass ``True`` only
    if a future invoke-backed job grows a cooperative-abort path.

    ``use_global_registry`` (KTD-20) routes the record into the manager-wide
    ``global_job_registry`` rather than the per-session registry. Session-
    MUTATING jobs — snapshot restore, bundle import, case reload — set this so
    the record survives the session it mutated INTO being replaced. The record
    still surfaces in the originating session's activity panel because
    ``list_session_jobs`` / ``get_session_job`` span both registries; the WS
    broadcast targets the same ``session_id`` either way.
    """
    registry = (
        mgr.global_job_registry
        if use_global_registry
        else mgr.session_job_registry(session_id)
    )
    # Stamp the originating session onto global-registry records so the
    # per-session HTTP surface (list/get/cancel) can filter the shared registry
    # to this session — otherwise every session would see (and be able to
    # cancel) every other session's session-mutating jobs (cross-session leak).
    job_id = registry.register_job(
        kind=kind,
        can_cancel=can_cancel,
        request_summary=request_summary or {},
        origin_session_id=session_id if use_global_registry else None,
    )
    _broadcast(mgr, session_id, registry, job_id)

    registry.mark_running(job_id)
    _broadcast(mgr, session_id, registry, job_id)

    try:
        yield job_id
    except Exception as exc:
        # NOT BaseException — preserve KeyboardInterrupt / SystemExit /
        # asyncio.CancelledError for the server's lifecycle handling. Marking
        # failed here is what keeps the job from being stuck ``running`` when
        # the exception escapes; the liveness sweeper would NOT catch it (the
        # worker is alive — it raised and returned to idle).
        # ``mark_failed`` may coalesce this failure into a prior same-signature
        # record (deleting THIS job_id); broadcast the SURVIVOR it returns so
        # the terminal transition still reaches WS subscribers instead of being
        # dropped (a re-read of the deleted id would yield None).
        problem = _internal_error_problem(kind, exc)
        # Snapshot the (still-``running``) record BEFORE mark_failed coalesces it
        # away, so we can synthesize a terminal envelope for THIS id if it gets
        # deleted. Without this, a client that saw ``job_id`` go ``running`` over
        # the WS would never hear it reach a terminal state when the failure is
        # coalesced into a prior id (the survivor is broadcast under a DIFFERENT
        # id) — its in-flight activity pill then spins forever (the "load case
        # stuck running" bug for a repeated same-signature failure).
        pre = registry.get_job(job_id)
        survivor_id = registry.mark_failed(job_id, problem=problem)
        if survivor_id != job_id and pre is not None:
            pre.status = "failed"
            pre.problem = problem
            pre.ended_at = pre.updated_at = time.monotonic()
            mgr.broadcast_job_event(session_id, pre)
        _broadcast(mgr, session_id, registry, survivor_id)
        raise
    else:
        registry.mark_done(job_id, result_ref=result_ref)
        _broadcast(mgr, session_id, registry, job_id)


def _broadcast(
    mgr: SessionManager,
    session_id: str,
    registry: _JobRegistry,
    job_id: str,
) -> None:
    """Broadcast the current state of ``job_id`` to the session's WS subscribers.

    Re-reads the record from its owning ``registry`` (the registry coalesces
    failures by signature, so the post-transition record is the authoritative
    one) and pushes its envelope to the originating session's subscribers. A
    no-op when the record has been coalesced away.
    """
    record = registry.get_job(job_id)
    if record is not None:
        mgr.broadcast_job_event(session_id, record)
