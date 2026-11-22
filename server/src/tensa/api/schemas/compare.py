"""Comparison of two results documents: ``POST /compare``.

The document models are the landed ones of ``tensa.engines.results_doc``; this
module defines only the comparison's own models: the tolerances, the request
and the answer.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

if TYPE_CHECKING:
    from tensa.engines.results_doc import EngineBlock, ResultsDocument


def _resolve_document_models() -> None:
    """Resolve the forward references to the document models.

    ``tensa.engines.results_doc`` imports ``tensa.api.schemas.tds``, whose
    package ``__init__`` imports this module, so the document models cannot be
    imported at module level: they are imported on first use and the models
    that name them are rebuilt with the real classes.
    """
    global _DOCUMENT_MODELS_RESOLVED
    if _DOCUMENT_MODELS_RESOLVED:
        return
    from tensa.engines.results_doc import EngineBlock, ResultsDocument

    namespace = {"EngineBlock": EngineBlock, "ResultsDocument": ResultsDocument}
    CompareRequest.model_rebuild(_types_namespace=namespace)
    CompareResponse.model_rebuild(_types_namespace=namespace)
    _DOCUMENT_MODELS_RESOLVED = True


_DOCUMENT_MODELS_RESOLVED = False


def _engine_defaults() -> tuple[float, float, float]:
    """The default tolerances of ``tensa.engines.compare``, imported lazily:
    that module names the document models of ``tensa.engines.results_doc``,
    whose import chain reaches this module, so a module-level import here
    would be circular."""
    from tensa.engines.compare import (
        DEFAULT_DAMPING_TOLERANCE,
        DEFAULT_FREQ_TOLERANCE_HZ,
        DEFAULT_MAX_MODE_DISTANCE,
    )

    return DEFAULT_FREQ_TOLERANCE_HZ, DEFAULT_DAMPING_TOLERANCE, DEFAULT_MAX_MODE_DISTANCE

__all__ = [
    "MAX_COMPARE_SAMPLES",
    "MAX_COMPARE_SAMPLES_TOTAL",
    "MAX_COMPARE_SERIES",
    "MAX_COMPARE_TABLE_ROWS",
    "CompareRequest",
    "CompareResponse",
    "EigenvaluePairOut",
    "NotComparableOut",
    "PflowComparisonOut",
    "SeriesDifferenceOut",
    "TableRowDifferenceOut",
    "Tolerances",
    "UnmatchedKeysOut",
]

# Bounds on one request. A results document records what a study asked for, so
# the series cap is longer than the metrics route's 64 hand-picked signals.
MAX_COMPARE_SERIES = 512


MAX_COMPARE_SAMPLES = 200_000


# Two documents of 1_000_000 samples each.
MAX_COMPARE_SAMPLES_TOTAL = 2_000_000


# Buses, branches and modes of the largest case TENSA opens.
MAX_COMPARE_TABLE_ROWS = 20_000


class Tolerances(BaseModel):
    """The tolerances a row is read against. A quantity absent from
    ``quantities`` takes the default of ``engines/compare.py``; one with no
    default is reported without a verdict."""

    model_config = ConfigDict(extra="forbid")

    quantities: dict[str, float] = Field(
        default_factory=dict,
        max_length=100,
        description=(
            "Absolute tolerance per quantity, in the quantity's unit; it replaces "
            "the default for that quantity."
        ),
    )
    frequency_hz: float = Field(
        default_factory=lambda: _engine_defaults()[0],
        gt=0.0,
        allow_inf_nan=False,
        description="Tolerance on the frequency of a matched mode, in hertz.",
    )
    damping_ratio: float = Field(
        default_factory=lambda: _engine_defaults()[1],
        gt=0.0,
        allow_inf_nan=False,
        description="Tolerance on the damping ratio of a matched mode.",
    )
    max_mode_distance: float = Field(
        default_factory=lambda: _engine_defaults()[2],
        gt=0.0,
        allow_inf_nan=False,
        description=(
            "The largest distance in the complex plane, in 1/s, at which two "
            "eigenvalues still count as one mode."
        ),
    )

    @field_validator("quantities")
    @classmethod
    def _quantities_are_positive_finite(
        cls, v: dict[str, float]
    ) -> dict[str, float]:
        for key, value in v.items():
            if not math.isfinite(value) or value <= 0.0:
                raise ValueError(f"tolerance for {key} must be a finite number greater than 0")
        return v


class CompareRequest(BaseModel):
    """Request body for ``POST /compare``."""

    model_config = ConfigDict(extra="forbid")

    reference: ResultsDocument = Field(
        ...,
        description=(
            "The reference results document: differences are comparison minus "
            "reference, and the swing is the reference series'."
        ),
    )
    comparison: ResultsDocument = Field(
        ..., description="The results document compared against the reference."
    )
    tolerances: Tolerances = Field(
        default_factory=lambda: Tolerances(),
        description="The tolerances; defaults are in ``engines/compare.py``.",
    )

    @model_validator(mode="after")
    def _within_total(self) -> CompareRequest:
        _resolve_document_models()
        for side, doc in (("reference", self.reference), ("comparison", self.comparison)):
            if len(doc.series) > MAX_COMPARE_SERIES:
                raise ValueError(
                    f"the {side} document holds more than {MAX_COMPARE_SERIES} series"
                )
            for i, s in enumerate(doc.series):
                if len(s.t) > MAX_COMPARE_SAMPLES or len(s.y) > MAX_COMPARE_SAMPLES:
                    raise ValueError(
                        f"the {side} document's series {i} holds more than "
                        f"{MAX_COMPARE_SAMPLES} samples"
                    )
        total = sum(len(s.t) for s in self.reference.series) + sum(
            len(s.t) for s in self.comparison.series
        )
        if total > MAX_COMPARE_SAMPLES_TOTAL:
            raise ValueError(
                f"the two documents hold more than {MAX_COMPARE_SAMPLES_TOTAL} samples in all"
            )
        return self


class TableRowDifferenceOut(BaseModel):
    """One power flow value compared."""

    quantity: str = Field(..., description="The quantity compared.")
    key: str = Field(..., description="The element key.")
    unit: str = Field(..., description="The unit of the values.")
    reference: float = Field(..., description="The reference value.")
    value: float = Field(..., description="The comparison value.")
    diff: float = Field(..., description="``value - reference``.")
    within_tolerance: bool | None = Field(
        ..., description="Whether ``|diff|`` is within the tolerance; ``null`` when there is none."
    )
    tolerance: float | None = Field(
        ..., description="The tolerance applied; ``null`` when the quantity has none."
    )


class SeriesDifferenceOut(BaseModel):
    """The difference of one pair of series."""

    quantity: str = Field(..., description="The quantity compared.")
    key: str = Field(..., description="The element key.")
    unit: str = Field(..., description="The unit of the values.")
    samples: int = Field(..., description="Instants compared, gaps left out.")
    t_start: float = Field(..., description="Start of the overlap used, in seconds.")
    t_end: float = Field(..., description="End of the overlap used, in seconds.")
    max_diff: float = Field(..., description="The largest absolute difference.")
    max_diff_t: float = Field(..., description="The time it occurs at, in seconds.")
    rms_diff: float = Field(
        ...,
        description=(
            "The time-weighted RMS difference: ``sqrt(integral(d^2 dt) / span)`` "
            "over the overlap, gaps left out."
        ),
    )
    swing_ref: float = Field(
        ..., description="The reference series' max minus min over the compared stretch."
    )
    within_tolerance: bool | None = Field(
        ..., description="Whether ``max_diff`` is within the tolerance; ``null`` when there is none."
    )
    tolerance: float | None = Field(
        ..., description="The tolerance applied; ``null`` when the quantity has none."
    )


class NotComparableOut(BaseModel):
    """A pair of series that cannot be compared, with the reason."""

    quantity: str = Field(..., description="The quantity.")
    key: str = Field(..., description="The element key.")
    reason: str = Field(..., description="Why the pair cannot be compared.")


class EigenvaluePairOut(BaseModel):
    """Two eigenvalues matched as one mode."""

    index_ref: int = Field(..., description="Its index in the reference table.")
    index_new: int = Field(..., description="Its index in the comparison table.")
    eigenvalue_ref_re: float = Field(..., description="Real part of the reference eigenvalue, 1/s.")
    eigenvalue_ref_im: float = Field(..., description="Imaginary part of the reference eigenvalue, 1/s.")
    eigenvalue_new_re: float = Field(..., description="Real part of the comparison eigenvalue, 1/s.")
    eigenvalue_new_im: float = Field(..., description="Imaginary part of the comparison eigenvalue, 1/s.")
    distance: float = Field(..., description="Distance in the complex plane, 1/s.")
    frequency_hz_ref: float = Field(..., description="Frequency of the reference mode, hertz.")
    frequency_hz_new: float = Field(..., description="Frequency of the comparison mode, hertz.")
    damping_ratio_ref: float = Field(..., description="Damping ratio of the reference mode.")
    damping_ratio_new: float = Field(..., description="Damping ratio of the comparison mode.")
    within_tolerance: bool = Field(
        ..., description="Whether frequency and damping are both within their tolerances."
    )


class UnmatchedKeysOut(BaseModel):
    """Keys present on one side only, sorted."""

    missing_in_comparison: list[str] = Field(
        ..., description="Keys the reference has and the comparison does not."
    )
    missing_in_reference: list[str] = Field(
        ..., description="Keys the comparison has and the reference does not."
    )


class PflowComparisonOut(BaseModel):
    """The power flow comparison, always shown first."""

    converged_reference: bool = Field(..., description="Whether the reference power flow converged.")
    converged_comparison: bool = Field(..., description="Whether the comparison power flow converged.")
    rows: list[TableRowDifferenceOut] = Field(..., description="One row per compared value.")
    unmatched: UnmatchedKeysOut = Field(
        ..., description="Keys present on one side only."
    )


class CompareResponse(BaseModel):
    """Response body for ``POST /compare``: power flow first, then series, then
    eigenvalues."""

    engine_reference: EngineBlock = Field(..., description="The reference document's engine block.")
    engine_comparison: EngineBlock = Field(..., description="The comparison document's engine block.")
    operating_point_differs: bool = Field(
        ...,
        description=(
            "True when the power flow comparison is outside its tolerance: a "
            "dynamic difference that starts from a different operating point "
            "must be read as that."
        ),
    )
    power_flow: PflowComparisonOut | None = Field(
        ..., description="The power flow comparison; ``null`` unless both documents carry one."
    )
    series: list[SeriesDifferenceOut] = Field(
        ..., description="One entry per compared pair of series."
    )
    not_comparable: list[NotComparableOut] = Field(
        ..., description="Pairs that cannot be compared, each with the reason."
    )
    unmatched_series_reference: list[str] = Field(
        ..., description="``quantity|key`` of series only the reference has."
    )
    unmatched_series_comparison: list[str] = Field(
        ..., description="``quantity|key`` of series only the comparison has."
    )
    eigenvalues: list[EigenvaluePairOut] = Field(
        ..., description="The matched modes, sorted by the reference frequency."
    )
    unmatched_eigenvalues_reference: list[int] = Field(
        ..., description="Indices of reference eigenvalues with no match."
    )
    unmatched_eigenvalues_comparison: list[int] = Field(
        ..., description="Indices of comparison eigenvalues with no match."
    )
    errors: list[str] = Field(
        ...,
        description=(
            "Per-series problems (times that run backwards, too few samples, no "
            "overlap); one bad series does not fail the request."
        ),
    )
