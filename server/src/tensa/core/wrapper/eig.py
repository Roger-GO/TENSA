"""Eigenvalue analysis."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

from tensa.core.edit_log import device_position
from tensa.core.eig_result import ComplexNumber, EigResult, EigSweepPoint, EigSweepResult
from tensa.core.errors import EigComputationError, EigPrerequisiteError, ElementNotFoundError
from tensa.core.pflow_options import pflow_options_applied
from tensa.core.wrapper.base import _sanitize_message
from tensa.core.wrapper.case import CaseMixin
from tensa.core.wrapper.pflow import solve_pflow

if TYPE_CHECKING:
    from andes.system import System

    from tensa.core.pflow_options import PflowSettings


class EigMixin(CaseMixin):
    """Eigenvalue analysis: the run, one mode's participation, the state matrix,
    and a sweep of one parameter (root loci data)."""

    def run_eig(self) -> EigResult:
        """Run eigenvalue analysis (small-signal stability) — Unit 6.

        Substrate-side gate (per Unit 1a spike): ``EIG._pre_check`` only
        warns on non-converged PFlow but falls through to ``TDS.init()``
        and crashes. We MUST gate on ``ss.PFlow.converged is True``
        ourselves and raise :class:`EigPrerequisiteError` otherwise.

        Side effects (documented for the UI banner):

        - ``EIG.run()`` sets ``TDS.initialized=True`` and advances
          ``dae.t`` from ``-1.0`` to ``0.0``. The result carries
          ``tds_initialized=True`` so the UI can surface a "EIG
          initialised the dynamic state" info banner per the plan's
          Approach addendum.
        - The reduced state count (``len(EIG.mu)``) is what we report,
          not ``dae.n``. Stock IEEE 14 → 0; full IEEE 14 + dyr → 62;
          kundur_full → 52.
        """
        ss = self._require_loaded()
        self._ensure_setup()
        # Independent PF gate — ANDES's own check is unsafe (see docstring).
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise EigPrerequisiteError(
                "Run PFlow first; EIG requires a converged operating point."
            )

        try:
            ss.EIG.run()
        except EigPrerequisiteError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise EigComputationError(
                f"Eigenvalue analysis failed: {exc}"
            ) from exc

        mu = getattr(ss.EIG, "mu", None)
        zero_tol = _zero_tolerance(ss)
        eigenvalues: list[ComplexNumber] = []
        damping_ratios: list[float] = []
        frequencies_hz: list[float] = []
        if mu is not None:
            try:
                mu_iter = list(mu)
            except TypeError:
                mu_iter = []
            for z in mu_iter:
                z_complex = _settle_axis(_settle_zero(complex(z), zero_tol))
                eigenvalues.append(ComplexNumber.from_complex(z_complex))
                damping_ratios.append(_compute_damping_ratio(z_complex))
                frequencies_hz.append(_compute_frequency_hz(z_complex))

        mode_count = len(eigenvalues)
        # Reduced state names — derived from the shape of ``EIG.As``
        # (which is sized identically to ``EIG.mu``) by indexing into
        # ``ss.dae.x_name`` when the lengths match. When they don't
        # (folded states), fall back to generic ``state_<i>`` labels so
        # the UI table always has something to render.
        state_names = _eig_state_names(ss, mode_count)
        return EigResult(
            eigenvalues=eigenvalues,
            damping_ratios=damping_ratios,
            frequencies_hz=frequencies_hz,
            mode_count=mode_count,
            state_count=mode_count,
            state_names=state_names,
            tds_initialized=bool(getattr(ss.TDS, "initialized", False)),
        )

    def eig_participation(self, mode_idx: int) -> dict[str, object]:
        """Return per-mode participation factors as a dict suitable for
        the routes layer to ship verbatim.

        ``EIG.pfactors`` is a 2-D ``np.ndarray`` of shape
        ``[mode_count, state_count]`` (computed inside ``EIG.run()``).
        Per the spike, there is no per-mode lazy slicing API in ANDES —
        we just slice the in-memory matrix. Substrate-side gating:

        - Returns 404 (via :class:`ElementNotFoundError`) if
          ``mode_idx`` is out of range OR EIG has not been run yet
          (``EIG.pfactors`` would be ``None``).
        """
        ss = self._require_loaded()
        pfactors = getattr(ss.EIG, "pfactors", None)
        if pfactors is None:
            raise EigPrerequisiteError(
                "EIG has not been run on this session; run /eig first"
            )
        try:
            n_modes = int(pfactors.shape[0])
        except (AttributeError, IndexError, TypeError) as exc:
            raise EigComputationError(
                f"EIG.pfactors has unexpected shape: {exc}"
            ) from exc
        if mode_idx < 0 or mode_idx >= n_modes:
            raise ElementNotFoundError(
                f"mode_idx {mode_idx} out of range [0, {n_modes - 1}]"
            )
        try:
            row = pfactors[mode_idx]
        except (IndexError, TypeError) as exc:
            raise EigComputationError(
                f"failed to slice EIG.pfactors[{mode_idx}]: {exc}"
            ) from exc

        # Coerce row to a Python list of floats (pfactors are real-valued
        # magnitudes by ANDES convention — see ``calc_pfactor``).
        try:
            row_list = [float(v) for v in row]
        except (TypeError, ValueError) as exc:
            raise EigComputationError(
                f"failed to coerce participation row: {exc}"
            ) from exc

        state_names = _eig_state_names(ss, len(row_list))
        participation = [
            {"state_name": name, "factor": factor}
            for name, factor in zip(state_names, row_list, strict=False)
        ]
        return {"mode_idx": mode_idx, "participation": participation}

    def run_eig_sweep(
        self, model: str, idx: str, param: str, values: list[float]
    ) -> EigSweepResult:
        """The eigenvalues at each of a list of values of one parameter of one
        device (root loci data).

        Each point is an eigenvalue analysis of a System of its own: the case
        file, or an empty System, with the session's edits applied
        (:meth:`_build_system`, the same System an undo rebuilds), the
        parameter set to the value before ``setup()``, the power flow solved
        with the settings of the session's last one, and ``EIG.run()``. So a
        point is what :meth:`run_eig` gives a session that opened the case with
        that value, and the session's own System is never touched: its
        parameters, its dynamic state, its ``EIG`` results and whether a power
        flow can run on it again are what they were, whether the sweep ends
        well or not. The disturbances the session holds for a time-domain run
        are not added: the eigenvalues are taken at the operating point, before
        any of them acts.

        Changing the parameter on the session's System and taking the state
        matrix again, as ANDES's ``EIG.sweep`` does, does not give that.
        ``TDS.init()`` returns at once on a System whose dynamic state is
        initialised (ANDES 2.0.0), so after the first point nothing that ANDES
        works out from a parameter at ``setup()`` or at initialisation follows
        the new value: the time constants of the states (``dae.Tf``, where a
        machine's ``M`` goes), the services, and the parameters other models
        copy from it (``ExtParam``). On IEEE 14 that sweep gives the second
        value of a ``GENROU`` ``M`` the eigenvalues of the first.

        A value is written as the case file holds the parameter, and as an
        edit of the element writes it: for a per-unit parameter, on the
        device's own base (``vin`` in ANDES), not on the system base.

        Raises ``EigPrerequisiteError`` without a converged power flow on the
        session, ``ElementNotFoundError`` for a model, a device or a parameter
        the case does not have (a parameter is a ``NumParam`` of the model that
        is not an ``ExtParam``, as for an edit), and ``EigComputationError`` for
        values that are not a list of 1 to ``_SWEEP_MAX_POINTS`` finite numbers
        and for a point that fails (its System does not set up, its power flow
        does not converge, the eigenvalue routine fails, or it has another
        number of eigenvalues than the first point). Eigenvalue order is not
        comparable across points (ANDES's ``plot_root_loci`` says so), so each
        point carries its own list and no mode is tracked across the sweep.
        """
        ss = self._require_loaded()
        # The same gate as run_eig's, without setting the System up for it.
        solved = bool(getattr(ss, "is_setup", False)) and bool(
            getattr(ss.PFlow, "converged", False)
        )
        if not solved:
            raise EigPrerequisiteError(
                "Run PFlow first; EIG requires a converged operating point."
            )
        _check_sweep_target(ss, model, idx, param)
        checked = _check_sweep_values(values)
        settings = self._sweep_pflow_settings(ss)
        zero_tol = _zero_tolerance(ss)

        points: list[EigSweepPoint] = []
        for count, value in enumerate(checked):
            try:
                mu = self._sweep_point(model, idx, param, value, settings)
            except EigComputationError as exc:
                raise EigComputationError(
                    f"eigenvalue sweep failed at value {value!r} (point {count}): {exc}"
                ) from exc
            except Exception as exc:  # noqa: BLE001
                raise EigComputationError(
                    f"eigenvalue sweep failed at value {value!r} (point {count}): "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
            point = _sweep_point_result(value, mu, zero_tol)
            if points and len(point.eigenvalues) != len(points[0].eigenvalues):
                raise EigComputationError(
                    f"eigenvalue count changed at point {count} (value {value!r}): "
                    f"{len(point.eigenvalues)} modes against "
                    f"{len(points[0].eigenvalues)} at the first point"
                )
            points.append(point)

        return EigSweepResult(
            model=model,
            idx=idx,
            param=param,
            points=points,
            mode_count=len(points[0].eigenvalues),
            tds_initialized=bool(getattr(ss.TDS, "initialized", False)),
        )

    def _sweep_pflow_settings(self, ss: System) -> PflowSettings | None:
        """The settings of the power flow that gave ``ss`` its operating point,
        or ``None`` when it was not :meth:`run_pflow` (a time-domain run solves
        one with the System's own settings)."""
        remembered = self._pflow_settings
        if remembered is None or remembered[0]() is not ss:
            return None
        return remembered[1]

    def _sweep_point(
        self,
        model: str,
        idx: str,
        param: str,
        value: float,
        settings: PflowSettings | None,
    ) -> Any:
        """The eigenvalues (``EIG.mu``) of a System of its own with ``param`` of
        ``model`` ``idx`` at ``value``. Raises ``EigComputationError`` for a
        System that does not set up, a power flow that does not converge or an
        eigenvalue routine that fails."""
        fresh = self._build_system(self._edit_log)
        model_obj = fresh.models[model]
        position = device_position(model_obj, idx)
        if position is None:  # the session's System has it, and is built the same way
            raise EigComputationError(f"{model} {idx!r} is not in the rebuilt system")
        getattr(model_obj, param).v[position] = value
        if not fresh.setup():
            raise EigComputationError("the system did not set up")
        with pflow_options_applied(
            fresh,
            tolerance=None if settings is None else settings.tolerance,
            max_iterations=None if settings is None else settings.max_iterations,
            flat_start=None if settings is None else settings.flat_start,
            enforce_q_limits=None if settings is None else settings.enforce_q_limits,
            method=None if settings is None else settings.method,
            n_factorize=None if settings is None else settings.n_factorize,
            linesearch=None if settings is None else settings.linesearch,
        ) as applied:
            solve_pflow(fresh, applied.method)
        if not bool(getattr(fresh.PFlow, "converged", False)):
            raise EigComputationError("the power flow did not converge")
        if fresh.EIG.run() is False:
            raise EigComputationError("the eigenvalue routine did not run")
        return fresh.EIG.mu

    def get_eig_state_matrix(self) -> bytes:
        """Return ``EIG.As`` (and ``EIG.mu``) packed as a ``.mat`` file
        via ``scipy.io.savemat`` — Unit 6 EIG export integration with
        Unit 2's MAT exporter.

        Pre-condition: EIG.run() must have populated ``EIG.As`` (raises
        :class:`EigPrerequisiteError` otherwise so the routes layer can
        surface a 409 with the same recovery message as the per-mode
        participation route).
        """
        ss = self._require_loaded()
        As = getattr(ss.EIG, "As", None)
        mu = getattr(ss.EIG, "mu", None)
        if As is None or mu is None:
            raise EigPrerequisiteError(
                "EIG has not been run on this session; run /eig first"
            )
        try:
            from io import BytesIO

            from scipy.io import savemat  # type: ignore[import-untyped]
        except ImportError as exc:  # pragma: no cover — scipy is an ANDES dep
            raise EigComputationError(
                f"scipy.io.savemat unavailable: {exc}"
            ) from exc

        buf = BytesIO()
        try:
            savemat(
                buf,
                {
                    "As": As,
                    "mu": mu,
                },
                format="5",
                do_compression=True,
            )
        except Exception as exc:  # noqa: BLE001
            raise EigComputationError(
                f"savemat failed for EIG.As: {exc}"
            ) from exc
        return buf.getvalue()


# ---- EIG helpers (Unit 6) --------------------------------------------------


# What ANDES counts as zero when its routine has no bound to give.
_ZERO_EIGENVALUE_TOL = 1e-6
# The most values one sweep may name. Each is a System read, set up, solved and analysed.
_SWEEP_MAX_POINTS = 200
# How small the real part of an oscillating eigenvalue is, next to the eigenvalue itself,
# for it to be rounding noise (see ``_settle_axis``). The noise of a solver is some 1e-16 of
# the size of the matrix it works on; a mode with real part this small has no damping that
# means anything.
_AXIS_NOISE = 1e-12


def _zero_tolerance(ss: System) -> float:
    """The magnitude up to which an eigenvalue is zero: ANDES's own bound
    (``EIG.config.tol``, which its statistics and its plot go by)."""
    try:
        tol = float(ss.EIG.config.tol)
    except (AttributeError, TypeError, ValueError):
        return _ZERO_EIGENVALUE_TOL
    return tol if math.isfinite(tol) and tol >= 0.0 else _ZERO_EIGENVALUE_TOL


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


def _eig_state_names(ss: System, mode_count: int) -> list[str]:
    """Best-effort labels for the reduced state vector EIG operates on.

    ANDES's ``EIG.run()`` reduces the state set via ``_fold_zstates``
    + ``_apply_state_constraints`` (see Unit 1a spike, lines 50-54).
    Our preferred source of names is ``ss.dae.x_name``; when the
    lengths match we use it directly. When they don't (folded
    states), fall back to generic ``state_<i>`` labels so the
    participation table always has stable labels.
    """
    dae = getattr(ss, "dae", None)
    if dae is not None:
        x_name = getattr(dae, "x_name", None)
        if x_name is not None:
            try:
                names = [str(n) for n in x_name]
            except (TypeError, ValueError):
                names = []
            if len(names) == mode_count:
                return names
    return [f"state_{i}" for i in range(mode_count)]


# ---- the parameter sweep ---------------------------------------------------


def _check_sweep_target(ss: System, model: str, idx: str, param: str) -> None:
    """Refuse a sweep of a model, a device or a parameter ``ss`` does not have.

    A parameter is one an edit of the element can write: a ``NumParam`` of the
    model that is not an ``ExtParam`` (a value copied from another model at
    ``setup()``). A service or any other attribute is not one, since it is
    worked out from the parameters again when the System is set up.
    """
    from andes.core.param import ExtParam, NumParam

    models = getattr(ss, "models", None)
    model_obj = models.get(model) if isinstance(models, dict) else None
    if model_obj is None:
        raise ElementNotFoundError(f"model {model!r} does not exist in this case")
    if device_position(model_obj, idx) is None:
        raise ElementNotFoundError(f"{model} {idx!r} does not exist in this case")
    params = getattr(model_obj, "params", None)
    param_obj = params.get(param) if isinstance(params, dict) else None
    if not isinstance(param_obj, NumParam) or isinstance(param_obj, ExtParam):
        raise ElementNotFoundError(f"{model} has no parameter {param!r}")


def _check_sweep_values(values: object) -> list[float]:
    """``values`` as floats: a list of 1 to ``_SWEEP_MAX_POINTS`` finite numbers.

    The REST body holds a request to the same; this is for a caller that did
    not come through it. Raises ``EigComputationError``.
    """
    if not isinstance(values, list | tuple):
        raise EigComputationError(
            f"sweep values must be a list of numbers, got {type(values).__name__}"
        )
    if not values:
        raise EigComputationError("sweep values must not be empty")
    if len(values) > _SWEEP_MAX_POINTS:
        raise EigComputationError(
            f"a sweep takes at most {_SWEEP_MAX_POINTS} values, got {len(values)}"
        )
    checked: list[float] = []
    for position, value in enumerate(values):
        # ``bool`` is an ``int`` subclass; ``true`` is not a parameter value.
        finite = False
        if isinstance(value, int | float) and not isinstance(value, bool):
            try:
                finite = math.isfinite(float(value))
            except OverflowError:  # an int too large for a float
                finite = False
        if not finite:
            raise EigComputationError(
                f"sweep value at position {position} is not a finite number: {value!r}"
            )
        checked.append(float(value))
    return checked


def _sweep_point_result(value: float, mu: Any, zero_tol: float) -> EigSweepPoint:
    """One point of a sweep, its eigenvalues cleaned as :meth:`EigMixin.run_eig`
    cleans them (an eigenvalue ANDES counts as zero is exactly zero)."""
    eigenvalues: list[ComplexNumber] = []
    damping_ratios: list[float] = []
    frequencies_hz: list[float] = []
    for z in [] if mu is None else list(mu):
        z_complex = _settle_axis(_settle_zero(complex(z), zero_tol))
        eigenvalues.append(ComplexNumber.from_complex(z_complex))
        damping_ratios.append(_compute_damping_ratio(z_complex))
        frequencies_hz.append(_compute_frequency_hz(z_complex))
    return EigSweepPoint(
        value=value,
        eigenvalues=eigenvalues,
        damping_ratios=damping_ratios,
        frequencies_hz=frequencies_hz,
    )
