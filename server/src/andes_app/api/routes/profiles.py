"""TimeSeries profile import endpoints (Unit 15 of the v2.0 plan).

Researchers upload a CSV / XLSX hourly profile, then assign it to a
target ANDES device's parameters. The substrate writes the file under
``<workspace>/profiles/<uuid>.xlsx`` (CSV uploads are transcoded to
xlsx via openpyxl) and stages a ``ss.add('TimeSeries', ...)`` call
pre-setup. ANDES applies the profile's values to the target device's
``dests`` columns at the exact step times encoded in ``tkey``.

Four routes:

- ``POST /sessions/{id}/profiles/upload`` — multipart upload of a CSV
  or XLSX file. The substrate writes a fresh ``<uuid>.xlsx`` under
  ``<workspace>/profiles/`` and returns the absolute path so the
  follow-up ``POST /profiles`` can reference it. CSV uploads are
  transcoded; XLSX uploads are written verbatim.
- ``POST /sessions/{id}/profiles`` — body
  ``{profile_path, sheet, fields, tkey, model, dev, dests, mode: 1}``.
  Stages the TimeSeries pre-setup. Returns the ``TopologyEntry`` for
  the newly-added TimeSeries (with auto-assigned ``TimeSeries_<n>``
  idx).
- ``GET /sessions/{id}/profiles`` — lists every TimeSeries currently
  on the System. Empty list when none have been added.
- ``DELETE /sessions/{id}/profiles/{idx}`` — removes a TimeSeries by
  idx. 204 on success; 404 when the idx isn't a known TimeSeries.

Pre-setup gates mirror ``pmu.py`` / ``elements.py`` / ``disturbances.py``:
ANDES rejects post-setup ``ss.add()`` calls regardless of model class,
so a post-setup ``POST /profiles`` returns 409 with a "reload to
recover" hint. ``DELETE /profiles/{idx}`` is also pre-setup-only
because it goes through the same reload-and-replay code path as
``delete_element``.

Mode constraint per the Unit 1a spike: ANDES's ``apply_interpolate``
raises ``NotImplementedError`` (line 230 of ``andes/models/timeseries.py``)
so the substrate accepts only ``mode=1`` (exact-match step times).
``mode=2`` returns 422 with an actionable hint; the wrapper-side gate
in ``add_timeseries`` is the second line of defence.
"""

from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field

from andes_app.api._run_as_job import _run_as_job
from andes_app.api.auth import RequireToken
from andes_app.api.error_mapping import map_worker_error
from andes_app.api.schemas import (
    ProblemDetails,
    TopologyEntry,
)
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from andes_app.core.wrapper import ParamValue

router = APIRouter()

# Cap individual profile uploads at 8 MB. Hourly profiles for a 24-h /
# week / month window are kilobyte-scale; the cap is a defensive ceiling
# against a runaway upload exhausting the worker Pipe.
_MAX_PROFILE_BYTES = 8 * 1024 * 1024


# ---- request / response schemas -------------------------------------------


class AddProfileRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/profiles``.

    Mirrors the ``ss.add('TimeSeries', ...)`` parameter surface from
    ``andes/models/timeseries.py:38-72``. ``profile_path`` is the
    absolute path returned by the prior ``POST /profiles/upload``.
    """

    model_config = ConfigDict(extra="forbid")

    profile_path: str = Field(
        ...,
        description=(
            "Absolute path of the on-disk profile xlsx — the value "
            "returned by ``POST /profiles/upload``. The file must "
            "exist before this call (ANDES reads it during setup)."
        ),
        min_length=1,
    )
    sheet: str = Field(
        ...,
        description=(
            "XLSX sheet name to read. CSV uploads are transcoded to a "
            "single sheet named ``profile``; XLSX uploads keep their "
            "original sheet names."
        ),
        min_length=1,
    )
    fields: str = Field(
        ...,
        description=(
            "Comma-separated column names from the source sheet "
            "providing the time series of values (e.g., ``p0``, "
            "``p0,q0``). Each entry must match an existing column in "
            "the sheet."
        ),
        min_length=1,
    )
    model: str = Field(
        ...,
        description=(
            "ANDES model class name of the target device (e.g., "
            "``PQ``, ``PV``, ``Slack``). Must reference a model "
            "present on the loaded System."
        ),
        min_length=1,
    )
    dev: str = Field(
        ...,
        description=(
            "Idx of the target device within ``model`` (e.g., ``PQ_5``). "
            "The substrate validates existence before the underlying "
            "``ss.add`` so the user gets a clean 422 instead of an "
            "ANDES-internal error."
        ),
        min_length=1,
    )
    dests: str = Field(
        ...,
        description=(
            "Comma-separated parameter names on the target device that "
            "receive the profile values (e.g., ``p0``, ``p0,q0``). "
            "Must align with ``fields`` (one destination per source "
            "column)."
        ),
        min_length=1,
    )
    tkey: str = Field(
        default="t",
        description=(
            "Source column carrying the timestamp (in seconds). "
            "Defaults to ``t`` — the convention shipped by ANDES's "
            "bundled examples."
        ),
        min_length=1,
    )
    mode: int = Field(
        default=1,
        description=(
            "Application mode. ``1`` (exact) applies values at exact "
            "step times. ``2`` (interpolated) raises NotImplementedError "
            "in ANDES (verified per Unit 1a spike) — the substrate "
            "rejects mode=2 with 422; default to mode=1."
        ),
        ge=1,
        le=2,
    )


class UploadProfileResponse(BaseModel):
    """Wire shape of ``POST /sessions/{id}/profiles/upload``."""

    model_config = ConfigDict(extra="forbid")

    profile_path: str = Field(
        ...,
        description=(
            "Absolute path of the written xlsx on the substrate's "
            "workspace. Pass this verbatim as ``profile_path`` on the "
            "follow-up ``POST /profiles`` call."
        ),
    )
    bytes_written: int = Field(
        ...,
        description=(
            "Size of the on-disk xlsx in bytes. Reported back so the "
            "UI can confirm the upload completed end-to-end."
        ),
        ge=0,
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the profile-upload routine (v3.1 Unit "
            "5b, kind ``profile-upload``). ``null`` on legacy responses."
        ),
    )


class ListProfilesResponse(BaseModel):
    """Wire shape of ``GET /sessions/{id}/profiles``."""

    model_config = ConfigDict(extra="forbid")

    profiles: list[TopologyEntry] = Field(
        ...,
        description=(
            "Currently-staged TimeSeries devices. Each entry's "
            "``params`` carries ``path``, ``sheet``, ``fields``, "
            "``model``, ``dev``, ``dests``, ``tkey``, ``mode``. Empty "
            "list when none have been added."
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

    The shared mapper owns the canonical category→status table, recovery, and the
    body shape. This route carries two documented per-route deltas (audit #12):

    - ``disturbance-commit`` → 409 (already canonical) with the "reload to pre-setup
      state" hint appended.
    - ``SetupFailedError`` → **500** here (file write failure), overriding the
      shared table's canonical 422. Detail is verbatim.
    - everything else uses the canonical mapping (``no-case-loaded`` → 409,
      ``ElementNotFoundError`` → 404, ``ElementValidationError`` /
      ``ElementHasDependentsError`` → 422).
    """
    if exc.category == "disturbance-commit":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to "
            "return to pre-setup state."
        )
    if exc.category == "SetupFailedError":
        http = map_worker_error(exc)
        # Audit #12 override: SetupFailedError here is a profile file-write
        # failure — a 500, not the canonical 422.
        http.status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
        return http
    return map_worker_error(exc)


def _entry_from_payload(payload: object) -> TopologyEntry:
    """Coerce a worker payload dict into a ``TopologyEntry`` model."""
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for TimeSeries: "
                f"{type(payload).__name__}"
            ),
        )
    raw_params = payload.get("params") or {}
    if not isinstance(raw_params, dict):
        raw_params = {}
    coerced: dict[str, ParamValue | None] = {}
    for k, v in raw_params.items():
        if v is None or isinstance(v, (bool, int, float, str)):
            coerced[str(k)] = v
    return TopologyEntry(
        idx=str(payload.get("idx", "")),
        name=str(payload.get("name", "")),
        kind=str(payload.get("kind", "TimeSeries")),
        params=coerced,  # type: ignore[arg-type]
    )


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/profiles/upload",
    operation_id="uploadProfile",
    summary="Upload a CSV / XLSX hourly profile to the session's workspace.",
    response_model=UploadProfileResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "The substrate was launched without a workspace — "
                "profile uploads require disk persistence."
            ),
        },
        413: {
            "model": ProblemDetails,
            "description": (
                f"Upload exceeds the {_MAX_PROFILE_BYTES}-byte cap; "
                "split the profile into a smaller window."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Unsupported file extension OR malformed CSV (parse "
                "failure / non-UTF-8 bytes)."
            ),
        },
        500: {
            "model": ProblemDetails,
            "description": (
                "Disk write failed (full filesystem, permissions, or "
                "openpyxl error). The error detail surfaces the "
                "underlying cause."
            ),
        },
    },
)
async def upload_profile(
    session_id: str,
    request: Request,
    _: RequireToken,
    file: UploadFile = File(
        ...,
        description=(
            "CSV or XLSX file. CSV inputs are transcoded to xlsx "
            "(single sheet named ``profile``) for uniformity with "
            "ANDES's preferred input format."
        ),
    ),
) -> UploadProfileResponse:
    """Upload a profile and persist it to ``<workspace>/profiles/<uuid>.xlsx``.

    The follow-up ``POST /profiles`` references the returned
    ``profile_path`` to stage the TimeSeries device.
    """
    # Read the body up to the cap. UploadFile streams from the request
    # body; reading more than the cap should fail loudly so a runaway
    # upload doesn't OOM the substrate.
    content = await file.read(_MAX_PROFILE_BYTES + 1)
    if len(content) > _MAX_PROFILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"profile upload exceeds {_MAX_PROFILE_BYTES} bytes; "
                "split the profile into a smaller window."
            ),
        )

    filename = file.filename or "profile"
    mgr = _manager(request)
    try:
        # request_summary carries only the filename — the (large, binary)
        # ``content_bytes`` blob never enters the JobRecord.
        async with _run_as_job(
            mgr,
            session_id,
            "profile-upload",
            request_summary={"filename": filename},
        ) as job_id:
            payload = await mgr.invoke(
                session_id,
                "upload_profile",
                {"filename": filename, "content_bytes": content},
            )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    if not isinstance(payload, str):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-string payload for upload_profile: "
                f"{type(payload).__name__}"
            ),
        )

    return UploadProfileResponse(
        profile_path=payload,
        bytes_written=len(content),
        job_id=job_id,
    )


