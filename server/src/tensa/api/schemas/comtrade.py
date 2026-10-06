"""COMTRADE export of sampled signals: ``POST /comtrade``."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from tensa.core.comtrade import MAX_NAME_CHARS as COMTRADE_NAME_CHARS
from tensa.core.comtrade import MAX_UNIT_CHARS as COMTRADE_UNIT_CHARS
from tensa.core.comtrade import NO_UNIT as COMTRADE_NO_UNIT

# The most values (channels times samples) one export takes. A body of this size
# is about 100 MB of JSON, which is read in about half a second. The route checks
# it, not a ``max_length`` here: a list that fails one comes back whole in the
# text of the 422.
MAX_COMTRADE_VALUES = 5_000_000


class ComtradeChannelSeries(BaseModel):
    """One signal of a COMTRADE export. A batch run's ``traces.variables`` entries
    have this shape."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description=(
            "What the signal is called; it becomes the channel's identifier, "
            f"reduced to ASCII without commas and cut to {COMTRADE_NAME_CHARS} characters."
        ),
    )
    unit: str | None = Field(
        None,
        max_length=200,
        description=(
            "The unit the values are in (``pu``, ``MW``, ``rad``), reduced to ASCII "
            f"and cut to {COMTRADE_UNIT_CHARS} characters. A channel given none is "
            f"written with the unit ``{COMTRADE_NO_UNIT}``, since the field cannot be empty."
        ),
    )
    values: list[float | None] = Field(
        ...,
        description=(
            "The signal's value at each time in ``t``. ``null`` marks a missing "
            "value (a diverged step), which the data file holds as 99999."
        ),
    )


class ComtradeExportRequest(BaseModel):
    """Request body for ``POST /comtrade``."""

    model_config = ConfigDict(extra="forbid")

    t: list[float] = Field(
        ...,
        description=(
            "Sample times in seconds, not decreasing, at least one. Times need "
            "not be evenly spaced: the record carries a time stamp per sample."
        ),
    )
    channels: list[ComtradeChannelSeries] = Field(
        ...,
        min_length=1,
        description=(
            "The signals, each with one value per time in ``t``. At most "
            f"{MAX_COMTRADE_VALUES} values in all (channels times samples)."
        ),
    )
    name: str = Field(
        "tensa",
        description=(
            "File name the record's two files share: the archive holds "
            "``<name>.cfg`` and ``<name>.dat``. 1-64 chars of [A-Za-z0-9._-] "
            "starting with an alphanumeric, not ending in a dot, and not a "
            "Windows device name (CON, NUL, COM1, ...)."
        ),
    )
    station: str = Field(
        "",
        max_length=200,
        description=(
            "The record's station name, for instance the case the run was made on. "
            f"Reduced to ASCII without commas and cut to {COMTRADE_NAME_CHARS} characters."
        ),
    )
    device: str | None = Field(
        None,
        max_length=200,
        description=(
            "The record's recording device, for instance a name for the run. "
            "Reduced as ``station`` is. Defaults to ``TENSA`` and its version."
        ),
    )
    frequency_hz: float = Field(
        60.0,
        gt=0.0,
        allow_inf_nan=False,
        description="The system's nominal frequency in Hz, the record's line frequency.",
    )
    start_time: datetime | None = Field(
        None,
        description=(
            "The date and time simulated time zero stands for (ISO 8601). The "
            "record's first date line is this plus the first time in ``t``. The "
            "format carries no time zone, so the clock reading is written as "
            "given. Defaults to the server's local time when the request arrives."
        ),
    )
    trigger_t: float | None = Field(
        None,
        allow_inf_nan=False,
        description=(
            "Simulated time of the trigger point in seconds, for instance when a "
            "fault is applied; it must lie inside the record. Defaults to the "
            "first time in ``t``."
        ),
    )
