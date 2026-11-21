"""Power flow."""

from __future__ import annotations

import contextlib
import io
import logging
import math
import weakref
from typing import TYPE_CHECKING

from tensa.core.errors import EigDirtyDaeError
from tensa.core.messages import NOTICE_LOGGER
from tensa.core.pflow_options import pflow_options_applied, validate_pflow_options
from tensa.core.wrapper.base import WrapperBase
from tensa.core.wrapper.pflow_extract import (
    _extract_generator_outputs,
    _extract_line_flows,
    _extract_load_consumption,
    _reference_angle_drift,
    _summarize_pflow,
)
from tensa.core.wrapper.results import PflowResult

if TYPE_CHECKING:
    from andes.system import System

_log = logging.getLogger(NOTICE_LOGGER)
_debug = logging.getLogger(__name__)


def _is_nk_failure(exc: Exception) -> bool:
    """Whether ``exc`` is how ANDES 2.0.0's ``PFlow.run`` ends a Newton-Krylov
    run that did not converge: SciPy's ``NoConvergence``, or the ``IndexError``
    of ``mis[-2]`` on the one-entry list the run leaves."""
    from scipy.optimize import NoConvergence  # type: ignore[import-untyped]

    return isinstance(exc, IndexError | NoConvergence)


def _residual(ss: System) -> float:
    """The largest absolute element of the residual ANDES holds, the measure
    ``PFlow._max_mis`` gives the Newton loop; one that is not finite is
    reported as it is, as the Newton loop's would be."""
    import numpy as np

    values = np.concatenate(
        (np.ravel(np.asarray(ss.dae.f, dtype=float)), np.ravel(np.asarray(ss.dae.g, dtype=float)))
    )
    return float(np.max(np.abs(values))) if values.size else 0.0


def solve_pflow(ss: System, method: str) -> None:
    """Run `ss.PFlow` with the settings already applied, `method` being the
    one in effect. A Newton-Krylov run that did not converge is left with
    `PFlow.converged` False instead of raising, and SciPy's printing is kept
    off stdout; any other failure is raised as it is."""
    # ANDES 2.0.0 runs `newton_krylov` with `verbose=True` whatever its log
    # level, and SciPy prints a line per iteration: kept off the server's
    # console, as a debug record of this module.
    printed = io.StringIO()
    quiet = (
        contextlib.redirect_stdout(printed)
        if method == "NK"
        else contextlib.nullcontext()
    )
    try:
        with quiet:
            ss.PFlow.run()
    except Exception as exc:
        if method != "NK" or not _is_nk_failure(exc):
            raise
        # A Newton-Krylov run that did not converge, which ANDES 2.0.0 raises
        # from instead of returning False: SciPy's `NoConvergence` is not
        # caught at all, and after the `ValueError` it does catch, `run()`
        # reads `mis[-2]` from a list `newton_krylov` never appended to.
        ss.PFlow.converged = False
        _log.warning("Newton-Krylov power flow did not converge: %s", exc)
    finally:
        for line in printed.getvalue().splitlines():
            _debug.debug("newton_krylov: %s", line)


def _result_keys(wrapper: WrapperBase, result: PflowResult) -> dict[str, dict[str, str]]:
    """The ``keys`` lookup of a power-flow result: per kind, the stringified
    idx of every entry of the matching result dict mapped to its key. An idx
    with no key is left out; an empty result dict gives an empty map."""
    book = wrapper.keys()
    plans = (
        ("bus", ("Bus",), result.bus_voltages),
        ("line", ("Line",), result.line_flows),
        ("generator", ("PV", "Slack"), result.generator_outputs),
        ("load", ("PQ",), result.load_consumption),
    )
    keys: dict[str, dict[str, str]] = {}
    for name, models, values in plans:
        mapped: dict[str, str] = {}
        for idx in values:
            for model in models:
                key = book.key_of(model, idx)
                if key is not None:
                    mapped[str(idx)] = key
                    break
        keys[name] = mapped
    return keys


