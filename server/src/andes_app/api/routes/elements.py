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

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import (
    AddElementRequest,
    BlankSystemResponse,
    DeleteBlockedResponse,
    EditElementRequest,
    ElementCreated,
    ProblemDetails,
    SaveCaseRequest,
    SaveCaseResponse,
    TopologyEntry,
    TopologyParamMeta,
    TopologySchema,
    TopologySummary,
)

# UndoLastEditResponse aliased to TopologySummary — the substrate just
# returns the post-undo topology snapshot.
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from andes_app.core.wrapper import _PARAMS_BY_MODEL
from andes_app.security.paths import (
    WorkspacePathError,
    open_workspace_file_for_write,
)

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
        "ElementHasDependentsError",
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


# ---- save (Unit 11) --------------------------------------------------------


def _validate_save_filename(workspace: Path, filename: str, format: str) -> Path:
    """Reject paths that escape the workspace; verify extension matches
    the chosen format. Returns the canonical absolute target path."""
    expected_ext = {"xlsx": ".xlsx", "json": ".json", "raw": ".raw"}[format]
    if not filename.endswith(expected_ext):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"filename {filename!r} does not match format {format!r}; "
                f"expected extension {expected_ext}"
            ),
        )
    try:
        with open_workspace_file_for_write(workspace, filename) as canonical:
            return canonical
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.post(
    "/sessions/{session_id}/save",
    operation_id="saveCase",
    summary="Write the current System to the workspace as xlsx or json.",
    response_model=SaveCaseResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or no case loaded."},
        409: {
            "model": ProblemDetails,
            "description": (
                "A file at the given filename exists and ``overwrite`` was "
                "not set, OR no case is loaded on this session."
            ),
        },
        413: {
            "model": ProblemDetails,
            "description": "Body exceeded the 64 KB cap.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "Filename failed validation (path traversal, mismatched "
                "extension, or unwriteable target)."
            ),
        },
    },
)
async def save_case(
    session_id: str,
    body: SaveCaseRequest,
    request: Request,
    _: RequireToken,
) -> SaveCaseResponse:
    _enforce_body_size(request)
    mgr = _manager(request)
    workspace = getattr(request.app.state, "workspace", None)
    if workspace is None or not isinstance(workspace, Path):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="workspace is not configured",
        )
    canonical = _validate_save_filename(workspace, body.filename, body.format)
    if canonical.exists() and not body.overwrite:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"file {body.filename!r} already exists; pass overwrite=true "
                "to replace it."
            ),
        )
    try:
        await mgr.invoke(
            session_id,
            "save_case",
            {"format": body.format, "filename": str(canonical)},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc
    bytes_written = canonical.stat().st_size if canonical.exists() else 0
    return SaveCaseResponse(filename=body.filename, bytes_written=bytes_written)


# ---- undo (Unit 12) -------------------------------------------------------


@router.post(
    "/sessions/{session_id}/undo-last-edit",
    operation_id="undoLastEdit",
    summary="Drop the last add() and rebuild the System.",
    response_model=TopologySummary,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "Session has been committed (PF / TDS already ran); reset "
                "the run before undoing."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": "No edits to undo on this session.",
        },
    },
)
async def undo_last_edit(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> TopologySummary:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(session_id, "undo_last_edit", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc
    return TopologySummary(**payload)


# ---- delete (Unit 1, v0.1.y) -----------------------------------------------


@router.delete(
    "/sessions/{session_id}/elements/{model}/{idx}",
    operation_id="deleteElement",
    summary="Delete a previously-added pre-setup element.",
    response_model=TopologySummary,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {
            "model": ProblemDetails,
            "description": (
                "Session not found, or no element of the given model+idx "
                "exists in the loaded System."
            ),
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "Session has already been committed (PF or TDS has run); "
                "call POST /api/sessions/{id}/reload to return to pre-setup."
            ),
        },
        422: {
            "model": DeleteBlockedResponse,
            "description": (
                "Deletion is blocked. Three sub-cases share this status: "
                "(a) cascade dependents exist (body matches "
                "``DeleteBlockedResponse``); (b) the element came from "
                "the loaded case file, not from ``add_element`` (body "
                "matches ``ProblemDetails`` with the 'reload to revert' "
                "message); (c) unknown model name (body matches "
                "``ProblemDetails``)."
            ),
        },
    },
)
async def delete_element(
    session_id: str,
    model: str,
    idx: str,
    request: Request,
    _: RequireToken,
) -> TopologySummary | JSONResponse:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(
            session_id,
            "delete_element",
            {"model": model, "idx": idx},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        # Cascade-dependents case: surface the typed ``DeleteBlockedResponse``
        # body instead of the generic ``ProblemDetails`` envelope. The
        # extra payload (dependents + total) crosses the worker Pipe via
        # ``WorkerError.extra`` (set by the worker's
        # ``ElementHasDependentsError`` handler).
        if exc.category == "ElementHasDependentsError":
            extra = exc.extra
            dependents_raw = extra.get("dependents", [])
            total = int(extra.get("total", len(dependents_raw)))
            dependents = [TopologyEntry(**d) for d in dependents_raw]
            body = DeleteBlockedResponse(dependents=dependents, total=total)
            return JSONResponse(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                content=body.model_dump(),
            )
        raise _map_worker_error(exc) from exc
    return TopologySummary(**payload)
