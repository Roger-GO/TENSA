"""The wire models of ``POST /studies``: one study on several engines."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from tensa.engines.ops import ENGINE_NAMES
from tensa.engines.results_doc import ResultsDocument
from tensa.engines.study_doc import StudyDocument

__all__ = [
    "EngineStudyOutcome",
    "StudyCaseRef",
    "StudyRequest",
    "StudyResponse",
    "StudyTolerances",
]


def _engine_defaults() -> tuple[float, float, float]:
    """The default tolerances of ``tensa.engines.compare``, imported lazily:
    that module names the document models of ``tensa.engines.results_doc``,
    whose import chain reaches the schemas package, so a module-level import
    here would be circular."""
    from tensa.engines.compare import (
        DEFAULT_DAMPING_TOLERANCE,
        DEFAULT_FREQ_TOLERANCE_HZ,
        DEFAULT_MAX_MODE_DISTANCE,
    )

    return DEFAULT_FREQ_TOLERANCE_HZ, DEFAULT_DAMPING_TOLERANCE, DEFAULT_MAX_MODE_DISTANCE


class StudyCaseRef(BaseModel):
    """The case every engine's session is created from: the primary file and
    its addfiles, as ``POST /sessions/{id}/case`` takes them."""

    model_config = ConfigDict(extra="forbid")

    primary_path: str = Field(..., description="The case file, relative to the workspace.")
    addfiles: list[str] = Field(
        default_factory=list, description="Further files (a .dyr beside a .raw)."
    )


class StudyTolerances(BaseModel):
    """Tolerances of the comparison, with the defaults of
    ``tensa.engines.compare``; section 10: "Tolerances are part of the
    request, with defaults"."""

    model_config = ConfigDict(extra="forbid")

    quantities: dict[str, float] = Field(
        default_factory=dict,
        description="Absolute tolerance per quantity, in the quantity's unit.",
    )
    frequency_hz: float = Field(
        default_factory=lambda: _engine_defaults()[0],
        gt=0.0,
        description="Tolerance on the frequency of a matched mode, in hertz.",
    )
    damping_ratio: float = Field(
        default_factory=lambda: _engine_defaults()[1],
        gt=0.0,
        description="Tolerance on the damping ratio of a matched mode.",
    )
    max_mode_distance: float = Field(
        default_factory=lambda: _engine_defaults()[2],
        gt=0.0,
        description="The largest distance in 1/s at which two eigenvalues count as one mode.",
    )


class StudyRequest(BaseModel):
    """The body of ``POST /studies``."""

    model_config = ConfigDict(extra="forbid")

    case: StudyCaseRef = Field(..., description="The case every engine's session is created from.")
    engines: list[str] = Field(
        ...,
        min_length=1,
        max_length=len(ENGINE_NAMES),
        description="The engines to run the study on, in the order to run them.",
    )
    study: StudyDocument = Field(..., description="The study document.")
    tolerances: StudyTolerances = Field(
        default_factory=StudyTolerances,
        description="The tolerances of the comparison; defaults are in ``engines/compare.py``.",
    )

    @model_validator(mode="after")
    def _check_engines(self) -> StudyRequest:
        for name in self.engines:
            if name not in ENGINE_NAMES:
                raise ValueError(
                    f"unknown engine {name!r}; the engines are {list(ENGINE_NAMES)}"
                )
        if len(set(self.engines)) != len(self.engines):
            raise ValueError("an engine is named twice")
        return self


class EngineStudyOutcome(BaseModel):
    """What one engine did with the study: its results document, or the
    problem document of its refusal."""

    model_config = ConfigDict(extra="forbid")

    engine: str = Field(..., description="The engine's registry name.")
    ran: bool = Field(..., description="Whether the engine ran the study.")
    document: ResultsDocument | None = Field(
        default=None, description="The results document; null when refused."
    )
    problem: dict[str, Any] | None = Field(
        default=None,
        description="The problem document of the refusal (status 409, category engine_unsupported); null when run.",
    )
    raw: dict[str, Any] | None = Field(
        default=None,
        description="The engine's own answer for a routine the results document has no table for yet (matrices, dispatch).",
    )


class StudyResponse(BaseModel):
    """The answer of ``POST /studies``."""

    model_config = ConfigDict(extra="forbid")

    outcomes: list[EngineStudyOutcome] = Field(
        ..., description="One per requested engine, in the request's order."
    )
    comparisons: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "One entry per engine after the first that ran: its document "
            "compared against the first engine that ran, as ``POST /compare`` "
            "answers, with an added ``engine`` field naming the comparison side."
        ),
    )