class PflowMixin(WrapperBase):
    """Power flow, and the operating point read back without running one."""

    def run_pflow(
        self,
        *,
        tolerance: float | None = None,
        max_iterations: int | None = None,
        flat_start: bool | None = None,
        enforce_q_limits: bool | None = None,
        method: str | None = None,
        n_factorize: int | None = None,
        linesearch: bool | None = None,
    ) -> PflowResult:
        """Run power flow. Calls ``ss.setup()`` first if not yet committed
        (verified: ``PFlow.run`` does not auto-call setup).

        The keyword arguments are the settings the request may change, each
        ``None`` for "leave the System's own value": ``tolerance`` (the
        mismatch, in pu, below which the solver stops), ``max_iterations``,
        ``flat_start`` (start every bus voltage from 1 pu at angle 0),
        ``enforce_q_limits`` (turn a PV or slack generator into a PQ bus held at
        ``qmin`` or ``qmax`` when its reactive power goes past one), ``method``
        (the solver: ``NR`` Newton-Raphson, ``dishonest`` Newton-Raphson that
        reuses the Jacobian after the first ``n_factorize`` iterations, ``NK``
        Newton-Krylov from SciPy, which stops by SciPy's own rule and so reads
        neither ``tolerance`` nor ``max_iterations``; its result has no
        iteration count, and its mismatch is read off the residual it leaves),
        ``n_factorize`` (matters only for ``dishonest``) and ``linesearch``
        (backtracking line search on the NR step; read only by ``nr_solve``, so
        without effect under ``NK``). They apply to this run only
        (:func:`~tensa.core.pflow_options.pflow_options_applied`)
        and a value out of range raises ``PflowRequestError`` before anything is
        written. The result carries the settings the run used.

        Substrate-side gate (Phase 1 smoke Issue 1): if ``ss.TDS.initialized``
        is True, refuse with :class:`EigDirtyDaeError`. Background:

        - Running ``ss.EIG.run()`` calls ``TDS.init()`` + ``TDS.itm_step()``
          via ``EIG._pre_check`` (Unit 1a spike), advancing ``dae.t`` to 0
          and extending the dae arrays for the full TDS state set.
        - A subsequent ``ss.PFlow.run()`` then completes (returns
          ``converged=True`` in 1 iteration) but populates ``Bus.v.v``
          with NaN entries on cases like ``kundur_full``. Extraction +
          JSON encoding then either crashes or emits non-finite floats.
        - ``ss.reset(force=True)`` is **not** a viable recovery path —
          it re-calls ``setup()`` which then raises
          ``NotImplementedError: Does not know how to shrink arrays``
          inside ``DAE.alloc_or_extend_names``. Verified empirically.

        Recovery is therefore ``reload_case()`` — full re-parse of the
        original case file. The error message points the caller there.
        """
        validate_pflow_options(
            tolerance=tolerance,
            max_iterations=max_iterations,
            flat_start=flat_start,
            enforce_q_limits=enforce_q_limits,
            method=method,
            n_factorize=n_factorize,
            linesearch=linesearch,
        )
        ss = self._require_loaded()
        if bool(getattr(getattr(ss, "TDS", None), "initialized", False)):
            raise EigDirtyDaeError(
                "EIG mutated dae state; reload case "
                "(POST /api/sessions/{id}/reload) to restore pre-EIG PF "
                "behavior, or use Run TDS instead."
            )
        self._ensure_setup()
        with pflow_options_applied(
            ss,
            tolerance=tolerance,
            max_iterations=max_iterations,
            flat_start=flat_start,
            enforce_q_limits=enforce_q_limits,
            method=method,
            n_factorize=n_factorize,
            linesearch=linesearch,
        ) as settings:
            solve_pflow(ss, settings.method)
        # What an eigenvalue sweep solves the power flow of its own Systems with.
        try:
            self._pflow_settings = (weakref.ref(ss), settings)
        except TypeError:  # a stand-in System that takes no weak reference
            self._pflow_settings = None
        converged = bool(getattr(ss.PFlow, "converged", False))
        iterations = int(getattr(ss.PFlow, "niter", 0))
        if settings.method == "NK":
            # ``newton_krylov`` keeps neither ``niter`` nor ``mis`` (which stays
            # at its placeholder of 1), so the mismatch is read off the
            # residual it left, as ``PFlow._max_mis`` reads it for NR.
            mismatch = _residual(ss)
        else:
            # ``ss.PFlow.mis`` is a list of per-iteration mismatches; the final
            # value represents the converged-state mismatch.
            mis_list = getattr(ss.PFlow, "mis", None)
            mismatch = (
                float(mis_list[-1])
                if mis_list and isinstance(mis_list, list | tuple)
                else 0.0
            )

        bus_voltages: dict[int | str, float] = {}
        bus_angles: dict[int | str, float] = {}
        if hasattr(ss, "Bus") and getattr(ss.Bus, "v", None) is not None:
            drift = _reference_angle_drift(ss)
            for i, idx in enumerate(ss.Bus.idx.v):
                v = float(ss.Bus.v.v[i])
                a = float(ss.Bus.a.v[i])
                # Guard finiteness (mirrors operating_point): a dirty dae can
                # leave NaN/Inf in Bus.a/v, which would break JSON encoding.
                if math.isfinite(v) and math.isfinite(a):
                    bus_voltages[idx] = v
                    bus_angles[idx] = a - drift

        line_flows = _extract_line_flows(ss) if converged else {}
        generator_outputs = _extract_generator_outputs(ss) if converged else {}
        load_consumption = _extract_load_consumption(ss) if converged else {}

        result = PflowResult(
            converged=converged,
            iterations=iterations,
            mismatch=mismatch,
            bus_voltages=bus_voltages,
            bus_angles=bus_angles,
            line_flows=line_flows,
            generator_outputs=generator_outputs,
            load_consumption=load_consumption,
            settings=settings,
            summary=(
                _summarize_pflow(ss, line_flows, generator_outputs, load_consumption)
                if converged
                else None
            ),
        )
        result.keys = _result_keys(self, result)
        return result

    def operating_point(self) -> PflowResult:
        """Read the System's CURRENT operating point WITHOUT running anything.

        The data grid shows solved bus V/θ from the last ``PflowResult``. A
        PF run sets that; a TDS run does NOT — so after a TDS-only run the
        grid sat empty even though ``ss.Bus.v``/``ss.Bus.a`` hold the
        final-time operating point. This read-only accessor reads the same
        ``Bus.v``/``Bus.a`` arrays ``run_pflow`` reads so the client can
        refresh the grid after TDS (and any routine that leaves a solved
        state) — no re-solve, no dae mutation.

        ``converged`` here means "a finite solution is present" (Bus.v set),
        not a fresh PF convergence. Non-finite entries (e.g. a dae left
        dirty by a prior EIG run) are skipped so JSON encoding never sees
        NaN/Inf. Line/generator/load flows are intentionally omitted: this
        read targets the Buses grid (V/θ), and deriving the rest from a
        possibly-dirty dae risks non-finite values; the PF path still
        populates them.
        """
        ss = self._require_loaded()
        bus_voltages: dict[int | str, float] = {}
        bus_angles: dict[int | str, float] = {}
        if hasattr(ss, "Bus") and getattr(ss.Bus, "v", None) is not None:
            drift = _reference_angle_drift(ss)
            for i, idx in enumerate(ss.Bus.idx.v):
                v = float(ss.Bus.v.v[i])
                a = float(ss.Bus.a.v[i])
                if math.isfinite(v) and math.isfinite(a):
                    bus_voltages[idx] = v
                    bus_angles[idx] = a - drift
        result = PflowResult(
            converged=len(bus_voltages) > 0,
            iterations=0,
            mismatch=0.0,
            bus_voltages=bus_voltages,
            bus_angles=bus_angles,
        )
        result.keys = _result_keys(self, result)
        return result
