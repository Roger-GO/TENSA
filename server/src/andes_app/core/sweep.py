"""Sensitivity sweep orchestrator (Unit 18 of the v2.0 plan).

A sweep iterates a single parameter through a numeric range, restoring a
named snapshot at each step (Unit 7), mutating the parameter override on
the snapshot's recorded disturbance log (Unit 6.5 ``replay_disturbances``
semantics), and running TDS (Unit 6) to record one result per step.

Concurrency model (KTD-9 + Unit 18 spec):

- The sweep runs as ONE long ``invoke`` on the per-session worker. The
  per-session ``threading.Lock`` (in ``SessionManager._Session.lock``) is
  held for the entire sweep duration. This keeps all other session-scoped
  endpoints out — they observe a "sweep in progress" flag (also kept on
  the ``_Session``) and the routes layer translates that flag into a
  ``503 Service Unavailable`` with a ``Retry-After`` header.

- Per-iteration progress is emitted via the ``data_pipe`` as
  ``{"type": "sweep_progress", ...}`` envelopes that the
  ``SessionManager.start_sweep`` background task forwards into a
  ``_SweepBuffer`` (analogous to ``_RunBuffer`` for streaming TDS). The
  WS endpoint ``/api/ws/{session_id}/sweep/{sweep_id}`` consumes the
  buffer and forwards events to the client.

- Cancellation: the existing ``signal_abort`` mechanism sets the worker's
  ``abort_event``. The orchestrator checks the event between iterations
  AND at the start of each per-iteration TDS. ``run_tds`` honours the
  flag mid-integration via its existing callpert hook. On abort, the
  sweep returns the iterations completed so far + a truncated flag.

The sweep ONLY supports parameter overrides on disturbance specs
(Fault.tc, Fault.tf, Fault.xf, Fault.rf, Toggle.t, Alter.t, Alter.value)
in v2.0. Topology-parameter sweeps would require pre-setup wrapper
mutation between iterations and are out of scope.

Snapshot prerequisite: the caller MUST have saved a snapshot before
starting the sweep (the sweep's first action is ``restore_snapshot`` on
the named snapshot). This keeps each iteration deterministic — the same
operating point every time — and avoids subtle drift across iterations
when ANDES post-iteration cleanup is incomplete.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from andes_app.core.errors import AndesAppError


class SweepValidationError(AndesAppError):
    """Raised when a SweepSpec fails substrate-side validation.

    The route layer maps this to HTTP 422.
    """


# ---- request shape (mirrors the wire format) -------------------------------


# Allowed disturbance-parameter targets. Each entry pairs a disturbance
# kind ("fault" / "toggle" / "alter") with the field name on the
# corresponding spec class. Extending this list is intentional — the
# substrate intentionally narrows the v2.0 sweep surface to fields that
# ANDES can numerically sweep without surprises.
SweepParamKind = Literal[
    "disturbance.fault.tc",
    "disturbance.fault.tf",
    "disturbance.fault.xf",
    "disturbance.fault.rf",
    "disturbance.toggle.t",
    "disturbance.alter.t",
    "disturbance.alter.value",
]


_KIND_TO_FIELD: dict[str, tuple[str, str]] = {
    # (disturbance kind discriminator, spec attribute name)
    "disturbance.fault.tc": ("fault", "tc"),
    "disturbance.fault.tf": ("fault", "tf"),
    "disturbance.fault.xf": ("fault", "xf"),
    "disturbance.fault.rf": ("fault", "rf"),
    "disturbance.toggle.t": ("toggle", "t"),
    "disturbance.alter.t": ("alter", "t"),
    "disturbance.alter.value": ("alter", "value"),
}


def parse_sweep_target(kind: str) -> tuple[str, str]:
    """Return ``(disturbance_discriminator, spec_field)`` for ``kind``.

    Raises :class:`SweepValidationError` on unknown kinds.
    """
    pair = _KIND_TO_FIELD.get(kind)
    if pair is None:
        raise SweepValidationError(
            f"unknown sweep parameter kind: {kind!r}; expected one of "
            f"{sorted(_KIND_TO_FIELD)!r}"
        )
    return pair


class SweepRange(BaseModel):
    """Inclusive-endpoint linear sweep range.

    ``steps`` is the iteration count (>= 2). The endpoints ``start`` and
    ``end`` always appear in the iteration set so the user gets exactly
    the boundary they asked for.
    """

    model_config = ConfigDict(extra="forbid")

    start: float = Field(..., description="First parameter value.")
    end: float = Field(..., description="Last parameter value.")
    steps: int = Field(
        ...,
        ge=2,
        le=200,
        description=(
            "Iteration count (must be >= 2; capped at 200 to keep "
            "memory + runtime bounded for v2.0)."
        ),
    )

    def values(self) -> list[float]:
        """Materialise the inclusive linear range as a Python list."""
        if self.steps < 2:  # pragma: no cover — guarded by Pydantic ge=2
            raise SweepValidationError(
                f"steps must be >= 2, got {self.steps}"
            )
        # Inclusive linear: ``start + i * (end - start) / (steps - 1)``.
        # Use Python floats throughout; numpy is a heavier import than
        # warranted for a short list.
        if self.steps == 2:
            return [float(self.start), float(self.end)]
        delta = (self.end - self.start) / (self.steps - 1)
        return [float(self.start + i * delta) for i in range(self.steps)]


class SweepParameter(BaseModel):
    """Discriminated sweep target.

    ``target`` is the ANDES-side device identifier the parameter applies
    to (e.g., the disturbance idx returned by ``add_disturbance``). The
    orchestrator looks up the matching spec in the snapshot's recorded
    ``disturbance_log`` and overrides its field.

    For v2.0 the target is the disturbance's index in the snapshot's log
    (zero-based). Future revisions may extend this to (model, idx,
    field) tuples for topology parameters.
    """

    model_config = ConfigDict(extra="forbid")

    kind: SweepParamKind = Field(
        ...,
        description=(
            "Discriminator: which spec field is being swept. Includes "
            "the disturbance kind so the spec lookup can validate the "
            "target type matches."
        ),
    )
    target: int = Field(
        ...,
        ge=0,
        description=(
            "Index into the snapshot's ``disturbance_log`` identifying "
            "which spec to mutate. v2.0 only supports per-disturbance "
            "sweeps; topology sweeps are deferred."
        ),
    )
    range: SweepRange = Field(
        ...,
        description=(
            "Inclusive linear sweep range over the parameter values."
        ),
    )


class SweepSimParams(BaseModel):
    """Per-iteration TDS parameters. Mirrors the ``run_tds`` call shape."""

    model_config = ConfigDict(extra="forbid")

    tf: float = Field(..., gt=0, description="Final sim time per iteration.")
    h: float | None = Field(
        None,
        description=(
            "Fixed integration step (seconds). ``None`` to use the "
            "wrapper default (currently 1/120 s)."
        ),
    )
    vars: list[str] | None = Field(
        None,
        description=(
            "Variable groups to record per iteration (kept as metadata "
            "only — the sweep stores aggregate convergence + final_t, "
            "not the full per-step state, to keep memory bounded)."
        ),
    )


class SweepRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/sweep``."""

    model_config = ConfigDict(extra="forbid")

    parameter: SweepParameter = Field(
        ...,
        description=(
            "Parameter target + range definition. Identifies the spec "
            "to mutate per iteration and the values to iterate over."
        ),
    )
    sim: SweepSimParams = Field(
        ...,
        description=(
            "Per-iteration TDS simulation parameters (tf, optional h, "
            "optional vars). Applied identically to every iteration."
        ),
    )
    snapshot_name: str = Field(
        ...,
        description=(
            "Name of a previously-saved snapshot. Each iteration "
            "restores this snapshot before applying the parameter "
            "override."
        ),
    )


