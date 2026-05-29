"""Eigenvalue analysis endpoints (Unit 6 of the v2.0 plan).

Three routes:

- ``POST /sessions/{id}/eig`` — runs ``ss.EIG.run()`` synchronously and
  returns the eigenvalues / damping ratios / mode metadata. Substrate
  gates on ``ss.PFlow.converged is True`` independently because
  ANDES's own ``EIG._pre_check`` only logs a warning before falling
  through to a crash (verified in Unit 1a spike).
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

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from andes_app.api.auth import RequireToken
from andes_app.api.error_mapping import map_worker_error
from andes_app.api.schemas import ProblemDetails
from andes_app.core.session import (
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
            "out-of-band complex encoding."
        ),
    )
    damping_ratios: list[float] = Field(
        ...,
        description=(
            "Per-mode damping ratio ``-Re(z) / |z|``. Index-aligned "
            "with ``eigenvalues``. NaN-collapsed to 0.0 so the wire "
            "payload never carries non-finite floats."
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
    operation_id="runEig",
    summary="Run eigenvalue analysis (small-signal stability) on the session.",
    response_model=EigResultResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
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
    body: EigRunRequest,  # noqa: ARG001 — accepted for forward-compat
    request: Request,
    _: RequireToken,
) -> EigResultResponse:
    """Synchronously run ``ss.EIG.run()`` and return the result.

    Side-effect note: ANDES mutates ``dae.t`` to 0 and sets
    ``TDS.initialized=True`` as part of EIG's pre-check. The response's
    ``tds_initialized`` field surfaces this so the UI can render an
    info banner ("Running EIG initialised the dynamic state...").
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "run_eig", {})
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
    )


@router.get(
    "/sessions/{session_id}/eig/modes/{mode_idx}/participation",
    operation_id="getEigParticipation",
    summary="Per-mode participation factor row for the given mode index.",
    response_model=EigParticipationResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
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
    _: RequireToken,
) -> EigParticipationResponse:
    """Slice ``EIG.pfactors[mode_idx]`` and return the per-state row.

    Substrate-side slice — there is no per-mode lazy API in ANDES (per
    Unit 1a spike). The full ``pfactors`` matrix is held in memory
    after EIG.run.
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
    operation_id="getEigStateMatrix",
    summary="Download EIG.As + EIG.mu as a .mat file.",
    response_class=Response,
    responses={
        200: {
            "content": {"application/octet-stream": {}},
            "description": (
                "MATLAB v5 ``.mat`` file containing ``As`` (state matrix) and "
                "``mu`` (eigenvalue vector). Consumed by the UI's MAT exporter "
                "(Unit 2)."
            ),
        },
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
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
    _: RequireToken,
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
