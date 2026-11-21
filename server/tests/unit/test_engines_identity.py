"""Unit tests for ``tensa.engines.identity``: the reader of the identity columns
of a PSS/E RAW or MATPOWER case file (unit P3-B1).

The format rules are driven with inline snippets; the real ANDES case files check
the reader against data an engine actually loads.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tensa.core.examples import _andes_cases_dir
from tensa.engines.identity import (
    BranchId,
    DeviceId,
    IdentityError,
    Transformer3Id,
    read_identity,
    read_matpower_identity,
    read_psse_raw_identity,
)

RAW_SNIPPET = """\
  0,    100.00, 33, 0, 0, 60.00       /
  SNIPPET CASE, WITH QUOTED NAMES
  SECOND COMMENT LINE
    1,'Bus, One   ',  20.0000,3,   1,   1,   1,1.04000,   0.0000
    2,'Bus / Two  ', 230.0000,2,   1,   1,   1,1.02500,   9.3507
    3,'Bus Three   ', 230.0000,1,   1,   1,   1,1.02500,   5.1420
    4,'Bus Four    ', 230.0000,4,   1,   1,   1,1.02531,  -2.2174
 0 / END OF BUS DATA, BEGIN LOAD DATA
    3,'BL',1,   1,   1,   125.000,    50.000,     0.000,     0.000,     0.000,    -0.000,   1,1
 0 / END OF LOAD DATA, BEGIN FIXED SHUNT DATA
    3,'1 ',1,  10.000,  20.000
 0 / END OF FIXED SHUNT DATA, BEGIN GENERATOR DATA
    1,'1 ',    71.627,    27.915,  9900.000, -9900.000,1.04000,    0,   500.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1,  100.0,   450.000,     0.000,   1,1.0000
    2,'G2',   163.000,     4.903,  9900.000, -9900.000,1.02500,    0,   250.000,   0.00000,   1.00000,   0.00000,   0.00000,1.00000,1,  100.0,   240.000,     0.000,   1,1.0000
 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA
    2,     3,'1 ', 0.01000, 0.06800,0.17600,   0.00,   0.00,   0.00,  0.00000,  0.00000,  0.00000,  0.00000,1,1,   0.0,   1,1.0000
    2,     3,'2 ', 0.01700, 0.09200,0.15800,   0.00,   0.00,   0.00,  0.00000,  0.00000,  0.00000,  0.00000,1,1,   0.0,   1,1.0000
    3,    -4,'1 ', 0.03200, 0.16100,0.30600,   0.00,   0.00,   0.00,  0.00000,  0.00000,  0.00000,  0.00000,1,1,   0.0,   1,1.0000
 0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA
    1,     2,    0,'1 ',1,1,1,  0.00000,  0.00000,2,'        ',1,   1,1.0000
 0.00000, 0.05760, 100.00
1.00000,  0.000,   0.000,   0.00,   0.00,   0.00,0,     0, 1.50000, 0.51000, 1.50000, 0.51000,159, 0, 0.00000, 0.00000
1.00000,  0.000
    2,     3,    4,'T3',1,1,1,  0.00000,  0.00000,2,'3WINDXFR',1,   1,1.0000
 0.01000, 0.10000, 100.00, 0.02000, 0.20000, 100.00, 0.03000, 0.30000, 100.00, 1.00000, 0.00000
1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     4, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000
1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     5, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000
1.00000,  230.00,   0.000,  100.00,  100.00,  100.00, 0,     6, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000
 0 / END OF TRANSFORMER DATA, BEGIN AREA DATA
   1,    2,     0.000,     1.000,'AREA 1      '
   2,    0,     0.000,     1.000,'AREA 2      '
 0 / END OF AREA DATA, BEGIN TWO-TERMINAL DC DATA
 0 / END OF TWO-TERMINAL DC DATA, BEGIN VOLTAGE SOURCE CONVERTER DATA
 0 / END OF VOLTAGE SOURCE CONVERTER DATA, BEGIN IMPEDANCE CORRECTION DATA
 0 / END OF IMPEDANCE CORRECTION DATA, BEGIN MULTI-TERMINAL DC DATA
 0 / END OF MULTI-TERMINAL DC DATA, BEGIN MULTI-SECTION LINE DATA
 0 / END OF MULTI-SECTION LINE DATA, BEGIN ZONE DATA
   1,'ZONE 1'
   2,'ZONE 2'
 0 / END OF ZONE DATA, BEGIN INTER-AREA TRANSFER DATA
 0 / END OF INTER-AREA TRANSFER DATA, BEGIN OWNER DATA
 0 / END OF OWNER DATA, BEGIN FACTS CONTROL DEVICE DATA
 0 / END OF FACTS CONTROL DEVICE DATA, BEGIN SWITCHED SHUNT DATA
    3,1,0,1, 1.000, 1.000, 0, 100.0,'',  50.000, 1, 25.000
 0 / END OF SWITCHED SHUNT DATA, BEGIN GNE DEVICE DATA
 0 / END OF GNE DEVICE DATA
