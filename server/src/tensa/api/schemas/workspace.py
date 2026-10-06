"""The workspace: its file lister, and the layout sidecar saved beside a case.

The layout's own models (``SidecarLayout`` and the records inside it) are defined in
``tensa.core.layout``, because the worker reads and writes layouts too (a snapshot
and a bundle hold one); the two the routes name are exported from here.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from tensa.core.layout import BusCoord, SidecarLayout

__all__ = [
    "BusCoord",
    "SidecarLayout",
    "UploadedWorkspaceFile",
    "WorkspaceFile",
    "WorkspaceFileList",
]


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
