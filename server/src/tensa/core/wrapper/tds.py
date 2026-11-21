"""Time-domain simulation."""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Mapping, Sequence
from threading import Event
from typing import TYPE_CHECKING, Any, Literal, get_args

import numpy as np

from tensa.core.errors import SetupFailedError, TdsRequestError, short_repr
from tensa.core.tds_controllers import ControllerBank, ControllerSpec, controller_catalogue
from tensa.core.tds_steps import land_on_time
from tensa.core.wrapper.base import WrapperBase
from tensa.core.wrapper.results import (
    TdsBatchResult,
    TdsInitClamp,
    TdsInitResidual,
    TdsInitResult,
)

if TYPE_CHECKING:
    from andes.system import System

# The integrators a time-domain run can ask for, by the names the API uses. The
# REST body, the WebSocket's ``start_tds`` frame, the worker and the wrapper all
# take them from here.
IntegratorName = Literal["trapezoidal", "trap_adapt", "backeuler", "qndf"]
TDS_INTEGRATORS: tuple[IntegratorName, ...] = get_args(IntegratorName)

# The ``ss.TDS.config.method`` each integrator is run with, which is also its key
# in ANDES's ``andes.routines.daeint.method_map``.
_ANDES_METHOD: dict[str, str] = {
    "trapezoidal": "trapezoid",
    "trap_adapt": "trap_adapt",
    "backeuler": "backeuler",
    "qndf": "qndf",
}

# The integrators that choose their own steps (ANDES's ``requires_variable_step``),
# which run with ``fixt = 0`` and ignore ``h``.
_VARIABLE_STEP: frozenset[str] = frozenset({"trap_adapt", "qndf"})

_notice = logging.getLogger("tensa.notice")

# The most rows of each diagnostic table a result carries; the full text of the
# tables remains in the session messages, where ``TDS.test_init()`` logs them.
_INIT_DIAGNOSTICS_CAP = 500


