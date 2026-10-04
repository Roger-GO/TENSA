"""The power-flow settings and the system summary, against real ANDES.

IEEE 14 (``ieee14.raw``) is a good subject for Q-limit enforcement: the generators
on buses 2 and 6 solve to more reactive power than their limits (15 and 10 MVAr)
allow, so turning the limits on changes the answer. What these tests pin is that
each setting of a request reaches ANDES for that run and no later one, since ANDES
copies ``pv2pq`` into the limiter when it builds the model and leaves the
limiter's flags where a run ends.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tensa.core.errors import PflowRequestError
from tensa.core.wrapper import PflowResult, Wrapper

pytestmark = pytest.mark.integration


def _case(name: str) -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.get_case(name))


def _loaded(name: str = "ieee14/ieee14.raw") -> Wrapper:
    w = Wrapper()
    w.load_case(_case(name))
    return w


def _outputs(pf: PflowResult) -> dict[str, tuple[float, float, float]]:
    return {k: (g.p, g.q, g.v) for k, g in pf.generator_outputs.items()}


def test_a_run_with_no_request_reports_andes_defaults() -> None:
    pf = _loaded().run_pflow()
    assert pf.converged
    assert pf.settings is not None
    assert pf.settings.tolerance == 1e-6
    assert pf.settings.max_iterations == 25
    assert pf.settings.flat_start is False
    assert pf.settings.enforce_q_limits is False


def test_enforcing_q_limits_holds_generators_at_the_limit() -> None:
    w = _loaded()
    free = w.run_pflow()
    held = w.run_pflow(enforce_q_limits=True)
    assert held.converged
    assert held.settings is not None and held.settings.enforce_q_limits is True

    # Without it, the generators on buses 2 and 6 solve past their limits (the
    # point of the option); with it, they sit on them.
    assert free.generator_outputs["2"].q > 15.0 + 1.0
    assert free.generator_outputs["4"].q > 10.0 + 1.0
    assert held.generator_outputs["2"].q == pytest.approx(15.0, abs=1e-3)
    assert held.generator_outputs["4"].q == pytest.approx(10.0, abs=1e-3)
    for out in held.generator_outputs.values():
        assert out.q_min is not None and out.q_max is not None
        assert out.q_min - 1e-3 <= out.q <= out.q_max + 1e-3
    # A generator that gives up the voltage it was holding does not reach it.
    assert held.generator_outputs["2"].v < free.generator_outputs["2"].v - 1e-3
    # Held at the limit, so the slack makes up the rest of the reactive power.
    assert held.generator_outputs["1"].q != pytest.approx(free.generator_outputs["1"].q, abs=1.0)


def test_the_next_run_does_not_inherit_the_limits() -> None:
    """ANDES's limiter keeps the flags a run set (``check_var`` returns early
    once it is off), so a run that does not enforce would otherwise start with
    the generators still held at their limits and report them there."""
    w = _loaded()
    first = w.run_pflow()
    w.run_pflow(enforce_q_limits=True)
    again = w.run_pflow()
    assert again.settings is not None and again.settings.enforce_q_limits is False
    assert again.iterations == first.iterations
    assert _outputs(again) == pytest.approx(_outputs(first), abs=1e-9)

    # ...and the other way round: an enforced run does not depend on what came before.
    ss = w._require_loaded()
    assert ss.PV.qlim.enable == 0
    held = w.run_pflow(enforce_q_limits=True)
    held_again = w.run_pflow(enforce_q_limits=True)
    assert _outputs(held_again) == pytest.approx(_outputs(held), abs=1e-9)


def test_a_case_that_asks_for_q_limits_keeps_them_unless_the_request_says_otherwise() -> None:
    """A case file's ``_config`` can turn ``pv2pq`` on. A request that is silent
    about it runs with the limits on and says so; one that says ``false`` does not."""
    w = _loaded()
    ss = w._require_loaded()
    w.run_pflow()  # sets the System up, which builds the limiters
    ss.PV.qlim.enable = 1
    ss.Slack.qlim.enable = 1

    silent = w.run_pflow()
    assert silent.settings is not None and silent.settings.enforce_q_limits is True
    assert silent.generator_outputs["2"].q == pytest.approx(15.0, abs=1e-3)
    off = w.run_pflow(enforce_q_limits=False)
    assert off.settings is not None and off.settings.enforce_q_limits is False
    assert off.generator_outputs["2"].q > 16.0
    assert ss.PV.qlim.enable == 1  # given back


def test_the_tolerance_reaches_the_solver_for_that_run_only() -> None:
    w = _loaded()
    default = w.run_pflow()
    tight = w.run_pflow(tolerance=1e-12)
    assert tight.converged
    assert tight.settings is not None and tight.settings.tolerance == 1e-12
    assert tight.mismatch < 1e-12
    assert tight.iterations > default.iterations

    after = w.run_pflow()
    assert after.settings is not None and after.settings.tolerance == 1e-6
    assert after.iterations == default.iterations


def test_the_iteration_limit_stops_the_solver_and_is_given_back() -> None:
    w = _loaded()
    short = w.run_pflow(max_iterations=1)
    assert not short.converged
    assert short.settings is not None and short.settings.max_iterations == 1
    assert short.iterations == 2  # ANDES stops once the count passes the limit
    assert short.summary is None
    assert short.generator_outputs == {}

    retry = w.run_pflow(max_iterations=25)
    assert retry.converged
    assert w.run_pflow().converged  # the limit of 1 did not stay behind


def test_what_the_case_sets_is_what_a_silent_request_runs_with() -> None:
    w = _loaded()
    ss = w._require_loaded()
    ss.PFlow.config.max_iter = 1  # as a case file's _config section can
    silent = w.run_pflow()
    assert silent.settings is not None and silent.settings.max_iterations == 1
    assert not silent.converged

    assert w.run_pflow(max_iterations=25).converged
    assert ss.PFlow.config.max_iter == 1


def test_a_flat_start_reaches_the_solver_and_reaches_the_same_solution() -> None:
    w = _loaded()
    default = w.run_pflow()
    ss = w._require_loaded()
    seen: list[Any] = []
    real_run = ss.PFlow.run

    def spy(*args: Any, **kwargs: Any) -> Any:
        seen.append(ss.Bus.config.flat_start)
        return real_run(*args, **kwargs)

    ss.PFlow.run = spy
    try:
        flat = w.run_pflow(flat_start=True)
        w.run_pflow()
    finally:
        del ss.PFlow.run
    assert seen == [1, 0]
    assert flat.converged
    assert flat.settings is not None and flat.settings.flat_start is True
    assert flat.bus_voltages == pytest.approx(default.bus_voltages, abs=1e-6)
    assert ss.Bus.config.flat_start == 0


def test_a_refused_request_touches_nothing() -> None:
    w = _loaded()
    with pytest.raises(PflowRequestError):
        w.run_pflow(tolerance=0.0)
    with pytest.raises(PflowRequestError):
        w.run_pflow(max_iterations=0)
    # Not even the setup that a run does first.
    assert not w._require_loaded().is_setup
    assert w.run_pflow().converged


def test_a_time_domain_run_follows_a_run_that_enforced_the_limits() -> None:
    w = _loaded("ieee14/ieee14_full.xlsx")
    held = w.run_pflow(enforce_q_limits=True)
    assert held.converged
    tds = w.run_tds(tf=0.5, h=1 / 60)
    assert tds.converged
    assert tds.final_t >= 0.49


# ---- the summary ------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "ieee14/ieee14.raw",
        "ieee14/ieee14_full.xlsx",
        "ieee14/ieee14_shuntsw.xlsx",  # switched shunts, which carry geff / beff
        "kundur/kundur_full.xlsx",
    ],
)
@pytest.mark.parametrize("enforce", [False, True])
def test_the_summary_balances(name: str, enforce: bool) -> None:
    """Generation, load, shunts and line losses add up, in P and in Q, to what the
    solver's tolerance allows: this ties every figure of the summary to ANDES's
    own power balance, not to the rows it was added from."""
    pf = _loaded(name).run_pflow(enforce_q_limits=enforce)
    assert pf.converged
    s = pf.summary
    assert s is not None
    assert s.generation_p - s.load_p - s.shunt_p - s.loss_p == pytest.approx(0.0, abs=1e-3)
    assert s.generation_q - s.load_q - s.shunt_q - s.loss_q == pytest.approx(0.0, abs=1e-3)
    assert s.loss_p > 0.0
    assert s.generation_p == pytest.approx(sum(g.p for g in pf.generator_outputs.values()))
    assert s.load_p == pytest.approx(sum(ld.p for ld in pf.load_consumption.values()))


def test_the_summary_figures_of_ieee_14() -> None:
    s = _loaded().run_pflow().summary
    assert s is not None
    assert s.load_p == pytest.approx(223.7)  # the case's total demand, MW
    assert s.load_q == pytest.approx(95.4)
    assert s.loss_p == pytest.approx(2.727, abs=0.001)
    # Two capacitors (19 and 15 MVAr at bus 9 and bus 14) supply about 35 MVAr.
    assert s.shunt_p == 0.0
    assert s.shunt_q == pytest.approx(-35.33, abs=0.01)
    assert s.slack_p == pytest.approx(81.43, abs=0.01)
    assert s.generation_p == pytest.approx(226.43, abs=0.01)


def test_the_slack_output_is_the_slack_generators_own() -> None:
    w = _loaded()
    pf = w.run_pflow()
    slack = w._require_loaded().Slack
    assert len(slack.idx.v) == 1
    row = pf.generator_outputs[str(slack.idx.v[0])]
    assert pf.summary is not None
    assert pf.summary.slack_p == pytest.approx(row.p)
    assert pf.summary.slack_q == pytest.approx(row.q)
    assert 0.0 < pf.summary.slack_p < pf.summary.generation_p


def test_a_shunt_that_draws_active_power_is_in_the_balance() -> None:
    w = _loaded()
    w.add_element("Shunt", {"idx": "Shunt_g", "name": "Shunt_g", "bus": 5, "Vn": 69.0, "g": 0.05, "b": 0.1})
    pf = w.run_pflow()
    assert pf.converged and pf.summary is not None
    s = pf.summary
    assert s.shunt_p == pytest.approx(0.05 * pf.bus_voltages[5] ** 2 * 100.0)
    assert s.generation_p - s.load_p - s.shunt_p - s.loss_p == pytest.approx(0.0, abs=1e-3)
    assert s.generation_q - s.load_q - s.shunt_q - s.loss_q == pytest.approx(0.0, abs=1e-3)


def test_devices_switched_off_count_for_nothing_in_the_summary() -> None:
    """The generator on bus 3 and the first load are out of service. Their rows say
    so, and the books balance without them."""
    w = _loaded()
    ss = w._require_loaded()
    ss.PV.u.v[list(ss.PV.idx.v).index(3)] = 0
    load_idx = str(ss.PQ.idx.v[0])
    ss.PQ.u.v[0] = 0
    pf = w.run_pflow()
    assert pf.converged and pf.summary is not None
    assert (pf.generator_outputs["3"].p, pf.generator_outputs["3"].q) == (0.0, 0.0)
    assert (pf.load_consumption[load_idx].p, pf.load_consumption[load_idx].q) == (0.0, 0.0)
    s = pf.summary
    assert s.generation_p - s.load_p - s.shunt_p - s.loss_p == pytest.approx(0.0, abs=1e-3)
    assert s.generation_q - s.load_q - s.shunt_q - s.loss_q == pytest.approx(0.0, abs=1e-3)


def test_a_switched_shunt_counts_at_the_admittance_it_has_switched_to() -> None:
    """``ShuntSw`` writes ``geff`` / ``beff`` into the bus equations, and the 0.095
    and 0.15 pu it is entered with are only where it starts."""
    w = _loaded("ieee14/ieee14_shuntsw.xlsx")
    pf = w.run_pflow()
    assert pf.converged and pf.summary is not None
    sw = w._require_loaded().ShuntSw
    assert list(sw.beff.v) != list(sw.b.v)
    expected = -sum(float(b) * float(v) ** 2 for b, v in zip(sw.beff.v, sw.v.v, strict=True)) * 100.0
    fixed = w._require_loaded().Shunt
    expected -= sum(float(b) * float(v) ** 2 for b, v in zip(fixed.b.v, fixed.v.v, strict=True)) * 100.0
    assert pf.summary.shunt_q == pytest.approx(expected)


def _bus_out(w: Wrapper, bus: int) -> None:
    ss = w._require_loaded()
    ss.Bus.u.v[list(ss.Bus.idx.v).index(bus)] = 0


def test_what_hangs_on_a_bus_that_is_out_of_service_counts_for_nothing() -> None:
    """A load, a generator or a shunt keeps its own ``u`` of 1 when its bus is out
    of service, and ANDES leaves it out of the equations through ``ue``. Bus 14
    carries a load and a shunt, bus 8 a generator: the rows and the summary agree
    with what the solver saw."""
    for bus in (14, 8):
        w = _loaded()
        _bus_out(w, bus)
        pf = w.run_pflow()
        assert pf.converged and pf.summary is not None
        s = pf.summary
        assert s.generation_p - s.load_p - s.shunt_p - s.loss_p == pytest.approx(0.0, abs=1e-3)
        assert s.generation_q - s.load_q - s.shunt_q - s.loss_q == pytest.approx(0.0, abs=1e-3)

    w = _loaded()
    _bus_out(w, 14)
    ss = w._require_loaded()
    pf = w.run_pflow()
    on_14 = [str(idx) for idx, bus in zip(ss.PQ.idx.v, ss.PQ.bus.v, strict=True) if bus == 14]
    assert on_14
    assert all((pf.load_consumption[i].p, pf.load_consumption[i].q) == (0.0, 0.0) for i in on_14)

    w = _loaded()
    _bus_out(w, 8)
    pf = w.run_pflow()
    ss = w._require_loaded()
    gen_on_8 = next(str(idx) for idx, bus in zip(ss.PV.idx.v, ss.PV.bus.v, strict=True) if bus == 8)
    row = pf.generator_outputs[gen_on_8]
    assert (row.p, row.q) == (0.0, 0.0)
    assert (row.q_min, row.q_max) == (None, None)


def test_there_is_no_summary_for_a_run_that_did_not_converge() -> None:
    pf = _loaded().run_pflow(max_iterations=1)
    assert not pf.converged
    assert pf.summary is None
    assert pf.settings is not None


def test_the_operating_point_carries_neither_settings_nor_summary() -> None:
    w = _loaded()
    w.run_pflow()
    op = w.operating_point()
    assert op.settings is None
    assert op.summary is None
