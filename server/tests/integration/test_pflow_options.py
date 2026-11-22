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


def _outputs(pf: PflowResult) -> dict[str, float]:
    """Each generator's P, Q and V, flat: ``pytest.approx`` takes no nested values."""
    return {
        f"{k}.{name}": value
        for k, g in pf.generator_outputs.items()
        for name, value in (("p", g.p), ("q", g.q), ("v", g.v))
    }


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
    for bad in ({"method": "nr"}, {"n_factorize": 0}, {"linesearch": 1}):
        with pytest.raises(PflowRequestError):
            w.run_pflow(**bad)
    # Not even the setup that a run does first.
    assert not w._require_loaded().is_setup
    assert w.run_pflow().converged


# ---- the solver: method, n_factorize, linesearch ----------------------------


def _spy_on_solver_config(w: Wrapper) -> list[tuple[Any, Any, Any]]:
    """Record ``PFlow.config``'s solver settings each time ``PFlow.run`` is called."""
    ss = w._require_loaded()
    seen: list[tuple[Any, Any, Any]] = []
    real_run = ss.PFlow.run

    def spy(*args: Any, **kwargs: Any) -> Any:
        config = ss.PFlow.config
        seen.append((config.method, config.n_factorize, config.linesearch))
        return real_run(*args, **kwargs)

    ss.PFlow.run = spy
    return seen


def test_the_solver_settings_reach_andes_for_that_run_only() -> None:
    w = _loaded()
    seen = _spy_on_solver_config(w)
    asked = w.run_pflow(method="dishonest", n_factorize=2, linesearch=False)
    plain = w.run_pflow()
    assert seen == [("dishonest", 2, 0), ("NR", 4, 1)]
    assert asked.settings is not None and plain.settings is not None
    assert (asked.settings.method, asked.settings.n_factorize, asked.settings.linesearch) == (
        "dishonest",
        2,
        False,
    )
    assert (plain.settings.method, plain.settings.n_factorize, plain.settings.linesearch) == (
        "NR",
        4,
        True,
    )


def test_the_dishonest_method_reuses_the_jacobian_after_n_factorize_iterations() -> None:
    """On Kundur's system NR converges in 4 iterations. Refactorising only on the
    first takes several times as many to the same solution; refactorising on the
    first 100 is NR again, iteration for iteration."""
    w = _loaded("kundur/kundur_full.xlsx")
    nr = w.run_pflow()
    once = w.run_pflow(method="dishonest", n_factorize=1)
    always = w.run_pflow(method="dishonest", n_factorize=100)
    assert nr.converged and once.converged and always.converged
    # 22 against 4 on this machine: a margin no other LAPACK moves it across.
    assert once.iterations > 2 * nr.iterations
    # Exact, because it is the same computation: with n_factorize past every
    # iteration the dishonest branch refactorises on each, which is NR's path.
    assert always.iterations == nr.iterations
    assert once.bus_voltages == pytest.approx(nr.bus_voltages, abs=1e-6)
    assert once.bus_angles == pytest.approx(nr.bus_angles, abs=1e-6)

    after = w.run_pflow()
    assert after.settings is not None and after.settings.method == "NR"
    assert after.iterations == nr.iterations  # the first run again, on the same machine


def test_newton_krylov_reaches_the_newton_solution_by_its_own_stopping_rule() -> None:
    w = _loaded()
    nr = w.run_pflow()
    nk = w.run_pflow(method="NK")
    assert nk.converged
    assert nk.settings is not None and nk.settings.method == "NK"
    # SciPy stops once the largest residual is under its own tolerance (the
    # cube root of the machine epsilon, about 6e-6 pu), so that is what the
    # residual is held to, and the voltages to a margin over it.
    assert nk.iterations == 0  # SciPy keeps no count ANDES reads
    assert 0.0 <= nk.mismatch < 1e-5
    assert nk.bus_voltages == pytest.approx(nr.bus_voltages, abs=1e-4)
    assert nk.bus_angles == pytest.approx(nr.bus_angles, abs=1e-4)
    # It reads neither ANDES's tolerance nor its iteration limit.
    assert w.run_pflow(method="NK", max_iterations=1).converged

    after = w.run_pflow()
    assert after.settings is not None and after.settings.method == "NR"
    assert after.iterations == nr.iterations  # the first run again, on the same machine


