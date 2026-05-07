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
class PflowResult:
    """Power-flow run result. Keyed by ANDES idx."""

    converged: bool
    iterations: int
    mismatch: float
    bus_voltages: dict[int | str, float]
    bus_angles: dict[int | str, float]


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

        return PflowResult(
            converged=converged,
            iterations=iterations,
            mismatch=mismatch,
            bus_voltages=bus_voltages,
            bus_angles=bus_angles,
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
        for idx, name in zip(idx_values, name_values, strict=True):
            entries.append(
                TopologyEntry(idx=idx, name=name, kind=model_name, params={})
            )
    return entries
