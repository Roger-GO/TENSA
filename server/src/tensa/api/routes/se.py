"""State estimation endpoints (Unit 13 of the v2.0 plan).

Two routes:

- ``POST /sessions/{id}/se/measurements/generate`` — builds the default
  ``Measurements`` set (bus voltages + bus injections) from the
  converged PF solution and stores it on the substrate worker. Returns
  the measurement count so the UI can show "N measurements ready"
  before committing to the SE iteration cost.
- ``POST /sessions/{id}/se`` — runs ``ss.SE.run()`` against the
  previously-generated measurement set and returns convergence stats +
  per-measurement residuals + flagged-bad-data indices.

Substrate gates on ``ss.PFlow.converged is True`` independently because
ANDES's own ``SE.init`` only logs an error before returning False
(verified in Unit 1a spike, mirroring the EIG / CPF gating discipline).
The two-step split is intentional — the user can inspect the
measurement count, decide whether to add more measurements (deferred to
a later unit's UI), and only then commit to the WLS iteration.
"""

from __future__ import annotations

from typing import Literal

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


class SeGenerateMeasurementsRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/se/measurements/generate``.

    Only optional knob is the noise seed — pinning the seed makes runs
    reproducible across browser refreshes (useful for the UI's
    "Generate measurements" button).
    """

    model_config = ConfigDict(extra="forbid")

    noise_seed: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Optional non-negative integer seed for the Gaussian-noise "
            "draw inside ``Measurements.generate_from_pflow``. ``None`` "
            "(default) uses an unseeded ``np.random.default_rng``; pinning "
            "the seed lets the UI re-generate the same measurement set "
            "across page refreshes. ``ge=0`` because numpy's "
            "``default_rng`` rejects negative seeds — a clean 422 here "
            "beats a misleading non-convergent error downstream."
        ),
    )


class SeRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/se``.

    Every field is optional and applies to this run only; a body that
    names none behaves exactly as before (WLS with the case's
    ``SE.config`` defaults and the generate step's noise draw). Kept as
    a model with ``extra="forbid"`` so typos are rejected forward-
    compatibly.
    """

    model_config = ConfigDict(extra="forbid")

    algorithm: Literal["wls", "lav"] | None = Field(
        default=None,
        description=(
            "The estimator. ``\"wls\"`` (default) is weighted least "
            "squares (Gauss-Newton); ``\"lav\"`` is least absolute "
            "value via iteratively reweighted least squares, robust to "
            "gross measurement errors. LAV converges linearly and often "
            "needs more than the default 100 iterations when a measurement "
            "is bad, so raise ``max_iter`` with it (a run that runs out "
            "answers 422). The chi-squared test is only computed for WLS."
        ),
    )
    tol: float | None = Field(
        default=None,
        gt=0,
        description=(
            "Convergence tolerance on the max absolute state correction "
            "for this run only. ``None`` keeps the case's "
            "``SE.config.tol`` (ANDES default 1e-4)."
        ),
    )
    max_iter: int | None = Field(
        default=None,
        ge=1,
        description=(
            "Maximum iterations for this run only. ``None`` keeps the "
            "case's ``SE.config.max_iter`` (ANDES default 100)."
        ),
    )
    noise_seed: int | None = Field(
        default=None,
        ge=0,
        description=(
            "When set, this run's measurement values are drawn afresh "
            "from the power flow solution with this seed (the noise is "
            "drawn here, as the generate step draws it), over the cached "
            "set's measurements and sigmas; the cached values are left as "
            "the generate step made them. The same seed gives the same "
            "run. ``None`` runs on the cached values."
        ),
    )


class SeRunSettings(BaseModel):
    """The settings a state-estimation run used: the request's where it gave
    one, the case's ``SE.config`` (ANDES's default unless the case file sets
    one) where it did not."""

    model_config = ConfigDict(extra="forbid")

    tol: float = Field(
        ...,
        description="Convergence tolerance on the max absolute state correction.",
    )
    max_iter: int = Field(..., description="Iteration limit.")
    noise_seed: int | None = Field(
        default=None,
        description=(
            "The seed this run's measurement noise was drawn with; ``null`` "
            "when the run used the cached values from the generate step."
        ),
    )


