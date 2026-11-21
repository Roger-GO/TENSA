"""Backward Euler and the adaptive trapezoidal method, run by ANDES itself.

Every run goes through the worker's handler, as a batch run does, on ANDES's
bundled IEEE 14 case with a fault on bus 4 from 0.5 s to 0.6 s. The tests hold
what the record of each run is (``traces`` against ``dae.ts``, row for row, the
fault's two instants included), compare the trajectory with the trapezoidal
method's on the same disturbance, show that the tolerances and step bounds reach
ANDES and change the run, and that one integrator follows another on the same
System as asked.

The reference is the trapezoidal method at ``h = 1/120 s``, whose speed of
generator 1 differs from the same method at ``h = 1/2400 s`` by 3e-6 pu at most
over 3 s. The fault swings that speed by about 7.4e-3 pu.

Markers: ``integration``.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core import worker
from tensa.core.disturbance import FaultSpec
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

TF = 2.0
H = 1 / 120
OMEGA = "omega GENROU 1"
DELTA = "delta GENROU 2"
RECORDED = [OMEGA, DELTA, "v Bus 4"]
AUTO = {"rtol": 1e-3, "atol": 1e-6, "max_step": 0.05}


def _ieee14() -> Wrapper:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    w = Wrapper()
    w.load_case(cases / "ieee14.raw", addfiles=[cases / "ieee14.dyr"])
    w.add_disturbance(FaultSpec(bus_idx=4, tf=0.5, tc=0.6))
    return w


class Run:
    """One batch run through the worker's handler and what ANDES kept of it."""

    def __init__(self, w: Wrapper, **request: Any) -> None:
        self.w = w
        args: dict[str, Any] = {"tf": TF, "dae_vars": RECORDED, **request}
        self.result = worker._handle_run_tds(w, args, threading.Event())  # noqa: SLF001
        traces = self.result["traces"]
        self.t = np.array(traces["t"], dtype=float)
        self.values = {
            v["name"]: np.array(v["values"], dtype=float) for v in traces["variables"]
        }
        ss = w._require_loaded()  # noqa: SLF001
        self.stored_t = np.asarray(ss.dae.ts.t, dtype=float)
        self.stored_omega = np.asarray(ss.dae.ts.x)[:, list(ss.dae.x_name).index(OMEGA)]

    @property
    def omega(self) -> np.ndarray:
        return self.values[OMEGA]


def _fresh(**request: Any) -> Run:
    return Run(_ieee14(), **request)


@pytest.fixture(scope="module")
def trapezoidal() -> Run:
    return _fresh(h=H)


@pytest.fixture(scope="module")
def backeuler() -> Run:
    return _fresh(h=H, integrator="backeuler")


@pytest.fixture(scope="module")
def trap_adapt() -> Run:
    return _fresh(integrator="trap_adapt", tds_config_overrides=AUTO)


# ---- the record --------------------------------------------------------------------


@pytest.mark.parametrize("name", ["backeuler", "trap_adapt"])
def test_the_run_reaches_tf_and_its_record_is_the_steps_andes_stored(
    name: str, request: pytest.FixtureRequest
) -> None:
    run: Run = request.getfixturevalue(name)
    assert run.result["converged"] is True
    assert run.result["final_t"] == TF
    assert run.result["integrator"] == name
    assert run.t.tolist() == run.stored_t.tolist()
    assert np.array_equal(run.omega, run.stored_omega)
    assert run.t[-1] == TF
    # The fault lands on its two instants, and the step after each is solved on
    # the network as it then is: collapsed at once, recovering after the clear.
    v_bus4 = dict(zip(run.t.tolist(), run.values["v Bus 4"].tolist(), strict=True))
    assert v_bus4[0.5] > 0.9
    after_fault = run.t[run.t > 0.5][0]
    assert v_bus4[after_fault] < 0.1
    assert v_bus4[0.6] < 0.1
    after_clear = run.t[run.t > 0.6][0]
    assert v_bus4[after_clear] > 0.5


