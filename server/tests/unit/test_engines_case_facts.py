"""Unit tests for ``tensa.engines.case_facts``: the reader of the facts of a
PSS/E RAW or MATPOWER case file that an engine's own reader can get wrong
(unit P4-F).

The format rules are driven with inline snippets; the committed fixtures, which
hold what ANDES read from the same files, check the reader against the reference
reader on the six PSS/E cases.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from tensa.core.examples import _andes_cases_dir
from tensa.engines.case_facts import (
    CaseFacts,
    CaseFactsError,
    LineFact,
    RatingFact,
    TransformerFact,
    corrections_document,
    read_case_facts,
    read_matpower_facts,
    read_psse_raw_facts,
)
from tensa.engines.identity import (
    read_identity,
    read_matpower_identity,
    read_psse_raw_identity,
)

FIXTURES = Path(__file__).resolve().parent.parent / "julia" / "fixtures"
SAMPLES = Path(__file__).resolve().parent / "sienna_samples"
EXAMPLE_CASES = (
    Path(__file__).resolve().parents[2] / "src" / "tensa" / "examples" / "cases"
)

RAW_HEADER = """\
  0,    100.00, 33, 0, 0, 60.00       /
  CASE FACTS SNIPPET
  SECOND COMMENT LINE
"""

RAW_BUSES = """\
    1,'Bus One    ',  20.0000,3,   1,   1,   1,1.04000,   0.0000
    2,'Bus Two    ', 230.0000,2,   1,   1,   1,1.02500,   9.3507
    3,'Bus Three  ', 230.0000,1,   1,   1,   1,1.02500,   5.1420
    4,'Bus Four   ', 115.0000,1,   1,   1,   1,1.02531,  -2.2174
 0 / END OF BUS DATA, BEGIN LOAD DATA
 0 / END OF LOAD DATA, BEGIN FIXED SHUNT DATA
 0 / END OF FIXED SHUNT DATA, BEGIN GENERATOR DATA
