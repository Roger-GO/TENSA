"""Power flow."""

from __future__ import annotations

import math

from tensa.core.errors import EigDirtyDaeError
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


class PflowMixin(WrapperBase):
    """Power flow, and the operating point read back without running one."""

    def run_pflow(
        self,
        *,
        tolerance: float | None = None,
        max_iterations: int | None = None,
        flat_start: bool | None = None,
        enforce_q_limits: bool | None = None,
    ) -> PflowResult:
        """Run power flow. Calls ``ss.setup()`` first if not yet committed
        (verified: ``PFlow.run`` does not auto-call setup).

        The keyword arguments are the settings the request may change, each
        ``None`` for "leave the System's own value": ``tolerance`` (the
        mismatch, in pu, below which the solver stops), ``max_iterations``,
        ``flat_start`` (start every bus voltage from 1 pu at angle 0) and
        ``enforce_q_limits`` (turn a PV or slack generator into a PQ bus held at
        ``qmin`` or ``qmax`` when its reactive power goes past one). They apply
        to this run only (:func:`~tensa.core.pflow_options.pflow_options_applied`)
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
        ) as settings:
            ss.PFlow.run()
        converged = bool(getattr(ss.PFlow, "converged", False))
        iterations = int(getattr(ss.PFlow, "niter", 0))
        # ``ss.PFlow.mis`` is a list of per-iteration mismatches; the final value
        # represents the converged-state mismatch.
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

        return PflowResult(
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
        return PflowResult(
            converged=len(bus_voltages) > 0,
            iterations=0,
            mismatch=0.0,
            bus_voltages=bus_voltages,
            bus_angles=bus_angles,
        )
