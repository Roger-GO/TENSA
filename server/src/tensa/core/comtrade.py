"""COMTRADE (IEEE C37.111) export of sampled signals: one record's ``.cfg`` and ``.dat``.

:func:`comtrade_record` takes sample times and named signals (a streamed run's
columns, a batch run's ``traces``) and returns the configuration file and the
ASCII data file of one record, which fault-record viewers and analysis tools
read. :func:`comtrade_zip` packs the two under one name, as the standard pairs
them (``<name>.cfg``, ``<name>.dat``).

What is written is the 1999 revision of the standard, the one readers most
widely take, with ASCII data:

- Every signal is an analog channel; there are no status channels. A channel's
  identifier is the signal's name and its unit the one the caller gives
  (``NONE`` when it gives none: the field cannot be empty). Phase and circuit
  component are left blank. Text is reduced to ASCII without commas, the field
  separator, and cut to the standard's widths (64 characters for a name, 32 for
  a unit).
- The 1999 data file holds integers from -99999 to 99998, so each channel is
  scaled onto that range over its own smallest and largest value and the
  configuration carries the conversion: ``value = a * stored + b``. A channel
  therefore resolves about 1 / 200 000 of its own range. A channel that never
  changes is stored as zeros with ``a = 1`` and its value as ``b``. A value that
  is missing or not a number is stored as 99999, the standard's mark for one.
  The values are the caller's own (per unit, MW, radians): primary and secondary
  ratios are 1 and the scaling identifier is ``P``.
- Time stamps are whole microseconds counted from the first sample. A record
  longer than the ten digits a time stamp has (about 2 h 46 min) raises the time
  multiplier by tens, which coarsens the stamps by as much.
- A time-domain run is not sampled at a fixed rate: an event repeats its time,
  a variable-step integrator chooses its own steps. Such a record declares no
  sampling rate (``nrates`` is 0) and its time stamps are what a reader goes by.
  When the samples are evenly spaced to within one stamp, the record declares
  that one rate as well.
- The first date line is the time of the first sample and the second the time
  of the trigger point: ``start`` stands for simulated time zero, and the
  trigger is the first sample unless the caller names the instant (a fault's
  time). The format carries no time zone; the clock reading of ``start`` is
  written as given.
- Lines end in CR LF, and the data file ends with the end-of-file mark (hex 1A)
  the standard asks for after its last line.

The values of a time-domain run are phasor quantities (magnitudes, angles,
speeds, powers), one per simulation step or output interval, not samples of the
instantaneous waveforms a recorder stores.

This module imports no ANDES and holds no state.
"""

from __future__ import annotations

import io
import math
import unicodedata
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
from numpy.typing import NDArray

from tensa.core.errors import short_repr

REV_YEAR = 1999
# The range an analog value has in a 1999 ASCII data file, and the value that
# marks a missing one.
DATA_MIN = -99_999
DATA_MAX = 99_998
DATA_MISSING = 99_999
# The largest total number of channels a configuration file can declare.
MAX_CHANNELS = 999_999
# The largest time stamp: the field is ten characters wide.
MAX_TIME_STAMP = 9_999_999_999
MAX_NAME_CHARS = 64
MAX_UNIT_CHARS = 32
# The unit of a channel that is given none.
NO_UNIT = "NONE"

_MICROSECONDS = 1_000_000
# Data lines are formatted this many samples at a time, which bounds the Python
# integers alive at once on a long record of many channels.
_ROWS_PER_BLOCK = 2048

_Array = NDArray[np.float64]
# Samples as a caller holds them: a list (a JSON body), or an array; ``None``
# marks a value that is missing.
_Samples = Sequence[float | None] | _Array


class ComtradeError(ValueError):
    """The signals cannot be written as a record (no samples, times that run
    backwards, a channel of another length); the message says which."""


@dataclass(frozen=True)
class ComtradeChannel:
    """One signal of a record."""

    name: str
    #: One value per sample time; ``None`` or a value that is not a number is missing.
    values: _Samples
    #: The unit the values are in (``pu``, ``MW``, ``rad``); ``None`` for none.
    unit: str | None = None


@dataclass(frozen=True)
class ComtradeRecord:
    """The two files of one record, as text (ASCII only, lines ending in CR LF)."""

    cfg: str
    dat: str
    samples: int
    channels: int
    #: The sampling rate the configuration declares, in Hz; ``None`` when the
    #: samples are not evenly spaced and the record goes by its time stamps.
    sample_rate_hz: float | None