"""


def _raw(
    *,
    header: str = RAW_HEADER,
    gens: str = "",
    branches: str = "",
    transformers: str = "",
    tail: str = "Q\n",
) -> str:
    return (
        header
        + RAW_BUSES
        + gens
        + " 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA\n"
        + branches
        + " 0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA\n"
        + transformers
        + " 0 / END OF TRANSFORMER DATA\n"
        + tail
    )


def _transformer(
    cw: int, line3: str, line4: str, ckt: str = "'1 '", buses: str = "1,     2"
) -> str:
    return (
        f"    {buses},    0,{ckt},{cw},1,1,  0.00000,  0.00000,2,'        ',1,   1,1.0000\n"
        " 0.00000, 0.05760, 100.00\n"
        f"{line3}\n"
        f"{line4}\n"
    )


def _rating_keys(facts: CaseFacts) -> list[tuple[int, int, str]]:
    return [(r.from_bus, r.to_bus, r.ckt) for r in facts.ratings]


@pytest.mark.unit
def test_cw1_ratio() -> None:
    text = _raw(transformers=_transformer(1, "1.10000,  0.000,   0.000", "1.00000,  0.000"))
    facts = read_psse_raw_facts(text)
    assert facts.transformers == (
        TransformerFact(1, 2, "1", 1.1, 0.0),
    )
    assert facts.lines == ()


@pytest.mark.unit
def test_cw1_ratio_is_windv1_over_windv2() -> None:
    # The file's meaning, where ANDES 2.0.0 would take WINDV1 alone.
    text = _raw(transformers=_transformer(1, "1.10000,  0.000,   0.000", "1.05000,  0.000"))
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].tap == pytest.approx(1.1 / 1.05)


@pytest.mark.unit
def test_winding_2_off_its_bus_base_gets_a_note() -> None:
    text = _raw(
        transformers=_transformer(1, "1.10000,  0.000,   0.000", "1.05000,  0.000")
        + _transformer(1, "1.10000,  0.000,   0.000", "1.00000,  0.000", ckt="'2 '")
    )
    facts = read_psse_raw_facts(text)
    # Only the first record's winding 2 is off 1.0; the second has no note.
    assert len(facts.notes) == 1
    note = facts.notes[0]
    assert "transformer 1-2 circuit '1'" in note
    assert "winding 1 ratio 1.1" in note
    assert "winding 2 ratio 1.05" in note
    assert "ANDES ignores it" in note
    assert corrections_document(facts)["notes"] == [note]


@pytest.mark.unit
def test_winding_2_note_counts_its_nominal_voltage() -> None:
    # CW 3 with WINDV2 of 1 but NOMV2 of 120 kV on a 115 kV bus: the winding-2
    # ratio in per unit of the bus base is 120/115, so it gets a note.
    text = _raw(
        transformers=_transformer(
            3, "1.00000,  0.000,   0.000", "1.00000, 120.00", buses="1,     4"
        )
    )
    facts = read_psse_raw_facts(text)
    assert len(facts.notes) == 1
    assert "winding 2 ratio 1.04347" in facts.notes[0]


@pytest.mark.unit
def test_cw2_ratio_uses_bus_base_kv() -> None:
    # Buses 1 and 4 are 20 kV and 115 kV: tap = (21/20) / (110/115). The NOMV
    # fields play no part under CW 2.
    text = _raw(
        transformers=_transformer(
            2, "21.0000, 22.000,   0.000", "110.000, 120.00", buses="1,     4"
        )
    )
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].tap == pytest.approx((21 / 20) / (110 / 115))


@pytest.mark.unit
def test_cw2_windv2_of_zero_means_bus_base() -> None:
    text = _raw(
        transformers=_transformer(
            2, "21.0000,  0.000,   0.000", "0.00000,  0.000", buses="1,     4"
        )
    )
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].tap == pytest.approx(21 / 20)


@pytest.mark.unit
def test_cw2_without_a_bus_base_voltage_raises() -> None:
    # Bus 9 is not in the bus block, so its base voltage is unknown.
    text = _raw(
        transformers=_transformer(
            2, "21.0000,  0.000,   0.000", "230.000,  0.000", buses="1,     9"
        )
    )
    with pytest.raises(CaseFactsError, match="1-9"):
        read_psse_raw_facts(text)


@pytest.mark.unit
def test_cw3_ratio_uses_nominal_winding_voltages() -> None:
    # tap = (1.05 / 1.02) * (22/20) / (120/115): WINDV2 counts, where ANDES
    # 2.0.0 would leave it out.
    text = _raw(
        transformers=_transformer(
            3, "1.05000, 22.000,   0.000", "1.02000, 120.00", buses="1,     4"
        )
    )
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].tap == pytest.approx(
        (1.05 / 1.02) * (22 / 20) / (120 / 115)
    )


@pytest.mark.unit
def test_cw3_nomv_of_zero_means_bus_base_kv() -> None:
    # NOMV1 of 0 reads as the bus base voltage (20 kV), so its factor is 1:
    # tap = 1.05 * (20/20) / (120/115).
    text = _raw(
        transformers=_transformer(
            3, "1.05000,  0.000,   0.000", "1.00000, 120.00", buses="1,     4"
        )
    )
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].tap == pytest.approx(1.05 / (120 / 115))
    # And NOMV2 of 0 on the other side: tap = 1.05 * (22/20).
    text = _raw(
        transformers=_transformer(
            3, "1.05000, 22.000,   0.000", "1.00000,  0.000", buses="1,     4"
        )
    )
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].tap == pytest.approx(1.05 * (22 / 20))


@pytest.mark.unit
@pytest.mark.parametrize(
    ("cw", "line3", "line4", "expected"),
    [
        # A WINDV of 0 is that winding at its nominal, before the ratio is
        # taken: the other winding still counts.
        (1, "0.00000,  0.000,   0.000", "1.05000,  0.000", 1 / 1.05),
        (1, "1.05000,  0.000,   0.000", "0.00000,  0.000", 1.05),
        (1, "0.00000,  0.000,   0.000", "0.00000,  0.000", 1.0),
        (2, "0.00000,  0.000,   0.000", "110.000,  0.000", 1 / (110 / 115)),
        (3, "0.00000, 22.000,   0.000", "1.00000, 120.00", (22 / 20) / (120 / 115)),
        (3, "1.05000, 22.000,   0.000", "0.00000, 120.00", 1.05 * (22 / 20) / (120 / 115)),
    ],
)
def test_windv_of_zero_means_nominal_for_that_winding(
    cw: int, line3: str, line4: str, expected: float
) -> None:
    text = _raw(transformers=_transformer(cw, line3, line4, buses="1,     4"))
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].tap == pytest.approx(expected)


@pytest.mark.unit
def test_negative_j_is_metering_flag() -> None:
    branches = "    2,    -3,'1 ', 0.01000, 0.06800,0.17600,1\n"
    text = _raw(branches=branches)
    facts = read_psse_raw_facts(text)
    assert facts.lines == (LineFact(2, 3, "1", 0.176),)


@pytest.mark.unit
def test_out_of_service_machine_ignored() -> None:
    gens = (
        "    1,'1 ',    71.627,    27.915,  9900.000, -9900.000,1.04000,    0,   500.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1\n"
        "    2,'1 ',   163.000,     4.903,  9900.000, -9900.000,1.02500,    0,   250.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,0\n"
    )
    facts = read_psse_raw_facts(_raw(gens=gens))
    assert facts.v_setpoints == {1: 1.04}


@pytest.mark.unit
def test_short_generator_record_counts_as_in_service() -> None:
    gens = "    2,'1 ',   163.000,     4.903,  9900.000, -9900.000,1.02500\n"
    facts = read_psse_raw_facts(_raw(gens=gens))
    assert facts.v_setpoints == {2: 1.025}


@pytest.mark.unit
def test_two_machines_one_bus_same_vs() -> None:
    gens = (
        "    2,'1 ',   163.000,     4.903,  9900.000, -9900.000,1.02500,    0,   250.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1\n"
        "    2,'2 ',    50.000,     2.000,  9900.000, -9900.000,1.02500,    0,   100.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1\n"
    )
    facts = read_psse_raw_facts(_raw(gens=gens))
    assert facts.v_setpoints == {2: 1.025}


@pytest.mark.unit
def test_two_machines_one_bus_different_vs_raises() -> None:
    gens = (
        "    2,'1 ',   163.000,     4.903,  9900.000, -9900.000,1.02500,    0,   250.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1\n"
        "    2,'2 ',    50.000,     2.000,  9900.000, -9900.000,1.02600,    0,   100.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1\n"
    )
    with pytest.raises(CaseFactsError, match="bus 2"):
        read_psse_raw_facts(_raw(gens=gens))


def _gen(bus: int, ckt: str, vs: str) -> str:
    return (
        f"    {bus},'{ckt} ',    50.000,     2.000,  9900.000, -9900.000,{vs},    0,"
        "   100.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1\n"
    )


@pytest.mark.unit
@pytest.mark.parametrize("vs", ["1.02510", "1.02500001"], ids=["1e-4", "1e-8"])
def test_two_machines_one_bus_a_small_difference_still_raises(vs: str) -> None:
    # Any difference a file can state is a conflict, however small.
    gens = _gen(2, "1", "1.02500") + _gen(2, "2", vs)
    with pytest.raises(CaseFactsError, match="bus 2"):
        read_psse_raw_facts(_raw(gens=gens))


@pytest.mark.unit
def test_two_machines_one_bus_same_vs_written_two_ways() -> None:
    # The same setpoint written with different digits (and so as floats that
    # can differ in the last place) is one setpoint, not a conflict.
    gens = _gen(2, "1", "1.025") + _gen(2, "2", "1.0250000000000001")
    facts = read_psse_raw_facts(_raw(gens=gens))
    assert facts.v_setpoints == {2: pytest.approx(1.025, abs=1e-12)}


@pytest.mark.unit
def test_record_that_ends_just_before_a_field_takes_its_default() -> None:
    # A generator record that stops after GTAP (field 14 of 15, so STAT is the
    # first field missing) is in service; a branch record that stops after X
    # (B, field 6, is the first missing) has no line charging. A record one
    # field short must not be read past its end.
    gens = (
        "    2,'1 ',   163.000,     4.903,  9900.000, -9900.000,1.02500,    0,"
        "   250.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000\n"
    )
    branches = "    2,     3,'1 ', 0.01000, 0.06800\n"
    facts = read_psse_raw_facts(_raw(gens=gens, branches=branches))
    assert facts.v_setpoints == {2: 1.025}
    assert facts.lines == (LineFact(2, 3, "1", 0.0),)


@pytest.mark.unit
@pytest.mark.parametrize(
    "first_line",
    ["  0,    100.00 /", "  0,    100.00, REV, 0, 0, 60.00 /"],
    ids=["no-revision", "revision-not-a-number"],
)
def test_header_without_a_usable_revision_is_read_as_33(first_line: str) -> None:
    # Revision 33 has no system-wide block, so the bus block is the first; a
    # file read as 34 would take the buses for that block and every later
    # block for the one before it.
    gens = "    1,'1 ',    71.627,    27.915,  9900.000, -9900.000,1.04000\n"
    branches = "    2,     3,'1 ', 0.01000, 0.06800,0.17600\n"
    transformers = _transformer(1, "1.10000,  0.000,   0.000", "1.00000,  0.000")
    as_33 = _raw(gens=gens, branches=branches, transformers=transformers)
    header = first_line + "\n" + RAW_HEADER.split("\n", 1)[1]
    text = _raw(header=header, gens=gens, branches=branches, transformers=transformers)
    facts = read_psse_raw_facts(text)
    assert facts == read_psse_raw_facts(as_33)
    assert facts.v_setpoints == {1: 1.04}
    assert facts.lines == (LineFact(2, 3, "1", 0.176),)
    assert facts.transformers == (TransformerFact(1, 2, "1", 1.1, 0.0),)


@pytest.mark.unit
def test_three_winding_transformer_skipped() -> None:
    transformers = (
        "    2,     3,    4,'T3',1,1,1,  0.00000,  0.00000,2,'3WINDXFR',1,   1,1.0000\n"
        " 0.01000, 0.10000, 100.00, 0.02000, 0.20000, 100.00, 0.03000, 0.30000, 100.00, 1.00000, 0.00000\n"
        "1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     4, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000\n"
        "1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     5, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000\n"
        "1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     6, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000\n"
        + _transformer(1, "1.02000,  0.000,   0.000", "1.00000,  0.000")
    )
    facts = read_psse_raw_facts(_raw(transformers=transformers))
    assert facts.transformers == (TransformerFact(1, 2, "1", 1.02, 0.0),)


@pytest.mark.unit
def test_phase_shift_in_radians() -> None:
    text = _raw(transformers=_transformer(1, "1.00000,  0.000,  30.000", "1.00000,  0.000"))
    facts = read_psse_raw_facts(text)
    assert facts.transformers[0].shift_rad == pytest.approx(math.radians(30.0))


@pytest.mark.unit
def test_transformer_negative_j_and_circuit_id() -> None:
    text = _raw(
        transformers=_transformer(
            1, "1.00000,  0.000,   0.000", "1.00000,  0.000", ckt="' T9 '", buses="1,    -2"
        )
    )
    facts = read_psse_raw_facts(text)
    assert facts.transformers == (TransformerFact(1, 2, "T9", 1.0, 0.0),)
    identity = read_psse_raw_identity(text)
    assert [(b.from_bus, b.to_bus, b.ckt) for b in identity.branches] == [(1, 2, "T9")]


@pytest.mark.unit
def test_unsupported_revision() -> None:
    text = "0, 100.00, 35, 0, 0, 60.00 /\ncomment\ncomment\nQ\n"
    with pytest.raises(CaseFactsError, match="35"):
        read_psse_raw_facts(text)


@pytest.mark.unit
def test_revision_34_layout() -> None:
    # Revision 34 opens with a system-wide block ended by its own delimiter and
    # has a switching device block between the branch and transformer blocks.
    gens = "    1,'1 ',    71.627,    27.915,  9900.000, -9900.000,1.04000\n"
    branches = "    2,     3,'1 ', 0.01000, 0.06800,0.17600\n"
    text = (
        RAW_HEADER.replace(" 33,", " 34,")
        + "GENERAL, THRSHZ=0.0001\n"
        + " 0 / END OF SYSTEM-WIDE DATA, BEGIN BUS DATA\n"
        + RAW_BUSES
        + gens
        + " 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA\n"
        + branches
        + " 0 / END OF BRANCH DATA, BEGIN SYSTEM SWITCHING DEVICE DATA\n"
        + "    3,     4,'1 ', 0.00000, 0.00010\n"
        + " 0 / END OF SYSTEM SWITCHING DEVICE DATA, BEGIN TRANSFORMER DATA\n"
        + _transformer(1, "1.10000,  0.000,   0.000", "1.00000,  0.000")
        + " 0 / END OF TRANSFORMER DATA\nQ\n"
    )
    facts = read_psse_raw_facts(text)
    assert facts.v_setpoints == {1: 1.04}
    assert facts.lines == (LineFact(2, 3, "1", 0.176),)
    assert facts.transformers == (TransformerFact(1, 2, "1", 1.1, 0.0),)


@pytest.mark.unit
def test_revision_33_with_system_wide_delimiter() -> None:
    # A delimiter before the bus block is not a block of its own.
    text = _raw(
        header=RAW_HEADER + " 0 / END OF SYSTEM-WIDE DATA, BEGIN BUS DATA\n",
        gens="    2,'1 ',   163.000,     4.903,  9900.000, -9900.000,1.02500\n",
    )
    facts = read_psse_raw_facts(text)
    assert facts.v_setpoints == {2: 1.025}


@pytest.mark.unit
def test_file_ends_early() -> None:
    text = (
        RAW_HEADER
        + RAW_BUSES
        + "    1,'1 ',    71.627,    27.915,  9900.000, -9900.000,1.04000,    0,   500.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1\n"
    )
    facts = read_psse_raw_facts(text)
    assert facts.v_setpoints == {1: 1.04}
    assert facts.lines == ()
    assert facts.transformers == ()


@pytest.mark.unit
def test_file_ends_inside_a_transformer_record() -> None:
    # The first record is whole; the second stops after two of its four lines.
    whole = _transformer(1, "1.10000,  0.000,   0.000", "1.00000,  0.000")
    cut = "".join(_transformer(1, "1.20000,  0.000,   0.000", "1.00000,  0.000").splitlines(
        keepends=True
    )[:2])
    text = (
        RAW_HEADER
        + RAW_BUSES
        + " 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA\n"
        + " 0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA\n"
        + whole
        + cut
    )
    facts = read_psse_raw_facts(text)
    assert facts.transformers == (TransformerFact(1, 2, "1", 1.1, 0.0),)


@pytest.mark.unit
def test_order_matches_identity_on_a_snippet() -> None:
    branches = (
        "    3,     2,'2 ', 0.01000, 0.06800,0.17600\n"
        "    2,     3,'1 ', 0.01000, 0.06800,0.15800\n"
    )
    transformers = _transformer(
        1, "1.10000,  0.000,   0.000", "1.00000,  0.000", buses="4,     2"
    ) + _transformer(1, "1.20000,  0.000,   0.000", "1.00000,  0.000")
    text = _raw(branches=branches, transformers=transformers)
    facts = read_psse_raw_facts(text)
    keys = [(f.from_bus, f.to_bus, f.ckt) for f in facts.lines]
    keys += [(f.from_bus, f.to_bus, f.ckt) for f in facts.transformers]
    identity = read_psse_raw_identity(text)
    assert keys == [(b.from_bus, b.to_bus, b.ckt) for b in identity.branches]
    assert keys == [(3, 2, "2"), (2, 3, "1"), (4, 2, "1"), (1, 2, "1")]
    assert _rating_keys(facts) == keys


_THREE_WINDING = (
    "    2,     3,    4,'T3',1,1,1,  0.00000,  0.00000,2,'3WINDXFR',1,   1,1.0000\n"
    " 0.01000, 0.10000, 100.00, 0.02000, 0.20000, 100.00, 0.03000, 0.30000, 100.00, 1.00000, 0.00000\n"
    "1.00000,  230.00,  30.000,  100.00,  100.00,  100.00, 0,     4, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000\n"
    "1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     5, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000\n"
    "1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     6, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000\n"
)


@pytest.mark.unit
def test_order_matches_identity_around_three_winding_records() -> None:
    # Three-winding records (ANG2 of 0) before, between and after two-winding
    # ones: both readers must end each record where it ends.
    transformers = (
        _THREE_WINDING
        + _transformer(1, "1.10000,  0.000,   0.000", "1.00000,  0.000")
        + _THREE_WINDING
        + _THREE_WINDING
        + _transformer(1, "1.20000,  0.000,   0.000", "1.00000,  0.000", buses="4,     2")
        + _THREE_WINDING
    )
    text = _raw(branches="    2,     3,'1 ', 0.01000, 0.06800,0.17600\n", transformers=transformers)
    facts = read_psse_raw_facts(text)
    keys = [(f.from_bus, f.to_bus, f.ckt) for f in facts.lines]
    keys += [(f.from_bus, f.to_bus, f.ckt) for f in facts.transformers]
    identity = read_psse_raw_identity(text)
    assert keys == [(b.from_bus, b.to_bus, b.ckt) for b in identity.branches]
    assert keys == [(2, 3, "1"), (1, 2, "1"), (4, 2, "1")]
    assert len(identity.transformers3) == 4
    # A three-winding record gives no rating row, as it gives no other fact.
    assert _rating_keys(facts) == keys


@pytest.mark.unit
def test_corrections_document_shape() -> None:
    gens = "    2,'1 ',   163.000,     4.903,  9900.000, -9900.000,1.02500\n"
    branches = "    2,     3,'1 ', 0.01000, 0.06800,0.17600,1\n"
    transformers = _transformer(1, "1.10000,  0.000,  10.000", "1.00000,  0.000")
    facts = read_psse_raw_facts(_raw(gens=gens, branches=branches, transformers=transformers))
    document = corrections_document(facts)
    assert document == {
        "v_setpoints": {"2": 1.025},
        "transformers": [[1, 2, "1", 1.1, math.radians(10.0)]],
        "line_charging": [[2, 3, "1", 0.176]],
        # A PSS/E transformer record has no line charging.
        "transformer_charging": [],
        # The branch's seventh field, RATEA, is 1; the transformer's third
        # line ends before RATA1.
        "ratings": [[2, 3, "1", 1.0], [1, 2, "1", 0.0]],
        "notes": [],
        # A PSS/E file has no operations data (no cost, no ramps).
        "generator_ops": [],
    }


@pytest.mark.unit
def test_branch_ratea_revision_33() -> None:
    # RATEA is the seventh field, after I, J, CKT, R, X, B.
    branches = "    2,     3,'1 ', 0.01000, 0.06800,0.17600,  250.000,  300.000,  350.000\n"
    facts = read_psse_raw_facts(_raw(branches=branches))
    assert facts.ratings == (RatingFact(2, 3, "1", 250.0),)


@pytest.mark.unit
def test_branch_rate1_revision_34_after_the_name_field() -> None:
    # Revision 34 carries a NAME field after B, so RATE1 is the eighth field:
    # the name must not be taken for the rating nor the rating for the name.
    branches = (
        "    2,     3,'1 ', 0.01000, 0.06800,0.17600,'LINE NAME   ',  300.000,  400.000,  500.000\n"
    )
    text = (
        RAW_HEADER.replace(" 33,", " 34,")
        + "GENERAL, THRSHZ=0.0001\n"
        + " 0 / END OF SYSTEM-WIDE DATA, BEGIN BUS DATA\n"
        + RAW_BUSES
        + " 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA\n"
        + branches
        + " 0 / END OF BRANCH DATA, BEGIN SYSTEM SWITCHING DEVICE DATA\n"
        + " 0 / END OF SYSTEM SWITCHING DEVICE DATA, BEGIN TRANSFORMER DATA\n"
        + " 0 / END OF TRANSFORMER DATA\nQ\n"
    )
    facts = read_psse_raw_facts(text)
    assert facts.ratings == (RatingFact(2, 3, "1", 300.0),)


@pytest.mark.unit
@pytest.mark.parametrize("revision", [33, 34])
def test_transformer_rata1(revision: int) -> None:
    # RATA1 (RATE1 of winding 1 at revision 34) is the fourth field of the
    # record's third line, after WINDV1, NOMV1, ANG1.
    transformers = _transformer(1, "1.10000,  0.000,   0.000,  100.000", "1.00000,  0.000")
    header = RAW_HEADER if revision == 33 else RAW_HEADER.replace(" 33,", " 34,")
    text = _raw(header=header, transformers=transformers)
    if revision == 34:
        text = text.replace(
            header,
            header
            + "GENERAL, THRSHZ=0.0001\n"
            + " 0 / END OF SYSTEM-WIDE DATA, BEGIN BUS DATA\n",
        ).replace(
            " 0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA\n",
            " 0 / END OF BRANCH DATA, BEGIN SYSTEM SWITCHING DEVICE DATA\n"
            " 0 / END OF SYSTEM SWITCHING DEVICE DATA, BEGIN TRANSFORMER DATA\n",
        )
    facts = read_psse_raw_facts(text)
    assert facts.ratings == (RatingFact(1, 2, "1", 100.0),)


@pytest.mark.unit
def test_rating_of_a_short_record_is_zero() -> None:
    # A branch record that ends after B has no RATEA; a transformer whose
    # third line ends after ANG1 has no RATA1.
    branches = "    2,     3,'1 ', 0.01000, 0.06800,0.17600\n"
    transformers = _transformer(1, "1.10000,  0.000,   0.000", "1.00000,  0.000")
    facts = read_psse_raw_facts(_raw(branches=branches, transformers=transformers))
    assert facts.ratings == (RatingFact(2, 3, "1", 0.0), RatingFact(1, 2, "1", 0.0))


@pytest.mark.unit
def test_a_negative_rating_is_zero() -> None:
    branches = "    2,     3,'1 ', 0.01000, 0.06800,0.17600, -250.000\n"
    transformers = _transformer(1, "1.10000,  0.000,   0.000, -100.000", "1.00000,  0.000")
    facts = read_psse_raw_facts(_raw(branches=branches, transformers=transformers))
    assert facts.ratings == (RatingFact(2, 3, "1", 0.0), RatingFact(1, 2, "1", 0.0))


MATPOWER_SNIPPET = """\
function mpc = snippet
mpc.version = '2';
mpc.baseMVA = 100;