class TdsMixin(WrapperBase):
    """Time-domain simulation: the request checks, the controllers a run takes,
    and the run itself."""

    def check_tds_request(
        self,
        integrator: IntegratorName = "trapezoidal",
        tds_config_overrides: dict[str, float] | None = None,
    ) -> None:
        """Raise if :meth:`run_tds` would refuse this request.

        Covers the refusals that follow from the request and the System's
        state: an integrator that is not one of :data:`TDS_INTEGRATORS`
        (``TdsRequestError``), QNDF on a System that has already stepped with
        another integrator (``SetupFailedError``, whose recovery is a reload),
        and an override key that is neither a canonical alias nor a real
        ``ss.TDS.config`` field, or an override value that breaks its rule
        (:func:`validate_tds_overrides`), both ``TdsRequestError``. ``run_tds``
        calls it before any config write. A caller that sends something ahead of
        the run (the streaming handler's stream-start frame) calls it first, so a
        refused run never opens a stream. It writes nothing, so a refusal leaves
        the System as it was.
        """
        validate_integrator(integrator)
        ss = self._require_loaded()

        # ANDES builds its integrator object once, in ``TDS.init()``, and a
        # System that has already run keeps it. QNDF also needs the history
        # cache ``init()`` builds. Where nothing has stepped yet (``init_tds`` and
        # an eigenvalue analysis call ``init()`` and stop there) ``run_tds``
        # builds the cache itself. Past the first step it cannot be swapped in, so
        # refuse rather than run with another integrator's object under a QNDF
        # request. The
        # other three keep no history and are swapped in at any point.
        if integrator == "qndf" and _qndf_needs_init(ss):
            if not _tds_unstepped(ss):
                raise SetupFailedError(
                    f"QNDF cannot replace the {_live_integrator(ss) or 'current'} integrator of a "
                    "System that has already taken time-domain steps, in a run or in "
                    "a snapshot taken after one"
                )
            if not int(ss.dae.n):
                # What ``TDS.init()`` raises for QNDF on a System without
                # differential equations; asked here so the run is refused up front.
                raise SetupFailedError(
                    "QNDF requires at least one differential equation (dae.n > 0); "
                    "load the dynamic data, or use the trapezoidal integrator"
                )

        for key in tds_config_overrides or {}:
            if not hasattr(ss.TDS.config, _TDS_OVERRIDE_ALIASES.get(key, key)):
                raise TdsRequestError(
                    f"unknown TDS override key {short_repr(key)}; expected a "
                    f"wrapper-canonical alias {list(_TDS_OVERRIDE_ALIASES)!r} or "
                    f"a real ss.TDS.config field name"
                )
        validate_tds_overrides(tds_config_overrides)

    def tds_controllers(self, specs: Sequence[ControllerSpec]) -> ControllerBank | None:
        """The controllers of a time-domain run about to start, bound to the
        loaded System; ``None`` for a run that names none.

        A run that names the controllers the last one had, on the same System
        and from where that run stopped, is given that run's bank, so it carries
        on: an FFR that has fired stays fired. Any other run gets a new one, also
        the first on a System a reload or a restored snapshot put in place.
        Nothing is written to the System here.

        Raises:
            TdsRequestError: a controller names a device the case does not have
                or one no controller can command (see
                ``tensa.core.tds_controllers``).
        """
        ss = self._require_loaded()
        if not specs:
            return None
        bank = self._controller_bank
        if bank is not None and bank.continues(ss, specs):
            bank.rebind(ss)
            return bank
        return ControllerBank(ss, specs)

    def tds_controller_catalogue(self) -> dict[str, Any]:
        """The kinds of controller a time-domain run takes and the devices of
        the loaded case they can command; no devices when no case is loaded."""
        return controller_catalogue(self._ss)

    def init_tds(self, test_init: bool = True) -> TdsInitResult:
        """Initialise the time-domain run on the loaded System without stepping it.

        Calls ANDES ``TDS.init()``: it restores the power-flow solution into the
        DAE, initialises every dynamic model, compacts the DAE, and builds the
        mass matrix and the integrator. No step is taken: ``dae.t`` stays 0 and
        ``dae.kcount`` stays 0. The System is left initialised, so a later
        :meth:`run_tds` resumes from it through ANDES's own ``init_resume()``
        path, as ``TDS.run()`` does after ``init()``. Its record has no row at
        0 s, which a run from scratch stores and which holds the initial values.
        ``init()`` builds the integrator the System's config names now (the
        case's own, the trapezoidal method); the run that follows steps with
        the integrator it names, which :meth:`run_tds` swaps in, QNDF with its
        history, since nothing has stepped. With a fixed step that run solves
        the same steps as a run with no initialise before it; the two
        variable-step integrators choose other steps before the first event
        (a run from scratch solves the point at 0 s as its first step and grows
        its steps from there), and the same steps after it. A run that starts
        from an initialisation that failed its test is reported as not
        converged, as it would be from scratch (see :meth:`run_tds`).

        ``test_init`` applies to this call only and is put back afterwards, even
        when ``TDS.init()`` raises: with it on (the default) ANDES checks the
        initialisation residuals against ``TDS.config.tol``, logs the two
        diagnostic tables when the check fails (variables clamped at limits,
        equations with non-zero residuals) and gives its verdict in
        ``test_ok``; with it off ANDES does not check and ``test_ok`` is
        ``None``. The result reports the setting used. The diagnostics are read
        from the System either way, by the rule ANDES's test applies (see
        :func:`_init_diagnostics`), so a call with the test off still names what
        did not initialise rather than reading as a clean start.

        The call runs setup and a power flow first (``TDS.init()`` reads
        ``PFlow.x_sol`` / ``y_sol``), so the case closes to new disturbances
        and edits exactly as a first :meth:`run_tds` would; that is intended.

        Raises:
            TdsRequestError: ``test_init`` is not a bool.
            SetupFailedError: the loaded case has no dynamic models, the System
                is already initialised (ANDES ``init()`` is a no-op then and
                would report the stale verdict of the first initialisation;
                reload the case to initialise again), the power flow did not
                converge, or ``TDS.init()`` itself raised.
        """
        if not isinstance(test_init, bool):
            raise TdsRequestError(
                f"test_init must be true or false, got {short_repr(test_init)}"
            )
        ss = self._require_loaded()
        self._ensure_setup()
        if not _dynamic_models(ss):
            raise SetupFailedError(
                "the loaded case has no dynamic models; there is no time-domain "
                "run to initialise"
            )
        if bool(ss.TDS.initialized):
            raise SetupFailedError(
                "TDS is already initialised on this System; reload the case to "
                "initialise again"
            )

        # ANDES TDS requires a converged power-flow solution as initial
        # conditions, exactly as ``run_tds`` does it.
        if not bool(getattr(ss.PFlow, "converged", False)):
            ss.PFlow.run()
            if not bool(getattr(ss.PFlow, "converged", False)):
                raise SetupFailedError(
                    "power flow did not converge; TDS cannot begin"
                )

        # ``test_init`` for this call only, put back even when ``init()`` raises.
        old_test_init = ss.TDS.config.test_init
        ss.TDS.config.test_init = 1 if test_init else 0
        # Judge this call on its own, as ``run_tds`` does.
        ss.exit_code = 0
        try:
            ss.TDS.init()
            if not test_init:
                # The test is also where ``init()`` leaves the Jacobians evaluated
                # at the initial point. An eigenvalue analysis on an initialised
                # System builds its state matrix from them without evaluating them
                # again, so without this one that follows would read the
                # Jacobians of the power flow.
                ss.j_update(models=ss.exist.pflow_tds)
        except Exception as exc:  # noqa: BLE001
            raise SetupFailedError(f"TDS.init raised: {exc}") from exc
        finally:
            ss.TDS.config.test_init = old_test_init

        clamped, residuals, truncated = _init_diagnostics(ss)
        fg = _checked_residuals(ss)
        test_ok = ss.TDS.test_ok
        result = TdsInitResult(
            initialized=bool(ss.TDS.initialized),
            test_ok=None if test_ok is None else bool(test_ok),
            test_init=test_init,
            n_states=int(ss.dae.n),
            n_algeb=int(ss.dae.m),
            max_residual=float(np.nanmax(np.abs(fg))) if fg.size and not np.isnan(fg).all() else 0.0,
            nan_residuals=int(np.count_nonzero(np.isnan(fg))),
            clamped=clamped,
            residuals=residuals,
            diagnostics_truncated=truncated,
        )
        verdict = (
            "not run"
            if result.test_ok is None
            else ("passed" if result.test_ok else "failed")
        )
        _notice.info(
            "tds init: initialised %d states, %d algebraic variables; "
            "initialisation test %s",
            result.n_states,
            result.n_algeb,
            verdict,
        )
        return result

    def run_tds(
        self,
        tf: float,
        h: float | None = None,
        on_step: Callable[[float, System], None] | None = None,
        abort_flag: Event | None = None,
        integrator: IntegratorName = "trapezoidal",
        tds_config_overrides: dict[str, float] | None = None,
        controllers: ControllerBank | None = None,
    ) -> TdsBatchResult:
        """Run a time-domain simulation up to ``tf`` seconds.

        ``on_step`` is invoked once per integration step via ANDES's
        ``TDS.callpert`` hook. ``abort_flag``, when set, causes the wrapper
        to set ``ss.TDS.busted = True`` on the next callpert invocation,
        cleanly terminating the integration loop within ~2 steps.

        ``controllers`` (from :meth:`tds_controllers`) act from the same hook,
        ahead of ``on_step``: each reads the frequency once a sample period and
        sets the power of its device. What they wrote is taken back when the
        run ends, however it ends.

        A run on a System that :meth:`init_tds` (or an eigenvalue analysis)
        initialised and that has not stepped since carries on from that
        initialisation, and when its test failed the run is reported as not
        converged, as the same run from scratch is.

        ``h`` (seconds) is written to ``ss.TDS.config.tstep``, the field
        ANDES 2.0.0 reads. With the trapezoidal integrator it is the fixed
        step (steps are still clipped at event times and at ``tf``);
        ``None`` keeps the ANDES default of 1/30 s. Backward Euler steps at
        ``h`` the same way. The two variable-step integrators (``trap_adapt``
        and ``qndf``) pick their own first step (``min(1/30, tf/100)``) and
        ignore it; bound their steps with the ``max_step`` and ``min_step``
        overrides instead.

        ``integrator`` selects the DAE solution method (the ANDES
        ``ss.TDS.config.method`` in brackets):
        - ``"trapezoidal"`` (default, ``trapezoid``): fixed-step Implicit
          Trapezoidal Method, second order. ``h`` is the step.
        - ``"backeuler"`` (``backeuler``): fixed-step backward Euler, first
          order, so more damped than the trapezoidal method at the same ``h``.
          ``h`` is the step.
        - ``"trap_adapt"`` (``trap_adapt``): the trapezoidal method with a
          variable step, chosen from an estimate of the local error (one step
          against two half steps) held to ``reltol`` and ``abstol``, between
          ``dtmin_adapt`` and ``dtmax``. Within 0.1 s of an event, and for 20
          steps after a step it rejected, ANDES grows the step by the Newton
          iteration count instead.
        - ``"qndf"`` (``qndf``): variable-order, variable-step QNDF (NDF)
          method, with the same tolerances and bounds.

        ``fixt`` is set on every run (1 for the fixed-step two, 0 for the
        variable-step two), and so is ``method``: neither is put back after the
        run, because every run writes both again before ANDES reads them, so no
        run inherits an earlier run's integrator. ANDES builds
        its integrator object once, in ``TDS.init()``, so on a System that has
        already been initialised (a run, :meth:`init_tds`, an eigenvalue
        analysis, a restored snapshot) the wrapper swaps the object for the one requested. The
        trapezoidal, backward Euler and adaptive trapezoidal objects keep no
        state between steps, and ANDES works the step bounds out again when a
        run carries on, so any of them replaces any other at any point. QNDF
        keeps a history that ``TDS.init()`` builds: a QNDF request on a System
        initialised without it builds the history itself while nothing has
        stepped (after :meth:`init_tds` or an eigenvalue analysis), and raises
        ``SetupFailedError`` once the System has taken steps, and the caller
        must reload the case first.

        ``tds_config_overrides`` (optional) is a dict of TDS config
        field names → values. Two key flavours are accepted:

        - Four wrapper-canonical aliases for the adaptive knobs, which only the
          variable-step integrators read:
          - ``rtol`` → ``ss.TDS.config.reltol`` (relative tolerance).
          - ``atol`` → ``ss.TDS.config.abstol`` (absolute tolerance).
          - ``max_step`` → ``ss.TDS.config.dtmax`` (maximum step size; the
            ANDES field is ``dtmax``, NOT ``h_max``).
          - ``min_step`` → ``ss.TDS.config.dtmin_adapt`` (the smallest step
            the variable-step integrators may shrink to; 0 lets ANDES choose).
        - Any genuine ``ss.TDS.config`` field name (e.g. ``tol``,
          ``max_iter``, ``fixt``, ``shrinkt``, ``honest``, ``tstep``,
          ``reltol``, ``abstol``, ``dtmax``). These are validated against
          the live config object (``hasattr``) and ``setattr`` directly.
          This is what the GUI's free-form override editor forwards.

        Overrides are applied after ``h``, so an explicit ``tstep`` key wins.
        The step-size overrides follow the rule ``h`` does: ``tstep`` must be a
        finite number greater than zero, ``max_step`` (``dtmax``) and
        ``min_step`` (``dtmin_adapt``) finite and not negative, and ``fixt`` 0
        or 1 (see :func:`validate_tds_overrides`). An override stays on the
        System after the run, as it always has.

        A key that is neither a canonical alias nor a real ``ss.TDS.config``
        field raises ``TdsRequestError`` (the wrapper stays a strict
        gatekeeper — it never sets an attribute that does not exist), and so
        does a value that breaks its rule, before anything is written. The
        Auto preset (``rtol=1e-3, atol=1e-6, max_step=0.05``) is the
        caller's responsibility to set; this method does NOT inject
        defaults.
        """
        h = validate_step_size(h)
        # Before setup is committed, like the step: a request refused for what it
        # names must leave the System as it was.
        validate_integrator(integrator)
        ss = self._require_loaded()
        self._ensure_setup()

        # Refusals that depend only on the request and the System's state. They
        # come before any config write, so a refusal leaves the System as it was.
        self.check_tds_request(integrator, tds_config_overrides)

        # ANDES TDS requires a converged power-flow solution as initial conditions.
        # Run PF first if it hasn't been solved (idempotent — re-running converged
        # PF is fast and a no-op semantically). This one runs with the case's own
        # settings: a power-flow request's options (``run_pflow``) apply only to a
        # run that request makes.
        if not bool(getattr(ss.PFlow, "converged", False)):
            ss.PFlow.run()
            if not bool(getattr(ss.PFlow, "converged", False)):
                raise SetupFailedError(
                    "power flow did not converge; TDS cannot begin"
                )

        # Configure the TDS endpoint and step size. ANDES 2.0.0 reads the
        # step from ``config.tstep`` (fixed step for trapezoid; QNDF ignores
        # it for the initial step). ``Config`` accepts any attribute name
        # silently, so a write to a name ANDES never reads (the old
        # ``config.h``) went unnoticed; guard the field exists instead.
        ss.TDS.config.tf = tf
        if h is not None:
            if not hasattr(ss.TDS.config, "tstep"):
                raise SetupFailedError(
                    "ss.TDS.config has no 'tstep' field; cannot apply the "
                    "requested step size (unsupported ANDES version?)"
                )
            ss.TDS.config.tstep = h

        # Integrator selection: the ANDES ``method`` string, and ``fixt = 0`` for
        # the variable-step two so ANDES leaves the step to their error control
        # (andes/routines/tds.py, ``set_method``). ``fixt`` is set on every run
        # for every integrator: it lives on the System's config, so leaving it
        # alone would carry a variable-step run's ``fixt = 0`` into a later
        # fixed-step run and silently void its ``h``.
        ss.TDS.config.method = _ANDES_METHOD[integrator]
        ss.TDS.config.fixt = 0 if integrator in _VARIABLE_STEP else 1
        # ANDES builds the integrator object once, in ``TDS.init()``; a resumed
        # run ignores ``config.method``. Without this a run would keep stepping
        # with whatever integrator the System was initialised or last run with.
        # Before ``init()`` the object is left to it. QNDF is swapped in below,
        # with its history, and only where ``check_tds_request`` allowed it.
        if (
            integrator != "qndf"
            and bool(getattr(ss.TDS, "initialized", False))
            and _live_integrator(ss) != integrator
        ):
            ss.TDS.set_method(_ANDES_METHOD[integrator])

        # Tolerance / step-bound overrides. Four keys are wrapper-canonical
        # aliases (``rtol`` / ``atol`` / ``max_step`` / ``min_step``) that map to
        # the ANDES field names ``reltol`` / ``abstol`` / ``dtmax`` /
        # ``dtmin_adapt``. Any other
        # key is treated as a literal ``ss.TDS.config`` field name and is
        # set directly — this is what the GUI free-form override editor
        # forwards (e.g. ``tol``, ``max_iter``). ``check_tds_request`` has
        # already refused a key that is neither a canonical alias nor a real
        # config field (the wrapper never sets a non-existent attr).
        if tds_config_overrides:
            for key, value in tds_config_overrides.items():
                setattr(ss.TDS.config, _TDS_OVERRIDE_ALIASES.get(key, key), value)

        # QNDF on a System whose ``TDS.init()`` already ran, with another
        # integrator (``init_tds`` and an eigenvalue analysis do that, with the
        # case's own): ``init()`` is skipped, so
        # build what it would have built for QNDF. Last, because the history takes
        # its tolerances from the config at construction, overrides included.
        if integrator == "qndf" and _qndf_needs_init(ss):
            from andes.routines.qndf import QNDFCache

            ss.TDS.set_method("qndf")
            ss.TDS.qndf_cache = QNDFCache(
                n=ss.dae.n,
                abstol=ss.TDS.config.abstol,
                reltol=ss.TDS.config.reltol,
            )

        callpert_count = 0

        def _callpert(t: float, system: System) -> None:
            nonlocal callpert_count
            callpert_count += 1
            land_on_time(system)
            if abort_flag is not None and abort_flag.is_set():
                system.TDS.busted = True
                # The step before this call is solved whatever becomes of the
                # run, and ANDES still solves this one: both belong to a record.
                if on_step is not None:
                    on_step(t, system)
                return
            if controllers is not None:
                controllers.step(t, system)
            if on_step is not None:
                on_step(t, system)

        ss.TDS.callpert = _callpert

        # Reset busted flag in case of re-run on the same System
        ss.TDS.busted = False

        # Only a run that names the same controllers again carries them on; a
        # run without any ends them.
        self._controller_bank = controllers
        if controllers is not None:
            controllers.begin_run()
        # ANDES only ever adds to ``exit_code`` (a failed continuation power flow, an eigenvalue
        # pre-check that failed, a failed setup) and only a power flow sets it back to 0, so the
        # code a run leaves says what the runs before it did as well. This run is judged on its
        # own: a run that reaches its end time cleanly, in a session where a continuation power
        # flow failed, is not one that failed. A run that starts where ``TDS.init()``
        # left the System (``init_tds``, or an eigenvalue analysis) does not call
        # ``init()`` again, so the failed initialisation test that adds 1 to the code
        # of a run from scratch is carried over from that call.
        ss.exit_code = 1 if _starts_from_failed_init(ss) else 0
        try:
            ss.TDS.run()
        except Exception as exc:  # noqa: BLE001
            raise SetupFailedError(f"TDS.run raised: {exc}") from exc
        finally:
            if controllers is not None:
                controllers.end_run(ss)

        final_t = float(ss.dae.t)
        # If ANDES set a non-zero exit code, treat as not-fully-converged but do not raise
        # (caller can inspect callpert_count and final_t to assess).
        converged = bool(getattr(ss, "exit_code", 0) == 0) and not bool(
            getattr(ss.TDS, "busted", False)
        )
        return TdsBatchResult(
            converged=converged,
            final_t=final_t,
            callpert_count=callpert_count,
            integrator=integrator,
        )


