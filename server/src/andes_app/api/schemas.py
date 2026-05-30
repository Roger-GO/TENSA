"""Pydantic v2 request / response models for the HTTP API.

Every field has an explicit ``description`` (R25 acceptance: the
OpenAPI-to-MCP audit asserts no field has an empty description). Every error
response is shaped as ``ProblemDetails`` per RFC 7807.
"""

from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from andes_app.core.jobs import JobKind as JobKindLiteral
from andes_app.core.jobs import JobStatus as JobStatusLiteral
from andes_app.core.wrapper import ParamValue

# ---- error envelope ---------------------------------------------------------


# Canonical recovery-action discriminator. Each ``AndesAppError`` subclass
# declares a matching plain-``str`` ``recovery_kind`` attribute in
# ``core/errors.py`` / ``core/session.py`` (a plain ``str`` there, NOT this
# Literal — importing it into ``core/`` would create a core->api import
# cycle). A reflection test cross-checks the two for drift. The shared error
# mapper (Unit 4a) translates an error's ``recovery_kind`` into a
# ``RecoveryDescriptor`` on the wire.
RecoveryKind = Literal[
    "load-case",
    "reload-case",
    "run-pflow",
    "retry",
    "add-measurements",
    "none",
    "wait-for-job",
    "wait-for-sweep",
]


# Default user-facing copy for each recovery kind. The mapper falls back to
# these when an error does not carry a bespoke label.
RECOVERY_DEFAULT_LABELS: dict[RecoveryKind, str] = {
    "load-case": "Load a case",
    "reload-case": "Reload the case",
    "run-pflow": "Run power flow first",
    "retry": "Try again",
    "add-measurements": "Add more measurements",
    "none": "No recovery action",
    "wait-for-job": "Wait for the running operation",
    "wait-for-sweep": "Wait for the sweep to finish",
}


class RecoveryDescriptor(BaseModel):
    """Recovery call-to-action attached to an error response.

    The ``kind`` is the stable, machine-readable discriminator the UI keys
    off to render the right action (e.g., a "Run power flow" button); the
    ``label`` is the human-facing copy. ``kind == "none"`` means the error was
    considered but has no canonical recovery action — the UI renders it
    without a CTA, same as an absent ``recovery``.
    """

    model_config = ConfigDict(extra="forbid")

    kind: RecoveryKind = Field(
        ...,
        description=(
            "Stable, machine-readable discriminator for the recovery action "
            "the client should offer (e.g., ``run-pflow``, ``load-case``, "
            "``retry``). ``none`` means no canonical recovery action applies."
        ),
    )
    label: str = Field(
        ...,
        description=(
            "Human-readable copy describing the recovery action, suitable for "
            "rendering on a call-to-action button or hint."
        ),
    )


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
    # ``default=`` (keyword), NOT positional ``None``: under mypy's
    # dataclass_transform handling of pydantic ``BaseModel`` (no pydantic mypy
    # plugin is enabled here), a model-typed optional declared with positional
    # ``Field(None, ...)`` is NOT recognized as having a default, so mypy
    # ``--strict`` flags ``recovery`` as a required ctor arg at every
    # ``ProblemDetails(...)`` site that omits it (verified: the positional form
    # raises ``Missing named argument "recovery"`` in api/app.py). The keyword
    # ``default=None`` form is recognized and keeps the field optional.
    recovery: RecoveryDescriptor | None = Field(
        default=None,
        description=(
            "Optional recovery call-to-action describing how the client can "
            "resolve the problem (e.g., load a case, run power flow, retry). "
            "``None`` means no recovery action is offered. Populated by the "
            "shared error mapper (Unit 4a) from the error's recovery kind."
        ),
    )


# ---- jobs (v3.1 Unit 1) -----------------------------------------------------


# Re-exported aliases so OpenAPI consumers can reference these by name.
# The substrate's authoritative types live in ``core/jobs.py``.
JobKindSchema = JobKindLiteral
JobStatusSchema = JobStatusLiteral


