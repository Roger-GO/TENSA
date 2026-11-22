"""The neutral naming of an ANDES time-domain run's series (unit p6-f).

``state_name_andes`` renames a ``dae_vars`` variable ``state|<key>#<variable>``;
the relative quantities of ``tensa.engines.frames`` are computed by hand here
and held to the functions. Key books are built the way
``test_engines_series_names.py`` builds them; no engine.
"""

from __future__ import annotations

import numpy as np
import pytest

from tensa.engines.frames import angle_rel, rotor_angle_rel
from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.series_names import (
    build_state_name,
    neutral_name_andes,
    parse_name,
    parse_state_name,
    state_name_andes,
)

pytestmark = pytest.mark.unit


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("bus:7", "bus", "Bus", 7, "file"))
    book.assign(KeyEntry("bus:1", "bus", "Bus", 1, "file"))
    book.assign(KeyEntry("gen:1-1", "generator", "PV", 1, "file"))
    book.assign(KeyEntry("gen:1-1/machine", "dynamic", "GENROU", 1, "engine"))
    book.assign(KeyEntry("gen:2-1", "generator", "PV", 2, "file"))
    book.assign(KeyEntry("gen:2-1/machine", "dynamic", "GENROU", 2, "engine"))
    return book


def test_bus_column_renamed() -> None:
    assert neutral_name_andes("Bus_7_v", _book()) == "voltage|bus:7"


def test_dae_var_renamed_state_key_variable() -> None:
    book = _book()
    name = state_name_andes("omega GENROU 1", book)
    assert name == "state|gen:1-1/machine#omega"
    # The name parses back: quantity state, key gen:1-1/machine, variable omega.
    assert parse_name(name) == ("state", "gen:1-1/machine#omega")
    assert parse_state_name(name) == ("gen:1-1/machine", "omega")


def test_dae_var_of_the_second_machine() -> None:
    assert state_name_andes("delta GENROU 2", _book()) == "state|gen:2-1/machine#delta"


def test_dae_var_of_a_device_the_book_does_not_key_is_none() -> None:
    book = _book()
    # GENROU 99 is no device of the case; the caller refuses the request with
    # the name in the message.
    assert state_name_andes("omega GENROU 99", book) is None
    # A name that does not split into variable, model and idx is not one.
    assert state_name_andes("Bus_7_v", book) is None
    assert state_name_andes("omega GENROU", book) is None


def test_unknown_device_refused_with_its_name() -> None:
    # The worker's refusal names the columns it cannot rename; the unit test
    # holds the wording's shape on the helper the worker uses.
    unnamed = [
        name
        for name in ("omega GENROU 99", "vf EXST1 3")
        if state_name_andes(name, _book()) is None
    ]
    assert unnamed == ["omega GENROU 99", "vf EXST1 3"]
    message = f"no neutral name for variable(s) {unnamed!r}"
    assert "omega GENROU 99" in message
    assert "vf EXST1 3" in message


def test_build_state_name_as_the_worker_spells_it() -> None:
    assert build_state_name("gen:1-1/machine", "omega") == "state|gen:1-1/machine#omega"


def test_rotor_angle_rel_two_machines_by_hand() -> None:
    # By hand: angles 0.3 and 0.1 rad, H*Sn weights 3 and 1.
    # mean = (3*0.3 + 1*0.1) / (3 + 1) = 1.0 / 4 = 0.25
    # relatives: 0.3 - 0.25 = 0.05, 0.1 - 0.25 = -0.15.
    angles = np.array([[0.3, 0.1]])
    weights = np.array([3.0, 1.0])
    in_service = np.array([[True, True]])
    rel = rotor_angle_rel(angles, weights, in_service)
    assert rel.shape == (1, 2)
    assert rel[0, 0] == pytest.approx(0.05, abs=1e-12)
    assert rel[0, 1] == pytest.approx(-0.15, abs=1e-12)
    # The weighted sum of the relatives is zero: 3*0.05 + 1*(-0.15) = 0.
    assert float(np.dot(weights, rel[0])) == pytest.approx(0.0, abs=1e-12)


def test_rotor_angle_rel_a_tripped_machine_leaves_the_mean() -> None:
    # By hand: machine 1 tripped, so the mean is machine 0's angle alone and
    # its relative is 0; the tripped machine keeps its difference to it.
    angles = np.array([[0.3, 0.1]])
    weights = np.array([3.0, 1.0])
    in_service = np.array([[True, False]])
    rel = rotor_angle_rel(angles, weights, in_service)
    assert rel[0, 0] == pytest.approx(0.0, abs=1e-12)
    assert rel[0, 1] == pytest.approx(0.1 - 0.3, abs=1e-12)


def test_angle_rel_two_buses_against_the_slack() -> None:
    # By hand: bus 0 is the slack (reference), angles 0.20 and 0.35 rad.
    # relatives: 0.20 - 0.20 = 0.0 exactly, 0.35 - 0.20 = 0.15.
    angles = np.array([[0.20, 0.35]])
    rel = angle_rel(angles, 0)
    assert rel[0, 0] == 0.0
    assert rel[0, 1] == pytest.approx(0.15, abs=1e-12)
