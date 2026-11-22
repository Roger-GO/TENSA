"""Parity: the two engines' case documents for kundur.raw agree field by field."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tensa.core.wrapper import Wrapper
from tensa.engines.andes.case_doc import build_case_document as build_andes
from tensa.engines.identity import read_identity
from tensa.engines.keys import KeyBook
from tensa.engines.sienna.case_doc import build_case_document as build_sienna
from tensa.engines.sienna.keys import assign_sienna_keys

SAMPLES = Path(__file__).parent / "sienna_samples"


def _kundur() -> Path:
    import andes

    return Path(andes.__file__).parent / "cases" / "kundur" / "kundur.raw"


@pytest.fixture()
def documents(tmp_path: Path) -> tuple:
    case = tmp_path / "kundur.raw"
    case.write_bytes(_kundur().read_bytes())
    wrapper = Wrapper(workspace=str(tmp_path), session_id="t", owner_pid=None)
    wrapper.load_case(str(case))
    andes_doc = build_andes(wrapper)

    topology = json.loads((SAMPLES / "kundur.topology.json").read_text())
    report = json.loads((SAMPLES / "kundur.report.json").read_text())
    identity = read_identity(case)
    book = assign_sienna_keys(topology, identity, KeyBook())
    sienna_doc = build_sienna(topology, report, None, identity, book, case, None)
    return andes_doc, sienna_doc


def test_same_keys_in_the_same_order(documents: tuple) -> None:
    andes_doc, sienna_doc = documents
    for name in ("buses", "lines", "transformers", "generators", "loads", "shunts"):
        andes_keys = [r.key for r in getattr(andes_doc, name)]
        sienna_keys = [r.key for r in getattr(sienna_doc, name)]
        assert andes_keys == sienna_keys, name


def test_header_fields_agree(documents: tuple) -> None:
    andes_doc, sienna_doc = documents
    assert andes_doc.base_mva == sienna_doc.base_mva == 100.0
    assert andes_doc.freq_hz == sienna_doc.freq_hz == 60.0
    assert andes_doc.name == sienna_doc.name == "kundur"


def test_buses_agree(documents: tuple) -> None:
    andes_doc, sienna_doc = documents
    for a, s in zip(andes_doc.buses, sienna_doc.buses, strict=True):
        assert a.number == s.number
        assert a.vn_kv == s.vn_kv
        assert a.type == s.type
        assert a.v_pu == pytest.approx(s.v_pu, abs=1e-9)
        # Both sides convert to degrees from their own stored angle.
        assert a.angle_deg == pytest.approx(s.angle_deg, abs=1e-6)
        # Sienna's JSON carries no area or zone: null on that side.
        assert s.area is None
        assert s.zone is None


def test_lines_agree(documents: tuple) -> None:
    andes_doc, sienna_doc = documents
    for a, s in zip(andes_doc.lines, sienna_doc.lines, strict=True):
        assert (a.from_bus, a.to_bus, a.ckt) == (s.from_bus, s.to_bus, s.ckt)
        assert a.r_pu == pytest.approx(s.r_pu, rel=1e-9)
        assert a.x_pu == pytest.approx(s.x_pu, rel=1e-9)
        assert a.b_pu == pytest.approx(s.b_pu, rel=1e-9)
        assert a.in_service == s.in_service


def _on_system_base(document: object, record: object, value: float) -> float:
    """A transformer impedance of a record put on the system base and the
    from bus's voltage, from the bases the record states."""
    bus_vn = {bus.number: bus.vn_kv for bus in document.buses}  # type: ignore[attr-defined]
    zn = record.vn_from_kv**2 / record.rate_mva  # type: ignore[attr-defined]
    zb = bus_vn[record.from_bus] ** 2 / document.base_mva  # type: ignore[attr-defined]
    return value * zn / zb


