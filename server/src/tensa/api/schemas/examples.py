"""The example cases: ``GET /examples`` and ``POST /examples/{example_id}/add``.

What an entry holds (its source, citations, licence and checks) is the catalog's own model,
``tensa.core.example_catalog.Example``; the list adds what is true of this workspace.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from tensa.core.example_catalog import Example

__all__ = ["AddedExample", "AddedExampleFile", "ExampleList", "ExampleListEntry"]


class ExampleListEntry(Example):
    """One example case, as the catalog describes it, with its state on this machine."""

    in_workspace: bool = Field(
        ...,
        description=(
            "Whether the case's primary file is already in the workspace (a regular file of "
            "that name, which may be one the user wrote). Always ``false`` for a case with "
            "no file."
        ),
    )
    available: bool = Field(
        ...,
        description=(
            "Whether every file the case copies can be found: in the installed ANDES, or in "
            "this package. ``false`` for a case that has no file (``external``), and for an "
            "ANDES case the installed release does not hold."
        ),
    )


class ExampleList(BaseModel):
    """Response shape for ``GET /examples``."""

    examples: list[ExampleListEntry] = Field(
        ..., description="Every example case, in the order the catalog gives."
    )


class AddedExampleFile(BaseModel):
    """One file ``POST /examples/{example_id}/add`` wrote."""

    name: str = Field(..., description="The file name in the workspace root.")
    size_bytes: int = Field(..., ge=0, description="Size of the file in bytes.")
    replaced: bool = Field(
        ..., description="Whether the file replaced one of the same name (``overwrite`` was set)."
    )


class AddedExample(BaseModel):
    """Response shape for ``POST /examples/{example_id}/add``."""

    id: str = Field(..., description="The id of the example case that was added.")
    primary: str = Field(
        ..., description="Name of the case file to open (the first of ``files``)."
    )
    files: list[AddedExampleFile] = Field(
        ..., description="Every file written, the case file first."
    )
    warnings: list[str] = Field(
        ...,
        description=(
            "Things to know about what was added: an ANDES file that is not the one the "
            "catalog was written against, or a sources file that could not be updated."
        ),
    )
    sources_file: str = Field(
        ...,
        description=(
            "Name of the file in the workspace root that records the source, citations and "
            "licence of every example added."
        ),
    )
