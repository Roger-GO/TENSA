"""Snapshot + reproducibility-bundle endpoints (Units 3 and 7 of the v2.0 plan).

This module hosts:

- ``POST /sessions/{id}/bundle/export`` (Unit 3): streams a ``.zip``
  reproducibility bundle to the caller.
- ``POST /sessions/{id}/snapshot`` (Unit 7): save a snapshot.
- ``POST /sessions/{id}/snapshot/restore`` (Unit 7): restore a snapshot.
- ``GET /sessions/{id}/snapshots`` (Unit 7): list snapshots for the case.
- ``DELETE /sessions/{id}/snapshot/{name}`` (Unit 7): delete a snapshot.

The bundle assembly orchestrator lives in ``andes_app.core.bundle``; the
snapshot orchestrator lives in ``andes_app.core.snapshot``. This module
is only the HTTP-shape glue (auth, request-body validation, worker
dispatch, error mapping).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from andes_app.api._run_as_job import _run_as_job
from andes_app.api.auth import RequireToken
from andes_app.api.error_mapping import map_worker_error
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


def _to_http_error(exc: WorkerError) -> HTTPException:
    """Bundle-export adapter over the shared ``map_worker_error`` (Unit 4b).

    The shared mapper owns the canonical category→status table, recovery, and the
    body shape. The bundle-export route carries one documented per-route delta
    (audit #6): a wide 422 bucket — ``ElementValidationError`` / ``CaseLoadError``
    (both canonical 422) PLUS the bare ``AndesAppError`` category, which is NOT in
    the shared table (it would 500) and is **overridden to 422** here — all with the
    "roundtrip-capable case (reload to recover)" hint appended. ``no-case-loaded``
    → 409 and everything else → 500 come straight from the shared mapper.
    """
    if exc.category in {"ElementValidationError", "CaseLoadError", "AndesAppError"}:
        exc.detail = (
            f"{exc.detail} — bundle export needs a roundtrip-capable case "
            "(reload to recover)."
        )
        if exc.category == "AndesAppError":
            # Audit #6 override: the bare ``AndesAppError`` category is unmapped in
            # the shared table (a deliberate 500 default + log). Build the 422 body
            # directly so the legitimate export-failure path neither 500s nor emits
            # the shared mapper's "unmapped category" error log. ``AndesAppError``'s
            # ``recovery_kind`` is the base ``None`` → no CTA, matching the original.
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"detail": exc.detail, "recovery": None},
            )
        # ElementValidationError / CaseLoadError already resolve to 422 in the
        # shared table; route through it to pick up their per-class recovery.
        return map_worker_error(exc)
    return map_worker_error(exc)


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/bundle/export",
    openapi_extra={"x-andes-app-gui-location": "bundle-dialog"},
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

    # request_summary drops the (potentially large) ``results_csv`` body — the
    # activity-panel Retry only needs the user-facing knobs, not the CSV blob.
    summary = body.model_dump(exclude={"results_csv"})

    try:
        async with _run_as_job(
            mgr, session_id, "bundle-export", request_summary=summary
        ) as job_id:
            payload = await mgr.invoke(session_id, "export_bundle", args)
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
                "worker returned a non-bytes payload for export_bundle: "
                f"{type(payload).__name__}"
            ),
        )

    # Suggest a filename — the client's BundleExportDialog overrides it
    # locally before triggering the download, but the header is still
    # the right thing to ship for direct-curl callers. The binary body can't
    # carry a ``job_id`` JSON field, so the mirrored job id rides an
    # ``X-Job-Id`` header (additive; the JobRecord is the source of truth).
    filename = f"andes-bundle-{session_id[:8]}.zip"
    return Response(
        content=bytes(payload),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Job-Id": job_id,
        },
    )


# ---- snapshot endpoints (Unit 7) ------------------------------------------


class SaveSnapshotRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/snapshot``."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        ...,
        description=(
            "Snapshot name. 1-64 chars of [A-Za-z0-9._-] starting with "
            "an alphanumeric. Names are unique per case; collisions return "
            "409 unless ``force=true``."
        ),
    )
    force: bool = Field(
        False,
        description=(
            "When True, overwrite any existing snapshot under the same "
            "name. Default False rejects collisions with 409 so the UI "
            "can prompt the user."
        ),
    )


class SnapshotMetadataModel(BaseModel):
    """Sidecar JSON metadata shape echoed in save/restore/list responses."""

    model_config = ConfigDict(extra="allow")

    andes_version: str
    andes_app_version: str
    case_filename: str | None
    case_sha256: str | None
    disturbance_log: list[dict[str, Any]] = Field(default_factory=list)
    saved_at: str
    has_pflow: bool
    has_tds: bool


class SaveSnapshotResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/snapshot``."""

    model_config = ConfigDict(extra="forbid")

    name: str
    metadata: SnapshotMetadataModel
    dill_bytes: int = Field(
        ..., description="Size of the dill blob on disk, in bytes."
    )
    metadata_bytes: int = Field(
        ..., description="Size of the sidecar JSON on disk, in bytes."
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the snapshot-save routine (v3.1 Unit "
            "5b, kind ``snapshot-save``). ``null`` on legacy responses."
        ),
    )


class RestoreSnapshotRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/snapshot/restore``."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="Snapshot name to restore.")
    use_dill_optimization: bool = Field(
        True,
        description=(
            "When True (default), attempt to skip the PF re-solve by "
            "loading the dill blob via ``andes.utils.snapshot.load_ss``. "
            "Falls back to the always-works replay+PF path on ANDES "
            "version mismatch or a missing dill blob; the response's "
            "``fallback_reason`` carries the explanation."
        ),
    )


class RestoreSnapshotResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/snapshot/restore``."""

    model_config = ConfigDict(extra="forbid")

    used_dill: bool = Field(
        ...,
        description=(
            "True when the dill optimisation succeeded. False means the "
            "always-works replay+PF path was taken; ``fallback_reason`` "
            "is non-null."
        ),
    )
    fallback_reason: str | None = Field(
        None,
        description=(
            "Human-readable explanation when ``used_dill=False`` despite "
            "``use_dill_optimization=True``. Surfaced inline in the load "
            "dialog so the user understands why a fallback fired."
        ),
    )
    disturbances_replayed: int = Field(
        ...,
        description=(
            "Count of disturbance specs re-applied from the snapshot "
            "metadata onto the new System."
        ),
    )
    metadata: SnapshotMetadataModel
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the snapshot-restore routine (v3.1 Unit "
            "5b, kind ``snapshot-restore``). Recorded in the manager-wide "
            "global registry (KTD-20) so it survives the session being "
            "replaced, yet still surfaces via "
            "``GET /sessions/{id}/jobs/{job_id}``. ``null`` on legacy responses."
        ),
    )


class SnapshotListEntry(BaseModel):
    """One entry in the ``GET /sessions/{id}/snapshots`` response."""

    model_config = ConfigDict(extra="forbid")

    name: str
    saved_at: str
    has_pflow: bool
    has_tds: bool
    has_dill: bool = Field(
        ...,
        description=(
            "Whether the dill blob is present on disk. False when only "
            "the sidecar JSON survives (e.g., manual half-delete) — the "
            "snapshot is still restorable via the slow replay path."
        ),
    )
    andes_version: str
    disturbance_count: int


class ListSnapshotsResponse(BaseModel):
    """Response body for ``GET /sessions/{id}/snapshots``."""

    model_config = ConfigDict(extra="forbid")

    snapshots: list[SnapshotListEntry] = Field(default_factory=list)


def _map_snapshot_error(exc: WorkerError) -> HTTPException:
    """Translate snapshot-specific worker error categories into HTTP responses.

    - ``SnapshotNotFoundError`` → 404 (snapshot doesn't exist).
    - ``SnapshotCollisionError`` → 409 (name already taken).
    - ``SnapshotMetadataError`` / ``SnapshotVersionMismatchError`` /
      ``SetupFailedError`` → 422 (corrupt metadata, version mismatch on
      forced dill load, save-time failure inside ANDES).
    - ``no-case-loaded`` → 409 (snapshot ops scope to a loaded case).
    - Anything else → 500.
    """
    if exc.category == "SnapshotNotFoundError":
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=exc.detail,
        )
    if exc.category == "SnapshotCollisionError":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{exc.detail} — re-issue with ``force=true`` to "
                "overwrite, or pick a different name."
            ),
        )
    if exc.category in {
        "SnapshotMetadataError",
        "SnapshotVersionMismatchError",
        "SetupFailedError",
        "DisturbanceValidationError",
    }:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.detail,
        )
    if exc.category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{exc.category}: {exc.detail}",
    )


@router.post(
    "/sessions/{session_id}/snapshot",
    openapi_extra={"x-andes-app-gui-location": "snapshot-dialog"},
    operation_id="saveSnapshot",
    summary="Save the current operating point as a named snapshot.",
    response_model=SaveSnapshotResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "Snapshot name collision (re-issue with ``force=true``) "
                "OR no case loaded yet."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": "Invalid snapshot name or save-time failure inside ANDES.",
        },
    },
)
async def save_snapshot(
    session_id: str,
    body: SaveSnapshotRequest,
    request: Request,
    _: RequireToken,
) -> SaveSnapshotResponse:
    """Save snapshot endpoint — Unit 7.

    Composes ANDES's ``andes.utils.snapshot.save_ss`` (dill blob) plus
    sidecar JSON metadata under
    ``<workspace>/snapshots/<case_basename>/<name>.{dill,json}``.
    """
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "snapshot-save", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(
                session_id,
                "save_snapshot",
                {"name": body.name, "force": body.force},
                timeout=60.0,
            )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_snapshot_error(exc) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for save_snapshot: "
                f"{type(payload).__name__}"
            ),
        )
    return SaveSnapshotResponse(**payload, job_id=job_id)


@router.post(
    "/sessions/{session_id}/snapshot/restore",
    openapi_extra={"x-andes-app-gui-location": "snapshot-dialog"},
    operation_id="restoreSnapshot",
    summary="Restore a previously-saved snapshot onto the session.",
    response_model=RestoreSnapshotResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session or snapshot not found."},
        409: {
            "model": ProblemDetails,
            "description": "No case loaded — restore needs a case to scope the snapshot directory.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Invalid snapshot name OR corrupt metadata OR version "
                "mismatch on forced dill restore."
            ),
        },
    },
)
async def restore_snapshot(
    session_id: str,
    body: RestoreSnapshotRequest,
    request: Request,
    _: RequireToken,
) -> RestoreSnapshotResponse:
    """Restore snapshot endpoint — Unit 7.

    Always replays the snapshot's ``disturbance_log`` from the sidecar
    JSON; either substitutes the dill-loaded System (fast path, when the
    ANDES version matches) or re-runs ``setup`` + ``PFlow.run`` (slow
    path, the always-works fallback).
    """
    mgr = _manager(request)
    try:
        # Session-MUTATING (KTD-20): restore replaces the session's System, so
        # the record lives in the manager-wide global registry to survive it.
        async with _run_as_job(
            mgr,
            session_id,
            "snapshot-restore",
            request_summary=body.model_dump(),
            use_global_registry=True,
        ) as job_id:
            payload = await mgr.invoke(
                session_id,
                "restore_snapshot",
                {
                    "name": body.name,
                    "use_dill_optimization": body.use_dill_optimization,
                },
                timeout=120.0,
            )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_snapshot_error(exc) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for restore_snapshot: "
                f"{type(payload).__name__}"
            ),
        )
    return RestoreSnapshotResponse(**payload, job_id=job_id)


@router.get(
    "/sessions/{session_id}/snapshots",
    openapi_extra={"x-andes-app-gui-location": "snapshot-dialog"},
    operation_id="listSnapshots",
    summary="List snapshots saved against the current case.",
    response_model=ListSnapshotsResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def list_snapshots(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> ListSnapshotsResponse:
    """List snapshots for the current case.

    Empty list (200, ``{"snapshots": []}``) when no case is loaded, no
    snapshots have been saved, or the workspace lacks a snapshots
    directory. The route does NOT 404 on "no case loaded" — the UI's
    "Load snapshot…" menu wants to render an empty state cleanly.
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "list_snapshots", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_snapshot_error(exc) from exc

    if not isinstance(payload, list):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-list payload for list_snapshots: "
                f"{type(payload).__name__}"
            ),
        )
    return ListSnapshotsResponse(
        snapshots=[SnapshotListEntry(**e) for e in payload if isinstance(e, dict)]
    )


@router.delete(
    "/sessions/{session_id}/snapshot/{name}",
    openapi_extra={"x-andes-app-gui-location": "snapshot-dialog"},
    operation_id="deleteSnapshot",
    summary="Delete a snapshot by name.",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session or snapshot not found."},
        409: {
            "model": ProblemDetails,
            "description": "No case loaded — delete needs a case to scope the snapshot directory.",
        },
        422: {
            "model": ProblemDetails,
            "description": "Invalid snapshot name.",
        },
    },
)
async def delete_snapshot(
    session_id: str,
    name: str,
    request: Request,
    _: RequireToken,
) -> Response:
    """Delete snapshot endpoint — Unit 7."""
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "snapshot-delete", request_summary={"name": name}
        ) as job_id:
            await mgr.invoke(session_id, "delete_snapshot", {"name": name})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_snapshot_error(exc) from exc
    # 204 has no JSON body; the mirrored job id rides an ``X-Job-Id`` header.
    return Response(
        status_code=status.HTTP_204_NO_CONTENT,
        headers={"X-Job-Id": job_id},
    )
