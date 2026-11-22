"""``POST /studies``: one study on several engines (section 10 of ``design/multiengine/spec.md``). A session per engine from the same case, the study run on each, the results documents back with each engine's document compared against the first's. Sessions made here are closed here, whatever happens."""

from __future__ import annotations

import contextlib
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import ValidationError

from tensa.api.body_limit import body_limited_route, json_number_bytes
from tensa.api.error_mapping import map_worker_error
from tensa.api.routes.compare import _pair_out, _row_out, _series_out
from tensa.api.routes.pflow import _result_from_payload
from tensa.api.routes.results_doc import _eig_result, _key_book, _pflow_result
from tensa.api.schemas import (
    CompareResponse,
    NotComparableOut,
    PflowComparisonOut,
    ProblemDetails,
    UnmatchedKeysOut,
)
from tensa.api.schemas.keys import KeyEntrySchema
from tensa.api.schemas.studies import (
    EngineStudyOutcome,
    StudyCaseRef,
    StudyRequest,
    StudyResponse,
)
from tensa.api.schemas.tds import TdsTraces, TdsTraceSeries
from tensa.core.errors import EngineUnavailableError
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError
from tensa.core.stream import decode_batch
from tensa.engines.compare import (
    CompareError,
    ComparisonInput,
    compare_documents,
)
from tensa.engines.ops import ENGINE_NAMES, ENGINE_OPS
from tensa.engines.results_doc import (
    EngineBlock,
    ResultsDocError,
    ResultsDocument,
    ResultsTables,
    Series,
    eig_document,
    pflow_document,
    tds_document,
)
from tensa.engines.study_doc import (
    ROUTINE_OPS,
    Disturbance,
    StudyDocError,
    StudyDocument,
    engines_refusing,
)
from tensa.security.paths import WorkspacePathError, open_workspace_file_for_andes

# A study request is small: the case is file paths and the study is a
# document. A larger body is answered 413 before it is read.
MAX_STUDY_BYTES = json_number_bytes(20_000)

router = APIRouter(route_class=body_limited_route(MAX_STUDY_BYTES, "a study request"))

# Per-op timeouts, backstops; the watchdog in SessionManager handles a wedged
# session. A study runs each engine's session one op at a time, so these are
# the per-call values of the routes the study maps to.
LOAD_CASE_TIMEOUT = 120.0
PFLOW_TIMEOUT = 120.0
TDS_TIMEOUT = 300.0  # the batch tds route's own backstop
EIG_TIMEOUT = 300.0
MATRICES_TIMEOUT = 120.0
DISPATCH_TIMEOUT = 600.0
STUDY_TOTAL_TIMEOUT = 1800.0  # the whole request, all engines

# The neutral pflow options of section 6.2 and the run_pflow args they map to.
# No pass-through of arbitrary keys: an option not in this table is refused.
_PFLOW_OPTION_ARGS: dict[str, str] = {
    "tolerance": "tolerance",
    "max_iterations": "max_iterations",
    "solver": "method",
    "enforce_q_limits": "enforce_q_limits",
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


async def _invoke(
    mgr: SessionManager, sid: str, op: str, args: dict[str, Any], timeout: float
) -> Any:
    """One op on one session; ``SessionExpiredError`` becomes a 404 naming the
    engine's session, ``WorkerError`` is re-raised for the caller to map."""
    try:
        return await mgr.invoke(sid, op, args, timeout=timeout)
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)
        ) from exc


def _refusal_problem(engine: str, study: StudyDocument) -> dict[str, Any]:
    """The problem document of an engine that lacks the study's routine.

    Section 9: an op the engine's table lacks is answered with category
    ``engine_unsupported`` and the API turns it into a 409 problem document
    whose ``recovery`` names the engines that have the op. Here the refusal is
    known before any session is made, so the document is built directly, with
    the same shape."""
    op = ROUTINE_OPS[study.routine]
    have = [name for name in ENGINE_NAMES if op in ENGINE_OPS[name]]
    return {
        "status": 409,
        "category": "engine_unsupported",
        "detail": (
            f"engine {engine!r} has no routine {study.routine!r} "
            f"(op {op!r}); the engines that have it: {have}"
        ),
        "recovery": {"engines": have},
    }


