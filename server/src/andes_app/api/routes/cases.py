"""Case-load + topology + reload endpoints.

These endpoints translate API-shaped requests into wrapper invocations via
the SessionManager. Path validation runs at the FastAPI layer
(``security.paths.open_workspace_file_for_andes``) before forwarding the
canonical real path to the worker.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import (
    AlterableParamsResponse,
    LoadCaseRequest,
    ProblemDetails,
    TopologyEntry,
    TopologySummary,
)
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from andes_app.security.paths import (
    WorkspacePathError,
    open_workspace_file_for_andes,
)

router = APIRouter()


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


def _topology_from_payload(payload: dict[str, Any]) -> TopologySummary:
    """Build a TopologySummary response model from the dict the worker sent."""
    return TopologySummary(
        state=payload["state"],
        buses=[TopologyEntry(**e) for e in payload.get("buses", [])],
        lines=[TopologyEntry(**e) for e in payload.get("lines", [])],
        transformers=[TopologyEntry(**e) for e in payload.get("transformers", [])],
        generators=[TopologyEntry(**e) for e in payload.get("generators", [])],
        loads=[TopologyEntry(**e) for e in payload.get("loads", [])],
        shunts=[TopologyEntry(**e) for e in payload.get("shunts", [])],
        controllers=[TopologyEntry(**e) for e in payload.get("controllers", [])],
    )


def _map_worker_error(exc: WorkerError) -> HTTPException:
    """Translate a WorkerError into the appropriate HTTP status code."""
    category = exc.category
    if category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if category == "CaseLoadError":
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.detail,
        )
    if category == "SetupFailedError":
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=exc.detail,
        )
    # Fallback: surface as 500 with the worker-provided detail
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{category}: {exc.detail}",
    )


@router.post(
    "/sessions/{session_id}/case",
    operation_id="loadCase",
    summary="Load an ANDES case file (with optional addfiles) into a session.",
    response_model=TopologySummary,
    responses={
        400: {
            "model": ProblemDetails,
            "description": "Workspace path validation failed (traversal, absolute path, NUL byte, missing).",
        },
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        422: {
            "model": ProblemDetails,
            "description": "ANDES could not parse the case file.",
        },
    },
)
async def load_case(
    session_id: str,
    body: LoadCaseRequest,
    request: Request,
    _: RequireToken,
) -> TopologySummary:
    mgr = _manager(request)
    workspace = request.app.state.workspace

    # Validate + canonicalize the primary path AND each addfile under the
    # workspace boundary before forwarding to the worker.
    try:
        with open_workspace_file_for_andes(workspace, body.primary_path) as primary:
            canonical_addfiles: list[str] = []
            if body.addfiles:
                for af in body.addfiles:
                    with open_workspace_file_for_andes(workspace, af) as canonical_af:
                        canonical_addfiles.append(str(canonical_af))
            primary_str = str(primary)
    except WorkspacePathError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    try:
        payload = await mgr.invoke(
            session_id,
            "load_case",
            {
                "path": primary_str,
                "addfiles": canonical_addfiles or None,
            },
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc

    return _topology_from_payload(payload)


@router.get(
    "/sessions/{session_id}/topology",
    operation_id="getTopology",
    summary="Get the current topology view of a session's loaded case.",
    response_model=TopologySummary,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or no case loaded."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
    },
)
async def get_topology(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> TopologySummary:
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "topology", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc
    return _topology_from_payload(payload)


@router.get(
    "/sessions/{session_id}/topology/models/{model}/alterable_params",
    operation_id="getAlterableParams",
    summary=(
        "List parameter names ANDES will accept as ``src`` for an Alter "
        "disturbance on a given model."
    ),
    response_model=AlterableParamsResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {
            "model": ProblemDetails,
            "description": (
                "Session not found or already closed, OR the requested "
                "model name is not present on the loaded ``System``."
            ),
        },
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
    },
)
async def get_alterable_params(
    session_id: str,
    model: str,
    request: Request,
    _: RequireToken,
) -> AlterableParamsResponse:
    """Best-effort introspection of the model's ``params`` ordered dict on
    the loaded ``System``. Filters to ``NumParam`` instances that are not
    ``ExtParam`` — ANDES's own definition of "alterable" for the
    ``alter()`` / ``set()`` contract.

    The response order matches ANDES's internal declaration order on the
    model class, which is also the order the UI's parameter dropdown
    renders. Empty list when the model has no alterable params (no
    ``NumParam`` declarations or all are ``ExtParam``); the route is a 200
    in that case.
    """
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(
            session_id,
            "alterable_params",
            {"model": model},
        )
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        # Unknown model name on a loaded System — surface as 404 so the
        # UI can distinguish "no such model" from "no case loaded" (409).
        if exc.category == "ElementValidationError":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=exc.detail,
            ) from exc
        raise _map_worker_error(exc) from exc
    if not isinstance(payload, list):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"unexpected worker payload shape: {type(payload).__name__}",
        )
    return AlterableParamsResponse(model=model, params=[str(p) for p in payload])


@router.post(
    "/sessions/{session_id}/reload",
    operation_id="reloadCase",
    summary="Re-load the current case to return to pre-setup state.",
    response_model=TopologySummary,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session yet.",
        },
    },
)
async def reload_case(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> TopologySummary:
    """Calls ``andes.load(setup=False)`` again. **Cost is honest** — this is
    a full re-parse, not a fast path. Documented in the OpenAPI summary so
    callers can budget for multi-second latency on large cases."""
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "reload_case", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc
    return _topology_from_payload(payload)
