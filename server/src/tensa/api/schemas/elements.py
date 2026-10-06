"""Add, edit and delete an element of the case, and the form the element builder draws."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from tensa.api.schemas.topology import TopologyEntry, TopologySummary
from tensa.core.wrapper import ParamValue


class AddElementRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/elements``.

    Adds a single topology element (Bus, Line, generator, load, shunt) to a
    pre-setup System. The wrapper validates the model name + param keys
    against an internal whitelist BEFORE invoking ANDES; unknown keys
    surface as 422 ``ProblemDetails`` listing both the rejected and the
    allowed sets.
    """

    model_config = ConfigDict(extra="forbid")

    model: str = Field(
        ...,
        description=(
            "ANDES model class name. It must be one of the buildable models "
            "listed by ``GET /api/topology/schema`` (buses, lines, "
            "generators, loads, shunts, exciters, governors, the ``ESD1`` "
            "battery, and other controllers). Unknown models are rejected "
            "with 422."
        ),
        min_length=1,
    )
    params: dict[str, ParamValue] = Field(
        ...,
        description=(
            "Flat dict of model parameters. Keys are validated against the "
            "per-model whitelist; values pass through to ``ss.add()``. "
            "A reference to another device (``bus``, ``gen``, ``syn``) may be "
            "sent as text or as a number: it is matched to the idx the case "
            "holds. "
            "A request that leaves out a parameter ANDES has no default for "
            "is rejected with 422 and adds nothing. "
            "Required keys vary per model — query "
            "``GET /api/topology/schema`` for the live form metadata."
        ),
    )


class EditElementRequest(BaseModel):
    """Request body for ``PUT /sessions/{id}/elements/{model}/{idx}``.

    Updates one or more parameters on an existing element. The same
    pre-setup gate + whitelist as ``AddElementRequest`` apply. ``idx`` and
    ``name`` cannot be edited (they would desync ANDES's internal indexes);
    create a new element if you need to reassign topology references.
    """

    model_config = ConfigDict(extra="forbid")

    params: dict[str, ParamValue] = Field(
        ...,
        description=(
            "Subset of model parameters to overwrite. Each key must be in "
            "the per-model whitelist; ``idx`` / ``name`` are explicitly "
            "rejected (create a new element instead)."
        ),
    )


