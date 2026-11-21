"""The state-estimation run options against real ANDES (IEEE 14).

What ANDES 2.0.0 does with them, held here because the unit tests drive a
stand-in: ``andes.se.algorithms.lav`` is iteratively reweighted least squares
in NumPy (no LP solver), the chi-squared test takes ``dof = nm - 2 * nb`` with
the angle-reference pseudo-measurement counted in ``nm``, the noise of
``Measurements.generate_from_pflow`` comes from its own
``numpy.random.default_rng(seed)``, and ``SE.config.tol`` / ``max_iter`` are
read when ``SE.run`` starts.

The margins: a test that rests on noise takes it from fixed seeds and holds a
bound a few times wider than any of twenty seeds came near (the numbers are
beside each assertion), so a NumPy whose normal stream differs does not break
it. The test of a gross error uses measurements without noise, which no random
stream enters.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from tensa.core.errors import SeNonConvergentError
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

CASE = "ieee14/ieee14_full.xlsx"
NB = 14
# 14 bus voltages, 14 P and 14 Q injections, and the angle reference.
NM = 43
DOF = NM - 2 * NB


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


@pytest.fixture
def wrapper() -> Wrapper:
    w = Wrapper()
    w.load_case(_cases() / CASE)
    assert w.run_pflow().converged
    w.generate_measurements_from_pflow(noise_seed=0)
    return w


def _ss(w: Wrapper) -> Any:
    return w._require_loaded()


def _measurements(w: Wrapper) -> Any:
    m = w._se_measurements
    assert m is not None
    return m


def _truth(w: Wrapper) -> tuple[np.ndarray, np.ndarray]:
    ss = _ss(w)
    return np.array(ss.Bus.a.v, dtype=float), np.array(ss.Bus.v.v, dtype=float)


def _errors(w: Wrapper) -> tuple[float, float]:
    """The largest angle (rad) and magnitude (pu) error of the last estimate."""
    ss = _ss(w)
    a, v = _truth(w)
    x = np.asarray(ss.SE.result["x_est"], dtype=float)
    return float(np.max(np.abs(x[:NB] - a))), float(np.max(np.abs(x[NB:] - v)))


def _without_noise(w: Wrapper) -> None:
    _measurements(w).generate_from_pflow(noise_func=lambda sigma, n, rng: np.zeros(n))


def _position(w: Wrapper, kind: str, bus: int) -> int:
    m = _measurements(w)
    return next(i for i in range(m.nm) if m._kind[i] == kind and m._idx[i] == bus)


def test_without_noise_both_estimators_give_the_power_flow_state(wrapper: Wrapper) -> None:
    _without_noise(wrapper)
    for algorithm in ("wls", "lav"):
        result = wrapper.run_se(algorithm=algorithm)
        assert result.algorithm == algorithm
        da, dv = _errors(wrapper)
        assert da < 1e-8 and dv < 1e-8
        assert result.mismatch < 1e-12
    wls = wrapper.run_se()
    assert wls.chi_squared is not None
    assert wls.chi_squared["passed"] is True
    assert wls.chi_squared["J"] < 1e-12


def test_lav_rejects_a_gross_error_that_pulls_wls(wrapper: Wrapper) -> None:
    """One P injection 20 sigma off, the rest exact. WLS spreads the error over
    the state (0.10 rad at the worst bus, ANDES 2.0.0 on IEEE 14); LAV leaves
    the bad measurement out and lands within its own tolerance of the truth
    (6.8e-4 rad). Every one of the 42 measurements made bad this way in turn
    gave WLS at least 2.8e-3 rad or 1.6e-2 pu and LAV at most 6.8e-4 rad and
    1.6e-4 pu."""
    _without_noise(wrapper)
    bad = _position(wrapper, "p_inj", 8)
    m = _measurements(wrapper)
    m.z[bad] += 20 * m.sigma[bad]

    wls = wrapper.run_se(algorithm="wls")
    wls_da, _ = _errors(wrapper)
    lav = wrapper.run_se(algorithm="lav")
    lav_da, lav_dv = _errors(wrapper)

    assert wls_da > 2e-2
    assert lav_da < 3e-3 and lav_dv < 1e-3
    assert lav_da < wls_da / 10
    # LAV leaves the whole error on the bad measurement and flags it alone.
    assert lav.residuals[bad] == pytest.approx(20 * m.sigma[bad], rel=0.05)
    assert lav.flagged_indices == [bad]
    assert wls.residuals[bad] < 0.8 * 20 * m.sigma[bad]
    # The chi-squared test sees it in the WLS run.
    assert wls.chi_squared is not None and wls.chi_squared["passed"] is False
    assert lav.chi_squared is None


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_with_noise_both_estimates_stay_near_the_power_flow_state(
    wrapper: Wrapper, seed: int
) -> None:
    """Twenty seeds gave an RMS state error of at most 7.8e-3 for WLS and
    1.05e-2 for LAV (LAV is the less efficient estimator under Gaussian
    noise). The bound is 3e-2."""
    for algorithm in ("wls", "lav"):
        wrapper.run_se(algorithm=algorithm, noise_seed=seed, max_iter=1000)
        ss = _ss(wrapper)
        a, v = _truth(wrapper)
        x = np.asarray(ss.SE.result["x_est"], dtype=float)
        rms = float(np.sqrt(np.mean(np.concatenate([x[:NB] - a, x[NB:] - v]) ** 2)))
        assert rms < 3e-2, (algorithm, rms)


def test_chi_squared_with_noise_at_the_stated_sigmas(wrapper: Wrapper) -> None:
    """J of a WLS run follows a chi-squared law with ``nm - 2 * nb`` = 15 degrees
    of freedom. Over ten seeds its mean is 15 within 1.7 (one standard
    deviation of the mean); twenty seeds gave a mean of 16.3 and one J of 26.5
    over the 25.0 threshold, the 5% the test lets through. The bounds are 9
    and 23, and at least seven of ten pass."""
    from scipy.stats import chi2

    js: list[float] = []
    passed = 0
    for seed in range(10):
        result = wrapper.run_se(noise_seed=seed)
        chi = result.chi_squared
        assert chi is not None
        assert chi["dof"] == DOF == result.measurement_count - 2 * NB
        assert chi["threshold"] == pytest.approx(chi2.ppf(0.95, DOF))
        assert chi["confidence"] == 0.95
        assert chi["J"] == pytest.approx(result.mismatch)
        assert chi["passed"] is (chi["J"] < chi["threshold"])
        js.append(float(chi["J"]))
        passed += int(bool(chi["passed"]))
    assert 9.0 < float(np.mean(js)) < 23.0
    assert passed >= 7


@pytest.mark.parametrize("seed", [0, 1, 2, 3, 4])
def test_chi_squared_fails_on_a_gross_error(wrapper: Wrapper, seed: int) -> None:
    """A P injection 50 sigma off with noise on the rest: J was 117 to 223 over
    twenty seeds, against a threshold of 25."""
    wrapper.run_se(noise_seed=seed)  # the angle reference is in the set from here
    m = _measurements(wrapper)
    m.generate_from_pflow(seed=seed)
    bad = _position(wrapper, "p_inj", 4)
    m.z[bad] += 50 * m.sigma[bad]
    result = wrapper.run_se()
    assert result.chi_squared is not None
    assert result.chi_squared["passed"] is False
    assert result.chi_squared["J"] > 2 * result.chi_squared["threshold"]


def test_a_seed_draws_this_run_only_and_touches_no_global_state(
    wrapper: Wrapper,
) -> None:
    m = _measurements(wrapper)
    cached = wrapper.run_se()
    z_cached = np.array(m.z, copy=True)
    np.random.seed(12345)
    global_state = np.random.get_state()

    first = wrapper.run_se(noise_seed=7)
    second = wrapper.run_se(noise_seed=7)
    other = wrapper.run_se(noise_seed=8)

    assert first.residuals == second.residuals
    assert first.settings["noise_seed"] == 7
    assert other.residuals != first.residuals
    assert first.residuals != cached.residuals
    # The cached set is as the generate step left it, and a run without a
    # seed runs on it again.
    assert np.array_equal(m.z, z_cached)
    assert wrapper.run_se().residuals == cached.residuals
    # NumPy's global generator was neither used nor reseeded.
    after = np.random.get_state()
    assert after[0] == global_state[0]
    assert np.array_equal(after[1], global_state[1]) and after[2:] == global_state[2:]
    # Unseeded draws after a seeded run still differ from one another.
    wrapper.generate_measurements_from_pflow()
    z1 = np.array(_measurements(wrapper).z, copy=True)
    wrapper.generate_measurements_from_pflow()
    z2 = np.array(_measurements(wrapper).z, copy=True)
    assert not np.array_equal(z1, z2)


def test_the_first_seeded_run_matches_a_later_one(wrapper: Wrapper) -> None:
    """The first run adds the angle reference; a seeded draw made before it and
    one made after must still be the same draw."""
    first = wrapper.run_se(noise_seed=3)
    wrapper.run_se()
    again = wrapper.run_se(noise_seed=3)
    assert first.residuals == again.residuals


@pytest.mark.parametrize("algorithm", ["wls", "lav"])
def test_a_small_max_iter_reports_non_convergence_and_puts_everything_back(
    wrapper: Wrapper, algorithm: str
) -> None:
    """ANDES returns ``converged=False`` when ``max_iter`` runs out (it does not
    raise); one iteration never converges here, since the first correction
    from the power-flow state is the size of the noise (1e-3 and more), far
    above ``tol``."""
    ss = _ss(wrapper)
    m = _measurements(wrapper)
    wrapper.run_se()
    z_cached = np.array(m.z, copy=True)
    with pytest.raises(SeNonConvergentError, match=rf"{algorithm.upper()} did not converge after 1 iterations"):
        wrapper.run_se(algorithm=algorithm, max_iter=1, tol=1e-6, noise_seed=5)
    assert ss.SE.config.tol == 1e-4
    assert ss.SE.config.max_iter == 100
    assert np.array_equal(m.z, z_cached)


def test_tol_and_max_iter_are_what_the_solver_used(wrapper: Wrapper) -> None:
    loose = wrapper.run_se(tol=1e-2)
    tight = wrapper.run_se(tol=1e-12, max_iter=50)
    assert loose.settings == {"tol": 1e-2, "max_iter": 100, "noise_seed": None}
    assert tight.settings == {"tol": 1e-12, "max_iter": 50, "noise_seed": None}
    assert tight.iterations > loose.iterations
    ss = _ss(wrapper)
    assert (ss.SE.config.tol, ss.SE.config.max_iter) == (1e-4, 100)
