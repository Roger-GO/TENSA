"""Version endpoint: which tensa and which ANDES this server is running.

``GET /version`` backs the web UI's About dialog, and is where a script or an
agent reads the two versions a bug report needs. Both come from package
metadata, so the call is instant and touches no session or worker.
"""

from __future__ import annotations

from fastapi import APIRouter

from tensa import __version__, andes_version
from tensa.api.schemas import VersionInfo

router = APIRouter()


@router.get(
    "/version",
    openapi_extra={"x-tensa-gui-location": "about-dialog"},
    operation_id="getVersion",
    summary="Report the tensa and ANDES versions this server runs.",
    response_model=VersionInfo,
)
async def get_version() -> VersionInfo:
    """Static endpoint: the versions are read from package metadata and never
    change while the server runs."""
    return VersionInfo(tensa=__version__, andes=andes_version())
