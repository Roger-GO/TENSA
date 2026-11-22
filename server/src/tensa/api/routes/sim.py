"""The Sienna multi-stage simulation of a session's case: ``POST /sessions/{id}/sim``."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ProblemDetails, SimRequest, SimResponse
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError
from tensa.engines.sienna.dispatch import NO_COST_DATA_MESSAGE

router = APIRouter()

# Worker error categories this route answers itself, beside the shared map:
# no case is 409 and a request the engine does not take is 422, as the
# dispatch route's own categories are mapped. SimRequestError is a
# DispatchRequestError subclass, but the worker reports the concrete class
# name as the category, so the map holds both. A case with no cost data is a
# 422 through the existing SiennaError path: the message is the one the Julia
# module throws, matched verbatim.
_CATEGORY_STATUS = {
    "NoCaseLoadedError": status.HTTP_409_CONFLICT,
    "DispatchRequestError": status.HTTP_422_UNPROCESSABLE_CONTENT,
    "SimRequestError": status.HTTP_422_UNPROCESSABLE_CONTENT,
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
    "/sessions/{session_id}/sim",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface runs a multi-stage simulation yet; the route is "
            "for scripts and agents. A later operations unit adds it to the "
            "run drawer."
        ),
    },
    operation_id="runSim",
    summary=(
        "Run the day-ahead unit commitment and real-time dispatch of the "
        "loaded case (Sienna only)."
    ),
    response_model=SimResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case has been loaded into this session yet, or the session's "
                "engine does not run a simulation (an ANDES session has none)."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The load profile is not 96 finite numbers at or above 0, "
                "the network model is not one of copper_plate, dc, ptdf, or "
                "the case has no generator cost data (a PSS/E .raw case "
                "carries none; use a MATPOWER case)."
            ),
        },
    },
)
async def run_sim(
    session_id: str,
    body: SimRequest,
    request: Request,
) -> SimResponse:
    """Run the two-stage simulation of the loaded case of a Sienna session,
    with PowerSimulations: a day-ahead unit commitment at hourly resolution
    over the day (every generator starting off, so one on in the first hour
    pays its start-up), then a real-time economic dispatch at 15 minutes held
    to that commitment through a SemiContinuousFeedforward, one simulation
    step over the day. The request's load profile is the time series of every
    load, held constant within each hour for the real-time stage. The answer
    lists, per stage and per period, each generator's on/off (day-ahead) and
    MW, the cost of each stage recomputed from its dispatch and the file's
    own gencost coefficients, and every slack variable past 1e-6 MW. The
    generators are keyed by their neutral key.
    """
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(
            session_id,
            "run_sim",
            {
                "load_profile": body.load_profile,
                "network_model": body.network_model,
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
    key_of = payload.get("keys", {}).get("generator", {})

    def rekeyed(rows: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for idx, row in rows.items():
            key = key_of.get(idx)
            if key is None:
                out[str(idx)] = {**row, "idx": idx}
                continue
            out[key] = {**row, "idx": idx, "id": key.split(":", 1)[1].split("-", 1)[1]}
        return out

    stages = [
        {
            **stage,
            "commitment": rekeyed(stage.get("commitment", {})),
            "dispatch": rekeyed(stage.get("dispatch", {})),
        }
        for stage in payload.get("stages", [])
    ]
    answer = {**payload, "engine": "sienna", "stages": stages}
    answer.pop("store_dir", None)
    return SimResponse.model_validate(answer)