# ---- per-iteration result shape -------------------------------------------


@dataclass(frozen=True)
class SweepIterationResult:
    """Outcome of one sweep iteration, recorded into the SweepBuffer.

    The result is intentionally minimal: aggregate convergence + final
    time + callpert count, not the full per-step state. The full state
    would blow the per-sweep memory budget at 50 iterations × N seconds
    × 120 Hz × M variables.
    """

    iteration: int  # 0-based index in the sweep
    parameter_value: float
    converged: bool
    final_t: float
    callpert_count: int
    error: str | None = None  # populated on per-iteration failure


@dataclass
class SweepResult:
    """Aggregate result returned by :meth:`Wrapper.run_sweep`.

    The orchestrator collects per-iteration results into ``iterations``;
    the caller (worker handler) ships each iteration over the data_pipe
    progressively as ``sweep_progress`` events. ``truncated`` is True if
    the abort flag fired before all iterations completed.
    """

    sweep_id: str
    parameter_kind: str
    parameter_target: int
    snapshot_name: str
    iterations: list[SweepIterationResult] = field(default_factory=list)
    truncated: bool = False


__all__ = [
    "SweepIterationResult",
    "SweepParameter",
    "SweepParamKind",
    "SweepRange",
    "SweepRequest",
    "SweepResult",
    "SweepSimParams",
    "SweepValidationError",
    "parse_sweep_target",
]
