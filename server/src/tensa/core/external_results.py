"""External results import: a TSAT or PSS/E Excel export as overlay series.

:func:`excel_to_series` reads the bytes of an ``.xlsx`` workbook that TSAT or
PSS/E exported for a time-domain run and answers with the time column and one
series per signal column, in the shape ``POST /response-metrics`` takes, so a
client can overlay an external result on a TENSA run's traces. No session is
involved: the file is all the input there is.

What is read, as ``andes.utils.tsat.excel_to_df`` reads it. ANDES calls
``pandas.read_excel(file)``, which takes the first sheet and the first non-blank
row of it as a header row, and then drops ``offset_row`` more rows of the frame:
6 for TSAT (``tsat_to_df``), 1 for PSS/E (``psse_to_df``), ``offset_col`` 0 for
both. So a TSAT export's data starts on the eighth row of the sheet and a PSS/E
export's on the third, blank rows not counted (pandas skips them). This module
reads the same way and gives the same numbers; the unit tests hold it to ANDES's
own functions on the same workbooks. ``andes.utils.tsat`` is not imported:
importing it imports ``andes`` and reconfigures logging, which the server process
must not do. Only the first sheet is read, as ANDES reads it; a workbook's other
sheets are ignored.

The first column after the offset is time; the others are the signals, in the
order the export wrote them. The exports carry no signal names ANDES reads (its
own ``plot_comparison`` takes them separately as ``tsat_header`` /
``psse_header``), so the series are named by position, ``column 1``,
``column 2``, ..., and the caller labels them.

Values. A cell is read as a number the way ``pandas.to_numeric`` reads it: a
numeric cell is its number, a text cell that spells a number is that number, a
``TRUE`` / ``FALSE`` cell is 1 / 0. Anything else (text, a date or a time, an
empty cell, an Excel error such as ``#N/A``) is not a number, and neither is a
value that is not finite (a text ``inf``), since JSON has no such numbers. In a
signal column such a value is ``None`` (the convention ``MetricsSeries`` uses for
a missing sample); in the time column it drops the row. Trailing signal columns
that hold no number at all (an export's padding) are dropped. Times are returned
in the order the export gives them, not sorted and not checked: an overlay plots
what it is given, and ``POST /response-metrics`` collapses a repeated time and
refuses one that runs backwards with its own error.

Bounds. The file comes from outside and is parsed in the server process, so it
is bounded before the reader sees it and while it reads. An ``.xlsx`` is a zip
archive of XML, and a small file can unpack to gigabytes, or declare a sheet of a
million rows by sixteen thousand columns in a few bytes:

- Only ``.xlsx`` (and ``.xlsm``, whose macros are never run or kept) is read, and
  it is told by its content, not its name: a zip archive with an
  ``xl/workbook.xml``. ``.xls``, ``.xlsb``, ``.ods`` and text are refused, and the
  reader is pinned to ``openpyxl`` (read-only, cached values only, external links
  not followed), so pandas never picks another engine for what it sniffs.
- ``MAX_ARCHIVE_MEMBERS`` (1 000) members, and ``MAX_UNPACKED_BYTES`` (128 MiB)
  unpacked in all, as the archive's central directory declares them, checked
  before anything is unpacked. A workbook of ``MAX_CELLS`` numbers is about
  45 MiB of sheet XML. Python's ``zipfile``, which ``openpyxl`` reads through,
  never unpacks a member past its declared size (it stops there and fails the
  member's checksum), so a declaration that lies ends in a refusal, not in more
  data.
- At most ``MAX_ROWS`` (200 000) rows after the header and the offset, the most
  samples ``POST /response-metrics`` takes in one series; ``MAX_COLUMNS`` (1 024)
  columns; and ``MAX_CELLS`` (1 000 000) cells, counted as rows times the widest
  row, since that is the table pandas builds (it pads every row to the widest). A
  million cells is the most samples ``POST /response-metrics`` takes in one
  request; a sheet of that size (an 11 MiB file) takes about 25 seconds and
  150 MiB to read on a busy development machine, in a thread. The sheet is
  walked once with these bounds before pandas reads it, because the extent a
  sheet declares can lie and a row with one cell in column ``XFD`` is 16 384
  cells wide to the reader; the walk stops at the first row past a bound, empty
  rows included.

Errors carry no path: the workbook is read from memory, and a reader's failure
is named by its kind only.
"""

