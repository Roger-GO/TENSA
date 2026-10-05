"""Unit tests for what the element builder checks, fills in and says about an ESD1.

The rules are driven with plain dicts and the link check with a stand-in System,
so each refusal is pinned to its reason without a solver. What ANDES itself does
with the values these refuse is in ``tests/integration/test_esd1_api.py``.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace
from typing import Any

import andes
import pytest
from andes.core.param import ExtParam, NumParam

from tensa.core.clone_writers import load_clone_write_index
from tensa.core.errors import ElementValidationError
from tensa.core.esd1 import (
    CHECKED_PARAMS,
    base_notice,
    check_edit,
    check_link,
    check_values,
    log_base_notice,
    prepare_add,
)
from tensa.core.messages import NOTICE_LOGGER
from tensa.core.wrapper import (
    _ALTERABLE_SERVICES,
    _CONTROLLER_MODEL_NAMES,
    _PARAMS_BY_MODEL,
    _REFERENCE_ATTRS,
)

pytestmark = pytest.mark.unit


@pytest.fixture(scope="module")
def system() -> andes.System:
    return andes.System()


@pytest.fixture(scope="module")
def defaults(system: andes.System) -> dict[str, Any]:
    """ANDES's own default of every param the rules read."""
    return {name: getattr(system.ESD1, name).default for name in CHECKED_PARAMS}


# ---- the whitelist is ANDES's own parameter list -----------------------------------


def test_esd1_is_registered_wherever_a_buildable_controller_is() -> None:
    assert "ESD1" in _PARAMS_BY_MODEL
    assert "ESD1" in _CONTROLLER_MODEL_NAMES
    # It sits on a bus, so deleting that bus must name it as a dependent.
    assert _REFERENCE_ATTRS["ESD1"] == ("bus",)


def test_esd1_params_are_andes_own_in_its_order(system: andes.System) -> None:
    expected = ["idx", "name"]
    for name, param in system.ESD1.params.items():
        if name in ("idx", "name", "u") or isinstance(param, ExtParam):
            continue
        expected.append(name)
    assert [p.name for p in _PARAMS_BY_MODEL["ESD1"]] == expected


def test_esd1_numbers_are_numbers_and_links_are_pickers(system: andes.System) -> None:
    metas = {p.name: p for p in _PARAMS_BY_MODEL["ESD1"]}
    assert metas["bus"].kind == "bus_idx"
    # The static generator it takes over is picked like a machine's.
    assert metas["gen"].kind == "gen_idx"
    for name, param in system.ESD1.params.items():
        if isinstance(param, NumParam) and not isinstance(param, ExtParam) and name != "u":
            assert metas[name].kind == "number", name


def test_esd1_requires_what_andes_has_no_default_for_and_what_sizes_it(
    system: andes.System,
) -> None:
    required = {p.name for p in _PARAMS_BY_MODEL["ESD1"] if p.required}
    mandatory = {
        name for name, param in system.ESD1.params.items() if param.get_property("mandatory")
    }
    assert mandatory == {"bus", "gen", "pqflag"}
    assert mandatory <= required
    assert required == {"idx", "name", "bus", "gen", "Sn", "pqflag", "pmx", "En"}


def test_esd1_units_are_the_ones_andes_gives() -> None:
    units = {p.name: p.unit for p in _PARAMS_BY_MODEL["ESD1"]}
    assert units["Sn"] == "MVA"
    assert units["En"] == "MWh"
    assert units["pmx"] == "pu"
    assert units["fn"] == units["ft0"] == "Hz"
    assert units["SOCinit"] is None


def test_the_rules_read_only_params_the_model_has(system: andes.System) -> None:
    for name in CHECKED_PARAMS:
        assert isinstance(system.ESD1.params[name], NumParam), name