Q
"""

MATPOWER_SNIPPET = """\
function mpc = snippet
% a comment line
mpc.version = '2';
mpc.baseMVA = 100;

%% bus data
% bus_i type Pd Qd Gs Bs area Vm Va baseKV zone Vmax Vmin
mpc.bus = [
    1 3 0 0 0 0 1 1.04 0 230 1 1.1 0.9;
    2 2 10 5 0 0 1 1.025 9.3 230 1 1.1 0.9; % a load bus
    3 1 20 8 1.5 -2.5 1 1.01 5.1 230 1 1.1 0.9;
    4 4 0 0 0 0 1 1.0 -2.2 230 1 1.1 0.9;
];

%% generator data
mpc.gen = [
    1 100 10 50 -40 1.04 100 1 200 0 0 0 0 0 0 0 0 0 0 0 0;
    2 80 5 40 -30 1.025 100 1 150 0 0 0 0 0 0 0 0 0 0 0 0;
    2 60 3 30 -20 1.02 100 1 100 0 0 0 0 0 0 0 0 0 0 0 0;
];

%% branch data
% fbus tbus r x b rateA rateB rateC ratio angle status angmin angmax
mpc.branch = [
    1 4 0.01 0.06 0.176 0 0 0 0 0 1 -360 360;
    2 3 0.02 0.09 0.158 0 0 0 0 0 1 -360 360;
    3 2 0.03 0.16 0.306 0 0 0 0 0 1 -360 360;
    1 2 0.0 0.0576 0 100 100 100 1.02 0 1 -360 360;
];
"""


@pytest.mark.unit
def test_psse_raw_snippet() -> None:
    identity = read_psse_raw_identity(RAW_SNIPPET)
    assert identity.format == "psse-raw"
    assert identity.version == 33
    assert identity.base_mva == 100.0
    assert identity.freq_hz == 60.0
    assert identity.buses == (1, 2, 3, 4)
    assert identity.swing_buses == (1,)
    assert identity.isolated_buses == (4,)
    # Quoted ids are stripped of quotes and surrounding spaces.
    assert identity.loads == (DeviceId(3, "BL"),)
    assert identity.fixed_shunts == (DeviceId(3, "1"),)
    assert identity.generators == (DeviceId(1, "1"), DeviceId(2, "G2"))
    # Non-transformer branches first, in file order, then two-winding
    # transformers. A negative J is a metering flag: take the absolute value.
    assert identity.branches == (
        BranchId(2, 3, "1", transformer=False),
        BranchId(2, 3, "2", transformer=False),
        BranchId(3, 4, "1", transformer=False),
        BranchId(1, 2, "1", transformer=True),
    )
    assert identity.transformers3 == (Transformer3Id((2, 3, 4), "T3"),)
    # The area with ISW 0 is left out.
    assert identity.area_slack_buses == {1: 2}
    assert identity.switched_shunts == (DeviceId(3, "1"),)
    # Every block of the revision is counted, zero included.
    assert identity.counts["bus"] == 4
    assert identity.counts["transf"] == 2
    assert identity.counts["twotermdc"] == 0
    assert identity.counts["zone"] == 2
    # Zone is non-empty and not interpreted: it is reported unread.
    assert identity.unread_blocks == ("zone",)


@pytest.mark.unit
def test_psse_raw_ends_early() -> None:
    text = """\
  0,    100.00, 33, 0, 0, 60.00       /
  CASE THAT STOPS AFTER THE BUS BLOCK
  SECOND COMMENT LINE
    1,'Bus One    ',  20.0000,3,   1,   1,   1,1.04000,   0.0000
    2,'Bus Two    ', 230.0000,1,   1,   1,   1,1.02500,   9.3507
 0 / END OF BUS DATA, BEGIN LOAD DATA
    2,'1 ',1,   1,   1,   125.000,    50.000