def _field(text: str, limit: int) -> str:
    """``text`` as one field of a configuration line: ASCII, with no comma (the
    separator) and no control character, runs of blanks as one, at most ``limit``
    characters."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    cleaned = "".join(" " if ch == "," or not ch.isprintable() else ch for ch in ascii_text)
    return " ".join(cleaned.split())[:limit].rstrip()


def _real(value: float) -> str:
    """``value`` in the standard's notation for a real number: a whole number as
    an integer (``60``), anything else at full precision with an ``E`` exponent."""
    if value == math.floor(value) and abs(value) < 1e15:
        return str(int(value))
    return repr(value).upper()


def _date_stamp(when: datetime) -> str:
    """``dd/mm/yyyy,hh:mm:ss.ssssss``, the 1999 form of a date and time."""
    return (
        f"{when.day:02d}/{when.month:02d}/{when.year:04d},"
        f"{when.hour:02d}:{when.minute:02d}:{when.second:02d}.{when.microsecond:06d}"
    )


def _times(t: _Samples) -> _Array:
    try:
        times = np.asarray(t, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ComtradeError("t must hold numbers") from exc
    if times.ndim != 1 or times.size == 0:
        raise ComtradeError("a record needs at least one sample")
    if not bool(np.all(np.isfinite(times))):
        raise ComtradeError("t must hold finite numbers")
    backwards = np.flatnonzero(times[1:] < times[:-1])
    if backwards.size:
        at = int(backwards[0]) + 1
        raise ComtradeError(
            f"t must not decrease: t[{at}] = {times[at]:g} is earlier than "
            f"t[{at - 1}] = {times[at - 1]:g}"
        )
    return times


def _values(channel: ComtradeChannel, samples: int) -> _Array:
    """The channel's values as floats, a missing one as ``nan``."""
    try:
        # numpy reads ``None`` as ``nan`` when asked for floats.
        values = np.asarray(channel.values, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ComtradeError(f"channel {short_repr(channel.name, 80)} must hold numbers") from exc
    if values.ndim != 1 or values.size != samples:
        raise ComtradeError(
            f"channel {short_repr(channel.name, 80)} has {values.size} values "
            f"for {samples} samples"
        )
    return values


def _scaled(values: _Array) -> tuple[NDArray[np.int64], float, float]:
    """``(stored, a, b)`` with ``value = a * stored + b``: the channel spread over
    the whole range a data file holds, a missing value as :data:`DATA_MISSING`."""
    finite = np.isfinite(values)
    stored = np.full(values.shape, DATA_MISSING, dtype=np.int64)
    if not bool(finite.any()):
        return stored, 1.0, 0.0
    low = float(values[finite].min())
    high = float(values[finite].max())
    # Halved before they are combined, so two values at opposite ends of what a
    # float holds do not overflow.
    b = high / 2 + low / 2
    a = (high / 2 - low / 2) / DATA_MAX
    if a <= 0.0 or not math.isfinite(a):
        # One value throughout (or a spread too small to divide): zeros on ``b``.
        stored[finite] = 0
        return stored, 1.0, b
    steps = np.rint((values[finite] - b) / a)
    stored[finite] = np.clip(steps, -DATA_MAX, DATA_MAX).astype(np.int64)
    return stored, a, b


def _time_stamps(times: _Array) -> tuple[NDArray[np.int64], float]:
    """Each sample's time stamp and the multiplier that turns one into microseconds."""
    with np.errstate(over="ignore"):
        elapsed = (times - times[0]) * _MICROSECONDS
    if not math.isfinite(float(elapsed[-1])):
        raise ComtradeError("the sample times span more than a record can stamp")
    multiplier = 1.0
    while elapsed[-1] / multiplier > MAX_TIME_STAMP:
        multiplier *= 10.0
    return np.rint(elapsed / multiplier).astype(np.int64), multiplier


def _sample_rate(times: _Array, stamps: NDArray[np.int64]) -> float | None:
    """The one rate the samples are taken at, in Hz, or ``None`` when they are not
    evenly spaced. Even means every time stamp lies within one stamp of a constant
    step, which is as close as rounded stamps of an exact rate come."""
    count = stamps.size
    if count < 2:
        return None
    step = float(stamps[-1]) / (count - 1)
    # Below two stamps a step, a repeated time would pass for an even one.
    if step < 2.0:
        return None
    if float(np.abs(stamps - np.arange(count) * step).max()) > 1.0:
        return None
    rate = (count - 1) / float(times[-1] - times[0])
    return float(f"{rate:.12g}")


def comtrade_record(
    t: _Samples,
    channels: Sequence[ComtradeChannel],
    *,
    station: str = "",
    device: str = "",
    frequency_hz: float = 60.0,
    start: datetime | None = None,
    trigger_t: float | None = None,
) -> ComtradeRecord:
    """The record of ``channels`` sampled at times ``t`` (seconds, not decreasing).

    ``station`` and ``device`` name where the record is from and what made it
    (the case, the program), ``frequency_hz`` is the system's nominal frequency.
    ``start`` is the date and time simulated time zero stands for (now, by the
    local clock, when not given) and ``trigger_t`` the simulated time of the
    trigger point, inside the record (its first sample when not given). Raises
    :class:`ComtradeError` for signals that make no record. The module docstring
    says what is written.
    """
    times = _times(t)
    samples = int(times.size)
    if not channels:
        raise ComtradeError("a record needs at least one channel")
    if len(channels) > MAX_CHANNELS:
        raise ComtradeError(
            f"{len(channels)} channels; a record holds at most {MAX_CHANNELS}"
        )
    if not (math.isfinite(frequency_hz) and frequency_hz > 0):
        raise ComtradeError("frequency_hz must be a finite number above zero")
    first_t = float(times[0])
    trigger = first_t if trigger_t is None else float(trigger_t)
    if not (first_t <= trigger <= float(times[-1])):
        raise ComtradeError(
            f"trigger_t = {trigger:g} s is outside the record, which runs from "
            f"{first_t:g} s to {float(times[-1]):g} s"
        )
    zero = datetime.now() if start is None else start
    try:
        first_stamp = _date_stamp(zero + timedelta(seconds=first_t))
        trigger_stamp = _date_stamp(zero + timedelta(seconds=trigger))
    except OverflowError as exc:
        raise ComtradeError("start and the sample times do not add up to a date") from exc

    stamps, multiplier = _time_stamps(times)
    rate = _sample_rate(times, stamps)

    stored = np.empty((samples, len(channels)), dtype=np.int64)
    lines = [
        f"{_field(station, MAX_NAME_CHARS)},{_field(device, MAX_NAME_CHARS)},{REV_YEAR}",
        f"{len(channels)},{len(channels)}A,0D",
    ]
    for column, channel in enumerate(channels):
        stored[:, column], a, b = _scaled(_values(channel, samples))
        number = column + 1
        name = _field(channel.name, MAX_NAME_CHARS) or f"channel {number}"
        unit = _field(channel.unit or "", MAX_UNIT_CHARS) or NO_UNIT
        # An,ch_id,ph,ccbm,uu,a,b,skew,min,max,primary,secondary,PS
        lines.append(
            f"{number},{name},,,{unit},{_real(a)},{_real(b)},0,{DATA_MIN},{DATA_MAX},1,1,P"
        )
    lines += [
        _real(frequency_hz),
        "0" if rate is None else "1",
        f"{_real(0.0 if rate is None else rate)},{samples}",
        first_stamp,
        trigger_stamp,
        "ASCII",
        _real(multiplier),
    ]

    data: list[str] = []
    for begin in range(0, samples, _ROWS_PER_BLOCK):
        block = stored[begin : begin + _ROWS_PER_BLOCK].tolist()
        block_stamps = stamps[begin : begin + _ROWS_PER_BLOCK].tolist()
        for offset, (stamp, row) in enumerate(zip(block_stamps, block, strict=True)):
            data.append(f"{begin + offset + 1},{stamp},{','.join(map(str, row))}")

    return ComtradeRecord(
        cfg="\r\n".join(lines) + "\r\n",
        dat="\r\n".join(data) + "\r\n\x1a",
        samples=samples,
        channels=len(channels),
        sample_rate_hz=rate,
    )


def comtrade_zip(record: ComtradeRecord, name: str) -> bytes:
    """``record`` as a ``.zip`` holding ``<name>.cfg`` and ``<name>.dat``.

    The caller answers for ``name`` being a plain file name (see
    ``tensa.security.names``). The lowest compression level is used: the data
    file is digits and commas, which it already cuts to a third, several times
    faster than the default does.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(
        buf, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=1
    ) as zf:
        zf.writestr(f"{name}.cfg", record.cfg.encode("ascii"))
        zf.writestr(f"{name}.dat", record.dat.encode("ascii"))
    return buf.getvalue()


__all__ = [
    "DATA_MAX",
    "DATA_MIN",
    "DATA_MISSING",
    "MAX_CHANNELS",
    "MAX_NAME_CHARS",
    "MAX_TIME_STAMP",
    "MAX_UNIT_CHARS",
    "NO_UNIT",
    "REV_YEAR",
    "ComtradeChannel",
    "ComtradeError",
    "ComtradeRecord",
    "comtrade_record",
    "comtrade_zip",
]
