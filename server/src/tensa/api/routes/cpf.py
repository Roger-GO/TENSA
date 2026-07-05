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
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from tensa.api._run_as_job import _run_as_job
from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ProblemDetails
from tensa.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)

router = APIRouter()


# ---- request / response schemas -------------------------------------------


class CpfRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/cpf``.

    All fields are optional. ``direction`` toggles between scaling
    loads vs generation up; ``step`` and ``max_iter`` push the
    corresponding ``ss.CPF.config`` values before the run.
    """

    model_config = ConfigDict(extra="forbid")

    direction: str = Field(
        default="load",
        description=(
            "Continuation direction. ``'load'`` (default) scales loads "
            "via ``CPF.run(load_scale=2.0)``. ``'gen'`` scales "
            "generation via ``pg_target=2.0``."
        ),
        pattern="^(load|gen)$",
    )
    step: float | None = Field(
        default=None,
        description=(
            "Optional initial continuation step size for lambda "
            "(pushed onto ``ss.CPF.config.step``). Default uses ANDES's "
            "own default (0.1)."
        ),
        gt=0,
    )
    max_iter: int | None = Field(
        default=None,
        description=(
            "Optional cap on the number of continuation steps "
            "(pushed onto ``ss.CPF.config.max_steps``). This maps the "
            "user-facing parameter name onto ANDES's ``max_steps`` "
            "field, which actually controls truncation; ANDES's own "
            "``max_iter`` config is the Newton corrector iterations "
            "per step. Default uses ANDES's own default (500)."
        ),
        ge=1,
    )


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
            "Index into ``lambdas`` where lambda is maximised "
            "(the nose point / voltage-collapse margin). ``-1`` when "
            "the run was truncated before reaching the nose."
        ),
    )
    max_lam: float = Field(
        ...,
        description=(
            "Peak lambda value reached. Echo of ``CPF.max_lam``. "
            "Always populated, even on truncation."
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
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this CPF routine (v3.1 Unit 5b, kind "
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
    raw_voltages = payload.get("voltages_per_bus") or {}
    voltages_per_bus: dict[str, list[float]] = {}
    if isinstance(raw_voltages, dict):
        for k, v in raw_voltages.items():
            try:
                voltages_per_bus[str(k)] = [float(x) for x in (v or [])]
            except (TypeError, ValueError):
                voltages_per_bus[str(k)] = []
    return CpfResultResponse(
        lambdas=[float(x) for x in (payload.get("lambdas") or [])],
        voltages_per_bus=voltages_per_bus,
        bus_idxes=[str(b) for b in (payload.get("bus_idxes") or [])],
        nose_idx=int(payload.get("nose_idx", -1)),
        max_lam=float(payload.get("max_lam", 0.0)),
        truncated=bool(payload.get("truncated", True)),
        done_msg=str(payload.get("done_msg", "")),
        mode=str(payload.get("mode", "pv")),
        job_id=job_id,
    )


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
                "fall through to a non-actionable internal error."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES CPF routine raised (e.g., singular Jacobian, KLU "
                "segfault, internal LinAlg failure)."
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
    args: dict[str, object] = {"direction": body.direction}
    if body.step is not None:
        args["step"] = body.step
    if body.max_iter is not None:
        args["max_iter"] = body.max_iter
    try:
        async with _run_as_job(
            mgr, session_id, "cpf", request_summary=body.model_dump()
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