"""
    identity = read_psse_raw_identity(text)
    assert identity.buses == (1, 2)
    assert identity.loads == (DeviceId(2, "1"),)
    assert identity.counts["bus"] == 2
    assert identity.counts["load"] == 1
    assert identity.counts["gen"] == 0
    assert identity.branches == ()


@pytest.mark.unit
def test_psse_raw_unsupported_revision() -> None:
    text = "0, 100.00, 35, 0, 0, 60.00 /\ncomment\ncomment\nQ\n"
    with pytest.raises(IdentityError, match="35"):
        read_psse_raw_identity(text)


@pytest.mark.unit
def test_psse_raw_header_without_revision_defaults_to_33() -> None:
    text = "0, 100.00 /\ncomment\ncomment\nQ\n"
    identity = read_psse_raw_identity(text)
    assert identity.version == 33
    assert identity.freq_hz is None


def _two_winding(i: int, j: int, ckt: str) -> str:
    """A two-winding transformer record (four lines)."""
    return (
        f"    {i},     {j},    0,'{ckt}',1,1,1,  0.00000,  0.00000,2,'        ',1,   1,1.0000\n"
        " 0.00000, 0.05760, 100.00\n"
        "1.00000,  0.000,   0.000,   0.00,   0.00,   0.00,0,     0, 1.50000, 0.51000, 1.50000, 0.51000,159, 0, 0.00000, 0.00000\n"
        "1.00000,  0.000\n"
    )


def _three_winding(
    i: int, j: int, k: int, ckt: str, angles: tuple[float, float, float] = (0.0, 0.0, 0.0)
) -> str:
    """A three-winding transformer record (five lines), with ANG1, ANG2, ANG3."""
    windings = "".join(
        f"1.00000,  230.00, {angle:8.3f},  100.00,  100.00,  100.00, 0,     4, 1.10000, 0.90000, 1.10000, 0.90000, 33, 0, 0.00000, 0.00000\n"
        for angle in angles
    )
    return (
        f"    {i},     {j},    {k},'{ckt}',1,1,1,  0.00000,  0.00000,2,'3WINDXFR',1,   1,1.0000\n"
        " 0.01000, 0.10000, 100.00, 0.02000, 0.20000, 100.00, 0.03000, 0.30000, 100.00, 1.00000, 0.00000\n"
        + windings
    )


def _raw_with_transformers(records: str) -> str:
    return (
        "  0,    100.00, 33, 0, 0, 60.00       /\n"
        "  TRANSFORMER RECORDS\n"
        "  SECOND COMMENT LINE\n"
        "    1,'Bus One    ',  20.0000,3\n"
        "    2,'Bus Two    ', 230.0000,2\n"
        "    3,'Bus Three  ', 230.0000,1\n"
        "    4,'Bus Four   ', 115.0000,1\n"
        "    5,'Bus Five   ', 115.0000,1\n"
        " 0 / END OF BUS DATA, BEGIN LOAD DATA\n"
        " 0 / END OF LOAD DATA, BEGIN FIXED SHUNT DATA\n"
        " 0 / END OF FIXED SHUNT DATA, BEGIN GENERATOR DATA\n"
        " 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA\n"
        "    2,     3,'1 ', 0.01000, 0.06800,0.17600\n"
        " 0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA\n"
        + records
        + " 0 / END OF TRANSFORMER DATA, BEGIN AREA DATA\n"
        " 0 / END OF AREA DATA\n"
        "Q\n"
    )


_LINE = BranchId(2, 3, "1", transformer=False)


# A transformer record's length comes from the K field of the line that opens
# it. The later lines of a three-winding record carry an angle where K would
# be, and one of 0 must not end the record a line early.
@pytest.mark.unit
@pytest.mark.parametrize(
    ("records", "branches", "transformers3"),
    [
        pytest.param(
            _three_winding(2, 3, 4, "T3") + _two_winding(1, 2, "1"),
            (_LINE, BranchId(1, 2, "1", transformer=True)),
            (Transformer3Id((2, 3, 4), "T3"),),
            id="three-then-two",
        ),
        pytest.param(
            _three_winding(2, 3, 4, "T3", angles=(30.0, 0.0, -30.0)) + _two_winding(1, 2, "1"),
            (_LINE, BranchId(1, 2, "1", transformer=True)),
            (Transformer3Id((2, 3, 4), "T3"),),
            id="ang2-zero",
        ),
        pytest.param(
            _three_winding(2, 3, 4, "T3") + _three_winding(3, 4, 5, "T4"),
            (_LINE,),
            (Transformer3Id((2, 3, 4), "T3"), Transformer3Id((3, 4, 5), "T4")),
            id="two-three-winding-in-a-row",
        ),
        pytest.param(
            _two_winding(1, 2, "1") + _three_winding(2, 3, 4, "T3") + _two_winding(4, 5, "2"),
            (
                _LINE,
                BranchId(1, 2, "1", transformer=True),
                BranchId(4, 5, "2", transformer=True),
            ),
            (Transformer3Id((2, 3, 4), "T3"),),
            id="three-between-two",
        ),
    ],
)
def test_psse_raw_transformer_record_length(
    records: str,
    branches: tuple[BranchId, ...],
    transformers3: tuple[Transformer3Id, ...],
) -> None:
    identity = read_psse_raw_identity(_raw_with_transformers(records))
    assert identity.branches == branches
    assert identity.transformers3 == transformers3
    assert identity.counts["transf"] == len(branches) - 1 + len(transformers3)
    assert identity.unread_blocks == ()


@pytest.mark.unit
@pytest.mark.parametrize("basfrq", ["0.0", "-50.0", "x"])
def test_psse_raw_frequency_that_is_not_positive_is_none(basfrq: str) -> None:
    text = f"0, 100.00, 33, 0, 0, {basfrq} /\ncomment\ncomment\nQ\n"
    identity = read_psse_raw_identity(text)
    assert identity.freq_hz is None


@pytest.mark.unit
def test_psse_raw_transformer_j_taken_by_absolute_value() -> None:
    # A negative J on a transformer record is the metering flag, as on a branch.
    text = """\
  0,    100.00, 33, 0, 0, 60.00       /
  TRANSFORMER WITH A NEGATIVE J
  SECOND COMMENT LINE
    1,'Bus One    ',  20.0000,3,   1,   1,   1,1.04000,   0.0000
    2,'Bus Two    ', 230.0000,1,   1,   1,   1,1.02500,   9.3507
 0 / END OF BUS DATA, BEGIN LOAD DATA
 0 / END OF LOAD DATA, BEGIN FIXED SHUNT DATA
 0 / END OF FIXED SHUNT DATA, BEGIN GENERATOR DATA
 0 / END OF GENERATOR DATA, BEGIN BRANCH DATA
 0 / END OF BRANCH DATA, BEGIN TRANSFORMER DATA
    1,    -2,    0,'1 ',1,1,1,  0.00000,  0.00000,2,'        ',1,   1,1.0000
 0.00000, 0.05760, 100.00
