"""Droop and fast frequency response on a battery, on real ANDES.

IEEE 14 with a generator that trips at t = 1 s (ANDES's ``ieee14_gentrip.xlsx``)
and a 40 MW battery added through the element builder. The runs go through
``Wrapper.run_tds`` in-process, with a step hook of the test's own that reads
ANDES's arrays at every solved instant, so what a controller says it read and
commanded is checked against the System itself: the frequency against the
machines' speeds, the command against the battery's input and output, the times
against the steps ANDES took. This is what contract 13 in
``server/ANDES_VERSIONS.md`` rests on. ``tests/unit/test_tds_controllers.py``
pins each rule to a number on a stand-in; ``test_tds_controllers_api.py`` drives
the same thing over HTTP and the WebSocket.

Markers: ``integration``.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core.disturbance import AlterSpec
from tensa.core.errors import SetupFailedError, TdsRequestError
from tensa.core.tds_controllers import (
    SETPOINT,
    controllable_models,
    controller_targets,
    parse_controllers,
)
from tensa.core.wrapper import TdsBatchResult, Wrapper

pytestmark = [
    pytest.mark.integration,
    # ANDES evaluates the converter's compensated voltage as a complex number and
    # stores its magnitude; numpy says so each time an ESD1 is initialised.
    pytest.mark.filterwarnings("ignore:Casting complex values to real"),
]

BUS = 4
MVA = 100.0
F0 = 60.0
# The battery's limit: pmx = 0.4 on a rating equal to the 100 MVA system base
# (its current limit, ANDES's default of 1.3, is above that).
P_LIMIT = 40.0
# Short of a multiple of the sample period, so the count of samples does not
# hang on whether the last step lands a rounding error before it.
TF = 5.95

DROOP = {"type": "droop", "model": "ESD1", "idx": "ESD1_1", "gain": 100.0, "deadband": 0.02}
FFR = {
    "type": "ffr", "model": "ESD1", "idx": "ESD1_1",
    "power": 30.0, "trigger_deviation": 0.1, "hold": 2.0,
}


def _case() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14" / "ieee14_gentrip.xlsx"


@pytest.fixture(scope="module")
def bus_voltage() -> float:
    """The voltage the battery's bus has before anything is added to it, which
    the static generator the battery takes over is told to hold (so it asks for
    next to no reactive power and the battery starts within its current limit)."""
    wrapper = Wrapper()
    wrapper.load_case(_case())
    return float(wrapper.run_pflow().bus_voltages[BUS])


def _build(bus_voltage: float) -> Wrapper:
    wrapper = Wrapper()
    wrapper.load_case(_case())
    wrapper.add_element(
        "PV",
        {"idx": "PV_B", "name": "PV_B", "bus": BUS, "Sn": MVA, "Vn": 69.0, "p0": 0.0,
         "v0": bus_voltage},
    )
    wrapper.add_element(
        "ESD1",
        {"idx": "ESD1_1", "name": "ESD1_1", "bus": BUS, "gen": "PV_B", "pqflag": 1,
         "pmx": P_LIMIT / MVA, "En": 10.0},
    )
    return wrapper


@dataclass
class Run:
    result: TdsBatchResult
    controllers: list[dict[str, Any]]
    #: One row per call of the step hook, at the solved instant the System held.
    t: np.ndarray
    coi: np.ndarray  # Hz, from the machines' own speeds and inertias
    bus_f: np.ndarray  # Hz, the battery's fHz
    pext: np.ndarray  # MW, the external signal as the battery's equations see it
    output: np.ndarray  # MW, bus voltage times active current
    wrapper: Wrapper

    def at(self, instant: float) -> int:
        """The first row that holds the solution at ``instant``."""
        row = int(np.argmin(np.abs(self.t - instant)))
        assert abs(self.t[row] - instant) < 1e-9, (instant, self.t[row])
        return row

    def from_(self, instant: float) -> int:
        """The first row at or after ``instant`` (an event moves the solved
        instants off the round numbers, so a test cannot name one)."""
        return int(np.argmax(self.t >= instant - 1e-9))


def _run(
    wrapper: Wrapper,
    controllers: list[dict[str, Any]],
    tf: float = TF,
    **kwargs: Any,
) -> Run:
    bank = wrapper.tds_controllers(parse_controllers(controllers))
    rows: list[tuple[float, ...]] = []

    def read(t: float, system: Any) -> None:
        machines, battery = system.GENROU, system.ESD1
        weight = machines.M.v * (machines.u.v > 0.5)
        rows.append(
            (
                max(float(t) - float(system.TDS.h), 0.0),
                float(np.dot(weight, machines.omega.v) / weight.sum()) * F0,
                float(battery.fHz.v[0]),
                float(battery.Pext.v[0]) * MVA,
                float(battery.v.v[0] * battery.Ipout_y.v[0]) * MVA,
            )
        )

    result = wrapper.run_tds(
        tf=tf,
        on_step=read,
        controllers=bank,
        # ANDES stops a run when the tripped machine's angle drifts from the rest.
        tds_config_overrides={"criteria": 0},
        **kwargs,
    )
    table = np.array(rows)
    return Run(
        result=result,
        controllers=bank.results(traces=True) if bank is not None else [],
        t=table[:, 0], coi=table[:, 1], bus_f=table[:, 2], pext=table[:, 3], output=table[:, 4],
        wrapper=wrapper,
    )


@pytest.fixture(scope="module")
def uncontrolled(bus_voltage: float) -> Run:
    return _run(_build(bus_voltage), [])


@pytest.fixture(scope="module")
def droop(bus_voltage: float) -> Run:
    return _run(_build(bus_voltage), [DROOP])


@pytest.fixture(scope="module")
def ffr(bus_voltage: float) -> Run:
    return _run(_build(bus_voltage), [FFR])


def _input(run: Run) -> float:
    """What the battery's external power input holds now, per unit."""
    return float(run.wrapper._require_loaded().ESD1.Pext0.v[0])  # noqa: SLF001


