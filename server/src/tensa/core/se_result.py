"""SE (state estimation) result dataclasses for Unit 13 of the v2.0 plan.

Wraps :meth:`andes.routines.se.SE.run` outputs. Returned by
:meth:`tensa.core.wrapper.Wrapper.run_se` and
:meth:`tensa.core.wrapper.Wrapper.generate_measurements_from_pflow`,
serialized over the worker Pipe before crossing the FastAPI boundary.

Per Unit 1a spike (``docs/spikes/2026-05-09-andes-routine-surface-spike.md``):

- ``SE.run(measurements=m)`` returns ``True`` on convergence; the result
  dict on ``ss.SE.result`` carries ``x_est``, ``converged``, ``n_iter``,
  ``residuals`` (shape = number of measurements), ``J`` (objective).
- Substrate gates on ``ss.PFlow.converged`` independently — ANDES's own
  ``SE.init`` only logs an error before returning False (verified on
  stock IEEE 14).
- A successful ``SE.run`` requires a prior ``Measurements`` object whose
  ``z`` array was populated via ``generate_from_pflow``. The substrate
  splits this into two endpoints (generate, then run) so the UI can
  show the measurement count before committing the SE iteration cost.
- Under-determined (nm < 2*nb) SE runs return ``False`` with a singular
  gain matrix logged at iteration 0; the residual array still has
  length nm. The substrate maps this to ``SeUnderDeterminedError`` via
  the ``chi_squared_test`` ``dof <= 0`` branch (or directly via
  ``measurements.nm < 2 * Bus.n``).
- Residual flagging: by SE convention, a normalised residual
  ``|r_i| / sigma_i`` exceeding ~3 (3 sigma) flags the measurement as a
  candidate bad-data point. The wrapper computes the indices client-side
  so the UI can highlight bars without re-deriving the threshold.
"""

from __future__ import annotations

import dataclasses
from dataclasses import field


@dataclasses.dataclass(frozen=True)
class SeResult:
    """State estimation result returned by ``Wrapper.run_se``.

    Field semantics:

    - ``converged``: ``True`` when ANDES's ``SE.run`` returned True
      (Gauss-Newton residual fell below ``config.tol`` within
      ``config.max_iter``).
    - ``iterations``: ``ss.SE.result['n_iter']`` (1-indexed inside ANDES).
    - ``mismatch``: ``ss.SE.result['J']`` — the WLS objective value
      ``sum(w * r^2)``. Smaller is better; the chi-squared test on
      ``J`` flags whether the measurement set fits the model.
    - ``residuals``: per-measurement residuals ``z - h(x_est)``. Length
      equals the measurement count returned by
      :class:`MeasurementsGenerated`.
    - ``measurement_count``: ``len(measurements._models)``. Echoed into
      the wire payload so the UI doesn't have to remember the prior
      generate-measurements response.
    - ``flagged_indices``: indices into ``residuals`` whose normalised
      residual ``|r_i| / sigma_i`` exceeds 3. These are candidate
      bad-data points — the UI highlights the bars in the residual
      histogram.
    - ``algorithm``: the estimator the run used, normalised lowercase
      (``"wls"`` or ``"lav"``).
    - ``settings``: what the run used: ``tol``, ``max_iter`` (the
      effective values the solver saw, after any per-run override) and
      ``noise_seed`` (the seed this run's measurement noise was drawn
      with, or ``None`` when the run used the generate step's draw).
    - ``chi_squared``: for WLS, the chi-squared bad-data test on the
      objective ``J``: ``passed``, ``J``, ``threshold``, ``dof`` and the
      ``confidence`` the threshold was taken at. ``None`` for LAV, where
      the test is not valid, and when the set has no redundancy
      (``dof <= 0``).

    Note on ``mismatch``: for LAV, ``J`` is the LAV objective
    ``sum(|r| / sigma)``, not the weighted sum of squares.
    """

    converged: bool
    iterations: int
    mismatch: float
    residuals: list[float]
    measurement_count: int
    flagged_indices: list[int]
    algorithm: str = "wls"
    settings: dict[str, float | int | None] = field(default_factory=dict)
    chi_squared: dict[str, float | int | bool] | None = None


@dataclasses.dataclass(frozen=True)
class MeasurementsGenerated:
    """Result of ``Wrapper.generate_measurements_from_pflow``.

    - ``count``: number of scalar measurements in the substrate's
      ``Measurements`` object after default generation. Includes the
      ``_ensure_angle_reference`` pseudo-measurement that ANDES's
      ``SE.init`` adds automatically (one per island), so the count
      matches what the eventual ``SeResult.residuals`` length will be.
    """

    count: int


__all__ = ["MeasurementsGenerated", "SeResult"]
