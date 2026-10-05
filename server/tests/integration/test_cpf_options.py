"""The settings of a continuation power flow, against real ANDES.

IEEE 14 (``ieee14.raw``) and IEEE 39 (``ieee39.xlsx``) are good subjects for
reactive limits. On IEEE 14 the limits change everything: two generators are
past theirs in the plain power flow, with limits enforced all four PV generators
sit on them from the start, and the load can grow by half before the slack
generator runs out too, where without limits it grows more than threefold. On
IEEE 39 three more generators and the slack reach their limits one after another
on the way to the nose.

What these tests pin is what ANDES's CPF does not do by itself (contract 11 in
``server/ANDES_VERSIONS.md``): that generators switch along the path, each where
it reaches its limit and not a step later; that a switch the path cannot get past
ends it there; that each generator's reactive output is read at every step; that
the three directions and a custom one reach the routine; that the lower branch
is traced on request; and that nothing of one run is left for the next.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core.cpf_result import CpfResult
from tensa.core.errors import CpfPrerequisiteError, CpfRequestError
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

# A reactive output may sit this far past a limit, in MVAr: the corrector's
# tolerance of 1e-6 pu on a 100 MVA base, with room to spare.
MVAR_SLACK = 0.05


def _case(name: str) -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.get_case(name))


def _solved(name: str = "ieee14/ieee14.raw", *, enforce_q_limits: bool = False) -> Wrapper:
    w = Wrapper()
    w.load_case(_case(name))
    assert w.run_pflow(enforce_q_limits=enforce_q_limits).converged
    return w


def _system(w: Wrapper) -> Any:
    return w._require_loaded()  # noqa: SLF001


def _within_limits(result: CpfResult) -> bool:
    return all(
        (g.q_max is None or max(g.q) <= g.q_max + MVAR_SLACK)
        and (g.q_min is None or min(g.q) >= g.q_min - MVAR_SLACK)
        for g in result.generators
    )


def _events(result: CpfResult) -> list[tuple[int, str, str, str]]:
    return [(e.step, e.model, e.idx, e.limit) for e in result.limit_events]


# ---- the direction of the increase ------------------------------------------


def test_the_three_built_in_directions_reach_three_different_noses() -> None:
    w = _solved()
    load = w.run_cpf(direction="load")
    load_only = w.run_cpf(direction="load-only")
    gen = w.run_cpf(direction="gen")
    for result, direction in ((load, "load"), (load_only, "load-only"), (gen, "gen")):
        assert result.direction == direction
        assert not result.truncated and result.complete and result.nose_idx > 0
    assert load.max_lam == pytest.approx(3.258, abs=0.01)
    # The slack alone supplying the increase collapses sooner than every
    # generator sharing it; scaling generation alone goes much further.
    assert load_only.max_lam == pytest.approx(2.943, abs=0.01)
    assert gen.max_lam == pytest.approx(7.839, abs=0.02)


def test_the_generation_direction_runs() -> None:
    """It used to hand the routine a bare 2.0 where it takes a target per PV
    generator, and every request for it failed."""
    result = _solved().run_cpf(direction="gen")
    assert len(result.lambdas) > 5 and result.lambdas[1] > 0.0


def test_a_custom_direction_of_every_loads_own_power_is_the_loads_only_curve() -> None:
    """Megawatts in, per unit on the system base to the routine: giving each load
    its own base P and Q as the increase is ``load-only``, point for point."""
    w = _solved()
    ss = _system(w)
    mva = float(ss.config.mva)
    increases = [
        {"idx": idx, "p": float(p) * mva, "q": float(q) * mva}
        for idx, p, q in zip(ss.PQ.idx.v, ss.PQ.p0.v, ss.PQ.q0.v, strict=True)
    ]
    custom = w.run_cpf(direction="custom", load_increase=increases)
    load_only = w.run_cpf(direction="load-only")
    assert custom.direction == "custom"
    assert custom.lambdas == pytest.approx(load_only.lambdas)
    assert custom.voltages_per_bus["14"] == pytest.approx(load_only.voltages_per_bus["14"])


def test_a_custom_direction_moves_only_the_devices_it_names() -> None:
    w = _solved()
    # 10 MW and 3 MVAr more on bus 14's load per unit of lambda, met by generator 2.
    result = w.run_cpf(
        direction="custom",
        load_increase=[{"idx": "PQ_11", "p": 10.0, "q": 3.0}],
        generator_increase=[{"idx": 2, "p": 10.0}],
    )
    assert not result.truncated
    # Lambda counts multiples of 10 MW: the bus takes several of them, far short
    # of the 300-odd per cent of the whole system's load.
    assert 3.0 < result.max_lam < 30.0
    nose = result.nose_idx
    drop = {bus: v[0] - v[nose] for bus, v in result.voltages_per_bus.items()}
    assert max(drop, key=lambda bus: drop[bus]) == "14"


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"load_increase": [{"idx": "PQ_99", "p": 1.0}]}, "not a PQ load"),
        ({"generator_increase": [{"idx": 1, "p": 1.0}]}, "slack generator"),
        ({"load_increase": [{"idx": "PQ_1", "p": 0.0}]}, "nothing to increase"),
    ],
)
def test_a_custom_direction_the_case_cannot_take_is_refused(
    kwargs: dict[str, Any], message: str
) -> None:
    w = _solved()
    with pytest.raises(CpfRequestError, match=message):
        w.run_cpf(direction="custom", **kwargs)
    # Refused before the routine ran: the next request is not affected.
    assert not w.run_cpf().truncated


def test_a_bad_setting_is_refused_before_the_power_flow_is_asked_for() -> None:
    w = Wrapper()
    w.load_case(_case("ieee14/ieee14.raw"))
    with pytest.raises(CpfRequestError, match="stop_at"):
        w.run_cpf(stop_at="lower")
    with pytest.raises(CpfPrerequisiteError, match="PFlow"):
        w.run_cpf()


# ---- the generators along the path ------------------------------------------


def test_every_generators_reactive_output_is_read_at_every_step() -> None:
    w = _solved()
    pf = w.run_pflow()
    result = w.run_cpf()
    assert [(g.model, g.idx, g.bus) for g in result.generators] == [
        ("PV", "2", "2"),
        ("PV", "3", "3"),
        ("PV", "4", "6"),
        ("PV", "5", "8"),
        ("Slack", "1", "1"),
    ]
    for g in result.generators:
        assert len(g.q) == len(result.lambdas)
        # The first step is the power flow the run started from, in its units.
        assert g.q[0] == pytest.approx(pf.generator_outputs[g.idx].q, abs=1e-6)
        assert g.q_max == pytest.approx(pf.generator_outputs[g.idx].q_max)
        assert g.q_min == pytest.approx(pf.generator_outputs[g.idx].q_min)
    by_idx = {g.idx: g for g in result.generators}
    # More load, more reactive power: the generator on bus 2 ends far past the
    # 15 MVAr it is rated for, which is what the trace is there to show.
    assert by_idx["2"].q[result.nose_idx] > 5 * 15.0
    assert result.q_limits_enforced is False and result.limit_events == []


def test_without_enforcement_only_what_the_power_flow_held_is_held() -> None:
    result = _solved(enforce_q_limits=True).run_cpf()
    assert result.q_limits_enforced is False
    # All four PV generators are on their upper limit in the enforced power flow.
    assert _events(result) == [(0, "PV", idx, "qmax") for idx in ("2", "3", "4", "5")]
    assert not any(e.at_nose for e in result.limit_events)
    slack = next(g for g in result.generators if g.model == "Slack")
    assert slack.q_max is not None and max(slack.q) > slack.q_max + 10.0
    assert result.max_lam == pytest.approx(0.7536, abs=0.005)


# ---- reactive limits along the path -----------------------------------------


def test_enforcing_limits_is_refused_when_the_power_flow_broke_them() -> None:
    w = _solved()
    with pytest.raises(CpfPrerequisiteError) as refused:
        w.run_cpf(enforce_q_limits=True)
    message = str(refused.value)
    assert "PV 2 past qmax" in message and "PV 4 past qmax" in message
    assert "reactive limits enforced first" in message
    # The refusal wrote nothing: the plain run is what it was.
    assert w.run_cpf().max_lam == pytest.approx(3.258, abs=0.01)


def test_enforcing_limits_holds_every_generator_within_its_limits() -> None:
    result = _solved(enforce_q_limits=True).run_cpf(enforce_q_limits=True)
    assert result.q_limits_enforced is True
    assert not result.truncated and result.complete
    assert _within_limits(result)
    # The slack is the last generator with reactive power to give. Where it runs
    # out the load can grow no further: half again, not the threefold of a run
    # without limits or the three quarters of one that only keeps the power
    # flow's four.
    assert result.max_lam == pytest.approx(0.517, abs=0.003)
    last = result.limit_events[-1]
    assert (last.model, last.idx, last.limit, last.at_nose) == ("Slack", "1", "qmax", True)
    assert last.step in {result.nose_idx, result.nose_idx + 1}
    assert [e.step for e in result.limit_events[:-1]] == [0, 0, 0, 0]
    # No voltage ran away: following the equations past the switch, as the
    # routine alone does, ends with buses at several per unit.
    assert max(max(v) for v in result.voltages_per_bus.values()) < 1.2


@pytest.mark.parametrize("direction", ["load-only", "gen"])
def test_a_switch_the_path_cannot_get_past_ends_it_there(direction: str) -> None:
    """With the loads alone, or generation alone, growing, the equations have a
    branch beyond the slack's switch on which every voltage climbs without end.
    It is not a state the system can be in (the slack would be at its limit with
    its voltage above the set-point), so the path stops at the switch."""
    result = _solved(enforce_q_limits=True).run_cpf(direction=direction, enforce_q_limits=True)
    assert not result.truncated and result.complete
    assert result.done_msg.startswith("Nose point")
    last = result.limit_events[-1]
    assert (last.model, last.limit, last.at_nose) == ("Slack", "qmax", True)
    assert last.step == result.nose_idx
    assert result.max_lam == pytest.approx(last.lam)
    assert max(max(v) for v in result.voltages_per_bus.values()) < 1.2
    assert _within_limits(result)


def test_generators_switch_one_after_another_on_the_way_to_the_nose() -> None:
    w = _solved("ieee39/ieee39.xlsx", enforce_q_limits=True)
    result = w.run_cpf(enforce_q_limits=True)
    assert _within_limits(result)
    along = [(e.model, e.idx, e.limit) for e in result.limit_events if e.step > 0]
    assert along == [
        ("PV", "13", "qmax"),
        ("PV", "3", "qmax"),
        ("PV", "12", "qmax"),
        ("Slack", "10", "qmax"),
    ]
    # The nose here is a fold a little after the last switch, not the switch.
    assert not any(e.at_nose for e in result.limit_events)
    assert result.max_lam == pytest.approx(0.1375, abs=0.001)
    # Far below the nose with only the power flow's four generators held, and
    # further still below the one with no limits at all.
    assert w.run_cpf().max_lam == pytest.approx(0.362, abs=0.005)

    by_key = {(g.model, g.idx): g for g in result.generators}
    for event in result.limit_events:
        if event.step == 0:
            continue
        trace = by_key[event.model, event.idx]
        assert trace.q_max is not None
        # Free at the step before, on the limit from this one on.
        assert trace.q[event.step - 1] < trace.q_max - MVAR_SLACK
        assert trace.q[event.step:] == pytest.approx([trace.q_max] * (len(trace.q) - event.step))


def test_the_result_says_where_a_held_generator_would_have_left_its_limit() -> None:
    """The power flow holds IEEE 39's generator 14 at qmin, where it absorbs all
    it can because its bus sits above the set-point. As the load grows that
    voltage sinks, and from lambda 0.125 it is below the set-point: a real
    exciter would stop absorbing there. ANDES's limiter does not let go, so the
    last tenth of the path is the one for a generator pinned at qmin, and the
    event says from which step."""
    result = _solved("ieee39/ieee39.xlsx", enforce_q_limits=True).run_cpf(enforce_q_limits=True)
    by_key = {(e.model, e.idx): e for e in result.limit_events}
    pinned = by_key["PV", "14"]
    assert (pinned.step, pinned.limit) == (0, "qmin")
    assert pinned.would_release_step is not None
    assert 0 < pinned.would_release_step < result.nose_idx
    assert result.lambdas[pinned.would_release_step] == pytest.approx(0.125, abs=0.01)
    # The generators on their upper limit only see their voltage fall further.
    assert all(
        e.would_release_step is None for e in result.limit_events if e.limit == "qmax"
    )


def test_a_switch_is_placed_where_the_limit_is_reached_whatever_the_step() -> None:
    """A limiter switches a generator at the first iterate past its limit, which
    with a long step is well beyond where the limit is. Placing each switch makes
    the answer the same for a step five times shorter."""
    w = _solved("ieee39/ieee39.xlsx", enforce_q_limits=True)
    coarse = w.run_cpf(enforce_q_limits=True)
    fine = w.run_cpf(enforce_q_limits=True, step=0.02)
    assert fine.max_lam == pytest.approx(coarse.max_lam, abs=1e-3)
    moved = lambda r: [(e.idx, e.limit) for e in r.limit_events if e.step > 0]  # noqa: E731
    assert moved(fine) == moved(coarse)
    for a, b in zip(
        (e for e in coarse.limit_events if e.step > 0),
        (e for e in fine.limit_events if e.step > 0),
        strict=True,
    ):
        assert a.lam == pytest.approx(b.lam, abs=1e-3)


def test_a_case_whose_limits_never_bind_runs_the_same_with_them_enforced() -> None:
    w = _solved("wscc9/wscc9.raw")
    plain = w.run_cpf()
    enforced = w.run_cpf(enforce_q_limits=True)
    assert enforced.q_limits_enforced is True and enforced.limit_events == []
    assert enforced.max_lam == pytest.approx(plain.max_lam, rel=1e-6)
    assert len(enforced.lambdas) == len(plain.lambdas)


# ---- the lower branch -------------------------------------------------------


def test_a_full_curve_comes_back_to_the_base_load_along_the_lower_branch() -> None:
    w = _solved()
    upper = w.run_cpf()
    full = w.run_cpf(stop_at="full")
    assert (upper.stop_at, full.stop_at) == ("nose", "full")
    assert full.complete and not full.truncated
    assert full.done_msg.startswith("Full curve traced")
    assert full.nose_idx == upper.nose_idx
    assert full.max_lam == pytest.approx(upper.max_lam)
    assert full.lambdas[-1] == pytest.approx(0.0, abs=1e-9)
    # Lambda only falls after the nose, and at the base load the lower branch
    # sits far below the operating point it started from.
    lower = full.lambdas[full.nose_idx :]
    assert all(b < a for a, b in zip(lower, lower[1:], strict=False))
    assert full.voltages_per_bus["14"][-1] < 0.5 < full.voltages_per_bus["14"][0]
    # The routine reads the last point twice (it refines it onto lambda = 0);
    # the generators still line up with the steps.
    assert full.generators and all(len(g.q) == len(full.lambdas) for g in full.generators)


def test_a_full_curve_with_limits_enforced_keeps_the_generators_within_them() -> None:
    w = _solved("ieee39/ieee39.xlsx", enforce_q_limits=True)
    full = w.run_cpf(enforce_q_limits=True, stop_at="full")
    assert full.complete and full.lambdas[-1] == pytest.approx(0.0, abs=1e-9)
    assert full.max_lam == pytest.approx(0.1375, abs=0.001)
    assert 0 < full.nose_idx < len(full.lambdas) - 1
    assert _within_limits(full)
    assert all(len(g.q) == len(full.lambdas) for g in full.generators)


def test_a_full_curve_cut_short_after_the_nose_keeps_its_nose() -> None:
    """The nose of IEEE 14 is 16 steps in. Twenty steps reach it and run out on
    the way down: that is a curve with a nose and an unfinished lower branch,
    not one that never got there."""
    cut = _solved().run_cpf(stop_at="full", max_iter=20)
    assert cut.truncated is False and cut.complete is False
    assert cut.nose_idx == 16 and cut.max_lam == pytest.approx(3.258, abs=0.01)
    assert cut.done_msg == "Reached max steps (20)"
    assert len(cut.lambdas) > cut.nose_idx + 1


def test_a_run_cut_short_before_the_nose_is_truncated() -> None:
    cut = _solved().run_cpf(max_iter=3)
    assert cut.truncated is True and cut.complete is False and cut.nose_idx == -1
    assert all(len(g.q) == len(cut.lambdas) for g in cut.generators)


# ---- nothing of one run is left for the next --------------------------------


def test_a_runs_step_and_step_count_do_not_stay_for_the_next_request() -> None:
    """They were written to the routine's config and left there, so one request
    with three steps truncated every later one that asked for nothing."""
    w = _solved()
    assert w.run_cpf(max_iter=3, step=0.01).truncated is True
    after = w.run_cpf()
    assert after.truncated is False
    assert after.max_lam == pytest.approx(3.258, abs=0.01)
    config = _system(w).CPF.config
    assert (config.step, config.max_steps, config.stop_at) == (0.1, 500, "NOSE")


def test_an_enforced_run_leaves_the_system_as_the_power_flow_solved_it() -> None:
    w = _solved("ieee39/ieee39.xlsx", enforce_q_limits=True)
    ss = _system(w)
    limiters = (ss.PV.qlim, ss.Slack.qlim)

    def state() -> dict[str, Any]:
        return {
            "x": np.array(ss.dae.x),
            "y": np.array(ss.dae.y),
            "flags": [np.array(getattr(lim, f)) for lim in limiters for f in ("zl", "zu", "zi")],
            "latches": [np.array(getattr(lim, f)) for lim in limiters for f in ("ql", "qu")],
            "counts": [(lim.nql, lim.nqu) for lim in limiters],
            "switches": [(lim.enable, lim.min_iter) for lim in limiters],
            "config": tuple(
                getattr(ss.CPF.config, name)
                for name in ("step", "max_steps", "stop_at", "linsolve")
            ),
        }

    first = w.run_cpf(enforce_q_limits=True)
    before = state()
    result = w.run_cpf(enforce_q_limits=True, stop_at="full", step=0.05, max_iter=400)
    # The run did switch generators the power flow had left free.
    assert any(e.step > 0 for e in result.limit_events)
    after = state()
    np.testing.assert_allclose(after["x"], before["x"])
    np.testing.assert_allclose(after["y"], before["y"])
    for name in ("flags", "latches"):
        for a, b in zip(after[name], before[name], strict=True):
            np.testing.assert_array_equal(a, b)
    assert after["counts"] == before["counts"]
    assert after["switches"] == before["switches"]
    assert after["config"] == before["config"]
    # The wrapped methods are the routine's own again.
    assert not {"_bus_vmag", "_corrector"} & set(vars(ss.CPF))

    # And the session goes on as if the run had not happened.
    pf = w.run_pflow(enforce_q_limits=True)
    assert pf.converged
    again = w.run_cpf(enforce_q_limits=True)
    assert again.lambdas == pytest.approx(first.lambdas)
    assert _events(again) == _events(first)


def test_a_plain_run_after_an_enforced_one_is_the_plain_run() -> None:
    w = _solved(enforce_q_limits=True)
    plain = w.run_cpf()
    assert w.run_cpf(enforce_q_limits=True).q_limits_enforced is True
    again = w.run_cpf()
    assert again.q_limits_enforced is False
    assert again.lambdas == pytest.approx(plain.lambdas)


# ---- the QV curve -----------------------------------------------------------


def test_a_qv_curve_reads_the_generators_and_takes_the_limits() -> None:
    w = _solved(enforce_q_limits=True)
    plain = w.run_cpf_qv(bus_idx="5")
    held = w.run_cpf_qv(bus_idx="5", enforce_q_limits=True)
    for result in (plain, held):
        assert result.mode == "qv" and result.direction is None
        assert len(result.generators) == 5
        assert all(len(g.q) == len(result.lambdas) for g in result.generators)
    assert plain.q_limits_enforced is False and not _within_limits(plain)
    assert held.q_limits_enforced is True and _within_limits(held)
    # The bus takes much less reactive load once the slack may not go past its limit.
    assert max(held.lambdas) < 0.5 * max(plain.lambdas)
    last = held.limit_events[-1]
    assert (last.model, last.limit, last.at_nose) == ("Slack", "qmax", True)


def test_a_qv_curves_peak_is_the_largest_reactive_power_it_reached() -> None:
    """``lambdas`` of a QV curve holds the reactive power at the bus. The peak
    used to be the routine's own parameter, a fraction of the swept range: 1.17
    for a curve that reached 5.87 pu."""
    result = _solved().run_cpf_qv(bus_idx="5")
    assert result.max_lam == pytest.approx(max(result.lambdas))
    assert result.max_lam == pytest.approx(result.lambdas[result.nose_idx])
    assert result.max_lam == pytest.approx(5.87, abs=0.01)


def test_a_qv_curve_with_limits_is_refused_when_the_power_flow_broke_them() -> None:
    w = _solved()
    with pytest.raises(CpfPrerequisiteError, match="past a reactive limit"):
        w.run_cpf_qv(bus_idx="5", enforce_q_limits=True)
    assert w.run_cpf_qv(bus_idx="5").nose_idx > 0