# ---- what ANDES offers ---------------------------------------------------------


def test_the_models_a_controller_commands_are_andes_s_distributed_generation() -> None:
    """Contract 13: the ``DG`` group's models declare ``paux`` as ``Pext0`` and
    carry what a controller reads off a device."""
    import andes

    models = controllable_models(andes.System())
    assert set(models) == {"PVD1", "ESD1", "EV1", "EV2"}
    for name, model in models.items():
        assert model._setpoints[SETPOINT] == "Pext0", name  # noqa: SLF001
        for attr in ("Pext0", "Pext", "fHz", "fn", "pmx", "ialim", "Ipout_y", "v"):
            assert hasattr(model, attr), (name, attr)
        assert hasattr(model, "pIG_y") == (name != "PVD1"), name


def test_the_target_s_limit_is_the_same_megawatts_before_and_after_setup(
    bus_voltage: float, droop: Run
) -> None:
    (before,) = controller_targets(_build(bus_voltage)._require_loaded())  # noqa: SLF001
    (after,) = controller_targets(droop.wrapper._require_loaded())  # noqa: SLF001
    assert before["p_limit"] == pytest.approx(P_LIMIT)
    assert after["p_limit"] == pytest.approx(P_LIMIT)
    assert before["idx"] == "ESD1_1"
    assert before["bus"] == BUS


# ---- frequency droop -----------------------------------------------------------


def test_the_uncontrolled_battery_does_nothing_and_the_frequency_falls(uncontrolled: Run) -> None:
    assert uncontrolled.result.converged
    assert np.abs(uncontrolled.pext).max() == 0.0
    assert np.abs(uncontrolled.output).max() < 0.01
    assert uncontrolled.coi.min() < 59.7