%% bus data
mpc.bus = [
    1 3 0 0 0 0 1 1.04 0 230 1 1.1 0.9;
    2 2 10 5 0 0 1 1.025 9.3 230 1 1.1 0.9;
    3 1 20 8 0 0 1 1.01 5.1 230 1 1.1 0.9;
];

%% generator data
mpc.gen = [
    1 100 10 50 -40 1.04 100 1 200 0;
    2 80 5 40 -30 1.025 100 1 150 0;
    2 60 3 30 -20 1.02 100 0 100 0;
];

%% branch data
% fbus tbus r x b rateA rateB rateC ratio angle status angmin angmax
mpc.branch = [
    1 2 0.01 0.06 0.176 0 0 0 0 0 1 -360 360;
    2 3 0.02 0.09 0.158 0 0 0 0 0 1 -360 360;
    3 2 0.03 0.16 0.306 0 0 0 0 0 1 -360 360;
    1 3 0.0 0.0576 0 100 100 100 1.02 -5 1 -360 360;
];
"""


@pytest.mark.unit
def test_matpower_snippet() -> None:
    facts = read_matpower_facts(MATPOWER_SNIPPET)
    # The generator that is off (status 0) is ignored.
    assert facts.v_setpoints == {1: 1.04, 2: 1.025}
    # Parallel rows 2-3 and 3-2 share an unordered pair: ckt "1", "2".
    assert facts.lines == (
        LineFact(1, 2, "1", 0.176),
        LineFact(2, 3, "1", 0.158),
        LineFact(3, 2, "2", 0.306),
    )
    assert facts.transformers == (
        TransformerFact(1, 3, "1", 1.02, math.radians(-5.0)),
    )
    document = corrections_document(facts)
    assert document["v_setpoints"] == {"1": 1.04, "2": 1.025}
    assert document["transformers"] == [[1, 3, "1", 1.02, math.radians(-5.0)]]
    assert document["line_charging"] == [
        [1, 2, "1", 0.176],
        [2, 3, "1", 0.158],
        [3, 2, "2", 0.306],
    ]
    assert document["ratings"] == [
        [1, 2, "1", 0.0],
        [2, 3, "1", 0.0],
        [3, 2, "2", 0.0],
        [1, 3, "1", 100.0],
    ]
    assert document["notes"] == []


@pytest.mark.unit
def test_matpower_transformer_charging() -> None:
    # A row with a ratio and a b is a transformer whose charging is half at
    # each end inside the ratio (MATPOWER's pi); PowerSystems keeps it on the
    # from end only, so the facts carry it as transformer_charging. A row with
    # a ratio and no b gives none, and a line's charging stays in
    # line_charging.
    text = MATPOWER_SNIPPET.replace(
        "    1 3 0.0 0.0576 0 100 100 100 1.02 -5 1 -360 360;\n",
        "    1 3 0.0 0.0576 0 100 100 100 1.02 -5 1 -360 360;\n"
        "    2 3 0.005 0.04 0.10 0 0 0 1 0 1 -360 360;\n",
    )
    facts = read_matpower_facts(text)
    assert facts.transformers == (
        TransformerFact(1, 3, "1", 1.02, math.radians(-5.0), 0.0),
        TransformerFact(2, 3, "3", 1.0, 0.0, 0.1),
    )
    document = corrections_document(facts)
    assert document["transformer_charging"] == [[2, 3, "3", 0.1]]
    assert [row[:3] for row in document["line_charging"]] == [
        [1, 2, "1"],
        [2, 3, "1"],
        [3, 2, "2"],
    ]


@pytest.mark.unit
def test_matpower_ratea() -> None:
    text = MATPOWER_SNIPPET.replace(
        "    1 2 0.01 0.06 0.176 0 0 0 0 0 1 -360 360;",
        "    1 2 0.01 0.06 0.176 9900 0 0 0 0 1 -360 360;",
    )
    facts = read_matpower_facts(text)
    assert facts.ratings[0] == RatingFact(1, 2, "1", 9900.0)
    # rateA is the sixth column of every row, transformer rows included.
    assert facts.ratings[-1] == RatingFact(1, 3, "1", 100.0)


@pytest.mark.unit
def test_matpower_short_and_negative_ratea_are_zero() -> None:
    text = MATPOWER_SNIPPET.replace(
        "    1 2 0.01 0.06 0.176 0 0 0 0 0 1 -360 360;",
        "    1 2 0.01 0.06 0.176;",
    ).replace(
        "    2 3 0.02 0.09 0.158 0 0 0 0 0 1 -360 360;",
        "    2 3 0.02 0.09 0.158 -50 0 0 0 0 1 -360 360;",
    )
    facts = read_matpower_facts(text)
    assert facts.ratings[0] == RatingFact(1, 2, "1", 0.0)
    assert facts.ratings[1] == RatingFact(2, 3, "1", 0.0)


@pytest.mark.unit
def test_matpower_ratings_in_the_order_of_the_other_branch_facts() -> None:
    # A transformer row before the lines, and a line on the transformer's bus
    # pair written the other way round: the ratings list the lines first and
    # the transformers after, each in row order, as ``lines`` then
    # ``transformers`` and the identity's ``branches`` do, and the line on
    # the transformer's pair is its second circuit.
    text = MATPOWER_SNIPPET.replace(
        "    1 2 0.01 0.06 0.176 0 0 0 0 0 1 -360 360;\n"
        "    2 3 0.02 0.09 0.158 0 0 0 0 0 1 -360 360;\n"
        "    3 2 0.03 0.16 0.306 0 0 0 0 0 1 -360 360;\n"
        "    1 3 0.0 0.0576 0 100 100 100 1.02 -5 1 -360 360;\n",
        "    1 3 0.0 0.0576 0 100 100 100 1.02 -5 1 -360 360;\n"
        "    1 2 0.01 0.06 0.176 50 0 0 0 0 1 -360 360;\n"
        "    3 1 0.03 0.16 0.306 70 0 0 0 0 1 -360 360;\n",
    )
    facts = read_matpower_facts(text)
    assert facts.ratings == (
        RatingFact(1, 2, "1", 50.0),
        RatingFact(3, 1, "2", 70.0),
        RatingFact(1, 3, "1", 100.0),
    )
    keys = [(f.from_bus, f.to_bus, f.ckt) for f in facts.lines]
    keys += [(f.from_bus, f.to_bus, f.ckt) for f in facts.transformers]
    assert _rating_keys(facts) == keys
    identity = read_matpower_identity(text)
    assert keys == [(b.from_bus, b.to_bus, b.ckt) for b in identity.branches]


@pytest.mark.unit
def test_read_case_facts_picks_by_extension(tmp_path: Path) -> None:
    raw = tmp_path / "case.raw"
    raw.write_text(_raw())
    assert read_case_facts(raw).lines == ()
    mat = tmp_path / "case.m"
    mat.write_text(MATPOWER_SNIPPET)
    assert len(read_case_facts(mat).lines) == 3
    other = tmp_path / "case.xlsx"
    other.write_text("nope")
    with pytest.raises(CaseFactsError, match="extension"):
        read_case_facts(other)


CASE_NAMES = ("kundur", "ieee14", "ieee39", "wscc9", "npcc", "wecc")


def _fixture_and_case(name: str) -> tuple[dict[str, object], Path]:
    fixture_path = FIXTURES / f"{name}.json"
    fixture: dict[str, object] = json.loads(fixture_path.read_text(encoding="utf-8"))
    cases_dir = _andes_cases_dir()
    if cases_dir is None:
        pytest.skip("ANDES cases folder not found")
    raw_path = Path(cases_dir) / str(fixture["raw"])
    if not raw_path.is_file():
        pytest.skip(f"ANDES case file missing: {fixture['raw']}")
    return fixture, raw_path


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_fixture_v_setpoints_and_corrections(name: str) -> None:
    fixture, raw_path = _fixture_and_case(name)
    document = corrections_document(read_case_facts(raw_path))

    expected_vs = fixture["v_setpoints"]
    assert isinstance(expected_vs, dict)
    actual_vs = document["v_setpoints"]
    assert isinstance(actual_vs, dict)
    assert actual_vs.keys() == expected_vs.keys()
    for bus, expected in expected_vs.items():
        assert actual_vs[bus] == pytest.approx(expected, abs=1e-9)

    expected_corrections = fixture["corrections"]
    assert isinstance(expected_corrections, dict)
    for key, width in (("transformers", 5), ("line_charging", 4)):
        expected_rows = expected_corrections[key]
        actual_rows = document[key]
        assert isinstance(expected_rows, list)
        assert isinstance(actual_rows, list)
        assert len(actual_rows) == len(expected_rows)
        for actual_row, expected_row in zip(actual_rows, expected_rows, strict=True):
            assert actual_row[:3] == expected_row[:3]
            for column in range(3, width):
                assert actual_row[column] == pytest.approx(
                    expected_row[column], abs=1e-9
                )

    # The fixtures carry no notes; in these six files every winding 2 is at
    # its bus base, so the reader has nothing to say either.
    assert document["notes"] == []


@pytest.mark.unit
@pytest.mark.parametrize("name", CASE_NAMES)
def test_order_matches_identity(name: str) -> None:
    _, raw_path = _fixture_and_case(name)
    facts = read_case_facts(raw_path)
    identity = read_identity(raw_path)
    fact_keys = [(line.from_bus, line.to_bus, line.ckt) for line in facts.lines]
    fact_keys += [(t.from_bus, t.to_bus, t.ckt) for t in facts.transformers]
    identity_keys = [(b.from_bus, b.to_bus, b.ckt) for b in identity.branches]
    assert fact_keys == identity_keys
    assert _rating_keys(facts) == identity_keys


def _case_files_in(folder: Path) -> list[Path]:
    """The ``.raw`` and ``.m`` files under ``folder``, sorted.

    The suffix is compared without case: ``RTS-GMLC.RAW`` is written in
    capitals, which a ``*.raw`` pattern misses on Linux and macOS.
    """
    return sorted(
        path for path in folder.rglob("*") if path.suffix.lower() in (".raw", ".m")
    )


def _all_case_files() -> list[Path]:
    """Every ``.raw`` and ``.m`` case of the ANDES package and of the examples."""
    cases_dir = _andes_cases_dir()
    assert cases_dir is not None, "ANDES cases folder not found"
    andes_files = _case_files_in(Path(cases_dir))
    assert andes_files, f"no .raw or .m case file in {cases_dir}"
    example_files = _case_files_in(EXAMPLE_CASES)
    assert "RTS-GMLC.RAW" in {path.name for path in example_files}, EXAMPLE_CASES
    return andes_files + example_files


def _branch_fact_keys(facts: CaseFacts) -> list[tuple[int, int, str]]:
    """The ``(from, to, ckt)`` of ``lines`` then ``transformers``."""
    keys = [(line.from_bus, line.to_bus, line.ckt) for line in facts.lines]
    keys += [(t.from_bus, t.to_bus, t.ckt) for t in facts.transformers]
    return keys


@pytest.mark.unit
def test_ratings_order_matches_identity_on_every_case_file() -> None:
    # The ratings are in the order of the module's other branch facts and of
    # the identity's branches, with the same ids, on every file. A MATPOWER
    # file can write a transformer row among the lines (GBnetwork.m opens with
    # one, case14.m has them in the middle) and a bus pair several times with
    # either end first, so row order would not do.
    for path in _all_case_files():
        facts = read_case_facts(path)
        identity_keys = [(b.from_bus, b.to_bus, b.ckt) for b in read_identity(path).branches]
        assert _branch_fact_keys(facts) == identity_keys, path.name
        assert _rating_keys(facts) == identity_keys, path.name


def _andes_branch_ratings(path: Path) -> dict[tuple[int, int], list[float]]:
    """ANDES's ``Line.rate_a`` of the case, per unordered bus pair, in MVA.

    ANDES 2.0.0 turns a three-winding transformer into three ``Line`` records
    on a star bus it adds (``andes/io/psse.py`` builds the star equivalent).
    Those three are left out here, and counted: the file has no two-terminal
    record for them, and its three-winding records are left out of the
    ratings as they are left out of the module's other branch facts.
    """
    import andes

    andes.config_logger(stream_level=50)
    system = andes.load(str(path), setup=False, no_output=True, default_config=True)
    identity = read_identity(path)
    file_buses = set(identity.buses)
    per_pair: dict[tuple[int, int], list[float]] = {}
    star_windings = 0
    for bus1, bus2, rate in zip(
        system.Line.bus1.v, system.Line.bus2.v, system.Line.rate_a.v, strict=True
    ):
        first, second = int(bus1), int(bus2)
        if first not in file_buses or second not in file_buses:
            # A winding of the star model of a three-winding record: ANDES
            # holds a Line the file has no branch record for (wscc9_3wxfr.raw
            # adds the pairs (4, 10), (5, 10) and (6, 10), bus 10 the star).
            star_windings += 1
            continue
        pair = (min(first, second), max(first, second))
        per_pair.setdefault(pair, []).append(float(rate))
    assert star_windings == 3 * len(identity.transformers3), path.name
    return per_pair


@pytest.mark.unit
def test_ratings_match_andes_on_every_case_file() -> None:
    for path in _all_case_files():
        facts = read_case_facts(path)
        andes = _andes_branch_ratings(path)
        per_pair: dict[tuple[int, int], list[float]] = {}
        for rating in facts.ratings:
            pair = (
                min(rating.from_bus, rating.to_bus),
                max(rating.from_bus, rating.to_bus),
            )
            per_pair.setdefault(pair, []).append(rating.rate_mva)
        for rates in per_pair.values():
            rates.sort()
        for rates in andes.values():
            rates.sort()
        # ANDES 2.0.0 reads the same field into rate_a, in MVA and unscaled
        # (RATEA of a branch, RATA1 of a two-winding transformer, rateA of a
        # MATPOWER row, a rateA of 0 kept as 0), on every two-terminal branch
        # of these files, so the file and ANDES agree here. The one place
        # they part is the star model of a three-winding record, left out
        # above, not read from the file.
        assert per_pair == andes, path.name


@pytest.mark.unit
def test_corrections_document_ratings_one_row_per_branch() -> None:
    for path in _all_case_files():
        facts = read_case_facts(path)
        document = corrections_document(facts)
        rows = document["ratings"]
        assert isinstance(rows, list)
        assert rows == [
            [r.from_bus, r.to_bus, r.ckt, r.rate_mva] for r in facts.ratings
        ], path.name
        # Row for row, the ids of line_charging followed by transformers.
        line_rows = document["line_charging"]
        transformer_rows = document["transformers"]
        assert isinstance(line_rows, list)
        assert isinstance(transformer_rows, list)
        assert [row[:3] for row in rows] == [
            row[:3] for row in (*line_rows, *transformer_rows)
        ], path.name


# The case file each recorded corrections document was read from, relative to
# the ANDES cases folder (a "_dyr" sample shares its base case's file).
SAMPLE_CASE_FILES = {
    "kundur": "kundur/kundur.raw",
    "kundur_dyr": "kundur/kundur.raw",
    "ieee14": "ieee14/ieee14.raw",
    "ieee14_dyr": "ieee14/ieee14.raw",
    "ieee39": "ieee39/ieee39.raw",
    "wscc9": "wscc9/wscc9.raw",
    "npcc": "npcc/npcc.raw",
    "wecc": "wecc/wecc.raw",
    "case14_m": "matpower/case14.m",
}


@pytest.mark.unit
def test_every_recorded_corrections_document_has_its_case_file() -> None:
    recorded = {path.name.split(".")[0] for path in SAMPLES.glob("*.corrections.json")}
    assert recorded == set(SAMPLE_CASE_FILES)


@pytest.mark.unit
@pytest.mark.parametrize("name", tuple(SAMPLE_CASE_FILES))
def test_corrections_document_keeps_the_committed_keys(name: str) -> None:
    committed_path = SAMPLES / f"{name}.corrections.json"
    committed: dict[str, object] = json.loads(committed_path.read_text(encoding="utf-8"))
    cases_dir = _andes_cases_dir()
    assert cases_dir is not None, "ANDES cases folder not found"
    case_path = Path(cases_dir) / SAMPLE_CASE_FILES[name]
    assert case_path.is_file(), f"ANDES case file missing: {case_path}"
    document = corrections_document(read_case_facts(case_path))
    # The committed documents predate "ratings", "generator_ops" and
    # "transformer_charging"; every key they have is what it was, value and
    # serialised text. None of these cases has a transformer with charging.
    assert set(document) == set(committed) | {
        "ratings",
        "generator_ops",
        "transformer_charging",
    }, name
    assert document["transformer_charging"] == [], name
    for key, value in committed.items():
        assert document[key] == value, f"{name}: {key}"
        assert json.dumps(document[key]) == json.dumps(value), f"{name}: {key}"
