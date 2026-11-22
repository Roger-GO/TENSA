"""The Sienna unit commitment of a session's case: ``POST /sessions/{id}/uc``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ProblemDetails, UcRequest, UcResponse
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError
from tensa.engines.sienna.dispatch import NO_COST_DATA_MESSAGE

router = APIRouter()

# Worker error categories this route answers itself, beside the shared map:
# no case is 409 and a request the engine does not take is 422, as the
# dispatch route's own categories are mapped. UcRequestError is a
# DispatchRequestError subclass, but the worker reports the concrete class
# name as the category, so the map holds both. A case with no cost data is a
# 422 through the existing SiennaError path: the message is the one the Julia
# module throws, matched verbatim.
_CATEGORY_STATUS = {
    "NoCaseLoadedError": status.HTTP_409_CONFLICT,
    "DispatchRequestError": status.HTTP_422_UNPROCESSABLE_CONTENT,
    "UcRequestError": status.HTTP_422_UNPROCESSABLE_CONTENT,
}


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


@router.post(
    "/sessions/{session_id}/uc",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface runs a unit commitment yet; the route is for "
            "scripts and agents. A later operations unit adds it to the run "
            "drawer."
        ),
    },
    operation_id="runUnitCommitment",
    summary="Solve the unit commitment of the loaded case (Sienna only).",
    response_model=UcResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case has been loaded into this session yet, or the session's "
                "engine does not run a unit commitment (an ANDES session has none)."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The request is not one the engine takes (network model, "
                "horizon, resolution, series length, an override), or the "
                "case has no generator cost data (a PSS/E .raw case carries "
                "none; use a MATPOWER case)."
            ),
        },
    },
)
async def run_uc(
    session_id: str,
    body: UcRequest,
    request: Request,
) -> UcResponse:
    """Solve the unit commitment of the loaded case of a Sienna session, with
    PowerSimulations: on a deep copy of the system every generator starts off
    (so a generator on in the first period pays its start-up), every load is
    given the request's profile as one forecast over the horizon, the cost
    curves are labelled as natural units so the objective is the true cost in
    $, and a ramp limit of 0 from the file (no data) becomes no limit. The
    answer lists, per period, each generator's on/off and MW, the cost split
    into energy, start-up and fixed, the solver's objective beside the cost
    recomputed from the file's own gencost coefficients, and every slack
    variable past 1e-6 MW. The generators are keyed by their neutral key.
    """
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(
            session_id,
            "run_uc",
            {
                "network_model": body.network_model,
                "horizon_h": body.horizon_h,
                "resolution_min": body.resolution_min,
                "series": body.series,
                "overrides": {
                    k: v.model_dump(exclude_none=True)
                    for k, v in body.overrides.items()
                },
            },
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        if exc.category == "SiennaError" and exc.detail == NO_COST_DATA_MESSAGE:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=exc.detail,
            ) from exc
        http_status = _CATEGORY_STATUS.get(exc.category)
        if http_status is not None:
            raise HTTPException(status_code=http_status, detail=exc.detail) from exc
        if exc.category == "SiennaError":
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=exc.detail,
            ) from exc
        raise map_worker_error(exc) from exc
    # The worker's payload keys the generators by the PowerSystems name (the
    # idx); the answer keys them by the neutral key, with the idx inside. The
    # id is the key's (gen:<bus>-<id>): the one the engine reads off the name
    # is, for a MATPOWER generator, its row in the file.
    generators: dict[str, Any] = {}
    by_idx = payload.get("generators", {})
    key_of = payload.get("keys", {}).get("generator", {})
    for idx, row in by_idx.items():
        key = key_of.get(idx)
        if key is None:
            generators[str(idx)] = {**row, "idx": idx}
            continue
        generators[key] = {**row, "idx": idx, "id": key.split(":", 1)[1].split("-", 1)[1]}
    answer = {**payload, "engine": "sienna", "generators": generators}
    return UcResponse.model_validate(answer)
