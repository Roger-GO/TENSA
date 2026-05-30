"""Power-flow endpoints.

POST /sessions/{id}/pflow runs PF synchronously. The wrapper calls
``ss.setup()`` first if not yet committed (verified: PFlow.run does not
auto-call setup; see ANDES_VERSIONS.md contract #6). After this, no further
disturbances can be added until /reload.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from andes_app.api._run_as_job import _run_as_job
from andes_app.api.auth import RequireToken
from andes_app.api.error_mapping import map_worker_error
from andes_app.api.schemas import (
    GeneratorOutput,
    LineFlow,
    LoadConsumption,
    PflowResult,
    PflowRunRequest,
    ProblemDetails,
)
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
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


def _result_from_payload(payload: dict[str, Any], run_id: str) -> PflowResult:
    """Build a PflowResult response model from the wrapper's serialized
    PflowResult dict. The wrapper sends bus_voltages / bus_angles keyed by
    Python idx values (which can be int or str on the wire); JSON object keys
    must be strings, so we stringify them at the boundary."""
    raw_flows = payload.get("line_flows") or {}
    line_flows: dict[str, LineFlow] = {}
    for line_idx, flow in raw_flows.items():
        line_flows[str(line_idx)] = LineFlow(
            p=float(flow["p"]),
            q=float(flow["q"]),
            from_idx=flow["from_idx"],
            to_idx=flow["to_idx"],
        )
    raw_gen = payload.get("generator_outputs") or {}
    generator_outputs: dict[str, GeneratorOutput] = {}
    for gen_idx, gen in raw_gen.items():
        generator_outputs[str(gen_idx)] = GeneratorOutput(
            p=float(gen["p"]),
            q=float(gen["q"]),
            v=float(gen["v"]),
            bus=gen["bus"],
        )
    raw_load = payload.get("load_consumption") or {}
    load_consumption: dict[str, LoadConsumption] = {}
    for load_idx, load in raw_load.items():
        load_consumption[str(load_idx)] = LoadConsumption(
            p=float(load["p"]),
            q=float(load["q"]),
            bus=load["bus"],
        )
    return PflowResult(
        run_id=run_id,
        converged=bool(payload["converged"]),
        iterations=int(payload["iterations"]),
        mismatch=float(payload["mismatch"]),
        bus_voltages={str(k): float(v) for k, v in payload["bus_voltages"].items()},
        bus_angles={str(k): float(v) for k, v in payload["bus_angles"].items()},
        line_flows=line_flows,
        generator_outputs=generator_outputs,
        load_consumption=load_consumption,
    )


def _to_http_error(exc: WorkerError) -> HTTPException:
    """Route-local adapter over the shared ``map_worker_error`` (Unit 4b).

    The shared mapper owns the canonical category→status table, the recovery
    descriptor, and the ProblemDetails body shape. This route only carries its
    one documented detail-copy delta: ``SetupFailedError`` gets the actionable
    "reload to recover" hint appended (``RunButton.tsx`` keys off ``/reload/i``).
    ``EigDirtyDaeError`` already carries the reload hint in the wrapper detail.
    """
    if exc.category == "SetupFailedError":
        exc.detail = (
            f"{exc.detail} — call POST /api/sessions/{{id}}/reload to recover."
        )
    return map_worker_error(exc)


@router.post(
    "/sessions/{session_id}/pflow",
    openapi_extra={"x-andes-app-gui-location": "run-controls"},
    operation_id="runPflow",
    summary="Run power flow on the session's loaded case.",
    response_model=PflowResult,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "ANDES setup() failed, OR a previous EIG run mutated dae "
                "state (``TDS.initialized=True``). Either case requires "
                "POST /reload to recover."
            ),
        },
    },
)
async def run_pflow(
    session_id: str,
    body: PflowRunRequest,
    request: Request,
    _: RequireToken,
) -> PflowResult:
    mgr = _manager(request)
    try:
        async with _run_as_job(
            mgr, session_id, "pflow", request_summary=body.model_dump()
        ) as job_id:
            payload = await mgr.invoke(session_id, "run_pflow", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    run_id = uuid.uuid4().hex
    result = _result_from_payload(payload, run_id)
    result.job_id = job_id
    return result


@router.get(
    "/sessions/{session_id}/operating-point",
    openapi_extra={"x-andes-app-gui-location": "data-grid"},
    operation_id="getOperatingPoint",
    summary="Read the session's current operating point (bus V/θ) without running.",
    response_model=PflowResult,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": "No case has been loaded into this session.",
        },
    },
)
async def get_operating_point(
    session_id: str,
    request: Request,
    _: RequireToken,
) -> PflowResult:
    """Return the System's current solved bus voltages/angles WITHOUT
    re-running anything. After a TDS run the data grid otherwise sits empty
    (only PF writes ``usePflowStore.lastRun``); the client fetches this on
    run completion to surface the final operating point. Read-only — does
    not run a job or mutate dae state."""
    mgr = _manager(request)
    try:
        payload = await mgr.invoke(session_id, "operating_point", {})
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _to_http_error(exc) from exc

    return _result_from_payload(payload, uuid.uuid4().hex)