from __future__ import annotations

import io
import math
import zipfile
from typing import TYPE_CHECKING, Any, BinaryIO, Literal

if TYPE_CHECKING:
    import pandas as pd  # type: ignore[import-untyped]  # pandas ships no stubs

__all__ = [
    "MAX_ARCHIVE_MEMBERS",
    "MAX_CELLS",
    "MAX_COLUMNS",
    "MAX_ROWS",
    "MAX_UNPACKED_BYTES",
    "OFFSET_ROWS",
    "ExternalResultsError",
    "ExternalResultsTooLargeError",
    "excel_to_series",
]

MAX_ARCHIVE_MEMBERS = 1_000
MAX_UNPACKED_BYTES = 128 * 1024 * 1024
MAX_ROWS = 200_000
MAX_COLUMNS = 1_024
MAX_CELLS = 1_000_000

# The rows ANDES drops after the header row, as ``andes.utils.tsat`` has them.
OFFSET_ROWS: dict[str, int] = {"tsat": 6, "psse": 1}

_NOT_READABLE = "the file is not an Excel workbook ANDES can read"


class ExternalResultsError(ValueError):
    """The file cannot be read as an Excel export, or it holds no usable series."""


class ExternalResultsTooLargeError(ExternalResultsError):
    """The workbook is past one of the bounds this module reads within."""


def _check_archive(data: bytes) -> None:
    """Refuse what is not an ``.xlsx`` archive, or unpacks past the caps."""
    if not data:
        raise ExternalResultsError("the file is empty")
    if not data.startswith(b"PK"):
        raise ExternalResultsError(
            f"{_NOT_READABLE}: it is not an .xlsx workbook "
            "(an .xls, .xlsb, .ods or text file is not read)"
        )
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
    except (zipfile.BadZipFile, ValueError, OSError) as exc:
        raise ExternalResultsError(
            f"{_NOT_READABLE}: its zip archive cannot be read ({type(exc).__name__})"
        ) from exc
    if len(members) > MAX_ARCHIVE_MEMBERS:
        raise ExternalResultsTooLargeError(
            f"the workbook's archive holds {len(members)} files; an import reads at "
            f"most {MAX_ARCHIVE_MEMBERS}"
        )
    unpacked = sum(member.file_size for member in members)
    if unpacked > MAX_UNPACKED_BYTES:
        raise ExternalResultsTooLargeError(
            f"the workbook unpacks to {unpacked // (1024 * 1024)} MiB; an import reads "
            f"at most {MAX_UNPACKED_BYTES // (1024 * 1024)} MiB"
        )
    if "xl/workbook.xml" not in {member.filename for member in members}:
        raise ExternalResultsError(
            f"{_NOT_READABLE}: it is not an .xlsx workbook "
            "(an .xlsb or .ods archive is not read)"
        )


