"""Report generation for ANDES routines (Unit 4 of the v2.0 plan).

Wraps :meth:`andes.routines.pflow.PFlow.report` and
:meth:`andes.routines.tds.TDS.summary` so the substrate can ship a
structured report payload to the UI:

- ``plain_text``: the verbatim string ANDES would have written to disk
  (PFlow) or logged (TDS).
- ``structured.tables``: best-effort parse of the plain text into a
  list of ``ReportTable`` blocks the frontend can render as HTML
  tables and copy to LaTeX.

The PFlow report writer (:class:`andes.variables.report.Report`) writes
to ``system.files.txt``. We capture that output by:

1. Saving the current ``system.files`` settings.
2. Pointing ``system.files.txt`` at a tempfile + flipping
   ``system.files.no_output = False``.
3. Calling ``ss.PFlow.report()``.
4. Reading the tempfile back and restoring the original settings.

TDS.summary() writes only to a logger; we capture by attaching a
``logging.Handler`` to the ``andes.routines.tds`` logger for the
duration of the call.

EIG report variant lands in Unit 6; the routines literal here will
widen to ``"eig"`` then.
"""

from __future__ import annotations

import dataclasses
import logging
import re
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Literal

from andes_app.core.errors import AndesAppError, NoCaseLoadedError

# Public Routine type — Phase 1 (Unit 4) shipped ``pflow`` + ``tds``;
# Unit 6 widens to include ``eig`` (the EIG report variant). Routes
# layer enforces this with a 422 for unknown routines so an early-call
# client gets a polite rejection.
ReportRoutine = Literal["pflow", "tds", "eig"]

# Maximum characters of plain text we'll buffer in memory. ANDES reports
# for typical academic cases (IEEE 14, 39, kundur) are <50 KB; this cap
# is a defense against pathological output (e.g., a 10000-bus case).
MAX_PLAIN_TEXT_BYTES = 4 * 1024 * 1024  # 4 MiB


@dataclasses.dataclass(frozen=True)
class ReportTable:
    """A single tabular block parsed out of a routine's plain-text report.

    The frontend's LatexCopyButton serialises each ReportTable as a
    ``\\begin{tabular}{...}`` block. ``rows`` is a list of row lists —
    each row's length matches ``headers``.
    """

    title: str
    headers: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]


@dataclasses.dataclass(frozen=True)
class ReportPayload:
    """Wrapper-side shape for a routine's report.

    The worker serialises this through :func:`_serialize_dataclass`
    before crossing the Pipe; the routes layer rebuilds the response
    body from the dict shape.
    """

    routine: str
    plain_text: str
    tables: tuple[ReportTable, ...]


# ---- public entry points ---------------------------------------------------


def generate_report(ss, routine: ReportRoutine) -> ReportPayload:  # type: ignore[no-untyped-def]
    """Run the requested report and return the captured plain text +
    structured tables.

    ``ss`` is an ``andes.System`` post-load (and post-PF for ``pflow``,
    post-TDS for ``tds``). The caller is responsible for the routine
    pre-conditions; this function raises :class:`AndesAppError` with
    the categories the routes layer maps to 4xx if the pre-conditions
    aren't met.
    """
    if ss is None:
        raise NoCaseLoadedError(
            "no case has been loaded — load a case before requesting a report"
        )

    if routine == "pflow":
        return _generate_pflow_report(ss)
    if routine == "tds":
        return _generate_tds_report(ss)
    if routine == "eig":
        return _generate_eig_report(ss)
    # The routes layer constrains the literal upstream; this is
    # belt-and-braces.
    raise AndesAppError(f"unknown report routine: {routine!r}")


# ---- per-routine implementations -------------------------------------------


def _generate_pflow_report(ss) -> ReportPayload:  # type: ignore[no-untyped-def]
    """Capture ``ss.PFlow.report()``'s on-disk output into memory.

    Pre-condition: ``ss.PFlow.converged`` must be True. The Report
    writer falls back to a "summary only" body when PF has not
    converged; we surface the stricter contract at the wrapper boundary
    so the UI can show a clean "Run PFlow first" message instead of a
    confusing partial table.
    """
    if not bool(getattr(ss.PFlow, "converged", False)):
        raise PflowNotConvergedError(
            "no converged power-flow result on this session — run PFlow first"
        )

    files = ss.files
    saved_no_output = files.no_output
    saved_txt = files.txt
    with tempfile.TemporaryDirectory(prefix="andes-report-") as td:
        target = Path(td) / "report.txt"
        files.no_output = False
        files.txt = str(target)
        try:
            try:
                ss.PFlow.report()
            except Exception as exc:  # noqa: BLE001 — surface any ANDES failure
                raise ReportGenerationError(
                    f"PFlow.report() raised: {exc}"
                ) from exc
            try:
                raw = target.read_bytes()
            except FileNotFoundError as exc:
                raise ReportGenerationError(
                    "PFlow.report() did not write the expected report file"
                ) from exc
        finally:
            files.no_output = saved_no_output
            files.txt = saved_txt

    if len(raw) > MAX_PLAIN_TEXT_BYTES:
        raise ReportGenerationError(
            f"PFlow report exceeded {MAX_PLAIN_TEXT_BYTES} bytes; refusing to ship"
        )
    plain_text = raw.decode("utf-8", errors="replace")
    tables = parse_pflow_tables(plain_text)
    return ReportPayload(
        routine="pflow",
        plain_text=plain_text,
        tables=tuple(tables),
    )


