"""Unit tests for :mod:`andes_app.core.report`.

These tests exercise the structured-table parser and the routine
pre-condition gates without spinning up a real ``ss.PFlow.report()``
write — the structural functions are pure over their plain-text /
DAE inputs, and the report-generation entry points use a small fake
System object so the tests don't pay the multi-second ANDES setup
cost. Integration coverage of the actual ANDES round-trip lives in
``tests/integration/test_reports_api.py``.
"""

from __future__ import annotations

import dataclasses
import logging
from types import SimpleNamespace
from typing import Any

import pytest

from andes_app.core.errors import AndesAppError, NoCaseLoadedError
from andes_app.core.report import (
    PflowNotConvergedError,
    ReportGenerationError,
    ReportPayload,
    ReportTable,
    TdsNotRunError,
    _block_to_table,
    _split_columns,
    _tds_config_table,
    _tds_state_table,
    generate_report,
    parse_pflow_tables,
)

# ---- _split_columns -------------------------------------------------------


@pytest.mark.unit
def test_split_columns_handles_2plus_space_separators() -> None:
    """Real ANDES rows use 2+ spaces between columns; the splitter must
    not shred multi-word values like ``Bus 5``."""
    line = "1                               BUS1              1.03        7.95e-14"
    cols = _split_columns(line)
    assert cols == ["1", "BUS1", "1.03", "7.95e-14"]


@pytest.mark.unit
def test_split_columns_drops_empty_tokens() -> None:
    cols = _split_columns("   foo     bar   ")
    assert cols == ["foo", "bar"]


@pytest.mark.unit
def test_split_columns_returns_empty_for_blank_input() -> None:
    assert _split_columns("    ") == []


# ---- _block_to_table ------------------------------------------------------


@pytest.mark.unit
def test_block_to_table_builds_a_table_from_header_and_rows() -> None:
    block = [
        "",
        "Bus Name              Vm(pu)         Va(rad.)",
        "BUS1                  1.03           0.0",
        "BUS2                  1.04           -0.05",
        "",
    ]
    table = _block_to_table("BUS DATA", block)
    assert table is not None
    assert table.title == "BUS DATA"
    assert table.headers == ("Bus Name", "Vm(pu)", "Va(rad.)")
    assert table.rows == (
        ("BUS1", "1.03", "0.0"),
        ("BUS2", "1.04", "-0.05"),
    )


@pytest.mark.unit
def test_block_to_table_pads_short_rows_to_header_width() -> None:
    """A row with fewer columns than the header gets padded with empty
    strings — the frontend's renderer sees a uniform-width grid."""
    block = [
        "Field          Value",
        "alpha          1.0",
        "beta",  # only one column
    ]
    table = _block_to_table("MIX", block)
    assert table is not None
    assert table.rows == (("alpha", "1.0"), ("beta", ""))


@pytest.mark.unit
def test_block_to_table_truncates_long_rows_to_header_width() -> None:
    block = [
        "Field          Value",
        "alpha          1.0    extra",
    ]
    table = _block_to_table("MIX", block)
    assert table is not None
    assert table.rows == (("alpha", "1.0"),)


@pytest.mark.unit
def test_block_to_table_returns_none_on_header_only() -> None:
    block = ["Bus Name    Vm(pu)"]
    assert _block_to_table("BUS DATA", block) is None


@pytest.mark.unit
def test_block_to_table_returns_none_on_empty_block() -> None:
    assert _block_to_table("BUS DATA", []) is None
    assert _block_to_table("BUS DATA", ["", "  "]) is None


# ---- parse_pflow_tables ---------------------------------------------------


# A minimal PFlow report sample — same section headers + dump_data
# spacing as the real Report.write(), trimmed to two sections so the
# parser test doesn't depend on ANDES.
_PFLOW_REPORT_SAMPLE = """\
ANDES 2.0.0
Copyright (C) 2015-2026 Hantao Cui

ANDES comes with ABSOLUTELY NO WARRANTY
Case file: /tmp/ieee14.raw

Power flow converged in 4 iterations.
Flat-start: No

Statistics:
Buses                             14
Generators                         5
Lines                             20

EXTENDED SUMMARY:
                              P (pu)            Q (pu)

Generation                    2.2643           0.49799
Load                           2.237             0.954

BUS DATA:
                            Bus Name            Vm(pu)          Va(rad.)

1                               BUS1              1.03        0.0
2                               BUS2              1.03        -0.030

LINE DATA:
                            Line Name      Fr. Bus (idx)        To Bus (idx)
Line_1                      Line_1                 1                  2
"""


