"""Clone-on-write case-edit endpoints (v3.1 Unit 21 / KTD-9, KTD-10).

The clone-on-write model (KTD-9): on first edit the substrate clones the
active case files to a per-session scratch dir; each edit invokes a
format-specific writer that modifies the clone in place; the substrate then
re-loads + re-setups the System from the clone so PF / TDS / EIG / CPF / SE run
against the edited files. The original case files are never touched.

Routes:

- ``POST   /sessions/{id}/case/clone`` — initialise the clone (idempotent).
- ``PUT    /sessions/{id}/case/clone/params/{model}/{idx}/{param}`` — one edit.
- ``POST   /sessions/{id}/case/clone/undo`` — pop one edit off the stack.
- ``POST   /sessions/{id}/case/clone/redo`` — re-apply one popped edit.
- ``POST   /sessions/{id}/case/clone/save-as`` — write the clone to the
  workspace as a custom case.
- ``POST   /sessions/{id}/case/clone/reset`` — discard the clone, revert to
  the originals.

Security (per the plan Approach):

- **Whitelist-first validation** on the edit route: the FIRST action is the
  ``(model, param)`` whitelist check against ``_CONTROLLER_MODEL_NAMES`` +
  ``_PARAMS_BY_MODEL``; an out-of-whitelist request 422s BEFORE any clone
  work. NEVER reflective ``getattr``.
- **Path traversal:** ``model`` / ``idx`` / ``param`` are FastAPI path params
  validated against the whitelist + (idx) the loaded topology via the
  substrate; the ``save-as`` name is validated against a strict workspace-safe
  pattern by the clone manager.
- **Concurrency / 409:** every edit goes through ``mgr.invoke``'s non-blocking
  session lock; a request landing while a job (e.g. TDS) holds the lock fails
  fast with ``SessionBusyError`` — translated to ``409`` with a
  ``wait-for-job`` recovery by the app-level handler.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from andes_app.api._run_as_job import _run_as_job
from andes_app.api.error_mapping import map_worker_error
from andes_app.api.schemas import (
    CloneDiffPair,
    CloneDiffResponse,
    CloneEditRequest,
    CloneEditResponse,
    CloneInitResponse,
    CloneResetResponse,
    CloneSaveAsRequest,
    CloneSaveAsResponse,
    ProblemDetails,
)
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)
from andes_app.core.wrapper import _CONTROLLER_MODEL_NAMES, _PARAMS_BY_MODEL

router = APIRouter()

# Body-size cap (bytes). A clone edit body is a single scalar value; 64 KB is
# vast headroom while protecting against accidental / hostile oversize POSTs.
BODY_SIZE_LIMIT = 64 * 1024

_CONTROLLER_MODEL_SET = frozenset(_CONTROLLER_MODEL_NAMES)


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
                "clone-edit endpoints"
            ),
        )


def _whitelist_or_422(model: str, param: str) -> None:
    """Whitelist-first validation (security F1, retained).

    The route's FIRST action: ``model`` must be a dynamic-controller class AND
    ``param`` must be one of that model's whitelisted params. Out-of-whitelist
    requests 422 here, before any clone work. This is also the path-traversal
    guard for ``model`` / ``param`` (a ``..`` segment never matches a known
    model / param name). NEVER reflective ``getattr``.
    """
    if model not in _CONTROLLER_MODEL_SET or param not in {
        p.name for p in _PARAMS_BY_MODEL.get(model, ())
    }:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{model}.{param} is not an editable dynamic-controller "
                "parameter; clone editing is restricted to the whitelisted "
                "controller models. Use the edit-element route for "
                "static-topology edits."
            ),
        )


def _whitelist_model_or_422(model: str) -> None:
    """Whitelist-first validation for the diff route (no per-param input).

    ``model`` must be a dynamic-controller class. Out-of-whitelist requests
    422 here, before any invoke — also the path-traversal guard for ``model``
    (a ``..`` segment never matches a known model name).
    """
    if model not in _CONTROLLER_MODEL_SET:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{model} is not a dynamic-controller model; clone diffing is "
                "restricted to the whitelisted controller models."
            ),
        )


@router.post(
    "/sessions/{session_id}/case/clone",
    openapi_extra={"x-andes-app-gui-location": "inspector"},
    operation_id="initClone",
    summary="Initialise the clone-on-write copy of the active case.",
    response_model=CloneInitResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "No case is loaded, the session is busy with an in-flight job, "
                "or a sweep holds the session lock."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": "The loaded case cannot be cloned (e.g. a blank session).",
        },
    },
)
async def init_clone(
    session_id: str,
    request: Request,
) -> CloneInitResponse:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "clone-init", request_summary={}
        ) as job_id:
            payload: Any = await mgr.invoke(session_id, "init_clone", {})
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return CloneInitResponse(
        clone_dir=payload["clone_dir"],
        clone_files=list(payload.get("clone_files", [])),
        already_initialized=bool(payload["already_initialized"]),
        job_id=job_id,
    )


@router.put(
    "/sessions/{session_id}/case/clone/params/{model}/{idx}/{param}",
    openapi_extra={"x-andes-app-gui-location": "inspector"},
    operation_id="applyCloneEdit",
    summary="Edit one whitelisted controller param on the clone (write + reload + setup).",
    response_model=CloneEditResponse,
    responses={
        404: {
            "model": ProblemDetails,
            "description": "Session not found, or no device of the given model+idx exists.",
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "The session is busy with an in-flight job (e.g. TDS streaming) "
                "or a sweep holds the lock; retry when it completes."
            ),
        },
        413: {"model": ProblemDetails, "description": "Body exceeded the 64 KB cap."},
        422: {
            "model": ProblemDetails,
            "description": (
                "The (model, param) is not a whitelisted dynamic-controller "
                "param, the param is read-only in the loaded format, or the "
                "clone writer rejected the edit (malformed file / setup failed)."
            ),
        },
    },
)
async def apply_clone_edit(
    session_id: str,
    model: str,
    idx: str,
    param: str,
    body: CloneEditRequest,
    request: Request,
) -> CloneEditResponse:
    # Whitelist-first — BEFORE body-size, BEFORE any invoke. Doubles as the
    # path-traversal guard for ``model`` / ``param``.
    _whitelist_or_422(model, param)
    _enforce_body_size(request)
    mgr = _manager(request)
    summary = {"model": model, "idx": idx, "param": param, "value": body.value}
    try:
        async with _run_as_job(
            mgr, session_id, "clone-edit", request_summary=summary
        ) as job_id:
            payload: Any = await mgr.invoke(
                session_id,
                "apply_clone_edit",
                {"model": model, "idx": idx, "param": param, "value": body.value},
            )
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return _edit_response(payload, job_id)


@router.post(
    "/sessions/{session_id}/case/clone/undo",
    openapi_extra={"x-andes-app-gui-location": "inspector"},
    operation_id="undoCloneEdit",
    summary="Undo the most recent clone edit (restore prior file state + re-setup).",
    response_model=CloneEditResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {"model": ProblemDetails, "description": "Session busy with an in-flight job."},
        422: {"model": ProblemDetails, "description": "Nothing to undo."},
    },
)
async def undo_clone_edit(
    session_id: str,
    request: Request,
) -> CloneEditResponse:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "clone-undo", request_summary={}
        ) as job_id:
            payload: Any = await mgr.invoke(session_id, "undo_clone_edit", {})
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return _edit_response(payload, job_id)


@router.post(
    "/sessions/{session_id}/case/clone/redo",
    openapi_extra={"x-andes-app-gui-location": "inspector"},
    operation_id="redoCloneEdit",
    summary="Re-apply the most recently undone clone edit.",
    response_model=CloneEditResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {"model": ProblemDetails, "description": "Session busy with an in-flight job."},
        422: {"model": ProblemDetails, "description": "Nothing to redo."},
    },
)
async def redo_clone_edit(
    session_id: str,
    request: Request,
) -> CloneEditResponse:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "clone-redo", request_summary={}
        ) as job_id:
            payload: Any = await mgr.invoke(session_id, "redo_clone_edit", {})
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return _edit_response(payload, job_id)


@router.post(
    "/sessions/{session_id}/case/clone/save-as",
    openapi_extra={"x-andes-app-gui-location": "command-palette"},
    operation_id="saveCloneAs",
    summary="Write the clone to the workspace as a custom case.",
    response_model=CloneSaveAsResponse,
    status_code=status.HTTP_201_CREATED,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {"model": ProblemDetails, "description": "Session busy with an in-flight job."},
        413: {"model": ProblemDetails, "description": "Body exceeded the 64 KB cap."},
        422: {
            "model": ProblemDetails,
            "description": (
                "No clone to save, an invalid / traversal name, the workspace "
                "is not configured, or the name collides with an existing "
                "workspace file (pass overwrite=true to replace it)."
            ),
        },
    },
)
async def save_clone_as(
    session_id: str,
    body: CloneSaveAsRequest,
    request: Request,
) -> CloneSaveAsResponse:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "clone-save-as", request_summary={"name": body.name}
        ) as job_id:
            payload: Any = await mgr.invoke(
                session_id,
                "save_clone_as",
                {"name": body.name, "overwrite": body.overwrite},
            )
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return CloneSaveAsResponse(
        name=payload["name"], files=list(payload.get("files", [])), job_id=job_id
    )


@router.post(
    "/sessions/{session_id}/case/clone/reset",
    openapi_extra={"x-andes-app-gui-location": "command-palette"},
    operation_id="resetClone",
    summary="Discard the clone and revert to the original case files.",
    response_model=CloneResetResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {"model": ProblemDetails, "description": "Session busy with an in-flight job."},
    },
)
async def reset_clone(
    session_id: str,
    request: Request,
) -> CloneResetResponse:
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "clone-reset", request_summary={}
        ) as job_id:
            payload: Any = await mgr.invoke(session_id, "reset_clone", {})
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    return CloneResetResponse(reset=bool(payload["reset"]), job_id=job_id)


@router.get(
    "/sessions/{session_id}/case/clone/diff/{model}/{idx}",
    openapi_extra={"x-andes-app-gui-location": "inspector"},
    operation_id="getCloneDiff",
    summary="Diff the clone-file vs original-file values for one device.",
    response_model=CloneDiffResponse,
    responses={
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {"model": ProblemDetails, "description": "Session busy with an in-flight job."},
        422: {
            "model": ProblemDetails,
            "description": (
                "The model is not a whitelisted dynamic-controller class."
            ),
        },
    },
)
async def get_clone_diff(
    session_id: str,
    model: str,
    idx: str,
    request: Request,
) -> CloneDiffResponse:
    # Whitelist-first — BEFORE any invoke. Doubles as the path-traversal guard
    # for ``model``. ``idx`` is matched against the loaded device by the
    # substrate (an unmatched idx yields an empty diff, not an error).
    _whitelist_model_or_422(model)
    _enforce_body_size(request)
    mgr = _manager(request)
    try:
        payload: Any = await mgr.invoke(
            session_id, "clone_diff", {"model": model, "idx": idx}
        )
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc
    params = {
        name: CloneDiffPair(**pair)
        for name, pair in payload.get("params", {}).items()
    }
    return CloneDiffResponse(params=params)


def _edit_response(payload: dict[str, Any], job_id: str) -> CloneEditResponse:
    return CloneEditResponse(
        model=payload.get("model", ""),
        idx=payload.get("idx", ""),
        param=payload.get("param", ""),
        new_value=payload.get("new_value"),
        undo_depth=int(payload["undo_depth"]),
        redo_depth=int(payload["redo_depth"]),
        job_id=job_id,
    )
