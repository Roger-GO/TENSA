"""The engines the server can start a session for: ``GET /engines``."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class EngineFormats(BaseModel):
    """The case file formats an engine reads and writes."""

    read: list[str] = Field(
        ...,
        description=(
            "The formats the engine loads a case from (``xlsx``, ``json``, "
            "``psse-raw``, ``psse-dyr``, ``matpower``). Empty for an engine that is "
            "not available."
        ),
    )
    write: list[str] = Field(
        ...,
        description="The formats the engine saves a case as. Empty for an engine that is not available.",
    )


class EngineCapabilities(BaseModel):
    """What one engine can do, as ``GET /engines`` reports it (spec section 7)."""

    name: str = Field(..., description="The engine's name (``andes``, ``sienna``).")
    available: bool = Field(
        ...,
        description="Whether this build can start a session for the engine.",
    )
    unavailable_reason: str | None = Field(
        ...,
        description="Why the engine cannot start a session, or null when it can.",
    )
    versions: dict[str, str] = Field(
        ...,
        description=(
            "The versions the engine runs with, by package (``andes`` for the ANDES "
            "engine). Empty for an engine that is not available."
        ),
    )
    formats: EngineFormats = Field(..., description="The case file formats the engine reads and writes.")
    routines: list[str] = Field(
        ...,
        description=(
            "The routines the engine runs (``pflow``, ``tds``, ``eig``, ``cpf``, ``se``). "
            "A routine an engine lacks is absent here and refused with a 409 that names "
            "the engines that have it."
        ),
    )
    routine_options: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description=(
            "Per routine, what the engine takes where it differs from the ANDES "
            "engine, so a client offers only that: for ``tds``, whether runs "
            "stream (``streaming``) and can be aborted (``abort``), the "
            "disturbance kinds it takes (``disturbances``: ``branch_trip``, "
            "``bus_fault``, ``gen_trip``) and its options with their values "
            "(``options``: ``load_model``). Empty for an engine that takes "
            "everything the routine has (ANDES) and for one that is not available."
        ),
    )
    ops: list[str] = Field(
        ...,
        description="Every worker op the engine answers, sorted. Empty for an engine that is not available.",
    )
    editing: bool = Field(
        ...,
        description="Whether the engine edits a case (add, edit and delete elements).",
    )


class EngineList(BaseModel):
    """Response shape for ``GET /engines``."""

    engines: list[EngineCapabilities] = Field(
        ...,
        description="Every engine the server knows, available or not, in a fixed order.",
    )
