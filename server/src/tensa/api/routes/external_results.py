"""External results import: a TSAT or PSS/E Excel export as overlay series.

``POST /external-results?source=tsat|psse`` holds no session. The request body
is the export's bytes, as ``POST /workspace/files`` takes a file (not
multipart), and the response is the ``series`` shape of
``POST /response-metrics``: the same client code plots a TENSA run's ``traces``
and an imported export together. The reading, and the bounds it keeps to, live
in ``tensa.core.external_results``.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from starlette.responses import Response

from tensa.api.schemas import (
    ExternalResultsResponse,
    ExternalSeries,
    ProblemDetails,
)
from tensa.core.external_results import (
    MAX_CELLS,
    MAX_COLUMNS,
    MAX_ROWS,
    MAX_UNPACKED_BYTES,
    ExternalResultsError,
    ExternalResultsTooLargeError,
    excel_to_series,
)

# The cap of the workspace file upload, and read the same way: a declared
# ``Content-Length`` over it is refused before a byte is read, and a body sent
# without one is counted as it arrives, so an oversized one is never held.
MAX_EXPORT_BYTES = 32 * 1024 * 1024

router = APIRouter()


def _answer(body: bytes, source: Literal["tsat", "psse"]) -> bytes:
    """The response's JSON for the export in ``body``; run in a thread."""
    names, columns, time = excel_to_series(body, source=source)
    return ExternalResultsResponse(
        source=source,
        samples=len(time),
        series=[ExternalSeries(name=n, t=time, y=col) for n, col in zip(names, columns, strict=True)],
    ).model_dump_json().encode()


async def _read_export_body(request: Request) -> bytes:
    """The request body, refused with 413 as soon as it passes ``MAX_EXPORT_BYTES``."""
    declared = request.headers.get("content-length", "")
    too_large = HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        detail=f"the export exceeds {MAX_EXPORT_BYTES // (1024 * 1024)} MiB",
    )
    if declared.isdigit() and int(declared) > MAX_EXPORT_BYTES:
        raise too_large
    chunks: list[bytes] = []
    total = 0
    try:
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_EXPORT_BYTES:
                raise too_large
            chunks.append(chunk)
    except ClientDisconnect as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="the upload was interrupted before the whole file arrived",
        ) from exc
    return b"".join(chunks)


@router.post(
    "/external-results",
    openapi_extra={
        "x-tensa-gui-location": "none",
        "x-tensa-parity-deferred": (
            "No web surface imports an external result yet; the route is for "
            "scripts and agents. It will later back the analysis panel's overlay "
            "of a TSAT or PSS/E export on a run's plotted traces."
        ),
        "requestBody": {
            "required": True,
            "description": (
                "The export's bytes, verbatim: an ``.xlsx`` workbook. Not multipart "
                "form data, which is refused with 415."
            ),
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            },
        },
    },
    operation_id="importExternalResults",
    summary="Import a TSAT or PSS/E Excel export as series to overlay on a run's traces.",
    response_model=ExternalResultsResponse,
    responses={
        400: {
            "model": ProblemDetails,
            "description": "The upload was interrupted before the whole file arrived.",
        },
        413: {
            "model": ProblemDetails,
            "description": (
                f"The body is larger than {MAX_EXPORT_BYTES // (1024 * 1024)} MiB, which "
                "is refused before it is read, or the workbook is past a bound of "
                f"what an import reads: it unpacks to more than "
                f"{MAX_UNPACKED_BYTES // (1024 * 1024)} MiB, or its first sheet has "
                f"more than {MAX_ROWS} rows after the offset, more than {MAX_COLUMNS} "
                f"columns, or more than {MAX_CELLS} cells."
            ),
        },
        415: {
            "model": ProblemDetails,
            "description": "The body was sent as multipart form data instead of the raw file.",
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "``source`` is missing or is not ``tsat`` or ``psse``, or the file is "
                "not an export the reader takes or holds nothing usable: an empty "
                "body, a file that is not an ``.xlsx`` workbook (``.xls``, ``.xlsb``, "
                "``.ods`` and CSV are not read), or no signal columns or no samples "
                "after the format's offset."
            ),
        },
    },
)
async def import_external_results(
    request: Request,
    source: Literal["tsat", "psse"] = Query(
        ...,
        description="The tool whose export the file is: ``tsat`` or ``psse``.",
    ),
) -> Response:
    """Read the request body as a TSAT or PSS/E Excel export and answer with its
    series.

    The first sheet is read as ANDES's ``tsat_to_df`` and ``psse_to_df`` read it:
    its first row is a header, the next 6 rows (TSAT) or 1 row (PSS/E) are
    skipped, the first column after them is time and the others are signals. The
    signals come back in the order the tool wrote them, named ``column 1``,
    ``column 2``, ... because the format carries no names ANDES reads; the caller
    labels them (ANDES's own comparison plot takes the names separately). A value
    that is not a finite number is ``null``, and a row whose time is not one is
    left out. The response is the ``series`` shape of ``POST /response-metrics``,
    so the same client code plots a TENSA run's ``traces`` and an imported export
    together. Needs no session.
    """
    if request.headers.get("content-type", "").lower().startswith("multipart/"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                "send the export's bytes as the request body, not as multipart form "
                "data (for curl: --data-binary @export.xlsx)"
            ),
        )
    body = await _read_export_body(request)
    try:
        # Reading a workbook is CPU-bound and takes seconds for a large one, and
        # its answer can hold a million numbers, so both are done off the event
        # loop and the JSON is handed back as it is.
        answer = await run_in_threadpool(_answer, body, source)
    except ExternalResultsTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except ExternalResultsError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    return Response(content=answer, media_type="application/json")
