"""The keys of a case's elements: the answer of ``GET /sessions/{id}/keys``."""

from __future__ import annotations

from pydantic import BaseModel, Field


class KeyEntrySchema(BaseModel):
    """One element of the loaded case and the key it was given."""

    key: str = Field(
        ...,
        description=(
            "The element's key: a string that names it the same way in every "
            "engine that loads the case (``bus:7``, ``branch:7-8-1``, "
            "``gen:1-1``, ``gen:1-1/exciter``), built from the case by the "
            "rule of section 4 of ``design/multiengine/spec.md``."
        ),
    )
    bucket: str = Field(
        ...,
        description=(
            "The part of the case the element belongs to: ``bus``, ``line``, "
            "``transformer``, ``generator``, ``load``, ``shunt``, "
            "``dynamic`` or ``other``."
        ),
    )
    model: str = Field(
        ...,
        description="The engine's model of the element (an ANDES model class name).",
    )
    idx: int | str = Field(
        ...,
        description="The engine's own handle of the element within ``model``.",
    )
    source: str = Field(
        ...,
        description=(
            "Where the id in the key came from: ``file`` for one read from "
            "the case file, ``engine`` for one the engine holds, ``ordinal`` "
            "for one made up from order."
        ),
    )


class KeyList(BaseModel):
    """Every key of the loaded case, in assignment order, with the problems
    the assignment noted."""

    keys: list[KeyEntrySchema] = Field(
        default_factory=list,
        description=(
            "One entry per element of the loaded case, in the order the keys "
            "were assigned. Empty when no case is loaded."
        ),
    )
    problems: list[str] = Field(
        default_factory=list,
        description=(
            "What assigning the keys found worth saying (a collision, an "
            "element the file does not name, ...). Empty when there is "
            "nothing to say."
        ),
    )
