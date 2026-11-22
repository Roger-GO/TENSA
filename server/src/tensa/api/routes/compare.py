"""Comparison endpoint: two results documents side by side.

``POST /compare`` holds no session. The web UI sends the two results documents
it just plotted, and a script or an agent sends two archived ones. The
comparison itself lives in ``tensa.engines.compare``: per quantity and key the
largest and the time-weighted RMS difference over the overlap of the two time
ranges, the swing of the reference series, and the eigenvalues matched as
modes. The power flow comparison comes first: a dynamic difference that starts
from a different operating point is reported as that.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from tensa.api.body_limit import body_limited_route, json_number_bytes
from tensa.api.schemas import (
    MAX_COMPARE_SAMPLES_TOTAL,
    MAX_COMPARE_TABLE_ROWS,
    CompareRequest,
    CompareResponse,
    EigenvaluePairOut,
    NotComparableOut,
    PflowComparisonOut,
    ProblemDetails,
    SeriesDifferenceOut,
    TableRowDifferenceOut,
    UnmatchedKeysOut,
)
from tensa.api.schemas.compare import _resolve_document_models
from tensa.engines.compare import (
    CompareError,
    ComparisonInput,
    EigenvaluePair,
    SeriesDifference,
    TableRowDifference,
    compare_documents,
)
from tensa.engines.results_doc import validate_results_document

# ``CompareRequest`` and ``CompareResponse`` name the document models of
# ``tensa.engines.results_doc`` as forward references (a module-level import
# there would be circular); resolve them before FastAPI builds the route.
_resolve_document_models()

# The most bytes a body within the limits can be: a time and a value for each
# of ``MAX_COMPARE_SAMPLES_TOTAL`` samples, four numbers per eigenvalue row and
# up to six per power flow row. A larger one is answered 413 before it is read
# (``tensa.api.body_limit``).
MAX_COMPARE_BYTES = json_number_bytes(
    2 * MAX_COMPARE_SAMPLES_TOTAL + 10 * MAX_COMPARE_TABLE_ROWS
)

router = APIRouter(route_class=body_limited_route(MAX_COMPARE_BYTES, "a compare request"))


def _document_problems(body: CompareRequest) -> list[str]:
    """The problems of the two documents, each prefixed with its side."""
    problems = [f"reference: {p}" for p in validate_results_document(body.reference)]
    problems.extend(f"comparison: {p}" for p in validate_results_document(body.comparison))
    return problems


def _row_out(row: TableRowDifference) -> TableRowDifferenceOut:
    return TableRowDifferenceOut(
        quantity=row.quantity,
        key=row.key,
        unit=row.unit,
        reference=row.reference,
        value=row.value,
        diff=row.diff,
        within_tolerance=row.within_tolerance,
        tolerance=row.tolerance,
    )


def _series_out(row: SeriesDifference) -> SeriesDifferenceOut:
    return SeriesDifferenceOut(
        quantity=row.quantity,
        key=row.key,
        unit=row.unit,
        samples=row.samples,
        t_start=row.t_start,
        t_end=row.t_end,
        max_diff=row.max_diff,
        max_diff_t=row.max_diff_t,
        rms_diff=row.rms_diff,
        swing_ref=row.swing_ref,
        within_tolerance=row.within_tolerance,
        tolerance=row.tolerance,
    )


def _pair_out(pair: EigenvaluePair) -> EigenvaluePairOut:
    return EigenvaluePairOut(
        index_ref=pair.index_ref,
        index_new=pair.index_new,
        eigenvalue_ref_re=pair.eigenvalue_ref.real,
        eigenvalue_ref_im=pair.eigenvalue_ref.imag,
        eigenvalue_new_re=pair.eigenvalue_new.real,
        eigenvalue_new_im=pair.eigenvalue_new.imag,
        distance=pair.distance,
        frequency_hz_ref=pair.frequency_hz_ref,
        frequency_hz_new=pair.frequency_hz_new,
        damping_ratio_ref=pair.damping_ratio_ref,
        damping_ratio_new=pair.damping_ratio_new,
        within_tolerance=pair.within_tolerance,
    )


@router.post(
    "/compare",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface yet; the comparison view of the Phase 6 web unit adds it."
        ),
    },
    operation_id="compareResults",
    summary=(
        "Compare two results documents: per quantity and key the largest and "
        "RMS difference over the overlap of the time ranges, the swing of the "
        "reference, and the eigenvalues matched as modes."
    ),
    response_model=CompareResponse,
    responses={
        413: {
            "model": ProblemDetails,
            "description": (
                f"The body is larger than {MAX_COMPARE_BYTES // (1024 * 1024)} MiB, more "
                f"than a request within the limits takes ({MAX_COMPARE_SAMPLES_TOTAL} "
                "samples in all). It is refused before it is read."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The body is malformed or a limit is exceeded, a document has "
                "problems (the detail names the side and each problem), or the "
                "two documents give one series different units. A series that "
                "only cannot be compared (too few samples, no overlap) is not "
                "an error: it is listed in ``not_comparable``."
            ),
        },
    },
)
async def compare_results(body: CompareRequest) -> CompareResponse:
    """Compare the ``comparison`` document against the ``reference`` one.

    Both documents are validated first; one with problems is refused with a
    422 that names the side and each problem, and nothing is compared. The
    power flow comparison comes first, then the series, then the eigenvalues.
    Differences are comparison minus reference; for quantities in radians the
    difference is wrapped to [-pi, pi). Unmatched keys and modes are listed,
    never ignored. A unit mismatch on a pair of series is a 422, because the
    two documents disagree about what the number is."""
    problems = _document_problems(body)
    if problems:
        raise HTTPException(status_code=422, detail="; ".join(problems))
    try:
        result = compare_documents(
            ComparisonInput.from_document(body.reference),
            ComparisonInput.from_document(body.comparison),
            tolerances=body.tolerances.quantities,
            freq_tolerance_hz=body.tolerances.frequency_hz,
            damping_tolerance=body.tolerances.damping_ratio,
            max_mode_distance=body.tolerances.max_mode_distance,
        )
    except CompareError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
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
    return CompareResponse(
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
