"""Unit tests of the study document model (``tensa.engines.study_doc``)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from tensa.engines.study_doc import (
    Disturbance,
    RecordSpec,
    StudyDocument,
    engines_refusing,
)


def test_minimal_pflow_study() -> None:
    study = StudyDocument.model_validate({"tensa_study": 1, "routine": "pflow"})
    assert study.options == {}
    assert study.disturbances == []
    assert study.record == []
    assert study.load_model is None
    assert study.ext == {}


def test_version_zero_refused() -> None:
    with pytest.raises(ValidationError, match="at least 1"):
        StudyDocument.model_validate({"tensa_study": 0, "routine": "pflow"})


def test_newer_major_refused() -> None:
    with pytest.raises(
        ValidationError,
        match="tensa_study version 2 is newer than this server reads \\(1\\)",
    ):
        StudyDocument.model_validate({"tensa_study": 2, "routine": "pflow"})


def test_unknown_routine_refused() -> None:
    with pytest.raises(ValidationError):
        StudyDocument.model_validate({"tensa_study": 1, "routine": "cpf"})


def test_load_model_only_for_tds_eig() -> None:
    with pytest.raises(
        ValidationError, match="load_model belongs to tds and eig, not pflow"
    ):
        StudyDocument.model_validate(
            {"tensa_study": 1, "routine": "pflow", "load_model": "impedance"}
        )


def test_disturbances_only_for_tds() -> None:
    with pytest.raises(
        ValidationError, match="disturbances belong to a tds study, not eig"
    ):
        StudyDocument.model_validate(
            {
                "tensa_study": 1,
                "routine": "eig",
                "disturbances": [{"kind": "branch_trip", "target": "branch:7-8-1", "t": 1.0}],
            }
        )


def test_record_only_for_tds() -> None:
    with pytest.raises(ValidationError, match="record belongs to a tds study, not pflow"):
        StudyDocument.model_validate(
            {
                "tensa_study": 1,
                "routine": "pflow",
                "record": [{"quantity": "voltage", "of": "bus:*"}],
            }
        )


def test_bus_fault_fields() -> None:
    fault = Disturbance.model_validate(
        {
            "kind": "bus_fault",
            "bus": "bus:8",
            "t_on": 1.0,
            "t_clear": 1.1,
            "r_pu": 0.0,
            "x_pu": 0.0001,
        }
    )
    assert fault.bus == "bus:8"
    with pytest.raises(ValidationError, match="t_clear must be greater than t_on"):
        Disturbance.model_validate(
            {
                "kind": "bus_fault",
                "bus": "bus:8",
                "t_on": 1.0,
                "t_clear": 0.9,
                "r_pu": 0.0,
                "x_pu": 0.0001,
            }
        )
    with pytest.raises(ValidationError, match="takes no field 'target'"):
        Disturbance.model_validate(
            {
                "kind": "bus_fault",
                "bus": "bus:8",
                "target": "bus:8",
                "t_on": 1.0,
                "t_clear": 1.1,
                "r_pu": 0.0,
                "x_pu": 0.0001,
            }
        )


def test_branch_trip_needs_target_key() -> None:
    with pytest.raises(ValidationError, match="needs a target key"):
        Disturbance.model_validate({"kind": "branch_trip", "t": 1.0})
    with pytest.raises(ValidationError, match="needs a target key"):
        Disturbance.model_validate({"kind": "branch_trip", "target": "7-8-1", "t": 1.0})


def test_record_wildcard() -> None:
    spec = RecordSpec.model_validate({"quantity": "rotor_speed", "of": "gen:*"})
    assert spec.of == "gen:*"
    with pytest.raises(ValidationError, match="not a series quantity"):
        RecordSpec.model_validate({"quantity": "eigenvalue", "of": "gen:*"})
    with pytest.raises(ValidationError, match="must be a key or <kind>:\\*"):
        RecordSpec.model_validate({"quantity": "voltage", "of": "7"})


def test_ext_names_an_engine() -> None:
    with pytest.raises(ValidationError, match="is not an engine this server knows"):
        StudyDocument.model_validate(
            {"tensa_study": 1, "routine": "pflow", "ext": {"pandapower": {}}}
        )


def test_engines_refusing() -> None:
    matrices = StudyDocument.model_validate({"tensa_study": 1, "routine": "matrices"})
    dispatch = StudyDocument.model_validate({"tensa_study": 1, "routine": "dispatch"})
    pflow = StudyDocument.model_validate({"tensa_study": 1, "routine": "pflow"})
    assert engines_refusing(matrices) == ["andes"]
    assert engines_refusing(dispatch) == ["andes"]
    assert engines_refusing(pflow) == []


def test_extra_field_forbidden() -> None:
    with pytest.raises(ValidationError):
        StudyDocument.model_validate(
            {"tensa_study": 1, "routine": "pflow", "surprise": True}
        )