def _at_h(steps: np.ndarray) -> float:
    """The share of ``steps`` that are ``h``. ANDES's fixed step is a ceiling:
    it clips a step at an event time and at ``tf``, and after an event it grows
    the step back to ``h`` by the Newton iteration count (the case's own line
    trip at 1 s and 1.1 s adds four events to the fault's)."""
    assert steps.max() <= H + 1e-12
    return float(np.mean(np.isclose(steps, H, rtol=0.0, atol=1e-12)))


def test_backward_euler_steps_at_h(backeuler: Run, trapezoidal: Run) -> None:
    assert _at_h(np.diff(backeuler.t)) > 0.9
    # As many steps as the trapezoidal method's at the same ``h``, give or take
    # how each grows its step back after an event.
    assert abs(len(backeuler.t) - len(trapezoidal.t)) <= 5


def test_the_adaptive_method_chooses_its_steps_within_the_bound(
    trap_adapt: Run, backeuler: Run
) -> None:
    steps = np.diff(trap_adapt.t)
    assert steps.max() <= AUTO["max_step"] + 1e-12
    assert steps.max() > 2 * H  # it took steps longer than a fixed-step run's
    assert len(np.unique(np.round(steps, 9))) > 10
    assert len(trap_adapt.t) != len(backeuler.t)
    # The hook is called again for each step ANDES rejects, and the record has
    # one row per accepted step only.
    assert trap_adapt.result["callpert_count"] > len(trap_adapt.t)


# ---- the trajectory against the trapezoidal method's ---------------------------------


def _at(reference: Run, run: Run) -> np.ndarray:
    return np.interp(run.t, reference.t, reference.omega)


def test_the_adaptive_method_follows_the_trapezoidal_trajectory(
    trap_adapt: Run, trapezoidal: Run
) -> None:
    """Both are the trapezoidal rule: they agree to the reference's own error."""
    assert abs(trap_adapt.omega.max() - trapezoidal.omega.max()) < 2e-5
    assert abs(trap_adapt.omega[-1] - trapezoidal.omega[-1]) < 1e-5
    assert np.max(np.abs(trap_adapt.omega - _at(trapezoidal, trap_adapt))) < 2e-5
    # The rotor angle integrates the speed's small differences: 1.1e-4 rad here.
    assert abs(trap_adapt.values[DELTA][-1] - trapezoidal.values[DELTA][-1]) < 1e-3


def test_backward_euler_is_close_to_the_trapezoidal_trajectory_and_not_the_same(
    backeuler: Run, trapezoidal: Run
) -> None:
    """First order: within 7% of the swing at the peak, and visibly another
    method, which shows the request changed the method and not only its name."""
    assert abs(backeuler.omega.max() - trapezoidal.omega.max()) < 5e-4
    assert abs(backeuler.omega[-1] - trapezoidal.omega[-1]) < 1e-4
    assert abs(backeuler.values[DELTA][-1] - trapezoidal.values[DELTA][-1]) < 1e-2
    assert np.max(np.abs(backeuler.omega - trapezoidal.omega)) > 1e-5
    # Damped more: its peak is the lower one.
    assert backeuler.omega.max() < trapezoidal.omega.max()


# ---- what the tolerances and bounds change -------------------------------------------


def test_a_looser_tolerance_takes_fewer_steps(trap_adapt: Run) -> None:
    loose = _fresh(
        integrator="trap_adapt", tds_config_overrides={**AUTO, "rtol": 1e-2, "atol": 1e-4}
    )
    assert loose.result["converged"] is True
    assert len(loose.t) < len(trap_adapt.t)
    ss = loose.w._require_loaded()  # noqa: SLF001
    assert (float(ss.TDS.config.reltol), float(ss.TDS.config.abstol)) == (1e-2, 1e-4)


