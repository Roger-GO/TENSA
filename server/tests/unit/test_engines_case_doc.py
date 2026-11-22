"""Unit tests of the case document models and of ``validate_case_document``."""

from __future__ import annotations

import pytest

from tensa.engines.case_doc import (
    TENSA_CASE_VERSION,
    BusRecord,
    CaseDocument,
    CaseDocumentError,
    DynamicRecord,
    upgrade_case_document,
    validate_case_document,
)


def _minimal_document() -> dict:
    """The smallest document that exercises every list, as plain JSON."""
    return {
        "tensa_case": 1,
        "name": "mini",
        "base_mva": 100.0,
        "freq_hz": 60.0,
        "source": {"format": "psse-raw", "files": ["mini.raw"], "sha256": None},
        "buses": [
            {"key": "bus:1", "number": 1, "type": "ref", "vn_kv": 20.0},
            {"key": "bus:2", "number": 2, "type": "pq"},
        ],
        "lines": [
            {"key": "branch:1-2-1", "from": 1, "to": 2, "ckt": "1", "r_pu": 0.01}
        ],
        "transformers": [],
        "generators": [
            {"key": "gen:1-1", "bus": 1, "id": "1", "p_mw": 100.0}
        ],
        "loads": [
            {
                "key": "load:2-1",
                "bus": 2,
                "id": "1",
                "p_mw": 50.0,
                "zip": {"p": [0.0, 0.0, 1.0], "q": [0.0, 0.0, 1.0]},
            }
        ],
        "shunts": [{"key": "shunt:2-1", "bus": 2, "id": "1", "b_mvar": 10.0}],
        "dynamics": [
            {
                "key": "gen:1-1/machine",
                "unit": "gen:1-1",
                "role": "machine",
                "model": "GENROU",
                "values": [8.0, 0.03, 0.4, 0.05, 6.5, 0.0, 1.8, 1.7, 0.3, 0.55, 0.25, 0.06, 0.0, 0.0],
                "names": ["T'do", "T''do", "T'qo", "T''qo", "H", "D", "Xd", "Xq", "X'd", "X'q", "X''d", "Xl", "S(1.0)", "S(1.2)"],
            }
        ],
        "events": [],
        "notes": [],
        "ext": {},
    }


def test_minimal_document_round_trips_with_the_specs_json_names() -> None:
    document = CaseDocument.model_validate(_minimal_document())
    dumped = document.model_dump(mode="json", by_alias=True)
    assert dumped["tensa_case"] == 1
    assert dumped["lines"][0]["from"] == 1
    assert dumped["lines"][0]["to"] == 2
    assert "from_bus" not in dumped["lines"][0]
    assert dumped["loads"][0]["zip"] == {"p": [0.0, 0.0, 1.0], "q": [0.0, 0.0, 1.0]}
    again = CaseDocument.model_validate(dumped)
    assert again == document


def test_validate_accepts_the_minimal_document() -> None:
    document = validate_case_document(_minimal_document())
    assert isinstance(document, CaseDocument)
    assert document.name == "mini"


def test_validate_accepts_null_values_and_names() -> None:
    data = _minimal_document()
    data["dynamics"][0]["values"] = None
    data["dynamics"][0]["names"] = None
    document = validate_case_document(data)
    assert document.dynamics[0].values is None
    assert document.dynamics[0].names is None


def test_validate_refuses_a_newer_major_version() -> None:
    data = _minimal_document()
    data["tensa_case"] = 2
    with pytest.raises(CaseDocumentError, match="tensa_case 2"):
        validate_case_document(data)


def test_validate_refuses_a_duplicate_key() -> None:
    data = _minimal_document()
    data["buses"].append({"key": "bus:1", "number": 9, "type": "pq"})
    with pytest.raises(CaseDocumentError, match="bus:1"):
        validate_case_document(data)


def test_validate_refuses_a_dangling_bus_reference() -> None:
    data = _minimal_document()
    data["lines"][0]["from"] = 99
    with pytest.raises(CaseDocumentError, match="99"):
        validate_case_document(data)


def test_validate_refuses_a_zip_that_does_not_sum_to_one() -> None:
    data = _minimal_document()
    data["loads"][0]["zip"] = {"p": [0.5, 0.5, 0.5], "q": [0.0, 0.0, 1.0]}
    with pytest.raises(CaseDocumentError, match="1.5"):
        validate_case_document(data)


def test_validate_refuses_a_sienna_record_without_params() -> None:
    data = _minimal_document()
    data["dynamics"][0]["vocabulary"] = "sienna"
    data["dynamics"][0]["values"] = None
    data["dynamics"][0]["names"] = None
    with pytest.raises(CaseDocumentError, match="params"):
        validate_case_document(data)


def test_validate_accepts_a_sienna_record_with_params() -> None:
    data = _minimal_document()
    data["dynamics"][0]["vocabulary"] = "sienna"
    data["dynamics"][0]["values"] = None
    data["dynamics"][0]["names"] = None
    data["dynamics"][0]["params"] = {"H": 6.5}
    document = validate_case_document(data)
    assert document.dynamics[0].params == {"H": 6.5}


def test_validate_refuses_a_dangling_unit_reference() -> None:
    data = _minimal_document()
    data["dynamics"][0]["unit"] = "gen:9-1"
    with pytest.raises(CaseDocumentError, match="gen:9-1"):
        validate_case_document(data)


def test_extra_fields_are_forbidden() -> None:
    data = _minimal_document()
    data["buses"][0]["voltage"] = 1.0
    with pytest.raises(CaseDocumentError):
        validate_case_document(data)


def test_what_the_case_does_not_give_is_null_never_a_default() -> None:
    bus = BusRecord(key="bus:1", number=1, type="pq")
    assert bus.vn_kv is None
    assert bus.area is None
    assert bus.zone is None
    document = CaseDocument(name="x")
    assert document.base_mva is None
    assert document.freq_hz is None
    assert document.tensa_case == TENSA_CASE_VERSION


def test_upgrade_returns_other_versions_unchanged() -> None:
    data = _minimal_document()
    assert upgrade_case_document(data) == data
    record = DynamicRecord(key="gen:1-1/machine", unit="gen:1-1", role="machine", model="GENROU")
    assert record.values is None
    assert record.vocabulary == "psse"


def test_series_field_is_null_by_default() -> None:
    document = CaseDocument(name="x")
    assert document.series is None
    dumped = document.model_dump()
    assert dumped["series"] is None