def test_the_power_set_points_can_be_altered_in_a_run(system: andes.System) -> None:
    """``pref0`` and ``Pext0`` are services, which the NumParam scan misses."""
    assert _ALTERABLE_SERVICES["ESD1"] == ("pref0", "Pext0")
    for name in _ALTERABLE_SERVICES["ESD1"]:
        assert name in system.ESD1.services


def test_the_clone_index_can_edit_every_esd1_number_in_an_xlsx_and_none_in_a_dyr() -> None:
    entry = load_clone_write_index()["models"]["ESD1"]
    numbers = {p.name for p in _PARAMS_BY_MODEL["ESD1"] if p.kind == "number"}
    assert entry["xlsx"] == {"sheet": "ESD1", "idx_column": "idx"}
    # PSS/E has no record for the model, so a .dyr never holds one.
    assert entry["dyr"] is None
    assert set(entry["params"]) == numbers
    for name, ops in entry["params"].items():
        assert ops == {"xlsx": {"column": name}, "dyr": None}


# ---- the values a run cannot use ------------------------------------------------------


def test_andes_defaults_with_a_priority_flag_pass(defaults: dict[str, Any]) -> None:
    assert defaults["pqflag"] is None  # ANDES has no default for it
    check_values({**defaults, "pqflag": 1})
    check_values({**defaults, "pqflag": 0})
    # Without the flag the rest is still checked; ANDES names the missing one.
    check_values(defaults)


@pytest.mark.parametrize(
    ("changes", "says"),
    [
        ({"En": 0}, "En must be above zero; got 0"),
        ({"En": -5}, "En must be above zero; got -5"),
        ({"Tf": 0}, "Tf must be above zero"),
        ({"EtaD": 0}, "EtaD must be above 0 and at most 1; got 0. It is the discharging"),
        ({"EtaC": 1.2}, "EtaC must be above 0 and at most 1; got 1.2. It is the charging"),
        ({"Sn": 0}, "Sn must be above zero"),
        ({"pmx": -1}, "pmx must not be negative; got -1"),
        ({"pqflag": 2}, "pqflag must be 0"),
        ({"pqflag": 0.5}, "pqflag must be 0"),
        ({"SOCmin": 0.9, "SOCmax": 0.1}, "0 <= SOCmin < SOCmax <= 1; got SOCmin=0.9, SOCmax=0.1"),
        ({"SOCmax": 1.5}, "0 <= SOCmin < SOCmax <= 1"),
        ({"SOCmin": -0.1}, "0 <= SOCmin < SOCmax <= 1"),
        ({"SOCinit": 1.5}, "SOCinit must lie between SOCmin and SOCmax; got SOCinit=1.5"),
        ({"SOCinit": 0.05, "SOCmin": 0.1}, "SOCinit must lie between SOCmin and SOCmax"),
        ({"vt1": 1.2}, "voltage trip points must rise, vt0 < vt1 < vt2 < vt3; got vt1=1.2 and vt2=1.1"),
        ({"ft0": 59.7}, "frequency trip points must rise"),
        ({"fn": 50}, "fn=50 Hz is outside ft1 to ft2 (59.7 to 60.3 Hz)"),
    ],
)
def test_a_value_a_run_cannot_use_is_refused_with_its_reason(
    defaults: dict[str, Any], changes: dict[str, Any], says: str
) -> None:
    with pytest.raises(ElementValidationError) as refused:
        check_values({**defaults, "pqflag": 1, **changes})
    assert says in str(refused.value)


def test_a_nominal_frequency_is_accepted_with_trip_points_around_it(
    defaults: dict[str, Any],
) -> None:
    check_values(
        {**defaults, "pqflag": 1, "fn": 50, "ft0": 49.5, "ft1": 49.7, "ft2": 50.3, "ft3": 50.5}
    )