# Wrapper-canonical names for the adaptive knobs in
# ``run_tds(tds_config_overrides=...)``, mapped to the ``ss.TDS.config`` fields
# ANDES reads. Any other key must already be a real ``ss.TDS.config`` field.
_TDS_OVERRIDE_ALIASES: dict[str, str] = {
    "rtol": "reltol",
    "atol": "abstol",
    "max_step": "dtmax",
    "min_step": "dtmin_adapt",
}


def _live_integrator(ss: System) -> str | None:
    """The integrator ANDES steps the System with now, by its API name, or
    ``None`` for an object of no class :data:`TDS_INTEGRATORS` names.

    Read from the object, not from ``config.method``, which ANDES reads only in
    ``TDS.init()``.
    """
    from andes.routines.daeint import method_map

    live = type(getattr(ss.TDS, "method", None))
    for name, andes_name in _ANDES_METHOD.items():
        if method_map.get(andes_name) is live:
            return name
    return None


def _dynamic_models(ss: System) -> list[str]:
    """The models of the set-up System that only a time-domain run uses
    (machines, exciters, governors, ...), leaving out the timed events.

    ``exist.tds`` alone is no test: the network and the static devices are in
    it on a case with no dynamic data as well.
    """
    exist = getattr(ss, "exist", None)
    models = getattr(exist, "tds", None) or {}
    return [
        name
        for name, model in models.items()
        if not bool(getattr(getattr(model, "flags", None), "pflow", False))
        and getattr(model, "group", None) != "TimedEvent"
    ]