def test_newton_krylov_prints_nothing(capsys: pytest.CaptureFixture[str]) -> None:
    """ANDES 2.0.0 runs SciPy's solver verbose, which prints a line per
    iteration; the wrapper keeps that off standard output, converged or not."""
    w = _loaded()
    capsys.readouterr()
    assert w.run_pflow(method="NK").converged
    assert capsys.readouterr().out == ""

    failing = _overloaded("ieee14/ieee14.raw", 20.0)
    capsys.readouterr()
    assert not failing.run_pflow(method="NK").converged
    assert capsys.readouterr().out == ""


def _overloaded(name: str, scale: float) -> Wrapper:
    """A case set up with every load scaled by ``scale``, past what it can carry."""
    w = _loaded(name)
    w._ensure_setup()
    ss = w._require_loaded()
    ss.PQ.p0.v[:] *= scale
    ss.PQ.q0.v[:] *= scale
    return w


class _CountingNumpy:
    """``numpy`` as ANDES's power flow module sees it, counting ``empty_like``.

    ``nr_solve`` calls ``np.empty_like`` only to keep the point a line search
    steps back from (twice, for ``x`` and ``y``, before the first iteration),
    and nothing else in the module calls it, so the count says whether the run
    took the line-search branch whatever the numbers it computed."""

    def __init__(self, real: Any) -> None:
        self._real = real
        self.empty_like_calls = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)

    def empty_like(self, *args: Any, **kwargs: Any) -> Any:
        self.empty_like_calls += 1
        return self._real.empty_like(*args, **kwargs)


def test_the_line_search_setting_decides_the_branch_nr_solve_takes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from andes.routines import pflow as andes_pflow

    counting = _CountingNumpy(andes_pflow.np)
    monkeypatch.setattr(andes_pflow, "np", counting)
    w = _loaded()

    searched = w.run_pflow()
    assert searched.converged and counting.empty_like_calls == 2

    counting.empty_like_calls = 0
    unsearched = w.run_pflow(linesearch=False)
    assert unsearched.converged and counting.empty_like_calls == 0
    assert unsearched.settings is not None and unsearched.settings.linesearch is False
    # IEEE 14 takes the full Newton step every time, so both reach one solution.
    assert unsearched.bus_voltages == pytest.approx(searched.bus_voltages, abs=1e-6)

    # The case's own setting is back for the next run, in the config and in the branch.
    assert w._require_loaded().PFlow.config.linesearch == 1
    counting.empty_like_calls = 0
    again = w.run_pflow()
    assert again.settings is not None and again.settings.linesearch is True
    assert counting.empty_like_calls == 2

    # The setting is NR's and the dishonest method's, not Newton-Krylov's.
    counting.empty_like_calls = 0
    assert w.run_pflow(method="dishonest", linesearch=True).converged
    assert counting.empty_like_calls == 2
    counting.empty_like_calls = 0
    assert w.run_pflow(method="NK", linesearch=True).converged
    assert counting.empty_like_calls == 0


def test_newton_krylov_that_does_not_converge_says_so() -> None:
    """ANDES 2.0.0 raises from a Newton-Krylov run that fails (the ``IndexError``
    of ``mis[-2]`` after the ``ValueError`` it catches, or SciPy's
    ``NoConvergence``, which it does not); the wrapper answers either as a run
    that did not converge, with the settings given back."""
    w = _overloaded("ieee14/ieee14.raw", 20.0)
    failed = w.run_pflow(method="NK")
    assert not failed.converged
    assert failed.summary is None
    assert failed.settings is not None and failed.settings.method == "NK"
    assert failed.mismatch > 1e-6
    assert w._require_loaded().PFlow.config.method == "NR"


def test_newton_krylov_out_of_iterations_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    """SciPy's ``NoConvergence``, which ANDES does not catch at all."""
    from andes.routines import pflow as andes_pflow
    from scipy.optimize import NoConvergence

    def gives_up(*args: Any, **kwargs: Any) -> Any:
        raise NoConvergence("out of iterations")

    monkeypatch.setattr(andes_pflow, "newton_krylov", gives_up)
    w = _loaded()
    failed = w.run_pflow(method="NK")
    assert not failed.converged
    assert w._require_loaded().PFlow.config.method == "NR"


def test_only_a_newton_krylov_failure_is_taken_for_non_convergence() -> None:
    w = _loaded()
    ss = w._require_loaded()

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise IndexError("not a solver outcome")

    ss.PFlow.run = broken
    with pytest.raises(IndexError):
        w.run_pflow()
    with pytest.raises(IndexError):
        w.run_pflow(method="dishonest")
    assert ss.PFlow.config.method == "NR"


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
