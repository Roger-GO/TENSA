"""A reader of COMTRADE records, for the tests that check what the export writes.

It is written from the layout IEEE Std C37.111-1999 gives the two files and
shares nothing with ``tensa.core.comtrade``, so a test that reads a record back
through it checks the writer against the format, not against itself. It is
strict where the standard is: a line that does not end in CR LF, a field wider
than the standard allows, a count that disagrees with what follows all fail an
assertion here.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from numpy.typing import NDArray

# The value a 1999 ASCII data file holds for a missing analog value.
MISSING = 99999


@dataclass(frozen=True)
class ReadChannel:
    number: int
    name: str
    phase: str
    component: str
    unit: str
    a: float
    b: float
    skew: float
    minimum: int
    maximum: int
    primary: float
    secondary: float
    scaling: str
    #: The integers of the data file, one per sample.
    stored: NDArray[np.int64]

    @property
    def values(self) -> NDArray[np.float64]:
        """``a * stored + b``, a missing value as ``nan``."""
        out = self.a * self.stored.astype(np.float64) + self.b
        out[self.stored == MISSING] = np.nan
        return out


@dataclass(frozen=True)
class ReadRecord:
    station: str
    device: str
    rev_year: str
    channels: list[ReadChannel]
    frequency: float
    nrates: int
    #: ``(samp, endsamp)`` per rate line; one line with ``samp`` 0 when ``nrates`` is 0.
    rates: list[tuple[float, int]]
    first: datetime
    trigger: datetime
    file_type: str
    timemult: float
    #: The time stamp of each sample, as stored.
    stamps: NDArray[np.int64]

    @property
    def t(self) -> NDArray[np.float64]:
        """Seconds from the first sample: ``stamp * timemult`` microseconds."""
        return self.stamps.astype(np.float64) * self.timemult * 1e-6

    def channel(self, name: str) -> ReadChannel:
        (found,) = [c for c in self.channels if c.name == name]
        return found


def _lines(text: str) -> list[str]:
    """The lines of a file whose every line must end in CR LF."""
    assert text.isascii(), "the file holds a character outside ASCII"
    assert text.endswith("\r\n"), "the last line does not end in CR LF"
    lines = text[:-2].split("\r\n")
    for line in lines:
        assert "\r" not in line and "\n" not in line, f"a bare line break in {line!r}"
    return lines


def _date(text: str) -> datetime:
    # dd/mm/yyyy,hh:mm:ss.ssssss
    assert len(text) == 26, text
    return datetime.strptime(text, "%d/%m/%Y,%H:%M:%S.%f")


def read_comtrade(cfg: str, dat: str) -> ReadRecord:
    lines = _lines(cfg)

    station, device, rev_year = lines[0].split(",")
    assert len(station) <= 64 and len(device) <= 64

    total, analog, status = lines[1].split(",")
    assert analog.endswith("A") and status.endswith("D")
    n_analog, n_status = int(analog[:-1]), int(status[:-1])
    assert int(total) == n_analog + n_status
    assert 1 <= int(total) <= 999999
    assert n_status == 0, "the reader takes analog channels only"

    rows = [line.split(",") for line in lines[2 : 2 + n_analog]]
    rest = lines[2 + n_analog :]
    frequency = float(rest[0])
    nrates = int(rest[1])
    rate_lines = rest[2 : 2 + max(nrates, 1)]
    rates = [(float(samp), int(end)) for samp, end in (line.split(",") for line in rate_lines)]
    first, trigger, file_type, timemult = rest[2 + len(rate_lines) :]
    assert file_type == "ASCII"
    samples = rates[-1][1]

    # The data file: one line per sample, then the end-of-file mark.
    assert dat.endswith("\r\n\x1a"), "the data file does not end with CR LF and hex 1A"
    data = [line.split(",") for line in _lines(dat[:-1])]
    assert len(data) == samples, f"{len(data)} data lines for {samples} samples"
    for index, fields in enumerate(data):
        assert len(fields) == 2 + n_analog, f"line {index + 1} has {len(fields)} fields"
        assert int(fields[0]) == index + 1, "sample numbers do not count up from 1"
        assert 1 <= len(fields[0]) <= 10 and 1 <= len(fields[1]) <= 10
        for value in fields[2:]:
            assert 1 <= len(value) <= 6 and -99999 <= int(value) <= 99999, value
    stored = np.array([[int(v) for v in fields[2:]] for fields in data], dtype=np.int64)
    stamps = np.array([int(fields[1]) for fields in data], dtype=np.int64)
    assert stamps[0] == 0 and bool(np.all(np.diff(stamps) >= 0))

    channels: list[ReadChannel] = []
    for column, fields in enumerate(rows):
        assert len(fields) == 13, f"channel line {column + 1} has {len(fields)} fields"
        number, name, phase, component, unit, a, b, skew, low, high, primary, secondary, ps = fields
        assert int(number) == column + 1
        assert len(name) <= 64 and len(phase) <= 2 and len(component) <= 64
        assert 1 <= len(unit) <= 32
        assert 1 <= len(a) <= 32 and 1 <= len(b) <= 32
        assert -99999 <= int(low) <= int(high) <= 99999
        assert ps in {"P", "S"}
        channels.append(
            ReadChannel(
                number=int(number),
                name=name,
                phase=phase,
                component=component,
                unit=unit,
                a=float(a),
                b=float(b),
                skew=float(skew),
                minimum=int(low),
                maximum=int(high),
                primary=float(primary),
                secondary=float(secondary),
                scaling=ps,
                stored=stored[:, column],
            )
        )

    return ReadRecord(
        station=station,
        device=device,
        rev_year=rev_year,
        channels=channels,
        frequency=frequency,
        nrates=nrates,
        rates=rates,
        first=_date(first),
        trigger=_date(trigger),
        file_type=file_type,
        timemult=float(timemult),
        stamps=stamps,
    )


def read_comtrade_zip(archive: bytes) -> tuple[str, ReadRecord]:
    """``(name, record)`` of a ``.zip`` that holds ``<name>.cfg`` and ``<name>.dat``."""
    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        names = zf.namelist()
        assert len(names) == 2, names
        (cfg_name,) = [n for n in names if n.endswith(".cfg")]
        (dat_name,) = [n for n in names if n.endswith(".dat")]
        assert cfg_name[:-4] == dat_name[:-4], "the two files do not share a name"
        cfg = zf.read(cfg_name).decode("ascii")
        dat = zf.read(dat_name).decode("ascii")
    return cfg_name[:-4], read_comtrade(cfg, dat)
