"""In-process ANDES wrapper.

Owns a long-lived ``andes.System`` instance for a single session. This class
runs inside a per-session subprocess (spawned by ``andes_app.core.session.SessionManager``)
and is never invoked from the FastAPI event loop directly.

Lifecycle:
    1. ``load_case(path, addfiles=...)`` — calls ``andes.load(setup=False)``.
    2. ``add_disturbance(spec)`` — accepts FaultSpec / ToggleSpec / AlterSpec
       while the System is still pre-setup. Raises ``DisturbanceCommitError``
       once setup has been committed.
    3. ``run_pflow()`` — calls ``ss.setup()`` first if ``not ss.is_setup``
       (verified against ANDES 2.0.0: ``PFlow.run`` does NOT auto-call setup;
       it raises ``IndexError`` on a non-setup System), then ``ss.PFlow.run()``.
    4. ``run_tds(spec, on_step, abort_flag)`` — same setup contract; sets
       ``ss.TDS.callpert`` to a wrapper that emits per-step snapshots and
       checks the abort flag.
    5. ``reload_case()`` — re-runs ``andes.load(setup=False)`` to return to
       editable state. This is the only escape hatch from a committed System;
       it is honest about cost (full re-parse via ``andes.load``).

Thread-safety: This class is NOT thread-safe. It is invoked from a single
thread (the worker subprocess's main thread). The abort flag is set from a
separate worker-side thread that owns the control Pipe (see ``worker.py``).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event
from typing import TYPE_CHECKING, Any, Literal

from andes_app.core.disturbance import AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec
from andes_app.core.errors import (
    CaseLoadError,
    DisturbanceCommitError,
    DisturbanceValidationError,
    NoCaseLoadedError,
    SetupFailedError,
)

# JSON-friendly scalar union surfaced through topology / line-flow APIs.
# Mirrored on the API layer (``schemas.TopologyEntry.params``); see schemas.py.
ParamValue = float | int | str | bool

if TYPE_CHECKING:
    from andes.system import System


@dataclass
class TopologyEntry:
    """One element in a topology summary, keyed by ANDES idx + name."""

    idx: int | str
    name: str
    kind: str  # ANDES model class name (e.g., "Bus", "Line", "GENROU")
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class TopologySnapshot:
    """Substrate's structural view of the loaded case.

    ``state`` is "pre-setup" until ``ss.setup()`` has run; afterwards it's
    "committed". Some computed fields on each element are only populated
    after setup — the schema in the API surface (Unit 4) declares which
    fields are pre-setup-stable vs post-setup-required.
    """

    state: Literal["pre-setup", "committed"]
    buses: list[TopologyEntry]
    lines: list[TopologyEntry]
    transformers: list[TopologyEntry]
    generators: list[TopologyEntry]
    loads: list[TopologyEntry]


@dataclass
class LineFlow:
    """Per-line P/Q flow at terminal 1 (the ``bus1`` end), in MW / MVAr.

    Computed from the ANDES standard pi-equivalent line equation: the line's
    power injection at ``bus1`` (which is exactly what ANDES's own ``Line.a1``
    equation computes).
    """

    p: float
    q: float
    from_idx: int | str
    to_idx: int | str


@dataclass
class PflowResult:
    """Power-flow run result. Keyed by ANDES idx."""

    converged: bool
    iterations: int
    mismatch: float
    bus_voltages: dict[int | str, float]
    bus_angles: dict[int | str, float]
    line_flows: dict[str, LineFlow] = field(default_factory=dict)


@dataclass
class TdsBatchResult:
    """Time-domain simulation batch result (post-completion delivery).

    Streaming TDS uses a different code path (Unit 6) where the worker emits
    Arrow IPC frames per integration step into the data Pipe.
    """

    converged: bool
    final_t: float
    callpert_count: int  # how many times the per-step hook fired


class Wrapper:
    """Synchronous wrapper around a single ``andes.System`` instance.

    Public methods are the substrate's domain API. Each invocation runs to
    completion before the next can start (single-threaded contract). The
    caller (the worker subprocess's main loop) is responsible for serializing
    invocations.
    """

    def __init__(self) -> None:
        self._ss: System | None = None
        self._case_path: Path | None = None
        self._addfiles: list[Path] | None = None
        self._setup_failed: bool = False  # marks "requires reload"

    # ----- lifecycle -----

    def load_case(
        self, path: str | Path, addfiles: list[str | Path] | None = None
    ) -> TopologySnapshot:
        """Load an ANDES case file with ``setup=False`` so disturbances can be
        added before commit. Resets all wrapper state.

        Raises ``CaseLoadError`` on any failure (file not found, parse error,
        format detection failure). The wrapper survives the failure — a
        subsequent ``load_case`` call with a valid path works.
        """
        import andes  # heavy import — kept lazy

        case_path = Path(path)
        resolved_addfiles: list[Path] | None = (
            [Path(a) for a in addfiles] if addfiles else None
        )

        if not case_path.exists():
            raise CaseLoadError(str(case_path), "file does not exist")

        try:
            ss = andes.load(
                str(case_path),
                addfile=[str(a) for a in resolved_addfiles]
                if resolved_addfiles
                else None,
                setup=False,
                no_output=True,
                default_config=True,
            )
        except Exception as exc:  # noqa: BLE001 — wrap and re-raise
            raise CaseLoadError(str(case_path), str(exc)) from exc

        if ss is None:
            raise CaseLoadError(str(case_path), "andes.load returned None")

        self._ss = ss
        self._case_path = case_path
        self._addfiles = resolved_addfiles
        self._setup_failed = False
        return self._topology_snapshot_locked()

    def reload_case(self) -> TopologySnapshot:
        """Re-load the current case to return to pre-setup state.

        Honest about cost: this calls ``andes.load(setup=False)`` again — full
        re-parse. ANDES has no public mechanism to skip the parse and only
        revert ``is_setup``; ``System.reset()`` always re-calls setup, and
        ``System.reload()`` always re-parses.
        """
        if self._case_path is None:
            raise NoCaseLoadedError("no case has been loaded; call load_case() first")
        return self.load_case(
            self._case_path,
            addfiles=[str(a) for a in self._addfiles] if self._addfiles else None,
        )

    # ----- introspection -----

    def topology_snapshot(self) -> TopologySnapshot:
        """Return the current topology view. ``state`` reflects whether ``setup()``
        has been called."""
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        return self._topology_snapshot_locked()

    def _topology_snapshot_locked(self) -> TopologySnapshot:
        assert self._ss is not None
        ss = self._ss
        state: Literal["pre-setup", "committed"] = (
            "committed" if ss.is_setup else "pre-setup"
        )
        return TopologySnapshot(
            state=state,
            buses=_collect_models(ss, ["Bus"]),
            lines=_collect_models(ss, ["Line"]),
            transformers=[],  # ANDES models transformers within Line; revisit if a Transformer model surfaces
            generators=_collect_models(
                ss,
                ["PV", "Slack", "GENROU", "GENCLS"],
            ),
            loads=_collect_models(ss, ["PQ"]),
        )

    # ----- disturbance management -----

    def add_disturbance(self, spec: DisturbanceSpec) -> int | str:
        """Add a disturbance to the pre-setup System. Returns the assigned
        ANDES idx of the created device.

        Raises ``DisturbanceCommitError`` if setup has been committed; the
        caller must call ``reload_case()`` to add more.
        """
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        if self._ss.is_setup:
            raise DisturbanceCommitError()

        if isinstance(spec, FaultSpec):
            kwargs = {
                "bus": spec.bus_idx,
                "tf": spec.tf,
                "tc": spec.tc,
                "xf": spec.xf,
                "rf": spec.rf,
            }
            model_name = "Fault"
        elif isinstance(spec, ToggleSpec):
            kwargs = {
                "model": spec.model,
                "dev": spec.dev_idx,
                "t": spec.t,
            }
            model_name = "Toggle"
        elif isinstance(spec, AlterSpec):
            kwargs = {
                "model": spec.model,
                "dev": spec.dev_idx,
                "src": spec.src,
                "t": spec.t,
                "value": spec.value,
            }
            model_name = "Alter"
        else:  # pragma: no cover — Pydantic discriminator should prevent this
            raise DisturbanceValidationError(
                f"unknown disturbance kind: {type(spec).__name__}"
            )

        try:
            idx: int | str = self._ss.add(model_name, kwargs)
        except Exception as exc:  # noqa: BLE001
            raise DisturbanceValidationError(
                f"ANDES rejected {model_name} spec: {exc}"
            ) from exc
        return idx

    # ----- runs -----

    def run_pflow(self) -> PflowResult:
        """Run power flow. Calls ``ss.setup()`` first if not yet committed
        (verified: ``PFlow.run`` does not auto-call setup).
        """
        ss = self._require_loaded()
        self._ensure_setup()
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
            for i, idx in enumerate(ss.Bus.idx.v):
                bus_voltages[idx] = float(ss.Bus.v.v[i])
                bus_angles[idx] = float(ss.Bus.a.v[i])

        line_flows = _extract_line_flows(ss) if converged else {}

        return PflowResult(
            converged=converged,
            iterations=iterations,
            mismatch=mismatch,
            bus_voltages=bus_voltages,
            bus_angles=bus_angles,
            line_flows=line_flows,
        )

    def run_tds(
        self,
        tf: float,
        h: float | None = None,
        on_step: Callable[[float, System], None] | None = None,
        abort_flag: Event | None = None,
    ) -> TdsBatchResult:
        """Run a time-domain simulation up to ``tf`` seconds.

        ``on_step`` is invoked once per integration step via ANDES's
        ``TDS.callpert`` hook. ``abort_flag``, when set, causes the wrapper
        to set ``ss.TDS.busted = True`` on the next callpert invocation,
        cleanly terminating the integration loop within ~2 steps.
        """
        ss = self._require_loaded()
        self._ensure_setup()

        # ANDES TDS requires a converged power-flow solution as initial conditions.
        # Run PF first if it hasn't been solved (idempotent — re-running converged
        # PF is fast and a no-op semantically).
        if not bool(getattr(ss.PFlow, "converged", False)):
            ss.PFlow.run()
            if not bool(getattr(ss.PFlow, "converged", False)):
                raise SetupFailedError(
                    "power flow did not converge; TDS cannot begin"
                )

        # Configure the TDS endpoint and step size
        ss.TDS.config.tf = tf
        if h is not None:
            ss.TDS.config.h = h

        callpert_count = 0

        def _callpert(t: float, system: System) -> None:
            nonlocal callpert_count
            callpert_count += 1
            if abort_flag is not None and abort_flag.is_set():
                system.TDS.busted = True
                return
            if on_step is not None:
                on_step(t, system)

        ss.TDS.callpert = _callpert

        # Reset busted flag in case of re-run on the same System
        ss.TDS.busted = False

        try:
            ss.TDS.run()
        except Exception as exc:  # noqa: BLE001
            raise SetupFailedError(f"TDS.run raised: {exc}") from exc

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
        )

    # ----- internals -----

    def _require_loaded(self) -> System:
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        return self._ss

    def _ensure_setup(self) -> None:
        """Call ``ss.setup()`` if not yet committed.

        ANDES 2.0.0 verified contract (see ANDES_VERSIONS.md, contract #6):
        ``PFlow.run`` and ``TDS.run`` do NOT auto-call setup. We must call it
        explicitly. If setup returns False or raises, raise SetupFailedError
        and mark the wrapper as "requires reload" so the next caller is
        directed to ``reload_case``.
        """
        ss = self._require_loaded()
        if ss.is_setup:
            return
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        try:
            ok = ss.setup()
        except Exception as exc:  # noqa: BLE001
            self._setup_failed = True
            raise SetupFailedError(f"setup() raised: {exc}") from exc
        if not ok:
            self._setup_failed = True
            raise SetupFailedError("setup() returned False")


# Per-model param subsets surfaced through the topology API. The Inspector
# Properties tab shows these; absent params (None or wrong length) are
# silently skipped per the defensive contract in ``_extract_params``.
_PARAMS_BY_MODEL: dict[str, tuple[str, ...]] = {
    "Bus": ("Vn", "vmax", "vmin", "area", "zone"),
    "Line": ("r", "x", "b", "g", "tap", "phi", "bus1", "bus2"),
    "PV": ("Sn", "Vn", "bus", "p0", "v0", "pmax", "pmin", "qmax", "qmin"),
    "Slack": ("Sn", "Vn", "bus", "p0", "v0", "a0", "pmax", "pmin", "qmax", "qmin"),
    "GENROU": ("Sn", "Vn", "bus", "H", "D", "M", "ra", "xl", "xd", "xq", "xd1", "xq1"),
    "GENCLS": ("Sn", "Vn", "bus", "H", "D", "M", "ra", "xl"),
    "PQ": ("p0", "q0", "bus", "Vn"),
    "Shunt": ("g", "b", "bus", "Vn"),
}


def _coerce_scalar(value: Any) -> ParamValue | None:
    """Coerce a numpy / Python scalar to a JSON-friendly primitive.

    Returns None if the value is None, an array of length != 1, or a type the
    schema doesn't accept. The topology endpoint silently drops None entries
    so this is a safe filter rather than an error path.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        # Reject non-finite floats — the schema doesn't allow NaN / Inf in
        # JSON-serialized topology params.
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    if isinstance(value, str):
        return value
    # numpy scalar: has .item()
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _coerce_scalar(item())
        except (TypeError, ValueError):
            return None
    return None


def _extract_params(model: Any, param_names: tuple[str, ...]) -> list[dict[str, ParamValue]]:
    """For each device in ``model``, return a dict of the requested params.

    Defensive: missing params, zero-length arrays, and length mismatches are
    skipped silently. Returns one dict per device, in the same order as
    ``model.idx.v``.
    """
    n = int(getattr(model, "n", 0))
    if n <= 0:
        return []
    per_device: list[dict[str, ParamValue]] = [{} for _ in range(n)]
    for pname in param_names:
        param = getattr(model, pname, None)
        if param is None:
            continue
        values = getattr(param, "v", None)
        if values is None:
            continue
        try:
            vlist = list(values)
        except TypeError:
            continue
        if len(vlist) != n:
            continue
        for i, raw in enumerate(vlist):
            coerced = _coerce_scalar(raw)
            if coerced is None:
                continue
            per_device[i][pname] = coerced
    return per_device


def _collect_models(ss: System, model_names: list[str]) -> list[TopologyEntry]:
    """Walk a list of ANDES model class names on the System and collect their
    devices into a flat list keyed by idx + name.

    ANDES exposes models as attributes on the System (e.g., ``ss.Bus``,
    ``ss.Line``). Each model has ``.idx.v`` (idx values) and ``.name.v``
    (human names) when populated. Empty / absent models are skipped.
    """
    entries: list[TopologyEntry] = []
    for model_name in model_names:
        model = getattr(ss, model_name, None)
        if model is None:
            continue
        idx_var = getattr(model, "idx", None)
        if idx_var is None:
            continue
        idx_values = list(getattr(idx_var, "v", []))
        if not idx_values:
            continue
        name_values: list[str]
        name_var = getattr(model, "name", None)
        if name_var is not None and getattr(name_var, "v", None) is not None:
            name_values = [str(v) for v in name_var.v]
        else:
            name_values = [str(idx) for idx in idx_values]
        param_subset = _PARAMS_BY_MODEL.get(model_name, ())
        per_device_params = (
            _extract_params(model, param_subset) if param_subset else [{} for _ in idx_values]
        )
        for i, (idx, name) in enumerate(zip(idx_values, name_values, strict=True)):
            params = per_device_params[i] if i < len(per_device_params) else {}
            entries.append(
                TopologyEntry(idx=idx, name=name, kind=model_name, params=params)
            )
    return entries


def _extract_line_flows(ss: System) -> dict[str, LineFlow]:
    """Compute per-line P/Q flow at terminal 1 from a converged power-flow
    solution. Returns MW / MVAr (scaled by ``ss.config.mva``).

    ANDES does NOT expose ``ss.Line.p1.v`` directly. We compute the same
    expression that ANDES injects at the ``bus1`` power-balance equation
    (``ss.Line.a1.e_str`` / ``ss.Line.v1.e_str``). This is the standard
    pi-equivalent line model with off-nominal tap and phase shift:

        P1 = ue * (v1^2 * (gh + ghk) * itap2
                   - v1 * v2 * (ghk * cos(a1 - a2 - phi)
                                + bhk * sin(a1 - a2 - phi)) * itap)

        Q1 = ue * (-v1^2 * (bh + bhk) * itap2
                   - v1 * v2 * (ghk * sin(a1 - a2 - phi)
                                - bhk * cos(a1 - a2 - phi)) * itap)

    where ``ue`` is the line's in-service flag, ``gh+ghk`` and ``bh+bhk`` are
    the line's series + shunt admittance services on the bus1 end,
    ``itap = 1 / |tap|``, ``itap2 = itap**2``, and ``phi`` is the phase shift.

    All inputs are pulled defensively via ``getattr``; any missing attribute
    (e.g., on an unexpected ANDES API change) returns an empty dict and logs
    a warning. The PF run itself is not affected — line flows are
    best-effort.
    """
    log = logging.getLogger("andes-app.wrapper.line_flows")

    line = getattr(ss, "Line", None)
    if line is None:
        return {}
    idx_var = getattr(line, "idx", None)
    if idx_var is None:
        return {}
    idx_values = list(getattr(idx_var, "v", []))
    if not idx_values:
        return {}

    needed = (
        "v1", "v2", "a1", "a2", "phi", "ue",
        "gh", "bh", "ghk", "bhk", "itap", "itap2",
        "bus1", "bus2",
    )
    arrays: dict[str, list[Any]] = {}
    for name in needed:
        attr = getattr(line, name, None)
        if attr is None:
            log.warning("line attribute %r missing; cannot extract line flows", name)
            return {}
        values = getattr(attr, "v", None)
        if values is None:
            log.warning("line.%s.v is None; cannot extract line flows", name)
            return {}
        try:
            arrays[name] = list(values)
        except TypeError:
            log.warning("line.%s.v not iterable; cannot extract line flows", name)
            return {}

    n = len(idx_values)
    for name, vlist in arrays.items():
        if len(vlist) != n:
            log.warning(
                "line.%s.v length %d != idx length %d; cannot extract line flows",
                name, len(vlist), n,
            )
            return {}

    try:
        mva_base = float(getattr(ss.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0

    flows: dict[str, LineFlow] = {}
    try:
        for i, line_idx in enumerate(idx_values):
            v1 = float(arrays["v1"][i])
            v2 = float(arrays["v2"][i])
            a1 = float(arrays["a1"][i])
            a2 = float(arrays["a2"][i])
            phi = float(arrays["phi"][i])
            ue = float(arrays["ue"][i])
            gh = float(arrays["gh"][i])
            bh = float(arrays["bh"][i])
            ghk = float(arrays["ghk"][i])
            bhk = float(arrays["bhk"][i])
            itap = float(arrays["itap"][i])
            itap2 = float(arrays["itap2"][i])
            d = a1 - a2 - phi
            cos_d = math.cos(d)
            sin_d = math.sin(d)
            p_pu = ue * (
                v1 * v1 * (gh + ghk) * itap2
                - v1 * v2 * (ghk * cos_d + bhk * sin_d) * itap
            )
            q_pu = ue * (
                -v1 * v1 * (bh + bhk) * itap2
                - v1 * v2 * (ghk * sin_d - bhk * cos_d) * itap
            )
            if not (math.isfinite(p_pu) and math.isfinite(q_pu)):
                continue
            from_idx = arrays["bus1"][i]
            to_idx = arrays["bus2"][i]
            # Coerce numpy scalars (bus indices may be numpy ints from ANDES)
            from_coerced = _coerce_scalar(from_idx)
            to_coerced = _coerce_scalar(to_idx)
            # Bus indices must be int|str — bool/float are unexpected here
            from_bus: int | str
            to_bus: int | str
            if isinstance(from_coerced, int | str) and not isinstance(from_coerced, bool):
                from_bus = from_coerced
            else:
                from_bus = str(from_idx)
            if isinstance(to_coerced, int | str) and not isinstance(to_coerced, bool):
                to_bus = to_coerced
            else:
                to_bus = str(to_idx)
            flows[str(line_idx)] = LineFlow(
                p=p_pu * mva_base,
                q=q_pu * mva_base,
                from_idx=from_bus,
                to_idx=to_bus,
            )
    except Exception as exc:  # noqa: BLE001 — defensive: never crash PF
        log.warning("line-flow extraction failed: %s", exc)
        return {}
    return flows
