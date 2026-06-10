"""PMU placement endpoints (Unit 14 of the v2.0 plan).

Researchers place PMU instances at user-selected buses pre-setup. The
substrate stores them via the same ``_replay_buffer`` machinery used by
``add_element`` so PMUs survive a ``reload_case`` cycle (Unit 6.5
disturbance-replay parity).

Four routes:

- ``POST /sessions/{id}/pmu`` — body ``{bus_idx, Ta?, Tv?}``. Adds a
  PMU at ``bus_idx`` with low-pass filter time constants ``Ta`` (angle)
  and ``Tv`` (voltage), both defaulting to 0.05 s. Returns the
  newly-created TopologyEntry.
- ``GET /sessions/{id}/pmu`` — lists every PMU currently on the System.
  Empty list when no PMUs have been placed.
- ``DELETE /sessions/{id}/pmu/{idx}`` — removes a PMU by idx. 204 on
  success; 404 when the idx isn't a known PMU.
- ``GET /sessions/{id}/pmu/{run_id}/export.csv`` — full-rate CSV of
  the most recent TDS run's PMU am/vm trajectories. The ``run_id``
  segment is opaque on the substrate side (the substrate doesn't
  persist per-run histories — TDS data lives on ``ss.dae.ts`` and is
  replaced by the next run); the route accepts it so client-side run
  bookkeeping (the runs slice) can name the downloaded file with a
  stable identifier.

Pre-setup gates mirror ``elements.py`` / ``disturbances.py``: ANDES
rejects post-setup ``ss.add()`` calls regardless of model class, so a
post-setup ``POST /pmu`` returns 409 with a "reload to recover" hint.
``DELETE /pmu/{idx}`` is also pre-setup-only because it goes through
the same reload-and-replay code path as ``delete_element`` (which has
no in-place removal API on ANDES post-setup).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from andes_app.api._run_as_job import _run_as_job
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


# ---- request / response schemas -------------------------------------------


class AddPmuRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/pmu``.

    ``bus_idx`` accepts a string (which the substrate forwards as-is to
    ANDES — ``ss.add('PMU', dict(bus=...))``). Bus idx values can be
    integers (PSS/E .raw cases) or strings (.xlsx cases); the substrate
    coerces both via string-equality so the API surface stays uniform.

    ``Ta`` / ``Tv`` (optional) are the angle / voltage low-pass filter
    time constants in seconds. Defaults match the Unit 14 spike's
    empirical sweet spot (0.05 s) — small enough to track a 60 Hz
    swing, large enough to suppress integration noise on stiff cases.
    ANDES's own defaults are 0.1 s.
    """

    model_config = ConfigDict(extra="forbid")

    bus_idx: str = Field(
        ...,
        description=(
            "Bus idx the PMU attaches to. Must reference a Bus that "
            "exists on the loaded System. Integer-typed bus idxes "
            "(from PSS/E .raw cases) are accepted as their string "
            "representation."
        ),
        min_length=1,
    )
    Ta: float | None = Field(
        default=None,
        description=(
            "Angle filter time constant in seconds. Defaults to 0.05 s "
            "when omitted (the substrate's recommended sweet spot)."
        ),
        gt=0.0,
    )
    Tv: float | None = Field(
        default=None,
        description=(
            "Voltage filter time constant in seconds. Defaults to "
            "0.05 s when omitted."
        ),
        gt=0.0,
    )