def test_max_step_bounds_the_step() -> None:
    run = _fresh(integrator="trap_adapt", tds_config_overrides={"max_step": 0.01})
    assert run.result["converged"] is True
    assert np.diff(run.t).max() <= 0.01 + 1e-12


def test_min_step_is_the_floor_andes_steps_to() -> None:
    w = _ieee14()
    Run(w, tf=0.3, integrator="trap_adapt", tds_config_overrides={"min_step": 2e-3})
    ss = w._require_loaded()  # noqa: SLF001
    assert float(ss.TDS.config.dtmin_adapt) == 2e-3
    assert float(ss.TDS.deltatmin_adapt) == 2e-3


def test_steps_far_shorter_than_a_nanosecond_are_rows_of_their_own() -> None:
    """With a tolerance this loose the step grows until Newton fails, and ANDES
    shrinks it to well under a nanosecond before it gives up. The record is still
    ``dae.ts`` row for row."""
    run = _fresh(
        integrator="trap_adapt", tds_config_overrides={"rtol": 0.1, "atol": 0.01, "max_step": 0.05}
    )
    assert run.result["converged"] is False
    assert np.diff(run.stored_t).min() < 1e-9
    assert run.t.tolist() == run.stored_t.tolist()
    assert np.array_equal(run.omega, run.stored_omega)


# ---- one integrator after another on the same System -----------------------------------


def _live(w: Wrapper) -> str:
    return type(w._require_loaded().TDS.method).__name__  # noqa: SLF001


@pytest.mark.parametrize(
    ("first", "then", "live"),
    [
        ({"h": H}, {"integrator": "trap_adapt", "tds_config_overrides": AUTO}, "TrapezoidAdaptive"),
        ({"integrator": "qndf", "tds_config_overrides": AUTO}, {"integrator": "backeuler", "h": H}, "BackEuler"),
        ({"integrator": "trap_adapt", "tds_config_overrides": AUTO}, {"h": H}, "Trapezoid"),
        ({"integrator": "backeuler", "h": H}, {"h": H}, "Trapezoid"),
    ],
)
def test_a_run_that_carries_on_steps_with_the_integrator_it_names(
    first: dict[str, Any], then: dict[str, Any], live: str, trapezoidal: Run
) -> None:
    w = _ieee14()
    Run(w, tf=1.0, **first)
    second = Run(w, **then)
    assert second.result["converged"] is True
    assert _live(w) == live
    assert second.t[0] > 1.0
    steps = np.diff(second.t)
    if then.get("integrator") == "trap_adapt":
        assert steps.max() > 2 * H
    else:
        assert _at_h(steps) > 0.9
    # Where it ends is where a run of the trapezoidal method alone ends, within
    # what the first-order method costs.
    assert abs(second.omega[-1] - trapezoidal.omega[-1]) < 1e-4


def test_after_a_run_of_a_new_integrator_a_plain_run_is_what_it_always_was() -> None:
    """``method`` and ``fixt`` are what a System that never ran one has, and the
    plain run's second half matches that of a System that never did."""
    w = _ieee14()
    plain = _ieee14()
    Run(w, tf=1.0, integrator="trap_adapt", tds_config_overrides={"rtol": 1e-4})
    Run(plain, tf=1.0, h=H)
    ss, untouched = w._require_loaded(), plain._require_loaded()  # noqa: SLF001
    a, b = Run(w, h=H), Run(plain, h=H)
    assert (ss.TDS.config.method, int(ss.TDS.config.fixt)) == (
        untouched.TDS.config.method,
        int(untouched.TDS.config.fixt),
    ) == ("trapezoid", 1)
    assert _live(w) == _live(plain) == "Trapezoid"
    assert a.t.tolist() == pytest.approx(b.t.tolist(), abs=1e-12)
    assert abs(a.omega[-1] - b.omega[-1]) < 1e-5
