"""Relative reference frames for angles (section 6.5 of ``design/multiengine/spec.md``).

"No engine gives the two relative quantities; they are arithmetic on the
engine's values, done once in a shared module (``engines/frames.py``) for both
engines, so the definition cannot drift." This is that module. It implements
two rows of the section 6.5 quantity catalogue:

- ``angle_rel``, bus, rad: "minus the reference bus's angle at the same
  instant".
- ``rotor_angle_rel``, generating unit, rad: "minus the inertia-weighted mean
  angle of the machines in service at the same instant".

Both relative quantities are plain differences and are NOT wrapped: a rotor
angle that runs away past pi is how a loss of synchronism shows, and wrapping
would hide it. The module also offers :func:`wrap_angle`, which reduces an
angle into ``[-pi, pi)``; the code that later compares two engines' angles
applies it to the difference between engines, never here.

The module imports numpy only, no engine.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

__all__ = ["WRAP_PERIOD", "angle_rel", "rotor_angle_rel", "wrap_angle"]

WRAP_PERIOD: float = 2.0 * np.pi


def wrap_angle(angle: NDArray[np.float64]) -> NDArray[np.float64]:
    """Reduce every value of ``angle`` into the half-open interval ``[-pi, pi)``.

    Returns a new array of the same shape; the input is not modified. A 0-d
    input returns a 0-d array. NaN stays NaN and ``inf`` becomes NaN (numpy's
    remainder propagates them); no error is raised for non-finite input.
    Values already in the interval are returned unchanged within float
    rounding; a value of exactly ``pi`` maps to ``-pi``.

    The relative quantities of this module are not wrapped. This function is
    for the code that later compares two engines' angles, applied there to the
    difference between engines.
    """
    return (np.asarray(angle, dtype=np.float64) + np.pi) % WRAP_PERIOD - np.pi


def angle_rel(
    angles: NDArray[np.float64],
    reference_index: int,
) -> NDArray[np.float64]:
    """Every bus's angle minus the reference bus's angle at the same instant.

    ``angles`` has shape ``(n_steps, n_buses)``: row ``t`` holds every bus's
    angle at one instant, in radians, as the engine reports it (section 6.5,
    the ``angle`` row). ``reference_index`` is the column of the reference
    bus. The subtraction is per row, so the reference is taken at the same
    instant as each value. The result is a new array of the same shape and is
    NOT wrapped (see the module docstring). The reference bus's own column is
    exactly ``0.0`` in every row where it is finite.

    NaN in any column propagates to that column's result only; NaN in the
    reference column propagates to the whole row.

    Raises:
        ValueError: ``angles`` is not 2-D.
        IndexError: ``reference_index`` is outside ``[0, n_buses)`` (numpy's
            own, from the column gather; the function does not pre-check).
    """
    angles = np.asarray(angles, dtype=np.float64)
    if angles.ndim != 2:
        raise ValueError(
            f"angles must be a 2-D array of (n_steps, n_buses); got shape {angles.shape}"
        )
    return angles - angles[:, [reference_index]]


def rotor_angle_rel(
    angles: NDArray[np.float64],
    weights: NDArray[np.float64],
    in_service: NDArray[np.bool_],
) -> NDArray[np.float64]:
    """Every machine's angle minus the inertia-weighted mean angle of the
    machines in service at the same instant.

    ``angles`` has shape ``(n_steps, n_machines)``, radians, one column per
    machine, as the engine reports it (section 6.5, the ``rotor_angle`` row).
    ``in_service`` has the same shape, dtype bool: ``in_service[t, m]`` is
    whether machine ``m`` is in service at instant ``t``.

    ``weights`` has shape ``(n_machines,)`` and is the weight of each machine
    in the mean, computed by the caller: the machine's inertia on a common
    base, its ``H`` in seconds (on the machine's own MVA base) times that MVA
    base. Two machines with the same ``H`` and different MVA bases do not
    weigh the same.

    The mean at instant ``t`` is over the machines in service at ``t`` only::

        mean[t] = sum(weights[m] * angles[t, m] for m where in_service[t, m])
                  / sum(weights[m] for m where in_service[t, m])

    A tripped machine's weight leaves the mean from the instant it trips,
    because ``in_service[t, m]`` is ``False`` from that instant, not because
    the caller edits the weights. The machine's own relative angle keeps being
    computed after the trip (its angle minus the mean of the machines still in
    service); the function does not blank it, and callers that want a gap mask
    it themselves.

    The result is a new array of shape ``(n_steps, n_machines)`` and is NOT
    wrapped (see the module docstring). A row with no machine in service, or
    whose in-service machines all weigh zero, yields NaN across the row (the
    mean is a 0/0, computed under ``np.errstate(invalid="ignore",
    divide="ignore")``; no warning escapes). A machine with weight ``0.0``
    contributes nothing to the mean's numerator or denominator. Negative
    weights are not validated. Inputs are never modified.

    Raises:
        ValueError: ``angles`` is not 2-D, ``weights`` does not have one entry
            per machine, ``in_service`` does not match the angles shape, or
            ``in_service`` is not a bool array.
    """
    angles = np.asarray(angles, dtype=np.float64)
    if angles.ndim != 2:
        raise ValueError(
            f"angles must be a 2-D array of (n_steps, n_machines); got shape {angles.shape}"
        )
    weights = np.asarray(weights, dtype=np.float64)
    if weights.shape != (angles.shape[1],):
        raise ValueError(
            f"weights must have one entry per machine; got shape {weights.shape} "
            f"for {angles.shape[1]} machines"
        )
    in_service = np.asarray(in_service)
    if in_service.shape != angles.shape:
        raise ValueError(
            f"in_service must match the angles shape; got {in_service.shape} "
            f"for {angles.shape}"
        )
    if in_service.dtype != np.bool_:
        raise ValueError(f"in_service must be a bool array; got dtype {in_service.dtype}")

    active_weights: NDArray[np.float64] = np.where(in_service, weights[None, :], 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        denominator: NDArray[np.float64] = active_weights.sum(axis=1)
        numerator: NDArray[np.float64] = (angles * active_weights).sum(axis=1)
        mean: NDArray[np.float64] = numerator / denominator
    result: NDArray[np.float64] = angles - mean[:, None]
    return result