@pytest.mark.unit
def test_parse_pflow_tables_picks_up_known_sections() -> None:
    tables = parse_pflow_tables(_PFLOW_REPORT_SAMPLE)
    titles = [t.title for t in tables]
    # All three section headers should round-trip.
    assert "EXTENDED SUMMARY" in titles
    assert "BUS DATA" in titles
    assert "LINE DATA" in titles


@pytest.mark.unit
def test_parse_pflow_tables_bus_data_has_two_rows_per_sample() -> None:
    tables = parse_pflow_tables(_PFLOW_REPORT_SAMPLE)
    by_title = {t.title: t for t in tables}
    bus = by_title["BUS DATA"]
    assert bus.headers == ("Bus Name", "Vm(pu)", "Va(rad.)")
    assert len(bus.rows) == 2
    assert bus.rows[0] == ("1", "BUS1", "1.03")  # row dropped 4th col? No: pad


@pytest.mark.unit
def test_parse_pflow_tables_skips_unknown_pre_section_text() -> None:
    """The info / statistics block before the first ALL-CAPS header
    should be ignored (no title to attach it to)."""
    tables = parse_pflow_tables(_PFLOW_REPORT_SAMPLE)
    titles = [t.title for t in tables]
    # "Statistics:" lower-case + colon doesn't match the section regex,
    # so the parser correctly skips it.
    assert "Statistics" not in titles


@pytest.mark.unit
def test_parse_pflow_tables_returns_empty_on_pure_header_input() -> None:
    """A report with no recognisable section headers parses to an
    empty list; the frontend falls back to the plain-text view."""
    assert parse_pflow_tables("just some plain text\nwith no sections") == []


# ---- _tds_config_table ----------------------------------------------------


@pytest.mark.unit
def test_tds_config_table_extracts_field_value_pairs() -> None:
    text = """\
-> Time Domain Simulation Summary:
Sparse Solver: KLU
Simulation time: 0.0-1.0 s.
Fixed step size: h=33.33 ms.

Final simulation time: 1.0000 s
"""
    table = _tds_config_table(text)
    assert table is not None
    assert table.headers == ("Field", "Value")
    fields = [r[0] for r in table.rows]
    # The summary header ("-> Time Domain Simulation Summary:") is skipped.
    assert "Time Domain Simulation Summary" not in fields
    assert "Sparse Solver" in fields
    assert "Final simulation time" in fields


@pytest.mark.unit
def test_tds_config_table_returns_none_when_no_pairs_present() -> None:
    assert _tds_config_table("just\nplain\nlines") is None


# ---- _tds_state_table ----------------------------------------------------


@pytest.mark.unit
def test_tds_state_table_returns_none_when_no_dynamic_states() -> None:
    """A purely-algebraic case (e.g., raw IEEE 14 without dyr) has
    ``dae.n == 0``; the state table should be omitted."""
    fake_dae = SimpleNamespace(n=0, x_name=[], x=[])
    fake_ss = SimpleNamespace(dae=fake_dae)
    assert _tds_state_table(fake_ss) is None


@pytest.mark.unit
def test_tds_state_table_builds_rows_for_each_state() -> None:
    fake_dae = SimpleNamespace(
        n=2,
        x_name=["GENROU_1.delta", "GENROU_1.omega"],
        x=[0.123456789, 1.0],
    )
    fake_ss = SimpleNamespace(dae=fake_dae)
    table = _tds_state_table(fake_ss)
    assert table is not None
    assert table.headers == ("State", "Value")
    assert len(table.rows) == 2
    assert table.rows[0][0] == "GENROU_1.delta"
    assert table.rows[1][0] == "GENROU_1.omega"
    # Values are formatted to %.6g.
    assert "0.123457" in table.rows[0][1]
    assert "1" in table.rows[1][1]