def _checked_residuals(ss: System) -> np.ndarray:
    """A copy of ``dae.fg`` as ``TDS.test_init()`` judges it: with the
    differential equations ANDES does not check at initialisation
    (``System.no_check_init``) at zero. The test zeroes them in place; with the
    test off they still hold whatever ``init()`` left there."""
    fg = np.array(ss.dae.fg, dtype=float)
    unchecked = list(getattr(ss, "no_check_init", None) or [])
    if unchecked:
        fg[unchecked] = 0.0
    return fg


def _starts_from_failed_init(ss: System) -> bool:
    """Whether a run would start where ``TDS.init()`` left the System, after
    the initialisation test failed: initialised, no step taken, ``test_ok``
    false. ``TDS.run()`` does not call ``init()`` on such a System."""
    tds = ss.TDS
    return (
        bool(getattr(tds, "initialized", False))
        and getattr(tds, "test_ok", None) is False
        and _tds_unstepped(ss)
    )


def _init_diagnostics(ss: System) -> tuple[list[TdsInitClamp], list[TdsInitResidual], bool]:
    """The two diagnostic tables of ``TDS.test_init()``, re-derived from the
    state ``TDS.init()`` leaves behind, each capped at ``_INIT_DIAGNOSTICS_CAP``
    rows; the third value is whether either list was cut.

    The clamped-limits rows come from each model's discrete
    ``get_limit_report()``, which reads the limiters' state and holds the same
    rows whether or not the test ran (a variable can be clamped on a System
    that passes the test). The residual rows are the indices of the checked
    residuals (:func:`_checked_residuals`) at or over ``TDS.config.tol``, plus
    the NaN ones, with the name from ``dae.xy_name`` and the equation string
    from ``dae.x_map`` / ``dae.y_map``, the lookup ``test_init()`` does; a NaN
    mismatch is reported as ``None``, since NaN does not survive JSON. Nothing
    here writes to the System.
    """
    clamped: list[TdsInitClamp] = []
    for model in ss.exist.pflow_tds.values():
        for item in model.discrete.values():
            for r in item.get_limit_report():
                clamped.append(
                    TdsInitClamp(
                        model=r["model"],
                        idx=str(r["idx"]),
                        var=r["var"],
                        limit_name=r["limit_name"],
                        limit_val=float(r["limit_val"]),
                        unconstr=float(r["unconstr"]),
                    )
                )

    fg = _checked_residuals(ss)
    fail_idx = np.ravel(np.where(abs(fg) >= ss.TDS.config.tol))
    nan_idx = np.ravel(np.where(np.isnan(fg)))
    bad_idx = np.hstack([fail_idx, nan_idx])
    residuals: list[TdsInitResidual] = []
    n = int(ss.dae.n)
    for i in bad_idx:
        ii = int(i)
        entry = ss.dae.x_map.get(ii) if ii < n else ss.dae.y_map.get(ii - n)
        mismatch = float(fg[ii])
        residuals.append(
            TdsInitResidual(
                name=ss.dae.xy_name[ii],
                mismatch=None if math.isnan(mismatch) else mismatch,
                equation=entry[1].e_str if entry and entry[1].e_str else "",
            )
        )

    truncated = len(clamped) > _INIT_DIAGNOSTICS_CAP or len(residuals) > _INIT_DIAGNOSTICS_CAP
    return clamped[:_INIT_DIAGNOSTICS_CAP], residuals[:_INIT_DIAGNOSTICS_CAP], truncated


