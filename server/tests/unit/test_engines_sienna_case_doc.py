"""Unit tests of the Sienna case document builder, from the recorded samples."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from tensa.core.errors import NoCaseLoadedError
from tensa.engines.identity import read_identity
from tensa.engines.keys import KeyBook
from tensa.engines.sienna.case_doc import build_case_document
from tensa.engines.sienna.keys import assign_sienna_keys

SAMPLES = Path(__file__).parent / "sienna_samples"


def _andes_case(name: str) -> Path:
    import andes

    return Path(andes.__file__).parent / "cases" / "kundur" / name


def _build() -> tuple:
    topology = json.loads((SAMPLES / "kundur.topology.json").read_text())
    report = json.loads((SAMPLES / "kundur.report.json").read_text())
    case_path = _andes_case("kundur.raw")
    identity = read_identity(case_path)
    book = assign_sienna_keys(topology, identity, KeyBook())
    document = build_case_document(
        topology, report, None, identity, book, case_path, None
    )
    return document, topology, book


def test_base_mva_freq_and_bus_count() -> None:
    document, topology, _book = _build()
    assert document.base_mva == 100.0
    assert document.freq_hz == 60.0
    assert len(document.buses) == len(topology["buses"])
    assert document.name == "kundur"
    assert document.source is not None
    assert document.source.format == "psse-raw"
    assert document.source.files == ["kundur.raw"]


def test_bus_keys_and_angles() -> None:
    document, topology, book = _build()
    for record, row in zip(document.buses, topology["buses"], strict=True):
        assert record.key == book.key_of("Bus", row["number"])
        assert record.number == row["number"]
        # degrees(radians) computed independently of the builder.
        assert record.angle_deg == pytest.approx(
            row["angle_rad"] * 180.0 / math.pi, abs=1e-12
        )
        assert record.v_pu == row["v_pu"]
        assert record.vn_kv == row["vn_kv"]


def test_bus_types_from_the_generators() -> None:
    document, _topology, _book = _build()
    types = {record.number: record.type for record in document.buses}
    # Bus 1 holds the Slack generator; buses 2, 3, 4 hold PV ones.
    assert types[1] == "ref"
    assert types[2] == "pv"
    assert types[5] == "pq"


def test_branch_buckets_follow_the_json_kind_not_the_andes_rule() -> None:
    document, topology, _book = _build()
    json_transformers = [b for b in topology["branches"] if b["kind"] == "transformer"]
    json_lines = [b for b in topology["branches"] if b["kind"] != "transformer"]
    assert len(document.transformers) == len(json_transformers) == 4
    assert len(document.lines) == len(json_lines) == 11
    # Every transformer of the JSON has tap 1.0: an implementation that
    # classified by ANDES's tap rule would put them in lines.
    assert all(record.tap == 1.0 for record in document.transformers)


def test_rate_a_is_the_files_rating_not_the_invented_one() -> None:
    document, topology, _book = _build()
    # The corrections document is None here, so the JSON's rate_mva is used;
    # with one, file_ratings wins. The JSON's rates are PowerSystems' invented
    # ones (kundur.raw gives no branch a rating), thousands of MVA.
    by_key = {record.key: record for record in document.lines}
    line = by_key["branch:5-6-1"]
    assert line.rate_a_mva == pytest.approx(2407.995106993262)


def test_transformer_voltages_come_from_the_buses() -> None:
    document, _topology, _book = _build()
    record = next(r for r in document.transformers if r.key == "branch:1-5-1")
    assert record.vn_from_kv == 20.0
    assert record.vn_to_kv == 230.0
    assert record.shift_deg == pytest.approx(0.0, abs=1e-12)


def test_generator_ids_and_keys() -> None:
    document, _topology, _book = _build()
    first = document.generators[0]
    assert first.key == "gen:1-1"
    assert first.id == "1"
    assert first.p_mw == pytest.approx(745.861)
    assert first.mbase_mva == 900.0


def test_loads_carry_their_powers_and_no_zip_without_one() -> None:
    document, _topology, _book = _build()
    by_key = {record.key: record for record in document.loads}
    load = by_key["load:7-2"]
    assert load.p_mw == 1159.0
    assert load.q_mvar == -73.5
    # The recorded topology JSON carries no ZIP split: null, never a default.
    assert load.zip is None


def test_freq_hz_null_stays_null() -> None:
    topology = json.loads((SAMPLES / "kundur.topology.json").read_text())
    topology["freq_hz"] = None
    case_path = _andes_case("kundur.raw")
    book = assign_sienna_keys(topology, read_identity(case_path), KeyBook())
    document = build_case_document(topology, {}, None, None, book, case_path, None)
    assert document.freq_hz is None


def test_no_case_loaded_raises() -> None:
    from tensa.engines.sienna.state import SiennaState

    state = SiennaState(workspace=None, session_id=None, owner_pid=None)
    with pytest.raises(NoCaseLoadedError, match="no case has been loaded"):
        state.case_document_parts()