class ChiSquaredTest(BaseModel):
    """The chi-squared bad-data test on the SE objective ``J`` (WLS only)."""

    model_config = ConfigDict(extra="forbid")

    passed: bool = Field(
        ...,
        description=(
            "``True`` when ``J`` is below the threshold: no bad data "
            "detected at this confidence."
        ),
    )
    J: float = Field(
        ...,
        description=(
            "The WLS objective ``sum(r_i^2 / sigma_i^2)`` the test ran on "
            "(equal to ``mismatch``)."
        ),
    )
    threshold: float = Field(
        ...,
        description=(
            "The chi-squared quantile at ``confidence`` with ``dof`` degrees "
            "of freedom; ``J`` is compared against it."
        ),
    )
    dof: int = Field(
        ...,
        description=(
            "Degrees of freedom, ``measurement_count - 2 * <bus count>``; "
            "``measurement_count`` includes the angle-reference "
            "pseudo-measurement, which stands in for the one state it fixes."
        ),
    )
    confidence: float = Field(
        ...,
        description="The confidence level the threshold was taken at (0.95).",
    )


class SeMeasurementsGeneratedResponse(BaseModel):
    """Wire shape of ``POST /sessions/{id}/se/measurements/generate``."""

    model_config = ConfigDict(extra="forbid")

    count: int = Field(
        ...,
        description=(
            "Number of scalar measurements in the substrate's "
            "``Measurements`` object. For IEEE 14: 14 bus voltage "
            "measurements + 28 bus injection (P+Q for each bus) = 42. "
            "Note: ``SE.init`` adds an angle-reference pseudo-"
            "measurement at the slack bus on the first ``run_se`` "
            "call, so the eventual ``SeResult.residuals`` length will "
            "be one greater per island."
        ),
        ge=0,
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the SE measurement-generation routine "
            "(kind ``se-measurements``). "
            "``GET /sessions/{id}/jobs/{job_id}`` returns the matching record; "
            "``null`` on legacy responses."
        ),
    )


