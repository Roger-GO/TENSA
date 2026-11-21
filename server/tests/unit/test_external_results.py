"""Unit tests for ``tensa.core.external_results.excel_to_series``.

The workbooks are built in memory with ``openpyxl``, laid out as ANDES reads an
export: a header row, then the rows ``andes.utils.tsat`` skips after it (6 for
TSAT, 1 for PSS/E), then time and the signals. Where a test compares with ANDES,
it reads the same bytes with ANDES's own ``tsat_to_df`` / ``psse_to_df``.
"""

from __future__ import annotations

import datetime as dt
import io
import math
import re
import subprocess
import sys
import time
import zipfile
from typing import Any

import pandas as pd
import pytest
from openpyxl import Workbook

from tensa.core import external_results
from tensa.core.external_results import (
    ExternalResultsError,
    ExternalResultsTooLargeError,
    excel_to_series,
)

pytestmark = pytest.mark.unit

TSAT_SKIPPED = 6
PSSE_SKIPPED = 1


def _book(rows: list[list[Any]], *, extra_sheet: list[list[Any]] | None = None) -> bytes:
    """The bytes of a workbook whose first sheet holds ``rows`` from row 1."""
    book = Workbook()
    sheet = book.active
    for row in rows:
        sheet.append(row)
    if extra_sheet is not None:
        other = book.create_sheet("other")
        for row in extra_sheet:
            other.append(row)
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def _export(data: list[list[Any]], skipped: int) -> bytes:
    """An export as ANDES reads one: a header row, ``skipped`` rows of text, data."""
    width = max(len(row) for row in data)
    header = ["Export", *([None] * (width - 1))]
    meta = [[f"meta {i}", *(f"channel {j}" for j in range(1, width))] for i in range(skipped)]
    return _book([header, *meta, *data])


def _tsat(data: list[list[Any]]) -> bytes:
    return _export(data, TSAT_SKIPPED)


def _psse(data: list[list[Any]]) -> bytes:
    return _export(data, PSSE_SKIPPED)


def _rezip(data: bytes, change: Any) -> bytes:
    """The archive with ``change(name, content)`` applied to each member."""
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as src, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            dst.writestr(info.filename, change(info.filename, src.read(info.filename)))
    return out.getvalue()


# ---- what is read -----------------------------------------------------------


def test_a_tsat_export_gives_time_and_one_series_per_remaining_column() -> None:
    names, columns, time_ = excel_to_series(
        _tsat([[0.0, 1.0, 10.0], [0.1, 0.9, 11.0], [0.2, 0.8, 12.0]]), source="tsat"
    )
    assert names == ["column 1", "column 2"]
    assert time_ == [0.0, 0.1, 0.2]
    assert columns == [[1.0, 0.9, 0.8], [10.0, 11.0, 12.0]]


def test_a_psse_export_uses_its_own_offset() -> None:
    names, columns, time_ = excel_to_series(_psse([[1.0, 60.0], [1.1, 59.9]]), source="psse")
    assert names == ["column 1"]
    assert time_ == [1.0, 1.1]
    assert columns == [[60.0, 59.9]]


@pytest.mark.parametrize(("source", "first_data_row"), [("tsat", 8), ("psse", 3)])
def test_the_data_starts_where_andes_starts_it(source: str, first_data_row: int) -> None:
    # Every row of the sheet holds its own row number as time, so the first
    # time returned is the sheet row the data starts on: the header row plus
    # the offset rows after it are skipped, no more and no fewer.
    rows = [[float(r), float(10 * r)] for r in range(1, 21)]
    _names, columns, time_ = excel_to_series(_book(rows), source=source)  # type: ignore[arg-type]
    assert time_[0] == float(first_data_row)
    assert columns[0][0] == float(10 * first_data_row)
    assert time_[-1] == 20.0


def test_the_wrong_source_shifts_the_data_by_the_offset_difference() -> None:
    # A TSAT export read as PSS/E starts five rows early, among the text rows
    # whose time is no number, and those rows are dropped; with numbers there
    # the first time is the one five rows above the TSAT data.
    rows = [["header", None], *[[100.0 * i, 1.0] for i in range(1, 7)], [700.0, 2.0]]
    assert excel_to_series(_book(rows), source="tsat")[2] == [700.0]
    assert excel_to_series(_book(rows), source="psse")[2][0] == 200.0


