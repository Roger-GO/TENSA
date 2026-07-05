"""Bundle-import endpoint (Unit 10 of the v2.0 plan).

Counterpart to the Unit-3 export endpoint in ``snapshot.py``. Accepts a
multipart ``.zip`` upload, validates the manifest + computes conflicts
against the workspace state, and either short-circuits with a 409 +
:class:`BundleImportPlan` for the UI to render, or commits the import
(extract case files, ``Wrapper.load_case``, replay disturbances).

Conflict resolution flow:

1. Initial POST with ``force_resolve=false`` (default). Substrate
   validates the bundle and returns either ``200 {"status":
   "committed", ...}`` (clean import) or ``409 {"status": "plan",
   "plan": {...}}`` (conflicts surfaced).
2. UI renders the conflicts via ``<BundleConflictResolver />``. User
   picks "use bundle" / "use workspace" for each. The dialog re-issues
   the POST with ``force_resolve=true`` plus the resolution flags.
3. Substrate runs the same validate path, ignores the conflict gate,
   extracts the case files honouring the resolution flags, and
   commits.

The route layer maps :class:`BundleValidationError` categories to HTTP
statuses; see :func:`_to_http_error` below.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field

from tensa.api._run_as_job import _run_as_job
from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ProblemDetails
from tensa.core.bundle import MAX_BUNDLE_BYTES
from tensa.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)

router = APIRouter()


# ---- response models -------------------------------------------------------


class BundleConflictModel(BaseModel):
    """One conflict surfaced by ``validate_bundle``."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["andes-version", "addfile-missing", "sha-mismatch"] = Field(
        ..., description="Conflict category detected while validating the bundle."
    )
    severity: Literal["warning", "blocker"] = Field(
        ...,
        description=(
            "``warning`` conflicts can be overridden with ``force_resolve``; "
            "``blocker`` conflicts prevent the import entirely."
        ),
    )
    message: str = Field(
        ..., description="Human-readable explanation of the conflict."
    )
    filename: str | None = Field(
        None,
        description="Workspace-relative case filename the conflict refers to, when applicable.",
    )
    bundle_meta: dict[str, Any] | None = Field(
        None,
        description=(
            "Side-by-side metadata for the bundle's copy of the case "
            "file. Populated for ``sha-mismatch``."
        ),
    )
    workspace_meta: dict[str, Any] | None = Field(
        None,
        description=(
            "Side-by-side metadata for the workspace's copy of the "
            "case file. Populated for ``sha-mismatch``."
        ),
    )
    bundle_andes_version: str | None = Field(
        None,
        description="ANDES version recorded in the bundle manifest. Populated for ``andes-version``.",
    )
    current_andes_version: str | None = Field(
        None,
        description="ANDES version installed on this server. Populated for ``andes-version``.",
    )


class BundleImportPlanModel(BaseModel):
    """``BundleImportPlan`` shape echoed in both plan and committed responses."""

    model_config = ConfigDict(extra="forbid")

    manifest: dict[str, Any] = Field(
        ..., description="Parsed ``manifest.json`` from the bundle, echoed verbatim."
    )
    case_files: list[str] = Field(
        ..., description="Case filenames contained in the bundle (workspace-relative)."
    )
    conflicts: list[BundleConflictModel] = Field(
        default_factory=list,
        description="Conflicts detected between the bundle and this server/workspace.",
    )
    blocked: bool = Field(
        ...,
        description="``true`` if any conflict has ``blocker`` severity — the import cannot proceed.",
    )
    has_conflicts: bool = Field(
        ..., description="``true`` if ``conflicts`` is non-empty."
    )


class BundleImportResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/bundle/import``."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["plan", "committed"] = Field(
        ...,
        description=(
            "``plan`` = conflicts present, nothing committed; the user "
            "resolves them and re-issues with ``force_resolve=true``. "
            "``committed`` = case loaded and disturbances replayed."
        ),
    )
    plan: BundleImportPlanModel = Field(
        ..., description="The validation plan (conflicts, case files, manifest)."
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Non-blocking warnings emitted during commit (e.g. overridden conflicts).",
    )
    case_filename: str | None = Field(
        None,
        description=(
            "Basename of the case file the substrate loaded. Populated "
            "on ``status=committed``; null on ``status=plan``."
        ),
    )
    addfile_filenames: list[str] = Field(
        default_factory=list,
        description=(
            "Basenames of any addfiles the substrate extracted alongside "
            "the primary case (e.g., ``ieee14.dyr`` for a PSS/E .raw + "
            ".dyr bundle). Empty on ``status=plan``."
        ),
    )
    disturbances_replayed: int = Field(
        0,
        description=(
            "Count of disturbance specs successfully re-applied to the "
            "newly-loaded System. Zero on ``status=plan``."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the bundle-import routine (v3.1 Unit "
            "5b, kind ``bundle-import``). Recorded in the manager-wide global "
            "registry (KTD-20) so it survives the session being replaced on a "
            "committed import. Present on both the ``committed`` (200) body and "
            "the ``plan`` (409) body. ``null`` on legacy responses."
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


# Mapping of BundleValidationError sub-category → HTTP status.
_BUNDLE_VALIDATION_STATUS: dict[str, int] = {
    "corrupt-zip": status.HTTP_400_BAD_REQUEST,
    "oversize": status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
    "manifest-missing": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "manifest-malformed": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "case-entry-missing": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "too-many-case-files": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "disturbances-malformed": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "bundle-blocked": status.HTTP_422_UNPROCESSABLE_ENTITY,
}


def _to_http_error(exc: WorkerError) -> HTTPException:
    """Bundle-import adapter over the shared ``map_worker_error`` (Unit 4b).

    The shared mapper owns the canonical category→status table, recovery, and the
    body shape. The bundle-import route carries one documented per-route delta
    (audit #7): ``BundleValidationError`` is shipped over the wire as
    ``"BundleValidationError:<sub-category>"`` (see worker.py), and the
    sub-category — not the bare class — decides the status (corrupt-zip → 400,
    oversize → 413, the rest → 422). We keep that per-sub-category table route-local
    and use the shared mapper only for the body/recovery shape, passing the
    ``category`` (sub) + optional ``missing_fields`` as extras and overriding the
    status. ``no-case-loaded`` → 409, the other 422 categories, and the 500 fallback
    come straight from the shared mapper.
    """
    category = exc.category or ""
    if category.startswith("BundleValidationError:"):
        sub = category.split(":", 1)[1]
        http_status = _BUNDLE_VALIDATION_STATUS.get(
            sub, status.HTTP_422_UNPROCESSABLE_ENTITY
        )
        extras: dict[str, Any] = {"category": sub}
        missing = exc.extra.get("missing_fields") if exc.extra else None
        if missing:
            extras["missing_fields"] = list(missing)
        http = map_worker_error(exc, extras=extras)
        # Audit #7 override: the sub-category drives the status (400/413/422),
        # not the shared table's flat composite default (422).
        http.status_code = http_status
        return http
    return map_worker_error(exc)


def _coerce_plan(payload: dict[str, Any]) -> BundleImportPlanModel:
    plan_raw = payload.get("plan") or {}
    return BundleImportPlanModel(
        manifest=dict(plan_raw.get("manifest") or {}),
        case_files=[str(s) for s in (plan_raw.get("case_files") or [])],
        conflicts=[
            BundleConflictModel(**c) for c in (plan_raw.get("conflicts") or [])
        ],
        blocked=bool(plan_raw.get("blocked", False)),
        has_conflicts=bool(plan_raw.get("has_conflicts", False)),
    )


# ---- route -----------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/bundle/import",
    openapi_extra={"x-tensa-gui-location": "bundle-dialog"},
    operation_id="importBundle",
    summary="Import a reproducibility bundle (.zip) into the current session.",
    response_model=BundleImportResponse,
    responses={
        400: {
            "model": ProblemDetails,
            "description": "Bundle is not a valid ZIP archive.",
        },
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "Conflicts detected (sha mismatch / version mismatch / "
                "addfile missing). Body is a ``BundleImportResponse`` "
                "with ``status='plan'`` so the UI can render the "
                "conflict resolver."
            ),
        },
        413: {
            "model": ProblemDetails,
            "description": (
                f"Bundle exceeds the {MAX_BUNDLE_BYTES}-byte cap."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Manifest malformed (missing required fields, not a JSON "
                "object, references a case file the zip doesn't have); "
                "OR disturbances.json malformed; OR caller forced "
                "resolution on a bundle with blocker conflicts."
            ),
        },
    },
)
async def import_bundle(
    session_id: str,
    request: Request,
    file: UploadFile = File(
        ...,
        description=(
            "Reproducibility bundle ``.zip`` (the same format produced "
            "by ``POST /api/sessions/{id}/bundle/export``)."
        ),
    ),
    force_resolve: bool = Form(
        False,
        description=(
            "When False (default), the substrate validates the bundle "
            "and returns ``status=plan`` if any conflict is detected "
            "(sha mismatch, version mismatch, missing addfile). When "
            "True, the substrate proceeds with the extraction + replay "
            "honouring ``use_bundle_case`` / ``accept_version_mismatch``."
        ),
    ),
    use_bundle_case: bool = Form(
        True,
        description=(
            "Sha-mismatch resolution. True (default) overwrites the "
            "workspace's copy of the case file with the bundle's; "
            "False preserves the workspace file and writes the bundle's "
            "to a sibling ``<filename>.from-bundle`` for offline diff."
        ),
    ),
    accept_version_mismatch: bool = Form(
        True,
        description=(
            "When True (default), the substrate proceeds even when the "
            "bundle's ANDES major.minor differs from the installed "
            "version (the warning surfaces in the response's ``plan``)."
        ),
    ),
) -> BundleImportResponse:
    """Import a reproducibility bundle.

    See module docstring for the conflict-resolution flow. The
    response is always a :class:`BundleImportResponse` — the route
    layer differentiates the two outcomes via HTTP status:

    - ``200 OK`` + ``status="committed"``: case loaded, disturbances
      replayed. ``case_filename`` and ``disturbances_replayed`` carry
      the post-commit bookkeeping.
    - ``409 Conflict`` + ``status="plan"``: conflicts present, nothing
      committed. The UI renders the conflict resolver and re-issues
      with ``force_resolve=true``.
    """
    # Read the body up to the cap. ``UploadFile`` streams from the
    # request body; reading more than the cap should fail loudly so a
    # runaway upload doesn't OOM the substrate.
    content = await file.read(MAX_BUNDLE_BYTES + 1)
    if len(content) > MAX_BUNDLE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"bundle upload exceeds {MAX_BUNDLE_BYTES} bytes; "
                "split the run into a smaller window."
            ),
        )

    mgr = _manager(request)
    # request_summary drops the (large, binary) zip body — the user-facing
    # retry knobs are the resolution flags only.
    summary = {
        "force_resolve": force_resolve,
        "use_bundle_case": use_bundle_case,
        "accept_version_mismatch": accept_version_mismatch,
    }
    try:
        # Session-MUTATING (KTD-20): a committed import replaces the session's
        # System, so the record lives in the global registry. The ``plan``
        # outcome is a *successful* validation (a 409 conflict, not a failure),
        # so the job is marked done either way once the invoke returns.
        async with _run_as_job(
            mgr,
            session_id,
            "bundle-import",
            request_summary=summary,
            use_global_registry=True,
        ) as job_id:
            payload = await mgr.invoke(
                session_id,
                "import_bundle",
                {
                    "zip_bytes": content,
                    "force_resolve": force_resolve,
                    "use_bundle_case": use_bundle_case,
                    "accept_version_mismatch": accept_version_mismatch,
                },
                timeout=120.0,
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
                "worker returned a non-dict payload for import_bundle: "
                f"{type(payload).__name__}"
            ),
        )

    status_value = payload.get("status")
    plan_model = _coerce_plan(payload)
    response = BundleImportResponse(
        status="committed" if status_value == "committed" else "plan",
        plan=plan_model,
        warnings=[str(w) for w in (payload.get("warnings") or [])],
        case_filename=(
            str(payload["case_filename"])
            if payload.get("case_filename") is not None
            else None
        ),
        addfile_filenames=[
            str(f) for f in (payload.get("addfile_filenames") or [])
        ],
        disturbances_replayed=int(payload.get("disturbances_replayed") or 0),
        job_id=job_id,
    )

    if status_value == "plan":
        # Conflict path — surface as 409 with the plan body so the UI's
        # mutation hook can branch on the status code without parsing
        # the body shape.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=response.model_dump(),
        )
    return response