class ElementCreated(BaseModel):
    """Response body for ``POST /sessions/{id}/elements`` (201).

    Carries the newly-built ``TopologyEntry`` so the client can update its
    cache without re-fetching the full topology. Web-side mutation hooks
    use this to optimistically update bus dropdowns before the topology
    re-fetch resolves.
    """

    element: TopologyEntry = Field(
        ...,
        description=(
            "The element that was just added, with its assigned idx + the "
            "parameters as ANDES read them back."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the element-add routine (kind "
            "``element-add``). ``null`` on legacy responses."
        ),
    )


class TopologyParamMeta(BaseModel):
    """One parameter row in a model's add/edit form schema."""

    name: str = Field(..., description="ANDES parameter name (e.g., ``Vn``).")
    kind: Literal["string", "number", "bus_idx", "gen_idx", "syn_idx", "bool"] = Field(
        ...,
        description=(
            "Form-input kind. ``string`` and ``number`` map to text/number "
            "inputs; ``bus_idx`` renders as a dropdown of existing buses; "
            "``gen_idx`` a dropdown of existing static generators; "
            "``syn_idx`` a dropdown of existing synchronous machines "
            "(GENROU/GENCLS) for an exciter/governor's machine link; "
            "``bool`` is a checkbox."
        ),
    )
    required: bool = Field(
        False,
        description=(
            "Whether the field is required when adding a new element. "
            "Optional fields collapse under the form's ``Show advanced`` "
            "disclosure."
        ),
    )
    unit: str | None = Field(
        None,
        description=(
            "Display unit suffix (``kV``, ``pu``, ``MVA``, ``MWs/MVA``, "
            "``rad``). Rendered inline next to numerical inputs."
        ),
    )


class DeletedDisturbance(BaseModel):
    """A disturbance that acts on an element a delete removes, or would remove."""

    source: Literal["case", "restored", "committed"] = Field(
        ...,
        description=(
            "``case``: a ``Fault``, ``Toggle`` or ``Alter`` device the case's "
            "files define. ``restored``: one a bundle import or a snapshot "
            "restore replayed. ``committed``: one a client committed through "
            "``POST /sessions/{id}/disturbances``."
        ),
    )
    kind: Literal["fault", "toggle", "alter"] = Field(
        ..., description="Which ANDES event model it is."
    )
    model: str | None = Field(
        default=None,
        description="ANDES model of the device it acts on: ``Bus`` for a fault.",
    )
    dev_idx: int | str | None = Field(
        default=None, description="Idx of the device it acts on."
    )
    t: float | None = Field(
        default=None,
        description=(
            "Time it starts, in seconds: a fault's ``tf``. ``null`` for a "
            "device of the case that never fires (switched off, or a time "
            "below zero); it names the element all the same, so it goes too."
        ),
    )
    name: str | None = Field(
        default=None,
        description="The device's name in the case file, for a ``case`` one.",
    )


class DeleteBlockedResponse(BaseModel):
    """Response body for ``DELETE /sessions/{id}/elements/{model}/{idx}``
    when the element cannot be deleted alone (HTTP 422): other elements
    depend on it, or disturbances act on it or on one of those.

    Sending the delete again with ``cascade=true`` deletes them all with it.
    Each list is capped at 25 entries; ``total`` and ``disturbances_total``
    report the full counts so the UI can render a "Showing 25 of N" footer
    when truncated.
    """

    model_config = ConfigDict(extra="forbid")

    dependents: list[TopologyEntry] = Field(
        ...,
        description=(
            "Up to 25 of the elements that cannot stay without the target: "
            "the ones that name it (the lines and generators on a bus, the "
            "machine on a static generator), the ones that name those, and "
            "so on. The nearest come first. Empty when only disturbances "
            "stand in the way."
        ),
        max_length=25,
    )
    total: int = Field(
        ...,
        description=(
            "Full count of dependent elements. Equals "
            "``len(dependents)`` when ``total <= 25``; greater when "
            "the list was truncated."
        ),
        ge=0,
    )
    disturbances: list[DeletedDisturbance] = Field(
        default_factory=list,
        description=(
            "Up to 25 of the disturbances that act on the target or on one "
            "of its dependents, and would be removed with them."
        ),
        max_length=25,
    )
    disturbances_total: int = Field(
        default=0,
        description="Full count of those disturbances.",
        ge=0,
    )
    detail: str | None = Field(
        default=None,
        description="The refusal in one sentence, with the way out.",
    )


class DeleteElementResponse(TopologySummary):
    """Response body for ``DELETE /sessions/{id}/elements/{model}/{idx}``: the
    topology after the delete, with what the delete removed."""

    deleted: list[TopologyEntry] = Field(
        default_factory=list,
        description=(
            "Every element the delete removed, as it was: the dependents a "
            "``cascade`` took, then the element asked for, last."
        ),
    )
    disturbances: list[DeletedDisturbance] = Field(
        default_factory=list,
        description=(
            "Every disturbance the delete removed because it acted on one of "
            "``deleted``. A client that keeps its own list of disturbances "
            "to commit should drop the matching ones too."
        ),
    )


class TopologySchema(BaseModel):
    """Per-model parameter metadata, used by the web client's polymorphic
    form generator.

    Returned from ``GET /api/topology/schema``. Mirrors the wrapper-side
    ``_PARAMS_BY_MODEL`` table — adding a new model on the server
    automatically expands the form picker.
    """

    models: dict[str, list[TopologyParamMeta]] = Field(
        ...,
        description=(
            "Mapping from ANDES model class name to ordered parameter "
            "metadata. Order is the rendering order in the form."
        ),
    )
