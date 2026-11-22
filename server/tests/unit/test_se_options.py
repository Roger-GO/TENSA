"""Unit tests for the SE run options on the wrapper (Unit P4-A).

Drives ``Wrapper.run_se`` against a fake System: no ANDES import, no case
load. The fake ``ss.SE`` records the config values it saw during the run so
the tests can hold that ``tol`` / ``max_iter`` overrides apply for one run
only and are put back afterwards, including when the run raises.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from tensa.core.errors import SeNonConvergentError, SeOptionError
from tensa.core.wrapper import Wrapper


class _FakeConfig:
    def __init__(self, tol: float = 1e-4, max_iter: int = 100) -> None:
        self.tol = tol
        self.max_iter = max_iter


class _FakeMeasurements:
    """The cached measurement set: 43 measurements, a recordable redraw."""

    def __init__(self) -> None:
        self.nm = 43
        self.sigma = [0.01] * 43
        self.z = np.zeros(43)
        self.seeds: list[int | None] = []
        self.events: list[str] = []

    def generate_from_pflow(self, seed: int | None = None) -> None:
        self.seeds.append(seed)
        self.events.append("generate")
        self.z = np.full(43, float(seed if seed is not None else -1))


class _FakeSE:
    """Stand-in for ``ss.SE``: converges, records what the run saw."""

    def __init__(self, measurements: _FakeMeasurements) -> None:
        self.config = _FakeConfig()
        self.measurements: _FakeMeasurements | None = None
        self.result: dict[str, Any] = {}
        self.run_calls: list[dict[str, Any]] = []
        self.chi_squared_calls = 0
        self._cached = measurements

    def init(self, measurements: Any = None, algorithm: Any = None) -> bool:
        self.measurements = measurements
        measurements.events.append("init")
        return True

    def run(self, measurements: Any = None, algorithm: Any = None, **kwargs: Any) -> bool:
        self.run_calls.append(
            {
                "measurements": measurements,
                "algorithm": algorithm,
                "tol": self.config.tol,
                "max_iter": self.config.max_iter,
                "z": np.array(measurements.z, copy=True),
            }
        )
        self.measurements = measurements
        self.result = {
            "converged": True,
            "n_iter": 3,
            "J": 12.5,
            "residuals": [0.001] * 43,
        }
        return True

    def chi_squared_test(self, confidence: float = 0.95) -> tuple[bool, float, float, int]:
        self.chi_squared_calls += 1
        return (True, 12.5, 20.0, 15)


class _FakePFlow:
    converged = True


class _FakeBus:
    n = 14


class _FakeSystem:
    def __init__(self, se: _FakeSE) -> None:
        self.SE = se
        self.PFlow = _FakePFlow()
        self.Bus = _FakeBus()


def _wrapper_with_fake(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[Wrapper, _FakeSystem, _FakeSE, _FakeMeasurements]:
    wrapper = Wrapper()
    cached = _FakeMeasurements()
    se = _FakeSE(cached)
    ss = _FakeSystem(se)
    monkeypatch.setattr(wrapper, "_require_loaded", lambda: ss)
    monkeypatch.setattr(wrapper, "_ensure_setup", lambda: None)
    wrapper._se_measurements = cached
    return wrapper, ss, se, cached


def test_an_unknown_algorithm_is_refused_before_any_andes_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, _ss, se, _cached = _wrapper_with_fake(monkeypatch)
    with pytest.raises(SeOptionError, match="unknown SE algorithm 'nonsense'"):
        wrapper.run_se(algorithm="nonsense")
    assert se.run_calls == []


@pytest.mark.parametrize(
    ("kwargs", "match"),
    [
        ({"tol": 0.0}, "tol must be a positive float"),
        ({"tol": -1e-4}, "tol must be a positive float"),
        ({"tol": float("nan")}, "tol must be a positive float"),
        ({"max_iter": 0}, "max_iter must be an integer >= 1"),
        ({"max_iter": True}, "max_iter must be an integer >= 1"),
        ({"noise_seed": -1}, "noise_seed must be a non-negative integer"),
    ],
)
def test_a_bad_option_value_is_refused(
    monkeypatch: pytest.MonkeyPatch,
    kwargs: dict[str, Any],
    match: str,
) -> None:
    wrapper, _ss, se, _cached = _wrapper_with_fake(monkeypatch)
    with pytest.raises(SeOptionError, match=match):
        wrapper.run_se(**kwargs)
    assert se.run_calls == []


def test_the_algorithm_name_is_case_insensitive_and_dispatches_to_lav(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, _ss, se, _cached = _wrapper_with_fake(monkeypatch)
    result = wrapper.run_se(algorithm="LAV")
    assert result.algorithm == "lav"
    from andes.se.algorithms import lav

    assert se.run_calls[0]["algorithm"] is lav


def test_tol_and_max_iter_apply_for_one_run_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, ss, se, _cached = _wrapper_with_fake(monkeypatch)
    result = wrapper.run_se(tol=1e-8, max_iter=5)
    # During the run the config held the overrides.
    assert se.run_calls[0]["tol"] == 1e-8
    assert se.run_calls[0]["max_iter"] == 5
    # Afterwards the original values are back.
    assert ss.SE.config.tol == 1e-4
    assert ss.SE.config.max_iter == 100
    # The result reports the effective values the solver saw.
    assert result.settings["tol"] == 1e-8
    assert result.settings["max_iter"] == 5


def test_the_config_is_restored_when_the_run_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, ss, se, _cached = _wrapper_with_fake(monkeypatch)

    def _boom(**kwargs: Any) -> bool:
        raise RuntimeError("solver blew up")

    monkeypatch.setattr(se, "run", _boom)
    with pytest.raises(Exception, match="solver blew up"):
        wrapper.run_se(tol=1e-8, max_iter=5)
    assert ss.SE.config.tol == 1e-4
    assert ss.SE.config.max_iter == 100


def test_a_seed_redraws_the_noise_and_none_leaves_it_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, _ss, se, cached = _wrapper_with_fake(monkeypatch)
    wrapper.run_se(noise_seed=42)
    assert cached.seeds == [42]
    # The angle reference goes in before the draw, the run sees the draw,
    # and the cached values are put back after it.
    assert cached.events == ["init", "generate"]
    assert np.all(se.run_calls[0]["z"] == 42.0)
    assert np.all(cached.z == 0.0)
    wrapper.run_se()
    assert cached.seeds == [42]
    assert np.all(se.run_calls[1]["z"] == 0.0)


def test_the_cached_values_are_put_back_when_a_seeded_run_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, ss, se, cached = _wrapper_with_fake(monkeypatch)

    def _boom(**kwargs: Any) -> bool:
        raise RuntimeError("solver blew up")

    monkeypatch.setattr(se, "run", _boom)
    with pytest.raises(Exception, match="solver blew up"):
        wrapper.run_se(noise_seed=3, tol=1e-6)
    assert np.all(cached.z == 0.0)
    assert ss.SE.config.tol == 1e-4


def test_a_run_that_does_not_converge_is_reported_as_such(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, ss, se, _cached = _wrapper_with_fake(monkeypatch)
    real_run = se.run

    def _runs_out(**kwargs: Any) -> bool:
        real_run(**kwargs)
        se.result = {**se.result, "converged": False, "n_iter": 1}
        return False

    monkeypatch.setattr(se, "run", _runs_out)
    with pytest.raises(SeNonConvergentError, match="LAV did not converge after 1 iterations"):
        wrapper.run_se(algorithm="lav", max_iter=1)
    assert ss.SE.config.max_iter == 100


def test_no_chi_squared_without_redundancy(monkeypatch: pytest.MonkeyPatch) -> None:
    wrapper, _ss, se, _cached = _wrapper_with_fake(monkeypatch)
    monkeypatch.setattr(
        se, "chi_squared_test", lambda confidence=0.95: (False, 1.0, float("inf"), 0)
    )
    assert wrapper.run_se().chi_squared is None


def test_the_result_carries_algorithm_settings_and_chi_squared_for_wls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, _ss, se, _cached = _wrapper_with_fake(monkeypatch)
    result = wrapper.run_se(noise_seed=7)
    assert result.algorithm == "wls"
    assert result.settings == {"tol": 1e-4, "max_iter": 100, "noise_seed": 7}
    assert result.chi_squared is not None
    assert result.chi_squared["passed"] is True
    assert result.chi_squared["dof"] == 15
    assert result.chi_squared["confidence"] == 0.95
    assert se.chi_squared_calls == 1


def test_lav_reports_no_chi_squared_and_the_test_is_not_called(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, _ss, se, _cached = _wrapper_with_fake(monkeypatch)
    result = wrapper.run_se(algorithm="lav")
    assert result.algorithm == "lav"
    assert result.chi_squared is None
    assert se.chi_squared_calls == 0


def test_a_request_with_no_new_fields_behaves_as_before(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrapper, _ss, se, _cached = _wrapper_with_fake(monkeypatch)
    result = wrapper.run_se()
    assert result.converged is True
    assert result.algorithm == "wls"
    assert result.settings == {"tol": 1e-4, "max_iter": 100, "noise_seed": None}
    assert result.chi_squared is not None
    from andes.se.algorithms import wls

    assert se.run_calls[0]["algorithm"] is wls
