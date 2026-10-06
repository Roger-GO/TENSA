"""A job of the activity panel: ``GET /sessions/{id}/jobs`` and the jobs WebSocket."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from tensa.api.schemas.errors import ProblemDetails
from tensa.core.jobs import JobKind as JobKindLiteral
from tensa.core.jobs import JobStatus as JobStatusLiteral

# Re-exported aliases so OpenAPI consumers can reference these by name.
# The substrate's authoritative types live in ``core/jobs.py``.
JobKindSchema = JobKindLiteral


JobStatusSchema = JobStatusLiteral


class JobRecordSchema(BaseModel):
    """HTTP-visible shape of a ``_JobRegistry`` record.

    Returned by ``GET /sessions/{id}/jobs`` and ``GET /sessions/{id}/jobs/{job_id}``.
    Every routine response also embeds a ``job_id`` that resolves to one of
    these records.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        ...,
        description="Server-generated UUID identifier for the job.",
    )
    kind: JobKindLiteral = Field(
        ...,
        description=(
            "Discriminator for the routine kind (``pflow``, ``tds-stream``, "
            "``eig``, ``cpf``, ``cpf-qv``, ``se``, ``sweep``, ``snapshot-*``, "
            "``bundle-*``, ``element-*``, ``clone-*``, etc.). The full enum "
            "lives in ``tensa.core.jobs.JobKind``."
        ),
    )
    status: JobStatusLiteral = Field(
        ...,
        description=(
            "Lifecycle state: ``pending`` (registered), ``running`` (worker "
            "actively executing), ``done`` (completed successfully), "
            "``failed`` (worker raised; ``problem`` populated), or "
            "``cancelled`` (cooperative-abort succeeded)."
        ),
    )
    started_at: float = Field(
        ...,
        description=(
            "Monotonic clock seconds when the job was registered. Use "
            "differences between ``started_at`` / ``updated_at`` / "
            "``ended_at`` for elapsed-time display."
        ),
    )
    updated_at: float = Field(
        ...,
        description="Monotonic clock seconds at the most recent state mutation.",
    )
    ended_at: float | None = Field(
        None,
        description=(
            "Monotonic clock seconds at terminal transition (done/failed/cancelled). "
            "``None`` while in-flight."
        ),
    )
    can_cancel: bool = Field(
        ...,
        description=(
            "True if the job exposes a cooperative-abort path (TDS streaming, "
            "sweep, clone reload-replay). Synchronous routines like PF/EIG/CPF/"
            "SE are not cancellable; the UI must NOT render a cancel button "
            "for ``can_cancel: false`` records."
        ),
    )
    progress: float | None = Field(
        None,
        description=(
            "Fractional progress in ``[0.0, 1.0]`` when the job emits "
            "per-step progress (sweep iterations, clone reload-replay "
            "phases). ``None`` means indeterminate."
        ),
    )
    request_summary: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Serializable subset of the original request body. Used by the "
            "Activity panel's Retry affordance to re-fire the same mutation "
            "variables. Must NOT carry credentials or large blobs (R16: "
            "this field is in-memory only and excluded from any "
            "Zustand persist whitelist on the web side)."
        ),
    )
    result_ref: str | None = Field(
        None,
        description=(
            "Opaque reference to the job's result, populated on ``done``. "
            "For TDS this is the ``run_id``; for sweep, the ``sweep_id``; "
            "for clone edits, the new param value reference."
        ),
    )
    problem: ProblemDetails | None = Field(
        None,
        description=(
            "Populated on ``failed`` with the full ProblemDetails envelope "
            "(includes the typed ``recovery`` axes). Drives the "
            "Activity panel's per-job ``<ProblemDetailsErrorSurface>``."
        ),
    )
    repeated_count: int = Field(
        0,
        description=(
            "Number of identical-signature failures that coalesced into "
            "this record, which keeps the first of them. For ``done`` and "
            "in-flight jobs this is always ``0``."
        ),
    )