def _pflow_args(study: StudyDocument) -> dict[str, Any]:
    """The run_pflow args of a pflow study's neutral options (section 6.2)."""
    args: dict[str, Any] = {}
    for key, value in study.options.items():
        arg = _PFLOW_OPTION_ARGS.get(key)
        if arg is None:
            if key == "initialization":
                if value == "flat":
                    args["flat_start"] = True
                    continue
                raise StudyDocError(
                    f"pflow initialization {value!r} is not one this server runs ('flat')"
                )
            raise StudyDocError(
                f"unknown pflow option {key!r}; the neutral options are "
                f"{sorted(_PFLOW_OPTION_ARGS)} and 'initialization'"
            )
        args[arg] = value
    return args


def _disturbance_spec(
    disturbance: Disturbance, engine: str, keys: list[dict[str, Any]]
) -> dict[str, Any]:
    """The add_disturbance spec of one study disturbance (section 6.4)."""
    if disturbance.kind == "bus_fault":
        assert disturbance.bus is not None
        # The bus's idx in this engine, from the session's key listing: an
        # ANDES case's bus idx need not be its number, and ANDES keys it by type.
        bus_entry = next((e for e in keys if e.get("key") == disturbance.bus), None)
        if bus_entry is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"disturbance bus {disturbance.bus!r} is not a bus of the case",
            )
        return {
            "kind": "fault",
            "bus_idx": bus_entry["idx"],
            "tf": disturbance.t_on,
            "tc": disturbance.t_clear,
            "xf": disturbance.x_pu,
            "rf": disturbance.r_pu,
        }
    assert disturbance.target is not None
    entry = next((e for e in keys if e.get("key") == disturbance.target), None)
    if entry is None:
        raise StudyDocError(
            f"disturbance target {disturbance.target!r} is not an element of "
            f"the case as {engine} holds it"
        )
    model = str(entry["model"])
    idx = entry["idx"]
    if disturbance.kind in ("branch_trip", "branch_close", "gen_trip"):
        return {"kind": "toggle", "model": model, "dev_idx": idx, "t": disturbance.t}
    if disturbance.kind == "load_step":
        return {
            "kind": "alter",
            "model": model,
            "dev_idx": idx,
            "src": "p0",
            "t": disturbance.t,
            "method": "=",
            "amount": disturbance.p_mw,
        }
    if disturbance.kind == "setpoint":
        return {
            "kind": "alter",
            "model": model,
            "dev_idx": idx,
            "src": str(disturbance.signal),
            "t": disturbance.t,
            "method": "=",
            "amount": disturbance.value,
        }
    return {
        "kind": "alter",
        "model": model,
        "dev_idx": idx,
        "src": str(disturbance.param),
        "t": disturbance.t,
        "method": "=",
        "amount": disturbance.value,
    }


def _tds_args(study: StudyDocument, engine: str) -> dict[str, Any]:
    """The run_tds args of a tds study's options."""
    options = study.options
    if "t_end" not in options:
        raise StudyDocError("a tds study needs options.t_end")
    args: dict[str, Any] = {"tf": options["t_end"]}
    if "step" in options:
        args["h"] = options["step"]
    args["load_model"] = study.load_model or "impedance"
    method = options.get("method")
    if method is not None and engine == "andes":
        if method == "adaptive":
            raise StudyDocError("an andes tds study takes no adaptive method")
        # ``default`` and ``fixed`` are the engine's own integrator: omit.
    elif method is not None:
        args["solver"] = method
    return args


def _filter_record(document: ResultsDocument, study: StudyDocument) -> ResultsDocument:
    """The document with its series filtered to the study's ``record`` list.

    A record entry ``{"quantity": q, "of": "kind:*"}`` keeps every series of
    that quantity whose key is of that kind; ``{"quantity": q, "of": key}``
    keeps exactly that series. An empty record list keeps everything.
    """
    if not study.record:
        return document

    def _kept(series: Series) -> bool:
        for spec in study.record:
            if spec.quantity != series.quantity:
                continue
            if spec.of.endswith(":*"):
                if series.of.split(":", 1)[0] == spec.of.split(":", 1)[0]:
                    return True
            elif series.of == spec.of:
                return True
        return False

    return document.model_copy(update={"series": [s for s in document.series if _kept(s)]})


