"""The neutral results document on the wire: ``POST /results/convert``.

The document models themselves live in ``tensa.engines.results_doc`` and are
re-exported here; this module adds only the request and the answer of the
conversion route.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from tensa.api.schemas.keys import KeyEntrySchema
from tensa.engines.results_doc import (
    EigenvalueRow,
    EigenvalueTable,
    EngineBlock,
    OptimizationDualTable,
    OptimizationExpressionTable,
    OptimizationParameterTable,
    OptimizationRow,
    OptimizationSlackRow,
    OptimizationTable,
    OptimizationVariableTable,
    PflowBranchRow,
    PflowBusRow,
    PflowGeneratorRow,
    PflowLoadRow,
    PflowTable,
    ResultsDocument,
    Series,
    SkippedSeries,
)

__all__ = [
    "ConvertResultRequest",
    "ConvertResultResponse",
    "EngineBlock",
    "EigenvalueRow",
    "EigenvalueTable",
    "OptimizationDualTable",
    "OptimizationExpressionTable",
    "OptimizationParameterTable",
    "OptimizationRow",
    "OptimizationSlackRow",
    "OptimizationTable",
    "OptimizationVariableTable",
    "PflowBranchRow",
    "PflowBusRow",
    "PflowGeneratorRow",
    "PflowLoadRow",
    "PflowTable",
    "ResultsDocument",
    "Series",
    "SkippedSeries",
]

# Bounds on one request, in the spirit of the metrics route's: far past what a
# real run sends, small enough that a body within them parses quickly.
MAX_CONVERT_SERIES = 512
MAX_CONVERT_SAMPLES_TOTAL = 2_000_000


class ConvertResultRequest(BaseModel):
    """Request body for ``POST /results/convert``: one engine result, answered
    as a neutral results document (section 6.5)."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["pflow", "tds", "eig", "dispatch"] = Field(
        ..., description="Which builder the result goes through."
    )
    engine: str = Field(..., description="The engine that produced the result (``andes``, ``sienna``).")
    versions: dict[str, str] = Field(
        default_factory=dict,
        description="The package versions the engine ran with; carried into the document as given.",
    )
    study: dict[str, Any] | None = Field(
        default=None, description="The study as run; stored in the document verbatim."
    )
    result: dict[str, Any] = Field(
        ...,
        description=(
            "The engine's own result as JSON: for ``pflow`` the fields of the "
            "power flow result, for ``tds`` a traces object (``t``, "
            "``variables``, ``truncated``), for ``eig`` the eigenvalue result."
        ),
    )
    keys: list[KeyEntrySchema] = Field(
        default_factory=list,
        description=(
            "The session's keys as ``GET /sessions/{id}/keys`` lists them (its "
            "``keys`` list: key, bucket, model, idx, source). Used to map ANDES "
            "time-domain column names, a machine's through its own entry "
            "(``gen:1-1/machine``); ignored for ``sienna`` and for ``pflow`` "
            "(whose result carries its own ``keys``)."
        ),
    )
    status: Literal["completed", "aborted", "failed"] = Field(
        default="completed", description="How the run ended; carried into the document."
    )


class ConvertResultResponse(BaseModel):
    """Answer of ``POST /results/convert``: the document, and what is not in it."""

    model_config = ConfigDict(extra="forbid")

    document: ResultsDocument = Field(..., description="The neutral results document.")
    skipped: list[SkippedSeries] = Field(
        default_factory=list,
        description="Every column of the result that is not part of the document, and why.",
    )
    notes: list[str] = Field(
        default_factory=list,
        description="What the answer does not say in the document, such as a truncated result.",
    )