def _qndf_needs_init(ss: System) -> bool:
    """Whether ``TDS.init()`` has already run with an integrator other than QNDF.

    ANDES builds the integrator object, and for QNDF its history, in
    ``TDS.init()`` and skips it from then on, so a QNDF run on such a System has
    to build the history itself (:func:`_tds_unstepped`) or cannot run. The
    name is QNDF's because only QNDF needs more than its object swapped.
    """
    return bool(getattr(ss.TDS, "initialized", False)) and _live_integrator(ss) != "qndf"


def _tds_unstepped(ss: System) -> bool:
    """Whether the DAE is where ``TDS.init()`` left it: at time 0, no step taken.

    ``init_tds`` and an eigenvalue analysis leave a System like this. ``dae.t`` moves off 0 when a
    run starts and ``dae.kcount`` counts the steps it takes, so a System that ran
    at all, or that was restored from a snapshot taken after a run, is not.
    """
    return float(ss.dae.t) == 0.0 and int(ss.dae.kcount) == 0


def tds_fixed_step(
    integrator: IntegratorName = "trapezoidal",
    tds_config_overrides: dict[str, float] | None = None,
) -> bool:
    """Whether :meth:`Wrapper.run_tds` steps at a fixed size for this request.

    Read from the request, not from ``ss.TDS.config.fixt``: ``run_tds`` sets
    ``fixt`` per run, so before it runs the config holds whatever an earlier
    run (or ANDES's default of 1) left there. QNDF and the adaptive trapezoidal
    method choose their own steps, and ANDES sets ``fixt = 0`` for them. A
    trapezoidal or backward Euler run is fixed-step unless a ``fixt`` override,
    applied after the wrapper's own, says otherwise. (A ``tstep`` override that
    is not positive would have ANDES quietly go to variable step, but
    ``Wrapper.check_tds_request`` refuses it before a run gets this far.)
    """
    if integrator in _VARIABLE_STEP:
        return False
    return bool((tds_config_overrides or {}).get("fixt", 1))


