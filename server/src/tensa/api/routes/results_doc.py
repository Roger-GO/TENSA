"""``POST /results/convert``: one engine result in, a neutral results document
out (section 6.5 of ``design/multiengine/spec.md``).

The route holds no session: the body carries the engine's own result and the
session's keys lookup, and the answer carries the document beside the list of
what is not in it (``skipped``) and what the document has no field for
(``notes``). The builders live in ``tensa.engines.results_doc``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import ValidationError

from tensa.api.body_limit import body_limited_route, json_number_bytes
from tensa.api.schemas import ProblemDetails
from tensa.api.schemas.keys import KeyEntrySchema
from tensa.api.schemas.pflow import PflowResult as PflowResultWire
from tensa.api.schemas.results_doc import (
    MAX_CONVERT_SAMPLES_TOTAL,
    ConvertResultRequest,
    ConvertResultResponse,
)
from tensa.api.schemas.tds import TdsTraces
from tensa.core.eig_result import ComplexNumber, EigResult
from tensa.core.wrapper.results import (
    GeneratorOutput,
    LineFlow,
    LoadConsumption,
    PflowResult,
)
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.results_doc import (
    EngineBlock,
    ResultsDocError,
    eig_document,
    pflow_document,
    tds_document,
)

# The most bytes a body within the limits can be: a time and a value for each
# of ``MAX_CONVERT_SAMPLES_TOTAL`` samples. A larger one is answered 413 before
# it is read, as the metrics route's is.
MAX_CONVERT_BYTES = json_number_bytes(2 * MAX_CONVERT_SAMPLES_TOTAL)

router = APIRouter(
    route_class=body_limited_route(MAX_CONVERT_BYTES, "a results conversion request")
)



def _unprocessable(exc: ValidationError | ResultsDocError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=str(exc),
    )


def _pflow_result(data: dict[str, Any]) -> PflowResult:
    """The core ``PflowResult`` of the wire object the body carries.

    The wire model asks for ``run_id``, which the builder does not read; a
    body that leaves it out gets a placeholder. ``settings`` and ``summary``
    are not reconstructed: the builder does not read them either.
    """
    if "run_id" not in data:
        data = {**data, "run_id": "convert"}
    wire = PflowResultWire.model_validate(data)
    # The wire model keys the two bus dicts by string; the core dataclass
    # takes ``int | str`` keys, so the strings pass as they are once each
    # entry is copied with its key typed as the wider one.
    bus_voltages: dict[int | str, float] = {
        str(idx): v for idx, v in wire.bus_voltages.items()
    }
    bus_angles: dict[int | str, float] = {str(idx): a for idx, a in wire.bus_angles.items()}
    return PflowResult(
        converged=wire.converged,
        iterations=wire.iterations,
        mismatch=wire.mismatch,
        bus_voltages=bus_voltages,
        bus_angles=bus_angles,
        line_flows={
            idx: LineFlow(
                p=flow.p,
                q=flow.q,
                from_idx=flow.from_idx,
                to_idx=flow.to_idx,
                p_to=flow.p_to,
                q_to=flow.q_to,
                loss=flow.loss,
                rate_a=flow.rate_a,
                loading_pct=flow.loading_pct,
            )
            for idx, flow in wire.line_flows.items()
        },
        generator_outputs={
            idx: GeneratorOutput(
                p=out.p,
                q=out.q,
                v=out.v,
                bus=out.bus,
                q_min=out.q_min,
                q_max=out.q_max,
            )
            for idx, out in wire.generator_outputs.items()
        },
        load_consumption={
            idx: LoadConsumption(p=load.p, q=load.q, bus=load.bus)
            for idx, load in wire.load_consumption.items()
        },
        keys={kind: dict(entries) for kind, entries in wire.keys.items()},
    )


def _key_book(entries: list[KeyEntrySchema]) -> KeyBook:
    """A ``KeyBook`` rebuilt from the session's key entries the body carries, as
    ``GET /sessions/{id}/keys`` listed them: the models and buckets are the
    session's own, which is what ``neutral_name_andes`` looks a column up by
    (a machine column through the machine's ``dynamic`` entry)."""
    book = KeyBook()
    for entry in entries:
        book.assign(
            KeyEntry(
                key=entry.key,
                bucket=entry.bucket,
                model=entry.model,
                idx=entry.idx,
                source=entry.source,
            )
        )
    return book


def _eig_result(data: dict[str, Any]) -> EigResult:
    """The core ``EigResult`` of the JSON the body carries."""
    try:
        eigenvalues = [
            ComplexNumber(real=float(z["real"]), imag=float(z["imag"]))
            for z in data["eigenvalues"]
        ]
        return EigResult(
            eigenvalues=eigenvalues,
            damping_ratios=[float(d) for d in data["damping_ratios"]],
            frequencies_hz=[float(f) for f in data["frequencies_hz"]],
            mode_count=int(data["mode_count"]),
            state_count=int(data.get("state_count", len(eigenvalues))),
            state_names=[str(n) for n in data.get("state_names", [])],
            tds_initialized=bool(data.get("tds_initialized", False)),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ResultsDocError(f"the result does not fit kind 'eig': {exc}") from exc


@router.post(
    "/results/convert",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface yet; the comparison overlay of the Phase 6 "
            "comparison unit adds it."
        ),
    },
    operation_id="convertResult",
    summary="Turn one engine result into a neutral results document (tensa_results: 1).",
    response_model=ConvertResultResponse,
    responses={
        413: {
            "model": ProblemDetails,
            "description": (
                f"The body is larger than {MAX_CONVERT_BYTES // (1024 * 1024)} MiB. "
                "It is refused before it is read."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The body is malformed, the result does not fit its kind, the "
                "power flow did not converge, or a Sienna series name is not "
                "neutral. The detail says which."
            ),
        },
    },
)
async def convert_result(body: ConvertResultRequest) -> ConvertResultResponse:
    """Convert one engine result to the neutral document. Needs no session:
    send the result as the engine's API answered it, with the session's keys
    lookup for a time-domain result of an ANDES session."""
    engine = EngineBlock(name=body.engine, versions=body.versions)
    try:
        if body.kind == "pflow":
            document = pflow_document(
                _pflow_result(body.result), engine=engine, study=body.study
            )
            return ConvertResultResponse(document=document, skipped=[], notes=[])
        if body.kind == "tds":
            traces = TdsTraces.model_validate(body.result)
            book = None if body.engine == "sienna" else _key_book(body.keys)
            document, skipped, notes = tds_document(
                traces,
                engine=engine,
                study=body.study,
                status=body.status,
                key_book=book,
            )
            return ConvertResultResponse(document=document, skipped=skipped, notes=notes)
        document = eig_document(_eig_result(body.result), engine=engine, study=body.study)
        return ConvertResultResponse(document=document, skipped=[], notes=[])
    except (ValidationError, ResultsDocError) as exc:
        raise _unprocessable(exc) from exc
