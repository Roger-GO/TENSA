"""Unit tests for the fidelity module: the register, the states, the entries.

No Julia and no worker; the register and the audit register are read from
temporary files where a test needs a malformed or a filled one.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tensa.engines import fidelity
from tensa.engines.fidelity import (
    COMMON_MODELS,
    fidelity_entries,
    load_audited_models,
    load_known_differences,
    model_state,
    models_map,
)


def _entry(**overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "id": "tgov1-torque",
        "model": "TGOV1",
        "engines": ["andes", "sienna"],
        "summary": "Sienna hands the machine a torque of P_m / omega.",
        "effect": "Sienna is more damped.",
        "small_signal": True,
        "evidence": "Kundur, GENROU + TGOV1.",
        "check": "server/tests/integration/test_known_differences.py::test_tgov1_torque",
    }
    entry.update(overrides)
    return entry


def _write(tmp_path: Path, rows: list[dict[str, object]]) -> Path:
    file = tmp_path / "known_differences.json"
    file.write_text(json.dumps(rows), encoding="utf-8")
    return file


def test_register_loads_its_entries() -> None:
    entries = {entry.id: entry for entry in load_known_differences()}
    assert set(entries) == {
        "tgov1-torque",
        "gast-torque",
        "hygov-torque",
        "esac1a-rate-feedback",
        "exac1-transducer",
        "exst1-output-limiter",
    }
    tgov1 = entries["tgov1-torque"]
    assert tgov1.model == "TGOV1"
    assert tgov1.engines == ("andes", "sienna")
    assert tgov1.small_signal is True
    assert tgov1.check.endswith("test_tgov1_torque")
    esac1a = entries["esac1a-rate-feedback"]
    assert esac1a.model == "ESAC1A"
    assert esac1a.check.endswith("test_esac1a_rate_feedback")


def test_register_rejects_a_duplicate_id(tmp_path: Path) -> None:
    path = _write(tmp_path, [_entry(), _entry()])
    with pytest.raises(ValueError, match="tgov1-torque"):
        load_known_differences(path)


def test_register_rejects_an_unknown_model(tmp_path: Path) -> None:
    path = _write(tmp_path, [_entry(model="NOTAMODEL")])
    with pytest.raises(ValueError, match="NOTAMODEL"):
        load_known_differences(path)


def test_register_rejects_a_missing_field(tmp_path: Path) -> None:
    row = _entry()
    del row["evidence"]
    path = _write(tmp_path, [row])
    with pytest.raises(ValueError, match="evidence"):
        load_known_differences(path)


def test_register_rejects_one_engine(tmp_path: Path) -> None:
    path = _write(tmp_path, [_entry(engines=["sienna"])])
    with pytest.raises(ValueError, match="engines"):
        load_known_differences(path)


def test_andes_common_models_are_exact() -> None:
    for model in COMMON_MODELS:
        assert model_state("andes", model, unsupported=False) == "exact"


def test_sienna_tgov1_is_the_known_difference() -> None:
    assert model_state("sienna", "TGOV1", unsupported=False) == (
        "known-difference:tgov1-torque"
    )


def test_sienna_other_common_models_are_exact_once_audited(monkeypatch: pytest.MonkeyPatch) -> None:
    differing = {entry.model for entry in fidelity.KNOWN_DIFFERENCES}
    monkeypatch.setattr(fidelity, "AUDITED_MODELS", frozenset())
    for model in sorted(COMMON_MODELS - differing):
        assert model_state("sienna", model, unsupported=False) == "unverified"
    monkeypatch.setattr(
        fidelity, "AUDITED_MODELS", frozenset(("sienna", model) for model in COMMON_MODELS)
    )
    for model in sorted(COMMON_MODELS - differing):
        assert model_state("sienna", model, unsupported=False) == "exact"
    # A known difference wins over an audit record.
    assert model_state("sienna", "TGOV1", unsupported=False) == "known-difference:tgov1-torque"


def test_a_sienna_only_model_is_unverified_and_every_andes_model_exact() -> None:
    """ANDES is the reference engine for every model it holds (spec section 8);
    a model only Sienna simulates stays unverified."""
    assert model_state("sienna", "GENROE", unsupported=False) == "unverified"
    assert model_state("andes", "EXDC2", unsupported=False) == "exact"


def test_a_sienna_dynamics_row_is_keyed_by_its_bus_and_record_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The topology JSON's dynamics rows carry the component name in
    ``generator``; the key comes from the bus and the record id."""
    monkeypatch.setattr(fidelity, "AUDITED_MODELS", frozenset())
    rows = [{"bus": 3, "id": "2", "model": "SEXS", "generator": "generator-3-2"}]
    assert [entry["key"] for entry in fidelity_entries("sienna", rows, [])] == ["gen:3-2/exciter"]