def validate_integrator(integrator: object) -> IntegratorName:
    """Return ``integrator`` when it is one of :data:`TDS_INTEGRATORS`.

    The REST body checks it against the same literal; the WebSocket start frame,
    the worker's run handler and the wrapper call this, since none of them has
    the body's model in front of it.

    Raises:
        TdsRequestError: any other value.
    """
    for name in TDS_INTEGRATORS:
        if isinstance(integrator, str) and integrator == name:
            return name
    raise TdsRequestError(
        f"unknown integrator {short_repr(integrator)}; expected one of {list(TDS_INTEGRATORS)!r}"
    )


def validate_step_size(h: object, name: str = "h") -> float | None:
    """Return ``h`` as a float, or ``None`` when no step size was requested.

    A TDS step size has to be a finite number greater than zero. ANDES does
    not reject anything else: ``TDS._calc_h_first`` logs a warning for
    ``tstep <= 0`` and quietly flips ``config.fixt`` to variable-step on the
    live System, and NaN or infinity reach the integrator unchecked. The REST
    bodies carry the same rule as a field constraint; the WebSocket start frame,
    the worker's run handlers, sweeps, and ``run_tds`` itself call this, so a bad
    value is refused before it can touch the System. ``name`` is what the
    message calls the value (``tstep`` when it came in as an override).

    Raises:
        TdsRequestError: ``h`` is not a finite number greater than zero.
    """
    if h is None:
        return None
    message = (
        f"step size {short_repr(name)} must be a finite number greater than 0, got {short_repr(h)}"
    )
    # ``bool`` is an ``int`` subclass; ``true`` is not a step size.
    if isinstance(h, bool) or not isinstance(h, int | float | str):
        raise TdsRequestError(message)
    try:
        value = float(h)
    except (ValueError, OverflowError):  # OverflowError: an int too large for a float
        raise TdsRequestError(message) from None
    if not math.isfinite(value) or value <= 0.0:
        raise TdsRequestError(message)
    return value