@pytest.mark.parametrize("bad", ["abc", [1], float("nan"), float("inf")])
def test_a_checked_value_that_is_no_finite_number_is_refused(
    defaults: dict[str, Any], bad: Any
) -> None:
    with pytest.raises(ElementValidationError) as refused:
        check_values({**defaults, "En": bad})
    assert "ESD1 param 'En' must be a" in str(refused.value)


def test_a_number_sent_as_text_is_read_as_the_number(defaults: dict[str, Any]) -> None:
    check_values({**defaults, "En": "25"})
    with pytest.raises(ElementValidationError):
        check_values({**defaults, "En": "0"})


def test_an_edit_is_checked_only_for_what_it_changes(defaults: dict[str, Any]) -> None:
    """A device that already holds a value a rule refuses (a case file may) can
    still have its other values changed."""
    held = {**defaults, "pqflag": 1, "SOCinit": 1.5}
    with pytest.raises(ElementValidationError):
        check_values(held)
    check_values({**held, "En": 20}, changed={"En"})
    # Changing one end of a relation brings the whole relation in.
    with pytest.raises(ElementValidationError) as refused:
        check_values({**held, "SOCmax": 0.9}, changed={"SOCmax"})
    assert "SOCinit must lie between" in str(refused.value)


# ---- the static generator it takes over ----------------------------------------------


class _Group:
    def __init__(self, buses: dict[Any, Any]) -> None:
        self._buses = buses

    def get_all_idxes(self) -> list[Any]:
        return list(self._buses)

    def idx2model(self, idx: Any) -> Any:
        positions = list(self._buses)
        return SimpleNamespace(
            idx2uid=positions.index,
            bus=SimpleNamespace(v=[self._buses[known] for known in positions]),
        )


def _fake_system(*, mva: float = 100.0, held: dict[str, list[Any]] | None = None) -> Any:
    esd1 = SimpleNamespace(
        **{name: SimpleNamespace(default=None, v=[]) for name in (*CHECKED_PARAMS, "bus", "gen")}
    )
    for name, values in (held or {}).items():
        getattr(esd1, name).v = values
    return SimpleNamespace(
        config=SimpleNamespace(mva=mva),
        Bus=SimpleNamespace(idx=SimpleNamespace(v=[1, 2, 7])),
        StaticGen=_Group({1: 1, "PV_B": 7}),
        ESD1=esd1,
    )


def test_a_static_generator_on_the_same_bus_is_accepted() -> None:
    check_link(_fake_system(), 7, "PV_B")
    # A reference sent as text names the same device.
    check_link(_fake_system(), "7", "PV_B")
    check_link(_fake_system(), "1", "1")


def test_a_gen_that_names_no_static_generator_is_refused() -> None:
    with pytest.raises(ElementValidationError) as refused:
        check_link(_fake_system(), 7, "NOPE")
    assert "gen='NOPE' names no static generator" in str(refused.value)
    assert "add one first" in str(refused.value)


def test_a_static_generator_on_another_bus_is_refused() -> None:
    with pytest.raises(ElementValidationError) as refused:
        check_link(_fake_system(), 7, 1)
    assert "is on bus 7 but its static generator 1 is on bus 1" in str(refused.value)


def test_a_bus_the_case_does_not_have_is_refused() -> None:
    with pytest.raises(ElementValidationError) as refused:
        check_link(_fake_system(), 99, "PV_B")
    assert "bus=99 names no bus" in str(refused.value)


def test_a_missing_link_is_left_for_andes_to_name() -> None:
    check_link(_fake_system(), None, "PV_B")
    check_link(_fake_system(), 7, None)


# ---- an add --------------------------------------------------------------------------


def test_an_add_without_a_rating_gets_the_system_base() -> None:
    params: dict[str, Any] = {"bus": 7, "gen": "PV_B", "pqflag": 1}
    prepare_add(_fake_system(mva=250.0), params, 250.0)
    assert params["Sn"] == 250.0


