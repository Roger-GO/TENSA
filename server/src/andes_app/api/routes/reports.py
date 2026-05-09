"""Report endpoints (Unit 4 of the v2.0 plan).

Hosts ``GET /sessions/{id}/report?routine={pflow|tds}`` which renders a
human-readable plain-text report plus a structured table list ready for
LaTeX serialisation on the frontend.

Phase 1 endpoint scope: ``pflow|tds`` only. The route's enum widens to
include ``eig`` in Unit 6 (alongside the EIG analysis routine itself);
until then a request with ``routine=eig`` returns 422 with a polite
"ships in Unit 6" message so an early-call agent gets a clear signal.

The structured table parser is best-effort — for any section the
parser can't recognise the frontend falls back to the verbatim plain
text. Per the plan's KTD: don't gate the endpoint on parser
completeness, the verbatim text is the source of truth.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from andes_app.api.auth import RequireToken
from andes_app.api.schemas import ProblemDetails
from andes_app.core.session import (
    SessionExpiredError,
    SessionManager,
    WorkerError,
)

router = APIRouter()


# ---- request / response schemas -------------------------------------------


class ReportRoutineEnum(str, Enum):
    """Routines that can be reported. Phase 1 (Unit 4) only honours
    ``pflow`` and ``tds``; ``eig`` is accepted at the wire layer but
    immediately rejected with 422 so Unit 6 can land without breaking
    any caller already passing it."""

    PFLOW = "pflow"
    TDS = "tds"
    EIG = "eig"


class ReportTableModel(BaseModel):
    """One tabular block of a routine's report.

    Matches :class:`andes_app.core.report.ReportTable` 1:1. Each row's
    length always matches ``headers`` — the wrapper-side parser pads /
    truncates so the frontend's renderer doesn't have to think about
    ragged rows.
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., description="Section title (e.g., ``BUS DATA``).")
    headers: list[str] = Field(..., description="Column names, in order.")
    rows: list[list[str]] = Field(
        ...,
        description=(
            "Rows of stringified cell values. Numeric columns are pre-formatted "
            "by the wrapper so the frontend can render verbatim without locale "
            "issues."
        ),
    )


class ReportStructured(BaseModel):
    """Structured-table envelope. Empty ``tables`` is valid — the frontend
    falls back to the plain-text view."""

    model_config = ConfigDict(extra="forbid")

    tables: list[ReportTableModel] = Field(
        default_factory=list,
        description=(
            "Best-effort parse of the plain-text report into tabular blocks. "
            "Empty when the parser couldn't recognise any sections; the "
            "``plain_text`` body remains the source of truth."
        ),
    )


class ReportResponse(BaseModel):
    """Wire shape of ``GET /sessions/{id}/report``."""

    model_config = ConfigDict(extra="forbid")

    routine: ReportRoutineEnum = Field(
        ..., description="Echo of the requested routine."
    )
    plain_text: str = Field(
        ...,
        description=(
            "Verbatim report text — for ``pflow``, the file ANDES would "
            "have written to ``<case>_out.txt``; for ``tds``, "
            "``TDS.summary()``'s log output augmented with run statistics."
        ),
    )
    structured: ReportStructured = Field(
        ...,
        description="Structured tabular blocks parsed out of ``plain_text``.",
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


def _map_worker_error(exc: WorkerError) -> HTTPException:
    """Map worker error categories to HTTP responses for the report route.

    The four substantively-distinct failure modes:

    - ``no-case-loaded`` → 409 (no case at all on this session).
    - ``PflowNotConvergedError`` / ``TdsNotRunError`` → 409 with the
      pre-condition message verbatim (the UI's empty state shows it as-is).
    - ``ReportGenerationError`` → 500 with the original ANDES error text.
    - ``AndesAppError`` and unknown categories → 500.
    """
    if exc.category == "no-case-loaded":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if exc.category in {"PflowNotConvergedError", "TdsNotRunError"}:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=exc.detail,
        )
    if exc.category == "ReportGenerationError":
        return HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=exc.detail,
        )
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"{exc.category}: {exc.detail}",
    )


# ---- routes ---------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/report",
    operation_id="getReport",
    summary="Render a human-readable report from PFlow or TDS results.",
    response_model=ReportResponse,
    responses={
        401: {"model": ProblemDetails, "description": "Missing or invalid X-Andes-Token."},
        404: {"model": ProblemDetails, "description": "Session not found or already closed."},
        409: {
            "model": ProblemDetails,
            "description": (
                "The routine pre-condition is not met — for ``pflow``, no "
                "converged PFlow result; for ``tds``, no completed TDS run."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The requested routine is not yet supported in Phase 1. "
                "``eig`` ships in Unit 6 of the v2.0 plan."
            ),
        },
        500: {
            "model": ProblemDetails,
            "description": (
                "ANDES's report writer failed. The detail carries the "
                "underlying ANDES error verbatim."
            ),
        },
    },
)
async def get_report(
    session_id: str,
    request: Request,
    _: RequireToken,
    routine: ReportRoutineEnum = Query(
        ...,
        description=(
            "Which routine to report on. ``pflow`` requires a converged "
            "power-flow result; ``tds`` requires a completed TDS run. "
            "``eig`` is accepted at the schema level but rejected with "
            "422 until Unit 6 ships."
        ),
    ),
) -> ReportResponse:
    """Produce a routine report and return ``{plain_text, structured}``.

    Phase 1 (Unit 4) handles ``pflow`` and ``tds`` only. ``eig`` is
    deliberately accepted by the schema (so the frontend's enum doesn't
    have to widen in lockstep with Unit 6) but immediately rejected
    with 422 + a forward-looking message.
    """
    if routine == ReportRoutineEnum.EIG:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "EIG report variant ships in Unit 6 of the v2.0 plan; "
                "use ``pflow`` or ``tds`` until then."
            ),
        )

    mgr = _manager(request)
    args: dict[str, Any] = {"routine": routine.value}
    try:
        payload = await mgr.invoke(session_id, "generate_report", args)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except WorkerError as exc:
        raise _map_worker_error(exc) from exc

    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "worker returned a non-dict payload for generate_report: "
                f"{type(payload).__name__}"
            ),
        )

    tables_raw = payload.get("tables") or []
    structured_tables = [
        ReportTableModel(
            title=str(t.get("title", "")),
            headers=[str(h) for h in (t.get("headers") or [])],
            rows=[[str(c) for c in row] for row in (t.get("rows") or [])],
        )
        for t in tables_raw
    ]
    return ReportResponse(
        routine=routine,
        plain_text=str(payload.get("plain_text", "")),
        structured=ReportStructured(tables=structured_tables),
    )
