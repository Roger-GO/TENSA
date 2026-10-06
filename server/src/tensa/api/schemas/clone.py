"""Clone-on-write editing of a case after setup."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from tensa.core.wrapper import ParamValue


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
            "Job-registry id mirroring the clone routine (kinds "
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
    """One changed param's original-vs-current file values."""

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
