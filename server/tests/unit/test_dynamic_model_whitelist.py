"""Unit 15 — the R15 dynamic-model whitelist expansion.

Nine controller classes were added to ``_PARAMS_BY_MODEL`` /
``_CONTROLLER_MODEL_NAMES`` / ``_REFERENCE_ATTRS``. Their param metadata is
introspected from the real ANDES 2.0 model classes, so these tests assert the
static whitelist matches live andes (catching drift or transcription errors).

PSS/E names ST6BU / PSS2A have no ANDES class; they map to ANDES-native
siblings ESST1A / ST2CUT.
"""

from __future__ import annotations

import andes
import pytest
from andes.core.param import ExtParam

from andes_app.core.wrapper import (
    _CONTROLLER_MODEL_NAMES,
    _PARAMS_BY_MODEL,
    _REFERENCE_ATTRS,
)

# The R15 set, using the ANDES-native names (ST6BU->ESST1A, PSS2A->ST2CUT).
NEW_MODELS = [
    "EXST1",
    "ESST1A",
    "GAST",
    "HYGOV",
    "IEESGO",
    "ST2CUT",
    "REGCP1",
    "REECA1",
    "REPCA1",
]


@pytest.fixture(scope="module")
def system() -> andes.System:
    return andes.System()


def _expected_param_names(model: str, system: andes.System) -> list[str]:
    """idx + name + every non-Ext input param except the ``u`` flag — the same
    selection the whitelist uses."""
    m = system.models[model]
    names = ["idx", "name"]
    for name, param in m.params.items():
        if name in ("idx", "name", "u") or isinstance(param, ExtParam):
            continue
        names.append(name)
    return names


@pytest.mark.parametrize("model", NEW_MODELS)
def test_model_registered_everywhere(model: str) -> None:
    assert model in _PARAMS_BY_MODEL, f"{model} missing from _PARAMS_BY_MODEL"
    assert model in _CONTROLLER_MODEL_NAMES
    assert model in _REFERENCE_ATTRS  # dependents-coverage invariant


@pytest.mark.parametrize("model", NEW_MODELS)
def test_idx_and_name_lead(model: str) -> None:
    metas = _PARAMS_BY_MODEL[model]
    assert len(metas) >= 3
    assert metas[0].name == "idx" and metas[0].kind == "string" and metas[0].required
    assert metas[1].name == "name" and metas[1].kind == "string" and metas[1].required


@pytest.mark.parametrize("model", NEW_MODELS)
def test_param_names_match_real_andes(model: str, system: andes.System) -> None:
    got = [p.name for p in _PARAMS_BY_MODEL[model]]
    assert got == _expected_param_names(model, system)


@pytest.mark.parametrize("model", NEW_MODELS)
def test_kinds_well_formed(model: str, system: andes.System) -> None:
    for p in _PARAMS_BY_MODEL[model]:
        assert p.kind in ("string", "number", "bus_idx")
        # bus references render with the bus picker
        if p.name in ("bus", "bus1", "bus2"):
            assert p.kind == "bus_idx"


def test_regcp1_bus_is_a_dependent_reference() -> None:
    # REGCP1 attaches to a Bus directly, so deleting a Bus must surface it.
    assert _REFERENCE_ATTRS["REGCP1"] == ("bus",)