def _generate_tds_report(ss) -> ReportPayload:  # type: ignore[no-untyped-def]
    """Capture ``ss.TDS.summary()``'s logger output.

    Pre-condition: a TDS run must have completed (``ss.TDS.initialized``
    is True AND ``ss.dae.t > 0``). The summary itself succeeds on a
    fresh System — it just prints config defaults — but the resulting
    "report" would mislead the user. We gate on actual run state.
    """
    if not bool(getattr(ss.TDS, "initialized", False)):
        raise TdsNotRunError(
            "no TDS run has completed on this session — run TDS first"
        )
    if float(getattr(ss.dae, "t", 0.0)) <= 0.0:
        raise TdsNotRunError(
            "TDS has been initialised but no integration steps have run — "
            "run TDS first"
        )

    captured: list[str] = []

    class _CaptureHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            try:
                captured.append(record.getMessage())
            except Exception:  # noqa: BLE001 — never let logging break us
                captured.append(str(record.msg))

    handler = _CaptureHandler(level=logging.INFO)
    handler.setFormatter(logging.Formatter("%(message)s"))
    target_logger = logging.getLogger("andes.routines.tds")
    saved_level = target_logger.level
    target_logger.addHandler(handler)
    if saved_level > logging.INFO or saved_level == 0:
        target_logger.setLevel(logging.INFO)
    try:
        try:
            ss.TDS.summary()
        except Exception as exc:  # noqa: BLE001
            raise ReportGenerationError(
                f"TDS.summary() raised: {exc}"
            ) from exc
    finally:
        target_logger.removeHandler(handler)
        target_logger.setLevel(saved_level)

    summary_text = "\n".join(captured).strip()
    # Augment with the post-run statistics ANDES would have logged
    # separately. Best-effort: missing attributes are skipped. This
    # turns the otherwise terse summary into something a paper author
    # can actually paste into a "simulation parameters" section.
    extra_lines: list[str] = []
    final_t = float(getattr(ss.dae, "t", 0.0))
    extra_lines.append(f"Final simulation time: {final_t:.4f} s")
    config = getattr(ss.TDS, "config", None)
    if config is not None:
        tf = float(getattr(config, "tf", 0.0))
        extra_lines.append(f"Configured tf: {tf:.4f} s")
        h = float(getattr(config, "tstep", 0.0))
        if h > 0.0:
            extra_lines.append(f"Configured step (tstep): {h:.6f} s")
        fixed = bool(getattr(config, "fixt", False))
        extra_lines.append(f"Fixed-step integration: {'yes' if fixed else 'no'}")
    plain_text = (summary_text + "\n\n" + "\n".join(extra_lines)).strip() + "\n"

    if len(plain_text.encode("utf-8")) > MAX_PLAIN_TEXT_BYTES:
        raise ReportGenerationError(
            f"TDS report exceeded {MAX_PLAIN_TEXT_BYTES} bytes; refusing to ship"
        )

    tables = parse_tds_tables(ss, plain_text)
    return ReportPayload(
        routine="tds",
        plain_text=plain_text,
        tables=tuple(tables),
    )