def test_transformers_agree(documents: tuple) -> None:
    andes_doc, sienna_doc = documents
    for a, s in zip(andes_doc.transformers, sienna_doc.transformers, strict=True):
        assert (a.from_bus, a.to_bus, a.ckt) == (s.from_bus, s.to_bus, s.ckt)
        # Each states the base its numbers are on; on the system base they agree.
        assert a.rate_mva is not None and s.rate_mva is not None
        assert _on_system_base(andes_doc, a, a.r_pu) == pytest.approx(
            _on_system_base(sienna_doc, s, s.r_pu), rel=1e-9
        )
        assert _on_system_base(andes_doc, a, a.x_pu) == pytest.approx(
            _on_system_base(sienna_doc, s, s.x_pu), rel=1e-9
        )
        # kundur.raw: R 0.001, X 0.012 on the 100 MVA system base (CZ=1).
        assert _on_system_base(sienna_doc, s, s.x_pu) == pytest.approx(0.012)
        assert s.rate_mva == sienna_doc.base_mva
        assert a.tap == pytest.approx(s.tap, rel=1e-9)
        assert a.shift_deg == pytest.approx(s.shift_deg, abs=1e-6)
        assert a.vn_from_kv == s.vn_from_kv
        assert a.vn_to_kv == s.vn_to_kv


def test_generators_agree(documents: tuple) -> None:
    andes_doc, sienna_doc = documents
    for a, s in zip(andes_doc.generators, sienna_doc.generators, strict=True):
        assert (a.bus, a.id) == (s.bus, s.id)
        assert a.p_mw == pytest.approx(s.p_mw, rel=1e-9)
        assert a.q_mvar == pytest.approx(s.q_mvar, rel=1e-9)
        assert a.v_set_pu == pytest.approx(s.v_set_pu, abs=1e-9)
        assert a.mbase_mva == pytest.approx(s.mbase_mva, rel=1e-9)
        assert a.in_service == s.in_service


def test_loads_agree_exactly(documents: tuple) -> None:
    andes_doc, sienna_doc = documents
    for a, s in zip(andes_doc.loads, sienna_doc.loads, strict=True):
        assert (a.bus, a.id) == (s.bus, s.id)
        assert a.p_mw == s.p_mw
        assert a.q_mvar == s.q_mvar
        assert a.in_service == s.in_service
    # ANDES's PQ is constant power in the file: [0, 0, 1] for both. The Sienna
    # JSON carries no split, so its side is null.
    assert all(record.zip is not None for record in andes_doc.loads)
    assert all(record.zip is None for record in sienna_doc.loads)


def test_both_carry_the_files_numbers(documents: tuple) -> None:
    """Agreement alone would pass two builders that are wrong the same way:
    each document is also held to kundur.raw's own numbers."""
    for document in documents:
        buses = {bus.number: bus for bus in document.buses}
        assert buses[1].type == "ref"
        assert buses[1].angle_deg == pytest.approx(32.6732)
        assert buses[5].v_pu == pytest.approx(0.98337)
        # Areas 1 and 2 name buses 1 and 3 as their swing buses.
        assert {n for n, bus in buses.items() if bus.area_slack} == {1, 3}
        line = next(r for r in document.lines if r.key == "branch:7-8-2")
        assert (line.r_pu, line.x_pu, line.b_pu) == pytest.approx((0.02202, 0.22002, 0.33))
        generator = next(r for r in document.generators if r.key == "gen:1-1")
        assert generator.p_mw == pytest.approx(745.861)
        assert generator.q_mvar == pytest.approx(143.612)
        assert (generator.q_min_mvar, generator.q_max_mvar) == pytest.approx((0.0, 600.0))
        assert generator.mbase_mva == pytest.approx(900.0)
        load = next(r for r in document.loads if r.key == "load:8-1")
        assert (load.p_mw, load.q_mvar) == pytest.approx((1575.0, -89.9))


def test_key_sets_are_equal(documents: tuple) -> None:
    andes_doc, sienna_doc = documents

    def keys_of(document: object) -> set[str]:
        return {
            record.key
            for name in ("buses", "lines", "transformers", "generators", "loads", "shunts")
            for record in getattr(document, name)
        }

    assert keys_of(andes_doc) == keys_of(sienna_doc)
