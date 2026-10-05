"""COMTRADE export endpoint: the signals the caller sends, as an IEEE C37.111 record.

``POST /comtrade`` holds no session. The web UI sends the columns of a streamed
run, which live in the browser, and a script or an agent sends the ``traces`` of
a batch TDS run. The answer is a ``.zip`` of the record's configuration file and
its ASCII data file. What the two hold is described in ``tensa.core.comtrade``.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from tensa import __version__
from tensa.api.schemas import MAX_COMTRADE_VALUES, ComtradeExportRequest, ProblemDetails
from tensa.core.comtrade import ComtradeChannel, ComtradeError, comtrade_record, comtrade_zip
from tensa.core.errors import short_repr
from tensa.security.names import user_name_problem

router = APIRouter()


def _record_zip(body: ComtradeExportRequest) -> bytes:
    record = comtrade_record(
        body.t,
        [ComtradeChannel(name=c.name, values=c.values, unit=c.unit) for c in body.channels],
        station=body.station,
        device=f"TENSA {__version__}" if body.device is None else body.device,
        frequency_hz=body.frequency_hz,
        start=body.start_time,
        trigger_t=body.trigger_t,
    )
    return comtrade_zip(record, body.name)


@router.post(
    "/comtrade",
    openapi_extra={"x-tensa-gui-location": "analysis-panel"},
    operation_id="exportComtrade",
    summary="Write sampled signals as a COMTRADE (IEEE C37.111) record: a .cfg and an ASCII .dat in a .zip.",
    response_class=Response,
    responses={
        200: {
            "content": {"application/zip": {}},
            "description": (
                "A ``.zip`` holding ``<name>.cfg`` and ``<name>.dat``: the 1999 "
                "revision of the standard, ASCII data, one analog channel per "
                "signal and a time stamp per sample."
            ),
        },
        413: {
            "model": ProblemDetails,
            "description": (
                f"The request holds more than {MAX_COMTRADE_VALUES} values "
                "(channels times samples)."
            ),
        },
        422: {
            "model": ProblemDetails,
            "description": (
                "The body is malformed, or the signals make no record: no sample, "
                "times that decrease, a channel whose length is not that of ``t``, "
                "a ``trigger_t`` outside the record, or a ``name`` that is not a "
                "plain file name."
            ),
        },
    },
)
async def export_comtrade(body: ComtradeExportRequest) -> Response:
    """Each signal becomes an analog channel named and given the unit the request
    gives it, scaled over its own range onto the integers a 1999 data file holds,
    so a channel resolves about 1 / 200 000 of its range. The record declares a
    sampling rate only when the samples are evenly spaced; otherwise a reader goes
    by the time stamps, as it must for a run with an event in it. The values are
    the caller's own (per unit, MW, radians), and for a time-domain run they are
    phasor quantities, not instantaneous waveforms. Needs no session: send the
    columns of a streamed run, or ``t`` and ``variables`` of a batch run's
    ``traces``."""
    problem = user_name_problem(body.name)
    if problem is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"invalid name {short_repr(body.name, 80)}; the name {problem}",
        )
    held = sum(len(channel.values) for channel in body.channels)
    if held > MAX_COMTRADE_VALUES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"the request holds {held} values (channels times samples); an "
                f"export takes at most {MAX_COMTRADE_VALUES}"
            ),
        )
    try:
        # Scaling and formatting a long run takes seconds, so not on the event loop.
        archive = await run_in_threadpool(_record_zip, body)
    except ComtradeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    return Response(
        content=archive,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{body.name}.zip"'},
    )