def _generate_eig_report(ss) -> ReportPayload:  # type: ignore[no-untyped-def]
    """Capture ``ss.EIG.report()`` output (Unit 6).

    Pre-condition: ``EIG.run()`` must have populated ``EIG.mu`` (i.e.,
    EIG has been run on this session). The check is on ``EIG.mu``
    rather than a boolean flag because ANDES does not advertise an
    ``EIG.initialized`` field — the routine just mutates ``As`` /
    ``mu`` / ``pfactors`` on success.

    Capture path mirrors the PFlow report but targets ``files.eig``
    (the ``.eig.txt``-style path EIG.report writes to via
    :func:`andes.io.txt.dump_data`). We re-target a tempfile, run the
    report, read the file back, restore the original setting.
    """
    mu = getattr(ss.EIG, "mu", None)
    if mu is None:
        raise EigReportPrerequisiteError(
            "no EIG result on this session — run EIG first"
        )

    files = ss.files
    saved_no_output = files.no_output
    # ANDES does not always populate ``files.eig`` pre-routine; we
    # capture whatever is there (``None`` when freshly loaded) so the
    # restore step always runs in the finally branch — never leak our
    # tempdir path back into the System.
    saved_eig = getattr(files, "eig", None)
    with tempfile.TemporaryDirectory(prefix="andes-report-eig-") as td:
        target = Path(td) / "report.eig.txt"
        files.no_output = False
        files.eig = str(target)
        try:
            try:
                ss.EIG.report()
            except Exception as exc:  # noqa: BLE001
                raise ReportGenerationError(
                    f"EIG.report() raised: {exc}"
                ) from exc
            try:
                raw = target.read_bytes()
            except FileNotFoundError as exc:
                raise ReportGenerationError(
                    "EIG.report() did not write the expected report file"
                ) from exc
        finally:
            files.no_output = saved_no_output
            files.eig = saved_eig

    if len(raw) > MAX_PLAIN_TEXT_BYTES:
        raise ReportGenerationError(
            f"EIG report exceeded {MAX_PLAIN_TEXT_BYTES} bytes; refusing to ship"
        )
    plain_text = raw.decode("utf-8", errors="replace")
    tables = parse_eig_tables(ss, plain_text)
    return ReportPayload(
        routine="eig",
        plain_text=plain_text,
        tables=tuple(tables),
    )


# ---- error taxonomy --------------------------------------------------------


class PflowNotConvergedError(AndesAppError):
    """Raised when a PFlow report is requested but PF has not converged.

    The routes layer maps this to HTTP 409 with the
    "Run PFlow first" message so the UI's empty state can render it
    verbatim without inventing copy.
    """


class TdsNotRunError(AndesAppError):
    """Raised when a TDS report is requested but no TDS run has completed.

    The routes layer maps this to HTTP 409 (analogous to the PFlow
    case) so the UI's empty state has a single error category to
    branch on.
    """


class ReportGenerationError(AndesAppError):
    """Raised when ANDES's report writer fails (file write error,
    captured exception, output exceeded the buffer cap).

    The routes layer maps this to HTTP 500 so the failure surfaces
    with the actual ANDES error preserved in the detail.
    """


class EigReportPrerequisiteError(AndesAppError):
    """Raised when an EIG report is requested but no EIG run has fired.

    The routes layer maps this to HTTP 409 alongside
    :class:`PflowNotConvergedError` and :class:`TdsNotRunError` so the
    UI's empty state can render a single recovery copy ("Run EIG
    first") verbatim.
    """


# ---- structured-table parsers (best-effort) --------------------------------


# Match a section header like "BUS DATA:" produced by Report.write().
# The trailing colon is load-bearing — it's the only signal that
# differentiates a section title from a data row in a fixed-width table.
_SECTION_HEADER_RE = re.compile(r"^([A-Z][A-Z _0-9]+):\s*$")


def parse_pflow_tables(plain_text: str) -> list[ReportTable]:
    """Best-effort parse of the PFlow report into structured tables.

    The ANDES Report writer uses :func:`andes.io.txt.dump_data` which
    produces fixed-width columns separated by 2+ spaces. We:

    1. Split the report on section-header lines (``BUS DATA:``,
       ``LINE DATA:``, ``EXTENDED SUMMARY:``, ``OTHER ALGEBRAIC
       VARIABLES:``, ``OTHER STATE VARIABLES:``).
    2. For each section, treat the first non-blank line as headers
       and subsequent non-blank lines as rows, splitting on runs of
       2+ spaces.
    3. Drop sections without a header row or without any data rows.

    Sections we don't recognise are skipped silently. The frontend
    falls back to the plain-text view when the structured list is
    empty (or for sections that didn't parse cleanly).
    """
    tables: list[ReportTable] = []
    lines = plain_text.splitlines()
    current_title: str | None = None
    current_block: list[str] = []

    def _flush() -> None:
        if current_title is None:
            return
        table = _block_to_table(current_title, current_block)
        if table is not None:
            tables.append(table)

    for raw_line in lines:
        line = raw_line.rstrip()
        m = _SECTION_HEADER_RE.match(line)
        if m is not None:
            _flush()
            current_title = m.group(1).strip()
            current_block = []
            continue
        if current_title is None:
            continue
        # The Report writer separates sections with a blank line; we
        # accumulate everything between two headers and let the block
        # parser strip leading/trailing blanks.
        current_block.append(line)
    _flush()
    return tables