def test_a_cell_that_is_not_a_finite_number_is_none_and_a_time_that_is_not_one_drops_the_row() -> None:
    names, columns, time_ = excel_to_series(
        _tsat(
            [
                [0.0, 1.0, True],
                [0.1, "bad", dt.datetime(2020, 1, 1)],
                ["text", 9.0, 9.0],
                [0.3, "inf", "2.5"],
                [dt.datetime(2020, 1, 1), 9.0, 9.0],
                ["inf", 9.0, 9.0],
                [0.6, None, "#N/A"],
                [0.7, "-1e400", False],
            ]
        ),
        source="tsat",
    )
    assert names == ["column 1", "column 2"]
    assert time_ == [0.0, 0.1, 0.3, 0.6, 0.7]
    # TRUE / FALSE are 1 / 0 and a text that spells a number is that number, as
    # pandas.to_numeric reads them; the rest is None, never NaN or infinity.
    assert columns == [[1.0, None, None, None, None], [1.0, None, 2.5, None, 0.0]]


def test_trailing_empty_columns_are_dropped_and_inner_ones_kept() -> None:
    names, columns, _time = excel_to_series(
        _tsat([[0.0, None, 1.0, None, None], [0.1, None, 0.9, "pad", None]]), source="tsat"
    )
    assert names == ["column 1", "column 2"]
    assert columns == [[None, None], [1.0, 0.9]]


def test_only_the_first_sheet_is_read() -> None:
    book = _book(
        [["h", None], *[["m", "c"]] * TSAT_SKIPPED, [0.0, 1.0]],
        extra_sheet=[["h", None], *[["m", "c"]] * TSAT_SKIPPED, [5.0, 5.0], [6.0, 6.0]],
    )
    assert excel_to_series(book, source="tsat") == (["column 1"], [[1.0]], [0.0])


def test_times_come_back_in_the_order_the_export_gives_them() -> None:
    _names, _columns, time_ = excel_to_series(
        _tsat([[0.2, 1.0], [0.1, 2.0], [0.1, 3.0]]), source="tsat"
    )
    assert time_ == [0.2, 0.1, 0.1]


def test_a_binary_stream_is_read_like_bytes() -> None:
    data = _tsat([[0.0, 1.0], [0.1, 2.0]])
    assert excel_to_series(io.BytesIO(data), source="tsat") == excel_to_series(data, source="tsat")


# ---- the same numbers as ANDES ----------------------------------------------


def _as_andes_reads(df: pd.DataFrame) -> tuple[list[float], list[list[float | None]]]:
    """What ``excel_to_series`` should answer for a frame ANDES's reader made."""

    def finite(v: Any) -> float | None:
        return None if pd.isna(v) or not math.isfinite(float(v)) else float(v)

    numeric = [[finite(v) for v in pd.to_numeric(df[c], errors="coerce")] for c in df.columns]
    keep = [i for i, t in enumerate(numeric[0]) if t is not None]
    columns = [[col[i] for i in keep] for col in numeric[1:]]
    while columns and all(v is None for v in columns[-1]):
        columns.pop()
    return [numeric[0][i] for i in keep], columns  # type: ignore[misc]


@pytest.mark.parametrize("source", ["tsat", "psse"])
def test_every_value_is_the_one_andes_reads(source: str) -> None:
    from andes.utils.tsat import psse_to_df, tsat_to_df

    rows: list[list[Any]] = [["Title", None, None, None]]
    rows += [[f"m{i}", "Bus 1 V", "Gen 2 speed", None] for i in range(8)]
    rows += [[None, None, None, None]]  # a blank row, which pandas skips
    rows += [[0.01 * k, 1.0 - 0.001 * k, 60 + math.sin(k / 3), None] for k in range(40)]
    rows += [[0.5, "n/a", 7, None], ["end", 1.0, 2.0, None], [0.6, True, "3.25", None]]
    data = _book(rows)

    reader = tsat_to_df if source == "tsat" else psse_to_df
    expected_time, expected_columns = _as_andes_reads(reader(io.BytesIO(data)))
    names, columns, time_ = excel_to_series(data, source=source)  # type: ignore[arg-type]
    assert time_ == expected_time
    assert columns == expected_columns
    assert names == [f"column {i + 1}" for i in range(len(expected_columns))]
    assert len(time_) > 30


# ---- what is refused ---------------------------------------------------------


def test_a_sheet_with_nothing_after_the_offset_raises() -> None:
    with pytest.raises(ExternalResultsError, match="no samples after the tsat offset"):
        excel_to_series(_book([["h", "h"], *[["m", "m"]] * TSAT_SKIPPED]), source="tsat")