# ---- generate_report — pre-condition gates -------------------------------


@pytest.mark.unit
def test_generate_report_raises_no_case_loaded_when_ss_is_none() -> None:
    with pytest.raises(NoCaseLoadedError):
        generate_report(None, "pflow")


@pytest.mark.unit
def test_generate_report_pflow_raises_when_pf_not_converged() -> None:
    """The wrapper enforces ``PFlow.converged`` itself rather than
    relying on Report.write() to silently emit a partial body."""
    fake_pflow = SimpleNamespace(converged=False)
    fake_ss = SimpleNamespace(PFlow=fake_pflow)
    with pytest.raises(PflowNotConvergedError):
        generate_report(fake_ss, "pflow")


@pytest.mark.unit
def test_generate_report_tds_raises_when_not_initialized() -> None:
    fake_tds = SimpleNamespace(initialized=False)
    fake_dae = SimpleNamespace(t=0.0)
    fake_ss = SimpleNamespace(TDS=fake_tds, dae=fake_dae)
    with pytest.raises(TdsNotRunError):
        generate_report(fake_ss, "tds")


@pytest.mark.unit
def test_generate_report_tds_raises_when_no_steps_have_run() -> None:
    """``TDS.init()`` flips ``initialized`` to True without advancing
    ``dae.t``; a report at that point would mislead the user."""
    fake_tds = SimpleNamespace(initialized=True)
    fake_dae = SimpleNamespace(t=0.0)
    fake_ss = SimpleNamespace(TDS=fake_tds, dae=fake_dae)
    with pytest.raises(TdsNotRunError):
        generate_report(fake_ss, "tds")


@pytest.mark.unit
def test_generate_report_unknown_routine_raises_andes_app_error() -> None:
    fake_ss = SimpleNamespace(PFlow=SimpleNamespace(converged=True))
    with pytest.raises(AndesAppError) as exc_info:
        generate_report(fake_ss, "bogus")  # type: ignore[arg-type]
    # AndesAppError or any subclass — the routes layer maps the
    # specific class name to a status, but for the unit test we just
    # care that the unknown-routine path is rejected.
    assert "bogus" in str(exc_info.value).lower() or "unknown" in str(exc_info.value).lower()


# ---- generate_report — PFlow tempfile-roundtrip --------------------------


class _FakeFiles:
    """Stand-in for ``ss.files`` — the report writer reads / writes
    ``no_output`` and ``txt``. The attribute names match
    :class:`andes.variables.fileman.FileMan` exactly."""

    def __init__(self) -> None:
        self.no_output = True
        self.txt: str | None = None


class _FakePFlowWritesFile:
    """Stand-in for ``ss.PFlow``. Calling ``report()`` writes a fixed
    fixture to ``ss.files.txt`` so the round-trip path is exercised
    without depending on a real ANDES system."""

    def __init__(self, ss: Any, body: str) -> None:
        self._ss = ss
        self._body = body
        self.converged = True

    def report(self) -> bool:
        if self._ss.files.no_output:
            # Mirrors Report.write()'s early-return.
            return False
        target = self._ss.files.txt
        assert target is not None, "files.txt must be set before report()"
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(self._body)
        return True


@pytest.mark.unit
def test_generate_report_pflow_round_trips_through_tempfile() -> None:
    fake_ss = SimpleNamespace(files=_FakeFiles())
    fake_ss.PFlow = _FakePFlowWritesFile(fake_ss, _PFLOW_REPORT_SAMPLE)
    payload = generate_report(fake_ss, "pflow")
    assert isinstance(payload, ReportPayload)
    assert payload.routine == "pflow"
    assert "BUS DATA" in payload.plain_text
    titles = [t.title for t in payload.tables]
    assert "BUS DATA" in titles
    assert "LINE DATA" in titles


