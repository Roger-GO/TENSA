"""Eigenvalue math shared by every engine.

The zero rule, the axis rule, the damping ratio and the frequency of one
eigenvalue, lifted from ``core/wrapper/eig.py`` so the Sienna engine builds
the same ``EigResult`` the ANDES engine returns (``design/multiengine/spec.md``,
section 9: damping, frequency and participation factors are computed by the
code ANDES sessions already use, from the same matrices). Nothing here imports
an engine.
"""

from __future__ import annotations

import math
from typing import Any

# What ANDES counts as zero when its routine has no bound to give.
_ZERO_EIGENVALUE_TOL = 1e-6
# How small the real part of an oscillating eigenvalue is, next to the eigenvalue itself,
# for it to be rounding noise (see ``_settle_axis``). The noise of a solver is some 1e-16 of
# the size of the matrix it works on; a mode with real part this small has no damping that
# means anything.
_AXIS_NOISE = 1e-12


def _settle_zero(z: complex, tol: float) -> complex:
    """``z``, or exactly zero when it is zero to within ``tol``.

    A system with no fixed angle reference has a zero eigenvalue, and what the
    solver returns for it is rounding noise of either sign: ``-3e-14`` on one
    processor and ``+1e-14`` on another, for the same case and the same ANDES.
    Left as it came, the sign decided whether the mode was reported as decaying
    (a damping ratio of 1) or as growing (-1, with a positive real part), so one
    machine showed a stable system and the next an unstable one. ANDES counts
    such an eigenvalue among its zeros and so does the result.
    """
    return 0j if abs(z) <= tol else z


def _settle_axis(z: complex) -> complex:
    """``z``, or its imaginary part alone when the real part is rounding noise beside it.

    A system with no damping at all, such as machines on the classical model with ``D = 0``,
    has eigenvalues on the imaginary axis, and the solver returns them with a real part of
    some 1e-16 of either sign. Left as it came, the sign again decided whether the mode was
    undamped (a damping ratio of 0) or growing (a positive real part, which the scatter and
    the report count as unstable), and it can differ from one processor to the next, as for
    the zero eigenvalue. An oscillating eigenvalue whose real part is under ``_AXIS_NOISE``
    of its size is reported on the axis, with a damping ratio of exactly 0.
    """
    if z.imag != 0.0 and abs(z.real) <= _AXIS_NOISE * abs(z):
        return complex(0.0, z.imag)
    return z


def _compute_damping_ratio(z: complex) -> float:
    """Per-mode damping ratio.

    Convention used by power-systems texts (and ANDES's own
    plotting): ``zeta = -Re(z) / |z|``. A zero eigenvalue has none by
    that formula and is given 1.0: it neither oscillates nor grows, so
    it is listed with the real modes that decay and not with the poorly
    damped ones. NaN guards collapse to 0.0 so the wire payload never
    carries non-finite floats (which would fail JSON serialization in
    the routes layer).
    """
    magnitude = (z.real * z.real + z.imag * z.imag) ** 0.5
    if magnitude == 0.0:
        return 1.0
    if not math.isfinite(magnitude):
        return 0.0
    zeta = -z.real / magnitude
    if not math.isfinite(zeta):
        return 0.0
    # ``+ 0.0`` turns a negative zero (the ratio of an eigenvalue on the axis) into zero.
    return float(zeta + 0.0)


def _compute_frequency_hz(z: complex) -> float:
    """Per-mode oscillation frequency in Hz.

    ``f = |Im(z)| / (2*pi)``. Returns 0 for purely real eigenvalues.
    """
    return float(abs(z.imag) / (2.0 * math.pi))


def eigen_decomposition(matrix: Any) -> tuple[list[complex], list[list[float]]]:
    """The eigenvalues of a reduced state matrix and their participation
    factors, from one decomposition, so row ``i`` of the factors belongs to
    eigenvalue ``i``.

    This is the pairing ANDES has: its ``calc_pfactor`` answers ``mu`` and the
    factors from the same ``eig`` call, and the ANDES engine reports that
    ``mu``. An engine that takes its eigenvalues from elsewhere (PSID's own
    list) and its factors from a decomposition of its own pairs them by
    position, and two solvers need not list the modes in one order.

    ``matrix`` is a square numpy array. The factors are ANDES's arithmetic, as
    :func:`participation_factors` documents.
    """
    values, factors = _decompose(matrix)
    return [complex(z) for z in values], factors


def participation_factors(matrix: Any) -> list[list[float]]:
    """The participation factors of a reduced state matrix, one row per mode.

    ``matrix`` is a square numpy array. The arithmetic is ANDES's own
    ``calc_pfactor`` (``andes/routines/eig.py``): with ``N`` the right
    eigenvectors of the matrix (``numpy.linalg.eig``, one column per mode) and
    ``W`` the left eigenvectors (the transpose of the inverse of ``N``, from
    ``W.T @ N = I``), ``|W| * |N|`` is transposed and each of its columns is
    divided by one mode's total and rounded to 5 decimals, exactly as ANDES
    does, so the two engines' factors are the same numbers for the same
    matrix. The answer is one row per mode, each row one factor per state, in
    the matrix's order, the modes in the order ``numpy.linalg.eig`` gives them
    (pair them with the eigenvalues of :func:`eigen_decomposition`).
    """
    return _decompose(matrix)[1]


def _decompose(matrix: Any) -> tuple[Any, list[list[float]]]:
    """``numpy.linalg.eig`` of ``matrix`` and ANDES's participation factors of it."""
    import numpy as np

    mu, right = np.linalg.eig(matrix)
    n_state = len(mu)
    if n_state == 0:
        return mu, []
    left = np.linalg.solve(right, np.eye(n_state)).T
    pfactor = np.abs(left) * np.abs(right)
    column_sums = np.ones(n_state) @ pfactor
    pfactor = pfactor.T
    for item in range(n_state):
        pfactor[:, item] /= column_sums[item]
    pfactor = np.round(pfactor, 5)
    return mu, [[float(v) for v in row] for row in pfactor]