def test_an_empty_sheet_raises() -> None:
    with pytest.raises(ExternalResultsError, match="no samples"):
        excel_to_series(_book([]), source="tsat")


def test_a_sheet_with_time_but_no_signal_columns_raises() -> None:
    with pytest.raises(ExternalResultsError, match="no signal columns after the tsat offset"):
        excel_to_series(_tsat([[0.0], [0.1]]), source="tsat")


def test_a_sheet_whose_signals_hold_no_number_raises() -> None:
    with pytest.raises(ExternalResultsError, match="no signal columns"):
        excel_to_series(_tsat([[0.0, "a"], [0.1, "b"]]), source="tsat")


def test_a_sheet_whose_times_hold_no_number_raises() -> None:
    with pytest.raises(ExternalResultsError, match="no samples"):
        excel_to_series(_tsat([["a", 1.0], ["b", 2.0]]), source="tsat")


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"this is not a workbook",
        b"time,v\n0,1\n",
        # The signature of an .xls (an OLE2 compound file).
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 512,
        b"PK\x03\x04 but not a zip archive",
    ],
)
def test_bytes_that_are_not_an_xlsx_workbook_raise(data: bytes) -> None:
    with pytest.raises(ExternalResultsError) as caught:
        excel_to_series(data, source="tsat")
    assert not isinstance(caught.value, ExternalResultsTooLargeError)


def test_a_zip_that_is_not_an_xlsx_workbook_raises() -> None:
    # An .ods is a zip archive too; it is told apart by what it holds.
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("mimetype", "application/vnd.oasis.opendocument.spreadsheet")
        archive.writestr("content.xml", "<office:document-content/>")
    with pytest.raises(ExternalResultsError, match="not an .xlsx workbook"):
        excel_to_series(out.getvalue(), source="tsat")


def test_an_error_names_no_path() -> None:
    with pytest.raises(ExternalResultsError) as caught:
        excel_to_series(_rezip(_tsat([[0.0, 1.0]]), lambda n, c: b"<broken" if n == "xl/workbook.xml" else c), source="tsat")
    text = str(caught.value)
    assert "\\" not in text and "/" not in text.replace(".xlsx", "")


# ---- the bounds ----------------------------------------------------------------


def test_the_reader_is_pinned_to_openpyxl(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []
    read_excel = pd.read_excel

    def spy(*args: Any, **kwargs: Any) -> Any:
        seen.append(kwargs)
        return read_excel(*args, **kwargs)

    monkeypatch.setattr(pd, "read_excel", spy)
    excel_to_series(_tsat([[0.0, 1.0]]), source="tsat")
    assert [k.get("engine") for k in seen] == ["openpyxl"]


def test_an_archive_that_unpacks_past_the_cap_is_refused_before_it_is_unpacked() -> None:
    # A valid export with one more member: zeros that compress about a
    # thousandfold, past the cap once unpacked.
    zeros = b"\0" * (external_results.MAX_UNPACKED_BYTES + 1)
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(_tsat([[0.0, 1.0]]))) as src, zipfile.ZipFile(
        out, "w", zipfile.ZIP_DEFLATED
    ) as dst:
        for info in src.infolist():
            dst.writestr(info.filename, src.read(info.filename))
        dst.writestr("xl/media/bomb.bin", zeros)
    del zeros
    data = out.getvalue()
    assert len(data) < 1024 * 1024
    with pytest.raises(ExternalResultsTooLargeError, match="unpacks to 128 MiB"):
        excel_to_series(data, source="tsat")


