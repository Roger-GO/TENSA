"""Unit tests for the settings of a continuation power flow.

``tensa.core.cpf_options`` turns a request's direction into the targets ANDES's
CPF takes, and wraps one run of the routine: it switches the reactive limiters
on, places each switch, refuses the steps that follow a switch the path cannot
get past, reads the generators at every point the routine keeps, and puts back
what it wrote. These run against stand-ins for the parts of an ANDES System and
of its CPF routine that the module touches, so what is checked is the
bookkeeping. The same things against the real routine are in
``tests/integration/test_cpf_options.py``.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from pydantic import ValidationError

from tensa.api.routes.cpf import CpfQvRunRequest, CpfRunRequest
from tensa.core import worker
from tensa.core.cpf_options import (
    SWITCH_STEP,
    cpf_run_applied,
    direction_targets,
    generators_past_limits,
    validate_cpf_options,
)
from tensa.core.errors import CpfPrerequisiteError, CpfRequestError
from tensa.core.wrapper import _first_turn

pytestmark = pytest.mark.unit


# ---- stand-ins --------------------------------------------------------------


def _holder(values: Any) -> SimpleNamespace:
    return SimpleNamespace(v=np.array(values, dtype=float))


class _Limiter:
    """The fields of a ``SortedLimiter`` the run reads and writes."""

    def __init__(self, n: int, enable: Any = 0) -> None:
        self.enable = enable
        self.min_iter = 2
        self.zl = np.zeros(n)
        self.zu = np.zeros(n)
        self.zi = np.ones(n)
        self.ql = np.zeros(n)
        self.qu = np.zeros(n)
        self.nql = 0
        self.nqu = 0

    def hold_upper(self, i: int) -> None:
        self.zu[i] = self.qu[i] = 1.0
        self.zi[i] = 0.0
        self.nqu = int(self.qu.sum())


def _generators(
    idx: list[Any],
    *,
    q: list[float],
    qmax: list[float],
    qmin: list[float] | None = None,
    bus: list[Any] | None = None,
    u: list[float] | None = None,
    enable: Any = 0,
) -> SimpleNamespace:
    n = len(idx)
    return SimpleNamespace(
        n=n,
        idx=SimpleNamespace(v=list(idx)),
        bus=SimpleNamespace(v=list(bus if bus is not None else idx)),
        q=_holder(q),
        qmax=_holder(qmax),
        qmin=_holder(qmin if qmin is not None else [-9.0] * n),
        v=_holder([1.0] * n),
        v0=_holder([1.0] * n),
        u=_holder(u if u is not None else [1.0] * n),
        qlim=_Limiter(n, enable),
    )


def _system(
    *,
    load_p: list[float] | None = None,
    load_q: list[float] | None = None,
    load_u: list[float] | None = None,
    gen_p: list[float] | None = None,
    mva: float = 100.0,
) -> SimpleNamespace:
    """Three PQ loads, two PV generators and a slack, as far as a direction reads them."""
    load_p = [1.0, 0.5, 0.0] if load_p is None else load_p
    load_q = [0.2, 0.1, 0.0] if load_q is None else load_q
    gen_p = [0.4, 0.6] if gen_p is None else gen_p
    pq = SimpleNamespace(
        n=len(load_p),
        idx=SimpleNamespace(v=["PQ_1", "PQ_2", "PQ_3"][: len(load_p)]),
        p0=_holder(load_p),
        q0=_holder(load_q),
        u=_holder(load_u if load_u is not None else [1.0] * len(load_p)),
    )
    pv = SimpleNamespace(
        n=len(gen_p),
        idx=SimpleNamespace(v=[2, 3][: len(gen_p)]),
        p=_holder(gen_p),
        u=_holder([1.0] * len(gen_p)),
    )
    slack = SimpleNamespace(n=1, idx=SimpleNamespace(v=[1]))
    return SimpleNamespace(PQ=pq, PV=pv, Slack=slack, config=SimpleNamespace(mva=mva))


# ---- validation -------------------------------------------------------------


def test_nothing_asked_is_valid() -> None:
    validate_cpf_options()
    validate_cpf_options(
        direction="custom", stop_at="full", step=0.01, max_steps=1, enforce_q_limits=False
    )


@pytest.mark.parametrize("direction", ["both", "", None, 3, "LOAD", "load_only"])
def test_a_direction_the_routine_does_not_know_is_refused(direction: Any) -> None:
    with pytest.raises(CpfRequestError, match="direction"):
        validate_cpf_options(direction=direction)


@pytest.mark.parametrize("stop_at", ["FULL", "lower", None, 0.5])
def test_a_stop_at_other_than_nose_or_full_is_refused(stop_at: Any) -> None:
    with pytest.raises(CpfRequestError, match="stop_at"):
        validate_cpf_options(stop_at=stop_at)


@pytest.mark.parametrize("step", [0, -0.1, float("nan"), float("inf"), True, "0.1", 10**400])
def test_a_step_that_is_not_a_positive_number_is_refused(step: Any) -> None:
    with pytest.raises(CpfRequestError, match="step"):
        validate_cpf_options(step=step)


@pytest.mark.parametrize("max_steps", [0, -5, 2.0, 2.5, True, "50"])
def test_a_step_count_that_is_not_a_whole_number_of_at_least_one_is_refused(
    max_steps: Any,
) -> None:
    with pytest.raises(CpfRequestError, match="max_iter"):
        validate_cpf_options(max_steps=max_steps)


@pytest.mark.parametrize("value", [1, 0, "yes", "true", 1.0])
def test_a_limits_flag_that_is_not_a_boolean_is_refused(value: Any) -> None:
    with pytest.raises(CpfRequestError, match="enforce_q_limits"):
        validate_cpf_options(enforce_q_limits=value)


# ---- the direction of the increase ------------------------------------------


def test_load_scales_everything_through_the_routines_own_factor() -> None:
    assert direction_targets(_system(), direction="load") == {"load_scale": 2.0}


def test_load_only_doubles_the_loads_and_leaves_the_generators_out() -> None:
    targets = direction_targets(_system(), direction="load-only")
    assert set(targets) == {"p0_target", "q0_target"}
    np.testing.assert_allclose(targets["p0_target"], [2.0, 1.0, 0.0])
    np.testing.assert_allclose(targets["q0_target"], [0.4, 0.2, 0.0])


def test_gen_doubles_the_pv_generators_as_an_array_and_leaves_the_loads_out() -> None:
    """The routine takes a target per generator; a bare factor made it raise."""
    targets = direction_targets(_system(), direction="gen")
    assert set(targets) == {"pg_target"}
    np.testing.assert_allclose(targets["pg_target"], [0.8, 1.2])


def test_a_custom_direction_adds_the_megawatts_given_to_the_base_values() -> None:
    targets = direction_targets(
        _system(mva=200.0),
        direction="custom",
        load_increase=[{"idx": "PQ_2", "p": 100.0, "q": 30.0}],
        generator_increase=[{"idx": 3, "p": 50.0}],
    )
    # 100 MW on a 200 MVA base is 0.5 pu; devices left out keep their base value.
    np.testing.assert_allclose(targets["p0_target"], [1.0, 1.0, 0.0])
    np.testing.assert_allclose(targets["q0_target"], [0.2, 0.25, 0.0])
    np.testing.assert_allclose(targets["pg_target"], [0.4, 0.85])


def test_a_custom_direction_finds_a_device_by_its_idx_as_text() -> None:
    targets = direction_targets(
        _system(), direction="custom", generator_increase=[{"idx": "2", "p": 10.0}]
    )
    np.testing.assert_allclose(targets["pg_target"], [0.5, 0.6])


def test_an_increase_may_be_negative() -> None:
    targets = direction_targets(
        _system(), direction="custom", load_increase=[{"idx": "PQ_1", "p": -50.0}]
    )
    np.testing.assert_allclose(targets["p0_target"], [0.5, 0.5, 0.0])


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"load_increase": [{"idx": "PQ_9", "p": 1.0}]}, "not a PQ load"),
        ({"generator_increase": [{"idx": 7, "p": 1.0}]}, "not a PV generator"),
        ({"generator_increase": [{"idx": 1, "p": 1.0}]}, "slack generator"),
        (
            {"load_increase": [{"idx": "PQ_1", "p": 1.0}, {"idx": "PQ_1", "q": 1.0}]},
            "more than once",
        ),
        ({"generator_increase": [{"idx": 2, "p": 1.0}, {"idx": "2", "p": 1.0}]}, "more than once"),
        ({"load_increase": [{"p": 1.0}]}, "idx"),
        ({"load_increase": [{"idx": True, "p": 1.0}]}, "idx"),
        ({"load_increase": [{"idx": "PQ_1", "p": float("nan")}]}, "finite number"),
        ({"load_increase": [{"idx": "PQ_1", "q": "3"}]}, "finite number"),
        ({"load_increase": ["PQ_1"]}, "object"),
        ({"load_increase": {"idx": "PQ_1"}}, "list"),
        ({}, "at least one entry"),
        ({"load_increase": [], "generator_increase": []}, "at least one entry"),
    ],
)
def test_a_custom_direction_that_cannot_be_applied_is_refused(
    kwargs: dict[str, Any], message: str
) -> None:
    with pytest.raises(CpfRequestError, match=message):
        direction_targets(_system(), direction="custom", **kwargs)


def test_a_custom_direction_of_zeros_moves_nothing_and_is_refused() -> None:
    with pytest.raises(CpfRequestError, match="nothing to increase"):
        direction_targets(
            _system(), direction="custom", load_increase=[{"idx": "PQ_1", "p": 0.0, "q": 0.0}]
        )


def test_an_increase_given_only_to_a_load_that_is_off_moves_nothing() -> None:
    with pytest.raises(CpfRequestError, match="out of service"):
        direction_targets(
            _system(load_u=[1.0, 0.0, 1.0]),
            direction="custom",
            load_increase=[{"idx": "PQ_2", "p": 10.0}],
        )


@pytest.mark.parametrize("direction", ["load", "load-only", "gen"])
def test_the_lists_of_a_custom_direction_are_refused_with_any_other(direction: str) -> None:
    with pytest.raises(CpfRequestError, match="custom"):
        direction_targets(
            _system(), direction=direction, load_increase=[{"idx": "PQ_1", "p": 1.0}]
        )


def test_gen_is_refused_when_no_pv_generator_has_output() -> None:
    with pytest.raises(CpfRequestError, match="no PV generator output"):
        direction_targets(_system(gen_p=[0.0, 0.0]), direction="gen")


def test_load_only_is_refused_when_no_load_is_in_service() -> None:
    with pytest.raises(CpfRequestError, match="no load in service"):
        direction_targets(_system(load_u=[0.0, 0.0, 0.0]), direction="load-only")


# ---- the request bodies and the worker --------------------------------------


def test_the_request_takes_the_four_directions_and_both_ends() -> None:
    body = CpfRunRequest.model_validate(
        {
            "direction": "custom",
            "load_increase": [{"idx": "PQ_1", "p": 10, "q": 3}],
            "generator_increase": [{"idx": 2, "p": 10}],
            "enforce_q_limits": True,
            "stop_at": "full",
        }
    )
    assert body.load_increase is not None and body.load_increase[0].q == 3.0
    assert body.stop_at == "full" and body.enforce_q_limits is True
    assert CpfRunRequest().direction == "load"
    assert CpfRunRequest().stop_at == "nose"
    assert CpfRunRequest().enforce_q_limits is None
    assert CpfQvRunRequest(bus_idx="5").enforce_q_limits is None


@pytest.mark.parametrize(
    "body",
    [
        {"direction": "both"},
        {"stop_at": "lower"},
        {"direction": "custom"},
        {"direction": "custom", "load_increase": []},
        {"direction": "load", "load_increase": [{"idx": "PQ_1", "p": 1}]},
        {"direction": "gen", "generator_increase": [{"idx": 2, "p": 1}]},
        {"direction": "custom", "load_increase": [{"idx": "PQ_1", "p": "nan"}]},
        {"direction": "custom", "generator_increase": [{"idx": 2}]},
        {"direction": "custom", "load_increase": [{"idx": "PQ_1", "dp": 1}]},
        {"enforce_q_limits": "sometimes"},
        {"step": 0},
    ],
)
def test_the_request_refuses_what_the_routine_cannot_run(body: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        CpfRunRequest.model_validate(body)


def test_the_worker_forwards_every_setting_to_the_wrapper() -> None:
    seen: dict[str, Any] = {}

    class _Wrapper:
        def run_cpf(self, **kwargs: Any) -> dict[str, Any]:
            seen.update(kwargs)
            return {}

        def run_cpf_qv(self, **kwargs: Any) -> dict[str, Any]:
            seen.update(kwargs)
            return {}

    increases = [{"idx": "PQ_1", "p": 1.0, "q": 0.0}]
    worker._handle_run_cpf(  # noqa: SLF001
        _Wrapper(),  # type: ignore[arg-type]
        {
            "direction": "custom",
            "load_increase": increases,
            "enforce_q_limits": True,
            "stop_at": "full",
            "step": 0.05,
            "max_iter": 40,
        },
    )
    assert seen == {
        "direction": "custom",
        "step": 0.05,
        "max_iter": 40,
        "load_increase": increases,
        "generator_increase": None,
        "enforce_q_limits": True,
        "stop_at": "full",
    }

    seen.clear()
    worker._handle_run_cpf(_Wrapper(), {})  # type: ignore[arg-type]  # noqa: SLF001
    assert seen["direction"] == "load" and seen["stop_at"] == "nose"
    assert seen["enforce_q_limits"] is None and seen["step"] is None

    seen.clear()
    worker._handle_run_cpf_qv(  # noqa: SLF001
        _Wrapper(),  # type: ignore[arg-type]
        {"bus_idx": 5, "enforce_q_limits": True},
    )
    assert seen == {"bus_idx": "5", "q_range": 5.0, "enforce_q_limits": True}


# ---- generators past a limit in the base case -------------------------------


def test_a_generator_past_a_limit_it_is_not_held_at_is_found() -> None:
    pv = _generators([2, 3, 4], q=[0.30, -0.50, 0.10], qmax=[0.25] * 3, qmin=[-0.4] * 3)
    slack = _generators([1], q=[0.2500001], qmax=[0.25])
    past = generators_past_limits(SimpleNamespace(PV=pv, Slack=slack))
    # The slack is a millionth past its limit, which is the power flow's own
    # tolerance and not a generator out of bounds.
    assert [(p.model, p.idx, p.limit) for p in past] == [("PV", 2, "qmax"), ("PV", 3, "qmin")]


def test_a_generator_the_power_flow_holds_at_its_limit_is_not_past_it() -> None:
    pv = _generators([2], q=[0.2503], qmax=[0.25])
    pv.qlim.hold_upper(0)
    assert generators_past_limits(SimpleNamespace(PV=pv)) == []


def test_a_generator_out_of_service_is_not_past_a_limit() -> None:
    pv = _generators([2], q=[0.9], qmax=[0.25], u=[0.0])
    assert generators_past_limits(SimpleNamespace(PV=pv)) == []


# ---- one run of the routine -------------------------------------------------


class _Routine:
    """What the run touches of ANDES's ``CPF``: its config, its solver, the method
    that reads the bus voltages and the corrector.

    The corrector is scripted. It takes the predicted point as the solution, lets
    the limiter of the first generator model switch each generator whose reactive
    output is at or past ``qmax`` (as a limiter with ``min_iter`` 0 does), and
    then does what ``after`` says to the System, which is how a test moves a
    voltage or makes a step fail.
    """

    def __init__(self, ss: SimpleNamespace) -> None:
        self.system = ss
        self.config = SimpleNamespace(
            step=0.1, step_min=1e-4, max_steps=500, stop_at="NOSE", linsolve=0
        )
        self.solver = SimpleNamespace(cleared=0)
        self.solver.clear = lambda: setattr(self.solver, "cleared", self.solver.cleared + 1)
        self.V: Any = None
        self.lengths: list[float] = []
        self.enabled_during_derivative: list[bool] = []
        self.after: Any = None
        self.fail = False

    def _bus_vmag(self) -> np.ndarray:
        return np.array(self.system.Bus.v.v)

    def _dfg_dlam(self, lam: float) -> np.ndarray:
        self.enabled_during_derivative.append(bool(self.system.PV.qlim.enable))
        return np.zeros(1)

    def _corrector(
        self, lam: float, xy_prev: Any, lam_prev: float, step: float, z: Any, dfg: Any
    ) -> tuple[bool, int, float]:
        self.lengths.append(float(step))
        pv = self.system.PV
        if pv.qlim.enable:
            for i in range(pv.n):
                if pv.q.v[i] >= pv.qmax.v[i]:
                    pv.qlim.hold_upper(i)
                    pv.q.v[i] = pv.qmax.v[i]
        if self.after is not None:
            self.after(self.system)
        return (not self.fail), 3, float(lam)


def _studied(*, q: float = 0.10, qmax: float = 0.25, enable: Any = 0) -> SimpleNamespace:
    """A System of one PV generator and one slack whose only variable is the PV's
    reactive output, and a routine for it."""
    pv = _generators([2], q=[q], qmax=[qmax], enable=enable)
    slack = _generators([1], q=[0.05], qmax=[9.0], enable=enable)
    dae = SimpleNamespace(n=0, m=1, x=np.zeros(0), y=np.array([q]))
    ss = SimpleNamespace(
        PV=pv,
        Slack=slack,
        Bus=SimpleNamespace(v=_holder([1.0, 0.98])),
        dae=dae,
        config=SimpleNamespace(mva=100.0),
    )
    ss.vars_to_models = lambda: pv.q.v.__setitem__(slice(None), dae.y[:1])
    ss.CPF = _Routine(ss)
    return ss


# A tangent along which the generator gains 0.6 pu of reactive power, and lambda
# 0.8, per unit of step.
_TANGENT = np.array([0.6, 0.8])


def _step(ss: SimpleNamespace, length: float, *, start: float = 0.10) -> tuple[bool, int, float]:
    """One step as the routine takes it: predict along the tangent, then correct."""
    ss.dae.y[:] = start + length * _TANGENT[0]
    ss.vars_to_models()
    return ss.CPF._corrector(  # type: ignore[no-any-return]  # noqa: SLF001
        length * _TANGENT[1], np.array([start]), 0.0, length, _TANGENT, np.zeros(1)
    )


def test_a_run_puts_back_everything_it_wrote() -> None:
    ss = _studied()
    cpf, limiter = ss.CPF, ss.PV.qlim
    limiter.hold_upper(0)
    with cpf_run_applied(
        ss, enforce_q_limits=None, stop_at="full", step=0.02, max_steps=40
    ) as run:
        assert run.enforce_q_limits is False  # the case's own setting: off
        assert (cpf.config.step, cpf.config.max_steps, cpf.config.stop_at) == (0.02, 40, "FULL")
        assert cpf.config.linsolve == 0
        assert "_bus_vmag" in vars(cpf) and "_corrector" not in vars(cpf)
        limiter.zu[:] = 0.0  # as a run could leave it
        limiter.nqu = 0
    assert (cpf.config.step, cpf.config.max_steps, cpf.config.stop_at) == (0.1, 500, "NOSE")
    assert "_bus_vmag" not in vars(cpf)
    assert limiter.zu[0] == 1.0 and limiter.nqu == 1
    assert cpf.solver.cleared == 1


def test_enforcing_limits_switches_the_limiters_on_for_the_run_only() -> None:
    ss = _studied()
    cpf = ss.CPF
    with cpf_run_applied(ss, enforce_q_limits=True) as run:
        assert run.enforce_q_limits is True
        for model in (ss.PV, ss.Slack):
            assert model.qlim.enable is True and model.qlim.min_iter == 0
        # A fresh factorisation at every solve: a switch changes the matrix's shape.
        assert cpf.config.linsolve == 1
        assert {"_bus_vmag", "_corrector"} <= set(vars(cpf))
    for model in (ss.PV, ss.Slack):
        assert model.qlim.enable == 0 and model.qlim.min_iter == 2
    assert cpf.config.linsolve == 0
    assert not {"_bus_vmag", "_corrector"} & set(vars(cpf))


def test_a_case_that_turns_limits_on_itself_is_enforced_unless_told_otherwise() -> None:
    with cpf_run_applied(_studied(enable=1)) as run:
        assert run.enforce_q_limits is True
    ss = _studied(enable=1)
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        assert run.enforce_q_limits is False
        assert ss.PV.qlim.enable is False
    assert ss.PV.qlim.enable == 1


def test_everything_is_put_back_when_the_routine_raises() -> None:
    ss = _studied()
    with pytest.raises(RuntimeError), cpf_run_applied(ss, enforce_q_limits=True, step=0.5):
        ss.PV.qlim.hold_upper(0)
        raise RuntimeError("singular")
    assert ss.PV.qlim.enable == 0 and ss.PV.qlim.zu[0] == 0.0
    assert ss.CPF.config.step == 0.1 and not vars(ss.CPF).keys() & {"_bus_vmag", "_corrector"}


def test_a_run_that_enforces_limits_is_refused_when_the_base_case_breaks_them() -> None:
    ss = _studied(q=0.40)
    with (
        pytest.raises(CpfPrerequisiteError, match="PV 2 past qmax") as refused,
        cpf_run_applied(ss, enforce_q_limits=True, step=0.5),
    ):
        pytest.fail("the run must not start")
    assert "reactive limits enforced first" in str(refused.value)
    # Refused before anything was written.
    assert ss.CPF.config.step == 0.1 and ss.PV.qlim.enable == 0
    assert ss.CPF.solver.cleared == 0
    # Without enforcement the same base case runs.
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        assert run.enforce_q_limits is False


def test_a_step_that_fails_gives_back_the_generators_it_switched() -> None:
    ss = _studied()
    with cpf_run_applied(ss, enforce_q_limits=True):
        ss.CPF._bus_vmag()  # noqa: SLF001 - the base point
        ss.CPF.fail = True
        ok, _, _ = _step(ss, 0.4)  # far enough to switch the generator
        assert ok is False
        assert ss.PV.qlim.zu[0] == 0.0 and ss.PV.qlim.qu[0] == 0.0 and ss.PV.qlim.nqu == 0


def test_a_switch_is_placed_to_within_the_switch_step() -> None:
    """The generator reaches its limit a quarter of the way along a long step."""
    ss = _studied()
    reaches_limit_at = (0.25 - 0.10) / _TANGENT[0]
    with cpf_run_applied(ss, enforce_q_limits=True):
        cpf = ss.CPF
        cpf._bus_vmag()  # noqa: SLF001
        ok, _, lam = _step(ss, 0.4)
        assert ok is True
        placed = lam / _TANGENT[1]
        assert reaches_limit_at <= placed <= reaches_limit_at + SWITCH_STEP
        # The System is left at that step, with the generator held.
        assert cpf.lengths[-1] == pytest.approx(placed)
        assert ss.PV.qlim.zu[0] == 1.0 and ss.PV.q.v[0] == pytest.approx(0.25)
        # Bisection, not a crawl: 0.4 down to 0.001 is nine halvings.
        assert len(cpf.lengths) <= 12
        # The limiters stood still while the derivative was taken, and work again.
        assert cpf.enabled_during_derivative and not any(cpf.enabled_during_derivative)
        assert ss.PV.qlim.enable is True


def test_a_switch_within_a_short_step_is_taken_as_it_is() -> None:
    ss = _studied(q=0.2499)
    with cpf_run_applied(ss, enforce_q_limits=True):
        ss.CPF._bus_vmag()  # noqa: SLF001
        ok, _, _ = _step(ss, SWITCH_STEP / 2, start=0.2499)
        assert ok is True and ss.PV.qlim.zu[0] == 1.0
        assert ss.CPF.lengths == [SWITCH_STEP / 2]


def test_a_step_without_a_switch_is_not_touched() -> None:
    ss = _studied()
    with cpf_run_applied(ss, enforce_q_limits=True):
        ss.CPF._bus_vmag()  # noqa: SLF001
        assert _step(ss, 0.1) == (True, 3, pytest.approx(0.08))
        assert ss.CPF.lengths == [0.1]


def test_a_placing_step_that_does_not_converge_is_handed_back_as_failed() -> None:
    ss = _studied()
    with cpf_run_applied(ss, enforce_q_limits=True):
        cpf = ss.CPF
        cpf._bus_vmag()  # noqa: SLF001

        def fail_the_second(_: Any) -> None:
            cpf.fail = len(cpf.lengths) >= 2

        cpf.after = fail_the_second
        ok, _, _ = _step(ss, 0.4)
        assert ok is False and len(cpf.lengths) == 2
        assert ss.PV.qlim.zu[0] == 0.0


def _run_to_a_switch(ss: SimpleNamespace) -> None:
    """Base point, then a step in which the PV generator is switched, both kept."""
    cpf = ss.CPF
    cpf._bus_vmag()  # noqa: SLF001
    assert _step(ss, SWITCH_STEP / 2, start=0.2499)[0] is True
    ss.Bus.v.v[1] = 0.97
    cpf._bus_vmag()  # noqa: SLF001


def test_a_step_that_lifts_a_just_switched_generators_voltage_is_refused() -> None:
    """Held at qmax with its voltage above the set-point, the generator is not at
    its limit at all: the path ends at the switch."""
    ss = _studied(q=0.2499)
    with cpf_run_applied(ss, enforce_q_limits=True) as run:
        cpf = ss.CPF
        _run_to_a_switch(ss)
        cpf.after = lambda system: system.PV.v.v.__setitem__(0, 1.004)
        for _ in range(3):
            assert _step(ss, 0.05, start=0.25)[0] is False
        # The limiter still holds what it held at the last point kept.
        assert ss.PV.qlim.zu[0] == 1.0
        columns = np.array([[1.0, 1.0], [0.98, 0.97]])
        path = run.path(columns)
    assert path is not None
    _, events = path.traces([0.0, 0.0004], nose_idx=1)
    assert [(e.step, e.model, e.idx, e.limit, e.at_nose) for e in events] == [
        (1, "PV", "2", "qmax", True)
    ]


def test_a_switched_generator_whose_voltage_sinks_carries_on() -> None:
    ss = _studied(q=0.2499)
    with cpf_run_applied(ss, enforce_q_limits=True) as run:
        cpf = ss.CPF
        _run_to_a_switch(ss)
        cpf.after = lambda system: system.PV.v.v.__setitem__(0, 0.99)
        assert _step(ss, 0.05, start=0.25)[0] is True
        ss.Bus.v.v[1] = 0.96
        cpf._bus_vmag()  # noqa: SLF001
        # Once it has moved clear of the switch it is no longer watched: ANDES's
        # limiter does not let go, and a later recovery is not a reason to stop.
        cpf.after = lambda system: system.PV.v.v.__setitem__(0, 1.02)
        assert _step(ss, 0.05, start=0.25)[0] is True
        ss.Bus.v.v[1] = 0.95
        cpf._bus_vmag()  # noqa: SLF001
        path = run.path(np.array([[1.0] * 4, [0.98, 0.97, 0.96, 0.95]]))
    assert path is not None
    # Lambda goes on rising, so the switch at step 1 is not where it turns.
    _, events = path.traces([0.0, 0.1, 0.2, 0.3], nose_idx=3)
    assert [(e.step, e.at_nose) for e in events] == [(1, False)]


def test_without_enforcement_the_corrector_is_left_alone() -> None:
    ss = _studied(q=0.2499)
    with cpf_run_applied(ss, enforce_q_limits=False):
        assert "_corrector" not in vars(ss.CPF)
        ss.CPF._bus_vmag()  # noqa: SLF001
        assert _step(ss, 0.4, start=0.2499)[0] is True
        assert ss.PV.qlim.zu[0] == 0.0  # the limiter is off: nothing switches
        assert ss.CPF.lengths == [0.4]


# ---- the generators along the path ------------------------------------------


def _three_points(ss: SimpleNamespace, run: Any) -> None:
    """Three points kept, the PV generator at 10, 20 and 25 MVAr, held at the third."""
    cpf = ss.CPF
    for voltage, q in ((0.98, 0.10), (0.96, 0.20), (0.94, 0.25)):
        ss.Bus.v.v[1] = voltage
        ss.PV.q.v[0] = q
        if q >= 0.25:
            ss.PV.qlim.hold_upper(0)
        cpf._bus_vmag()  # noqa: SLF001


def test_each_generator_is_read_at_every_point_in_mvar() -> None:
    ss = _studied()
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        _three_points(ss, run)
        path = run.path(np.array([[1.0, 1.0, 1.0], [0.98, 0.96, 0.94]]))
    assert path is not None and path.finite_steps() == 3
    traces, events = path.traces([0.0, 0.5, 0.9], nose_idx=-1)
    assert [(t.model, t.idx, t.bus) for t in traces] == [("PV", "2", "2"), ("Slack", "1", "1")]
    assert traces[0].q == pytest.approx([10.0, 20.0, 25.0])
    assert (traces[0].q_min, traces[0].q_max) == (-900.0, 25.0)
    assert traces[1].q == pytest.approx([5.0, 5.0, 5.0])
    assert [(e.step, e.lam, e.idx, e.limit, e.at_nose) for e in events] == [
        (2, 0.9, "2", "qmax", False)
    ]


def test_a_reading_the_routine_replaced_is_skipped_when_matching_the_columns() -> None:
    """The routine reads the last point again after refining it and keeps the second."""
    ss = _studied()
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        _three_points(ss, run)
        ss.Bus.v.v[1] = 0.93
        ss.PV.q.v[0] = 0.24
        ss.CPF._bus_vmag()  # noqa: SLF001
        path = run.path(np.array([[1.0, 1.0, 1.0], [0.98, 0.96, 0.93]]))
    assert path is not None
    traces, _ = path.traces([0.0, 0.5, 0.0], nose_idx=1)
    assert traces[0].q == pytest.approx([10.0, 20.0, 24.0])


def test_readings_that_do_not_match_the_columns_give_no_generators() -> None:
    ss = _studied()
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        _three_points(ss, run)
        assert run.path(np.array([[1.0, 1.0], [0.98, 0.5]])) is None
        assert run.path(None) is None
        assert run.path(np.zeros(3)) is None


def test_a_generator_out_of_service_has_no_trace() -> None:
    ss = _studied()
    ss.Slack.u.v[0] = 0.0
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        _three_points(ss, run)
        path = run.path(np.array([[1.0, 1.0, 1.0], [0.98, 0.96, 0.94]]))
    assert path is not None
    assert [t.model for t in path.traces([0.0, 0.5, 0.9], nose_idx=-1)[0]] == ["PV"]


def test_the_traces_stop_where_a_reactive_output_is_not_finite() -> None:
    ss = _studied()
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        _three_points(ss, run)
        ss.Bus.v.v[1] = 0.5
        ss.PV.q.v[0] = float("nan")
        ss.CPF._bus_vmag()  # noqa: SLF001
        path = run.path(np.array([[1.0] * 4, [0.98, 0.96, 0.94, 0.5]]))
    assert path is not None and path.finite_steps() == 3


def test_a_generator_held_from_the_start_is_an_event_at_step_zero() -> None:
    ss = _studied(q=0.25)
    ss.PV.qlim.hold_upper(0)
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        ss.CPF._bus_vmag()  # noqa: SLF001
        ss.Bus.v.v[1] = 0.9
        ss.CPF._bus_vmag()  # noqa: SLF001
        path = run.path(np.array([[1.0, 1.0], [0.98, 0.9]]))
    assert path is not None
    # Lambda turns at step 0 or 1 on so short a path; a generator the base case
    # holds is not what turned it.
    _, events = path.traces([0.0, -0.1], nose_idx=0)
    assert [(e.step, e.at_nose) for e in events] == [(0, False)]


def _held_path(ss: SimpleNamespace, voltages: list[float]) -> Any:
    """A path on which the PV generator is held at qmax from the start, with its
    terminal voltage at each point as given."""
    ss.PV.qlim.hold_upper(0)
    with cpf_run_applied(ss, enforce_q_limits=False) as run:
        for k, voltage in enumerate(voltages):
            ss.Bus.v.v[1] = 0.98 - 0.01 * k
            ss.PV.v.v[0] = voltage
            ss.CPF._bus_vmag()  # noqa: SLF001
        columns = np.array([[1.0] * len(voltages), [0.98 - 0.01 * k for k in range(len(voltages))]])
        return run.path(columns)


def test_an_event_says_where_a_real_exciter_would_have_left_the_limit() -> None:
    """Held at qmax, the generator's voltage climbs back over its set-point of
    1.0 at the third point. ANDES keeps it at the limit; the event says from
    where that is no longer what a generator would do."""
    path = _held_path(_studied(q=0.25), [0.99, 0.995, 1.004, 1.02])
    assert path is not None
    _, events = path.traces([0.0, 0.1, 0.2, 0.3], nose_idx=-1)
    assert [(e.step, e.limit, e.would_release_step) for e in events] == [(0, "qmax", 2)]


def test_a_held_generator_whose_voltage_stays_on_its_side_would_not_release() -> None:
    # A thousandth of a per unit over the set-point is still "on it".
    path = _held_path(_studied(q=0.25), [0.99, 0.97, 1.0005, 0.95])
    assert path is not None
    _, events = path.traces([0.0, 0.1, 0.2, 0.3], nose_idx=-1)
    assert events[0].would_release_step is None


def test_a_generator_with_one_value_for_both_limits_has_nothing_to_release_to() -> None:
    ss = _studied(q=0.25)
    ss.PV.qmin.v[0] = 0.25
    path = _held_path(ss, [0.99, 1.05, 1.1])
    assert path is not None
    _, events = path.traces([0.0, 0.1, 0.2], nose_idx=-1)
    assert events[0].would_release_step is None


# ---- where the nose is ------------------------------------------------------


def test_the_nose_is_where_lambda_first_goes_down() -> None:
    assert _first_turn([0.0, 0.5, 0.9, 0.8]) == 2
    # A lower branch that climbs back above the nose is not reached by adding load.
    assert _first_turn([0.0, 0.5, 0.9, 0.7, 1.2, 0.3, 0.0]) == 2
    # A run that ends at its nose never went down.
    assert _first_turn([0.0, 0.5, 0.9]) == 2
    assert _first_turn([0.0]) == 0
