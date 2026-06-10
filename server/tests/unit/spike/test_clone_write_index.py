"""Unit 0 — schema + drift validation for the clone-write index.

Validates ``docs/spikes/2026-05-29-clone-write-index.json`` against (a) its own
schema and (b) live ANDES: every editable param must exist on the model, and
every ``dyr`` field_index must point at the named field in the model's
``psse-dyr.yaml`` inputs order. This is a drift guard — if ANDES renames a
param or reorders a .dyr record, Unit 21's writer would corrupt files; this
test fails first.
"""

from __future__ import annotations

import json
import os

import andes
import pytest
import yaml

from andes_app.core.wrapper import _CONTROLLER_MODEL_NAMES, _PARAMS_BY_MODEL

_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
_INDEX_PATH = os.path.join(_REPO_ROOT, "docs", "spikes", "2026-05-29-clone-write-index.json")


@pytest.fixture(scope="module")
def index() -> dict:
    if not os.path.exists(_INDEX_PATH):
        pytest.skip(
            "clone-write index artifact not present in this checkout "
            f"({_INDEX_PATH})"
        )
    with open(_INDEX_PATH) as fh:
        return json.load(fh)


@pytest.fixture(scope="module")
def dyr_yaml() -> dict:
    path = os.path.join(os.path.dirname(andes.__file__), "io", "psse-dyr.yaml")
    with open(path) as fh:
        return yaml.safe_load(fh)


def _editable_param_names(model: str) -> set[str]:
    return {p.name for p in _PARAMS_BY_MODEL.get(model, ()) if p.kind == "number"}


def test_top_level_schema(index: dict) -> None:
    assert index["schema_version"] == 1
    assert isinstance(index["models"], dict) and index["models"]
    assert set(index["formats"]) == {"xlsx", "dyr", "raw"}


def test_every_whitelisted_model_present(index: dict) -> None:
    for model in _CONTROLLER_MODEL_NAMES:
        if _editable_param_names(model):
            assert model in index["models"], f"{model} missing from clone-write index"


def test_xlsx_op_is_total_and_well_formed(index: dict) -> None:
    for model, spec in index["models"].items():
        assert spec["xlsx"] == {"sheet": model, "idx_column": "idx"}
        # Every editable ANDES param has an xlsx edit op naming its own column.
        editable = _editable_param_names(model)
        assert set(spec["params"]) == editable, f"{model}: index params != editable params"
        for param, ops in spec["params"].items():
            assert ops["xlsx"] == {"column": param}


def test_param_kinds_are_numbers_only(index: dict) -> None:
    # Reference / identity params must never appear (they are immutable).
    for model, spec in index["models"].items():
        metas = {p.name: p.kind for p in _PARAMS_BY_MODEL[model]}
        for param in spec["params"]:
            assert metas[param] == "number"
        for forbidden in ("idx", "name", "syn", "avr", "reg", "ree", "bus", "gen"):
            assert forbidden not in spec["params"], f"{model}.{forbidden} must not be editable"


def test_dyr_field_index_matches_live_yaml(index: dict, dyr_yaml: dict) -> None:
    """Each dyr op's field_index must point at its named field in live ANDES."""
    for model, spec in index["models"].items():
        record = spec["dyr"]
        if record is None:
            # No dyr record → no param may claim a dyr op.
            assert all(p["dyr"] is None for p in spec["params"].values())
            continue
        inputs = dyr_yaml[model]["inputs"]
        assert record["inputs"] == inputs
        for param, ops in spec["params"].items():
            dyr = ops["dyr"]
            if dyr is None:
                continue
            assert inputs[dyr["field_index"]] == dyr["field"], (
                f"{model}.{param}: field_index {dyr['field_index']} is "
                f"{inputs[dyr['field_index']]!r}, expected {dyr['field']!r}"
            )


def test_coverage_meets_gate(index: dict) -> None:
    total = sum(len(m["params"]) for m in index["models"].values())
    dyr_ok = sum(1 for m in index["models"].values() for p in m["params"].values() if p["dyr"])
    # xlsx is total; dyr must clear the spike's 80% gate.
    assert total > 0
    assert dyr_ok / total >= 0.80, f"dyr coverage {dyr_ok}/{total} below 80% gate"
