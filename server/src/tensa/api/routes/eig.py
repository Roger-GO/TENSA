"""Eigenvalue analysis endpoints (Unit 6 of the v2.0 plan).

Four routes:

- ``POST /sessions/{id}/eig`` — runs ``ss.EIG.run()`` synchronously and
  returns the eigenvalues / damping ratios / mode metadata. Substrate
  gates on ``ss.PFlow.converged is True`` independently because
  ANDES's own ``EIG._pre_check`` only logs a warning before falling
  through to a crash (verified in Unit 1a spike).
- ``POST /sessions/{id}/eig/sweep``: the eigenvalues at each of a list of
  values of one parameter of one device (root loci data), each from a
  System of its own, so the session's System is left as it was
  (``Wrapper.run_eig_sweep``).
- ``GET /sessions/{id}/eig/modes/{mode_idx}/participation`` — slices
  ``EIG.pfactors[mode_idx]`` and returns the per-state participation
  factor row (substrate-side slice; no per-mode lazy API in ANDES).
- ``GET /sessions/{id}/eig/state-matrix.mat`` — returns ``EIG.As`` and
  ``EIG.mu`` packed as a ``.mat`` file (consumed by the UI's MAT
  exporter — Unit 2).

ANDES side-effect, documented in the response: ``EIG.run()`` mutates
``dae.t`` and sets ``TDS.initialized=True``. The response carries
``tds_initialized: true`` so the UI surfaces an info banner per the
plan's Approach addendum.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from tensa.api._run_as_job import _run_as_job
from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ProblemDetails
from tensa.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)

router = APIRouter()


# ---- response schemas -----------------------------------------------------


class EigRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/eig``.

    Empty body — ANDES's ``EIG.run()`` takes no public arguments. Kept
    as a model (rather than ``None``) so the route can declare a
    ``model_config`` ``extra="forbid"`` and reject typos in the
    forward-compatible way.
    """

    model_config = ConfigDict(extra="forbid")

    load_model: Literal["impedance", "power", "as-case"] | None = Field(
        default=None,
        description=(
            "How loads behave in the analysis: ``impedance`` (the default), "
            "``power`` or ``as-case``. A Sienna session takes all three; an "
            "ANDES session takes it left out or ``impedance``, which is what "
            "ANDES does, and refuses the other two with 422."
        ),
    )


class EigSweepRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/eig/sweep``: one parameter of
    one device and the values to take the eigenvalues at."""

    model_config = ConfigDict(extra="forbid")

    model: str = Field(..., description="ANDES model name, e.g. 'GENROU'.")
    idx: str = Field(
        ...,
        description="idx of the device within the model, as a string, e.g. '1'.",
    )
    param: str = Field(
        ...,
        description=(
            "Parameter name as ANDES names it, e.g. 'M': a numeric parameter "
            "of the model that is not copied from another model, the ones "
            "GET /sessions/{id}/topology/models/{model}/alterable_params "
            "lists before its services."
        ),
    )
    values: list[FiniteFloat] = Field(
        ...,
        min_length=1,
        max_length=200,
        description=(
            "The values to take the eigenvalues at, in order: 1 to 200 "
            "finite numbers. A value is on the base the case file and an "
            "edit of the element use, which for a per-unit parameter is the "
            "device's own base (ANDES's ``vin``). Each value costs a read, a "
            "setup, a power flow and an eigenvalue analysis of the case."
        ),
    )


class ComplexNumberModel(BaseModel):
    """JSON-friendly complex number ``{real, imag}``."""

    model_config = ConfigDict(extra="forbid")

    real: float = Field(..., description="Real part of the eigenvalue.")
    imag: float = Field(..., description="Imaginary part of the eigenvalue.")


class EigResultResponse(BaseModel):
    """Wire shape of ``POST /sessions/{id}/eig``.

    The state matrix itself (``As``) is intentionally omitted from this
    response — for NPCC 140-bus it would be ~110k entries. The UI
    fetches the matrix on demand via ``GET /eig/state-matrix.mat``.
    """

    model_config = ConfigDict(extra="forbid")

    eigenvalues: list[ComplexNumberModel] = Field(
        ...,
        description=(
            "Eigenvalues of ``EIG.As`` (the system's reduced state matrix). "
            "Length equals ``mode_count``. Each entry is "
            "``{real, imag}`` so the JSON payload doesn't carry an "
            "out-of-band complex encoding. An eigenvalue ANDES counts as "
            "zero (magnitude within ``EIG.config.tol``, 1e-6 by default) "
            "is exactly ``{0, 0}``: what the solver returns for it is "
            "rounding noise whose sign differs between machines."
        ),
    )
    damping_ratios: list[float] = Field(
        ...,
        description=(
            "Per-mode damping ratio ``-Re(z) / |z|``. Index-aligned "
            "with ``eigenvalues``. A zero eigenvalue, which neither "
            "oscillates nor grows, has 1.0. NaN-collapsed to 0.0 so the "
            "wire payload never carries non-finite floats."
        ),
    )
    frequencies_hz: list[float] = Field(
        ...,
        description=(
            "Per-mode oscillation frequency ``|Im(z)| / (2*pi)`` in Hz. "
            "0 for purely-real eigenvalues."
        ),
    )
    mode_count: int = Field(
        ...,
        description=(
            "Number of eigenvalues == ``len(EIG.mu)`` (the *reduced* state "
            "count post fold/elimination). Stock IEEE 14 (no dyn models) "
            "→ 0; full IEEE 14 + dyr → 62; kundur_full → 52."
        ),
    )
    state_count: int = Field(
        ...,
        description=(
            "Same value as ``mode_count`` — surfaced as a separate field "
            "for clarity in the UI (the state matrix shape is "
            "``[state_count, state_count]``)."
        ),
    )
    state_names: list[str] = Field(
        ...,
        description=(
            "Reduced-state names indexed identically to participation "
            "factor rows. Falls back to ``state_<i>`` labels when the "
            "reduced count differs from ``ss.dae.x_name``."
        ),
    )
    tds_initialized: bool = Field(
        ...,
        description=(
            "Always ``true`` after a successful EIG.run. ANDES's "
            "``EIG._pre_check`` calls ``TDS.init()`` + ``TDS.itm_step()`` "
            "if not already initialised — the substrate surfaces this so "
            "the UI can warn that subsequent TDS / re-run PF will start "
            "from this initialised dae."
        ),
    )
    load_model: str | None = Field(
        default=None,
        description=(
            "The load model the analysis used (``impedance``, ``power`` or "
            "``as-case``). Set by the Sienna engine; ``null`` for ANDES, "
            "whose loads behave as the case and its own defaults leave them."
        ),
    )
    notes: list[str] = Field(
        default_factory=list,
        description=(
            "Standing notes on the result. A Sienna result carries the note "
            "that PSID's small-signal results are work in progress in "
            "validation, by PSID's own documentation (spec section 13). "
            "Empty for ANDES."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this EIG routine (kind "
            "``eig``). ``GET /sessions/{id}/jobs/{job_id}`` returns the "
            "matching record; ``null`` on legacy responses."
        ),
    )


class EigSweepPointModel(BaseModel):
    """The eigenvalues at one value of the swept parameter."""

    model_config = ConfigDict(extra="forbid")

    value: float = Field(
        ...,
        description=(
            "The parameter value of this point: ``points[i]`` is at "
            "``values[i]`` of the request."
        ),
    )
    eigenvalues: list[ComplexNumberModel] = Field(
        ...,
        description=(
            "Eigenvalues of the reduced state matrix at this value, each "
            "``{real, imag}``, as ``POST /sessions/{id}/eig`` gives them for a "
            "case opened with the value (an eigenvalue ANDES counts as zero "
            "is exactly ``{0, 0}``). The order is not comparable across "
            "points, since ANDES does not keep one: each point is a list of "
            "its own and no mode is followed through the sweep, so a client "
            "drawing root loci matches the modes itself."
        ),
    )
    damping_ratios: list[float] = Field(
        ...,
        description=(
            "Per-mode damping ratio ``-Re(z) / |z|`` at this value, "
            "index-aligned with ``eigenvalues``; 1.0 for a zero eigenvalue."
        ),
    )
    frequencies_hz: list[float] = Field(
        ...,
        description=(
            "Per-mode oscillation frequency ``|Im(z)| / (2*pi)`` in Hz at "
            "this value, index-aligned with ``eigenvalues``."
        ),
    )


class EigSweepResponse(BaseModel):
    """Wire shape of ``POST /sessions/{id}/eig/sweep``."""

    model_config = ConfigDict(extra="forbid")

    model: str = Field(..., description="The model of the swept parameter, as requested.")
    idx: str = Field(..., description="The device of the swept parameter, as requested.")
    param: str = Field(..., description="The swept parameter, as requested.")
    points: list[EigSweepPointModel] = Field(
        ...,
        description=(
            "One point per requested value, in the request's order. Each is "
            "an eigenvalue analysis of a system of its own: the case with the "
            "session's edits and the parameter at the value, its power flow "
            "solved with the settings of the session's last one. The "
            "session's own system is not changed by the sweep."
        ),
    )
    mode_count: int = Field(
        ...,
        description=(
            "Number of eigenvalues at every point. A sweep whose points "
            "differ in it is refused (422), not answered with lists of "
            "different lengths."
        ),
    )
    tds_initialized: bool = Field(
        ...,
        description=(
            "Whether the session's dynamic state is initialised, which the "
            "sweep does not change: ``false`` unless an eigenvalue analysis "
            "or a time-domain run of the session initialised it, so a power "
            "flow can still run after a sweep that followed one."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this sweep (kind ``eig``). "
            "``GET /sessions/{id}/jobs/{job_id}`` returns the matching record."
        ),
    )


class ParticipationFactorModel(BaseModel):
    """One per-state participation factor row entry."""

    model_config = ConfigDict(extra="forbid")

    state_name: str = Field(..., description="Reduced-state label.")
    factor: float = Field(
        ...,
        description=(
            "Participation factor magnitude. By ANDES convention "
            "(``calc_pfactor`` in routines/eig.py) these are real-valued."
        ),
    )


class EigParticipationResponse(BaseModel):
    """Wire shape of ``GET /sessions/{id}/eig/modes/{mode_idx}/participation``."""

    model_config = ConfigDict(extra="forbid")

    mode_idx: int = Field(
        ..., description="Echo of the requested mode index.", ge=0
    )
    participation: list[ParticipationFactorModel] = Field(
        ...,
        description=(
            "Per-state participation factor row for the requested mode. "
            "Length equals the EIG result's ``state_count``."
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
    → 409, ``EigPrerequisiteError`` → 409, ``ElementNotFoundError`` → 404,
    ``EigComputationError`` → 422, ``SetupFailedError`` → 422), recovery, and the
    body shape. This route only appends the documented "reload to recover" hint to
    ``SetupFailedError``'s detail.
    """
    if exc.category == "SetupFailedError":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to recover."
        )
    return map_worker_error(exc)


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/eig",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="runEig",
    summary="Run eigenvalue analysis (small-signal stability) on the session.",
    response_model=EigResultResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case loaded OR the session has no converged PFlow result. "
                "Run /pflow first; ``EIG._pre_check`` only warns and would "
                "otherwise crash with a non-actionable TypeError."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES eigenvalue routine raised (e.g., singular Jacobian "
                "after regularization)."
            ),
        },
    },
)
async def run_eig(
    session_id: str,
    body: EigRunRequest,
    request: Request,
) -> EigResultResponse:
    """Synchronously run ``ss.EIG.run()`` and return the result.

    Side-effect note: ANDES mutates ``dae.t`` to 0 and sets
    ``TDS.initialized=True`` as part of EIG's pre-check. The response's
    ``tds_initialized`` field surfaces this so the UI can render an
    info banner ("Running EIG initialised the dynamic state...").
    """
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "eig", request_summary=body.model_dump()
        ) as job_id:
            args: dict[str, Any] = {}
            if body.load_model is not None:
                args["load_model"] = body.load_model
            payload = await mgr.invoke(session_id, "run_eig", args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for run_eig: "
                f"{type(payload).__name__}"
            ),
        )
    eigenvalues = [
        ComplexNumberModel(real=float(z["real"]), imag=float(z["imag"]))
        for z in payload.get("eigenvalues") or []
    ]
    return EigResultResponse(
        eigenvalues=eigenvalues,
        damping_ratios=[float(d) for d in payload.get("damping_ratios") or []],
        frequencies_hz=[float(f) for f in payload.get("frequencies_hz") or []],
        mode_count=int(payload.get("mode_count", 0)),
        state_count=int(payload.get("state_count", 0)),
        state_names=[str(n) for n in payload.get("state_names") or []],
        tds_initialized=bool(payload.get("tds_initialized", False)),
        load_model=(
            None if payload.get("load_model") is None else str(payload.get("load_model"))
        ),
        notes=[str(n) for n in payload.get("notes") or []],
        job_id=job_id,
    )


