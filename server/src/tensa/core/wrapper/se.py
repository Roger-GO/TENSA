"""Static state estimation."""

from __future__ import annotations

import math

from tensa.core.errors import (
    SeNonConvergentError,
    SeOptionError,
    SePrerequisiteError,
    SeUnderDeterminedError,
    short_repr,
)
from tensa.core.se_result import MeasurementsGenerated, SeResult
from tensa.core.wrapper.base import WrapperBase


class SeMixin(WrapperBase):
    """Static state estimation: the measurement set and the WLS or LAV run on it."""

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

    def run_se(
        self,
        *,
        algorithm: str | None = None,
        tol: float | None = None,
        max_iter: int | None = None,
        noise_seed: int | None = None,
    ) -> SeResult:
        """Run static state estimation against the substrate's
        in-memory measurement set — Unit 13.

        Per-run options (all optional; a call that names none behaves
        exactly as before):

        - ``algorithm``: ``"wls"`` (default, weighted least squares via
          Gauss-Newton) or ``"lav"`` (least absolute value via
          iteratively reweighted least squares, robust to gross
          measurement errors; it converges linearly and often needs more
          than ANDES's 100 iterations once a measurement is bad).
          Case-insensitive.
        - ``tol`` / ``max_iter``: convergence tolerance and iteration
          limit for this run only, written to ``ss.SE.config`` for the
          run and put back afterwards (the ``pflow_options`` pattern).
        - ``noise_seed``: when set, this run's measurement values are
          drawn afresh from the power-flow solution with this seed, over
          the cached set's measurements and sigmas, and the cached values
          are put back afterwards, so the same seed gives the same run and
          the next run without one sees the generate step's draw.
          ``None`` runs on the cached values.

        A bad option raises :class:`SeOptionError` → 422 before any
        ANDES call; the worker does not rely on the REST body's checks.

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
        - Gauss-Newton non-convergent (e.g., bad initial guess,
          exceeded ``max_iter``): raises :class:`SeNonConvergentError`
          → 422 with the iteration count.
        - Singular gain matrix at iteration 0: raises
          :class:`SeUnderDeterminedError` (the substrate maps both
          observability failures to the same error so the UI surfaces
          "add more measurements").

        Returns a :class:`SeResult` with per-measurement residuals, the
        indices of measurements whose normalised residual exceeds
        3-sigma (candidate bad-data points the UI highlights), the
        settings the run used and, for WLS, the chi-squared bad-data
        test on the objective ``J``.
        """
        if algorithm is not None:
            if not isinstance(algorithm, str) or algorithm.lower() not in ("wls", "lav"):
                raise SeOptionError(
                    f"unknown SE algorithm {short_repr(algorithm)}; "
                    "expected 'wls' or 'lav'"
                )
            algorithm = algorithm.lower()
        else:
            algorithm = "wls"
        if tol is not None:
            tol_ok = False
            if isinstance(tol, int | float) and not isinstance(tol, bool):
                tol = float(tol)
                tol_ok = math.isfinite(tol) and tol > 0
            if not tol_ok:
                raise SeOptionError(
                    f"tol must be a positive float, got {short_repr(tol)}"
                )
        if max_iter is not None and (
            isinstance(max_iter, bool)
            or not isinstance(max_iter, int)
            or max_iter < 1
        ):
            raise SeOptionError(
                f"max_iter must be an integer >= 1, got {short_repr(max_iter)}"
            )
        if noise_seed is not None and (
            isinstance(noise_seed, bool)
            or not isinstance(noise_seed, int)
            or noise_seed < 0
        ):
            raise SeOptionError(
                f"noise_seed must be a non-negative integer, got {short_repr(noise_seed)}"
            )

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

        from andes.se.algorithms import lav, wls  # heavy import — kept lazy

        saved_z = None
        # tol and max_iter live on ``ss.SE.config`` and ``SE.run`` reads them
        # when it starts: snapshot, apply the overrides for this run, and
        # restore in a ``finally`` so a failed run also puts them back (the
        # ``pflow_options`` pattern).
        saved_tol = ss.SE.config.tol
        saved_max_iter = ss.SE.config.max_iter
        if tol is not None:
            ss.SE.config.tol = tol
        if max_iter is not None:
            ss.SE.config.max_iter = max_iter
        try:
            # A seeded run draws its own noise and leaves the cached set as
            # the generate step left it. ``SE.init`` adds the angle-reference
            # pseudo-measurement on the first run (with the power-flow angle
            # as its value), so it runs first: the draw then covers the
            # structure the solver sees, and the values saved for putting
            # back are ones the next run can use. ``generate_from_pflow``
            # draws from its own ``numpy.random.default_rng(seed)``, never
            # from NumPy's global state.
            if noise_seed is not None:
                ss.SE.init(measurements=m)
                saved_z = m.z.copy()  # type: ignore[attr-defined]
                m.generate_from_pflow(seed=noise_seed)  # type: ignore[attr-defined]
            # The effective values the solver sees, read back while the
            # overrides are applied so the result reports them.
            effective_tol = float(ss.SE.config.tol)
            effective_max_iter = int(ss.SE.config.max_iter)
            # Pass the algorithm even for WLS so ``ss.SE._algorithm`` is
            # always set for the chi-squared test.
            ok = bool(
                ss.SE.run(measurements=m, algorithm=wls if algorithm == "wls" else lav)
            )
        except SePrerequisiteError:
            raise
        except SeUnderDeterminedError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise SeNonConvergentError(
                f"State estimation failed: {exc}"
            ) from exc
        finally:
            ss.SE.config.tol = saved_tol
            ss.SE.config.max_iter = saved_max_iter
            if saved_z is not None:
                m.z = saved_z  # type: ignore[attr-defined]

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
                f"{algorithm.upper()} did not converge after {n_iter} iterations "
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

        # The chi-squared test on J is only valid for WLS; for LAV ANDES
        # logs a warning and returns a meaningless (False, J, inf, 0), so
        # it is not called and the result carries ``chi_squared=None``.
        # ANDES takes ``dof = nm - 2 * nb`` with the angle reference counted
        # in ``nm``; with no redundancy (``dof <= 0``) it answers an infinite
        # threshold, which is no test either.
        chi_squared: dict[str, float | int | bool] | None = None
        if algorithm == "wls":
            passed, J_test, threshold, dof = ss.SE.chi_squared_test(confidence=0.95)
            if int(dof) > 0 and math.isfinite(float(threshold)):
                chi_squared = {
                    "passed": bool(passed),
                    "J": float(J_test),
                    "threshold": float(threshold),
                    "dof": int(dof),
                    "confidence": 0.95,
                }

        return SeResult(
            converged=True,
            iterations=n_iter,
            mismatch=J,
            residuals=residuals_list,
            measurement_count=finalized_count,
            flagged_indices=flagged,
            algorithm=algorithm,
            settings={
                "tol": effective_tol,
                "max_iter": effective_max_iter,
                "noise_seed": noise_seed,
            },
            chi_squared=chi_squared,
        )