def _matrix_args(study: StudyDocument) -> dict[str, Any]:
    """The network_matrix args of a matrices study's options."""
    kind = study.options.get("kind", "ptdf")
    return {"kind": kind}


_DISPATCH_REQUIRED: tuple[str, ...] = ("network_model",)


def _dispatch_args(study: StudyDocument) -> dict[str, Any]:
    """The run_dispatch args of a dispatch study's options (section 6.1)."""
    for name in _DISPATCH_REQUIRED:
        if name not in study.options:
            raise StudyDocError(f"a dispatch study needs options.{name}")
    args: dict[str, Any] = {"network_model": study.options["network_model"]}
    for name in ("horizon", "resolution", "solver", "template", "duals"):
        if name in study.options:
            args[name] = study.options[name]
    return args


def _empty_document(engine: EngineBlock, study: StudyDocument) -> ResultsDocument:
    """The document of a routine the results document has no table for yet."""
    return ResultsDocument(
        tensa_results=1,
        engine=engine,
        study=study.model_dump(mode="json"),
        status="completed",
        series=[],
        tables=ResultsTables(),
    )


async def _run_study(
    mgr: SessionManager, sid: str, engine: str, study: StudyDocument
) -> tuple[ResultsDocument, dict[str, Any] | None]:
    """Run the study on one session and build its results document. The second
    value is the engine's own answer for a routine with no document table."""
    block = EngineBlock(name=engine, versions={})
    study_dump = study.model_dump(mode="json")
    if study.routine == "pflow":
        payload = await _invoke(mgr, sid, "run_pflow", _pflow_args(study), PFLOW_TIMEOUT)
        versions = payload.get("versions", {}) if isinstance(payload, dict) else {}
        block = EngineBlock(name=engine, versions=versions)
        return (
            pflow_document(_pflow_result(_pflow_wire(payload)), engine=block, study=study_dump),
            None,
        )
    if study.routine == "tds":
        keys_payload = await _invoke(mgr, sid, "list_keys", {}, LOAD_CASE_TIMEOUT)
        keys: list[dict[str, Any]] = list(keys_payload.get("keys", keys_payload))
        for disturbance in study.disturbances:
            spec = _disturbance_spec(disturbance, engine, keys)
            await _invoke(mgr, sid, "add_disturbance", {"spec": spec}, LOAD_CASE_TIMEOUT)
        # Both engines start a dynamic run from a solved power flow; a Sienna
        # session refuses one without it, and ANDES takes the disturbances
        # only before the power flow commits its setup, so it comes after them.
        await _invoke(mgr, sid, "run_pflow", {}, PFLOW_TIMEOUT)
        if engine == "andes":
            # An ANDES batch run records only the variables it is named
            # (dae_vars); its stream carries every bus and machine column,
            # which is what tds_document maps to keys.
            payload, traces = await _streamed_tds(mgr, sid, _tds_args(study, engine))
        else:
            payload = await _invoke(mgr, sid, "run_tds", _tds_args(study, engine), TDS_TIMEOUT)
            traces = TdsTraces.model_validate(payload["traces"])
        versions = payload.get("versions", {}) if isinstance(payload, dict) else {}
        block = EngineBlock(name=engine, versions=versions)
        book = None if engine == "sienna" else _key_book(
            [KeyEntrySchema.model_validate(e) for e in keys]
        )
        document, _skipped, _notes = tds_document(
            traces, engine=block, study=study_dump, key_book=book
        )
        return _filter_record(document, study), None
    if study.routine == "eig":
        args: dict[str, Any] = {}
        if study.load_model is not None:
            args["load_model"] = study.load_model
        await _invoke(mgr, sid, "run_pflow", {}, PFLOW_TIMEOUT)
        payload = await _invoke(mgr, sid, "run_eig", args, EIG_TIMEOUT)
        versions = payload.get("versions", {}) if isinstance(payload, dict) else {}
        block = EngineBlock(name=engine, versions=versions)
        return (
            eig_document(_eig_result(dict(payload)), engine=block, study=study_dump),
            None,
        )
    if study.routine == "matrices":
        payload = await _invoke(
            mgr, sid, "network_matrix", _matrix_args(study), MATRICES_TIMEOUT
        )
        return _empty_document(block, study), dict(payload)
    payload = await _invoke(
        mgr, sid, "run_dispatch", _dispatch_args(study), DISPATCH_TIMEOUT
    )
    return _empty_document(block, study), dict(payload)


