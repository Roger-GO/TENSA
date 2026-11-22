"""Unit tests of the ANDES case document builder, on a real ANDES System."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from tensa.core.errors import NoCaseLoadedError
from tensa.core.wrapper import Wrapper
from tensa.engines.andes.case_doc import build_case_document


def _kundur() -> Path:
    import andes

    return Path(andes.__file__).parent / "cases" / "kundur" / "kundur.raw"


@pytest.fixture()
def wrapper(tmp_path: Path) -> Wrapper:
    case = tmp_path / "kundur.raw"
    case.write_bytes(_kundur().read_bytes())
    w = Wrapper(workspace=str(tmp_path), session_id="t", owner_pid=None)
    w.load_case(str(case))
    return w


def test_header_fields(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    # kundur.raw's header: SBASE 100, BASFRQ 60.
    assert document.base_mva == 100.0
    assert document.freq_hz == 60.0
    assert document.name == "kundur"
    assert document.source is not None
    assert document.source.format == "psse-raw"
    assert document.source.files == ["kundur.raw"]
    assert document.source.sha256 is not None
    assert len(document.source.sha256[0]) == 64


def test_bus_keys_match_the_book(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    book = wrapper.keys()
    for record in document.buses:
        assert record.key == book.key_of("Bus", record.number)
    # Kundur has ten buses, numbered 1 to 10.
    assert len(document.buses) == 10


def test_bus_voltages_are_the_stored_initial_values(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    ss = wrapper._require_loaded()  # noqa: SLF001
    v0_by_idx = {str(idx): float(v) for idx, v in zip(ss.Bus.idx.v, ss.Bus.v0.v, strict=True)}
    a0_by_idx = {str(idx): float(a) for idx, a in zip(ss.Bus.idx.v, ss.Bus.a0.v, strict=True)}
    for record in document.buses:
        v0 = v0_by_idx[str(record.number)]
        a0 = a0_by_idx[str(record.number)]
        assert record.v_pu == pytest.approx(v0, abs=1e-12)
        # degrees(a0) computed independently of the builder.
        assert record.angle_deg == pytest.approx(a0 * 180.0 / math.pi, abs=1e-9)


def test_bus_types(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    types = {record.number: record.type for record in document.buses}
    # Bus 1 holds the Slack; buses 2, 3, 4 hold PV generators.
    assert types[1] == "ref"
    assert types[2] == "pv"
    assert types[3] == "pv"
    assert types[5] == "pq"


def test_lines_carry_the_files_values(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    snapshot = wrapper.topology_snapshot()
    assert len(document.lines) == len(snapshot.lines) == 11
    by_key = {record.key: record for record in document.lines}
    for entry in snapshot.lines:
        record = by_key[wrapper.keys().key_of("Line", entry.idx)]
        assert record.r_pu == pytest.approx(float(entry.params["r"]), abs=1e-12)
        assert record.x_pu == pytest.approx(float(entry.params["x"]), abs=1e-12)
        assert record.b_pu == pytest.approx(float(entry.params["b"]), abs=1e-12)
        # kundur.raw gives no branch a rating: rate_a is 0.0, kept as 0.0.
        assert record.rate_a_mva == 0.0
        assert record.ckt


def test_transformers_split_and_tap(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    snapshot = wrapper.topology_snapshot()
    assert len(document.transformers) == len(snapshot.transformers) == 4
    by_key = {record.key: record for record in document.transformers}
    for entry in snapshot.transformers:
        record = by_key[wrapper.keys().key_of("Line", entry.idx)]
        assert record.tap == pytest.approx(float(entry.params["tap"]), abs=1e-12)
        phi = float(entry.params["phi"])
        assert record.shift_deg == pytest.approx(
            phi * 180.0 / math.pi, abs=1e-12
        )
        assert record.vn_from_kv == pytest.approx(20.0)
        assert record.vn_to_kv == pytest.approx(230.0)
        # CZ=1 in the file: the impedance is on the system base, which is the
        # rating ANDES gives the transformer.
        assert record.rate_mva == 100.0
    # The file's numbers: R 0.001, X 0.012 for every transformer.
    assert by_key["branch:1-5-1"].r_pu == pytest.approx(0.001)
    assert by_key["branch:1-5-1"].x_pu == pytest.approx(0.012)


def _kundur_variant(tmp_path: Path) -> Path:
    """Kundur with transformer 1-5 given on its own 900 MVA winding base
    (CZ=2: R 0.009, X 0.108, which is 0.001 and 0.012 on 100 MVA) and a fixed
    shunt of 200 MVAr at bus 7."""
    text = _kundur().read_text()
    old_header = "     1,     5,     0,'1 ',1,1,1,"
    old_impedance = " 1.00000E-3, 1.20000E-2,   100.00"
    old_shunts = " 0 /End of Fixed shunt data"
    for old in (old_header, old_impedance, old_shunts):
        assert old in text, old
    text = text.replace(old_header, "     1,     5,     0,'1 ',1,2,1,", 1)
    text = text.replace(old_impedance, " 9.00000E-3, 1.08000E-1,   900.00", 1)
    text = text.replace(old_shunts, "     7,'1 ',1,     0.000,   200.000\n" + old_shunts, 1)
    case = tmp_path / "kundur.raw"
    case.write_text(text)
    return case


def test_bases_are_stated_and_a_power_flow_does_not_change_them(tmp_path: Path) -> None:
    """A transformer keeps its own rating and the values the case gave on it,
    a shunt is on the system base whatever its own rating, and the document
    is the same before and after ``setup()`` has put ANDES's values on the
    system base (``System.calc_pu_coeff``)."""
    case = _kundur_variant(tmp_path)
    w = Wrapper(workspace=str(tmp_path), session_id="t", owner_pid=None)
    w.load_case(str(case))
    ss = w._require_loaded()  # noqa: SLF001
    # The shunt rated at 200 MVA: the same 200 MVAr is 1.0 pu on its own base.
    ss.Shunt.Sn.v[0] = 200.0
    ss.Shunt.b.v[0] = 1.0

    before = build_case_document(w)
    transformer = next(t for t in before.transformers if t.key == "branch:1-5-1")
    assert transformer.rate_mva == 900.0
    assert transformer.r_pu == pytest.approx(0.009)
    assert transformer.x_pu == pytest.approx(0.108)
    # Its other three are still on the system base.
    assert {t.rate_mva for t in before.transformers if t.key != "branch:1-5-1"} == {100.0}
    [shunt] = before.shunts
    assert shunt.bus == 7
    assert shunt.b_mvar == pytest.approx(200.0)
    assert shunt.g_mw == pytest.approx(0.0)

    w.run_pflow()
    assert ss.is_setup
    # ANDES now holds the transformer's x on the system base.
    assert float(ss.Line.x.v[list(ss.Line.idx.v).index(_line_idx(w, "branch:1-5-1"))]) == (
        pytest.approx(0.012)
    )
    after = build_case_document(w)
    assert after.transformers == before.transformers
    assert after.lines == before.lines
    assert after.shunts == before.shunts
    assert after.loads == before.loads
    assert after.generators == before.generators


def _line_idx(w: Wrapper, key: str) -> object:
    for entry in w.keys().entries():
        if entry.key == key:
            return entry.idx
    raise AssertionError(key)


def test_dynamics_records_of_a_dyr(tmp_path: Path) -> None:
    """With kundur_full.dyr each generating unit's models are listed under
    its unit, by role, and the note says the values are not in this version."""
    case = tmp_path / "kundur.raw"
    case.write_bytes(_kundur().read_bytes())
    dyr = tmp_path / "kundur_full.dyr"
    dyr.write_bytes((_kundur().parent / "kundur_full.dyr").read_bytes())
    w = Wrapper(workspace=str(tmp_path), session_id="t", owner_pid=None)
    w.load_case(str(case), addfiles=[str(dyr)])
    document = build_case_document(w)
    units = {record.key for record in document.generators}
    by_unit: dict[str, set[str]] = {}
    for record in document.dynamics:
        assert record.unit in units
        assert record.key.startswith(record.unit + "/")
        assert record.values is None
        by_unit.setdefault(record.unit, set()).add(record.role)
    assert set(by_unit) == units
    assert all("machine" in roles for roles in by_unit.values())
    assert any(note.startswith("dynamic model parameters") for note in document.notes)
    assert document.source is not None
    assert document.source.files == ["kundur.raw", "kundur_full.dyr"]


def test_generators_in_mw(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    snapshot = wrapper.topology_snapshot()
    statics = [e for e in snapshot.generators if e.kind in ("PV", "Slack")]
    assert len(document.generators) == len(statics) == 4
    by_key = {record.key: record for record in document.generators}
    ss = wrapper._require_loaded()  # noqa: SLF001
    q0_by_idx: dict[str, float] = {}
    for model_name in ("PV", "Slack"):
        model = getattr(ss, model_name)
        for idx, q0 in zip(model.idx.v, model.q0.v, strict=True):
            q0_by_idx[str(idx)] = float(q0)
    for entry in statics:
        record = by_key[wrapper.keys().key_of(entry.kind, entry.idx)]
        # p0 is per unit on 100 MVA; p_mw is p0 * 100, computed independently.
        assert record.p_mw == pytest.approx(float(entry.params["p0"]) * 100.0, rel=1e-9)
        assert record.q_mvar == pytest.approx(q0_by_idx[str(entry.idx)] * 100.0, rel=1e-9)
        assert record.v_set_pu == pytest.approx(float(entry.params["v0"]), abs=1e-12)
        assert record.mbase_mva == pytest.approx(float(entry.params["Sn"]))
        assert record.id == "1"
    # The units are listed in bus order, as the file has them.
    assert [record.bus for record in document.generators] == [1, 2, 3, 4]


def test_loads_are_constant_power(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    assert len(document.loads) == 2
    by_key = {record.key: record for record in document.loads}
    load = by_key["load:7-2"]
    # kundur.raw: the load of id 2 at bus 7, P 1159 MW, Q -73.5 MVAr.
    assert load.p_mw == pytest.approx(1159.0)
    assert load.q_mvar == pytest.approx(-73.5)
    # ANDES's PQ is constant power in the file: [0, 0, 1] for both.
    assert load.zip is not None
    assert load.zip.p == [0.0, 0.0, 1.0]
    assert load.zip.q == [0.0, 0.0, 1.0]


def test_dynamics_records_and_note(wrapper: Wrapper) -> None:
    # kundur.raw alone carries no dynamics; the document says so by absence.
    document = build_case_document(wrapper)
    assert document.dynamics == []
    assert all("dynamic model parameters" not in note for note in document.notes)


def test_keys_equal_the_session_keys(wrapper: Wrapper) -> None:
    document = build_case_document(wrapper)
    book_keys = {
        entry.key
        for entry in wrapper.keys().entries()
        if entry.bucket in ("bus", "line", "transformer", "generator", "load", "shunt")
    }
    document_keys = {
        record.key
        for record in (
            *document.buses,
            *document.lines,
            *document.transformers,
            *document.generators,
            *document.loads,
            *document.shunts,
        )
    }
    assert document_keys == book_keys


def test_no_case_loaded(tmp_path: Path) -> None:
    w = Wrapper(workspace=str(tmp_path), session_id="t", owner_pid=None)
    with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
        build_case_document(w)
