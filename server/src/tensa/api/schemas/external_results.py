"""External results import: ``POST /external-results``."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ExternalSeries(BaseModel):
    """One signal of an imported export, in the wire shape of ``MetricsSeries``."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        ...,
        description=(
            "What the series is called. The export format carries no signal "
            "names ANDES reads, so the import names them by position: "
            "``column 1``, ``column 2``, ... in the order the tool wrote them."
        ),
    )
    t: list[float] = Field(
        ...,
        description=(
            "Sample times in seconds, in the order the export gives them (not "
            "sorted); a row whose time is not a finite number is left out."
        ),
    )
    y: list[float | None] = Field(
        ...,
        description=(
            "The signal's value at each time. A value the export did not carry "
            "as a finite number (text, a date, an empty cell, an Excel error) is "
            "``null``."
        ),
    )


class ExternalResultsResponse(BaseModel):
    """Response body for ``POST /external-results``."""

    source: Literal["tsat", "psse"] = Field(
        ..., description="The format the file was read as."
    )
    series: list[ExternalSeries] = Field(
        ...,
        description=(
            "One series per signal column of the export, in the order the tool "
            "wrote them, all on the same ``t``. Feed them to "
            "``POST /response-metrics`` as they are (at most 64 series a "
            "request), or plot them against a run's ``traces``."
        ),
    )
    samples: int = Field(
        ..., description="The length of every series' ``t`` and ``y``."
    )
