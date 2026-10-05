"""The controllers a time-domain run closes a loop with, on a stand-in System.

The System here is a handful of numpy arrays where ANDES keeps them, stepped the
way ``TDS.run`` steps (the hook is called with the time a step ends at while the
arrays still hold the step before), so each rule of ``tensa.core.tds_controllers``
is pinned to a number without a solver: what a request may name, the two control
laws, when a sample is taken, what is written and what is put back.
``tests/integration/test_tds_controllers_api.py`` runs the same controllers on
real ANDES.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core import messages
from tensa.core.errors import TdsRequestError
from tensa.core.messages import NOTICE_LOGGER
from tensa.core.tds_controllers import (
    DEFAULT_PERIOD,
    MAX_CONTROLLERS,
    MAX_SAMPLE_VALUES,
    ControllerBank,
    DroopController,
    FfrController,
    coi_speed,
    controllable_models,
    controller_catalogue,
    controller_targets,
    device_label,
    log_notices,
    parse_controllers,
)

pytestmark = pytest.mark.unit

MVA = 100.0
F0 = 60.0


# ---- a System to step ---------------------------------------------------------


class _Thing:
    """A plain object with the attributes given (a ``SimpleNamespace`` cannot be
    weakly referenced, and the bank keeps the System by a weak reference)."""

    def __init__(self, **attrs: Any) -> None:
        self.__dict__.update(attrs)


def _v(values: Any) -> SimpleNamespace:
    return SimpleNamespace(v=values)


def _battery(
    idx: tuple[Any, ...] = (1, 2),
    pmx: float = 0.5,
    soc: bool = True,
    model_fn: float = F0,
) -> Any:
    n = len(idx)
    model = _Thing(
        n=n,
        idx=_v(list(idx)),
        name=_v([f"ESD1_{i}" for i in idx]),
        bus=_v([4] * n),
        u=_v(np.ones(n)),
        Sn=_v(np.full(n, MVA)),
        pmx=_v(np.full(n, pmx)),
        fn=_v(np.full(n, model_fn)),
        Pext0=_v(np.zeros(n)),
        fHz=_v(np.full(n, model_fn)),
        v=_v(np.ones(n)),
        Ipout_y=_v(np.zeros(n)),
        _setpoints={"pref": "pref0", "qref": "qref0", "paux": "Pext0"},
    )
    if soc:
        model.pIG_y = _v(np.full(n, 0.5))
    model.idx2uid = lambda wanted: list(model.idx.v).index(wanted)
    return model


def _machines(inertia: tuple[float, ...] = (10.0, 30.0)) -> Any:
    n = len(inertia)
    return _Thing(n=n, M=_v(np.array(inertia)), omega=_v(np.ones(n)), u=_v(np.ones(n)))


def _system(
    battery: Any | None = None,
    machines: Any | None = None,
    alter: Any | None = None,
    *,
    with_machines: bool = True,
    is_setup: bool = True,
) -> Any:
    battery = battery if battery is not None else _battery()
    machines = machines if machines is not None else _machines()
    return _Thing(
        groups={
            "DG": _Thing(models={"ESD1": battery}),
            "SynGen": _Thing(models={"GENROU": machines} if with_machines else {}),
        },
        config=_Thing(mva=MVA, freq=F0),
        TDS=_Thing(h=0.01),
        dae=_Thing(t=0.0),
        is_setup=is_setup,
        Alter=alter,
        ESD1=battery,
        GENROU=machines,
    )


def _set_frequency(system: Any, hz: float) -> None:
    """Every machine at the speed of ``hz``, and every bus reading it."""
    system.GENROU.omega.v[:] = hz / F0
    system.ESD1.fHz.v[:] = hz


def _drive(
    bank: ControllerBank,
    system: Any,
    frequency: Callable[[float], float],
    until: float,
    h: float = 0.01,
    start: float = 0.0,
) -> list[tuple[float, float]]:
    """Step the bank as ``TDS.run`` would from ``start`` to ``until``.

    ANDES calls the hook with the time ``t`` the next step ends at while the
    System still holds the solution at ``t - h``: that instant's frequency is
    put in, the hook is called, and the first device's input is read back. A
    run from zero opens with a call at ``t = 0``, and the last call of a run is
    the one for the step that ends at ``until``. Returns
    ``(solved instant, input in MW)`` for every call.
    """
    system.TDS.h = h
    calls = [(0.0, 0.0)] if start == 0.0 else []
    for k in range(round((until - start) / h)):
        now = start + k * h
        calls.append((now + h, now))
    seen: list[tuple[float, float]] = []
    for t, now in calls:
        _set_frequency(system, frequency(now))
        bank.step(t, system)
        seen.append((round(now, 9), float(system.ESD1.Pext0.v[0]) * MVA))
    system.dae.t = until
    return seen


def _bank(system: Any, *controllers: dict[str, Any]) -> ControllerBank:
    bank = ControllerBank(system, parse_controllers(list(controllers)))
    bank.begin_run()
    return bank


def _droop(**fields: Any) -> dict[str, Any]:
    return {"type": "droop", "model": "ESD1", "idx": 1, "gain": 100.0, **fields}


def _ffr(**fields: Any) -> dict[str, Any]:
    return {
        "type": "ffr",
        "model": "ESD1",
        "idx": 1,
        "power": 20.0,
        "trigger_deviation": 0.1,
        "hold": 1.0,
        **fields,
    }


def _at(seen: list[tuple[float, float]], instant: float) -> float:
    return next(value for now, value in seen if abs(now - instant) < 1e-9)


# ---- what a request may name ---------------------------------------------------


def test_no_controllers_is_an_empty_list() -> None:
    assert parse_controllers(None) == []
    assert parse_controllers([]) == []


def test_a_droop_gets_the_defaults_it_leaves_out() -> None:
    (spec,) = parse_controllers([{"type": "droop", "model": "ESD1", "idx": 1, "gain": 50}])
    assert isinstance(spec, DroopController)
    assert (spec.frequency, spec.period, spec.t_start) == ("coi", DEFAULT_PERIOD, 0.0)
    assert (spec.deadband, spec.p_max, spec.ramp) == (0.0, None, None)


def test_an_ffr_keeps_what_it_is_given() -> None:
    (spec,) = parse_controllers(
        [_ffr(trigger_rocof=0.2, frequency="bus", period=0.05, ramp=100, t_start=1)]
    )
    assert isinstance(spec, FfrController)
    assert (spec.power, spec.trigger_deviation, spec.trigger_rocof) == (20.0, 0.1, 0.2)
    assert (spec.hold, spec.frequency, spec.period, spec.ramp, spec.t_start) == (
        1.0, "bus", 0.05, 100.0, 1.0,
    )


def test_parsed_models_pass_through_unchanged() -> None:
    specs = parse_controllers([_droop()])
    assert parse_controllers(specs) == specs


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("droop", "'controllers' must be a list of controller objects"),
        ({"type": "droop"}, "'controllers' must be a list of controller objects"),
        ([_droop()] * (MAX_CONTROLLERS + 1), f"a run takes at most {MAX_CONTROLLERS}"),
        ([{"model": "ESD1", "idx": 1}], "controllers[0]: Unable to extract tag"),
        ([{"type": "pid", "model": "ESD1", "idx": 1}], "controllers[0]: Input tag 'pid'"),
        ([{"type": "droop", "model": "ESD1", "idx": 1}], "controllers[0].gain: Field required"),
        ([_droop(gain=0)], "controllers[0].gain: Input should be greater than 0"),
        ([_droop(gain=float("nan"))], "controllers[0].gain"),
        ([_droop(deadband=-0.1)], "controllers[0].deadband"),
        ([_droop(p_max=0)], "controllers[0].p_max"),
        ([_droop(period=0.0001)], "controllers[0].period"),
        ([_droop(period=600)], "controllers[0].period"),
        ([_droop(t_start=-1)], "controllers[0].t_start"),
        ([_droop(ramp=0)], "controllers[0].ramp"),
        ([_droop(frequency="pll")], "controllers[0].frequency"),
        ([_droop(model="")], "controllers[0].model"),
        ([_droop(), _droop(code="import os")], "controllers[1].code: Extra inputs"),
        ([_ffr(power=0)], "controllers[0]: power must not be zero"),
        ([_ffr(trigger_deviation=None)], "controllers[0]: give trigger_deviation"),
        ([_ffr(hold=0)], "controllers[0].hold"),
        ([_ffr(trigger_rocof=-0.2)], "controllers[0].trigger_rocof"),
        (["droop"], "controllers[0]"),
    ],
)
def test_a_request_that_breaks_a_rule_is_refused_with_where_and_why(
    raw: Any, message: str
) -> None:
    with pytest.raises(TdsRequestError) as refused:
        parse_controllers(raw)
    assert message in str(refused.value)


def test_a_refusal_does_not_repeat_what_was_sent() -> None:
    """The reason goes to a client and into a WebSocket close; a long value a
    caller sent must not ride along."""
    with pytest.raises(TdsRequestError) as refused:
        parse_controllers([_droop(model="x" * 5000)])
    assert len(str(refused.value)) < 200


# ---- binding to the case -------------------------------------------------------


def test_only_distributed_generation_models_with_the_input_can_be_commanded() -> None:
    battery = _battery()
    plain = _Thing(n=1, _setpoints={"pref": "pref0"})
    system = _system(battery)
    system.groups["DG"].models["OTHER"] = plain
    assert controllable_models(system) == {"ESD1": battery}


def test_a_device_named_as_text_is_found_as_the_case_holds_it() -> None:
    bank = _bank(_system(_battery(idx=(5, "B2"))), _droop(idx="5"), _droop(idx="B2"))
    assert [entry["idx"] for entry in bank.results(traces=False)] == [5, "B2"]


@pytest.mark.parametrize(
    ("controller", "message"),
    [
        (_droop(model="GENROU"), "'GENROU' is not a model a controller can command"),
        (_droop(model="PVD1"), "the loaded case has ESD1"),
        (_droop(idx=9), "the loaded case has no ESD1 with idx 9"),
    ],
)
def test_a_controller_that_cannot_be_bound_is_refused(
    controller: dict[str, Any], message: str
) -> None:
    with pytest.raises(TdsRequestError) as refused:
        ControllerBank(_system(), parse_controllers([_droop(), controller]))
    assert str(refused.value).startswith("controllers[1]: ")
    assert message in str(refused.value)


def test_the_centre_of_inertia_needs_a_machine() -> None:
    system = _system(with_machines=False)
    with pytest.raises(TdsRequestError, match='use frequency "bus"'):
        ControllerBank(system, parse_controllers([_droop()]))
    # Reading its own bus needs none.
    ControllerBank(system, parse_controllers([_droop(frequency="bus")]))


def test_an_alter_on_the_same_input_is_refused_and_one_on_the_set_point_is_not() -> None:
    def alter(src: str, dev: Any = 1) -> Any:
        return _Thing(n=1, model=_v(["ESD1"]), dev=_v([dev]), src=_v([src]))

    with pytest.raises(TdsRequestError, match="an Alter event of the case writes Pext0"):
        ControllerBank(_system(alter=alter("Pext0")), parse_controllers([_droop()]))
    ControllerBank(_system(alter=alter("pref0")), parse_controllers([_droop()]))
    # Another battery's input is not this controller's.
    ControllerBank(_system(alter=alter("Pext0", dev=2)), parse_controllers([_droop()]))


# ---- the frequency a controller reads ------------------------------------------


def test_coi_weights_each_machine_by_its_inertia() -> None:
    machines = _machines((10.0, 30.0))
    machines.omega.v[:] = [0.99, 1.01]
    assert coi_speed(_system(machines=machines)) == pytest.approx(
        (10 * 0.99 + 30 * 1.01) / 40
    )


def test_coi_leaves_out_a_machine_that_is_switched_off() -> None:
    machines = _machines((10.0, 30.0))
    machines.omega.v[:] = [0.99, 1.2]  # a tripped machine runs away
    machines.u.v[:] = [1.0, 0.0]
    assert coi_speed(_system(machines=machines)) == pytest.approx(0.99)


def test_coi_is_unknown_with_every_machine_off() -> None:
    machines = _machines()
    machines.u.v[:] = 0.0
    assert coi_speed(_system(machines=machines)) is None
    assert coi_speed(_system(with_machines=False)) is None


def test_a_bus_reading_is_the_device_s_own_and_deviates_from_its_own_nominal() -> None:
    system = _system(_battery(model_fn=50.0))
    bank = _bank(system, _droop(frequency="bus"))
    system.TDS.h = 0.01
    system.ESD1.fHz.v[:] = [49.9, 50.0]
    system.GENROU.omega.v[:] = 1.0  # the machines say 60 Hz and are not asked
    bank.step(0.0, system)
    assert system.ESD1.Pext0.v[0] * MVA == pytest.approx(100.0 * 0.1)


# ---- frequency droop -----------------------------------------------------------


def _held(frequency: float, **fields: Any) -> float:
    """The command, in MW, a droop holds for a constant frequency."""
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(**fields))
    return _drive(bank, system, lambda _now: frequency, until=0.05)[-1][1]


def test_droop_commands_its_gain_times_the_deviation() -> None:
    assert _held(59.8) == pytest.approx(100.0 * 0.2)


def test_droop_absorbs_when_the_frequency_is_high() -> None:
    assert _held(60.3) == pytest.approx(-100.0 * 0.3)


def test_droop_does_nothing_inside_its_dead_band_and_counts_from_its_edge() -> None:
    assert _held(59.97, deadband=0.05) == 0.0
    assert _held(60.05, deadband=0.05) == 0.0
    assert _held(59.8, deadband=0.05) == pytest.approx(100.0 * 0.15)
    assert _held(60.2, deadband=0.05) == pytest.approx(-100.0 * 0.15)


def test_droop_stops_at_p_max_either_way() -> None:
    assert _held(59.0, p_max=30.0) == pytest.approx(30.0)
    assert _held(61.0, p_max=30.0) == pytest.approx(-30.0)


def test_droop_without_p_max_stops_at_the_device_s_own_limit() -> None:
    system = _system(_battery(pmx=0.25))  # 25 MW on the 100 MVA base
    bank = _bank(system, _droop())
    assert _drive(bank, system, lambda _now: 59.0, until=0.05)[-1][1] == pytest.approx(25.0)


def test_the_device_s_own_limit_is_the_smaller_of_its_power_and_current_limits() -> None:
    """ANDES's default ``pmx`` is 9999, no limit at all; what such a device can
    deliver is what its current limit carries."""
    battery = _battery(pmx=99.99)
    battery.ialim = _v(np.full(2, 0.011))  # 1.1 MW on the 100 MVA base
    system = _system(battery)
    bank = _bank(system, _droop())
    assert _drive(bank, system, lambda _now: 59.0, until=0.05)[-1][1] == pytest.approx(1.1)
    assert controller_targets(system)[0]["p_limit"] == pytest.approx(1.1)
    # A power limit below the current limit is the one that counts.
    battery.pmx.v[:] = 0.005
    assert controller_targets(system)[0]["p_limit"] == pytest.approx(0.5)


def test_the_command_is_written_in_per_unit_on_top_of_what_the_input_held() -> None:
    system = _system()
    system.ESD1.Pext0.v[:] = [0.03, 0.07]
    bank = _bank(system, _droop())
    _drive(bank, system, lambda _now: 59.9, until=0.05)
    assert system.ESD1.Pext0.v[0] == pytest.approx(0.03 + 10.0 / MVA)
    # A battery no controller names is left alone.
    assert system.ESD1.Pext0.v[1] == 0.07


def test_a_ramp_limits_how_fast_the_command_moves() -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(ramp=50.0))  # 5 MW a sample at 0.1 s
    seen = _drive(bank, system, lambda _now: 59.8, until=0.55)
    assert [_at(seen, k / 10) for k in range(5)] == pytest.approx([5.0, 10.0, 15.0, 20.0, 20.0])


# ---- when a controller samples -------------------------------------------------


def test_the_command_holds_between_samples() -> None:
    """The frequency falls all the time; the command only moves once a period,
    to what the frequency was at that solved instant."""
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(period=0.1))
    seen = _drive(bank, system, lambda now: F0 - now, until=0.35)
    for now, command in seen:
        sampled_at = np.floor(now / 0.1 + 1e-9) * 0.1
        assert command == pytest.approx(100.0 * sampled_at), now


def test_a_sample_reads_the_solved_instant_not_the_time_the_step_ends_at() -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(period=0.1))
    system.TDS.h = 0.05
    _set_frequency(system, 59.9)
    # The step to t = 0.1 is about to be solved: the System holds t = 0.05, the
    # controller's first sample was due at 0 and is taken now, at 0.05.
    bank.step(0.1, system)
    assert bank.results(traces=True)[0]["trace"]["t"] == [pytest.approx(0.05)]


def test_a_retried_step_does_not_sample_twice() -> None:
    """ANDES calls the hook again with a smaller step when one does not
    converge. The System holds the same solution, and so does the controller."""
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(ramp=50.0))
    _set_frequency(system, 59.8)
    system.TDS.h = 0.01
    bank.step(0.11, system)  # solved instant 0.1
    first = system.ESD1.Pext0.v[0]
    for smaller in (0.005, 0.0025):
        system.TDS.h = smaller
        bank.step(0.1 + smaller, system)  # the same solved instant
    assert system.ESD1.Pext0.v[0] == first
    assert bank.results(traces=False)[0]["samples"] == 1


def test_a_period_shorter_than_the_step_samples_at_every_step() -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(period=0.001))
    _drive(bank, system, lambda _now: 59.9, until=0.1, h=0.02)
    # The solved instants 0, 0.02, 0.04, 0.06 and 0.08.
    assert bank.results(traces=False)[0]["samples"] == 5


def test_steps_that_miss_the_multiples_of_the_period_do_not_drift() -> None:
    """With a step of 0.03 s no solved instant falls on 0.1 s. The samples are
    the first instants at or after each multiple, not 0.1 s after the last."""
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(period=0.1))
    _drive(bank, system, lambda _now: 59.9, until=0.63, h=0.03)
    assert bank.results(traces=True)[0]["trace"]["t"] == pytest.approx(
        [0.0, 0.12, 0.21, 0.3, 0.42, 0.51, 0.6]
    )


def test_nothing_is_commanded_before_t_start() -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(t_start=0.2))
    seen = _drive(bank, system, lambda _now: 59.8, until=0.31)
    assert {command for now, command in seen if now < 0.2 - 1e-9} == {0.0}
    assert _at(seen, 0.2) == pytest.approx(20.0)
    result = bank.results(traces=True)[0]
    assert result["first_action_t"] == pytest.approx(0.2)
    assert result["trace"]["t"] == pytest.approx([0.2, 0.3])


def test_a_frequency_that_cannot_be_read_leaves_the_command_where_it_is() -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop())
    _drive(bank, system, lambda _now: 59.8, until=0.05)
    system.GENROU.u.v[:] = 0.0  # every machine has tripped
    seen = _drive(bank, system, lambda _now: 59.0, until=0.35, start=0.06)
    assert [command for _now, command in seen] == pytest.approx([20.0] * len(seen))
    assert bank.results(traces=False)[0]["samples"] == 1


# ---- fast frequency response ---------------------------------------------------


def _falling(now: float) -> float:
    """60 Hz until 0.2 s, then 1 Hz a second down."""
    return F0 - max(0.0, now - 0.2)


def test_ffr_waits_for_its_deviation_then_holds_and_lets_go() -> None:
    system = _system()
    bank = _bank(system, _ffr(trigger_deviation=0.1, hold=1.0))
    seen = _drive(bank, system, _falling, until=1.6)
    # 0.1 Hz below nominal is reached at 0.3 s, on a sample.
    assert _at(seen, 0.29) == 0.0
    assert _at(seen, 0.3) == pytest.approx(20.0)
    assert _at(seen, 1.29) == pytest.approx(20.0)
    assert _at(seen, 1.3) == 0.0
    result = bank.results(traces=False)[0]
    assert result["first_action_t"] == pytest.approx(0.3)
    assert result["released_t"] == pytest.approx(1.3)
    assert (result["peak_command"], result["final_command"]) == (20.0, 0.0)


def test_ffr_fires_once_even_if_the_frequency_stays_low() -> None:
    system = _system()
    bank = _bank(system, _ffr(hold=0.5))
    seen = _drive(bank, system, lambda _now: 59.5, until=2.0)
    assert _at(seen, 0.49) == pytest.approx(20.0)
    assert {command for now, command in seen if now >= 0.5 - 1e-9} == {0.0}


def test_ffr_triggers_on_the_rate_between_two_samples() -> None:
    system = _system()
    bank = _bank(system, _ffr(trigger_deviation=None, trigger_rocof=0.5, hold=1.0))
    # 1 Hz/s from 0.2 s: the sample at 0.3 s sees 0.1 Hz less than the one at 0.2 s.
    seen = _drive(bank, system, _falling, until=0.5)
    assert _at(seen, 0.29) == 0.0
    assert _at(seen, 0.3) == pytest.approx(20.0)


def test_ffr_does_not_trigger_on_a_rate_below_its_threshold() -> None:
    system = _system()
    bank = _bank(system, _ffr(trigger_deviation=None, trigger_rocof=1.5))
    assert {command for _now, command in _drive(bank, system, _falling, until=1.0)} == {0.0}


def test_a_negative_ffr_answers_a_high_frequency() -> None:
    system = _system()
    bank = _bank(system, _ffr(power=-20.0, trigger_deviation=0.1, hold=1.0))
    seen = _drive(bank, system, lambda now: 2 * F0 - _falling(now), until=0.5)
    assert _at(seen, 0.29) == 0.0
    assert _at(seen, 0.3) == pytest.approx(-20.0)
    # A low frequency is not its business.
    other = _system()
    low = _bank(other, _ffr(power=-20.0))
    assert {command for _now, command in _drive(low, other, _falling, until=1.0)} == {0.0}


def test_ffr_ramps_up_and_down_when_given_a_ramp() -> None:
    system = _system()
    bank = _bank(system, _ffr(ramp=100.0, hold=0.5))  # 10 MW a sample
    seen = _drive(bank, system, lambda _now: 59.5, until=0.9)
    assert [_at(seen, k / 10) for k in range(9)] == pytest.approx(
        [10.0, 20.0, 20.0, 20.0, 20.0, 10.0, 0.0, 0.0, 0.0]
    )


def test_the_hold_is_counted_in_periods_whatever_the_steps_are() -> None:
    """Steps of 0.03 s put the samples up to a step late. The hold still ends
    ten periods after the trigger, not ten periods and a step."""
    system = _system()
    bank = _bank(system, _ffr(hold=1.0))
    _drive(bank, system, lambda _now: 59.5, until=1.5, h=0.03)
    result = bank.results(traces=False)[0]
    assert result["first_action_t"] == pytest.approx(0.0)
    assert result["released_t"] == pytest.approx(1.02)


# ---- several controllers, and what a run leaves ---------------------------------


def test_two_controllers_on_one_device_add_up() -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(), _ffr(hold=5.0))
    seen = _drive(bank, system, lambda _now: 59.8, until=0.05)
    assert seen[-1][1] == pytest.approx(100.0 * 0.2 + 20.0)


def test_each_device_gets_its_own_controller_s_command() -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(system, _droop(idx=1, gain=100.0), _droop(idx=2, gain=10.0))
    _drive(bank, system, lambda _now: 59.9, until=0.05)
    assert system.ESD1.Pext0.v * MVA == pytest.approx([10.0, 1.0])


def test_the_input_is_put_back_when_the_run_ends() -> None:
    system = _system()
    system.ESD1.Pext0.v[:] = [0.03, 0.0]
    bank = _bank(system, _droop())
    _drive(bank, system, lambda _now: 59.9, until=0.05)
    assert system.ESD1.Pext0.v[0] != 0.03
    bank.end_run(system)
    assert system.ESD1.Pext0.v[0] == 0.03
    # A stray call after the run changes nothing.
    bank.step(0.07, system)
    assert system.ESD1.Pext0.v[0] == 0.03


def test_a_run_that_never_stepped_puts_nothing_back() -> None:
    system = _system()
    system.ESD1.Pext0.v[:] = [0.03, 0.0]
    bank = _bank(system, _droop())
    bank.end_run(system)
    assert system.ESD1.Pext0.v[0] == 0.03


def test_a_run_from_where_the_last_one_stopped_carries_its_controllers_on() -> None:
    system = _system()
    specs = parse_controllers([_ffr(hold=0.5)])
    bank = ControllerBank(system, specs)
    bank.begin_run()
    _drive(bank, system, lambda _now: 59.5, until=0.3)
    bank.end_run(system)
    assert system.ESD1.Pext0.v[0] == 0.0

    assert bank.continues(system, parse_controllers([_ffr(hold=0.5)]))
    bank.rebind(system)
    bank.begin_run()
    seen = _drive(bank, system, lambda _now: 59.5, until=1.0, start=0.3)
    # Still holding what it triggered in the first part, and it lets go on time.
    assert _at(seen, 0.3) == pytest.approx(20.0)
    assert _at(seen, 0.5) == 0.0
    # It does not fire a second time.
    assert {command for now, command in seen if now >= 0.5 - 1e-9} == {0.0}
    result = bank.results(traces=True)[0]
    assert result["first_action_t"] == pytest.approx(0.0)
    assert result["released_t"] == pytest.approx(0.5)
    # The samples are this run's alone.
    assert result["trace"]["t"][0] == pytest.approx(0.3)


def test_any_other_run_does_not_carry_them_on() -> None:
    system = _system()
    bank = ControllerBank(system, parse_controllers([_ffr()]))
    # Before it has run at all.
    assert not bank.continues(system, parse_controllers([_ffr()]))
    bank.begin_run()
    _drive(bank, system, lambda _now: 59.5, until=0.3)
    bank.end_run(system)
    assert bank.continues(system, parse_controllers([_ffr()]))
    # Other controllers.
    assert not bank.continues(system, parse_controllers([_ffr(hold=2.0)]))
    assert not bank.continues(system, parse_controllers([_ffr(), _droop()]))
    # Another System (a reload builds a new one).
    assert not bank.continues(_system(), parse_controllers([_ffr()]))
    # The same System somewhere else in time (a snapshot restored into it).
    system.dae.t = 0.0
    assert not bank.continues(system, parse_controllers([_ffr()]))


def test_the_bank_does_not_keep_the_system_alive_between_runs() -> None:
    import gc
    import weakref

    system = _system()
    alive = weakref.ref(system)
    bank = _bank(system, _droop())
    _drive(bank, system, lambda _now: 59.9, until=0.05)
    bank.end_run(system)
    del system
    gc.collect()
    assert alive() is None
    assert bank.results(traces=False)[0]["samples"] == 1


# ---- what a run reports --------------------------------------------------------


def test_a_trace_holds_what_was_read_and_commanded_at_each_sample() -> None:
    system = _system(_battery(pmx=10.0))
    system.ESD1.v.v[:] = 1.02
    system.ESD1.Ipout_y.v[:] = 0.25
    system.ESD1.pIG_y.v[:] = 0.4
    bank = _bank(system, _droop())
    _drive(bank, system, lambda now: F0 - now, until=0.25)
    (result,) = bank.results(traces=True)
    assert {k: result[k] for k in ("type", "model", "idx", "samples")} == {
        "type": "droop", "model": "ESD1", "idx": 1, "samples": 3,
    }
    trace = result["trace"]
    assert trace["t"] == pytest.approx([0.0, 0.1, 0.2])
    assert trace["frequency"] == pytest.approx([60.0, 59.9, 59.8])
    assert trace["command"] == pytest.approx([0.0, 10.0, 20.0])
    assert trace["output"] == pytest.approx([1.02 * 0.25 * MVA] * 3)
    assert trace["soc"] == pytest.approx([0.4] * 3)
    assert trace["truncated"] is False
    assert result["peak_command"] == pytest.approx(20.0)
    assert "trace" not in bank.results(traces=False)[0]


def test_a_device_without_a_state_of_charge_reports_none() -> None:
    system = _system(_battery(soc=False))
    bank = _bank(system, _droop())
    _drive(bank, system, lambda _now: 59.9, until=0.05)
    assert bank.results(traces=True)[0]["trace"]["soc"] == [None]


def test_samples_beyond_what_a_response_holds_are_left_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tensa.core import tds_controllers

    assert MAX_SAMPLE_VALUES >= 100_000
    monkeypatch.setattr(tds_controllers, "MAX_SAMPLE_VALUES", 20)  # two samples each of two
    system = _system()
    bank = _bank(system, _droop(), _droop(idx=2))
    _drive(bank, system, lambda _now: 59.9, until=0.45)
    for result in bank.results(traces=True):
        assert result["samples"] == 5
        assert len(result["trace"]["t"]) == 2
        assert result["trace"]["truncated"] is True


def test_a_device_is_named_without_repeating_its_model() -> None:
    assert device_label("ESD1", 1) == "ESD1 1"
    assert device_label("ESD1", "B7") == "ESD1 B7"
    assert device_label("ESD1", "ESD1_1") == "ESD1_1"
    system = _system(_battery(idx=("ESD1_1", 2)))
    bank = _bank(system, _droop(idx="ESD1_1"))
    assert bank.notices()[0].startswith("Droop on ESD1_1 took no sample")


def test_notices_say_what_each_controller_did(caplog: pytest.LogCaptureFixture) -> None:
    system = _system(_battery(pmx=10.0))
    bank = _bank(
        system,
        _droop(),
        _droop(idx=2, deadband=5.0),
        _ffr(hold=0.2),
        _ffr(idx=2, hold=50.0),
        _ffr(idx=2, trigger_deviation=3.0),
        _droop(t_start=99.0),
    )
    _drive(bank, system, lambda _now: 59.5, until=0.45)
    assert bank.notices() == [
        "Droop on ESD1 1 acted from t = 0 s: its command peaked at 50 MW and was 50 MW "
        "when the run ended.",
        "Droop on ESD1 2 commanded nothing: the frequency never left its dead band "
        "(it read 59.5 to 59.5 Hz).",
        "Fast frequency response on ESD1 1 triggered at t = 0 s and commanded 20 MW "
        "until t = 0.2 s.",
        "Fast frequency response on ESD1 2 triggered at t = 0 s and commanded 20 MW "
        "and was still holding it when the run ended.",
        "Fast frequency response on ESD1 2 commanded nothing: the frequency never met a "
        "trigger (it read 59.5 to 59.5 Hz).",
        "Droop on ESD1 1 took no sample in this run (it starts at t = 99 s).",
    ]
    with caplog.at_level(logging.INFO, logger=NOTICE_LOGGER):
        log_notices(bank)
    assert [record.getMessage() for record in caplog.records] == bank.notices()
    assert {record.levelno for record in caplog.records} == {logging.INFO}
    assert NOTICE_LOGGER in messages.CAPTURED_LOGGERS


# ---- what a client is told it can command --------------------------------------


def test_targets_name_each_device_its_limit_and_the_variables_to_record() -> None:
    battery = _battery(idx=(1, "ESD1_B"), pmx=0.25)
    battery.u.v[:] = [1.0, 0.0]
    assert controller_targets(_system(battery)) == [
        {
            "model": "ESD1",
            "idx": 1,
            "name": "ESD1_1",
            "bus": 4,
            "in_service": True,
            "p_limit": 25.0,
            "fn": 60.0,
            "variables": {
                "command": "Pext ESD1 1",
                "frequency": "fHz ESD1 1",
                "active_current": "Ipout_y ESD1 1",
                "soc": "pIG_y ESD1 1",
            },
        },
        {
            "model": "ESD1",
            "idx": "ESD1_B",
            "name": "ESD1_ESD1_B",
            "bus": 4,
            "in_service": False,
            "p_limit": 25.0,
            "fn": 60.0,
            # ANDES does not repeat the model in a name whose idx already holds it.
            "variables": {
                "command": "Pext ESD1 B",
                "frequency": "fHz ESD1 B",
                "active_current": "Ipout_y ESD1 B",
                "soc": "pIG_y ESD1 B",
            },
        },
    ]


def test_the_limit_is_read_on_the_base_it_is_held_on() -> None:
    """``setup()`` moves ``pmx`` from the device rating to the system base."""
    battery = _battery(pmx=0.5)
    battery.Sn.v[:] = 40.0
    before = controller_targets(_system(battery, is_setup=False))
    assert before[0]["p_limit"] == pytest.approx(0.5 * 40.0)
    after = controller_targets(_system(battery, is_setup=True))
    assert after[0]["p_limit"] == pytest.approx(0.5 * MVA)


def test_a_device_without_a_state_of_charge_has_no_such_variable() -> None:
    (target, _other) = controller_targets(_system(_battery(soc=False)))
    assert target["variables"]["soc"] is None


def test_the_catalogue_says_what_the_case_offers() -> None:
    catalogue = controller_catalogue(_system())
    assert catalogue["types"] == ["droop", "ffr"]
    assert (catalogue["coi_available"], catalogue["freq_hz"], catalogue["base_mva"]) == (
        True, 60.0, 100.0,
    )
    assert len(catalogue["targets"]) == 2
    assert controller_catalogue(_system(with_machines=False))["coi_available"] is False


def test_the_catalogue_of_no_case_has_the_kinds_and_no_devices() -> None:
    assert controller_catalogue(None) == {
        "types": ["droop", "ffr"],
        "coi_available": False,
        "freq_hz": None,
        "base_mva": None,
        "targets": [],
    }