async def _streamed_tds(
    mgr: SessionManager, sid: str, args: dict[str, Any]
) -> tuple[Any, TdsTraces]:
    """Run TDS as a stream, as the WebSocket route does, and collect its
    frames into traces named by the stream's columns."""
    names: list[str] = []
    times: list[float] = []
    rows: list[list[float]] = []

    async def on_metadata(metadata: dict[str, Any]) -> None:
        names.extend(str(name) for name in metadata.get("var_columns") or [])

    async def on_frame(frame: bytes) -> None:
        t, values = decode_batch(frame)
        times.extend(float(v) for v in t)
        rows.extend(values.tolist())

    try:
        payload = await mgr.invoke_streaming(
            sid,
            "run_tds",
            {**args, "stream": True},
            on_metadata=on_metadata,
            on_frame=on_frame,
            timeout=TDS_TIMEOUT,
        )
    except SessionExpiredError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    traces = TdsTraces(
        t=times,
        variables=[
            TdsTraceSeries(name=name, values=[row[i] for row in rows])
            for i, name in enumerate(names)
        ],
        truncated=False,
    )
    return payload, traces


def _pflow_wire(payload: Any) -> dict[str, Any]:
    """The worker's power flow answer in the shape ``POST /sessions/{id}/pflow``
    answers it (bus maps keyed by strings), which ``_pflow_result`` reads."""
    return _result_from_payload(dict(payload), run_id="study").model_dump(mode="json")


def _case_paths(workspace: Any, case: StudyCaseRef) -> tuple[str, list[str]]:
    """The case's files, validated and made canonical under the workspace the
    way ``POST /sessions/{id}/case`` does it, before any session is made: a
    path outside the workspace, absolute, with a NUL byte or missing is a 400."""
    try:
        with open_workspace_file_for_andes(workspace, case.primary_path) as primary:
            addfiles: list[str] = []
            for addfile in case.addfiles:
                with open_workspace_file_for_andes(workspace, addfile) as canonical:
                    addfiles.append(str(canonical))
            return str(primary), addfiles
    except WorkspacePathError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


async def _run_on_engine(
    mgr: SessionManager,
    engine: str,
    paths: tuple[str, list[str]],
    study: StudyDocument,
) -> EngineStudyOutcome:
    """Create a session for ``engine``, load the case, run the study, close the
    session. The session is closed in a ``finally``, whatever happens."""
    primary, addfiles = paths
    sid = await mgr.create_session(engine)
    try:
        await _invoke(
            mgr,
            sid,
            "load_case",
            {"path": primary, "addfiles": addfiles or None},
            LOAD_CASE_TIMEOUT,
        )
        document, raw = await _run_study(mgr, sid, engine, study)
        return EngineStudyOutcome(
            engine=engine, ran=True, document=document, problem=None, raw=raw
        )
    finally:
        with contextlib.suppress(Exception):
            await mgr.close_session(sid)


def _has_content(document: ResultsDocument) -> bool:
    """Whether a document holds anything a comparison reads."""
    return bool(document.series) or document.tables.pflow is not None or document.tables.eig is not None