def test_a_droop_reads_the_centre_of_inertia_at_the_instants_andes_solved(droop: Run) -> None:
    (controller,) = droop.controllers
    trace = controller["trace"]
    assert controller["samples"] == len(trace["t"]) == 60  # every 0.1 s from 0 to 5.9 s
    for instant, frequency in zip(trace["t"], trace["frequency"], strict=True):
        # Each sample was taken at an instant the hook saw solved, and read the
        # inertia-weighted speed of the machines still in service there.
        assert frequency == pytest.approx(droop.coi[droop.at(instant)], abs=1e-12)
    # One sample per multiple of the period: the first solved instant at or after it.
    ticks = np.floor(np.array(trace["t"]) / 0.1 + 1e-9)
    assert list(ticks) == list(range(60))
    assert (np.array(trace["t"]) - ticks * 0.1).max() < 1 / 30 + 1e-9


def test_a_droop_commands_what_its_law_says(droop: Run) -> None:
    trace = droop.controllers[0]["trace"]
    deviation = F0 - np.array(trace["frequency"])
    beyond = np.maximum(np.abs(deviation) - 0.02, 0.0)
    assert np.array(trace["command"]) == pytest.approx(100.0 * beyond * np.sign(deviation))
    # Nothing before the trip, the most where the frequency is lowest.
    assert set(trace["command"][:10]) == {0.0}
    assert droop.controllers[0]["first_action_t"] == pytest.approx(1.1, abs=1e-3)
    assert droop.controllers[0]["peak_command"] == pytest.approx(max(trace["command"]))
    assert 10.0 < droop.controllers[0]["peak_command"] < P_LIMIT


def test_the_command_reaches_the_battery_from_the_instant_it_was_sampled(droop: Run) -> None:
    """The step after a sample is solved with the new command: the battery's own
    ``Pext`` variable holds it at the next solved instant, and until the next
    sample."""
    trace = droop.controllers[0]["trace"]
    samples = list(zip(trace["t"], trace["command"], strict=True))
    for (instant, command), (following, _next) in zip(samples, samples[1:], strict=False):
        first = droop.at(instant) + 1
        last = droop.at(following)
        assert droop.pext[first : last + 1] == pytest.approx(command, abs=1e-9)
        # At the sampled instant itself the battery still has the command before.
    assert droop.pext[droop.at(samples[20][0])] == pytest.approx(samples[19][1], abs=1e-9)


def test_the_battery_delivers_the_command_and_the_frequency_falls_less(
    droop: Run, uncontrolled: Run
) -> None:
    assert droop.result.converged
    final = droop.controllers[0]["final_command"]
    assert droop.output[-1] == pytest.approx(final, rel=0.01)
    assert droop.controllers[0]["trace"]["output"][-1] == pytest.approx(final, rel=0.02)
    # 15 MW of a 40 MW trip made up: the nadir is 0.13 Hz higher.
    assert droop.coi.min() > uncontrolled.coi.min() + 0.1
    # The state of charge went down by what was delivered.
    soc = droop.controllers[0]["trace"]["soc"]
    assert soc[0] == pytest.approx(0.5)
    assert soc[-1] < soc[0]


def test_the_input_is_as_it_was_when_the_run_ends(droop: Run, ffr: Run) -> None:
    assert _input(droop) == 0.0
    assert _input(ffr) == 0.0


def test_a_droop_without_p_max_stops_at_the_battery_s_own_limit(bus_voltage: float) -> None:
    run = _run(_build(bus_voltage), [{**DROOP, "gain": 5000.0}])
    assert run.controllers[0]["peak_command"] == pytest.approx(P_LIMIT)
    assert max(run.controllers[0]["trace"]["command"]) == pytest.approx(P_LIMIT)
    assert run.output.max() == pytest.approx(P_LIMIT, rel=0.01)


def test_a_bus_reading_is_the_battery_s_own_fhz(bus_voltage: float) -> None:
    run = _run(_build(bus_voltage), [{**DROOP, "frequency": "bus"}], tf=3.0)
    trace = run.controllers[0]["trace"]
    for instant, frequency in zip(trace["t"], trace["frequency"], strict=True):
        assert frequency == pytest.approx(run.bus_f[run.at(instant)], abs=1e-12)
    # Not the machines' frequency: the bus measurement lags and overshoots it.
    assert np.abs(np.array(trace["frequency"]) - [run.coi[run.at(t)] for t in trace["t"]]).max() > 1e-4