def test_an_add_keeps_the_rating_it_gives() -> None:
    params: dict[str, Any] = {"bus": 7, "gen": "PV_B", "pqflag": 1, "Sn": 40}
    prepare_add(_fake_system(), params, 100.0)
    assert params["Sn"] == 40


def test_an_add_is_checked_over_andes_defaults(system: andes.System) -> None:
    """``fn`` alone is enough to be refused: the trip points it is read against
    are ANDES's defaults, which the request never mentioned."""
    ss = _fake_system()
    for name in CHECKED_PARAMS:
        getattr(ss.ESD1, name).default = getattr(system.ESD1, name).default
    with pytest.raises(ElementValidationError) as refused:
        prepare_add(ss, {"bus": 7, "gen": "PV_B", "pqflag": 1, "fn": 50}, 100.0)
    assert "ANDES's values for 60 Hz" in str(refused.value)


def test_an_add_with_a_bad_link_is_refused_after_its_values() -> None:
    with pytest.raises(ElementValidationError) as refused:
        prepare_add(_fake_system(), {"bus": 7, "gen": 1, "pqflag": 1}, 100.0)
    assert "must be on the same bus" in str(refused.value)


# ---- an edit -------------------------------------------------------------------------


def _held_system() -> Any:
    return _fake_system(
        held={
            "bus": [7],
            "gen": ["PV_B"],
            "En": [10.0],
            "SOCmin": [0.1],
            "SOCmax": [0.9],
            "SOCinit": [0.5],
        }
    )


def test_an_edit_is_read_against_what_the_device_holds() -> None:
    ss = _held_system()
    check_edit(ss, 0, {"SOCinit": 0.8})
    with pytest.raises(ElementValidationError) as refused:
        check_edit(ss, 0, {"SOCinit": 0.95})
    assert "got SOCinit=0.95 with SOCmin=0.1, SOCmax=0.9" in str(refused.value)
    with pytest.raises(ElementValidationError):
        check_edit(ss, 0, {"En": 0})


def test_an_edit_of_a_link_is_checked_with_the_other_one_held() -> None:
    ss = _held_system()
    check_edit(ss, 0, {"gen": "PV_B"})
    with pytest.raises(ElementValidationError) as refused:
        check_edit(ss, 0, {"gen": 1})
    assert "static generator 1 is on bus 1" in str(refused.value)
    with pytest.raises(ElementValidationError):
        check_edit(ss, 0, {"bus": 1})
    # An edit that touches neither link does not look at them.
    ss.ESD1.gen.v = ["GONE"]
    check_edit(ss, 0, {"En": 20})


# ---- the notice ----------------------------------------------------------------------


def test_a_rating_on_the_system_base_says_nothing() -> None:
    assert base_notice("ESD1_1", 100.0, 100.0) is None
    assert base_notice("ESD1_1", "100", 100.0) is None


def test_a_rating_on_another_base_says_what_differs_and_what_to_set() -> None:
    text = base_notice("ESD1_1", 50, 100.0)
    assert text is not None
    assert text.startswith("ESD1 ESD1_1 has Sn = 50 MVA on a system base of 100 MVA.")
    assert "pmx, qmx, qmn, ialim" in text
    assert text.endswith("Set Sn to 100 MVA for them to agree.")


@pytest.mark.parametrize(("sn", "base"), [(50, None), (None, 100.0), ("abc", 100.0)])
def test_no_notice_without_both_numbers(sn: Any, base: float | None) -> None:
    assert base_notice("ESD1_1", sn, base) is None


def test_the_notice_is_a_warning_on_the_logger_the_messages_capture_reads(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger=NOTICE_LOGGER):
        log_base_notice("ESD1_1", 100.0, 100.0)
        assert caplog.records == []
        log_base_notice("ESD1_1", 50.0, 100.0)
    (record,) = caplog.records
    assert record.name == NOTICE_LOGGER
    assert record.levelno == logging.WARNING
    assert "Sn = 50 MVA" in record.getMessage()