@router.post(
    "/sessions/{session_id}/eig/sweep",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="runEigSweep",
    summary=(
        "Eigenvalues at each of a list of values of one parameter of one device "
        "(root loci data)."
    ),
    response_model=EigSweepResponse,
    responses={
        404: {
            "model": ProblemDetails,
            "description": (
                "Session not found or already closed, OR the case has no such "
                "model, device or parameter."
            ),
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "No case loaded OR the session has no converged power flow. "
                "Run /pflow first: the sweep solves each point's power flow "
                "with that run's settings."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The values are not 1 to 200 finite numbers, OR a point failed: "
                "its system did not set up, its power flow did not converge, the "
                "eigenvalue routine failed, or it has another number of "
                "eigenvalues than the first point. The detail names the value."
            ),
        },
    },
)
async def run_eig_sweep(
    session_id: str,
    body: EigSweepRequest,
    request: Request,
) -> EigSweepResponse:
    """Take the eigenvalues at each value of one parameter of one device.

    Synchronous, like ``POST /eig``, and run as a job of kind ``eig``. Each
    value is a read, a setup, a power flow and an eigenvalue analysis of the
    case, so the time grows with the number of values; the session's own
    System is not touched.
    """
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "eig", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(
                session_id,
                "run_eig_sweep",
                {
                    "model": body.model,
                    "idx": body.idx,
                    "param": body.param,
                    "values": list(body.values),
                },
            )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for run_eig_sweep: "
                f"{type(payload).__name__}"
            ),
        )
    points = [
        EigSweepPointModel(
            value=float(point["value"]),
            eigenvalues=[
                ComplexNumberModel(real=float(z["real"]), imag=float(z["imag"]))
                for z in point.get("eigenvalues") or []
            ],
            damping_ratios=[float(d) for d in point.get("damping_ratios") or []],
            frequencies_hz=[float(f) for f in point.get("frequencies_hz") or []],
        )
        for point in payload.get("points") or []
    ]
    return EigSweepResponse(
        model=str(payload.get("model", body.model)),
        idx=str(payload.get("idx", body.idx)),
        param=str(payload.get("param", body.param)),
        points=points,
        mode_count=int(payload.get("mode_count", 0)),
        tds_initialized=bool(payload.get("tds_initialized", False)),
        job_id=job_id,
    )