class JobRecordSchema(BaseModel):
    """HTTP-visible shape of a ``_JobRegistry`` record.

    Returned by ``GET /sessions/{id}/jobs`` and ``GET /sessions/{id}/jobs/{job_id}``
    in Unit 5a. Every routine response from Unit 5b also embeds a ``job_id``
    that resolves to one of these records.
    """

    model_config = ConfigDict(extra="forbid")

    id: str = Field(
        ...,
        description="Server-generated UUID identifier for the job.",
    )
    kind: JobKindLiteral = Field(
        ...,
        description=(
            "Discriminator for the routine kind (``pflow``, ``tds-stream``, "
            "``eig``, ``cpf``, ``cpf-qv``, ``se``, ``sweep``, ``snapshot-*``, "
            "``bundle-*``, ``element-*``, ``clone-*``, etc.). The full enum "
            "lives in ``andes_app.core.jobs.JobKind``."
        ),
    )
    status: JobStatusLiteral = Field(
        ...,
        description=(
            "Lifecycle state: ``pending`` (registered), ``running`` (worker "
            "actively executing), ``done`` (completed successfully), "
            "``failed`` (worker raised; ``problem`` populated), or "
            "``cancelled`` (cooperative-abort succeeded)."
        ),
    )
    started_at: float = Field(
        ...,
        description=(
            "Monotonic clock seconds when the job was registered. Use "
            "differences between ``started_at`` / ``updated_at`` / "
            "``ended_at`` for elapsed-time display."
        ),
    )
    updated_at: float = Field(
        ...,
        description="Monotonic clock seconds at the most recent state mutation.",
    )
    ended_at: float | None = Field(
        None,
        description=(
            "Monotonic clock seconds at terminal transition (done/failed/cancelled). "
            "``None`` while in-flight."
        ),
    )
    can_cancel: bool = Field(
        ...,
        description=(
            "True if the job exposes a cooperative-abort path (TDS streaming, "
            "sweep, clone reload-replay). Synchronous routines like PF/EIG/CPF/"
            "SE are not cancellable; the UI must NOT render a cancel button "
            "for ``can_cancel: false`` records."
        ),
    )
    progress: float | None = Field(
        None,
        description=(
            "Fractional progress in ``[0.0, 1.0]`` when the job emits "
            "per-step progress (sweep iterations, clone reload-replay "
            "phases). ``None`` means indeterminate."
        ),
    )
    request_summary: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Serializable subset of the original request body. Used by the "
            "Activity panel's Retry affordance to re-fire the same mutation "
            "variables. Must NOT carry credentials or large blobs (R16: "
            "this field is in-memory only and excluded from any "
            "Zustand persist whitelist on the web side)."
        ),
    )
    result_ref: str | None = Field(
        None,
        description=(
            "Opaque reference to the job's result, populated on ``done``. "
            "For TDS this is the ``run_id``; for sweep, the ``sweep_id``; "
            "for clone edits, the new param value reference."
        ),
    )
    problem: ProblemDetails | None = Field(
        None,
        description=(
            "Populated on ``failed`` with the full ProblemDetails envelope "
            "(includes the typed ``recovery`` axes from KTD-3). Drives the "
            "Activity panel's per-job ``<ProblemDetailsErrorSurface>``."
        ),
    )
    repeated_count: int = Field(
        0,
        description=(
            "Number of identical-signature failures that coalesced into "
            "this record (KTD-19 sticky-first semantics). For ``done`` and "
            "in-flight jobs this is always ``0``."
        ),
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
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the mutation that produced this entry "
            "(v3.1 Unit 5b). Populated only when this ``TopologyEntry`` is the "
            "top-level response of an edit / PMU-add / profile-add routine; "
            "``null`` for nested entries inside a ``TopologySummary``."
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
    controllers: list[TopologyEntry] = Field(
        default_factory=list,
        description=(
            "Dynamic controller devices: exciters (``IEEEX1``, ``ESDC2A``, "
            "``SEXS``), governors (``IEEEG1``, ``TGOV1``), the ``IEEEST`` "
            "PSS, and the ``REGCA1`` renewable-converter model. Surfaces "
            "the seven Unit-8 whitelist additions so the disturbance editor "
            "can populate device pickers when the case includes them. Empty "
            "for cases that carry no dynamics addfile (stock IEEE 14 .raw "
            "alone)."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the routine that produced this topology "
            "snapshot (v3.1 Unit 5b) — case load / reload, element delete / "
            "undo, or blank-system create. ``null`` when the summary is a plain "
            "read (``GET /topology``)."
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
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this routine invocation (v3.1 Unit "
            "5b). Additive: ``GET /sessions/{id}/jobs/{job_id}`` returns the "
            "matching ``JobRecord`` (kind ``pflow``). ``null`` only on legacy "
            "responses synthesised outside the job lifecycle."
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
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the disturbance-commit routine (v3.1 "
            "Unit 5b, kind ``disturbance-commit``). One job covers the whole "
            "batch; ``null`` on legacy responses."
        ),
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
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the element-add routine (v3.1 Unit 5b, "
            "kind ``element-add``). ``null`` on legacy responses."
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


# ---- clone-on-write (v3.1 Unit 21 / KTD-9) ----------------------------------


class CloneEditRequest(BaseModel):
    """Request body for ``PUT /sessions/{id}/case/clone/params/{model}/{idx}/{param}``.

    Carries only the new ``value`` — ``model`` / ``idx`` / ``param`` are path
    parameters, whitelist-validated by the route BEFORE any clone work. The
    edit modifies the cloned case file (never the original), then re-loads +
    re-setups the System so runs reflect the new value.
    """

    model_config = ConfigDict(extra="forbid")

    value: ParamValue = Field(
        ...,
        description=(
            "New value for the parameter. Written to the clone case file; "
            "ANDES re-reads it on the subsequent ``load(setup=False) → "
            "setup()`` cycle. Some params are per-unit-normalised at setup, so "
            "the read-back live value may differ from the file value."
        ),
    )


class CloneEditResponse(BaseModel):
    """Response body for the clone edit / undo / redo routes.

    Returns the post-setup live value plus the current undo / redo stack
    depths so the inspector can enable / disable its undo / redo affordances.
    """

    model_config = ConfigDict(extra="forbid")

    model: str = Field(
        ...,
        description=(
            "ANDES model class of the edited device (echoed from the path). "
            "Empty string on undo / redo responses (the stack entry, not a "
            "single field, is the unit of work)."
        ),
    )
    idx: str = Field(
        ...,
        description="Device idx of the edited element (empty on undo / redo).",
    )
    param: str = Field(
        ...,
        description="Edited parameter name (empty on undo / redo).",
    )
    new_value: ParamValue | None = Field(
        default=None,
        description=(
            "The parameter value read back from the re-setup System "
            "(``ss.<model>.<param>.v[i]``). ``null`` on undo / redo."
        ),
    )
    undo_depth: int = Field(
        ...,
        description="Number of edits currently recoverable via undo (0-50).",
    )
    redo_depth: int = Field(
        ...,
        description="Number of undone edits currently re-appliable via redo.",
    )
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring the clone routine (v3.1 Unit 5b, kinds "
            "``clone-edit`` / ``clone-undo`` / ``clone-redo``). ``null`` on "
            "legacy responses."
        ),
    )


class CloneInitResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/case/clone`` (clone init)."""

    model_config = ConfigDict(extra="forbid")

    clone_dir: str = Field(
        ...,
        description="Absolute path of the per-session clone scratch directory.",
    )
    clone_files: list[str] = Field(
        default_factory=list,
        description="Absolute paths of the cloned case files (case + addfiles).",
    )
    already_initialized: bool = Field(
        ...,
        description=(
            "``true`` when the clone already existed (idempotent re-init — no "
            "re-copy, so pending edits are preserved)."
        ),
    )
    job_id: str | None = Field(
        default=None,
        description="Job-registry id for the ``clone-init`` routine.",
    )


class CloneSaveAsRequest(BaseModel):
    """Request body for ``POST /sessions/{id}/case/clone/save-as``."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        ...,
        description=(
            "Workspace-relative case name (stem only — no extension, no path "
            "separators or traversal). The clone's files are written as "
            "``<name>.<ext>`` for each cloned format."
        ),
    )
    overwrite: bool = Field(
        default=False,
        description=(
            "When false (the default), save-as REFUSES to overwrite an existing "
            "workspace file (a 422) — this protects the loaded original case, "
            "which lives in the same workspace, from being silently clobbered. "
            "Pass true to intentionally overwrite an existing case."
        ),
    )


class CloneSaveAsResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/case/clone/save-as`` (201)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="The saved case name (stem).")
    files: list[str] = Field(
        default_factory=list,
        description="Absolute paths of the written workspace files.",
    )
    job_id: str | None = Field(
        default=None,
        description="Job-registry id for the ``clone-save-as`` routine.",
    )


class CloneResetResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/case/clone/reset``."""

    model_config = ConfigDict(extra="forbid")

    reset: bool = Field(
        ...,
        description="Always ``true`` — the clone dir was discarded and the "
        "session reverted to the original case files.",
    )
    job_id: str | None = Field(
        default=None,
        description="Job-registry id for the ``clone-reset`` routine.",
    )


class CloneDiffPair(BaseModel):
    """One changed param's original-vs-current file values (Unit 23)."""

    model_config = ConfigDict(extra="forbid")

    original: ParamValue | None = Field(
        default=None,
        description=(
            "The param value in the ORIGINAL case file (pre-setup read). "
            "``null`` when the param is absent on the original device."
        ),
    )
    current: ParamValue | None = Field(
        default=None,
        description=(
            "The param value in the CLONE case file (pre-setup read). "
            "``null`` when the param is absent on the clone device."
        ),
    )


class CloneDiffResponse(BaseModel):
    """Response body for ``GET /sessions/{id}/case/clone/diff/{model}/{idx}``.

    Maps each whitelisted controller param whose clone-file value differs from
    the original-file value to its ``{original, current}`` pair. An empty
    ``params`` means no edits relative to the original (or no clone yet).
    """

    model_config = ConfigDict(extra="forbid")

    params: dict[str, CloneDiffPair] = Field(
        default_factory=dict,
        description=(
            "Changed params keyed by name; unchanged / unedited params are "
            "absent. Empty when no clone is initialised."
        ),
    )


class TopologyParamMeta(BaseModel):
    """One parameter row in a model's add/edit form schema."""

    name: str = Field(..., description="ANDES parameter name (e.g., ``Vn``).")
    kind: Literal["string", "number", "bus_idx", "gen_idx", "bool"] = Field(
        ...,
        description=(
            "Form-input kind. ``string`` and ``number`` map to text/number "
            "inputs; ``bus_idx`` renders as a dropdown of existing buses; "
            "``gen_idx`` a dropdown of existing static generators; "
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
            "``format`` (``.xlsx`` for xlsx, ``.json`` for json, "
            "``.raw`` for raw)."
        ),
        min_length=1,
    )
    format: Literal["xlsx", "json", "raw"] = Field(
        ...,
        description=(
            "Output format. ``xlsx`` is the ANDES-native Excel layout. "
            "``json`` is the ANDES JSON serialization. ``raw`` is "
            "PSS/E v33 emitted by the substrate's hand-rolled writer; "
            "it covers Bus, PQ/ZIP loads, Shunt, PV/Slack/GENROU/"
            "GENCLS generators, Line, and 2W transformers. 3W "
            "transformers and other PSS/E sections are emitted as "
            "empty terminators."
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
            "Job-registry id mirroring the case-save routine (v3.1 Unit 5b, "
            "kind ``case-save``). ``null`` on legacy responses."
        ),
    )


class DeleteBlockedResponse(BaseModel):
    """Response body for ``DELETE /sessions/{id}/elements/{model}/{idx}``
    when the deletion is blocked by cascade dependents (HTTP 422).

    The list is capped at 25 entries; ``total`` reports the full count so
    the UI can render a "Showing 25 of N dependents" footer when truncated.
    """

    model_config = ConfigDict(extra="forbid")

    dependents: list[TopologyEntry] = Field(
        ...,
        description=(
            "Up to 25 dependent topology entries that reference the "
            "target element (e.g., Lines and generators attached to a "
            "Bus the caller tried to delete). The UI surfaces these as "
            "clickable rows the user must clear before re-issuing the "
            "delete."
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


# ``DeleteElementResponse`` is a transparent alias for ``TopologySummary``:
# a successful delete returns the post-delete topology snapshot. The alias
# documents the relationship at the OpenAPI surface and gives the generated
# TypeScript client a dedicated symbol for the success path.
DeleteElementResponse = TopologySummary


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
    vars: list[Literal["bus_v", "gen_state", "line_flow"]] | None = Field(
        None,
        description=(
            "Optional selector for which variable groups appear as columns "
            "in each per-step Arrow record batch on the streaming path. "
            "``bus_v`` covers bus voltage magnitudes (the v0.1 default); "
            "``gen_state`` adds generator rotor angle ``delta`` and per-"
            "unit speed ``omega`` for every member of the ANDES ``SynGen`` "
            "group (GENROU / GENCLS / PLBVFU1); ``line_flow`` adds active "
            "power ``Line_<idx>_p`` (MW) at each line's bus1 terminal. "
            "Unknown values are rejected with 422; an empty list is "
            "rejected with 422. The batch path (``POST /tds``) ignores "
            "this field at runtime — the streamed-only state values are "
            "not surfaced in batch responses — but it is accepted on the "
            "OpenAPI surface for symmetry with the WebSocket "
            "``start_tds`` config so generated clients can share one "
            "request shape. Defaults to ``[\"bus_v\"]`` when omitted."
        ),
        min_length=1,
    )
    integrator: Literal["trapezoidal", "qndf"] = Field(
        "trapezoidal",
        description=(
            "DAE integrator (Unit 16). ``\"trapezoidal\"`` (default) maps "
            "to ANDES's fixed-step Implicit Trapezoidal Method "
            "(``ss.TDS.config.method = \"trapezoid\"``). ``\"qndf\"`` "
            "selects the variable-order, variable-step QNDF (NDF) method "
            "and forces ``fixt = 0`` so ANDES enables LTE-driven step "
            "control. Combine ``integrator=\"qndf\"`` with the Auto "
            "preset (``rtol=1e-3, atol=1e-6, max_step=0.05``) by passing "
            "the values via ``tds_config_overrides``."
        ),
    )
    tds_config_overrides: dict[str, float] | None = Field(
        None,
        description=(
            "Optional adaptive-integrator tolerance overrides (Unit 16). "
            "Supported keys are ``rtol`` (→ ``ss.TDS.config.reltol``), "
            "``atol`` (→ ``ss.TDS.config.abstol``) and ``max_step`` (→ "
            "``ss.TDS.config.dtmax``). Unknown keys are rejected with "
            "500 ``SetupFailedError`` from the wrapper. Has no effect "
            "when ``integrator=\"trapezoidal\"`` (the fixed-step path "
            "ignores ``reltol/abstol`` and uses ``h`` for stepping)."
        ),
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
    job_id: str | None = Field(
        default=None,
        description=(
            "Job-registry id mirroring this TDS run (v3.1 Unit 5c). Additive "
            "and IDENTICAL to ``run_id`` — the two fields alias the same value, "
            "with ``run_id`` preserved for backward compatibility. "
            "``GET /sessions/{id}/jobs/{job_id}`` returns the matching "
            "``JobRecord`` (kind ``tds-batch``). ``null`` only on legacy "
            "responses synthesised outside the job lifecycle."
        ),
    )


# ---- abort + alterable-params (Unit 1b of v0.2) ----------------------------


class AbortResponse(BaseModel):
    """Response body for ``POST /sessions/{id}/abort``.

    The endpoint is fire-and-forget at the wire level — it sets the session's
    abort event and returns immediately. The actual TDS exit happens
    cooperatively at the next ``callpert`` tick on the worker (typically
    within a few milliseconds for IEEE 14, longer for larger cases). The
    streaming WebSocket emits the terminal ``done`` message with
    ``final_t < tf`` once the integration loop exits.

    There is no ``aborted`` flag on the WS ``done`` payload — the UI infers
    user-initiated abort from local state (it set the abort itself) vs.
    numerical instability (a ``done`` with ``final_t < tf`` arrived without
    a local abort).
    """

    model_config = ConfigDict(extra="forbid")

    aborted: Literal[True] = Field(
        True,
        description=(
            "Always ``true`` on a successful response. The signal has been "
            "delivered to the worker; the actual TDS exit is cooperative "
            "and lands on the next per-step ``callpert`` tick. No-op when "
            "no TDS is currently running on the session (the abort event "
            "is set but never consumed)."
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
    non_bus_coordinates: dict[str, dict[str, BusCoord]] = Field(
        default_factory=dict,
        description=(
            "Per-non-bus-element coordinates, two-level dict keyed by "
            "ANDES model class (e.g., ``PV``, ``GENROU``, ``PQ``, ``Shunt``) "
            "OR by UI category (``generator``, ``load``, ``shunt``), then by "
            "element idx (stringified). The writer emits BOTH the model-"
            "class-keyed entry and the UI-category-keyed entry for every "
            "dragged non-bus element so kind-edits (e.g., ``PV`` → "
            "``GENROU``) survive: the model-class entry becomes orphaned "
            "but the UI-category entry still resolves on read. Optional + "
            "additive — old sidecars without this field read as ``{}`` and "
            "the renderer falls back to kind-default offsets."
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
