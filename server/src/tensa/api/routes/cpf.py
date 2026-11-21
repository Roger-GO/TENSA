"""Continuation power flow endpoints (Unit 12 of the v2.0 plan).

Two routes:

- ``POST /sessions/{id}/cpf`` — runs ``ss.CPF.run()`` synchronously and
  returns the per-step lambda + per-bus voltage trace as a
  :class:`CpfResultResponse`. Substrate gates on ``ss.PFlow.converged
  is True`` independently because ANDES's own ``CPF.init`` only logs a
  warning before falling through (verified in Unit 1a spike, mirroring
  the EIG gating discipline).
- ``POST /sessions/{id}/cpf/qv`` — runs ``ss.CPF.run_qv(bus_idx)`` for
  a single-bus QV-curve trace. Same gating, same response shape; the
  ``mode`` discriminator on the body distinguishes ``"pv"`` from
  ``"qv"`` so the UI can label axes accordingly.

ANDES side-effects, documented in the spike:
``CPF._snapshot_base`` snapshots the base case before the run and
``_restore_base`` restores it on both success and failure (try/finally
at cpf.py:255-259). The substrate does not have to clean up afterwards
and does not surface a side-effect banner (unlike the EIG route).

What a request can ask for beyond the defaults (the direction of the
increase, reactive limits along the path, the lower branch) and how each
reaches ANDES is in :mod:`tensa.core.cpf_options`. Every setting is for
that run only.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, model_validator

from tensa.api._run_as_job import _run_as_job
from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ProblemDetails
from tensa.core.cpf_options import MAX_TOL, MIN_CORRECTOR_ITER
from tensa.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)

router = APIRouter()


# ---- request / response schemas -------------------------------------------


# The longest list of increases a custom direction takes: more than any case
# has loads, and short enough that the body stays small.
MAX_INCREASES = 100_000

# A target lambda for ``stop_at``: a number, never a numeric string or a boolean.
_TargetLambda = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]


class CpfLoadIncrease(BaseModel):
    """What one PQ load gains for each unit of lambda in a custom direction."""

    model_config = ConfigDict(extra="forbid")

    idx: int | str = Field(..., description="The load's ``PQ`` idx.")
    p: float = Field(
        default=0.0,
        allow_inf_nan=False,
        description="Active power added per unit of lambda, in MW. Negative takes load off.",
    )
    q: float = Field(
        default=0.0,
        allow_inf_nan=False,
        description="Reactive power added per unit of lambda, in MVAr.",
    )


class CpfGeneratorIncrease(BaseModel):
    """What one PV generator gains for each unit of lambda in a custom direction."""

    model_config = ConfigDict(extra="forbid")

    idx: int | str = Field(
        ...,
        description=(
            "The generator's ``PV`` idx. The slack generator cannot be named: it "
            "supplies whatever the rest of the direction leaves."
        ),
    )
    p: float = Field(
        ...,
        allow_inf_nan=False,
        description="Active power added per unit of lambda, in MW.",
    )


class CpfRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/cpf``.

    All fields are optional, and each applies to this run only.
    ``direction`` says what lambda increases, ``enforce_q_limits`` holds
    generators to their reactive limits along the path, ``stop_at`` asks
    for the lower branch as well or names a target lambda, ``step`` and
    ``max_iter`` set ``ss.CPF.config.step`` and ``max_steps`` for the run,
    and ``parameterization``, ``tol``, ``corrector_max_iter``, ``step_min``
    and ``step_max`` the routine's settings of those names (ANDES calls
    ``corrector_max_iter`` ``max_iter``).
    """

    model_config = ConfigDict(extra="forbid")

    direction: Literal["load", "load-only", "gen", "custom"] = Field(
        default="load",
        description=(
            "What lambda increases. ``'load'`` (default) scales every load "
            "and every PV generator's output in proportion to its base value "
            "(``CPF.run(load_scale=2.0)``). ``'load-only'`` scales the loads "
            "and leaves the PV generators where they are, so the slack "
            "generator supplies the increase. ``'gen'`` scales the PV "
            "generators and leaves the loads. With these three, "
            "``lambda = 1`` is twice the base value. ``'custom'`` moves the "
            "devices named in ``load_increase`` and ``generator_increase`` by "
            "the amounts given there, and ``lambda`` counts multiples of "
            "them. The slack generator is never part of a direction, and "
            "only PQ loads and PV generators move: ANDES's routine leaves "
            "every other load model as it is."
        ),
    )
    load_increase: list[CpfLoadIncrease] | None = Field(
        default=None,
        max_length=MAX_INCREASES,
        description=(
            "For ``direction: 'custom'``: the MW and MVAr each named PQ load "
            "gains per unit of lambda. A load left out does not move."
        ),
    )
    generator_increase: list[CpfGeneratorIncrease] | None = Field(
        default=None,
        max_length=MAX_INCREASES,
        description=(
            "For ``direction: 'custom'``: the MW each named PV generator gains "
            "per unit of lambda. A generator left out does not move, and what "
            "the loads gain beyond the generators is supplied by the slack."
        ),
    )
    enforce_q_limits: bool | None = Field(
        default=None,
        description=(
            "Switch a PV or slack generator to a PQ bus held at ``qmin`` or "
            "``qmax`` when its reactive output reaches one along the path. "
            "Left out, the case's own setting stands (off unless the case "
            "file turns ``pv2pq`` on). The continuation starts from the power "
            "flow as solved, so run that with ``enforce_q_limits`` as well: "
            "the request is refused with 409 when the solved power flow "
            "leaves a generator past a limit. Without it, the generators the "
            "power flow holds at a limit stay held and no other switches. A "
            "generator held at a limit stays held for the rest of the path "
            "(ANDES's limiter does not let go); ``would_release_step`` of its "
            "entry in ``limit_events`` says from where a real exciter would "
            "have."
        ),
    )
    stop_at: Literal["nose", "full"] | _TargetLambda = Field(
        default="nose",
        description=(
            "``'nose'`` (default) stops at the nose. ``'full'`` turns there "
            "and follows the lower-voltage solutions back to ``lambda = 0`` "
            "(``CPF.config.stop_at = 'FULL'``); the steps after ``nose_idx`` "
            "are that lower branch. A number above zero is a target lambda: "
            "the routine shortens the step that would cross it and lands on "
            "it, and the run ends there (``complete`` true, with no nose, so "
            "``truncated`` true). A target past the nose is never crossed: "
            "the run ends at the nose (``complete`` false, ``done_msg`` "
            "naming the target), where ANDES alone would go on down the "
            "lower branch. Not with ``parameterization: 'natural'`` and "
            "``'full'`` together."
        ),
    )
    parameterization: Literal["natural", "arclength", "pseudo_arclength"] | None = Field(
        default=None,
        description=(
            "The equation that fixes the length of a step in the corrector "
            "(``CPF.config.parameterization``). ``'pseudo_arclength'`` is "
            "ANDES's default and the most robust at the nose; "
            "``'arclength'`` also goes round it. ``'natural'`` fixes lambda, "
            "which is singular at the nose: the routine finds the nose by "
            "halving the step until it fails, with about twice the points "
            "and none past it, and it cannot trace the lower branch, so it "
            "is refused with ``stop_at: 'full'``. Left out, the case's "
            "setting stands."
        ),
    )
    tol: float | None = Field(
        default=None,
        gt=0,
        le=MAX_TOL,
        allow_inf_nan=False,
        description=(
            "The corrector's tolerance on the mismatch, in pu "
            "(``CPF.config.tol``; ANDES's default 1e-6). At most 1e-4: the "
            "nose and the switches of reactive limits are found from the "
            "points the corrector solves. Left out, the case's setting stands."
        ),
    )
    corrector_max_iter: int | None = Field(
        default=None,
        ge=MIN_CORRECTOR_ITER,
        strict=True,
        description=(
            "The Newton iterations the corrector takes per continuation step "
            "(ANDES's own ``CPF.config.max_iter``; its default 20). Not the "
            "cap on continuation steps, which is what ``max_iter`` sets. A "
            "step whose corrector runs out of iterations fails, and the "
            "routine calls the nose where failures pile up, so a low cap can "
            "call it early; at least 2. Left out, the case's setting stands."
        ),
    )
    step_min: float | None = Field(
        default=None,
        gt=0,
        allow_inf_nan=False,
        description=(
            "The smallest continuation step (``CPF.config.step_min``; ANDES's "
            "default 1e-4). A failed step is halved, and once it is below "
            "this the routine calls the nose, so a larger value ends the "
            "search for it sooner. Not above ``step_max`` (the request's or "
            "the case's). Left out, the case's setting stands."
        ),
    )
    step_max: float | None = Field(
        default=None,
        gt=0,
        allow_inf_nan=False,
        description=(
            "The largest step the routine grows its adaptive step to "
            "(``CPF.config.step_max``; ANDES's default 0.5): smaller draws "
            "the curve with more points. Left out, the case's setting stands."
        ),
    )
    step: float | None = Field(
        default=None,
        description=(
            "Optional initial continuation step size for lambda "
            "(``ss.CPF.config.step`` for this run). Default uses ANDES's "
            "own default (0.1)."
        ),
        gt=0,
        allow_inf_nan=False,
    )
    max_iter: int | None = Field(
        default=None,
        description=(
            "Optional cap on the number of continuation steps "
            "(``ss.CPF.config.max_steps`` for this run). This maps the "
            "user-facing parameter name onto ANDES's ``max_steps`` "
            "field, which actually controls truncation; ANDES's own "
            "``max_iter`` config is the Newton corrector iterations "
            "per step. Default uses ANDES's own default (500)."
        ),
        ge=1,
    )

    @model_validator(mode="after")
    def _settings_go_together(self) -> CpfRunRequest:
        if (
            self.step_min is not None
            and self.step_max is not None
            and self.step_min > self.step_max
        ):
            raise ValueError("step_min must not be above step_max")
        if self.parameterization == "natural" and self.stop_at == "full":
            raise ValueError(
                "parameterization 'natural' cannot pass the nose, so it cannot "
                "trace the lower branch of stop_at 'full'"
            )
        return self

    @model_validator(mode="after")
    def _increases_go_with_custom(self) -> CpfRunRequest:
        given = self.load_increase is not None or self.generator_increase is not None
        if self.direction == "custom":
            if not (self.load_increase or self.generator_increase):
                raise ValueError(
                    "direction 'custom' needs at least one entry in load_increase "
                    "or generator_increase"
                )
        elif given:
            raise ValueError(
                "load_increase and generator_increase go with direction 'custom'"
            )
        return self


class CpfQvRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/cpf/qv``."""

    model_config = ConfigDict(extra="forbid")

    bus_idx: str = Field(
        ...,
        description=(
            "Bus idx to draw the QV-curve at. Must match an entry in "
            "the loaded case's ``Bus.idx``; ANDES requires at least "
            "one PQ device at this bus (raises ``ValueError`` otherwise, "
            "surfaced as 422 here)."
        ),
        min_length=1,
    )
    q_range: float | None = Field(
        default=None,
        description=(
            "Reactive-power range for the QV continuation. Default "
            "matches ANDES's own ``q_range=5.0``."
        ),
        gt=0,
    )
    enforce_q_limits: bool | None = Field(
        default=None,
        description=(
            "Hold generators to their reactive limits along the curve, as "
            "``enforce_q_limits`` of ``POST /sessions/{id}/cpf`` does."
        ),
    )


class CpfGeneratorTraceSchema(BaseModel):
    """One PV or slack generator along the path. Mirrors
    :class:`tensa.core.cpf_result.CpfGeneratorTrace`."""

    model_config = ConfigDict(extra="forbid")

    idx: str = Field(..., description="The generator's idx.")
    model: Literal["PV", "Slack"] = Field(..., description="Its ANDES model.")
    bus: str = Field(..., description="The idx of the bus it sits on.")
    q: list[float] = Field(
        ...,
        description="Reactive output in MVAr at every step, index-aligned with ``lambdas``.",
    )
    q_min: float | None = Field(
        default=None, description="Lower reactive limit in MVAr; ``null`` when not finite."
    )
    q_max: float | None = Field(
        default=None, description="Upper reactive limit in MVAr; ``null`` when not finite."
    )


class CpfLimitEventSchema(BaseModel):
    """The first step at which a generator is held at a reactive limit. Mirrors
    :class:`tensa.core.cpf_result.CpfLimitEvent`."""

    model_config = ConfigDict(extra="forbid")

    step: int = Field(
        ...,
        description=(
            "Index into ``lambdas``. ``0`` means the power flow the "
            "continuation started from already held the generator there."
        ),
    )
    lam: float = Field(..., description="The value of ``lambdas`` at that step.")
    idx: str = Field(..., description="The generator's idx.")
    model: Literal["PV", "Slack"] = Field(..., description="Its ANDES model.")
    bus: str = Field(..., description="The idx of the bus it sits on.")
    limit: Literal["qmax", "qmin"] = Field(..., description="The limit it is held at.")
    at_nose: bool = Field(
        default=False,
        description=(
            "``true`` when the nose is where this generator switched: lambda "
            "turned at the switch or in the step after it, or the path could "
            "not get past the switch at all. The loadability then ends "
            "because the generator ran out of reactive power (a "
            "limit-induced collapse), not at a smooth fold."
        ),
    )
    would_release_step: int | None = Field(
        default=None,
        description=(
            "The first step, from ``step`` on, at which the generator's "
            "terminal voltage is back across its set-point (above it for "
            "``qmax``, below for ``qmin``), where a real exciter would take the "
            "voltage up again and leave the limit. ANDES keeps a generator at "
            "a limit once it is there, so from that step the curve is the one "
            "for a generator pinned at its limit. ``null`` when it does not "
            "happen."
        ),
    )


class CpfResultResponse(BaseModel):
    """Wire shape of ``POST /sessions/{id}/cpf`` and
    ``POST /sessions/{id}/cpf/qv``.

    Field semantics mirror :class:`tensa.core.cpf_result.CpfResult`
    1:1; see that class for prose.
    """

    model_config = ConfigDict(extra="forbid")

    lambdas: list[float] = Field(
        ...,
        description=(
            "Per-step continuation parameter values. For PV-curve "
            "runs this is ``CPF.lam`` (lambda); for QV-curve runs it "
            "is ``CPF.qv_q`` (reactive injection). The ``mode`` field "
            "tells the UI which axis label to use."
        ),
    )
    voltages_per_bus: dict[str, list[float]] = Field(
        ...,
        description=(
            "Per-bus voltage trace, index-aligned with ``lambdas``. "
            "PV runs include every bus in the loaded case; QV runs "
            "include only the requested ``bus_idx``."
        ),
    )
    bus_idxes: list[str] = Field(
        ...,
        description=(
            "Ordered list of bus idxes (stringified) matching the "
            "row order of ``CPF.V``. Surfaced separately so the UI "
            "can render in canonical order without dict-key iteration "
            "ambiguity."
        ),
    )
    nose_idx: int = Field(
        ...,
        description=(
            "Index into ``lambdas`` of the nose point (the voltage-collapse "
            "margin): the point after which lambda first goes down. ``-1`` "
            "when the run was truncated before reaching the nose. On a full "
            "curve the steps after it are the lower branch."
        ),
    )
    max_lam: float = Field(
        ...,
        description=(
            "Lambda at the nose, which is the largest value reached on the "
            "way up. Without a nose, the largest value reached. For a QV "
            "curve, the largest reactive power at the bus (the axis "
            "``lambdas`` is on). Always populated, even on truncation."
        ),
    )
    truncated: bool = Field(
        ...,
        description=(
            "``True`` when the run terminated without finding a nose "
            "point (e.g. hit ``max_steps`` or did not branch-switch "
            "to a NOSE event). When ``True``, ``nose_idx == -1`` and "
            "the UI shows the truncation note from ``done_msg``."
        ),
    )
    done_msg: str = Field(
        ...,
        description=(
            "ANDES's terminal status string (e.g., "
            "``\"Nose point at lambda=3.258046\"``, "
            "``\"Reached max steps (5)\"``). Used by the UI to label "
            "the truncation banner."
        ),
    )
    mode: str = Field(
        ...,
        description=(
            "Discriminator: ``\"pv\"`` for the full PV-curve sweep "
            "(``CPF.run``) or ``\"qv\"`` for a single-bus QV-curve "
            "(``CPF.run_qv``). The wire shape is the same; the UI "
            "uses ``mode`` to label the X-axis (lambda vs Q)."
        ),
        pattern="^(pv|qv)$",
    )
    generators: list[CpfGeneratorTraceSchema] = Field(
        default_factory=list,
        description=(
            "Every in-service PV and slack generator's reactive output along "
            "the path, with its limits. Empty only when the readings could "
            "not be matched to the steps."
        ),
    )
    limit_events: list[CpfLimitEventSchema] = Field(
        default_factory=list,
        description=(
            "The generators held at a reactive limit, each with the first "
            "step at which it is, in step order. Those at step 0 are held by "
            "the power flow the run started from. A generator has at most one "
            "entry: one that is held stays held for the rest of the path."
        ),
    )
    q_limits_enforced: bool = Field(
        default=False,
        description=(
            "Whether generators were switched to PQ at their reactive limits "
            "along the path. When ``false`` only the generators the base "
            "power flow held are held."
        ),
    )
    stop_at: Literal["nose", "full"] = Field(
        default="nose",
        description=(
            "What the run was asked to trace: up to the nose, or the full curve. "
            "A run given a target lambda has ``'nose'`` here and the target in "
            "``stop_at_lambda``."
        ),
    )
    complete: bool = Field(
        default=True,
        description=(
            "Whether the run ended the way ``stop_at`` asked. ``false`` with "
            "``truncated: false`` is a full curve whose lower branch broke "
            "off, or a run whose nose came before its target lambda; "
            "``done_msg`` says where. A run that reached its target lambda is "
            "complete, with ``truncated: true`` since it found no nose."
        ),
    )
    direction: Literal["load", "load-only", "gen", "custom"] | None = Field(
        default=None,
        description=(
            "The direction of the increase a PV run was asked for; ``null`` "
            "for a QV curve."
        ),
    )
    angles_per_bus: dict[str, list[float]] = Field(
        default_factory=dict,
        description=(
            "Bus voltage angles in radians at every step (``CPF.theta``), "
            "keyed by bus idx and index-aligned with ``lambdas`` and that "
            "bus's ``voltages_per_bus`` row. Empty for a QV curve, and when "
            "ANDES's angles could not be aligned with the points kept."
        ),
    )
    parameterization: Literal["natural", "arclength", "pseudo_arclength"] | None = Field(
        default=None,
        description=(
            "The parameterization the run used, as the request gave it; "
            "``null`` where the case's own setting was kept."
        ),
    )
    tol: float | None = Field(
        default=None,
        description=(
            "The corrector tolerance the run used, as the request gave it; "
            "``null`` where the case's own setting was kept."
        ),
    )
    corrector_max_iter: int | None = Field(
        default=None,
        description=(
            "The corrector's Newton iterations per step the run used, as the "
            "request gave them; ``null`` where the case's own setting was kept."
        ),
    )
    step_min: float | None = Field(
        default=None,
        description=(
            "The smallest step the run used, as the request gave it; ``null`` "
            "where the case's own setting was kept."
        ),
    )
    step_max: float | None = Field(
        default=None,
        description=(
            "The largest step the run used, as the request gave it; ``null`` "
            "where the case's own setting was kept."
        ),
    )
    stop_at_lambda: float | None = Field(
        default=None,
        description=(
            "The target lambda the run was given in ``stop_at``; ``null`` when "
            "``stop_at`` was ``'nose'`` or ``'full'``."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this CPF routine (kind "
            "``cpf`` for the PV sweep, ``cpf-qv`` for the QV curve). "
            "``GET /sessions/{id}/jobs/{job_id}`` returns the matching "
            "record; ``null`` on legacy responses."
        ),
    )


# ---- helpers --------------------------------------------------------------


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


def _to_http_error(exc: WorkerError) -> HTTPException:
    """Route-local adapter over the shared ``map_worker_error`` (Unit 4b).

    The shared mapper owns the canonical category→status table (``no-case-loaded``
    → 409, ``CpfPrerequisiteError`` → 409, ``CpfDivergedError`` → 422,
    ``SetupFailedError`` → 422), recovery, and the body shape. This route only
    appends the documented "reload to recover" hint to ``SetupFailedError``.
    """
    if exc.category == "SetupFailedError":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to recover."
        )
    return map_worker_error(exc)


def _summary(body: CpfRunRequest) -> dict[str, Any]:
    """What the job record keeps of a request: its settings, and how many
    devices a custom direction names in place of the lists themselves."""
    summary = body.model_dump(exclude={"load_increase", "generator_increase"})
    if body.direction == "custom":
        summary["load_increase"] = len(body.load_increase or [])
        summary["generator_increase"] = len(body.generator_increase or [])
    return summary


def _payload_to_response(
    payload: object, job_id: str | None = None
) -> CpfResultResponse:
    """Coerce a worker payload dict into a typed response model.

    Defensive against payload shape drift (the worker serializer is
    a plain dict / list cascade); explicit field-by-field coercion
    matches the EIG route's pattern.
    """
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for CPF: "
                f"{type(payload).__name__}"
            ),
        )
    return CpfResultResponse(
        lambdas=[float(x) for x in (payload.get("lambdas") or [])],
        voltages_per_bus=_series_by_bus(payload.get("voltages_per_bus")),
        bus_idxes=[str(b) for b in (payload.get("bus_idxes") or [])],
        nose_idx=int(payload.get("nose_idx", -1)),
        max_lam=float(payload.get("max_lam", 0.0)),
        truncated=bool(payload.get("truncated", True)),
        done_msg=str(payload.get("done_msg", "")),
        mode=str(payload.get("mode", "pv")),
        generators=_rows(payload.get("generators")),
        limit_events=_rows(payload.get("limit_events")),
        q_limits_enforced=bool(payload.get("q_limits_enforced", False)),
        stop_at=payload.get("stop_at") or "nose",
        complete=bool(payload.get("complete", True)),
        direction=payload.get("direction"),
        angles_per_bus=_series_by_bus(payload.get("angles_per_bus")),
        parameterization=payload.get("parameterization"),
        tol=payload.get("tol"),
        corrector_max_iter=payload.get("corrector_max_iter"),
        step_min=payload.get("step_min"),
        step_max=payload.get("step_max"),
        stop_at_lambda=payload.get("stop_at_lambda"),
        job_id=job_id,
    )


def _series_by_bus(raw: object) -> dict[str, list[float]]:
    """A per-bus mapping of the worker payload as floats, keyed by idx as text."""
    series: dict[str, list[float]] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                series[str(k)] = [float(x) for x in (v or [])]
            except (TypeError, ValueError):
                series[str(k)] = []
    return series


def _rows(raw: object) -> list[Any]:
    """The dict entries of a list in the worker payload, for pydantic to check."""
    return [row for row in raw if isinstance(row, dict)] if isinstance(raw, list) else []


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/cpf",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="runCpf",
    summary="Run continuation power flow (PV-curve / nose-curve) on the session.",
    response_model=CpfResultResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case loaded OR the session has no converged PFlow result. "
                "Run /pflow first; ``CPF.init`` only warns and would otherwise "
                "fall through to a non-actionable internal error. Also when "
                "``enforce_q_limits`` is on and the solved power flow leaves a "
                "generator past a reactive limit: run /pflow with "
                "``enforce_q_limits`` first."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The request cannot be run on this case (an increase names a "
                "device the case does not have, or the direction moves "
                "nothing), OR the ANDES CPF routine raised (e.g., singular "
                "Jacobian, KLU segfault, internal LinAlg failure)."
            ),
        },
    },
)
async def run_cpf(
    session_id: str,
    body: CpfRunRequest,
    request: Request,
) -> CpfResultResponse:
    """Synchronously run ``ss.CPF.run()`` and return the trajectory.

    Truncation (``ok=False`` on the wrapper side) does NOT raise — the
    response carries ``truncated=True`` and ``nose_idx=-1`` so the UI
    can show the "did not reach nose" note inline rather than as an
    error banner.
    """
    mgr = _manager(request)
    args: dict[str, object] = {"direction": body.direction, "stop_at": body.stop_at}
    if body.step is not None:
        args["step"] = body.step
    if body.max_iter is not None:
        args["max_iter"] = body.max_iter
    if body.enforce_q_limits is not None:
        args["enforce_q_limits"] = body.enforce_q_limits
    for name in ("parameterization", "tol", "corrector_max_iter", "step_min", "step_max"):
        value = getattr(body, name)
        if value is not None:
            args[name] = value
    if body.load_increase is not None:
        args["load_increase"] = [item.model_dump() for item in body.load_increase]
    if body.generator_increase is not None:
        args["generator_increase"] = [item.model_dump() for item in body.generator_increase]
    try:
        async with _run_as_job(
            mgr, session_id, "cpf", request_summary=_summary(body)
        ) as job_id:
            payload = await mgr.invoke(session_id, "run_cpf", args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    return _payload_to_response(payload, job_id)


@router.post(
    "/sessions/{session_id}/cpf/qv",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="runCpfQv",
    summary="Run a single-bus QV-curve continuation on the session.",
    response_model=CpfResultResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case loaded OR the session has no converged PFlow result. "
                "Run /pflow first."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES CPF.run_qv raised — typically because no PQ device is "
                "attached to ``bus_idx`` or the case is too stiff for the QV "
                "continuation."
            ),
        },
    },
)
async def run_cpf_qv(
    session_id: str,
    body: CpfQvRunRequest,
    request: Request,
) -> CpfResultResponse:
    """Synchronously run ``ss.CPF.run_qv(bus_idx)`` and return the trace."""
    mgr = _manager(request)
    args: dict[str, object] = {"bus_idx": body.bus_idx}
    if body.q_range is not None:
        args["q_range"] = body.q_range
    if body.enforce_q_limits is not None:
        args["enforce_q_limits"] = body.enforce_q_limits
    try:
        async with _run_as_job(
            mgr, session_id, "cpf-qv", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(session_id, "run_cpf_qv", args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    return _payload_to_response(payload, job_id)
