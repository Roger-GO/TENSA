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
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from andes_app.core.jobs import JobKind, _JobRegistry
    from andes_app.core.session import SessionManager

# Wire category stamped onto the synthesized ProblemDetails when an exception
# escapes the wrapped block. Distinct from the liveness sweeper's
# ``WorkerDied`` (the worker is alive here; it raised).
WORKER_INTERNAL_CATEGORY = "WorkerInternalError"


def _internal_error_problem(kind: JobKind, exc: Exception) -> dict[str, Any]:
    """Synthesize the 500 ProblemDetails for an exception escaping the block."""
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
    job_id = registry.register_job(
        kind=kind,
        can_cancel=can_cancel,
        request_summary=request_summary or {},
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
        registry.mark_failed(job_id, problem=_internal_error_problem(kind, exc))
        _broadcast(mgr, session_id, registry, job_id)
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
