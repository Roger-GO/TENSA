"""Continuation power flow."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

from tensa.core.cpf_options import CpfRun, cpf_run_applied, direction_targets, validate_cpf_options
from tensa.core.cpf_result import CpfGeneratorTrace, CpfLimitEvent, CpfResult
from tensa.core.errors import AndesAppError, CpfDivergedError, CpfPrerequisiteError
from tensa.core.wrapper.base import WrapperBase

if TYPE_CHECKING:
    from andes.system import System


class CpfMixin(WrapperBase):
    """Continuation power flow: the PV curve and the single-bus QV curve."""

    def run_cpf(
        self,
        *,
        direction: str = "load",
        step: float | None = None,
        max_iter: int | None = None,
        load_increase: list[dict[str, Any]] | None = None,
        generator_increase: list[dict[str, Any]] | None = None,
        enforce_q_limits: bool | None = None,
        stop_at: str = "nose",
    ) -> CpfResult:
        """Run continuation power flow — Unit 12.

        Args:
            direction: what lambda increases. ``"load"`` (default) scales
                every load and every PV generator in proportion
                (``ss.CPF.run(load_scale=2.0)``), ``"load-only"`` the
                loads alone, ``"gen"`` the PV generators alone, and
                ``"custom"`` the devices ``load_increase`` and
                ``generator_increase`` name. With the first three
                ``lambda = 1`` is twice the base value.
            step: optional initial continuation step size. Written to
                ``ss.CPF.config.step`` for this run when not None.
            max_iter: optional cap on the number of continuation steps.
                Written to ``ss.CPF.config.max_steps`` for this run
                when not None. ANDES's own ``max_iter`` config is the
                Newton corrector iterations per step, *not* the total
                continuation count — we map the user-facing parameter
                name (which the plan inherits from natural-language
                terminology) onto the ANDES ``max_steps`` field where
                it actually controls truncation.
            load_increase: for a custom direction, ``{"idx", "p", "q"}``
                per PQ load: the MW and MVAr it gains for each unit of
                lambda.
            generator_increase: for a custom direction, ``{"idx", "p"}``
                per PV generator, in MW for each unit of lambda.
            enforce_q_limits: switch a PV or slack generator to a PQ bus
                held at ``qmin`` or ``qmax`` when its reactive output
                reaches one along the path. ``None`` keeps the case's
                own setting. Refused when the solved power flow leaves a
                generator past a limit.
            stop_at: ``"nose"`` (default) stops at the nose; ``"full"``
                goes on along the lower branch back to ``lambda = 0``.

        The settings apply to this run only and everything written to the
        System is put back (:mod:`tensa.core.cpf_options`, which also says
        how each of them reaches ANDES). A value out of range raises
        :class:`CpfRequestError` before anything is written.

        Substrate-side gate (per Unit 1a spike): ``CPF.init`` only logs
        a warning when ``system.PFlow.converged`` is False. We MUST gate
        on ``ss.PFlow.converged is True`` ourselves and raise
        :class:`CpfPrerequisiteError` otherwise — same discipline as
        :meth:`run_eig`.

        Side effects: ``CPF._snapshot_base`` (cpf.py:462) snapshots the
        base case (PQ.vcmp, dae.x/y, p0/q0/pg) before the run and
        ``_restore_base`` (cpf.py:524) restores it on both success and
        failure (try/finally at cpf.py:255-259). The substrate does not
        have to clean up after a CPF run.

        A clean ``False`` return (``ok=False``) does NOT raise. Without a
        nose (e.g., hit ``max_steps``) the result is returned with
        ``truncated=True`` and ``nose_idx=-1`` so the UI can surface the
        truncation note; a full curve that breaks off on the lower branch
        keeps its nose and has ``complete=False``.

        An unexpected exception inside ``ss.CPF.run()`` raises
        :class:`CpfDivergedError` so the routes layer can return 422
        with the ANDES detail.
        """
        validate_cpf_options(
            direction=direction,
            stop_at=stop_at,
            step=step,
            max_steps=max_iter,
            enforce_q_limits=enforce_q_limits,
        )
        ss = self._require_loaded()
        self._ensure_setup()
        # Independent PF gate — ANDES's own check is unsafe (only warns).
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise CpfPrerequisiteError(
                "Run PFlow first; CPF requires a converged operating point."
            )
        targets = direction_targets(
            ss,
            direction=direction,
            load_increase=load_increase,
            generator_increase=generator_increase,
        )

        try:
            with cpf_run_applied(
                ss,
                enforce_q_limits=enforce_q_limits,
                stop_at=stop_at,
                step=step,
                max_steps=max_iter,
            ) as run:
                ok = bool(ss.CPF.run(**targets))
        except AndesAppError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CpfDivergedError(
                f"Continuation power flow failed: {exc}"
            ) from exc

        return _build_cpf_result(ss, mode="pv", ok=ok, run=run, direction=direction)

    def run_cpf_qv(
        self,
        *,
        bus_idx: str,
        q_range: float = 5.0,
        enforce_q_limits: bool | None = None,
    ) -> CpfResult:
        """Run a single-bus QV-curve continuation — Unit 12.

        Args:
            bus_idx: ANDES bus idx (string-coerced; ANDES accepts both
                ``int`` and ``str`` here depending on case file format).
            q_range: passed through to ``CPF.run_qv(q_range=...)``.
                Default 5.0 matches ANDES's own default
                (``cpf.py:273``).
            enforce_q_limits: as in :meth:`run_cpf`.

        Same prerequisite gate as :meth:`run_cpf`. ``CPF.run_qv``
        requires at least one PQ device at ``bus_idx``; ANDES raises a
        ``ValueError`` on missing PQ — the substrate forwards as
        :class:`CpfDivergedError` (mapped to 422).

        Returns a :class:`CpfResult` with ``mode="qv"`` and a single
        bus key in ``voltages_per_bus`` keyed off ``bus_idx``.
        ``lambdas`` carries the ``qv_q`` array (reactive-power axis);
        the UI labels the X-axis "Q (pu)" instead of "lambda" based on
        ``mode``. The curve stops at its nose.
        """
        validate_cpf_options(enforce_q_limits=enforce_q_limits)
        ss = self._require_loaded()
        self._ensure_setup()
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise CpfPrerequisiteError(
                "Run PFlow first; CPF requires a converged operating point."
            )

        # ANDES accepts both int and str bus idxes. Try numeric coercion
        # first (most case files use int idxes for buses), falling back
        # to the raw string. The error path forwards to CpfDivergedError.
        coerced_idx: int | str
        try:
            coerced_idx = int(bus_idx)
        except (TypeError, ValueError):
            coerced_idx = str(bus_idx)

        try:
            with cpf_run_applied(ss, enforce_q_limits=enforce_q_limits) as run:
                ss.CPF.run_qv(coerced_idx, q_range=float(q_range))
        except AndesAppError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CpfDivergedError(
                f"QV-curve run failed for bus {bus_idx!r}: {exc}"
            ) from exc

        return _build_cpf_result(ss, mode="qv", ok=True, qv_bus=str(bus_idx), run=run)


# ---- CPF helpers (Unit 12) ------------------------------------------------


def _build_cpf_result(
    ss: System,
    *,
    mode: str,
    ok: bool,
    qv_bus: str | None = None,
    run: CpfRun | None = None,
    direction: str | None = None,
) -> CpfResult:
    """Build a :class:`CpfResult` from the post-run ``ss.CPF`` state.

    Handles both PV-curve (``mode="pv"``, full multi-bus sweep) and
    QV-curve (``mode="qv"``, single-bus reactive-injection sweep)
    payloads. The two share the same wire shape so the UI can use one
    chart component for both.

    Per Unit 1a spike:

    - PV: ``CPF.lam`` (1-D length nsteps), ``CPF.V`` (nbus, nsteps).
    - QV: ``CPF.qv_q`` (1-D), ``CPF.qv_v`` (1-D, single bus).

    Truncation detection: a nose-finding run carries a ``NOSE`` event in
    ``CPF.events``. Without one, ``nose_idx=-1`` and ``truncated=True``
    so the UI can surface the "did not reach nose" note. ``ok`` is
    ANDES's own verdict and becomes ``complete``: a full curve that
    breaks off on the lower branch has its nose and is not complete.

    ``run`` is what read the generators while the routine ran
    (:class:`~tensa.core.cpf_options.CpfRun`); it gives each generator's
    reactive output at every step and the steps at which one is held at
    a limit.
    """
    cpf = ss.CPF
    done_msg = str(getattr(cpf, "done_msg", "") or "")
    events = list(getattr(cpf, "events", None) or [])
    path = run.path(getattr(cpf, "V", None)) if run is not None else None
    q_limits_enforced = run.enforce_q_limits if run is not None else False
    stop_at = run.stop_at if run is not None else "nose"

    def _finite_prefix_len(series: list[float]) -> int:
        """Length of the leading run of finite values.

        A CPF that hits max steps without converging leaves NaN in the
        tail of ``lam`` / ``V`` — those are not JSON-serialisable (the
        response 500s on ``Out of range float values``). The valid
        prefix is still a useful partial nose curve, so truncate rather
        than discard.
        """
        for i, x in enumerate(series):
            if not math.isfinite(x):
                return i
        return len(series)

    def _generators(
        lambdas: list[float], nose_idx: int
    ) -> tuple[list[CpfGeneratorTrace], list[CpfLimitEvent]]:
        # No steps, no traces: a QV run that failed has no curve to read them on.
        if path is None or not lambdas:
            return [], []
        return path.traces(lambdas, nose_idx)

    if mode == "qv":
        q_arr = getattr(cpf, "qv_q", None)
        v_arr = getattr(cpf, "qv_v", None)
        try:
            lambdas = [float(x) for x in (q_arr if q_arr is not None else [])]
        except (TypeError, ValueError):
            lambdas = []
        try:
            voltages = [float(x) for x in (v_arr if v_arr is not None else [])]
        except (TypeError, ValueError):
            voltages = []
        keep = min(_finite_prefix_len(lambdas), _finite_prefix_len(voltages))
        if path is not None:
            keep = min(keep, path.finite_steps())
        lambdas = lambdas[:keep]
        voltages = voltages[:keep]
        bus_label = qv_bus if qv_bus is not None else str(
            getattr(cpf, "qv_bus", "")
        )
        bus_idxes = [bus_label] if bus_label else []
        voltages_per_bus = (
            {bus_label: voltages} if bus_label else {}
        )
        # Nose detection: argmax over the lambda axis. For QV the
        # "nose" is the maximum reactive injection before voltage
        # collapse — treat the same way.
        nose_idx = -1
        if lambdas and ok:
            nose_idx = int(_argmax(lambdas))
        truncated = (not ok) or nose_idx < 0
        # The axis of a QV result is the reactive power at the bus, so its
        # peak is the largest of those. ``CPF.max_lam`` is the routine's own
        # parameter, a fraction of the swept range, and not on that axis.
        max_lam = max(lambdas) if lambdas else 0.0
        generators, limit_events = _generators(lambdas, nose_idx)
        return CpfResult(
            lambdas=lambdas,
            voltages_per_bus=voltages_per_bus,
            bus_idxes=bus_idxes,
            nose_idx=nose_idx,
            max_lam=max_lam,
            truncated=truncated,
            done_msg=done_msg,
            mode="qv",
            generators=generators,
            limit_events=limit_events,
            q_limits_enforced=q_limits_enforced,
            stop_at=stop_at,
            complete=not truncated,
        )

    # PV-curve path.
    lam = getattr(cpf, "lam", None)
    v_matrix = getattr(cpf, "V", None)
    try:
        lambdas = [float(x) for x in (lam if lam is not None else [])]
    except (TypeError, ValueError):
        lambdas = []

    bus_idxes_raw: list[Any] = []
    try:
        bus_idxes_raw = list(ss.Bus.idx.v)
    except (AttributeError, TypeError):
        bus_idxes_raw = []
    bus_idxes = [str(b) for b in bus_idxes_raw]

    voltages_per_bus = {}
    if v_matrix is not None and bus_idxes:
        try:
            n_rows = int(v_matrix.shape[0])
        except (AttributeError, IndexError, TypeError):
            n_rows = 0
        # Defensive: use the smaller of n_rows and len(bus_idxes) so a
        # mismatch (which the spike never observed but guards against
        # future ANDES bus-elimination edge cases) doesn't index out
        # of range.
        for i in range(min(n_rows, len(bus_idxes))):
            try:
                row = [float(x) for x in v_matrix[i]]
            except (TypeError, ValueError):
                row = []
            voltages_per_bus[bus_idxes[i]] = row

    # Truncate every series to the common finite prefix — an unconverged
    # CPF (e.g. "Reached max steps") leaves NaN tails that would 500 the
    # JSON response; the finite prefix is still a useful partial curve.
    keep = _finite_prefix_len(lambdas)
    for row in voltages_per_bus.values():
        keep = min(keep, _finite_prefix_len(row))
    if path is not None:
        keep = min(keep, path.finite_steps())
    lambdas = lambdas[:keep]
    voltages_per_bus = {k: v[:keep] for k, v in voltages_per_bus.items()}

    # Nose detection: a NOSE event in CPF.events tells us the run hit
    # the maximum-loadability point. A run that stops at the nose and
    # reports failure never left the base case (one point, no curve);
    # one that goes on past the nose and then fails still has it.
    has_nose_event = any(
        isinstance(ev, dict) and ev.get("type") == "NOSE" for ev in events
    )
    nose_found = has_nose_event and (ok or len(lambdas) > 1)
    nose_idx = _first_turn(lambdas) if lambdas and nose_found else -1
    truncated = nose_idx < 0

    # The loadability is lambda at the nose. A lower branch can climb back
    # above it (generators switching at their limits on the way down), and
    # those points are not reached from the base case by adding load.
    max_lam = float(getattr(cpf, "max_lam", 0.0) or 0.0)
    if nose_idx >= 0:
        max_lam = lambdas[nose_idx]
    if not math.isfinite(max_lam):
        max_lam = 0.0
    if not max_lam and lambdas:
        max_lam = max(lambdas)

    generators, limit_events = _generators(lambdas, nose_idx)
    return CpfResult(
        lambdas=lambdas,
        voltages_per_bus=voltages_per_bus,
        bus_idxes=bus_idxes,
        nose_idx=nose_idx,
        max_lam=max_lam,
        truncated=truncated,
        done_msg=done_msg,
        mode="pv",
        generators=generators,
        limit_events=limit_events,
        q_limits_enforced=q_limits_enforced,
        stop_at=stop_at,
        complete=ok and not truncated,
        direction=direction,
    )


def _first_turn(lambdas: list[float]) -> int:
    """The index of the point after which lambda first goes down: the nose.

    A run that stops at the nose has at most one point past it, so this is
    where lambda is largest. A full curve is the upper branch up to here and
    the lower branch after. The margin is the one ANDES itself uses to call
    a nose (``cpf.py:681``). A series that never goes down ends at its nose.
    """
    for i in range(len(lambdas) - 1):
        if lambdas[i + 1] < lambdas[i] - 1e-8:
            return i
    return len(lambdas) - 1


def _argmax(values: list[float]) -> int:
    """Return the index of the maximum value. Empty input returns 0."""
    if not values:
        return 0
    best_i = 0
    best_v = values[0]
    for i in range(1, len(values)):
        if values[i] > best_v:
            best_v = values[i]
            best_i = i
    return best_i
