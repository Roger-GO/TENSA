"""Snapshot + reproducibility-bundle endpoints (Unit 3 of the v2.0 plan).

This module hosts the ``POST /sessions/{id}/bundle/export`` endpoint that
streams a ``.zip`` reproducibility bundle to the caller. The full snapshot
save/load lifecycle (Unit 7) extends this same module with new endpoints;
Unit 3 ships only the bundle-export half.

The bundle assembly orchestrator lives in ``andes_app.core.bundle``; this
module is only the HTTP-shape glue (auth, request-body validation, worker
dispatch, error mapping, streaming response).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import ProblemDetails
from andes_app.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)

router = APIRouter()


# ---- request / response models --------------------------------------------


class BundleSimParams(BaseModel):
    """Sim-params subset embedded in ``sim_params.json`` of the bundle.

    Mirrors the fields the ``RunStream`` start-tds message ships. All
    fields are optional so a partially-populated client (e.g., a
    pre-Unit-7 session) can still produce a bundle.
    """

    model_config = ConfigDict(extra="allow")

    tf: float | None = Field(
        None, description="Final sim time of the last TDS run, in seconds."
    )
    h: float | None = Field(
        None,
        description=(
            "Fixed integration step of the last TDS run, in seconds. "
            "``null`` when the substrate's adaptive integrator was used."
        ),
    )
    vars: list[str] | None = Field(
        None,
        description=(
            "Variable groups streamed during the last run "
            "(e.g., ``[\"bus_v\", \"gen_state\"]``)."
        ),
    )
    decimation: str | None = Field(
        None,
        description="Decimation mode used during streaming (``none`` or ``mean``).",
    )
    max_rate_hz: float | None = Field(
        None,
        description="Output-rate clamp (Hz) the UI applied to the stream.",
    )


class BundleExportRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/bundle/export``.

    All fields are optional — the substrate happily exports a minimal
    bundle (case + manifest only) when none are present. The substrate
    contributes the case file, the ANDES + ``andes_app`` versions, and
    the manifest; this body carries the substrate-external state that
    lives in the frontend's runs / disturbance / ui slices today.
    """

    model_config = ConfigDict(extra="forbid")

    disturbances: list[FaultSpec | ToggleSpec | AlterSpec] = Field(
        default_factory=list,
        description=(
            "Disturbance specs (the discriminated union) the user composed "
            "in the timeline editor. Empty list when no disturbances were "
            "registered; ``disturbances.json`` is omitted from the bundle in "
            "that case."
        ),
    )
    sim_params: BundleSimParams | None = Field(
        None,
        description=(
            "Last TDS run's sim params. ``null`` when no run has fired yet; "
            "``sim_params.json`` is omitted from the bundle in that case."
        ),
    )
    results_csv: str | None = Field(
        None,
        description=(
            "Last TDS run's results as a long-form CSV body. ``null`` when "
            "no run has fired yet OR the caller chose not to ship the body. "
            "When omitted, ``results.csv`` is absent from the bundle but the "
            "run is still reproducible from case + disturbances + sim_params."
        ),
    )
    run_id: str | None = Field(
        None,
        description=(
            "Run id of the most recent TDS run. Surfaced in the manifest "
            "for cross-referencing with run-history exports."
        ),
    )


# ---- helpers ---------------------------------------------------------------


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


def _map_worker_error(exc: WorkerError) -> HTTPException:
    """Translate worker error categories into HTTP responses for this endpoint.

    The bundle endpoint can fail in three substantively-different ways:

    - ``no-case-loaded`` → 409 (the user's session has no case to bundle).
    - ``ElementValidationError`` / ``CaseLoadError`` → 422 (the canonical
      xlsx export went wrong, e.g., elements ANDES can't roundtrip; the
      detail copy points at the actionable next step).
    - Anything else → 500 (genuine server bug).
    """
    if exc.category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if exc.category in {
        "ElementValidationError",
        "CaseLoadError",
        "AndesAppError",
    }:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{exc.detail} — bundle export needs a roundtrip-capable case "
                "(reload to recover)."
            ),
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{exc.category}: {exc.detail}",
    )


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/bundle/export",
    operation_id="exportBundle",
    summary="Export a reproducibility bundle (.zip) for the current session.",
    response_class=Response,
    responses={
        200: {
            "content": {"application/zip": {}},
            "description": (
                "Bundle stream. Body is a ``.zip`` containing case + "
                "disturbances.json + sim_params.json + results.csv + "
                "manifest.json (each optional except case + manifest). "
                "Per KTD-5; snapshots are NOT included."
            ),
        },
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The substrate could not produce a canonical xlsx export "
                "for the dirty case (elements ANDES can't roundtrip)."
            ),
        },
    },
)
async def export_bundle(
    session_id: str,
    body: BundleExportRequest,
    request: Request,
    _: RequireToken,
) -> Response:
    """Assemble a reproducibility-bundle ``.zip`` and return it as a stream.

    The substrate gathers the case file (verbatim or canonical xlsx),
    builds the manifest, and zips the lot together with the
    request-body-supplied disturbances / sim_params / results.csv. The
    response is the raw zip bytes with ``Content-Type: application/zip``
    and a ``Content-Disposition`` header that suggests a sensible
    filename.

    Snapshots (dill payloads) are explicitly NOT in the bundle per
    KTD-4 + KTD-5 — they're version-locked and undermine portability.
    """
    mgr = _manager(request)

    args: dict[str, Any] = {
        "disturbances": [d.model_dump() for d in body.disturbances],
        "sim_params": body.sim_params.model_dump() if body.sim_params is not None else None,
        "results_csv": body.results_csv,
        "run_id": body.run_id,
    }

    try:
        payload = await mgr.invoke(session_id, "export_bundle", args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc

    if not isinstance(payload, (bytes, bytearray)):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-bytes payload for export_bundle: "
                f"{type(payload).__name__}"
            ),
        )

    # Suggest a filename — the client's BundleExportDialog overrides it
    # locally before triggering the download, but the header is still
    # the right thing to ship for direct-curl callers.
    filename = f"andes-bundle-{session_id[:8]}.zip"
    return Response(
        content=bytes(payload),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