@router.get(
    "/sessions/{session_id}/eig/modes/{mode_idx}/participation",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="getEigParticipation",
    summary="Per-mode participation factor row for the given mode index.",
    response_model=EigParticipationResponse,
    responses={
        404: {
            "model": ProblemDetails,
            "description": (
                "Session not found, OR ``mode_idx`` is out of range for "
                "the current EIG result."
            ),
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "EIG has not been run on this session — POST /eig first."
            ),
        },
    },
)
async def get_eig_participation(
    session_id: str,
    mode_idx: int,
    request: Request,
) -> EigParticipationResponse:
    """Slice ``EIG.pfactors[mode_idx]`` and return the per-state row.

    Substrate-side slice: there is no per-mode lazy API in ANDES. The
    full ``pfactors`` matrix is held in memory after EIG.run.
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(
            session_id,
            "eig_participation",
            {"mode_idx": int(mode_idx)},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for eig_participation: "
                f"{type(payload).__name__}"
            ),
        )
    rows: list[ParticipationFactorModel] = []
    for entry in payload.get("participation") or []:
        rows.append(
            ParticipationFactorModel(
                state_name=str(entry["state_name"]),
                factor=float(entry["factor"]),
            )
        )
    return EigParticipationResponse(
        mode_idx=int(payload.get("mode_idx", mode_idx)),
        participation=rows,
    )


@router.get(
    "/sessions/{session_id}/eig/state-matrix.mat",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="getEigStateMatrix",
    summary="Download EIG.As + EIG.mu as a .mat file.",
    response_class=Response,
    responses={
        200: {
            "content": {"application/octet-stream": {}},
            "description": (
                "MATLAB v5 ``.mat`` file containing ``As`` (state matrix) and "
                "``mu`` (eigenvalue vector). Consumed by the UI's MAT exporter."
            ),
        },
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "EIG has not been run on this session — POST /eig first.",
        },
    },
)
async def get_eig_state_matrix(
    session_id: str,
    request: Request,
) -> Response:
    """Return ``EIG.As`` (and ``EIG.mu``) as a ``.mat`` blob.

    Format is MATLAB v5 (compressed). The full matrix is shipped as a
    download because for non-trivial cases (NPCC 140 → 334×334) inline
    JSON would balloon the response unnecessarily.
    """
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(session_id, "eig_state_matrix", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    if not isinstance(payload, (bytes, bytearray)):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-bytes payload for eig_state_matrix: "
                f"{type(payload).__name__}"
            ),
        )
    filename = f"andes-eig-{session_id[:8]}.mat"
    return Response(
        content=bytes(payload),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
