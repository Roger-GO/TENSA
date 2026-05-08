"""Pydantic v2 request / response models for the HTTP API.

Every field has an explicit ``description`` (R25 acceptance: the
OpenAPI-to-MCP audit asserts no field has an empty description). Every error
response is shaped as ``ProblemDetails`` per RFC 7807.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from andes_app.core.wrapper import ParamValue

# ---- error envelope ---------------------------------------------------------


class ProblemDetails(BaseModel):
    """RFC 7807 problem-details object. Used for all 4xx and 5xx responses."""

    model_config = ConfigDict(extra="allow")

    type: str = Field(
        "about:blank",
        description=(
            "URI reference identifying the problem type. ``about:blank`` "
            "means the title is the canonical reason for the status code."
        ),
    )
    title: str = Field(..., description="Short, human-readable summary of the problem.")
    status: int = Field(..., description="HTTP status code for this response.")
    detail: str | None = Field(
        None,
        description=(
            "Human-readable explanation specific to this occurrence of the "
            "problem (e.g., 'session id is required to be server-generated; "
            "remove the session_id field from your request body')."
        ),
    )
    instance: str | None = Field(
        None,
        description="URI reference that identifies the specific occurrence of the problem.",
    )


# ---- session resources ------------------------------------------------------


class CreateSessionRequest(BaseModel):
    """Request body for ``POST /sessions``. Empty by design — the
    ``session_id`` is server-generated; client-supplied values are rejected."""

    model_config = ConfigDict(extra="forbid")


class SessionDescriptor(BaseModel):
    """Response shape for session create / read."""

    session_id: str = Field(
        ...,
        description=(
            "Server-generated UUID-shaped opaque identifier for the session. "
            "Use it in subsequent URL paths (e.g., ``/sessions/{session_id}/case``)."
        ),
    )
    state: Literal["live", "closed"] = Field(
        ...,
        description=(
            "``live`` if the worker subprocess is alive and accepting commands; "
            "``closed`` if the session has been reaped or explicitly closed."
        ),
    )


class SessionList(BaseModel):
    """Response shape for ``GET /sessions``."""

    sessions: list[SessionDescriptor] = Field(
        ..., description="Snapshot of currently-active sessions for this token."
    )


# ---- case + topology --------------------------------------------------------


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


class TopologyEntry(BaseModel):
    """One element in a topology summary."""

    idx: int | str = Field(
        ...,
        description=(
            "ANDES idx of the element (its public identifier in ANDES). "
            "Used as the stable handle in subsequent operations (e.g., "
            "Fault.bus references this idx)."
        ),
    )
    name: str = Field(..., description="Human-readable name of the element.")
    kind: str = Field(
        ...,
        description=(
            "ANDES model class name (e.g., ``Bus``, ``Line``, ``GENROU``, "
            "``PV``, ``Slack``, ``PQ``)."
        ),
    )
    params: dict[str, ParamValue] = Field(
        default_factory=dict,
        description=(
            "Flat dict of model-input parameters for this element (e.g., for "
            "a Bus: ``Vn`` rated voltage in kV, ``vmax``/``vmin`` voltage "
            "limits, ``area``, ``zone``; for a Line: ``r``, ``x``, ``b``, "
            "``g``, ``tap``, ``phi``; for a generator: ``Sn`` rated MVA, "
            "``Vn``, ``bus``, plus model-specific params). The Inspector "
            "Properties tab in the v0.1 UI consumes this dict; absent params "
            "(None or unavailable on a given model) are omitted."
        ),
    )


class TopologySummary(BaseModel):
    """Substrate's structural view of the loaded case.

    ``state`` reflects whether ``ss.setup()`` has been committed. Some
    fields on individual elements are only populated after setup.
    """

    state: Literal["pre-setup", "committed"] = Field(
        ...,
        description=(
            "``pre-setup`` if disturbances can still be added; ``committed`` "
            "after PF or TDS has triggered ``ss.setup()``. Once committed, "
            "callers must POST /sessions/{id}/reload to add more disturbances."
        ),
    )
    buses: list[TopologyEntry] = Field(..., description="Bus elements.")
    lines: list[TopologyEntry] = Field(..., description="Line elements.")
    transformers: list[TopologyEntry] = Field(
        ...,
        description=(
            "Transformer elements split out from the ANDES ``Line`` bucket "
            "via the ``tap != 1.0 OR phi != 0.0`` heuristic. Pure "
            "transmission lines remain in ``lines``; off-nominal-tap and "
            "phase-shifting branches move here."
        ),
    )
    generators: list[TopologyEntry] = Field(
        ...,
        description="Generator elements (PV, Slack, GENROU, GENCLS, etc.).",
    )
    loads: list[TopologyEntry] = Field(
        ...,
        description="Load elements — both static (PQ) and dynamic (ZIP).",
    )
    shunts: list[TopologyEntry] = Field(
        default_factory=list,
        description=(
            "Shunt elements (capacitors and reactors). Modeled as ANDES "
            "``Shunt`` devices; rendered with the IEC 60617 shunt-cap or "
            "shunt-reactor icon depending on the sign of ``b``."
        ),
    )


# ---- power flow -------------------------------------------------------------


class LineFlow(BaseModel):
    """Per-line active and reactive power flow, measured at terminal 1
    (``bus1``) flowing into the line toward terminal 2 (``bus2``).

    Sign convention: positive ``p`` means real power flowing FROM ``bus1``
    INTO the line; positive ``q`` means reactive power flowing FROM ``bus1``
    INTO the line. The v0.1 SLD overlay uses the sign of ``p`` to render
    directional arrows along each branch.
    """

    p: float = Field(
        ...,
        description=(
            "Active power leaving ``bus1`` into the line, in MW (i.e., "
            "computed in pu and multiplied by the system base MVA)."
        ),
    )
    q: float = Field(
        ...,
        description=(
            "Reactive power leaving ``bus1`` into the line, in MVAr."
        ),
    )
    from_idx: int | str = Field(
        ...,
        description="ANDES idx of the ``bus1`` terminal (the from-side bus).",
    )
    to_idx: int | str = Field(
        ...,
        description="ANDES idx of the ``bus2`` terminal (the to-side bus).",
    )


class GeneratorOutput(BaseModel):
    """Per-generator PF output. Active + reactive injection at the
    generator's terminal bus, plus the terminal voltage (pu).
    """

    p: float = Field(
        ..., description="Active power generated at the terminal bus, in MW."
    )
    q: float = Field(
        ..., description="Reactive power generated at the terminal bus, in MVAr."
    )
    v: float = Field(
        ..., description="Terminal bus voltage magnitude (pu)."
    )
    bus: int | str = Field(..., description="Terminal bus idx.")


class LoadConsumption(BaseModel):
    """Per-load PF consumption at the converged voltage."""

    p: float = Field(..., description="Active power drawn, in MW.")
    q: float = Field(..., description="Reactive power drawn, in MVAr.")
    bus: int | str = Field(..., description="Terminal bus idx.")


class PflowResult(BaseModel):
    """Power-flow run result. Bus voltages and angles are keyed by ANDES idx."""

    run_id: str = Field(
        ...,
        description=(
            "Server-generated identifier for this PF run. Use it with "
            "GET /sessions/{id}/pflow/{run_id} to fetch the result later."
        ),
    )
    converged: bool = Field(
        ...,
        description=(
            "``true`` if PF converged within the iteration limit. Non-"
            "convergence is NOT a server error; it is a valid power-system "
            "outcome the caller must handle."
        ),
    )
    iterations: int = Field(
        ..., description="Number of Newton-Raphson iterations executed."
    )
    mismatch: float = Field(
        ...,
        description=(
            "Final mismatch (max element of the residual vector) at the "
            "converged solution. For non-converged runs this is the last "
            "iteration's mismatch."
        ),
    )
    bus_voltages: dict[str, float] = Field(
        ...,
        description=(
            "Bus voltage magnitudes (pu) keyed by ANDES idx (stringified). "
            "JSON object keys must be strings; the ANDES idx is "
            "converted at the boundary."
        ),
    )
    bus_angles: dict[str, float] = Field(
        ...,
        description="Bus voltage angles (radians) keyed by ANDES idx (stringified).",
    )
    line_flows: dict[str, LineFlow] = Field(
        default_factory=dict,
        description=(
            "Per-line P/Q flow at terminal 1, keyed by line idx (stringified). "
            "Empty if the wrapper could not extract line flows from the post-"
            "PF System (e.g., on an unexpected ANDES API change). "
            "Populated by computing the standard pi-equivalent line "
            "injection at ``bus1`` from the converged ``v1``/``a1``/``v2``/"
            "``a2`` algebraic variables and the line's series + shunt "
            "admittances."
        ),
    )
    generator_outputs: dict[str, GeneratorOutput] = Field(
        default_factory=dict,
        description=(
            "Per-generator P / Q output and terminal voltage, keyed by "
            "generator idx (stringified). Covers PV, Slack, GENROU, and "
            "GENCLS. Empty when PF did not converge."
        ),
    )
    load_consumption: dict[str, LoadConsumption] = Field(
        default_factory=dict,
        description=(
            "Per-load P / Q consumption at the converged voltage, keyed "
            "by load idx (stringified). Covers PQ and ZIP. Empty when PF "
            "did not converge."
        ),
    )


class PflowRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/pflow``. Empty for v0.1; PF
    parameters are taken from the loaded case's defaults."""

    model_config = ConfigDict(extra="forbid")


