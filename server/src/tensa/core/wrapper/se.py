"""Static state estimation."""

from __future__ import annotations

from tensa.core.errors import SeNonConvergentError, SePrerequisiteError, SeUnderDeterminedError
from tensa.core.se_result import MeasurementsGenerated, SeResult
from tensa.core.wrapper.base import WrapperBase


class SeMixin(WrapperBase):
    """Static state estimation: the measurement set and the WLS run on it."""

    def generate_measurements_from_pflow(
        self, *, noise_seed: int | None = None
    ) -> MeasurementsGenerated:
        """Generate the default measurement set from the PF solution.

        Builds a fresh ``andes.se.Measurements`` object, populates it with
        the SE.run default of ``add_bus_voltage`` + ``add_bus_injection``,
        then calls ``generate_from_pflow(seed=noise_seed)`` to populate
        the ``z`` array with ``h(x_pflow) + noise``. The substrate
        retains the populated object on ``self._se_measurements`` so a
        subsequent ``run_se()`` call uses it without regenerating noise
        (the user might want to compare WLS vs LAV against the same
        measurement set, which requires a stable ``z``).

        Substrate-side gate (per Unit 1a spike): ANDES's ``SE.init`` only
        logs an error when ``ss.PFlow.converged`` is False before
        returning False. We MUST gate independently and raise
        :class:`SePrerequisiteError` for a clean 409 — same discipline
        as :meth:`run_eig` and :meth:`run_cpf`.

        Note: ANDES's ``SE.init`` (called from ``run``) injects an
        ``_ensure_angle_reference`` pseudo-measurement at the slack bus
        if no angle measurement exists. The substrate's
        ``generate_measurements_from_pflow`` does NOT call ``SE.init`` —
        the angle-reference is added on the first ``run_se`` call. So the
        ``count`` returned here is the user-visible measurement count
        (without the pseudo-measurement); the eventual residual array
        will be one longer per island.
        """
        from andes.se import Measurements  # heavy import — kept lazy

        ss = self._require_loaded()
        self._ensure_setup()
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise SePrerequisiteError(
                "Run PFlow first; SE requires a converged operating point."
            )

        m = Measurements(ss)
        # Default measurement set mirrors ANDES's own
        # ``SE._default_measurements`` (routines/se.py:272) — bus voltages
        # at sigma=0.01 plus bus injections at sigma_p=0.02 / sigma_q=0.03.
        m.add_bus_voltage(sigma=0.01)
        m.add_bus_injection(sigma_p=0.02, sigma_q=0.03)
        try:
            m.generate_from_pflow(seed=noise_seed)
        except Exception as exc:  # noqa: BLE001
            raise SeNonConvergentError(
                f"generate_from_pflow failed: {exc}"
            ) from exc

        self._se_measurements = m
        return MeasurementsGenerated(count=int(m.nm))

    def run_se(self) -> SeResult:
        """Run static state estimation against the substrate's
        in-memory measurement set — Unit 13.

        Pre-conditions (raise :class:`SePrerequisiteError` → 409):

        - ``ss.PFlow.converged is True`` — independent gate (ANDES's own
          ``SE.init`` only logs an error before returning False).
        - ``self._se_measurements is not None`` — the user must call
          ``generate_measurements_from_pflow`` first. The route layer
          surfaces this with "Generate measurements first".

        Failure modes:

        - Under-determined (``measurement_count < 2 * Bus.n``): raises
          :class:`SeUnderDeterminedError` → 422 BEFORE the WLS iteration
          runs (saves the iteration cost on a guaranteed-failure case).
          Mirrors ANDES's chi-squared ``dof <= 0`` detection.
        - WLS Gauss-Newton non-convergent (e.g., bad initial guess,
          exceeded ``max_iter``): raises :class:`SeNonConvergentError`
          → 422 with the iteration count.
        - Singular gain matrix at iteration 0: raises
          :class:`SeUnderDeterminedError` (the substrate maps both
          observability failures to the same error so the UI surfaces
          "add more measurements").

        Returns a :class:`SeResult` with per-measurement residuals and
        the indices of measurements whose normalised residual exceeds
        3-sigma (candidate bad-data points the UI highlights).
        """
        ss = self._require_loaded()
        self._ensure_setup()
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise SePrerequisiteError(
                "Run PFlow first; SE requires a converged operating point."
            )
        if self._se_measurements is None:
            raise SePrerequisiteError(
                "Generate measurements first, then run SE "
                "(POST /sessions/{id}/se/measurements/generate)."
            )

        # Pre-check observability: WLS needs at least 2*nb measurements
        # for a square+ system. ANDES's ``_ensure_angle_reference``
        # contributes one pseudo-measurement per island during init, so
        # the effective lower bound is ``2*nb - n_islands``. The check
        # below uses ``2 * nb`` as the conservative threshold, matching
        # what the chi-squared dof test (``dof <= 0``) would report.
        try:
            nb = int(ss.Bus.n)
        except (AttributeError, TypeError):
            nb = 0
        m = self._se_measurements
        try:
            nm_user = int(m.nm)  # type: ignore[attr-defined]
        except (AttributeError, TypeError):
            nm_user = 0
        # +1 accounts for the typical single-island angle reference that
        # ``SE.init`` will inject. Even with that, if 2*nb > nm + 1 the
        # system is under-determined.
        if nb > 0 and (nm_user + 1) < 2 * nb:
            raise SeUnderDeterminedError(
                f"insufficient measurements: {nm_user} provided, "
                f"need at least {2 * nb - 1} for a system of "
                f"{nb} buses (2*nb - 1 angle reference). Add more "
                "measurements via Measurements.add(...) and re-run."
            )

        try:
            ok = bool(ss.SE.run(measurements=m))
        except SePrerequisiteError:
            raise
        except SeUnderDeterminedError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SeNonConvergentError(
                f"State estimation failed: {exc}"
            ) from exc

        result_dict = getattr(ss.SE, "result", None) or {}
        n_iter = int(result_dict.get("n_iter", 0) or 0)
        J = float(result_dict.get("J", 0.0) or 0.0)
        residuals_arr = result_dict.get("residuals")
        residuals_list: list[float] = []
        if residuals_arr is not None:
            try:
                residuals_list = [float(x) for x in residuals_arr]
            except (TypeError, ValueError):
                residuals_list = []

        # Detect singular-gain (under-determined) post-hoc: the WLS
        # algorithm returns ``converged=False`` at ``n_iter=1`` with
        # ``residuals`` populated, and the chi-squared dof check trips.
        # We surface this as SeUnderDeterminedError so the route maps to
        # 422 with an actionable message rather than the generic
        # non-convergent error.
        finalized_m = ss.SE.measurements
        finalized_count = (
            int(finalized_m.nm) if finalized_m is not None else len(residuals_list)
        )
        if not ok and finalized_count < 2 * max(nb, 1):
            raise SeUnderDeterminedError(
                f"SE gain matrix is singular: {finalized_count} "
                f"measurements is below the {2 * nb} state count "
                f"({nb} buses × 2 = {2 * nb} states)."
            )

        if not ok:
            raise SeNonConvergentError(
                f"WLS did not converge after {n_iter} iterations "
                f"(J={J:.6g}); widen tol/max_iter or check measurements."
            )

        # Compute flagged indices: |r_i| / sigma_i > 3 is the canonical
        # 3-sigma bad-data threshold. ``ss.SE.measurements.sigma`` is
        # populated by ``Measurements.finalize`` (called from
        # ``SE.init``).
        flagged: list[int] = []
        sigma_arr = getattr(finalized_m, "sigma", None)
        if sigma_arr is not None:
            try:
                for i, r in enumerate(residuals_list):
                    s = float(sigma_arr[i])
                    if s > 0 and abs(r) / s > 3.0:
                        flagged.append(i)
            except (IndexError, TypeError, ValueError):
                # Defensive: shape mismatch falls back to empty flagged
                # list. The UI then renders the histogram without
                # highlighting.
                pass

        return SeResult(
            converged=True,
            iterations=n_iter,
            mismatch=J,
            residuals=residuals_list,
            measurement_count=finalized_count,
            flagged_indices=flagged,
        )