# ---- fast frequency response ---------------------------------------------------


def test_an_ffr_triggers_at_the_first_sample_past_its_threshold(ffr: Run) -> None:
    (controller,) = ffr.controllers
    trace = controller["trace"]
    triggered = controller["first_action_t"]
    frequencies = dict(zip(trace["t"], trace["frequency"], strict=True))
    assert frequencies[triggered] <= F0 - 0.1
    before = [f for t, f in frequencies.items() if t < triggered]
    assert min(before) > F0 - 0.1
    assert triggered == pytest.approx(1.5, abs=1e-3)


def test_an_ffr_holds_its_power_for_its_hold_and_lets_go(ffr: Run) -> None:
    (controller,) = ffr.controllers
    triggered, released = controller["first_action_t"], controller["released_t"]
    assert released - triggered == pytest.approx(2.0, abs=1e-6)
    commands = dict(zip(controller["trace"]["t"], controller["trace"]["command"], strict=True))
    assert {c for t, c in commands.items() if triggered <= t < released} == {30.0}
    assert {c for t, c in commands.items() if t < triggered or t >= released} == {0.0}
    # The battery delivered it while it was held, and nothing after.
    holding = (ffr.t > triggered + 0.3) & (ffr.t <= released)
    assert ffr.output[holding] == pytest.approx(30.0, rel=0.01)
    assert abs(ffr.output[-1]) < 0.01
    assert (controller["peak_command"], controller["final_command"]) == (30.0, 0.0)


def test_two_controllers_on_the_battery_add_up(bus_voltage: float) -> None:
    run = _run(_build(bus_voltage), [DROOP, FFR], tf=3.0)
    droop_part, ffr_part = run.controllers
    assert droop_part["trace"]["t"] == ffr_part["trace"]["t"]
    # The sample the FFR triggers at, with the droop already 0.08 Hz past its band.
    sample = ffr_part["trace"]["t"].index(ffr_part["first_action_t"])
    assert ffr_part["trace"]["command"][sample] == 30.0
    assert droop_part["trace"]["command"][sample] > 5.0
    # The step after that sample was solved with the two commands together.
    held = run.at(droop_part["trace"]["t"][sample]) + 1
    assert run.pext[held] == pytest.approx(droop_part["trace"]["command"][sample] + 30.0)


# ---- the solver's steps --------------------------------------------------------


def test_steps_the_solver_retries_are_not_sampled_twice(bus_voltage: float) -> None:
    """QNDF rejects steps and calls the hook again with a smaller one. The
    samples are still one per period, at instants that only go forward."""
    run = _run(_build(bus_voltage), [DROOP], integrator="qndf")
    assert run.result.converged
    retried = len(run.t) - len(np.unique(run.t.round(9)))
    assert retried > 0, "the run has no retried step, so it tests nothing"
    instants = np.array(run.controllers[0]["trace"]["t"])
    assert np.all(np.diff(instants) > 0)
    assert list(np.floor(instants / 0.1 + 1e-9)) == list(range(60))


def test_the_input_is_put_back_when_a_run_is_aborted(bus_voltage: float) -> None:
    wrapper = _build(bus_voltage)
    bank = wrapper.tds_controllers(parse_controllers([{**DROOP, "gain": 500.0}]))
    abort = threading.Event()
    seen: list[float] = []

    def stop_once_it_acts(t: float, system: Any) -> None:
        seen.append(float(system.ESD1.Pext0.v[0]))
        if seen[-1] != 0.0:
            abort.set()

    result = wrapper.run_tds(
        tf=TF, on_step=stop_once_it_acts, abort_flag=abort, controllers=bank,
        tds_config_overrides={"criteria": 0},
    )
    assert not result.converged
    assert result.final_t < 2.0
    assert seen[-1] != 0.0
    assert float(wrapper._require_loaded().ESD1.Pext0.v[0]) == 0.0  # noqa: SLF001