@pytest.mark.unit
def test_generate_report_pflow_restores_files_state_on_success() -> None:
    """After a successful report, the original ``no_output`` / ``txt``
    values must be back on ``ss.files`` — otherwise subsequent ANDES
    calls on the same session would silently spam the workspace with
    .txt outputs."""
    fake_ss = SimpleNamespace(files=_FakeFiles())
    fake_ss.PFlow = _FakePFlowWritesFile(fake_ss, _PFLOW_REPORT_SAMPLE)
    saved_no_output = fake_ss.files.no_output
    saved_txt = fake_ss.files.txt
    generate_report(fake_ss, "pflow")
    assert fake_ss.files.no_output is saved_no_output
    assert fake_ss.files.txt == saved_txt


@pytest.mark.unit
def test_generate_report_pflow_restores_files_state_on_failure() -> None:
    """If ANDES raises mid-report, the file state must still be
    restored. Otherwise a single failure poisons the session."""

    class _BoomPFlow(_FakePFlowWritesFile):
        def report(self) -> bool:
            raise RuntimeError("simulated ANDES write failure")

    fake_ss = SimpleNamespace(files=_FakeFiles())
    fake_ss.PFlow = _BoomPFlow(fake_ss, "")
    saved_no_output = fake_ss.files.no_output
    saved_txt = fake_ss.files.txt
    with pytest.raises(ReportGenerationError) as exc_info:
        generate_report(fake_ss, "pflow")
    assert "simulated ANDES write failure" in str(exc_info.value)
    assert fake_ss.files.no_output is saved_no_output
    assert fake_ss.files.txt == saved_txt


@pytest.mark.unit
def test_generate_report_pflow_raises_when_writer_skips_the_file() -> None:
    """If the writer returns without producing the file, surface the
    failure as a clean :class:`ReportGenerationError` (not a confusing
    ``FileNotFoundError`` on the wrong path)."""

    class _NoopPFlow:
        converged = True

        def report(self) -> bool:
            return False

    fake_ss = SimpleNamespace(files=_FakeFiles(), PFlow=_NoopPFlow())
    with pytest.raises(ReportGenerationError) as exc_info:
        generate_report(fake_ss, "pflow")
    assert "did not write" in str(exc_info.value)


# ---- generate_report — TDS logger capture --------------------------------


class _FakeTDSEmitsLog:
    """Stand-in for ``ss.TDS``. ``summary()`` emits a few INFO log
    records that the report generator should capture verbatim."""

    def __init__(self) -> None:
        self.initialized = True
        self.config = SimpleNamespace(tf=1.0, tstep=0.01, fixt=True)

    def summary(self) -> None:
        logger = logging.getLogger("andes.routines.tds")
        logger.info("-> Time Domain Simulation Summary:")
        logger.info("Sparse Solver: KLU")
        logger.info("Simulation time: 0.0-1.0 s.")


@pytest.mark.unit
def test_generate_report_tds_captures_logger_output() -> None:
    fake_dae = SimpleNamespace(t=1.0, n=0, x_name=[], x=[])
    fake_ss = SimpleNamespace(TDS=_FakeTDSEmitsLog(), dae=fake_dae)
    payload = generate_report(fake_ss, "tds")
    assert payload.routine == "tds"
    assert "Sparse Solver: KLU" in payload.plain_text
    assert "Final simulation time" in payload.plain_text
    # Augmentation includes the configured tf as a separate line.
    assert "Configured tf" in payload.plain_text


@pytest.mark.unit
def test_generate_report_tds_restores_logger_level() -> None:
    """The capture handler must not leak — logger level + handler list
    on ``andes.routines.tds`` must be unchanged after the call."""
    target_logger = logging.getLogger("andes.routines.tds")
    saved_level = target_logger.level
    saved_handlers = list(target_logger.handlers)
    fake_dae = SimpleNamespace(t=1.0, n=0, x_name=[], x=[])
    fake_ss = SimpleNamespace(TDS=_FakeTDSEmitsLog(), dae=fake_dae)
    generate_report(fake_ss, "tds")
    assert target_logger.level == saved_level
    assert target_logger.handlers == saved_handlers


@pytest.mark.unit
def test_report_table_dataclass_is_frozen() -> None:
    table = ReportTable(title="t", headers=("a",), rows=(("1",),))
    with pytest.raises(dataclasses.FrozenInstanceError):
        table.title = "other"  # type: ignore[misc]
