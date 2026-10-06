"""The workspace: its file lister, and the layout sidecar saved beside a case."""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class WorkspaceFile(BaseModel):
    """One entry in the workspace file lister response."""

    name: str = Field(
        ...,
        description=(
            "File name relative to the workspace root (no directory "
            "components; the lister does not recurse)."
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


class UploadedWorkspaceFile(WorkspaceFile):
    """Response shape for ``POST /workspace/files``: the file as it now sits in
    the workspace, as the lister would report it."""

    replaced: bool = Field(
        ...,
        description=(
            "``true`` when the upload replaced a file of the same name "
            "(``overwrite=true``), ``false`` when it created a new one."
        ),
    )


class WorkspaceFileList(BaseModel):
    """Response shape for ``GET /workspace/files``."""

    files: list[WorkspaceFile] = Field(
        ...,
        description=(
            "Workspace files matching the supported extensions, sorted "
            "alphabetically by ``name``. Hidden files (dotfiles) and "
            "symlinks are excluded; subdirectories are not recursed."
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
