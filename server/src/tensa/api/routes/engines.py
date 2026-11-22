"""Engines endpoint: which engines this server can start a session for.

``GET /engines`` lists every engine the server knows, available or not, with what
each can do (``design/multiengine/spec.md``, section 7). It holds no session and
never loads an engine: the capabilities are data, and the ANDES version comes from
package metadata, so the call is instant.
"""

from __future__ import annotations

from fastapi import APIRouter

from tensa.api.schemas import EngineCapabilities, EngineList
from tensa.engines import all_engine_capabilities

router = APIRouter()


@router.get(
    "/engines",
    openapi_extra={"x-tensa-gui-location": "auto"},
    operation_id="listEngines",
    summary="List the engines the server can start a session for, with their capabilities.",
    response_model=EngineList,
)
async def list_engines() -> EngineList:
    """Static endpoint: the capabilities are data and never change while the server runs."""
    return EngineList(
        engines=[
            EngineCapabilities.model_validate(block) for block in all_engine_capabilities()
        ]
    )
