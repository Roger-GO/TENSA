"""Unit tests for ``tensa.core.eig_math``: the engine-neutral eig math.

The participation factors are held against a 2 by 2 and a 3 by 3 matrix
worked by hand in the comments below; the ANDES eigenvalue tests passing
unchanged is the proof the lift of the four helpers changed nothing.
"""

from __future__ import annotations

import math
import subprocess
import sys

import numpy as np

from tensa.core.eig_math import (
    _compute_damping_ratio,
    _compute_frequency_hz,
    _settle_axis,
    _settle_zero,
    eigen_decomposition,
    participation_factors,
)


def test_each_factor_row_belongs_to_the_eigenvalue_at_its_position() -> None:
    # An upper-triangular matrix has its eigenvalues on the diagonal, and the
    # mode of eigenvalue a[k, k] is carried most by state k here (the
    # off-diagonal coupling is small). Whatever order the decomposition lists
    # the modes in, row i must peak at the state whose diagonal is eigenvalue i.
    matrix = np.array(
        [
            [-3.0, 0.1, 0.0],
            [0.0, -1.0, 0.1],
            [0.0, 0.0, -2.0],
        ]
    )
    eigenvalues, rows = eigen_decomposition(matrix)

    assert len(eigenvalues) == 3
    assert len(rows) == 3
    for z, row in zip(eigenvalues, rows, strict=True):
        state = max(range(3), key=lambda j: row[j])
        assert abs(matrix[state, state] - z.real) < 1e-9, (z, row)


def test_the_factors_are_andes_own_for_the_same_matrix() -> None:
    """ANDES's ``calc_pfactor`` itself, called on a stand-in for its routine,
    is the reference: both engines must show the same numbers for one matrix.
    The matrix is not symmetric, so a transpose dropped or added shows."""
    from types import SimpleNamespace

    from andes.routines.eig import EIG

    matrix = np.array(
        [
            [-0.5, 3.0, 0.2, 0.0],
            [-2.0, -0.1, 0.0, 0.4],
            [0.7, 0.0, -4.0, 1.0],
            [0.0, -0.3, 0.5, -1.5],
        ]
    )
    stand_in = SimpleNamespace(
        calc_eig=lambda As=None: np.linalg.eig(matrix), config=SimpleNamespace(tol=1e-6)
    )
    mu, pfactor, _right, _left = EIG.calc_pfactor(stand_in, matrix)

    eigenvalues, rows = eigen_decomposition(matrix)

    assert np.allclose(np.array(eigenvalues), mu)
    assert np.allclose(np.array(rows), pfactor)


def test_eigen_decomposition_and_participation_factors_agree() -> None:
    matrix = np.array([[-1.0, 2.0], [-3.0, -0.5]])
    _eigenvalues, rows = eigen_decomposition(matrix)
    assert rows == participation_factors(matrix)


def test_settle_zero() -> None:
    assert _settle_zero(complex(3e-14, 1e-14), 1e-6) == 0j
    assert _settle_zero(complex(0.1, 0.2), 1e-6) == complex(0.1, 0.2)
    # The rule is <=: exactly the tolerance is zero.
    assert _settle_zero(complex(1e-6, 0.0), 1e-6) == 0j


def test_settle_axis() -> None:
    assert _settle_axis(complex(1e-16, 1.5)) == complex(0.0, 1.5)
    assert _settle_axis(complex(0.001, 1.5)) == complex(0.001, 1.5)
    # A purely real eigenvalue is untouched (the rule needs imag != 0).
    assert _settle_axis(complex(1e-16, 0.0)) == complex(1e-16, 0.0)


def test_compute_damping_ratio() -> None:
    # A mode of 0.6295 Hz damped at 0.0684. With wd = 2 * pi * f the damped
    # frequency and wn = wd / sqrt(1 - zeta^2) the undamped one, the pole is
    # z = -zeta * wn + j * wd, and then |z| = wn, so -Re(z) / |z| = zeta
    # exactly. (z = -zeta * wd + j * wd would give zeta / sqrt(1 + zeta^2).)
    wd = 2 * math.pi * 0.6295
    wn = wd / math.sqrt(1 - 0.0684**2)
    z = complex(-0.0684 * wn, wd)
    assert _compute_damping_ratio(z) == pytest_approx(0.0684, 1e-12)
    assert _compute_damping_ratio(0j) == 1.0
    on_axis = _compute_damping_ratio(complex(0.0, 1.5))
    assert on_axis == 0.0
    assert math.copysign(1.0, on_axis) == 1.0  # 0.0, not -0.0
    assert _compute_damping_ratio(complex(-3.0, 0.0)) == 1.0
    assert _compute_damping_ratio(complex(3.0, 0.0)) == -1.0


def test_compute_frequency_hz() -> None:
    assert _compute_frequency_hz(complex(0.0, 7.1631)) == pytest_approx(
        7.1631 / (2 * math.pi), 1e-15
    )
    assert _compute_frequency_hz(complex(3.0, 0.0)) == 0.0
    assert _compute_frequency_hz(complex(0.0, -7.1631)) == pytest_approx(
        7.1631 / (2 * math.pi), 1e-15
    )


