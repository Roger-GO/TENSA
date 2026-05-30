"""Disturbance management endpoints.

- ``POST /sessions/{id}/disturbances`` accepts a list of FaultSpec /
  ToggleSpec / AlterSpec, all gated by pre-setup state. ANDES rejects
  post-setup ``add()`` calls regardless of model type, so this endpoint
  returns 409 with guidance to call ``/reload`` once the System has been
  committed.
- ``GET /sessions/{id}/disturbances`` returns the substrate's
  ``_disturbance_log`` (every spec successfully accepted since the most
  recent ``load_case`` / ``reload_case`` / ``clear_disturbances``). The
  client uses this to re-sync the disturbance editor after a reload.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from andes_app.api._run_as_job import _run_as_job
from andes_app.api.auth import RequireToken
from andes_app.api.error_mapping import map_worker_error
from andes_app.api.schemas import (
    AddDisturbancesRequest,
    AddDisturbancesResponse,
    DisturbanceAck,
    ProblemDetails,
)
from andes_app.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)

router = APIRouter()


class ListDisturbancesResponse(BaseModel):
    """Wire shape of ``GET /sessions/{id}/disturbances``.

    Mirrors the substrate's ``Wrapper.list_disturbances()`` — the
    discriminated union over Fault / Toggle / Alter, in the order the
    specs were accepted. Empty list when no disturbances are pending.
    """

    model_config = ConfigDict(extra="forbid")

    disturbances: list[FaultSpec | ToggleSpec | AlterSpec] = Field(
        ...,
        description=(
            "Currently-recorded disturbance specs. Same shape as the "
            "``POST /sessions/{id}/disturbances`` request body's "
            "``disturbances`` field."
        ),
    )


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
    → 409, ``disturbance-commit`` → 409, ``DisturbanceValidationError`` /
    ``CaseLoadError`` → 422), recovery, and the body shape. This route only appends
    the documented "reload to pre-setup state" hint to ``disturbance-commit``.
    """
    if exc.category == "disturbance-commit":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to return "
            "to pre-setup state."
        )
    return map_worker_error(exc)


@router.post(
    "/sessions/{session_id}/disturbances",
    openapi_extra={"x-andes-app-gui-location": "disturbance-panel"},
    operation_id="addDisturbances",
    summary="Register one or more disturbances on a pre-setup session.",
    response_model=AddDisturbancesResponse,
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
            "description": "ANDES rejected one of the disturbance specs (e.g., bad bus idx).",
        },
    },
)
async def add_disturbances(
    session_id: str,
    body: AddDisturbancesRequest,
    request: Request,
    _: RequireToken,
) -> AddDisturbancesResponse:
    mgr = _manager(request)
    accepted: list[DisturbanceAck] = []
    try:
        # One job covers the whole batch (kind ``disturbance-commit``); a
        # rejected spec mid-loop fails the job and re-raises so the existing
        # error mapping is unchanged.
        async with _run_as_job(
            mgr,
            session_id,
            "disturbance-commit",
            request_summary=body.model_dump(),
        ) as job_id:
            for spec in body.disturbances:
                idx = await mgr.invoke(
                    session_id,
                    "add_disturbance",
                    {"spec": spec.model_dump()},
                )
                accepted.append(DisturbanceAck(kind=spec.kind, idx=idx))
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc
    return AddDisturbancesResponse(accepted=accepted, job_id=job_id)


def _spec_from_dict(spec_dict: dict[str, Any]) -> FaultSpec | ToggleSpec | AlterSpec:
    """Re-build a Pydantic disturbance spec from the worker's dict payload."""
    kind = spec_dict.get("kind")
    if kind == "fault":
        return FaultSpec(**spec_dict)
    if kind == "toggle":
        return ToggleSpec(**spec_dict)
    if kind == "alter":
        return AlterSpec(**spec_dict)
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"worker returned a disturbance with unknown kind: {kind!r}",
    )


@router.get(
    "/sessions/{session_id}/disturbances",
    openapi_extra={
        "x-andes-app-gui-location": "none",
        "x-andes-app-parity-deferred": "Recorded disturbances are mirrored in the disturbance-panel Zustand store and rehydrated from snapshot restore; the web client never re-reads them via this GET (read-back endpoint kept for API/agent parity).",
    },
    operation_id="listDisturbances",
    summary="List the disturbance specs currently recorded on the session.",
    response_model=ListDisturbancesResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
    },
)
async def list_disturbances(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> ListDisturbancesResponse:
    """Return the wrapper's ``_disturbance_log`` for client sync.

    Use case: after the client calls ``POST /sessions/{id}/reload``, the
    substrate's disturbance log is wiped (the new System has no
    disturbances). The client can then call ``GET`` (now empty) to confirm,
    re-POST the originals, and re-GET to verify they were re-accepted.

    No 409 path — even on a freshly-created session with no case loaded the
    answer is well-defined (empty list).
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "list_disturbances", {})
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
                "worker returned a non-list payload for list_disturbances: "
                f"{type(payload).__name__}"
            ),
        )
    specs = [_spec_from_dict(d) for d in payload if isinstance(d, dict)]
    return ListDisturbancesResponse(disturbances=specs)
