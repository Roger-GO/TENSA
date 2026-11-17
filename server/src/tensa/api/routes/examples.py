"""Example cases: list the catalog, and add a case to the workspace.

- ``GET /examples`` lists every entry of the catalog (what the case is, its size and
  analyses, where it comes from, how to cite it, its licence and what was checked), with
  whether it is already in the workspace and whether its file can be found.
- ``POST /examples/{example_id}/add`` copies the case's file or files into the workspace
  root and records their source, citations and licence in ``EXAMPLE-SOURCES.md`` beside
  them. A file that exists is never replaced unless ``overwrite`` is set.

The catalog and the copying are in ``tensa.core.examples``; this module only maps what
they raise onto HTTP statuses.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi import Path as PathParam
from starlette.concurrency import run_in_threadpool

from tensa.api.schemas import (
    AddedExample,
    AddedExampleFile,
    ExampleList,
    ExampleListEntry,
    ProblemDetails,
)
from tensa.core.examples import (
    SOURCES_FILE,
    ExampleError,
    ExampleExistsError,
    ExampleHasNoFileError,
    ExampleSourceMissingError,
    UnknownExampleError,
    add_example,
    example_statuses,
)
from tensa.security.paths import WorkspacePathError

router = APIRouter()

log = logging.getLogger("tensa.examples")

def _workspace(request: Request) -> Path:
    workspace = getattr(request.app.state, "workspace", None)
    if not isinstance(workspace, Path):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="workspace is not configured",
        )
    return workspace


@router.get(
    "/examples",
    openapi_extra={"x-tensa-gui-location": "example-dialog"},
    operation_id="listExamples",
    summary="List the example cases TENSA can add to the workspace.",
    response_model=ExampleList,
)
async def list_examples(request: Request) -> ExampleList:
    """Every entry of the example catalog, in the catalog's order.

    An entry says what the case is for, its size and the analyses it supports, where its
    file comes from (``provenance``), how to cite it, its licence, what was changed in the
    data (``modifications``), what to know before relying on it (``caveats``) and how its
    results were checked (``verification``, where that has been done). ``in_workspace`` and
    ``available`` are about this server: whether the case's file is already in the
    workspace, and whether the file it would copy can be found. An entry of kind
    ``external`` has no file, only ``links``.
    """
    workspace = _workspace(request)
    statuses = await run_in_threadpool(example_statuses, workspace)
    return ExampleList(
        examples=[
            ExampleListEntry(
                **s.example.model_dump(),
                in_workspace=s.in_workspace,
                available=s.available,
            )
            for s in statuses
        ]
    )


@router.post(
    "/examples/{example_id}/add",
    openapi_extra={"x-tensa-gui-location": "example-dialog"},
    operation_id="addExample",
    summary="Add an example case to the workspace.",
    response_model=AddedExample,
    status_code=status.HTTP_201_CREATED,
    responses={
        400: {
            "model": ProblemDetails,
            "description": (
                "The entry is a link to data TENSA does not hold (kind ``external``), so there "
                "is no file to add, or a path in the workspace was refused."
            ),
        },
        404: {
            "model": ProblemDetails,
            "description": (
                "The catalog has no entry of that id, or the file it names cannot be found: "
                "the installed ANDES does not hold it."
            ),
        },
        409: {
            "model": ProblemDetails,
            "description": (
                "A file of the case is already in the workspace and ``overwrite`` was not set "
                "(or the name is a directory). Nothing was written."
            ),
        },
        500: {
            "model": ProblemDetails,
            "description": (
                "The file could not be written (full disk, permissions), or a bundled file is "
                "not the one TENSA shipped."
            ),
        },
    },
)
async def add_example_to_workspace(
    request: Request,
    example_id: str = PathParam(
        ..., description="Id of the example case, as ``GET /examples`` lists it."
    ),
    overwrite: bool = Query(
        False,
        description=(
            "Replace the files of the case that are already in the workspace. When ``false`` "
            "(the default) an existing file is left alone and the request answers 409."
        ),
    ),
) -> AddedExample:
    """Copy the case's file or files into the workspace root.

    The files go in as an upload does (written whole, never over a name that is taken
    unless ``overwrite`` is true). The source, citations and licence of the case are added
    to ``EXAMPLE-SOURCES.md`` in the workspace root, which is not a case file and is not
    listed as one. An ANDES case is copied from the ANDES installed on the server; when
    that file is not the one the catalog was written against, the case is added anyway and
    ``warnings`` says so.
    """
    workspace = _workspace(request)
    try:
        result = await run_in_threadpool(add_example, example_id, workspace, overwrite)
    except UnknownExampleError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ExampleSourceMissingError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ExampleHasNoFileError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except ExampleExistsError as exc:
        hint = "; send overwrite=true to replace it" if exc.replaceable else ""
        raise HTTPException(status.HTTP_409_CONFLICT, detail=f"{exc}{hint}") from exc
    except WorkspacePathError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except ExampleError as exc:
        log.warning("could not add example %r: %s", example_id, exc)
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc
    return AddedExample(
        id=result.example.id,
        primary=result.files[0].name,
        files=[
            AddedExampleFile(name=f.name, size_bytes=f.size_bytes, replaced=f.replaced)
            for f in result.files
        ],
        warnings=list(result.warnings),
        sources_file=SOURCES_FILE,
    )
