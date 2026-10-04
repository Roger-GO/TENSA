"""Unit tests for the power-flow settings and the system summary.

The settings of a request (tolerance, iteration limit, flat start, Q-limit
enforcement) reach ANDES through ``pflow_options_applied``, which writes them for
one run and puts back what it found. These run against stand-ins for the parts of
an ANDES System it touches, so what is checked is the bookkeeping: what is written,
what is restored, what the limiter flags look like at the start and the end of a
run, and what a bad value is refused with. The same things against a real System
are in ``tests/integration/test_pflow_options.py``.

``_summarize_pflow`` adds up the rows the other extractors made, so its stand-in is
the rows themselves.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from tensa.api.schemas import PflowRunRequest
from tensa.core import worker
from tensa.core.errors import PflowRequestError
from tensa.core.pflow_options import (
    MAX_ITERATIONS_MAX,
    TOLERANCE_MAX,
    TOLERANCE_MIN,
    PflowSettings,
    pflow_options_applied,
    validate_pflow_options,
)
from tensa.core.wrapper import (
    GeneratorOutput,
    LineFlow,
    LoadConsumption,
    _shunt_absorption,
    _summarize_pflow,
)

pytestmark = pytest.mark.unit


# ---- validation ------------------------------------------------------------


def test_nothing_asked_is_valid() -> None:
    validate_pflow_options()


def test_the_documented_extremes_are_valid() -> None:
    validate_pflow_options(
        tolerance=TOLERANCE_MIN, max_iterations=1, flat_start=False, enforce_q_limits=True
    )
    validate_pflow_options(tolerance=TOLERANCE_MAX, max_iterations=MAX_ITERATIONS_MAX)


@pytest.mark.parametrize(
    "tolerance",
    [0, -1e-6, 0.5, TOLERANCE_MIN / 10, float("nan"), float("inf"), True, "1e-6", 10**400],
)
def test_a_tolerance_out_of_range_or_not_a_number_is_refused(tolerance: Any) -> None:
    with pytest.raises(PflowRequestError, match="tolerance"):
        validate_pflow_options(tolerance=tolerance)


@pytest.mark.parametrize("max_iterations", [0, -3, MAX_ITERATIONS_MAX + 1, 25.0, 25.5, True, "25"])
def test_an_iteration_limit_out_of_range_or_not_whole_is_refused(max_iterations: Any) -> None:
    with pytest.raises(PflowRequestError, match="max_iterations"):
        validate_pflow_options(max_iterations=max_iterations)


@pytest.mark.parametrize("name", ["flat_start", "enforce_q_limits"])
@pytest.mark.parametrize("value", [1, 0, "yes", "true", 1.0])
def test_a_flag_that_is_not_a_boolean_is_refused(name: str, value: Any) -> None:
    with pytest.raises(PflowRequestError, match=name):
        validate_pflow_options(**{name: value})


def test_the_message_quotes_a_long_value_cut_short() -> None:
    with pytest.raises(PflowRequestError) as raised:
        validate_pflow_options(tolerance="x" * 500)
    assert len(str(raised.value)) < 200


# ---- the request body ------------------------------------------------------


def test_the_request_body_is_all_optional() -> None:
    body = PflowRunRequest()
    assert body.model_dump(exclude_none=True) == {}


def test_the_request_body_carries_what_was_asked() -> None:
    body = PflowRunRequest(
        tolerance=1e-4, max_iterations=50, flat_start=True, enforce_q_limits=True
    )
    assert body.model_dump(exclude_none=True) == {
        "tolerance": 1e-4,
        "max_iterations": 50,
        "flat_start": True,
        "enforce_q_limits": True,
    }


@pytest.mark.parametrize(
    "payload",
    [
        {"tolerance": 0},
        {"tolerance": 1.0},
        {"tolerance": float("nan")},
        {"max_iterations": 0},
        {"max_iterations": MAX_ITERATIONS_MAX + 1},
        {"max_iterations": 2.5},
        {"flat_start": "maybe"},
        {"method": "NR"},  # a setting this request does not have
    ],
)
def test_the_request_body_refuses_what_the_wrapper_would(payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        PflowRunRequest(**payload)


def test_the_worker_forwards_only_the_settings_the_request_names() -> None:
    calls: list[dict[str, Any]] = []

    class _Wrapper:
        def run_pflow(self, **options: Any) -> Any:
            calls.append(options)
            return PflowSettings(1e-6, 25, False, False)

    handler = worker._handle_run_pflow
    handler(_Wrapper(), {})  # type: ignore[arg-type]
    handler(_Wrapper(), {"tolerance": None, "flat_start": False, "max_iterations": 40})  # type: ignore[arg-type]
    assert calls == [{}, {"flat_start": False, "max_iterations": 40}]


# ---- applying and restoring ------------------------------------------------


def _limiter(n: int = 2, *, enable: Any = 0) -> SimpleNamespace:
    """A stand-in for a ``SortedLimiter`` as it is left by a run that held every
    generator at its upper limit."""
    return SimpleNamespace(
        enable=enable,
        zl=np.zeros(n),
        zu=np.ones(n),
        zi=np.zeros(n),
        ql=np.zeros(n),
        qu=np.ones(n),
        nql=0,
        nqu=n,
    )


def _system(*, converged: bool = True, slack: bool = True, **limiter_kwargs: Any) -> Any:
    ss = SimpleNamespace(
        PFlow=SimpleNamespace(config=SimpleNamespace(tol=1e-6, max_iter=25), converged=converged),
        Bus=SimpleNamespace(config=SimpleNamespace(flat_start=0)),
        PV=SimpleNamespace(qlim=_limiter(**limiter_kwargs)),
    )
    if slack:
        ss.Slack = SimpleNamespace(qlim=_limiter(1, **limiter_kwargs))
    return ss


def test_the_request_is_written_for_the_run_and_the_system_is_given_back() -> None:
    ss = _system()
    with pflow_options_applied(
        ss, tolerance=1e-4, max_iterations=60, flat_start=True, enforce_q_limits=True
    ) as used:
        assert ss.PFlow.config.tol == 1e-4
        assert ss.PFlow.config.max_iter == 60
        assert ss.Bus.config.flat_start == 1
        assert ss.PV.qlim.enable is True
        assert ss.Slack.qlim.enable is True
        assert used == PflowSettings(1e-4, 60, True, True)
    assert ss.PFlow.config.tol == 1e-6
    assert ss.PFlow.config.max_iter == 25
    assert ss.Bus.config.flat_start == 0
    assert ss.PV.qlim.enable == 0
    assert ss.Slack.qlim.enable == 0


def test_what_the_request_leaves_out_keeps_the_systems_own_value() -> None:
    """A case file's ``_config`` can set any of them; a request that says
    nothing about it must run with that, and report it."""
    ss = _system(enable=1)
    ss.PFlow.config.tol = 1e-8
    ss.PFlow.config.max_iter = 40
    ss.Bus.config.flat_start = 1
    with pflow_options_applied(ss, max_iterations=10) as used:
        assert used == PflowSettings(1e-8, 10, True, True)
    assert ss.PFlow.config.max_iter == 40
    assert ss.PV.qlim.enable == 1


def test_a_request_can_switch_off_what_the_case_switched_on() -> None:
    ss = _system(enable=1)
    with pflow_options_applied(ss, enforce_q_limits=False) as used:
        assert used.enforce_q_limits is False
        assert not ss.PV.qlim.enable
    assert ss.PV.qlim.enable == 1


def test_a_run_that_raises_still_gives_the_system_back() -> None:
    ss = _system(converged=False)
    with pytest.raises(RuntimeError), pflow_options_applied(ss, tolerance=1e-3, flat_start=True):
        raise RuntimeError("solver blew up")
    assert ss.PFlow.config.tol == 1e-6
    assert ss.Bus.config.flat_start == 0


def test_a_run_starts_with_the_limiter_flags_cleared() -> None:
    """A previous run left generators held at their limits. Without the reset a
    run that does not enforce limits would start from them (``check_var``
    returns early when the limiter is off) and report them as if the case did."""
    ss = _system()
    with pflow_options_applied(ss):
        for limiter in (ss.PV.qlim, ss.Slack.qlim):
            assert not limiter.zu.any()
            assert not limiter.zl.any()
            assert limiter.zi.all()
            assert not limiter.qu.any()
            assert not limiter.ql.any()
            assert limiter.nqu == 0


def test_a_converged_run_keeps_the_flags_its_solution_needs() -> None:
    ss = _system(converged=True)
    with pflow_options_applied(ss, enforce_q_limits=True):
        ss.PV.qlim.zu[:] = 1.0  # what the solver does while it runs
        ss.PV.qlim.zi[:] = 0.0
    assert ss.PV.qlim.zu.all()
    assert not ss.PV.qlim.zi.any()
    assert ss.PV.qlim.enable == 0


def test_a_run_that_did_not_converge_leaves_the_flags_cleared() -> None:
    """A time-domain run asks for a power flow again when none converged, with
    the limiter off; flags left by the failed run must not hold generators at a
    limit there."""
    ss = _system(converged=False)
    with pflow_options_applied(ss, enforce_q_limits=True):
        ss.PV.qlim.zu[:] = 1.0
    assert not ss.PV.qlim.zu.any()
    assert ss.PV.qlim.zi.all()


def test_a_system_without_generators_has_nothing_to_enforce() -> None:
    ss = SimpleNamespace(
        PFlow=SimpleNamespace(config=SimpleNamespace(tol=1e-6, max_iter=25), converged=False),
        Bus=SimpleNamespace(config=SimpleNamespace(flat_start=0)),
    )
    with pflow_options_applied(ss, enforce_q_limits=True) as used:  # type: ignore[arg-type]
        assert used.enforce_q_limits is False


# ---- the system summary ----------------------------------------------------


def _rows() -> tuple[
    dict[str, LineFlow], dict[str, GeneratorOutput], dict[str, LoadConsumption]
]:
    lines = {
        "L1": LineFlow(
            p=60.0, q=10.0, from_idx=1, to_idx=2, p_to=-58.0, q_to=-12.0, loss=2.0,
            rate_a=None, loading_pct=None,
        ),
        "L2": LineFlow(
            p=30.0, q=5.0, from_idx=2, to_idx=3, p_to=-29.5, q_to=-6.5, loss=0.5,
            rate_a=None, loading_pct=None,
        ),
    }
    gens = {
        "1": GeneratorOutput(p=60.0, q=10.0, v=1.04, bus=1),  # the slack
        "2": GeneratorOutput(p=30.0, q=20.0, v=1.02, bus=2),
        "3": GeneratorOutput(p=0.0, q=0.0, v=1.0, bus=3),  # switched off
    }
    loads = {
        "PQ_1": LoadConsumption(p=50.0, q=15.0, bus=2),
        "PQ_2": LoadConsumption(p=37.5, q=5.0, bus=3),
    }
    return lines, gens, loads


def _summary_system(
    *, shunt: dict[str, list[float]] | None = None, slack_u: float = 1.0
) -> Any:
    ss: dict[str, Any] = {
        "config": SimpleNamespace(mva=100.0),
        "Slack": SimpleNamespace(
            idx=SimpleNamespace(v=np.array([1])), u=SimpleNamespace(v=np.array([slack_u]))
        ),
    }
    if shunt is not None:
        ss["Shunt"] = SimpleNamespace(**{k: SimpleNamespace(v=np.array(v)) for k, v in shunt.items()})
    return SimpleNamespace(**ss)


def test_the_summary_adds_up_the_rows() -> None:
    lines, gens, loads = _rows()
    summary = _summarize_pflow(_summary_system(), lines, gens, loads)
    assert summary.generation_p == pytest.approx(90.0)
    assert summary.generation_q == pytest.approx(30.0)
    assert summary.load_p == pytest.approx(87.5)
    assert summary.load_q == pytest.approx(20.0)
    assert summary.loss_p == pytest.approx(2.5)
    # Net reactive absorption of the lines: (10 - 12) + (5 - 6.5)
    assert summary.loss_q == pytest.approx(-3.5)
    assert (summary.shunt_p, summary.shunt_q) == (0.0, 0.0)


def test_the_slack_output_is_the_slack_generators_row() -> None:
    lines, gens, loads = _rows()
    summary = _summarize_pflow(_summary_system(), lines, gens, loads)
    assert summary.slack_p == pytest.approx(60.0)
    assert summary.slack_q == pytest.approx(10.0)


def test_a_slack_switched_off_has_no_output_to_report() -> None:
    lines, gens, loads = _rows()
    summary = _summarize_pflow(_summary_system(slack_u=0.0), lines, gens, loads)
    assert summary.slack_p is None
    assert summary.slack_q is None


def test_a_system_with_no_slack_has_no_slack_output() -> None:
    lines, gens, loads = _rows()
    ss = _summary_system()
    del ss.Slack
    summary = _summarize_pflow(ss, lines, gens, loads)
    assert summary.slack_p is None
    assert summary.generation_p == pytest.approx(90.0)


def test_a_capacitor_absorbs_negative_reactive_power() -> None:
    # 0.19 pu of susceptance at 1.02 pu on 100 MVA: -0.19 * 1.02**2 * 100 MVAr
    shunt = {"u": [1.0], "g": [0.0], "b": [0.19], "v": [1.02]}
    p, q = _shunt_absorption(_summary_system(shunt=shunt), 100.0)
    assert p == 0.0
    assert q == pytest.approx(-0.19 * 1.02**2 * 100.0)


def test_a_shunt_with_conductance_absorbs_active_power_and_one_switched_off_nothing() -> None:
    shunt = {"u": [1.0, 0.0], "g": [0.02, 0.5], "b": [-0.1, 0.5], "v": [0.98, 1.0]}
    p, q = _shunt_absorption(_summary_system(shunt=shunt), 100.0)
    assert p == pytest.approx(0.02 * 0.98**2 * 100.0)
    assert q == pytest.approx(0.1 * 0.98**2 * 100.0)


def test_the_shunts_enter_the_summary() -> None:
    lines, gens, loads = _rows()
    shunt = {"u": [1.0], "g": [0.0], "b": [0.2], "v": [1.0]}
    summary = _summarize_pflow(_summary_system(shunt=shunt), lines, gens, loads)
    assert summary.shunt_q == pytest.approx(-20.0)


def test_a_shunt_whose_arrays_disagree_is_left_out() -> None:
    shunt = {"u": [1.0, 1.0], "g": [0.0], "b": [0.2], "v": [1.0]}
    assert _shunt_absorption(_summary_system(shunt=shunt), 100.0) == (0.0, 0.0)


def test_the_totals_follow_the_system_base() -> None:
    shunt = {"u": [1.0], "g": [0.0], "b": [0.2], "v": [1.0]}
    ss = _summary_system(shunt=shunt)
    assert _shunt_absorption(ss, 1000.0)[1] == pytest.approx(-200.0)
