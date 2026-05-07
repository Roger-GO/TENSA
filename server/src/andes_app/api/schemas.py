"""Pydantic v2 request / response models for the HTTP API.

Every field has an explicit ``description`` (R25 acceptance: the
OpenAPI-to-MCP audit asserts no field has an empty description). Every error
response is shaped as ``ProblemDetails`` per RFC 7807.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

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
            "Transformer elements (currently empty for v0.1; ANDES models "
            "transformers within the Line model)."
        ),
    )
    generators: list[TopologyEntry] = Field(
        ...,
        description="Generator elements (PV, Slack, GENROU, GENCLS, etc.).",
    )
    loads: list[TopologyEntry] = Field(..., description="Load elements (PQ).")


# ---- power flow -------------------------------------------------------------


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