def test_the_input_is_put_back_when_the_run_raises(bus_voltage: float) -> None:
    """A run that ends in an exception does not return, so nothing after
    ``TDS.run`` is reached; the input is put back all the same."""
    wrapper = _build(bus_voltage)
    bank = wrapper.tds_controllers(parse_controllers([{**DROOP, "gain": 500.0}]))
    seen: list[float] = []

    def fail_once_it_acts(t: float, system: Any) -> None:
        seen.append(float(system.ESD1.Pext0.v[0]))
        if seen[-1] != 0.0:
            raise RuntimeError("the step hook failed")

    with pytest.raises(SetupFailedError, match="TDS.run raised: the step hook failed"):
        wrapper.run_tds(
            tf=TF, on_step=fail_once_it_acts, controllers=bank,
            tds_config_overrides={"criteria": 0},
        )
    assert seen[-1] != 0.0
    assert float(wrapper._require_loaded().ESD1.Pext0.v[0]) == 0.0  # noqa: SLF001


# ---- a run that carries on -----------------------------------------------------


def test_a_run_that_carries_on_keeps_its_controllers_state(bus_voltage: float, ffr: Run) -> None:
    """Stopped at 2.5 s, half way through the FFR's hold, and carried on to 6 s
    with the same controllers: the FFR finishes its hold and does not fire a
    second time, although the frequency is still under its threshold."""
    wrapper = _build(bus_voltage)
    first = _run(wrapper, [FFR], tf=2.5)
    assert first.controllers[0]["first_action_t"] == pytest.approx(1.5, abs=1e-3)
    assert first.controllers[0]["released_t"] is None
    assert _input(first) == 0.0  # taken back between the two runs

    second = _run(wrapper, [FFR], tf=TF)
    (controller,) = second.controllers
    assert controller["first_action_t"] == first.controllers[0]["first_action_t"]
    assert controller["released_t"] == pytest.approx(ffr.controllers[0]["released_t"], abs=1e-3)
    commands = controller["trace"]["command"]
    assert commands[0] == 30.0  # still holding at the first sample of the second run
    assert commands[-1] == 0.0
    assert commands.count(30.0) == 10  # the second half of a 2 s hold at 0.1 s
    assert second.coi.min() < F0 - 0.1  # it would have triggered again
    # The samples reported are the second run's, one a period from where it began.
    instants = np.array(controller["trace"]["t"])
    assert instants[0] == pytest.approx(2.5, abs=1e-3)
    assert np.diff(instants) == pytest.approx(0.1, abs=1e-6)
    assert controller["samples"] == len(instants)


def test_other_controllers_on_the_same_system_start_afresh(bus_voltage: float) -> None:
    wrapper = _build(bus_voltage)
    first = _run(wrapper, [FFR], tf=2.5)
    assert first.controllers[0]["first_action_t"] == pytest.approx(1.5, abs=1e-3)
    # Not the controllers the first part had: this FFR has not fired yet. The
    # first one's power went with its run, so the frequency sinks to the
    # threshold again and this one triggers there, for its own hold.
    second = _run(wrapper, [{**FFR, "hold": 1.0}], tf=5.0)
    (controller,) = second.controllers
    assert controller["first_action_t"] >= 2.5
    assert controller["released_t"] - controller["first_action_t"] == pytest.approx(1.0, abs=1e-6)
    trace = controller["trace"]
    assert trace["t"][0] == pytest.approx(2.5, abs=1e-3)
    assert trace["frequency"][trace["t"].index(controller["first_action_t"])] <= F0 - 0.1