# ---- disturbances -----------------------------------------------------------


# Re-export the wrapper-level discriminated-union types for use in API
# schemas. They are Pydantic v2 models already, so they slot into FastAPI
# request bodies directly.
from andes_app.core.disturbance import (  # noqa: E402
    AlterSpec,
    FaultSpec,
    ToggleSpec,
)


class AddDisturbancesRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/disturbances``.

    Accepts a list so a caller can register multiple disturbances in one
    request — useful for the v0.2 timeline editor that wants to commit a
    full study scenario at once. ANDES rejects all post-setup ``add()`` calls,
    so this endpoint is gated on pre-setup state (returns 409 otherwise with
    a hint to call ``/reload``).
    """

    model_config = ConfigDict(extra="forbid")

    disturbances: list[FaultSpec | ToggleSpec | AlterSpec] = Field(
        ...,
        description=(
            "List of disturbance specifications. Discriminated by the "
            "``kind`` field (``fault``, ``toggle``, ``alter``)."
        ),
        min_length=1,
    )


class DisturbanceAck(BaseModel):
    """One entry in the response to ``POST /sessions/{id}/disturbances``."""

    kind: Literal["fault", "toggle", "alter"] = Field(
        ..., description="Discriminator from the original spec."
    )
    idx: int | str = Field(
        ...,
        description=(
            "ANDES idx assigned to the created disturbance device. Use this "
            "to reference the disturbance in subsequent operations."
        ),
    )


class AddDisturbancesResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/disturbances``."""

    accepted: list[DisturbanceAck] = Field(
        ..., description="One ack entry per accepted disturbance, in input order."
    )


