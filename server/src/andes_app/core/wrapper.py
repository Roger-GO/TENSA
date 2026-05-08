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
import re
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
    ElementNotFoundError,
    ElementValidationError,
    NoCaseLoadedError,
    SetupFailedError,
    SystemAlreadyLoadedError,
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

    Lines vs transformers split (Unit 2): ANDES models 2-winding transformers
    within the ``Line`` model class with a non-default ``tap`` or ``phi``.
    The substrate splits them into two buckets at the boundary so the SLD
    can render the transformer-2w icon at the line midpoint.
    """

    state: Literal["pre-setup", "committed"]
    buses: list[TopologyEntry]
    lines: list[TopologyEntry]
    transformers: list[TopologyEntry]
    generators: list[TopologyEntry]
    loads: list[TopologyEntry]
    shunts: list[TopologyEntry] = field(default_factory=list)


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
        # ``replay_buffer`` records every successful pre-setup add so a
        # blank session (no underlying case file) can recover its topology
        # via ``reload_case`` — the v0.1.x workaround for ANDES's missing
        # pre-setup ``delete()`` API. Capped at REPLAY_BUFFER_MAX entries
        # with oldest-eviction; older entries are dropped silently with a
        # logged warning.
        self._replay_buffer: list[tuple[str, dict[str, Any]]] = []

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
        # Loading from a real case file invalidates any blank-session replay
        # history — that buffer is only meaningful for sessions whose entire
        # state was built up via ``add_element``.
        self._replay_buffer = []
        return self._topology_snapshot_locked()

    def reload_case(self) -> TopologySnapshot:
        """Re-load the current case to return to pre-setup state.

        Honest about cost: this calls ``andes.load(setup=False)`` again — full
        re-parse. ANDES has no public mechanism to skip the parse and only
        revert ``is_setup``; ``System.reset()`` always re-calls setup, and
        ``System.reload()`` always re-parses.

        Blank-session reload (no underlying case file): re-create
        ``andes.System()`` and replay every entry recorded in
        ``self._replay_buffer``. Failed replays leave the wrapper in a
        partial state and raise ``ElementValidationError`` — caller can
        retry ``create_blank()`` to start over.
        """
        if self._case_path is None:
            if not self._replay_buffer:
                raise NoCaseLoadedError(
                    "no case has been loaded; call load_case() or create_blank() first"
                )
            return self._reload_blank_locked()
        return self.load_case(
            self._case_path,
            addfiles=[str(a) for a in self._addfiles] if self._addfiles else None,
        )

    def _reload_blank_locked(self) -> TopologySnapshot:
        """Re-create the blank System and replay every recorded add."""
        import andes  # heavy import — kept lazy

        log = logging.getLogger("andes-app.wrapper.replay")
        ss = andes.System()
        replay = list(self._replay_buffer)  # snapshot — replays may mutate
        self._ss = ss
        self._setup_failed = False
        self._replay_buffer = []
        for model_name, params in replay:
            # Pass a fresh copy each iteration — ANDES mutates the dict.
            try:
                ss.add(model_name, dict(params))
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "replay rejected by ANDES on model=%r: %s",
                    model_name,
                    _sanitize_message(str(exc)),
                )
                raise ElementValidationError(
                    f"replay failed at model {model_name!r}: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
            self._replay_buffer.append((model_name, dict(params)))
        return self._topology_snapshot_locked()

    # ----- introspection -----

    def topology_snapshot(self) -> TopologySnapshot:
        """Return the current topology view. ``state`` reflects whether ``setup()``
        has been called."""
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        return self._topology_snapshot_locked()

    def _topology_snapshot_locked(self) -> TopologySnapshot:
        """Build the topology snapshot from the loaded System.

        Lines and transformers are both backed by ANDES's ``Line`` model;
        the substrate splits them at the boundary using the ANDES-default
        heuristic ``tap != 1.0 OR phi != 0.0``. Pure transmission lines stay
        in ``lines``; off-nominal-tap or phase-shifting branches move to
        ``transformers``.
        """
        assert self._ss is not None
        ss = self._ss
        state: Literal["pre-setup", "committed"] = (
            "committed" if ss.is_setup else "pre-setup"
        )
        all_lines = _collect_models(ss, ["Line"])
        lines, transformers = _split_lines_transformers(all_lines)
        return TopologySnapshot(
            state=state,
            buses=_collect_models(ss, ["Bus"]),
            lines=lines,
            transformers=transformers,
            generators=_collect_models(
                ss,
                ["PV", "Slack", "GENROU", "GENCLS"],
            ),
            loads=_collect_models(ss, ["PQ", "ZIP"]),
            shunts=_collect_models(ss, ["Shunt"]),
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
                f"ANDES rejected {model_name} spec: {_sanitize_message(str(exc))}"
            ) from exc
        return idx

    # ----- topology mutation (Unit 2) -----

    def add_element(
        self, model: str, params: dict[str, Any]
    ) -> TopologyEntry:
        """Add a topology element (Bus, Line, generator, load, shunt) to the
        pre-setup System.

        Mirrors ``add_disturbance``'s pre-setup gate. Whitelists every key in
        ``params`` against ``_PARAMS_BY_MODEL[model]`` BEFORE invoking
        ``ss.add(...)`` so unknown keys never reach ANDES. On success,
        records the call in ``self._replay_buffer`` so a blank session can
        recover via ``reload_case()``.

        Returns a freshly-built ``TopologyEntry`` for the new element.
        """
        ss = self._require_loaded()
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        if ss.is_setup:
            raise DisturbanceCommitError()

        allowed = allowed_param_names(model)
        if not allowed:
            raise ElementValidationError(
                f"unknown model {model!r}; supported models: "
                f"{sorted(_PARAMS_BY_MODEL.keys())}"
            )
        unknown = sorted(set(params.keys()) - set(allowed))
        if unknown:
            raise ElementValidationError(
                f"unknown param keys for {model}: {unknown}; "
                f"allowed keys: {list(allowed)}"
            )

        # Snapshot the params for replay BEFORE ANDES gets a chance to
        # mutate the dict in-place — ``ss.add`` pops ``idx`` (and possibly
        # other identifier fields) out of the input dict during model
        # registration. Without the pre-call copy, replay would call
        # ``ss.add`` without the idx, and ANDES would auto-prefix the new
        # device's idx (``Bus_1`` instead of ``1``), breaking idempotent
        # reload.
        replay_snapshot = dict(params)
        try:
            idx = ss.add(model, params)
        except Exception as exc:  # noqa: BLE001
            raise ElementValidationError(
                f"ANDES rejected add({model!r}, ...): {_sanitize_message(str(exc))}"
            ) from exc

        # Cap the replay buffer at REPLAY_BUFFER_MAX with oldest-eviction.
        if len(self._replay_buffer) >= REPLAY_BUFFER_MAX:
            dropped, _ = self._replay_buffer.pop(0)
            logging.getLogger("andes-app.wrapper.replay").warning(
                "replay buffer at cap (%d); dropping oldest entry (model=%r)",
                REPLAY_BUFFER_MAX, dropped,
            )
        self._replay_buffer.append((model, replay_snapshot))

        # Build the TopologyEntry from the just-added device.
        entry = self._lookup_topology_entry(model, idx)
        if entry is None:
            # Defensive — ss.add reported success but the device isn't
            # surfaced via the standard introspection path. This indicates
            # a model whose ANDES introspection differs (e.g., a model
            # we haven't tested). Surface a clear error rather than
            # returning a garbage entry.
            raise ElementValidationError(
                f"ANDES accepted add({model!r}) but no device with idx={idx!r} "
                "was found on read-back"
            )
        return entry

    def edit_element(
        self, model: str, idx: int | str, params: dict[str, Any]
    ) -> TopologyEntry:
        """Edit parameters on an existing topology element.

        Same pre-setup gate as ``add_element``. Whitelists keys against
        ``_PARAMS_BY_MODEL[model]``. For each ``(param, value)`` pair, sets
        ``getattr(getattr(ss, model), param).v[i] = value`` where ``i`` is
        the index of ``idx`` in ``ss.<model>.idx.v``.

        Returns the updated ``TopologyEntry``.
        """
        ss = self._require_loaded()
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        if ss.is_setup:
            raise DisturbanceCommitError()

        allowed = allowed_param_names(model)
        if not allowed:
            raise ElementValidationError(
                f"unknown model {model!r}; supported models: "
                f"{sorted(_PARAMS_BY_MODEL.keys())}"
            )
        unknown = sorted(set(params.keys()) - set(allowed))
        if unknown:
            raise ElementValidationError(
                f"unknown param keys for {model}: {unknown}; "
                f"allowed keys: {list(allowed)}"
            )

        model_obj = getattr(ss, model, None)
        if model_obj is None:
            raise ElementValidationError(
                f"model {model!r} not present on the loaded System"
            )
        idx_var = getattr(model_obj, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        # Look up the device by string-equality on idx, since idx values can
        # be ints (from PSS/E .raw) or strings (from .xlsx) and the API
        # surface always passes them as strings.
        idx_str = str(idx)
        try:
            i = next(
                pos for pos, value in enumerate(idx_values) if str(value) == idx_str
            )
        except StopIteration as exc:
            raise ElementNotFoundError(
                f"no {model} with idx={idx!r}"
            ) from exc

        for pname, value in params.items():
            if pname in ("idx", "name"):
                # idx / name updates are not safe at the array-write level —
                # they would desync internal indexes. Reject explicitly.
                raise ElementValidationError(
                    f"editing {pname!r} is not supported; create a new "
                    f"element instead"
                )
            param = getattr(model_obj, pname, None)
            param_v = getattr(param, "v", None) if param is not None else None
            if param_v is None:
                raise ElementValidationError(
                    f"param {pname!r} not editable on {model}"
                )
            try:
                # ANDES service params expose .v as a numpy array — direct
                # element write is the documented way to alter a single
                # device's parameter.
                param_v[i] = value
            except Exception as exc:  # noqa: BLE001
                raise ElementValidationError(
                    f"ANDES rejected {model}.{pname}={value!r}: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc

        entry = self._lookup_topology_entry(model, idx_values[i])
        if entry is None:  # pragma: no cover — should never happen post-write
            raise ElementValidationError(
                f"could not read back {model} idx={idx!r} after edit"
            )
        return entry

    def create_blank(self) -> TopologySnapshot:
        """Create a brand-new empty ``andes.System()`` for this session.

        409s if a System is already loaded — the caller should reload or
        open a fresh session. The replay buffer is reset so the new blank
        session starts from zero.
        """
        if self._ss is not None:
            raise SystemAlreadyLoadedError(
                "a System is already loaded; call reload_case() or open a "
                "fresh session"
            )
        import andes  # heavy import — kept lazy

        self._ss = andes.System()
        self._case_path = None
        self._addfiles = None
        self._setup_failed = False
        self._replay_buffer = []
        return self._topology_snapshot_locked()

    def _lookup_topology_entry(
        self, model: str, idx: int | str
    ) -> TopologyEntry | None:
        """Build a single ``TopologyEntry`` for a given model/idx pair.

        Returns ``None`` if the device isn't present on the System (e.g.,
        ``ss.add`` failed silently, or the model class isn't surfaced).
        """
        ss = self._ss
        if ss is None:
            return None
        model_obj = getattr(ss, model, None)
        if model_obj is None:
            return None
        idx_var = getattr(model_obj, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        idx_str = str(idx)
        try:
            i = next(
                pos for pos, value in enumerate(idx_values) if str(value) == idx_str
            )
        except StopIteration:
            return None
        name_var = getattr(model_obj, "name", None)
        name_values = list(
            getattr(name_var, "v", []) if name_var is not None else []
        )
        name = (
            str(name_values[i])
            if i < len(name_values)
            else str(idx_values[i])
        )
        params_metas = _PARAMS_BY_MODEL.get(model, ())
        all_params = _extract_params(model_obj, params_metas) if params_metas else []
        params = all_params[i] if i < len(all_params) else {}
        return TopologyEntry(
            idx=idx_values[i], name=name, kind=model, params=params
        )

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


# Cap on the per-session replay buffer (Unit 2). Beyond this many adds the
# buffer drops the oldest entries with a logged warning. 1000 is well above
# any realistic interactive build session and well below memory concerns.
REPLAY_BUFFER_MAX = 1000


# Per-model parameter metadata. Drives three things:
#
# 1. The Inspector Properties tab read-back (legacy path; idx + name are
#    handled separately in ``_collect_models`` and skipped during extract).
# 2. The Add / Edit form schema published to the web client at
#    ``GET /api/topology/schema`` — consumed by Unit 6's polymorphic form
#    generator. ``kind``, ``required``, and ``unit`` flow through to form
#    rendering (input type, required asterisk, inline unit suffix).
# 3. The whitelist check in ``add_element`` / ``edit_element`` — any param
#    key absent from this table for a given model is rejected with 422
#    ``ElementValidationError`` BEFORE any ANDES call.
#
# Required vs. optional reflects ANDES's own contract: parameters without
# a sensible default (e.g., the bus a generator attaches to) are required.
# Defaulted params (limits, area / zone, etc.) are optional.
#
# Trafo (2W) note: ANDES 2.0 has no separate ``Trafo`` model class —
# transformers live in the ``Line`` model with non-default ``tap`` (and
# optionally ``phi``). The Add panel's "Transformer 2W" form maps to
# ``model='Line'`` with ``tap`` required; downstream ``_topology_snapshot``
# splits them via the ``tap != 1.0 OR phi != 0.0`` heuristic.
ParamKind = Literal["string", "number", "bus_idx", "bool"]


@dataclass(frozen=True)
class ParamMeta:
    """One parameter row in ``_PARAMS_BY_MODEL`` — name + form metadata."""

    name: str
    kind: ParamKind
    required: bool = False
    unit: str | None = None


_PARAMS_BY_MODEL: dict[str, tuple[ParamMeta, ...]] = {
    "Bus": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("vmax", "number", unit="pu"),
        ParamMeta("vmin", "number", unit="pu"),
        ParamMeta("area", "number"),
        ParamMeta("zone", "number"),
    ),
    "Line": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus1", "bus_idx", required=True),
        ParamMeta("bus2", "bus_idx", required=True),
        ParamMeta("r", "number", required=True, unit="pu"),
        ParamMeta("x", "number", required=True, unit="pu"),
        ParamMeta("b", "number", unit="pu"),
        ParamMeta("g", "number", unit="pu"),
        ParamMeta("tap", "number"),
        ParamMeta("phi", "number", unit="rad"),
    ),
    "PV": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("p0", "number", required=True, unit="pu"),
        ParamMeta("v0", "number", required=True, unit="pu"),
        ParamMeta("pmax", "number", unit="pu"),
        ParamMeta("pmin", "number", unit="pu"),
        ParamMeta("qmax", "number", unit="pu"),
        ParamMeta("qmin", "number", unit="pu"),
    ),
    "Slack": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("p0", "number", unit="pu"),
        ParamMeta("v0", "number", required=True, unit="pu"),
        ParamMeta("a0", "number", unit="rad"),
        ParamMeta("pmax", "number", unit="pu"),
        ParamMeta("pmin", "number", unit="pu"),
        ParamMeta("qmax", "number", unit="pu"),
        ParamMeta("qmin", "number", unit="pu"),
    ),
    "GENROU": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("H", "number", required=True, unit="MWs/MVA"),
        ParamMeta("D", "number", unit="pu"),
        ParamMeta("M", "number", unit="MWs/MVA"),
        ParamMeta("ra", "number", unit="pu"),
        ParamMeta("xl", "number", unit="pu"),
        ParamMeta("xd", "number", unit="pu"),
        ParamMeta("xq", "number", unit="pu"),
        ParamMeta("xd1", "number", unit="pu"),
        ParamMeta("xq1", "number", unit="pu"),
    ),
    "GENCLS": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("H", "number", required=True, unit="MWs/MVA"),
        ParamMeta("D", "number", unit="pu"),
        ParamMeta("M", "number"),
        ParamMeta("ra", "number", unit="pu"),
        ParamMeta("xl", "number", unit="pu"),
    ),
    "PQ": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("p0", "number", required=True, unit="pu"),
        ParamMeta("q0", "number", required=True, unit="pu"),
    ),
    "ZIP": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("p0", "number", required=True, unit="pu"),
        ParamMeta("q0", "number", required=True, unit="pu"),
        ParamMeta("u", "number"),
        ParamMeta("gammapz", "number"),
        ParamMeta("gammaiz", "number"),
        ParamMeta("gammapi", "number"),
        ParamMeta("gammaii", "number"),
        ParamMeta("gammapv", "number"),
        ParamMeta("gammaqv", "number"),
    ),
    "Shunt": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("g", "number", unit="pu"),
        ParamMeta("b", "number", unit="pu"),
    ),
}


def allowed_param_names(model: str) -> tuple[str, ...]:
    """Return the param names allowed for a given ANDES model class.

    Used by the wrapper-side whitelist check before any ANDES call. Returns
    an empty tuple for unknown models — callers should treat that as
    'unknown model' and reject the request.
    """
    return tuple(p.name for p in _PARAMS_BY_MODEL.get(model, ()))


def param_metadata_for_form(model: str) -> tuple[ParamMeta, ...]:
    """Return the form-renderable param metadata for an ANDES model.

    Includes idx + name (the form's identifier inputs). Used by the
    ``GET /api/topology/schema`` endpoint that drives the web client's
    polymorphic form generator (Unit 6).
    """
    return _PARAMS_BY_MODEL.get(model, ())


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


def _extract_params(
    model: Any, param_metas: tuple[ParamMeta, ...]
) -> list[dict[str, ParamValue]]:
    """For each device in ``model``, return a dict of the requested params.

    Defensive: missing params, zero-length arrays, and length mismatches are
    skipped silently. Returns one dict per device, in the same order as
    ``model.idx.v``.

    ``idx`` and ``name`` are skipped — those are surfaced at the
    ``TopologyEntry`` level by ``_collect_models``.
    """
    n = int(getattr(model, "n", 0))
    if n <= 0:
        return []
    per_device: list[dict[str, ParamValue]] = [{} for _ in range(n)]
    for meta in param_metas:
        if meta.name in ("idx", "name"):
            continue
        param = getattr(model, meta.name, None)
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
            per_device[i][meta.name] = coerced
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
        param_metas = _PARAMS_BY_MODEL.get(model_name, ())
        per_device_params = (
            _extract_params(model, param_metas) if param_metas else [{} for _ in idx_values]
        )
        for i, (idx, name) in enumerate(zip(idx_values, name_values, strict=True)):
            params = per_device_params[i] if i < len(per_device_params) else {}
            entries.append(
                TopologyEntry(idx=idx, name=name, kind=model_name, params=params)
            )
    return entries


def _split_lines_transformers(
    line_entries: list[TopologyEntry],
) -> tuple[list[TopologyEntry], list[TopologyEntry]]:
    """Partition ANDES Line entries into pure lines vs. transformers.

    Heuristic: a Line is a transformer if its tap is non-default
    (|tap - 1.0| > 1e-9) or its phase shift is non-zero (|phi| > 1e-9).
    Tolerant of float drift from PSS/E .raw imports where tap is stored as
    1.0 + epsilon.

    Devices without a readable ``tap``/``phi`` (older ANDES models, custom
    extensions) default to the ``lines`` bucket.
    """
    lines: list[TopologyEntry] = []
    transformers: list[TopologyEntry] = []
    for entry in line_entries:
        tap = entry.params.get("tap")
        phi = entry.params.get("phi")
        try:
            tap_offset = abs(float(tap) - 1.0) if tap is not None else 0.0
        except (TypeError, ValueError):
            tap_offset = 0.0
        try:
            phi_abs = abs(float(phi)) if phi is not None else 0.0
        except (TypeError, ValueError):
            phi_abs = 0.0
        if tap_offset > 1e-9 or phi_abs > 1e-9:
            transformers.append(entry)
        else:
            lines.append(entry)
    return lines, transformers


# Filesystem path patterns to strip from ANDES exception messages before
# they reach the API surface. Workspace paths leak per-user directory
# structure; the andes install path leaks the wheel layout. Both add noise
# without giving the client actionable detail.
_PATH_PATTERN = re.compile(r"/[\w./\-_]+(?:\.py|\.raw|\.dyr|\.xlsx|\.json|\.m)\b")


def _sanitize_message(message: str) -> str:
    """Strip filesystem paths from an ANDES exception message.

    Best-effort regex sweep — leaves the structural message intact while
    removing absolute paths that would otherwise leak workspace and
    install-tree details. Replaces matches with ``<path>``.
    """
    return _PATH_PATTERN.sub("<path>", message)


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
