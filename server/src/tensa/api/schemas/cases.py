"""Load, save and blank a case, and the parameters of a model that a disturbance may alter."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from tensa.api.schemas.topology import TopologySummary


class LoadCaseRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/case``. All paths are
    workspace-relative; the substrate canonicalizes them with O_NOFOLLOW
    before passing to ANDES."""

    model_config = ConfigDict(extra="forbid")

    primary_path: str = Field(
        ...,
        description=(
            "Workspace-relative path to the primary case file. Supported "
            "formats: xlsx, raw, dyr, json, m. The substrate routes through "
            "ANDES's native readers; format is detected from the extension."
        ),
        min_length=1,
    )
    addfiles: list[str] | None = Field(
        None,
        description=(
            "Optional list of workspace-relative addfile paths. PSS/E .raw "
            "(steady-state) and .dyr (dynamics) are paired via this "
            "mechanism; pass [.dyr path] when loading a .raw."
        ),
    )


class BlankSystemResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/blank`` (201).

    Returns the empty topology so the client immediately switches to the
    blank-system rendering path (centered ``Add your first bus`` prompt).
    """

    topology: TopologySummary = Field(
        ...,
        description=(
            "Empty topology snapshot for the freshly-created blank System. "
            "All buckets are empty; ``state`` is ``pre-setup``."
        ),
    )


class SaveCaseRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/save``.

    ``filename`` is workspace-relative; the substrate canonicalizes it
    through the workspace path validator (rejects traversal). ``format``
    selects the writer: ANDES's own for xlsx and json, and the substrate's
    PSS/E v33 writer for raw (ANDES 2.0 has none).
    """

    model_config = ConfigDict(extra="forbid")

    filename: str = Field(
        ...,
        description=(
            "Workspace-relative output filename. Extension must match "
            "``format`` (``.xlsx`` for xlsx, ``.json`` for json, "
            "``.raw`` for raw). The file name must be portable to "
            "Windows: no ``:``, trailing dot or space, or device names "
            "such as ``CON`` or ``nul.xlsx``."
        ),
        min_length=1,
    )
    format: Literal["xlsx", "json", "raw"] = Field(
        ...,
        description=(
            "Output format. ``xlsx`` is the ANDES-native Excel layout. "
            "``json`` is the ANDES JSON serialization. ``raw`` is "
            "PSS/E v33 emitted by the substrate's hand-rolled writer; "
            "it covers the power-flow data: Bus, PQ loads, Shunt, PV "
            "and Slack generators, Line, and 2W transformers. 3W "
            "transformers and other PSS/E sections are emitted as "
            "empty terminators. A ``.raw`` holds no dynamic data, so "
            "the dynamic models of the case (machines, exciters, a "
            "ZIP load) are left out: save as ``xlsx`` or ``json`` to "
            "keep them."
        ),
    )
    overwrite: bool = Field(
        False,
        description=(
            "When ``true``, overwrites an existing file at the same "
            "path. Default ``false`` returns 409 if the file exists."
        ),
    )


class SaveCaseResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/save`` (201)."""

    filename: str = Field(
        ..., description="Workspace-relative path of the file just written."
    )
    bytes_written: int = Field(
        ...,
        description="Size in bytes of the file just written, as reported by ``os.stat``.",
        ge=0,
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the case-save routine (kind "
            "``case-save``). ``null`` on legacy responses."
        ),
    )


class AlterableParamsResponse(BaseModel):
    """Response body for ``GET /sessions/{id}/topology/models/{model}/alterable_params``.

    Returns the ordered list of parameter names that ANDES will accept as
    ``src`` for the ``Alter`` disturbance on the given model. The UI uses
    this to populate the AlterSpec form's parameter dropdown.

    The introspection rule (mirrors ANDES's own ``alter()`` contract):
    a parameter is alterable iff it is a ``NumParam`` and not an
    ``ExtParam`` (which is a derived/external param read off another
    model). This excludes topology refs (``IdxParam``: ``bus``, ``bus1``,
    ``bus2``, ``area``, ``zone``, ``owner``, ``coi``, etc.) and string
    identifiers (``DataParam``: ``idx``, ``name``).
    """

    model_config = ConfigDict(extra="forbid")

    model: str = Field(
        ...,
        description=(
            "ANDES model class name the params belong to (echoed back from "
            "the path). Example: ``Bus``, ``PQ``, ``GENROU``."
        ),
    )
    params: list[str] = Field(
        ...,
        description=(
            "Ordered list of parameter names that ``ss.<model>.alter(src=...)`` "
            "will accept. Order matches ANDES's internal declaration order on "
            "the model class. Empty when the model has no alterable params."
        ),
    )