@router.post(
    "/sessions/{session_id}/profiles",
    operation_id="addProfile",
    summary="Stage a TimeSeries profile assignment on a pre-setup session.",
    response_model=TopologyEntry,
    status_code=status.HTTP_201_CREATED,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "Session has already been committed (PF or TDS has run); "
                "call POST /api/sessions/{id}/reload to return to pre-setup."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Profile file does not exist OR target model/device is "
                "absent OR mode=2 was requested OR ANDES rejected the "
                "underlying ``ss.add('TimeSeries', ...)`` call."
            ),
        },
    },
)
async def add_profile(
    session_id: str,
    body: AddProfileRequest,
    request: Request,
    _: RequireToken,
) -> TopologyEntry:
    """Stage a TimeSeries device pre-setup.

    Returns the freshly-built ``TopologyEntry`` with the auto-assigned
    ANDES idx (``TimeSeries_<n>``).
    """
    mgr = _manager(request)
    args: dict[str, object] = {
        "profile_path": body.profile_path,
        "sheet": body.sheet,
        "fields": body.fields,
        "tkey": body.tkey,
        "model": body.model,
        "dev": body.dev,
        "dests": body.dests,
        "mode": body.mode,
    }
    try:
        async with _run_as_job(
            mgr, session_id, "profile-add", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(session_id, "add_timeseries", args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    entry = _entry_from_payload(payload)
    entry.job_id = job_id
    return entry


@router.get(
    "/sessions/{session_id}/profiles",
    operation_id="listProfiles",
    summary="List currently-staged TimeSeries profiles on the session.",
    response_model=ListProfilesResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
    },
)
async def list_profiles(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> ListProfilesResponse:
    """Return every TimeSeries device currently registered on the
    session's System.

    Empty list when none have been staged (the common case for a
    freshly-loaded stock case — ANDES's bundled cases ship with zero
    TimeSeries devices).
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "list_timeseries", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    if not isinstance(payload, list):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-list payload for list_timeseries: "
                f"{type(payload).__name__}"
            ),
        )
    entries = [_entry_from_payload(item) for item in payload if isinstance(item, dict)]
    return ListProfilesResponse(profiles=entries)


@router.delete(
    "/sessions/{session_id}/profiles/{profile_idx}",
    operation_id="deleteProfile",
    summary="Remove a staged TimeSeries from the pre-setup session.",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {
            "model": ProblemDetails,
            "description": "Session not found OR no TimeSeries with that idx.",
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "Session has already been committed; call POST "
                "/api/sessions/{id}/reload to return to pre-setup."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "TimeSeries originated from the loaded case file (not "
                "removable via this endpoint — reload to reset)."
            ),
        },
    },
)
async def delete_profile(
    session_id: str,
    profile_idx: str,
    request: Request,
    _: RequireToken,
) -> Response:
    """Delete a TimeSeries previously staged via ``POST /profiles``.

    Returns 204 on success. 404 when the idx isn't a known TimeSeries.
    409 when the session is post-setup (call /reload first).
    """
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr,
            session_id,
            "profile-delete",
            request_summary={"idx": profile_idx},
        ) as job_id:
            await mgr.invoke(
                session_id, "delete_timeseries", {"idx": profile_idx}
            )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    # 204 has no JSON body; the mirrored job id rides an ``X-Job-Id`` header.
    return Response(
        status_code=status.HTTP_204_NO_CONTENT,
        headers={"X-Job-Id": job_id},
    )