def _declare_size(data: bytes, member: str, size: int) -> bytes:
    """``data`` with the unpacked size of ``member`` declared as ``size``, in its
    local header and in the central directory, and nothing else changed."""
    raw = bytearray(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.getinfo(member)
    name = member.encode()
    # The local header: the size sits 22 bytes into it.
    raw[info.header_offset + 22 : info.header_offset + 26] = size.to_bytes(4, "little")
    # The central directory entry: 24 bytes into it, found by its name.
    at = raw.rfind(name)
    entry = at - 46
    assert raw[entry : entry + 4] == b"PK\x01\x02"
    raw[entry + 24 : entry + 28] = size.to_bytes(4, "little")
    return bytes(raw)


def test_a_member_that_declares_a_huge_size_is_refused() -> None:
    data = _declare_size(_tsat([[0.0, 1.0]]), "xl/worksheets/sheet1.xml", 2**31)
    with pytest.raises(ExternalResultsTooLargeError, match="unpacks to"):
        excel_to_series(data, source="tsat")


def test_a_member_that_unpacks_past_its_declared_size_is_not_read_past_it() -> None:
    # The sheet declares 100 bytes and holds more: zipfile stops at the
    # declared size and fails the checksum, so the workbook is refused as
    # unreadable instead of being unpacked further.
    data = _declare_size(_tsat([[0.0, 1.0]] * 50), "xl/worksheets/sheet1.xml", 100)
    with pytest.raises(ExternalResultsError) as caught:
        excel_to_series(data, source="tsat")
    assert not isinstance(caught.value, ExternalResultsTooLargeError)


def test_more_rows_than_the_cap_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(external_results, "MAX_ROWS", 5)
    within = excel_to_series(_tsat([[float(i), 1.0] for i in range(5)]), source="tsat")
    assert len(within[2]) == 5
    with pytest.raises(ExternalResultsTooLargeError, match="more than 5 rows"):
        excel_to_series(_tsat([[float(i), 1.0] for i in range(6)]), source="tsat")


def test_more_columns_than_the_cap_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(external_results, "MAX_COLUMNS", 4)
    assert len(excel_to_series(_tsat([[0.0, 1.0, 2.0, 3.0]]), source="tsat")[0]) == 3
    with pytest.raises(ExternalResultsTooLargeError, match="5 columns wide"):
        excel_to_series(_tsat([[0.0, 1.0, 2.0, 3.0, 4.0]]), source="tsat")


def test_more_cells_than_the_cap_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    # Rows times the widest row: one wide row makes every row that wide.
    monkeypatch.setattr(external_results, "MAX_CELLS", 40)
    rows = [[float(i), 1.0] for i in range(10)]
    assert len(excel_to_series(_tsat(rows), source="tsat")[2]) == 10  # 17 rows x 2
    rows[0] = [0.0, 1.0, 2.0, 3.0]
    with pytest.raises(ExternalResultsTooLargeError, match="more than 40 cells"):
        excel_to_series(_tsat(rows), source="tsat")


def test_a_single_cell_far_out_is_refused_quickly() -> None:
    # A few bytes on disk that the reader would make 16 384 columns wide, or a
    # million rows long: refused at the first row past a bound.
    for coordinate in ("XFD8", "B1048576"):
        book = Workbook()
        sheet = book.active
        sheet.append(["h", None])
        sheet[coordinate] = 1.0
        buffer = io.BytesIO()
        book.save(buffer)
        started = time.perf_counter()
        with pytest.raises(ExternalResultsTooLargeError):
            excel_to_series(buffer.getvalue(), source="tsat")
        assert time.perf_counter() - started < 10


def test_a_declared_extent_that_lies_is_not_believed() -> None:
    data = _rezip(
        _tsat([[0.0, 1.0], [0.1, 2.0]]),
        lambda n, c: (
            re.sub(rb'<dimension ref="[^"]*" ?/>', b'<dimension ref="A1:XFD1048576"/>', c)
            if n == "xl/worksheets/sheet1.xml"
            else c
        ),
    )
    assert b"A1:XFD1048576" in zipfile.ZipFile(io.BytesIO(data)).read("xl/worksheets/sheet1.xml")
    assert excel_to_series(data, source="tsat") == (["column 1"], [[1.0, 2.0]], [0.0, 0.1])


# ---- what the server process imports -------------------------------------------


def test_reading_an_export_imports_neither_andes_nor_anything_at_import_time(tmp_path: Any) -> None:
    """The server process never imports ANDES for this, and pays for pandas and
    openpyxl only when an export is read."""
    path = tmp_path / "export.xlsx"
    path.write_bytes(_tsat([[0.0, 1.0], [0.1, 2.0]]))
    code = (
        "import sys\n"
        "import tensa.api.app\n"
        "from tensa.core.external_results import excel_to_series\n"
        "before = sorted(m for m in ('pandas', 'openpyxl', 'andes') if m in sys.modules)\n"
        "out = excel_to_series(open(sys.argv[1], 'rb').read(), source='tsat')\n"
        "assert out[2] == [0.0, 0.1], out\n"
        "after = sorted(m for m in ('pandas', 'openpyxl', 'andes') if m in sys.modules)\n"
        "print(before, after)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code, str(path)], capture_output=True, text=True, timeout=300
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[] ['openpyxl', 'pandas']"