class SeResultResponse(BaseModel):
    """Wire shape of ``POST /sessions/{id}/se``.

    Field semantics mirror :class:`tensa.core.se_result.SeResult`
    1:1; see that class for prose.
    """

    model_config = ConfigDict(extra="forbid")

    converged: bool = Field(
        ...,
        description=(
            "``True`` when ANDES's ``SE.run`` returned True (Gauss-"
            "Newton residual fell below ``config.tol`` within "
            "``config.max_iter``). ``False`` cases are surfaced as 422 "
            "errors rather than ``converged=false`` payloads — the UI "
            "always sees a converged result on a 200."
        ),
    )
    iterations: int = Field(
        ...,
        description=(
            "Number of iterations to convergence (Gauss-Newton for WLS, "
            "reweighted steps for LAV). "
            "ANDES's ``result['n_iter']`` is 1-indexed; echoed verbatim."
        ),
        ge=0,
    )
    mismatch: float = Field(
        ...,
        description=(
            "Final objective ``J``: for WLS ``sum(r^2 / sigma^2)``, which "
            "``chi_squared`` tests against its distribution; for LAV "
            "``sum(|r| / sigma)``. Smaller is better."
        ),
    )
    residuals: list[float] = Field(
        ...,
        description=(
            "Per-measurement residuals ``z - h(x_est)``. Length equals "
            "``measurement_count``. The UI bins these into a histogram."
        ),
    )
    measurement_count: int = Field(
        ...,
        description=(
            "Total measurements (including the angle-reference pseudo-"
            "measurement that ``SE.init`` injects). Equal to "
            "``len(residuals)``. Surfaced as a separate field so the "
            "UI's histogram doesn't have to derive it from the array "
            "length."
        ),
        ge=0,
    )
    flagged_indices: list[int] = Field(
        ...,
        description=(
            "Indices into ``residuals`` whose normalised residual "
            "``|r_i| / sigma_i`` exceeds 3-sigma. These are candidate "
            "bad-data measurements; the UI highlights the corresponding "
            "histogram bars in red."
        ),
    )
    algorithm: Literal["wls", "lav"] | None = Field(
        default=None,
        description=(
            "The estimator the run used (``\"wls\"`` or ``\"lav\"``); "
            "``null`` only from a server that predates the choice, which "
            "always ran WLS."
        ),
    )
    settings: SeRunSettings | None = Field(
        default=None,
        description=(
            "The ``tol``, ``max_iter`` and ``noise_seed`` the run used "
            "(the effective values, after any per-run override)."
        ),
    )
    chi_squared: ChiSquaredTest | None = Field(
        default=None,
        description=(
            "The chi-squared bad-data test on the objective ``J`` at 95% "
            "confidence; ``null`` for LAV runs, where ``J`` does not follow "
            "a chi-squared distribution."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the SE run routine (kind "
            "``se``). ``GET /sessions/{id}/jobs/{job_id}`` returns the matching "
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
    → 409, ``SePrerequisiteError`` → 409, ``SeUnderDeterminedError`` → 422,
    ``SeNonConvergentError`` → 422, ``SetupFailedError`` → 422), recovery, and the
    body shape. This route only appends the documented "reload to recover" hint to
    ``SetupFailedError``.
    """
    if exc.category == "SetupFailedError":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to recover."
        )
    return map_worker_error(exc)


def _generate_payload_to_response(
    payload: object, job_id: str | None = None
) -> SeMeasurementsGeneratedResponse:
    """Coerce a worker payload dict into a typed response model."""
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for SE measurement "
                f"generation: {type(payload).__name__}"
            ),
        )
    return SeMeasurementsGeneratedResponse(
        count=int(payload.get("count", 0)),
        job_id=job_id,
    )


def _se_payload_to_response(
    payload: object, job_id: str | None = None
) -> SeResultResponse:
    """Coerce a worker payload dict into a typed SeResultResponse."""
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for SE: "
                f"{type(payload).__name__}"
            ),
        )
    return SeResultResponse(
        converged=bool(payload.get("converged", False)),
        iterations=int(payload.get("iterations", 0)),
        mismatch=float(payload.get("mismatch", 0.0)),
        residuals=[float(x) for x in (payload.get("residuals") or [])],
        measurement_count=int(payload.get("measurement_count", 0)),
        flagged_indices=[int(i) for i in (payload.get("flagged_indices") or [])],
        algorithm="lav" if payload.get("algorithm") == "lav" else "wls",
        settings=(
            SeRunSettings(**payload["settings"]) if payload.get("settings") else None
        ),
        chi_squared=(
            ChiSquaredTest(**payload["chi_squared"])
            if payload.get("chi_squared")
            else None
        ),
        job_id=job_id,
    )


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/se/measurements/generate",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="generateSeMeasurements",
    summary="Generate the default SE measurement set from the converged PF solution.",
    response_model=SeMeasurementsGeneratedResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case loaded OR the session has no converged PFlow result. "
                "Run /pflow first; ``SE.init`` only logs an error and would "
                "otherwise return False with no actionable detail."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Measurement generation failed (e.g., a model lookup raised "
                "inside ``add_bus_injection``)."
            ),
        },
    },
)
async def generate_se_measurements(
    session_id: str,
    body: SeGenerateMeasurementsRequest,
    request: Request,
) -> SeMeasurementsGeneratedResponse:
    """Build the default measurement set and cache it on the worker.

    Default set mirrors ANDES's own ``SE._default_measurements``:
    ``add_bus_voltage(sigma=0.01)`` + ``add_bus_injection(sigma_p=0.02,
    sigma_q=0.03)``. The substrate caches the populated ``Measurements``
    object so a subsequent ``/se`` call doesn't have to regenerate
    noise (lets the user re-run SE against a stable measurement set).
    """
    mgr = _manager(request)
    args: dict[str, object] = {}
    if body.noise_seed is not None:
        args["noise_seed"] = body.noise_seed
    try:
        async with _run_as_job(
            mgr, session_id, "se-measurements", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(
                session_id, "generate_measurements_from_pflow", args
            )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    return _generate_payload_to_response(payload, job_id)


@router.post(
    "/sessions/{session_id}/se",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="runSe",
    summary="Run static state estimation against the cached measurement set.",
    response_model=SeResultResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case loaded OR the session has no converged PFlow result OR "
                "the substrate has no cached measurement set yet (call "
                "/se/measurements/generate first)."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Either: (a) the measurement set is under-determined (insufficient "
                "redundancy; gain matrix singular), (b) the estimator did not "
                "converge within ``config.max_iter``, or (c) an invalid option "
                "(``SeOptionError``: unknown algorithm, non-positive tol, "
                "max_iter below 1, negative seed)."
            ),
        },
    },
)
async def run_se(
    session_id: str,
    body: SeRunRequest,
    request: Request,
) -> SeResultResponse:
    """Synchronously run ``ss.SE.run()`` against the cached measurement
    set and return the result.

    Pre-conditions enforced by the substrate (mapped to 409):

    - ``ss.PFlow.converged is True`` — independent gate (ANDES warns
      but doesn't short-circuit).
    - The substrate has a cached ``Measurements`` object from a prior
      call to ``/se/measurements/generate``.

    Failure modes mapped to 422:

    - Under-determined measurement set (gain matrix singular).
    - Estimator non-convergent within ``config.max_iter``.
    - An invalid run option (``SeOptionError``).
    """
    mgr = _manager(request)
    args: dict[str, object] = {}
    if body.algorithm is not None:
        args["algorithm"] = body.algorithm
    if body.tol is not None:
        args["tol"] = body.tol
    if body.max_iter is not None:
        args["max_iter"] = body.max_iter
    if body.noise_seed is not None:
        args["noise_seed"] = body.noise_seed
    try:
        async with _run_as_job(
            mgr, session_id, "se", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(session_id, "run_se", args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    return _se_payload_to_response(payload, job_id)