def pytest_approx(value: float, tol: float) -> float:
    import pytest

    return pytest.approx(value, abs=tol)  # type: ignore[return-value]


def test_participation_factors_identity_is_one_hot() -> None:
    rows = participation_factors(np.eye(3))
    assert len(rows) == 3
    for row in rows:
        assert sorted(row) == [0.0, 0.0, 1.0]


def test_participation_factors_2x2_by_hand() -> None:
    # A = [[0, 1], [-2, -3]]: eigenvalues -1 and -2 (trace -3, determinant 2).
    # Right eigenvectors: for -1, (A + I) v = 0 gives v1 = (1, -1); for -2,
    # (A + 2I) v = 0 gives v2 = (1, -2). N = [[1, 1], [-1, -2]].
    # inv(N) = [[2, 1], [-1, -1]], so W = inv(N).T = [[2, -1], [1, -1]].
    # |W| * |N| = [[2*1, 1*1], [1*1, 1*2]] = [[2, 1], [1, 2]] (rows states,
    # columns modes). Column sums are 3 and 3, so normalised columns are
    # (2/3, 1/3) and (1/3, 2/3); one row per mode: mode -1 is [2/3, 1/3],
    # mode -2 is [1/3, 2/3].
    matrix = np.array([[0.0, 1.0], [-2.0, -3.0]])
    rows = participation_factors(matrix)
    assert len(rows) == 2
    by_sum = sorted(rows, key=lambda row: -row[0])
    assert by_sum[0] == pytest_approx_list([2 / 3, 1 / 3])
    assert by_sum[1] == pytest_approx_list([1 / 3, 2 / 3])
    for row in rows:
        assert sum(row) == pytest_approx(1.0, 1e-12)
        assert all(0.0 <= factor <= 1.0 for factor in row)


def test_participation_factors_3x3_by_hand() -> None:
    # diag(1, 2, 3) with one coupling: A = [[1, 1, 0], [0, 2, 0], [0, 0, 3]].
    # Eigenvalues 1, 2, 3. Right eigenvectors: for 1, (A - I) v = 0 gives
    # v1 = (1, 0, 0); for 2, (A - 2I) = [[-1, 1, 0], [0, 0, 0], [0, 0, 1]]
    # gives x = y and z = 0, so v2 = (1, 1, 0); for 3, v3 = (0, 0, 1).
    # N = [[1, 1, 0], [0, 1, 0], [0, 0, 1]] (one column per mode);
    # inv(N) = [[1, -1, 0], [0, 1, 0], [0, 0, 1]]; W = inv(N).T =
    # [[1, 0, 0], [-1, 1, 0], [0, 0, 1]] (one column per mode too).
    # |W| * |N| elementwise, column by column: mode 1 is |（1,0,0)| * |(1,0,0)|
    # = (1, 0, 0); mode 2 is |(0, 1, 0)| * |(1, 1, 0)| = (0, 1, 0); mode 3 is
    # (0, 0, 1). Each column already sums to 1, so the normalisation changes
    # nothing. One row per mode: [1.0, 0.0, 0.0], [0.0, 1.0, 0.0],
    # [0.0, 0.0, 1.0]. (The product is invariant to the eigenvector scaling:
    # scaling a column of N by c scales the matching column of W by 1/c.)
    matrix = np.array([[1.0, 1.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 3.0]])
    rows = participation_factors(matrix)
    assert len(rows) == 3
    assert sorted(rows) == [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]
    # A wrong implementation that uses only right eigenvectors gives the mode
    # of eigenvalue 2 as [0.5, 0.5, 0.0] instead of [0.0, 1.0, 0.0]: the left
    # eigenvector of that mode is (0, 1, 0), which cancels the first state.
    assert [0.0, 1.0, 0.0] in rows


def test_participation_factors_non_symmetric_mode_on_state_zero() -> None:
    # A = [[1, 2], [0, 3]]: eigenvalues 1 and 3. For eigenvalue 1 the right
    # eigenvector is (1, 0) and the left eigenvector row is (1, -1) up to
    # scale: |W[0,0] * N[0,0]| is the only nonzero of the column, so the mode
    # of eigenvalue 1 has factor 1.0 on state 0.
    matrix = np.array([[1.0, 2.0], [0.0, 3.0]])
    rows = participation_factors(matrix)
    assert [1.0, 0.0] in rows
    for row in rows:
        assert sum(row) == pytest_approx(1.0, 1e-12)


def pytest_approx_list(values: list[float]) -> list[float]:
    import pytest

    return pytest.approx(values, abs=1e-5)  # type: ignore[return-value]


def test_the_module_imports_no_engine() -> None:
    code = (
        "import sys\n"
        "import tensa.core.eig_math\n"
        "assert 'andes' not in sys.modules, 'andes was imported'\n"
        "assert 'juliacall' not in sys.modules, 'juliacall was imported'\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