def test_unsupported_wins_over_exact() -> None:
    assert model_state("andes", "GENROU", unsupported=True) == "unsupported"


def test_audits_file_absent_means_no_audited_models(tmp_path: Path) -> None:
    assert load_audited_models(tmp_path / "model_audits.json") == frozenset()


def test_the_audit_register_names_sienna_models_only() -> None:
    for engine, model in fidelity.AUDITED_MODELS:
        assert engine == "sienna"
        assert model in COMMON_MODELS


def test_audited_model_becomes_exact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    file = tmp_path / "model_audits.json"
    file.write_text(
        json.dumps([{"engine": "sienna", "model": "GENROU", "test": "x.py::t"}]),
        encoding="utf-8",
    )
    audited = load_audited_models(file)
    assert audited == frozenset({("sienna", "GENROU")})
    monkeypatch.setattr(fidelity, "AUDITED_MODELS", audited)
    assert model_state("sienna", "GENROU", unsupported=False) == "exact"


def _dynamics() -> list[dict[str, object]]:
    return [
        {"model": "GENROU", "generator": "generator-1-1", "bus": 1, "id": "1"},
        {"model": "TGOV1", "generator": "generator-1-1", "bus": 1, "id": "1"},
    ]


def test_fidelity_entries_lists_only_non_exact(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fidelity, "AUDITED_MODELS", frozenset())
    # GENROU is unverified on Sienna (no audit yet) and TGOV1 is the known
    # difference; both are listed, sorted by key, so the governor comes before
    # the machine ("governor" < "machine"). Only an exact entry would be left
    # out, which the ANDES case of the next test pins.
    entries = fidelity_entries("sienna", _dynamics(), [])
    assert len(entries) == 2
    governor, machine = entries
    assert governor["key"] == "gen:1-1/governor"
    assert governor["model"] == "TGOV1"
    assert governor["state"] == "known-difference:tgov1-torque"
    assert governor["detail"] == (
        "Sienna hands the machine a torque of P_m / omega; ANDES hands it P_m."
    )
    assert "handling" not in governor
    assert machine["key"] == "gen:1-1/machine"
    assert machine["model"] == "GENROU"
    assert machine["state"] == "unverified"
    assert "handling" not in machine
    assert "detail" not in machine


def test_fidelity_entries_unsupported_row() -> None:
    rows = [{"model": "IEEET1", "bus": 1, "id": "1", "reason": "PSID has no model"}]
    entries = fidelity_entries("sienna", [], rows)
    assert entries == [
        {
            "key": "gen:1-1/exciter",
            "model": "IEEET1",
            "state": "unsupported",
            "handling": "dropped",
            "reason": "PSID has no model",
        }
    ]


def test_fidelity_entries_andes_case_is_empty() -> None:
    assert fidelity_entries("andes", _dynamics(), []) == []


def test_fidelity_entries_sorted_by_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fidelity, "AUDITED_MODELS", frozenset())
    dynamics = [
        {"model": "TGOV1", "generator": "generator-1-1", "bus": 1, "id": "1"},
        {"model": "SEXS", "generator": "generator-1-1", "bus": 1, "id": "1"},
    ]
    entries = fidelity_entries("sienna", dynamics, [])
    assert [entry["key"] for entry in entries] == [
        "gen:1-1/exciter",
        "gen:1-1/governor",
    ]


def test_models_map_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fidelity, "AUDITED_MODELS", frozenset())
    andes = models_map("andes")
    assert len(andes) == 14
    assert set(andes.values()) == {"exact"}
    sienna = models_map("sienna")
    assert sienna["TGOV1"] == "known-difference:tgov1-torque"
    assert sienna["GENROU"] == "unverified"


def test_common_models_matches_the_matrix() -> None:
    assert frozenset(
        {
            "ESAC1A",
            "ESST1A",
            "EXAC1",
            "EXST1",
            "SEXS",
            "IEEEST",
            "REECB1",
            "REGCA1",
            "REPCA1",
            "GENCLS",
            "GENROU",
            "GAST",
            "HYGOV",
            "TGOV1",
        }
    ) == COMMON_MODELS
    assert len(COMMON_MODELS) == 14