1.00000,  0.000,   0.000,   0.00,   0.00,   0.00,0,     0, 1.50000, 0.51000, 1.50000, 0.51000,159, 0, 0.00000, 0.00000
1.00000,  0.000
 0 / END OF TRANSFORMER DATA, BEGIN AREA DATA
Q
"""
    identity = read_psse_raw_identity(text)
    assert identity.branches == (BranchId(1, 2, "1", transformer=True),)


@pytest.mark.unit
def test_psse_raw_stops_at_q() -> None:
    # Whatever follows the "Q" that ends the data is not read as records.
    text = """\
  0,    100.00, 33, 0, 0, 60.00       /
  CASE WITH LINES AFTER Q
  SECOND COMMENT LINE
    1,'Bus One    ',  20.0000,3,   1,   1,   1,1.04000,   0.0000
 0 / END OF BUS DATA, BEGIN LOAD DATA
Q
    1,'L1',1,   1,   1,   125.000,    50.000
"""
    identity = read_psse_raw_identity(text)
    assert identity.buses == (1,)
    assert identity.loads == ()
    assert identity.counts["load"] == 0


@pytest.mark.unit
def test_matpower_load_with_only_p_or_only_q() -> None:
    text = """\
mpc.baseMVA = 100;
mpc.bus = [
    1 3 0 0 0 0 1 1.0 0 230 1 1.1 0.9;
    2 1 10 0 0 0 1 1.0 0 230 1 1.1 0.9;
    3 1 0 5 0 0 1 1.0 0 230 1 1.1 0.9;
    4 1 0 0 0 3 1 1.0 0 230 1 1.1 0.9;
];
"""
    identity = read_matpower_identity(text)
    # A non-zero Pd alone or Qd alone is a load; a Bs alone is a shunt only.
    assert identity.loads == (DeviceId(2, "1"), DeviceId(3, "1"))
    assert identity.fixed_shunts == (DeviceId(4, "1"),)


@pytest.mark.unit
def test_matpower_snippet() -> None:
    identity = read_matpower_identity(MATPOWER_SNIPPET)
    assert identity.format == "matpower"
    assert identity.version is None
    assert identity.base_mva == 100.0
    assert identity.freq_hz is None
    assert identity.buses == (1, 2, 3, 4)
    assert identity.swing_buses == (1,)
    assert identity.isolated_buses == (4,)
    assert identity.loads == (DeviceId(2, "1"), DeviceId(3, "1"))
    assert identity.fixed_shunts == (DeviceId(3, "1"),)
    # Two generators on bus 2 get ordinals "1" and "2".
    assert identity.generators == (
        DeviceId(1, "1"),
        DeviceId(2, "1"),
        DeviceId(2, "2"),
    )
    # Parallel branches 2-3 and 3-2 share an unordered pair: ckt "1", "2".
    # The transformer row (ratio non-zero) comes after the plain branches.
    assert identity.branches == (
        BranchId(1, 4, "1", transformer=False),
        BranchId(2, 3, "1", transformer=False),
        BranchId(3, 2, "2", transformer=False),
        BranchId(1, 2, "1", transformer=True),
    )
    assert identity.transformers3 == ()
    assert identity.counts == {"bus": 4, "gen": 3, "branch": 4}


@pytest.mark.unit
def test_read_identity_picks_by_extension(tmp_path: Path) -> None:
    raw = tmp_path / "case.raw"
    raw.write_text(RAW_SNIPPET)
    assert read_identity(raw).format == "psse-raw"
    mat = tmp_path / "case.m"
    mat.write_text(MATPOWER_SNIPPET)
    assert read_identity(mat).format == "matpower"
    other = tmp_path / "case.xlsx"
    other.write_text("nope")
    with pytest.raises(IdentityError, match="extension"):
        read_identity(other)


def _andes_case(relative: str) -> Path:
    cases_dir = _andes_cases_dir()
    if cases_dir is None:
        pytest.skip("ANDES cases folder not found")
    path = Path(cases_dir) / relative
    if not path.is_file():
        pytest.skip(f"ANDES case file missing: {relative}")
    return path


REAL_CASES = (
    "kundur/kundur.raw",
    "ieee14/ieee14.raw",
    "wscc9/wscc9_3wxfr.raw",
    "ieee39/ieee39.raw",
    "npcc/npcc.raw",
    "wecc/wecc.raw",
)


@pytest.mark.unit
@pytest.mark.parametrize("relative", REAL_CASES)
def test_real_files_read_cleanly(relative: str) -> None:
    identity = read_identity(_andes_case(relative))
    buses = set(identity.buses)
    assert len(identity.buses) == identity.counts["bus"]
    assert len(buses) == len(identity.buses)
    for branch in identity.branches:
        assert branch.from_bus in buses
        assert branch.to_bus in buses
    for transformer in identity.transformers3:
        for bus in transformer.buses:
            assert bus in buses
    for device in (
        *identity.loads,
        *identity.fixed_shunts,
        *identity.switched_shunts,
        *identity.generators,
    ):
        assert device.bus in buses


@pytest.mark.unit
def test_kundur_exact_numbers() -> None:
    identity = read_identity(_andes_case("kundur/kundur.raw"))
    assert identity.version == 32
    assert identity.base_mva == 100.0
    assert identity.freq_hz == 60.0
    assert identity.buses == (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    assert identity.swing_buses == (1,)
    assert identity.isolated_buses == ()
    assert identity.loads == (DeviceId(7, "2"), DeviceId(8, "1"))
    assert identity.fixed_shunts == ()
    assert identity.generators == (
        DeviceId(1, "1"),
        DeviceId(2, "1"),
        DeviceId(3, "1"),
        DeviceId(4, "1"),
    )
    assert len(identity.branches) == 15
    plain = identity.branches[:11]
    assert all(not branch.transformer for branch in plain)
    transformers = identity.branches[11:]
    assert transformers == (
        BranchId(1, 5, "1", transformer=True),
        BranchId(2, 6, "1", transformer=True),
        BranchId(3, 9, "1", transformer=True),
        BranchId(4, 10, "1", transformer=True),
    )
    assert identity.transformers3 == ()
    assert identity.area_slack_buses == {1: 1, 2: 3}
    assert identity.counts["bus"] == 10
    assert identity.counts["branch"] == 11
    assert identity.counts["transf"] == 4
    assert identity.counts["zone"] == 1
    assert identity.counts["owner"] == 1
    assert identity.unread_blocks == ("zone", "owner")