def _comparison_entry(
    reference: EngineStudyOutcome,
    outcome: EngineStudyOutcome,
    body: StudyRequest,
) -> dict[str, Any]:
    """One comparisons entry: the outcome's document against the reference's,
    as ``POST /compare`` answers, with an added ``engine`` field."""
    assert reference.document is not None and outcome.document is not None
    try:
        result = compare_documents(
            ComparisonInput.from_document(reference.document),
            ComparisonInput.from_document(outcome.document),
            tolerances=body.tolerances.quantities,
            freq_tolerance_hz=body.tolerances.frequency_hz,
            damping_tolerance=body.tolerances.damping_ratio,
            max_mode_distance=body.tolerances.max_mode_distance,
        )
    except CompareError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc
    power_flow: PflowComparisonOut | None = None
    if result.power_flow is not None:
        power_flow = PflowComparisonOut(
            converged_reference=result.power_flow.converged_reference,
            converged_comparison=result.power_flow.converged_comparison,
            rows=[_row_out(row) for row in result.power_flow.rows],
            unmatched=UnmatchedKeysOut(
                missing_in_comparison=result.power_flow.unmatched.missing_in_comparison,
                missing_in_reference=result.power_flow.unmatched.missing_in_reference,
            ),
        )
    response = CompareResponse(
        engine_reference=result.engine_reference,
        engine_comparison=result.engine_comparison,
        operating_point_differs=result.operating_point_differs,
        power_flow=power_flow,
        series=[_series_out(row) for row in result.series],
        not_comparable=[
            NotComparableOut(quantity=row.quantity, key=row.key, reason=row.reason)
            for row in result.not_comparable
        ],
        unmatched_series_reference=result.unmatched_series_reference,
        unmatched_series_comparison=result.unmatched_series_comparison,
        eigenvalues=[_pair_out(pair) for pair in result.eigenvalues],
        unmatched_eigenvalues_reference=result.unmatched_eigenvalues_reference,
        unmatched_eigenvalues_comparison=result.unmatched_eigenvalues_comparison,
        errors=result.errors,
    )
    return {"engine": outcome.engine, **response.model_dump(mode="json")}


@router.post(
    "/studies",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface yet; the comparison overlay of the Phase 6 web unit adds it."
        ),
    },
    operation_id="runStudy",
    summary="Run one study on several engines and compare the results documents.",
    response_model=StudyResponse,
    responses={
        404: {
            "model": ProblemDetails,
            "description": "A session was closed under the study.",
        },
        409: {
            "model": ProblemDetails,
            "description": "An engine is not available; the detail says why.",
        },
        413: {
            "model": ProblemDetails,
            "description": "The body is larger than the limit; refused before it is read.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The body or the study document is malformed, or an engine's run "
                "failed in a way the study cannot report as a refusal."
            ),
        },
        504: {
            "model": ProblemDetails,
            "description": "The study did not finish in time over all engines.",
        },
    },
)
async def run_study(body: StudyRequest, request: Request) -> StudyResponse:
    """Run one study on each named engine, one after the other, and compare
    each engine's results document against the first engine's that ran. An
    engine whose op table lacks the study's routine answers its refusal beside
    the others' results, and no session is made for it."""
    mgr = _manager(request)
    paths = _case_paths(request.app.state.workspace, body.case)
    started = time.monotonic()
    refusing = engines_refusing(body.study)
    outcomes: list[EngineStudyOutcome] = []
    for engine in body.engines:
        if engine in refusing:
            outcomes.append(
                EngineStudyOutcome(
                    engine=engine,
                    ran=False,
                    document=None,
                    problem=_refusal_problem(engine, body.study),
                    raw=None,
                )
            )
            continue
        if time.monotonic() - started > STUDY_TOTAL_TIMEOUT:
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="the study did not finish in 1800 s over all engines",
            )
        try:
            outcome = await _run_on_engine(mgr, engine, paths, body.study)
        except EngineUnavailableError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=str(exc)
            ) from exc
        except WorkerError as exc:
            raise map_worker_error(exc) from exc
        except (ResultsDocError, StudyDocError, ValidationError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
            ) from exc
        outcomes.append(outcome)
    ran = [o for o in outcomes if o.ran and o.document is not None]
    comparisons: list[dict[str, Any]] = []
    if len(ran) >= 2:
        reference = ran[0]
        for outcome in ran[1:]:
            assert reference.document is not None and outcome.document is not None
            if not _has_content(reference.document) and not _has_content(outcome.document):
                continue  # raw-only outcomes (matrices, dispatch) have nothing to compare
            comparisons.append(_comparison_entry(reference, outcome, body))
    return StudyResponse(outcomes=outcomes, comparisons=comparisons)