def validate_tds_overrides(overrides: Mapping[str, float] | None) -> None:
    """Refuse a ``tds_config_overrides`` value that ANDES would take and then misbehave on.

    ``Wrapper.run_tds`` writes every override onto the live ``ss.TDS.config``,
    which ANDES reads without checking. The rule for ``h`` has to hold for the
    overrides that set a step as well, or the same bad value gets in by the
    other door and stays on the System for the rest of the session:

    - ``tstep`` is a step size: finite and greater than zero (see
      :func:`validate_step_size`).
    - ``max_step`` (``dtmax``) bounds the step: finite and not negative. Zero is
      ANDES's own "work it out from the frequency and the time span".
    - ``min_step`` (``dtmin_adapt``) is the floor of a variable step: finite and
      not negative, zero again leaving it to ANDES.
    - ``fixt`` is the fixed-step switch: 0 or 1.
    - Anything else has to be a finite number, since NaN and infinity are never a
      meaningful setting for an ANDES numeric.

    Keys are named as the caller wrote them. Unknown keys are not judged here;
    only a loaded System says which keys are real (``Wrapper.check_tds_request``).

    Raises:
        TdsRequestError: a value breaks its rule.
    """
    for key, value in (overrides or {}).items():
        target = _TDS_OVERRIDE_ALIASES.get(key, key)
        try:
            finite = isinstance(value, int | float) and math.isfinite(value)
        except OverflowError:  # an int too large for a float
            finite = False
        if not finite:
            raise TdsRequestError(
                f"TDS override {short_repr(key)} must be a finite number, got {short_repr(value)}"
            )
        if target == "tstep":
            validate_step_size(value, name=key)
        elif target in ("dtmax", "dtmin_adapt") and value < 0:
            raise TdsRequestError(
                f"TDS override {short_repr(key)} must be 0 (automatic) or greater, got {short_repr(value)}"
            )
        elif target == "fixt" and value not in (0, 1):
            raise TdsRequestError(
                f"TDS override {short_repr(key)} must be 0 (variable step) or 1 (fixed step), "
                f"got {short_repr(value)}"
            )
