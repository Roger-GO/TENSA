"""The models ANDES ships and its documentation of each.

``GET /sessions/{id}/models`` lists every model ANDES ships, grouped as ANDES
groups them, and ``GET /sessions/{id}/models/{model}/doc`` answers the text
ANDES prints for one of them (``andes doc <model>``: its parameters, variables
and equations). The worker reads both off a fresh, empty System of its own, so
they need no case and leave the session's System as it was; they take a session
only because ANDES is imported in the workers and never in this process.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from tensa.api.error_mapping import map_worker_error
from tensa.api.schemas import ModelDoc, ProblemDetails, SupportedModels
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError

router = APIRouter()

# The web UI's Model documentation dialog reads both routes: the list in its
# browse mode, opened from the command palette, and the text of one model,
# also opened from the button beside a model's name in an element form.
_GUI_LOCATION = "model-doc-dialog"

_SESSION_404 = "Session not found or already closed."
_ENGINE_409 = "The session's engine is not ANDES, and only ANDES documents its models."


def _manager(request: Request) -> SessionManager:
    mgr = getattr(request.app.state, "session_manager", None)
    if mgr is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session manager is not configured",
        )
    assert isinstance(mgr, SessionManager)
    return mgr


async def _invoke(request: Request, session_id: str, op: str, args: dict[str, Any]) -> Any:
    mgr = _manager(request)
    try:
        return await mgr.invoke(session_id, op, args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise map_worker_error(exc) from exc


@router.get(
    "/sessions/{session_id}/models",
    openapi_extra={"x-tensa-gui-location": _GUI_LOCATION},
    operation_id="listSupportedModels",
    summary="List every model ANDES ships, grouped as ANDES groups them.",
    response_model=SupportedModels,
    responses={
        404: {"model": ProblemDetails, "description": _SESSION_404},
        409: {"model": ProblemDetails, "description": _ENGINE_409},
    },
)
async def list_supported_models(session_id: str, request: Request) -> SupportedModels:
    """Every model class ANDES ships (about a hundred in ANDES 2.0.0), under the
    group ANDES puts it in, in ANDES's own order. Any of them names a model
    for ``GET /sessions/{id}/models/{model}/doc``.

    This is wider than what can be built: the element routes add and edit
    only the models ``GET /topology/schema`` lists, and a case file may hold
    any model here. No case is needed; the session's System is not touched.
    """
    payload = await _invoke(request, session_id, "supported_models", {})
    return SupportedModels.model_validate(payload)


@router.get(
    "/sessions/{session_id}/models/{model}/doc",
    openapi_extra={"x-tensa-gui-location": _GUI_LOCATION},
    operation_id="getModelDoc",
    summary="Get ANDES's own documentation of one model, as plain text.",
    response_model=ModelDoc,
    responses={
        404: {
            "model": ProblemDetails,
            "description": (
                "Session not found or already closed, or no model ANDES ships has "
                "that name (GET /api/sessions/{id}/models lists them)."
            ),
        },
        409: {"model": ProblemDetails, "description": _ENGINE_409},
        422: {
            "model": ProblemDetails,
            "description": "ANDES failed to write the documentation of that model.",
        },
    },
)
async def get_model_doc(session_id: str, model: str, request: Request) -> ModelDoc:
    """The text ANDES prints for ``andes doc <model>``, verbatim: plain text
    set in tables 78 columns wide (a heading with the model and its group, the
    description, then the parameters with their defaults and units, the
    variables, the initialization, differential and algebraic equations, the
    services, discretes and blocks, and the model's config fields, as the
    model has them). Read it in a fixed-width font. The longest, of the renewable
    controllers, are under 30 kB.

    ``model`` is matched exactly, case included, against the names
    ``GET /sessions/{id}/models`` lists; any other name answers 404. No case
    is needed; the session's System is not touched.
    """
    payload = await _invoke(request, session_id, "model_doc", {"model": model})
    return ModelDoc.model_validate(payload)