# ---- topology mutations (Unit 2) -------------------------------------------


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
            "ANDES model class name. Supported in v0.1.x: ``Bus``, ``Line``, "
            "``PV``, ``Slack``, ``GENROU``, ``GENCLS``, ``PQ``, ``ZIP``, "
            "``Shunt``. Unknown models are rejected with 422."
        ),
        min_length=1,
    )
    params: dict[str, ParamValue] = Field(
        ...,
        description=(
            "Flat dict of model parameters. Keys are validated against the "
            "per-model whitelist; values pass through to ``ss.add()``. "
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


class TopologyParamMeta(BaseModel):
    """One parameter row in a model's add/edit form schema."""

    name: str = Field(..., description="ANDES parameter name (e.g., ``Vn``).")
    kind: Literal["string", "number", "bus_idx", "bool"] = Field(
        ...,
        description=(
            "Form-input kind. ``string`` and ``number`` map to text/number "
            "inputs; ``bus_idx`` renders as a dropdown of existing buses; "
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


class SaveCaseRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/save``.

    ``filename`` is workspace-relative; the substrate canonicalizes it
    through the workspace path validator (rejects traversal). ``format``
    decides which writer ANDES uses — only xlsx and json are supported
    in v0.1.x because ANDES 2.0 has no PSS/E ``.raw`` writer.
    """

    model_config = ConfigDict(extra="forbid")

    filename: str = Field(
        ...,
        description=(
            "Workspace-relative output filename. Extension must match "
            "``format`` (``.xlsx`` for xlsx, ``.json`` for json)."
        ),
        min_length=1,
    )
    format: Literal["xlsx", "json"] = Field(
        ...,
        description=(
            "Output format. ``xlsx`` is the ANDES-native Excel layout "
            "(round-trips through ``andes.io.xlsx.write``). ``json`` is "
            "the ANDES JSON serialization (cleanest round-trip but "
            "less familiar to power-systems tooling). PSS/E ``raw`` "
            "WRITE is NOT supported by the ANDES library."
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


class TopologySchema(BaseModel):
    """Per-model parameter metadata, used by the web client's polymorphic
    form generator (Unit 6).

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


# ---- TDS --------------------------------------------------------------------


class TdsRunRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/tds`` (batch mode).

    Streaming mode lands in Unit 6 and uses a separate ``?stream=ws`` query
    parameter; this schema is the batch-only surface for v0.1.
    """

    model_config = ConfigDict(extra="forbid")

    tf: float = Field(
        ...,
        description="Final simulation time, in seconds. Must be > 0.",
        gt=0.0,
    )
    h: float | None = Field(
        None,
        description=(
            "Initial integration step size, in seconds. ``None`` lets ANDES "
            "use its case-default step size (typically 1/120 s)."
        ),
        gt=0.0,
    )


class TdsBatchResult(BaseModel):
    """Result of a batch TDS run (post-completion delivery).

    Streaming TDS uses a different code path (Unit 6) that emits Arrow IPC
    frames per integration step. Batch mode blocks until completion and
    returns a summary; the per-step state values are NOT returned in batch
    mode (use streaming mode if you need them).
    """

    run_id: str = Field(
        ..., description="Server-generated identifier for this TDS run."
    )
    converged: bool = Field(
        ...,
        description=(
            "``true`` if TDS completed without becoming ``busted``. "
            "Numerical instability (e.g., a fault that doesn't clear) "
            "surfaces as ``converged: false`` with ``final_t`` < ``tf``."
        ),
    )
    final_t: float = Field(
        ..., description="Last simulation time reached, in seconds."
    )
    callpert_count: int = Field(
        ...,
        description=(
            "Number of times the per-step ``TDS.callpert`` hook fired during "
            "the run. Useful as a sanity check that streaming is wired."
        ),
    )


# ---- workspace lister + layout sidecar -------------------------------------


class WorkspaceFile(BaseModel):
    """One entry in the workspace file lister response."""

    name: str = Field(
        ...,
        description=(
            "File name relative to the workspace root (no directory "
            "components in v0.1; the lister does not recurse)."
        ),
    )
    size_bytes: int = Field(
        ...,
        description="File size in bytes as reported by ``os.stat``.",
        ge=0,
    )
    modified_iso: str = Field(
        ...,
        description=(
            "Last-modified time in ISO 8601 format with timezone (UTC). "
            "Computed from ``stat.st_mtime`` at list time."
        ),
    )
    format: Literal["xlsx", "raw", "dyr", "json", "m"] = Field(
        ...,
        description=(
            "Detected file format from the extension. Matches one of the "
            "ANDES-supported formats; non-matching files are excluded by the "
            "lister."
        ),
    )


class WorkspaceFileList(BaseModel):
    """Response shape for ``GET /workspace/files``."""

    files: list[WorkspaceFile] = Field(
        ...,
        description=(
            "Workspace files matching the supported extensions, sorted "
            "alphabetically by ``name``. Hidden files (dotfiles) and "
            "symlinks are excluded; subdirectories are not recursed in v0.1."
        ),
    )


class BusCoord(BaseModel):
    """One bus's 2D coordinate in the layout sidecar.

    Coordinates are in arbitrary canvas units; the UI rescales them at render
    time. Infinity / NaN are rejected at validation time.
    """

    model_config = ConfigDict(extra="forbid")

    x: float = Field(..., description="Bus X coordinate, finite (no NaN/Inf).")
    y: float = Field(..., description="Bus Y coordinate, finite (no NaN/Inf).")

    @field_validator("x", "y")
    @classmethod
    def _finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("coordinate must be finite (no NaN/Inf)")
        return value


class SidecarLayout(BaseModel):
    """Persisted SLD layout sidecar (one file per case).

    Stored on disk as ``<case_path>.layout.json`` adjacent to the case file.
    The PUT endpoint validates this body, then writes atomically with mode
    0600.
    """

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(
        ...,
        description=(
            "Sidecar schema version (e.g., ``\"1.0\"``). Bumped on any "
            "incompatible shape change so the UI can fall back to defaults."
        ),
        min_length=1,
    )
    andes_version: str = Field(
        ...,
        description=(
            "ANDES version the layout was saved against (e.g., ``\"2.0.0\"``). "
            "Recorded for diagnosis; not validated on read."
        ),
        min_length=1,
    )
    coordinates: dict[str, BusCoord] = Field(
        ...,
        description=(
            "Per-bus coordinates, keyed by bus idx (stringified). Buses "
            "missing from this dict fall back to the renderer's auto-layout."
        ),
    )
    last_modified: str = Field(
        ...,
        description=(
            "ISO 8601 timestamp recorded by the client at save time. The "
            "server does NOT regenerate this on write; it stores the value "
            "the client sent so collaborative-edit conflict detection (a "
            "future feature) has a single source of truth."
        ),
        min_length=1,
    )