class ListPmusResponse(BaseModel):
    """Wire shape of ``GET /sessions/{id}/pmu``.

    Mirrors a slice of ``TopologySummary.controllers`` filtered to the
    PMU model class — surfaced as a dedicated route so the placement
    dialog doesn't have to load the full topology snapshot just to read
    the PMU list.
    """

    model_config = ConfigDict(extra="forbid")

    pmus: list[TopologyEntry] = Field(
        ...,
        description=(
            "Currently-placed PMU instances. Each entry's ``params`` "
            "carries ``bus`` / ``Ta`` / ``Tv``. Empty list when no PMUs "
            "have been placed."
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
    body shape. This route carries two documented per-route deltas (audit #11):

    - ``disturbance-commit`` → 409 (already canonical) with the "reload to pre-setup
      state" hint appended.
    - ``SetupFailedError`` → **409** here (PMU CSV export: TDS not run yet),
      overriding the shared table's canonical 422. Detail is verbatim (no hint).
    - everything else uses the canonical mapping (``no-case-loaded`` → 409,
      ``ElementNotFoundError`` → 404, ``ElementValidationError`` /
      ``ElementHasDependentsError`` → 422; no dependents body on PMU).
    """
    if exc.category == "disturbance-commit":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to "
            "return to pre-setup state."
        )
    if exc.category == "SetupFailedError":
        http = map_worker_error(exc)
        # Audit #11 override: SetupFailedError on the PMU CSV export means TDS
        # has not been run yet — a 409 conflict, not the canonical 422.
        http.status_code = status.HTTP_409_CONFLICT
        return http
    return map_worker_error(exc)


def _entry_from_payload(payload: object) -> TopologyEntry:
    """Coerce a worker payload dict into a ``TopologyEntry`` model."""
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for PMU add: "
                f"{type(payload).__name__}"
            ),
        )
    raw_params = payload.get("params") or {}
    if not isinstance(raw_params, dict):
        raw_params = {}
    # ``params`` values are JSON-friendly primitives (the substrate's
    # ``ParamValue`` union: float | int | str | bool | None). Drop None
    # values — TopologyEntry.params doesn't carry them — and cast to
    # the schema-side type so Pydantic's strict-mode validation passes.
    coerced: dict[str, ParamValue] = {}
    for k, v in raw_params.items():
        if isinstance(v, (bool, int, float, str)):
            coerced[str(k)] = v
    return TopologyEntry(
        idx=str(payload.get("idx", "")),
        name=str(payload.get("name", "")),
        kind=str(payload.get("kind", "PMU")),
        params=coerced,
    )


# ---- routes ---------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/pmu",
    openapi_extra={"x-andes-app-gui-location": "pmu-dialog"},
    operation_id="addPmu",
    summary="Place a PMU at the given bus on a pre-setup session.",
    response_model=TopologyEntry,
    status_code=status.HTTP_201_CREATED,
    responses={
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
                "Bus idx does not exist on the loaded System OR ANDES "
                "rejected the underlying ``ss.add('PMU', ...)`` call."
            ),
        },
    },
)
async def add_pmu(
    session_id: str,
    body: AddPmuRequest,
    request: Request,
) -> TopologyEntry:
    """Add a PMU instance to the session pre-setup.

    Returns the freshly-built ``TopologyEntry`` with the auto-assigned
    ANDES idx (``PMU_<n>``). The placement dialog seeds its local list
    from the response so the new PMU shows up without an extra GET.
    """
    mgr = _manager(request)
    args: dict[str, object] = {"bus_idx": body.bus_idx}
    if body.Ta is not None:
        args["Ta"] = body.Ta
    if body.Tv is not None:
        args["Tv"] = body.Tv
    try:
        async with _run_as_job(
            mgr, session_id, "pmu-add", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(session_id, "add_pmu", args)
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
    "/sessions/{session_id}/pmu",
    openapi_extra={"x-andes-app-gui-location": "pmu-dialog"},
    operation_id="listPmus",
    summary="List currently-placed PMU instances on the session.",
    response_model=ListPmusResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
    },
)
async def list_pmus(
    session_id: str,
    request: Request,
) -> ListPmusResponse:
    """Return every PMU currently registered on the session's System.

    Empty list when none have been placed (the common case for a
    freshly-loaded stock case — ANDES's bundled cases ship with zero
    PMUs).
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "list_pmus", {})
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
                "worker returned a non-list payload for list_pmus: "
                f"{type(payload).__name__}"
            ),
        )
    entries = [_entry_from_payload(item) for item in payload if isinstance(item, dict)]
    return ListPmusResponse(pmus=entries)


@router.delete(
    "/sessions/{session_id}/pmu/{pmu_idx}",
    openapi_extra={"x-andes-app-gui-location": "pmu-dialog"},
    operation_id="deletePmu",
    summary="Remove a PMU from the pre-setup session.",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    responses={
        404: {
            "model": ProblemDetails,
            "description": "Session not found OR no PMU with that idx.",
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
                "PMU originated from the loaded case file (not "
                "removable via this endpoint — reload to reset)."
            ),
        },
    },
)
async def delete_pmu(
    session_id: str,
    pmu_idx: str,
    request: Request,
) -> Response:
    """Delete a PMU previously added via ``POST /pmu``.

    Returns 204 on success. 404 when the idx isn't a known PMU. 409
    when the session is post-setup (call /reload first).
    """
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "pmu-delete", request_summary={"idx": pmu_idx}
        ) as job_id:
            await mgr.invoke(session_id, "delete_pmu", {"idx": pmu_idx})
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


@router.get(
    "/sessions/{session_id}/pmu/{run_id}/export.csv",
    openapi_extra={"x-andes-app-gui-location": "pmu-dialog"},
    operation_id="exportPmuCsv",
    summary="Download the PMU am/vm trajectories from the most recent TDS run.",
    response_class=Response,
    responses={
        200: {
            "content": {"text/csv": {}},
            "description": (
                "CSV body. Header is ``t,<idx1>_am,<idx1>_vm,...``; one "
                "row per integration step at full TDS rate (no "
                "decimation). Empty body (header only) when no PMUs are "
                "placed or no TDS step has fired."
            ),
        },
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case has been loaded OR the session has not yet "
                "committed setup() (i.e., no PF or TDS run has fired)."
            ),
        },
    },
)
async def export_pmu_csv(
    session_id: str,
    run_id: str,  # noqa: ARG001 — opaque client-side run identifier
    request: Request,
) -> Response:
    """Stream the PMU CSV for the session's most recent TDS run.

    The ``run_id`` segment is informational on the substrate side (the
    substrate keeps only the latest ``ss.dae.ts``); the client uses it
    so the downloaded file can be stably named per-run.
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "export_pmu_csv", {})
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
                "worker returned a non-string payload for export_pmu_csv: "
                f"{type(payload).__name__}"
            ),
        )

    filename = f"andes-pmu-{run_id[:12]}.csv"
    return Response(
        content=payload,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


