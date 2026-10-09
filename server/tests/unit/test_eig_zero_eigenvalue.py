"""A zero eigenvalue is reported as zero, on every machine.

A system with no fixed angle reference has one, and the solver returns rounding
noise for it: ``-3.0e-14`` for IEEE 14 with one set of BLAS kernels and
``+1.1e-14`` with another (``OPENBLAS_CORETYPE=Nehalem`` shows the second on a
processor that picks the first). The damping ratio ``-Re / |z|`` of the one is 1
and of the other -1, so the same case had a growing mode on some machines and
none on others, and whatever read the result (the scatter's filter, the report's
count of unstable modes, a test) went with the sign. ANDES counts an eigenvalue
within ``EIG.config.tol`` as zero; the result now says zero too.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tensa.core.wrapper import Wrapper
from tensa.core.wrapper.eig import (
    _ZERO_EIGENVALUE_TOL,
    _compute_damping_ratio,
    _settle_zero,
    _zero_tolerance,
)

pytestmark = pytest.mark.unit

# The zero eigenvalue of IEEE 14 as two machines computed it, and as a third might.
NOISE = [complex(-3.030009e-14, 0.0), complex(1.103590e-14, 0.0), complex(2e-9, -4e-10)]


@pytest.mark.parametrize("z", [*NOISE, 0j, complex(1e-6, 0.0), complex(0.0, -1e-6)])
def test_an_eigenvalue_within_the_tolerance_is_zero(z: complex) -> None:
    settled = _settle_zero(z, 1e-6)
    assert settled == 0j
    # Not a zero that still carries a sign.
    assert str(settled.real) == "0.0" and str(settled.imag) == "0.0"


@pytest.mark.parametrize(
    "z",
    [complex(-1.5e-6, 0.0), complex(2e-6, 0.0), complex(0.0, 5.0), complex(-1e-9, 5.0)],
)
def test_any_other_eigenvalue_is_left_as_it_came(z: complex) -> None:
    """Only the eigenvalue as a whole is judged: a mode that oscillates keeps its
    real part however small that is."""
    assert _settle_zero(z, 1e-6) == z


def test_a_zero_eigenvalue_is_not_poorly_damped() -> None:
    # It neither oscillates nor grows, like a real mode that decays.
    assert _compute_damping_ratio(0j) == 1.0
    assert _compute_damping_ratio(complex(-0.5, 0.0)) == 1.0
    # What the formula still says of the others.
    assert _compute_damping_ratio(complex(0.5, 0.0)) == -1.0
    assert _compute_damping_ratio(complex(0.0, 5.0)) == 0.0
    assert _compute_damping_ratio(complex(-3.0, 4.0)) == pytest.approx(0.6)
    # And what keeps a result that is no number out of the JSON.
    assert _compute_damping_ratio(complex(float("inf"), 0.0)) == 0.0
    assert _compute_damping_ratio(complex(float("nan"), 1.0)) == 0.0


def _system(mu: list[complex], **eig: Any) -> SimpleNamespace:
    """What ``run_eig`` reads of a System whose routine has returned ``mu``."""
    return SimpleNamespace(
        is_setup=True,
        PFlow=SimpleNamespace(converged=True),
        TDS=SimpleNamespace(initialized=True),
        EIG=SimpleNamespace(run=lambda: True, mu=mu, **eig),
        dae=SimpleNamespace(x_name=[f"x{i}" for i in range(len(mu))]),
    )


def test_the_tolerance_is_the_one_andes_counts_its_zeros_by() -> None:
    assert _zero_tolerance(_system([], config=SimpleNamespace(tol=1e-4))) == 1e-4
    # ANDES's default, when the routine has none to give or one that is no bound.
    assert _ZERO_EIGENVALUE_TOL == 1e-6
    assert _zero_tolerance(_system([])) == _ZERO_EIGENVALUE_TOL
    for odd in (None, "tight", float("nan"), float("inf"), -1.0):
        assert _zero_tolerance(_system([], config=SimpleNamespace(tol=odd))) == _ZERO_EIGENVALUE_TOL


OSCILLATING = [complex(-1.5037, 5.9612), complex(-1.5037, -5.9612), complex(-0.4695, 0.0)]


@pytest.mark.parametrize("zero", NOISE, ids=["negative", "positive", "complex"])
def test_the_result_is_the_same_whatever_the_sign_of_the_noise(zero: complex) -> None:
    wrapper = Wrapper()
    wrapper._ss = _system([*OSCILLATING, zero], config=SimpleNamespace(tol=1e-6))  # type: ignore[assignment]
    result = wrapper.run_eig()

    assert result.mode_count == 4
    assert (result.eigenvalues[3].real, result.eigenvalues[3].imag) == (0.0, 0.0)
    assert result.damping_ratios[3] == 1.0
    assert result.frequencies_hz[3] == 0.0
    # No mode has a positive real part, and none is poorly damped: what the UI
    # and the report read the result for.
    assert all(z.real <= 0.0 for z in result.eigenvalues)
    assert all(ratio > 0.05 for ratio in result.damping_ratios)
    # The other modes are as the routine returned them.
    assert [complex(z.real, z.imag) for z in result.eigenvalues[:3]] == OSCILLATING
    assert result.damping_ratios[0] == pytest.approx(0.2446, abs=1e-4)


def test_a_mode_that_does_grow_is_still_reported_as_growing() -> None:
    wrapper = Wrapper()
    wrapper._ss = _system([complex(1.033, 0.0), complex(2e-6, 0.0)])  # type: ignore[assignment]
    result = wrapper.run_eig()
    assert [z.real for z in result.eigenvalues] == [1.033, 2e-6]
    assert result.damping_ratios == [-1.0, -1.0]
