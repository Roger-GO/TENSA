"""Topology-mutation endpoints (Unit 2).

Three endpoints, all gated to pre-setup state:

- ``POST /sessions/{id}/elements`` — add a Bus/Line/generator/load/shunt.
- ``PUT /sessions/{id}/elements/{model}/{idx}`` — edit one or more
  parameters on an existing element.
- ``POST /sessions/{id}/blank`` — create a blank ``andes.System()``.

Pre-setup gate copies ``add_disturbance``'s pattern: ``self._ss.is_setup``
or ``self._setup_failed`` returns 409 with ``ProblemDetails`` directing the
caller to ``POST /api/sessions/{id}/reload`` first.

Body-size cap: each request body is limited to ``BODY_SIZE_LIMIT`` bytes
via a Content-Length pre-check. Oversize requests return 413.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import (
    AddElementRequest,
    BlankSystemResponse,
    EditElementRequest,
    ElementCreated,
    ProblemDetails,
    TopologyEntry,
    TopologyParamMeta,
    TopologySchema,
    TopologySummary,
)
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from andes_app.core.wrapper import _PARAMS_BY_MODEL

router = APIRouter()


# Body-size cap (in bytes). Element params are small flat dicts; 64 KB
# leaves headroom for any realistic payload while protecting the substrate
# from accidental or hostile oversize POSTs.
BODY_SIZE_LIMIT = 64 * 1024


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


def _enforce_body_size(request: Request) -> None:
    """Reject requests whose declared Content-Length exceeds the cap.

    For requests without a Content-Length header (chunked transfer), the
    actual body read at parse time is bounded by the schema validator, so
    no further check is needed here. The header check catches the common
    case fast — before any JSON parsing.
    """
    raw = request.headers.get("content-length")
    if raw is None:
        return
    try:
        size = int(raw)
    except ValueError:
        return
    if size > BODY_SIZE_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"request body exceeds the {BODY_SIZE_LIMIT}-byte cap on "
                "topology mutation endpoints"
            ),
        )


def _map_worker_error(exc: WorkerError) -> HTTPException:
    """Translate WorkerError categories into HTTP responses for these
    endpoints. Mirrors the disturbance.py mapping where overlap exists."""
    if exc.category in ("disturbance-commit", "SetupFailedError"):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{exc.detail} — call POST /api/sessions/{{id}}/reload to return "
                "to pre-setup state."
            ),
        )
    if exc.category == "SystemAlreadyLoadedError":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if exc.category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if exc.category == "ElementNotFoundError":
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=exc.detail,
        )
    if exc.category in {
        "ElementValidationError",
        "DisturbanceValidationError",
        "CaseLoadError",
    }:
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.detail,
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{exc.category}: {exc.detail}",
    )


# ---- topology schema --------------------------------------------------------


@router.get(
    "/topology/schema",
    operation_id="getTopologySchema",
    summary="Per-model parameter metadata for the add/edit forms.",
    response_model=TopologySchema,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
    },
)
async def topology_schema(_: RequireToken) -> TopologySchema:
    """Static endpoint — the schema mirrors a compile-time table on the
    wrapper. Auth-gated only because the rest of the substrate is."""
    models: dict[str, list[TopologyParamMeta]] = {}
    for model_name, metas in _PARAMS_BY_MODEL.items():
        models[model_name] = [
            TopologyParamMeta(
                name=m.name, kind=m.kind, required=m.required, unit=m.unit
            )
            for m in metas
        ]
    return TopologySchema(models=models)


# ---- mutations --------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/elements",
    operation_id="addElement",
    summary="Add a topology element to a pre-setup session.",
    response_model=ElementCreated,
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
        413: {
            "model": ProblemDetails,
            "description": (
                f"Request body exceeded the {BODY_SIZE_LIMIT}-byte cap on "
                "topology mutation endpoints."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES rejected the add() call (unknown model, missing "
                "required param, invalid bus reference, etc.) or the "
                "wrapper-side whitelist found unknown param keys."
            ),
        },
    },
)
async def add_element(
    session_id: str,
    body: AddElementRequest,
    request: Request,
    _: RequireToken,
) -> ElementCreated:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(
            session_id,
            "add_element",
            {"model": body.model, "params": body.params},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc
    return ElementCreated(element=TopologyEntry(**payload))


@router.put(
    "/sessions/{session_id}/elements/{model}/{idx}",
    operation_id="editElement",
    summary="Edit parameters on an existing pre-setup element.",
    response_model=TopologyEntry,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {
            "model": ProblemDetails,
            "description": (
                "Session not found, or no element of the given model+idx exists "
                "in the loaded System."
            ),
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "Session has already been committed; call POST /api/sessions/{id}"
                "/reload to return to pre-setup."
            ),
        },
        413: {
            "model": ProblemDetails,
            "description": (
                f"Request body exceeded the {BODY_SIZE_LIMIT}-byte cap on "
                "topology mutation endpoints."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES rejected the parameter write (e.g., unknown param key, "
                "wrong type, attempt to edit idx/name)."
            ),
        },
    },
)
async def edit_element(
    session_id: str,
    model: str,
    idx: str,
    body: EditElementRequest,
    request: Request,
    _: RequireToken,
) -> TopologyEntry:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(
            session_id,
            "edit_element",
            {"model": model, "idx": idx, "params": body.params},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc
    return TopologyEntry(**payload)


@router.post(
    "/sessions/{session_id}/blank",
    operation_id="createBlankSystem",
    summary="Create an empty andes.System() for a session.",
    response_model=BlankSystemResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "A System is already loaded on this session; reload or open "
                "a fresh session first."
            ),
        },
    },
)
async def create_blank(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> BlankSystemResponse:
    # No body; size cap is moot but we still don't want a giant Content-Length
    # to slip through.
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(
            session_id,
            "create_blank",
            {},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc
    return BlankSystemResponse(topology=TopologySummary(**payload))