def parse_eig_tables(ss, plain_text: str) -> list[ReportTable]:  # type: ignore[no-untyped-def]
    """Best-effort parse of the EIG report into structured tables.

    ``EIG.report()`` writes a fixed-width text file with section headers
    similar to the PFlow report (``EIGENVALUE ANALYSIS REPORT:``,
    ``PARTICIPATION FACTORS:``, etc.). We re-use the PFlow parser's
    section-split + ``_block_to_table`` logic — same structure, same
    quirks. When the parser can't recognise a section the frontend
    falls back to the verbatim plain-text view.
    """
    return parse_pflow_tables(plain_text)


def parse_tds_tables(ss, plain_text: str) -> list[ReportTable]:  # type: ignore[no-untyped-def]
    """Best-effort parse of the TDS summary into structured tables.

    ``TDS.summary()``'s plain text is a paragraph-style log message,
    not a table — but it's still useful to surface the configuration
    + per-run statistics as a key/value table so LatexCopyButton has
    something to paste. We additionally include a "Final state" table
    (one row per state variable name) when ``ss.dae.x_name`` is
    populated.
    """
    config_table = _tds_config_table(plain_text)
    out: list[ReportTable] = []
    if config_table is not None:
        out.append(config_table)
    state_table = _tds_state_table(ss)
    if state_table is not None:
        out.append(state_table)
    return out


# ---- table-parsing helpers -------------------------------------------------


def _block_to_table(title: str, block: Iterable[str]) -> ReportTable | None:
    """Parse a single section block into a ReportTable.

    Skips leading / trailing blank lines. The first content line is
    treated as the header row; subsequent content lines are rows. A
    block with fewer than 1 header + 1 data line is dropped.
    """
    content = [line for line in block if line.strip()]
    if len(content) < 2:
        return None
    header_line = content[0]
    headers = tuple(_split_columns(header_line))
    if not headers:
        return None
    rows: list[tuple[str, ...]] = []
    for row_line in content[1:]:
        cols = _split_columns(row_line)
        if not cols:
            continue
        # Pad / truncate to the header width so the frontend's table
        # renderer doesn't have to think about ragged rows.
        if len(cols) < len(headers):
            cols = cols + [""] * (len(headers) - len(cols))
        elif len(cols) > len(headers):
            cols = cols[: len(headers)]
        rows.append(tuple(cols))
    if not rows:
        return None
    return ReportTable(title=title, headers=headers, rows=tuple(rows))


def _split_columns(line: str) -> list[str]:
    """Split a fixed-width row by runs of 2+ spaces.

    The Report writer emits columns separated by at least 2 spaces
    (``dump_data`` left-pads numerics to a fixed width). Single-space
    splits would shred multi-word values like ``"Bus 5"``.
    """
    return [tok for tok in re.split(r" {2,}", line.strip()) if tok]


def _tds_config_table(plain_text: str) -> ReportTable | None:
    """Build a (Field, Value) two-column table from the augmented TDS
    summary text. Pure string parsing — no ANDES introspection."""
    rows: list[tuple[str, ...]] = []
    for line in plain_text.splitlines():
        line = line.strip()
        if ":" not in line or line.endswith(":"):
            continue
        # Skip the header line itself.
        if line.lower().startswith("-> time domain simulation summary"):
            continue
        # Split on the FIRST colon only — values may contain colons
        # (e.g., timestamps).
        field, _, value = line.partition(":")
        field = field.strip()
        value = value.strip()
        if not field or not value:
            continue
        rows.append((field, value))
    if not rows:
        return None
    return ReportTable(
        title="TDS Summary",
        headers=("Field", "Value"),
        rows=tuple(rows),
    )


def _tds_state_table(ss) -> ReportTable | None:  # type: ignore[no-untyped-def]
    """Build a (State, Final value) table from ``ss.dae.x`` post-run.

    Returns None when there are no dynamic states (purely-algebraic
    case, e.g., raw IEEE 14 without dyr).
    """
    dae = getattr(ss, "dae", None)
    if dae is None:
        return None
    n = int(getattr(dae, "n", 0))
    if n <= 0:
        return None
    x_name = getattr(dae, "x_name", None)
    x = getattr(dae, "x", None)
    if x_name is None or x is None:
        return None
    rows: list[tuple[str, ...]] = []
    for i in range(n):
        try:
            name = str(x_name[i])
            value = f"{float(x[i]):.6g}"
        except (IndexError, TypeError, ValueError):
            continue
        rows.append((name, value))
    if not rows:
        return None
    return ReportTable(
        title="Final state variables",
        headers=("State", "Value"),
        rows=tuple(rows),
    )


__all__ = [
    "MAX_PLAIN_TEXT_BYTES",
    "EigReportPrerequisiteError",
    "PflowNotConvergedError",
    "ReportGenerationError",
    "ReportPayload",
    "ReportRoutine",
    "ReportTable",
    "TdsNotRunError",
    "generate_report",
    "parse_eig_tables",
    "parse_pflow_tables",
    "parse_tds_tables",
]