def _check_extent(data: bytes, offset_row: int) -> None:
    """Walk the first sheet and refuse it at the first row past a bound."""
    from openpyxl import load_workbook

    try:
        book = load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
    except Exception as exc:
        raise ExternalResultsError(f"{_NOT_READABLE} ({type(exc).__name__})") from exc
    try:
        if not book.worksheets:
            raise ExternalResultsError("the workbook holds no worksheet")
        sheet = book.worksheets[0]
        # The extent a sheet declares can lie; this makes the reader go by the cells.
        sheet.reset_dimensions()
        most_rows = 1 + offset_row + MAX_ROWS
        widest = 0
        for rows, row in enumerate(sheet.iter_rows(values_only=True), start=1):
            widest = max(widest, len(row))
            if rows > most_rows:
                raise ExternalResultsTooLargeError(
                    f"the sheet holds more than {MAX_ROWS} rows after the header and "
                    f"the {offset_row}-row offset; an import reads at most {MAX_ROWS}"
                )
            if widest > MAX_COLUMNS:
                raise ExternalResultsTooLargeError(
                    f"the sheet is {widest} columns wide; an import reads at most {MAX_COLUMNS}"
                )
            if rows * widest > MAX_CELLS:
                raise ExternalResultsTooLargeError(
                    f"the sheet holds more than {MAX_CELLS} cells (rows times the widest "
                    "row); an import reads at most that"
                )
    except ExternalResultsError:
        raise
    except Exception as exc:
        raise ExternalResultsError(f"{_NOT_READABLE} ({type(exc).__name__})") from exc
    finally:
        book.close()


def _numbers(column: pd.Series) -> list[float | None]:
    """The column as finite floats, ``None`` where a cell is not one."""
    import pandas as pd

    values: list[float | None] = []
    for value in pd.to_numeric(column, errors="coerce"):
        number = None if pd.isna(value) else float(value)
        values.append(number if number is not None and math.isfinite(number) else None)
    return values


def excel_to_series(
    file: BinaryIO | bytes, *, source: Literal["tsat", "psse"]
) -> tuple[list[str], list[list[float | None]], list[float]]:
    """Read a TSAT or PSS/E Excel export into ``(names, columns, time)``.

    ``file`` is the export's bytes (or a binary stream of them), ``source`` the
    tool whose layout it was written in. Returns the series names (``column 1``,
    ``column 2``, ...), one list of values per series, each the length of
    ``time``, and the time samples as floats. Raises
    :class:`ExternalResultsTooLargeError` for a workbook past a bound, and
    :class:`ExternalResultsError` for one that is not an ``.xlsx`` workbook or
    holds nothing usable after the source's offset. Blocking and CPU-bound: a
    caller on an event loop runs it in a thread.
    """
    offset_row = OFFSET_ROWS[source]
    data = file if isinstance(file, bytes) else file.read()
    _check_archive(data)
    _check_extent(data, offset_row)

    import pandas as pd

    try:
        book: Any = pd.read_excel(io.BytesIO(data), engine="openpyxl", sheet_name=0)
    except Exception as exc:
        raise ExternalResultsError(f"{_NOT_READABLE} ({type(exc).__name__})") from exc

    # As andes.utils.tsat.excel_to_df: drop the offset rows after the header,
    # then the first column is time and the rest are the signals.
    df = book.iloc[offset_row:, 0:]
    if df.shape[0] == 0:
        raise ExternalResultsError(
            f"the workbook holds no samples after the {source} offset (row {offset_row})"
        )
    if df.shape[1] < 2:
        raise ExternalResultsError(
            f"the workbook holds no signal columns after the {source} offset (row {offset_row})"
        )

    times = _numbers(df.iloc[:, 0])
    signals = [_numbers(df.iloc[:, position]) for position in range(1, df.shape[1])]
    # A time that is not a number drops its row, signals included.
    keep = [i for i, t in enumerate(times) if t is not None]
    if not keep:
        raise ExternalResultsError(
            f"the workbook holds no samples after the {source} offset (row {offset_row})"
        )
    time = [t for t in times if t is not None]
    columns = [[signal[i] for i in keep] for signal in signals]
    # An export pads its sheet with empty columns on the right; drop the
    # trailing ones that hold not one number.
    while columns and all(v is None for v in columns[-1]):
        columns.pop()
    if not columns:
        raise ExternalResultsError(
            f"the workbook holds no signal columns after the {source} offset (row {offset_row})"
        )
    names = [f"column {i + 1}" for i in range(len(columns))]
    return names, columns, time
