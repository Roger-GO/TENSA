"""The versions the server runs on: ``GET /version``."""

from __future__ import annotations

from pydantic import BaseModel, Field


class VersionInfo(BaseModel):
    """Response shape for ``GET /version``: the packages this server runs on."""

    tensa: str = Field(
        ...,
        description="Installed tensa version (the one in the OpenAPI ``info.version``).",
    )
    andes: str = Field(
        ...,
        description="Installed ANDES version, or ``unknown`` when its package metadata is missing.",
    )