def test_a_run_without_controllers_ends_them(bus_voltage: float) -> None:
    wrapper = _build(bus_voltage)
    _run(wrapper, [FFR], tf=2.0)
    plain = _run(wrapper, [], tf=3.0)
    assert np.abs(plain.pext[2:]).max() == 0.0
    # Naming them again after a run without them starts them afresh: the FFR
    # that fired at 1.5 s fires again, at the first sample of this run.
    again = _run(wrapper, [FFR], tf=4.0)
    assert again.coi[0] < F0 - 0.1
    assert again.controllers[0]["first_action_t"] == pytest.approx(3.0, abs=1e-3)


def test_a_run_without_controllers_that_takes_no_step_ends_them_too(bus_voltage: float) -> None:
    """A run to the ``tf`` the last one reached takes no step, so the System is
    still where the controllers stopped and nothing about it says a run came
    between. The controllers are ended all the same: named again, the FFR that
    was half a second into its hold is one that has not fired."""
    wrapper = _build(bus_voltage)
    first = _run(wrapper, [FFR], tf=2.0)
    assert first.controllers[0]["first_action_t"] == pytest.approx(1.5, abs=1e-3)
    assert first.controllers[0]["released_t"] is None

    idle = wrapper.run_tds(tf=2.0, tds_config_overrides={"criteria": 0})
    assert idle.callpert_count == 0
    assert idle.final_t == first.result.final_t

    again = _run(wrapper, [FFR], tf=4.0)
    (controller,) = again.controllers
    # Carried on, it would still be holding its 30 MW at the first sample of
    # this run, and report the 1.5 s it first acted at.
    assert controller["trace"]["command"][0] == 0.0
    assert controller["first_action_t"] >= 2.0


# ---- what is refused -----------------------------------------------------------


def test_an_alter_on_the_battery_s_input_is_refused_before_anything_is_set_up(
    bus_voltage: float,
) -> None:
    wrapper = _build(bus_voltage)
    wrapper.add_disturbance(
        AlterSpec(model="ESD1", dev_idx="ESD1_1", src="Pext0", t=2.0, method="+", amount=0.1)
    )
    with pytest.raises(TdsRequestError, match="an Alter event of the case writes Pext0"):
        wrapper.tds_controllers(parse_controllers([DROOP]))
    assert wrapper.topology_snapshot().state == "pre-setup"


def test_an_alter_on_the_set_point_steps_the_battery_under_its_controller(
    bus_voltage: float, droop: Run
) -> None:
    wrapper = _build(bus_voltage)
    wrapper.add_disturbance(
        AlterSpec(model="ESD1", dev_idx="ESD1_1", src="pref0", t=0.5, method="+", amount=0.05)
    )
    run = _run(wrapper, [DROOP], tf=3.0)
    # 5 MW from the step before the trip, with the controller idle in its dead band.
    settled = run.from_(0.9)
    assert run.t[settled] < 1.0
    assert run.output[settled] == pytest.approx(5.0, rel=0.02)
    assert run.pext[settled] == 0.0
    # The droop's command comes on top of it.
    command = run.controllers[0]["final_command"]
    assert command > 5.0
    assert run.output[-1] == pytest.approx(5.0 + command, rel=0.02)


@pytest.mark.parametrize(
    ("controller", "message"),
    [
        ({**DROOP, "idx": "ESD1_9"}, "the loaded case has no ESD1 with idx 'ESD1_9'"),
        (
            {**DROOP, "model": "GENROU", "idx": "GENROU_1"},
            "'GENROU' is not a model a controller can command. A controller sets the "
            "auxiliary power input of a distributed generation device (ESD1, PVD1, EV1, "
            "EV2); the loaded case has ESD1",
        ),
        ({**DROOP, "model": "PVD1", "idx": 1}, "the loaded case has no PVD1 with idx 1"),
    ],
)
def test_a_controller_the_case_cannot_bind_is_refused(
    bus_voltage: float, controller: dict[str, Any], message: str
) -> None:
    wrapper = _build(bus_voltage)
    with pytest.raises(TdsRequestError) as refused:
        wrapper.tds_controllers(parse_controllers([controller]))
    assert message in str(refused.value)
    assert wrapper.topology_snapshot().state == "pre-setup"
