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

import contextlib
import hashlib
import logging
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from typing import TYPE_CHECKING, Any, Literal

from andes_app.core.connectivity_result import ConnectivityResult
from andes_app.core.cpf_result import CpfResult
from andes_app.core.disturbance import AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec
from andes_app.core.eig_result import ComplexNumber, EigResult
from andes_app.core.errors import (
    CaseLoadError,
    CpfDivergedError,
    CpfPrerequisiteError,
    DisturbanceCommitError,
    DisturbanceValidationError,
    EigComputationError,
    EigDirtyDaeError,
    EigPrerequisiteError,
    ElementHasDependentsError,
    ElementNotFoundError,
    ElementValidationError,
    NoCaseLoadedError,
    SeNonConvergentError,
    SePrerequisiteError,
    SetupFailedError,
    SeUnderDeterminedError,
    SystemAlreadyLoadedError,
)
from andes_app.core.se_result import MeasurementsGenerated, SeResult

# JSON-friendly scalar union surfaced through topology / line-flow APIs.
# Mirrored on the API layer (``schemas.TopologyEntry.params``); see schemas.py.
ParamValue = float | int | str | bool

# Unit-8 dynamic-model class names surfaced as a separate ``controllers``
# bucket on the topology snapshot (Unit 8.1). Order is the canonical
# rendering order: exciters → governors → PSS → renewable-interface.
# Each name must match the ANDES System attribute name 1:1
# (``ss.IEEEX1``, ``ss.IEEEG1``, etc.). Models with no instances on a given
# case are simply absent from the bucket — ``_collect_models`` skips empty
# / missing model attrs.
_CONTROLLER_MODEL_NAMES: tuple[str, ...] = (
    "IEEEX1",
    "ESDC2A",
    "SEXS",
    "IEEEG1",
    "TGOV1",
    "IEEEST",
    "REGCA1",
    # Unit 15 (v3.1): the R15 dynamic-model expansion — nine more
    # controller classes researchers attach to machines / renewable
    # plants. Exciters first (EXST1, ESST1A), then governors (GAST,
    # HYGOV, IEESGO), then the dual-input PSS (ST2CUT), then the
    # renewable interface stack (REGCP1 grid-following converter,
    # REECA1 electrical control, REPCA1 plant control).
    #
    # NOTE ON NAMES: the v3.1 plan named this set using PSS/E
    # identifiers (``ST6BU``, ``PSS2A``). ANDES 2.0.0 ships no model
    # class under those names — ``_PARAMS_BY_MODEL`` / this tuple key
    # on the ANDES System attribute name 1:1, so guessed names would
    # silently never match a loaded device. The two PSS/E-only names
    # are mapped to their nearest ANDES-native equivalents in the same
    # device family: ST6BU (a static ST-family exciter) → ``ESST1A``;
    # PSS2A (a dual-input stabilizer) → ``ST2CUT`` (the only ANDES PSS
    # besides the already-whitelisted ``IEEEST``). All param metadata
    # below is introspected from the real ANDES model classes.
    "EXST1",
    "ESST1A",
    "GAST",
    "HYGOV",
    "IEESGO",
    "ST2CUT",
    "REGCP1",
    "REECA1",
    "REPCA1",
    # Unit 14: PMU instances (PhasorMeasurement group) appear in the
    # controllers bucket so the SLD/topology view can surface their
    # placement alongside exciters/governors. PMU has ``flags.tds=True``
    # only — it contributes nothing to PFlow but tracks bus voltage
    # phasor (am, vm) state during TDS for post-run CSV export.
    "PMU",
    # Unit 15: TimeSeries profiles (DataSeries group) ship in the same
    # bucket so the topology view can surface scheduled profile drivers
    # alongside other auxiliary devices. ``flags.tds=True`` only — the
    # model has no PFlow contribution.
    "TimeSeries",
)

if TYPE_CHECKING:
    from andes.system import System

    from andes_app.core.clone_manager import CloneManager


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
    # Unit 8.1: dynamic controllers (exciters, governors, PSS, renewable
    # converters) surfaced by the Unit-8 whitelist additions. Empty when the
    # case carries no entries for any of the seven Unit-8 model classes —
    # e.g., a stock IEEE 14 .raw without the .dyr addfile.
    controllers: list[TopologyEntry] = field(default_factory=list)


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
class GeneratorOutput:
    """Per-generator PF output: active + reactive power injection at the
    generator's terminal bus, plus the terminal voltage (pu).

    For PV/Slack (static) generators these come straight from ANDES's
    own ``p`` / ``q`` / ``v`` algebraic variables. For dynamic models
    (GENROU/GENCLS) the same fields exist post-PF (the dynamic state
    initialization runs after PF converges).
    """

    p: float  # MW (scaled by ss.config.mva)
    q: float  # MVAr
    v: float  # terminal voltage (pu)
    bus: int | str


@dataclass
class LoadConsumption:
    """Per-load PF consumption: P + Q draw at the load's terminal bus."""

    p: float  # MW
    q: float  # MVAr
    bus: int | str


@dataclass
class PflowResult:
    """Power-flow run result. Keyed by ANDES idx."""

    converged: bool
    iterations: int
    mismatch: float
    bus_voltages: dict[int | str, float]
    bus_angles: dict[int | str, float]
    line_flows: dict[str, LineFlow] = field(default_factory=dict)
    generator_outputs: dict[str, GeneratorOutput] = field(default_factory=dict)
    load_consumption: dict[str, LoadConsumption] = field(default_factory=dict)


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

    def __init__(
        self,
        *,
        workspace: str | Path | None = None,
        session_id: str | None = None,
    ) -> None:
        self._ss: System | None = None
        self._case_path: Path | None = None
        self._addfiles: list[Path] | None = None
        self._setup_failed: bool = False  # marks "requires reload"
        # ``_workspace`` is the per-launch workspace directory (the same one
        # the CLI hands the FastAPI app). Snapshot files (Unit 7) live under
        # ``<workspace>/snapshots/<case_basename>/``. ``None`` is honoured
        # by the snapshot routes — they 409 with an actionable message —
        # so the wrapper itself stays usable in pure unit tests that
        # don't touch the snapshot surface.
        self._workspace: Path | None = (
            Path(workspace) if workspace is not None else None
        )
        # ``replay_buffer`` records every successful pre-setup add so a
        # blank session (no underlying case file) can recover its topology
        # via ``reload_case`` — the v0.1.x workaround for ANDES's missing
        # pre-setup ``delete()`` API. Capped at REPLAY_BUFFER_MAX entries
        # with oldest-eviction; older entries are dropped silently with a
        # logged warning.
        self._replay_buffer: list[tuple[str, dict[str, Any]]] = []
        # ``_disturbance_log`` records every successfully-added disturbance
        # spec so callers can replay them after ``reload_case()`` —
        # the only escape hatch from the post-setup ``add()`` rejection
        # ANDES enforces. The replay step is explicit (``replay_disturbances``)
        # rather than wired into ``reload_case`` itself, because Unit 7
        # (snapshot save/load) needs the JSON-serialisable spec list as
        # snapshot metadata before any new System exists. Cleared by
        # ``load_case`` (and therefore by ``reload_case`` which delegates
        # to ``load_case``); explicit reset via ``clear_disturbances``.
        self._disturbance_log: list[DisturbanceSpec] = []
        # ``_se_measurements`` holds the in-memory ``Measurements`` object
        # populated by ``generate_measurements_from_pflow`` (Unit 13). The
        # two-step SE flow (generate → run) keeps the measurement count
        # visible to the UI before the (potentially slow) iteration cost,
        # and lets the user re-run SE against the same measurement set
        # without regenerating noise. Reset on ``load_case`` /
        # ``reload_case`` because a new System invalidates the cached
        # measurement model references.
        self._se_measurements: object | None = None
        # ``_session_id`` (Unit 21) names the clone-on-write scratch dir
        # ``<workspace>/.sessions/<session_id>/clone/``. ``None`` in pure
        # unit tests that don't exercise the clone surface — the clone
        # manager is constructed lazily and 409s without a workspace.
        self._session_id: str | None = session_id
        # The clone-on-write manager (KTD-9) is created lazily on first
        # ``init_clone`` so a session that never edits pays nothing. It holds
        # the per-session clone files + undo/redo stacks.
        self._clone_manager: CloneManager | None = None

    def _clone_mgr(self) -> CloneManager:
        """Return (creating on first use) this session's clone manager."""
        # Deferred import — ``clone_manager`` imports wrapper-level symbols
        # (``_CONTROLLER_MODEL_NAMES``, ``allowed_param_names``), so importing
        # it at module top would create an import cycle.
        from andes_app.core.clone_manager import CloneManager as _CloneManager

        if self._clone_manager is None:
            self._clone_manager = _CloneManager(
                wrapper=self,
                workspace=self._workspace,
                session_id=self._session_id,
            )
        return self._clone_manager

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
        # Disturbances added against the prior System reference are gone —
        # the new System has none. Callers that need to keep them across a
        # reload must capture them via ``list_disturbances()`` BEFORE
        # ``reload_case`` and then ``replay_disturbances()`` AFTER.
        self._disturbance_log = []
        # SE measurements (Unit 13) are scoped to the previous System's
        # device idxes; load/reload invalidates them. The user must
        # call /se/measurements/generate again on the new System.
        self._se_measurements = None
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

    # ----- clone-on-write (Unit 21) -----

    def init_clone(self) -> dict[str, Any]:
        """Initialise (or return) the per-session clone of the active case.

        Delegates to :class:`~andes_app.core.clone_manager.CloneManager`.
        Returns a JSON-friendly dict of the clone metadata.
        """
        result = self._clone_mgr().init_clone()
        return {
            "clone_dir": result.clone_dir,
            "clone_files": result.clone_files,
            "already_initialized": result.already_initialized,
        }

    def apply_clone_edit(
        self, model: str, idx: int | str, param: str, value: Any
    ) -> dict[str, Any]:
        """Apply one clone-on-write edit and return the new value + stack depths."""
        result = self._clone_mgr().apply_edit(model, str(idx), param, value)
        return self._clone_edit_payload(result)

    def undo_clone_edit(self) -> dict[str, Any]:
        """Undo the most recent clone edit (restore prior file state + re-setup)."""
        result = self._clone_mgr().undo()
        return self._clone_edit_payload(result)

    def redo_clone_edit(self) -> dict[str, Any]:
        """Redo the most recently undone clone edit."""
        result = self._clone_mgr().redo()
        return self._clone_edit_payload(result)

    def save_clone_as(self, name: str, *, overwrite: bool = False) -> dict[str, Any]:
        """Copy the clone files to the workspace as ``<name>.<ext>``."""
        result = self._clone_mgr().save_as(name, overwrite=overwrite)
        return {"name": result.name, "files": result.files}

    def reset_clone(self) -> dict[str, Any]:
        """Discard the clone, delete its scratch dir, and revert to the originals."""
        self._clone_mgr().reset_clone()
        return {"reset": True}

    def clone_diff(self, model: str, idx: int | str) -> dict[str, Any]:
        """Diff the clone-file vs original-file values for one device (Unit 23).

        Returns ``{"params": {param: {original, current}}}`` for the
        whitelisted controller params that differ; an empty mapping when there
        is no clone (no edits) or nothing changed.
        """
        result = self._clone_mgr().clone_diff(model, str(idx))
        return {"params": result.params}

    @staticmethod
    def _clone_edit_payload(result: Any) -> dict[str, Any]:
        return {
            "model": result.model,
            "idx": result.idx,
            "param": result.param,
            "new_value": result.new_value,
            "undo_depth": result.undo_depth,
            "redo_depth": result.redo_depth,
        }

    def _bind_clone_system(self, ss: System) -> None:
        """Bind a clone-loaded ``System`` to this wrapper and commit ``setup()``.

        Used only by the clone manager's reload path. Mirrors the state reset
        ``load_case`` performs (clears disturbance / SE / replay caches keyed
        on the prior System) WITHOUT re-pointing ``_case_path`` / ``_addfiles``
        at the clone — the original paths must survive so ``reset_clone`` can
        revert to them. Commits ``setup()`` so PF / TDS / EIG / CPF / SE are
        ready against the edited files; a setup failure surfaces as
        :class:`SetupFailedError`.
        """
        self._ss = ss
        self._setup_failed = False
        self._replay_buffer = []
        self._disturbance_log = []
        self._se_measurements = None
        self._ensure_setup()

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
            controllers=_collect_models(ss, list(_CONTROLLER_MODEL_NAMES)),
        )

    # ----- disturbance management -----

    def add_disturbance(self, spec: DisturbanceSpec) -> int | str:
        """Add a disturbance to the pre-setup System. Returns the assigned
        ANDES idx of the created device.

        On success the spec is appended to ``self._disturbance_log`` so that
        ``replay_disturbances()`` can replay them after a future
        ``reload_case()`` (the only escape from the post-setup ``add()``
        rejection ANDES enforces). Failures (``ANDES rejected …``) leave the
        log untouched — atomic from the caller's perspective.

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
            # Don't pollute the replay log on rejection — the caller saw
            # an exception, ``list_disturbances`` must reflect that.
            raise DisturbanceValidationError(
                f"ANDES rejected {model_name} spec: {_sanitize_message(str(exc))}"
            ) from exc
        self._disturbance_log.append(spec)
        return idx

    def list_disturbances(self) -> list[DisturbanceSpec]:
        """Return a defensive copy of the currently-recorded disturbance specs.

        The list reflects every spec that was successfully accepted by
        ``add_disturbance`` since the most recent ``load_case`` /
        ``reload_case`` / ``clear_disturbances`` call. The route layer
        consumes this for the ``GET /sessions/{id}/disturbances`` sync
        endpoint.
        """
        return list(self._disturbance_log)

    def clear_disturbances(self) -> None:
        """Clear the disturbance log without touching the loaded System.

        Does NOT remove the actual ``Fault`` / ``Toggle`` / ``Alter`` devices
        that were already added to ``self._ss`` — only the replay log. The
        Wrapper has no public delete-disturbance API on the System (ANDES
        ``ss.add`` rejects post-setup; pre-setup it offers no removal hook
        either). To fully purge, callers must ``reload_case()`` and
        re-replay only what they want to keep.
        """
        self._disturbance_log = []

    def replay_disturbances(self) -> int:
        """Re-add every spec in ``self._disturbance_log`` to the current System.

        Intended use: ``reload_case()`` (which clears the log because
        it ``load_case``s a fresh System) → ``replay_disturbances()``
        (re-adds them on the new pre-setup System). Returns the number
        of specs replayed.

        No-op (returns 0, logs a warning) if the System is post-setup —
        ANDES rejects ``add()`` calls then. No-op if the log is empty.
        On individual replay failure raises ``DisturbanceValidationError``;
        already-replayed specs remain on the System and the log is rebuilt
        only for those entries that succeeded BEFORE the failure.
        """
        log = logging.getLogger("andes-app.wrapper.disturbance-replay")
        if self._ss is None:
            raise NoCaseLoadedError("no case has been loaded")
        if self._ss.is_setup:
            log.warning(
                "replay_disturbances called post-setup; no-op. "
                "Call reload_case() first to return to pre-setup."
            )
            return 0
        # Snapshot before reset — re-calling ``add_disturbance`` re-appends to
        # ``self._disturbance_log``; without the snapshot the iteration would
        # double-count and grow without bound.
        pending = list(self._disturbance_log)
        self._disturbance_log = []
        for spec in pending:
            self.add_disturbance(spec)
        return len(pending)

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

    def undo_last_edit(self) -> TopologySnapshot:
        """Drop the most recent add() from the replay buffer and rebuild
        the System from the remaining history.

        For blank sessions: re-creates ``andes.System()`` and replays the
        buffer minus the popped entry.

        For loaded sessions: reloads from the case file (which clears
        the buffer) and re-applies all remaining buffer entries.

        Raises ``ElementValidationError`` when there's nothing to undo.
        """
        if not self._replay_buffer:
            raise ElementValidationError("no edits to undo")
        kept = list(self._replay_buffer[:-1])
        if self._case_path is not None:
            # Loaded session: reload from file, then re-add the kept
            # entries on top.
            self.reload_case()
            ss = self._require_loaded()
            for model_name, params in kept:
                try:
                    ss.add(model_name, dict(params))
                except Exception as exc:  # noqa: BLE001
                    raise ElementValidationError(
                        f"undo failed at replay of model {model_name!r}: "
                        f"{_sanitize_message(str(exc))}"
                    ) from exc
                self._replay_buffer.append((model_name, dict(params)))
            return self._topology_snapshot_locked()
        # Blank session: replay-from-scratch with the truncated buffer.
        self._replay_buffer = kept
        return self._reload_blank_locked()

    def delete_element(self, model: str, idx: int | str) -> TopologySnapshot:
        """Delete a previously-added topology element by ``(model, idx)``.

        Order of operations:

        1. Whitelist check: ``model`` must be a known ANDES model class
           (i.e., a key of ``_PARAMS_BY_MODEL``). Unknown models are
           rejected with ``ElementValidationError`` BEFORE any further
           work — this guarantees the dependents walker only sees
           supported model classes.
        2. Replay-buffer check: ``(model, idx)`` must correspond to a
           successful ``add_element`` call recorded in
           ``self._replay_buffer``. Case-file-originated elements are
           NOT deletable in v0.1.y; the caller is directed to the
           Reload button. The check is the ground truth for "did the
           user add this element in this session?".
        3. Cascade detection: walk the loaded System for elements that
           reference the target via ``bus``/``bus1``/``bus2``. If any
           dependents exist, raise ``ElementHasDependentsError`` with
           the (capped) list and total count.
        4. Atomic reload-and-replay: snapshot the current ``self._ss``
           reference and ``_replay_buffer`` list. Pop the matching
           ``(model, idx)`` from the buffer, then rebuild the System
           from the kept entries via the same code path
           ``undo_last_edit`` uses. On any rebuild failure, restore
           the snapshots — leaving the wrapper in its pre-delete
           state — and re-raise.

        Notes:

        - Disturbances (``add_disturbance``) are NOT recorded in
          ``self._replay_buffer``; if the session has any pending
          disturbances they are silently dropped by the rebuild. This
          is documented as a known limitation in the v0.1.y plan; the
          v0.2 disturbance-timeline UI will need to either record
          disturbances in the replay buffer or refuse delete while
          disturbances are pending.

        Returns the post-delete topology snapshot.
        """
        ss = self._require_loaded()
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        if ss.is_setup:
            raise DisturbanceCommitError()

        # 1. Whitelist check — keep this before everything so the dependents
        # walker only ever sees a known model class string.
        if model not in _PARAMS_BY_MODEL:
            raise ElementValidationError(
                f"unknown model {model!r}; supported models: "
                f"{sorted(_PARAMS_BY_MODEL.keys())}"
            )

        # 2. Replay-buffer check. The buffer stores the params dict ANDES
        # was passed; ``idx`` lives at ``params['idx']`` (we pre-snapshot
        # before ANDES mutates the dict in ``add_element``).
        idx_str = str(idx)
        match_index: int | None = None
        for i, (m_name, params) in enumerate(self._replay_buffer):
            if m_name != model:
                continue
            entry_idx = params.get("idx")
            if entry_idx is None:
                continue
            if str(entry_idx) == idx_str:
                match_index = i
                break
        if match_index is None:
            # Verify the element exists at all so we can return a clear 404
            # vs the "case-file-originated" 422 distinction.
            existing = self._lookup_topology_entry(model, idx)
            if existing is None:
                raise ElementNotFoundError(
                    f"no {model} with idx={idx!r}"
                )
            raise ElementValidationError(
                "This element came from the loaded case file. "
                "Use the Reload button in the workflow toolbar to "
                "reset to the original case."
            )

        # 3. Cascade detection. The walker returns ``TopologyEntry`` items
        # for every device that references ``(model, idx)``.
        dependents_full = self._find_dependents(model, idx)
        if dependents_full:
            total = len(dependents_full)
            capped = dependents_full[:DELETE_DEPENDENTS_CAP]
            # Serialize to plain dicts so the error can cross the worker
            # Pipe without dataclass import on the parent side.
            payload = [
                {
                    "idx": e.idx,
                    "name": e.name,
                    "kind": e.kind,
                    "params": dict(e.params),
                }
                for e in capped
            ]
            raise ElementHasDependentsError(
                model=model, idx=idx, dependents=payload, total=total
            )

        # 4. Atomic reload-and-replay. Snapshot first so a rebuild failure
        # leaves the wrapper exactly as the caller saw it pre-delete.
        ss_snapshot = self._ss
        buffer_snapshot = list(self._replay_buffer)
        kept = [
            entry
            for i, entry in enumerate(self._replay_buffer)
            if i != match_index
        ]
        try:
            if self._case_path is not None:
                # Loaded session: re-load from file (clears the buffer),
                # then re-apply the kept entries on top.
                self.reload_case()
                ss_after = self._require_loaded()
                for model_name, params in kept:
                    try:
                        ss_after.add(model_name, dict(params))
                    except Exception as exc:  # noqa: BLE001
                        raise ElementValidationError(
                            f"delete failed at replay of model "
                            f"{model_name!r}: "
                            f"{_sanitize_message(str(exc))}"
                        ) from exc
                    self._replay_buffer.append((model_name, dict(params)))
            else:
                # Blank session: replay-from-scratch with the kept buffer.
                # ``_reload_blank_locked`` reads ``self._replay_buffer``
                # and re-creates the System from it.
                self._replay_buffer = kept
                self._reload_blank_locked()
        except Exception:
            # Rollback to the pre-delete state. We restore ss reference and
            # buffer; ``_setup_failed`` is implicitly cleared by the snapshot
            # ss reference being pre-failure.
            self._ss = ss_snapshot
            self._replay_buffer = buffer_snapshot
            self._setup_failed = False
            raise
        return self._topology_snapshot_locked()

    def _find_dependents(
        self, model: str, idx: int | str
    ) -> list[TopologyEntry]:
        """Walk the loaded System for elements that reference the target.

        Reference attributes per the ANDES 2.0 model surface enumerated
        in ``_PARAMS_BY_MODEL``:

        - ``Line``: ``bus1`` and ``bus2`` (terminal buses)
        - ``PV``, ``Slack``, ``GENROU``, ``GENCLS``: ``bus`` (terminal)
        - ``PQ``, ``ZIP``: ``bus`` (terminal)
        - ``Shunt``: ``bus`` (terminal)
        - ``Bus``: no outgoing references

        Therefore only ``Bus`` deletions trigger a non-empty dependents
        walk; deleting a Line / generator / load / shunt always returns
        an empty list (nothing else in ``_PARAMS_BY_MODEL`` references
        them).

        Returns a list of ``TopologyEntry`` items. The list is uncapped;
        callers (``delete_element``) are responsible for applying the
        ``DELETE_DEPENDENTS_CAP`` truncation.
        """
        # Bus is the only model with downstream references; everything
        # else trivially has no dependents.
        if model != "Bus":
            return []

        ss = self._require_loaded()
        idx_str = str(idx)
        dependents: list[TopologyEntry] = []
        # ``_REFERENCE_ATTRS`` enumerates the reference attribute(s) on
        # each model that, when matched, indicate a dependency on the
        # target Bus. Add new ANDES model classes here as the
        # ``_PARAMS_BY_MODEL`` whitelist grows.
        for ref_model, ref_attrs in _REFERENCE_ATTRS.items():
            model_obj = getattr(ss, ref_model, None)
            if model_obj is None:
                continue
            idx_var = getattr(model_obj, "idx", None)
            idx_values = list(
                getattr(idx_var, "v", []) if idx_var is not None else []
            )
            if not idx_values:
                continue
            for attr in ref_attrs:
                ref_var = getattr(model_obj, attr, None)
                ref_values = list(
                    getattr(ref_var, "v", []) if ref_var is not None else []
                )
                for i, ref_v in enumerate(ref_values):
                    if i >= len(idx_values):
                        break
                    if str(ref_v) == idx_str:
                        entry = self._lookup_topology_entry(
                            ref_model, idx_values[i]
                        )
                        if entry is not None:
                            dependents.append(entry)
        return dependents

    def save_case(
        self, format: Literal["xlsx", "json", "raw"], filename: str
    ) -> Path:
        """Write the current System to a workspace file.

        Three formats:

        - ``xlsx`` — ANDES native, via ``andes.io.xlsx.write``.
        - ``json`` — ANDES JSON, via ``andes.io.json.write``.
        - ``raw`` — PSS/E v33, via the substrate's hand-rolled writer
          (``andes_app.core.psse_writer.write_raw``). ANDES 2.0 has no
          built-in PSS/E writer; the substrate ships one for the model
          classes it can emit (Bus, PQ/ZIP, Shunt, PV/Slack/GENROU/
          GENCLS, Line, 2W transformer).

        Returns the absolute path of the written file. Caller (the
        route handler) is responsible for canonicalizing ``filename``
        against the workspace and rejecting traversal.
        """
        ss = self._require_loaded()
        target = Path(filename)
        # ANDES's xlsx/json writers call ``confirm_overwrite`` which falls back
        # to ``input()`` when the file exists and ``overwrite`` is unset — in
        # the TTY-less worker that raises "EOFError: EOF when reading a line".
        # The route already guards collisions (409 unless overwrite=true), so
        # by the time we're here the write is authorised: force ``overwrite``.
        try:
            if format == "xlsx":
                from andes.io import xlsx

                xlsx.write(ss, str(target), overwrite=True)
            elif format == "json":
                from andes.io import json as andes_json

                andes_json.write(ss, str(target), overwrite=True)
            elif format == "raw":
                from andes_app.core.psse_writer import write_raw

                write_raw(ss, str(target))
            else:  # pragma: no cover — Literal narrows the type
                raise ElementValidationError(
                    f"unsupported save format {format!r}; supported: xlsx, json, raw"
                )
        except Exception:
            # A failed write (e.g. ANDES choking on a from-scratch System) can
            # leave a 0-byte file behind that then masquerades as a real case
            # in the workspace listing. Remove it so the listing stays honest.
            if target.exists() and target.stat().st_size == 0:
                target.unlink()
            raise
        return target

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

    # ----- introspection (Unit 1b of v0.2) -----

    def alterable_params(self, model: str) -> list[str]:
        """Return the ordered list of parameter names that ANDES will accept
        as ``src`` for an ``Alter`` disturbance on the given model.

        The rule mirrors ANDES's ``alter()`` contract: a parameter is
        alterable iff it is a ``NumParam`` instance AND not an ``ExtParam``
        (which is a derived/external value sourced off another model).
        Topology refs (``IdxParam``: ``bus``, ``bus1``, ``area``, etc.) and
        string identifiers (``DataParam``: ``idx``, ``name``) are excluded.

        Raises ``NoCaseLoadedError`` if no case is loaded on the session.
        Raises ``ElementValidationError`` if the model name is not a known
        attribute on the loaded ``System`` (404 at the API layer).

        Works pre- or post-setup — ``model.params`` is populated at parse
        time.
        """
        from andes.core.param import ExtParam, NumParam

        ss = self._require_loaded()
        model_obj = getattr(ss, model, None)
        # ANDES populates a ``params`` OrderedDict on every Model instance at
        # ``__init__``. Reject not-a-model attributes like ``ss.config`` or
        # ``ss.dae`` (which exist on the System but aren't ANDES models) by
        # checking that ``params`` exists and is dict-shaped.
        params_dict: Any = (
            getattr(model_obj, "params", None) if model_obj is not None else None
        )
        if not isinstance(params_dict, dict):
            raise ElementValidationError(
                f"unknown model {model!r} on the loaded System"
            )
        out: list[str] = []
        for name, param in params_dict.items():
            if not isinstance(param, NumParam):
                continue
            if isinstance(param, ExtParam):
                continue
            out.append(str(name))
        return out

    # ----- runs -----

    def run_pflow(self) -> PflowResult:
        """Run power flow. Calls ``ss.setup()`` first if not yet committed
        (verified: ``PFlow.run`` does not auto-call setup).

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
        ss = self._require_loaded()
        if bool(getattr(getattr(ss, "TDS", None), "initialized", False)):
            raise EigDirtyDaeError(
                "EIG mutated dae state; reload case "
                "(POST /api/sessions/{id}/reload) to restore pre-EIG PF "
                "behavior, or use Run TDS instead."
            )
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

    def run_tds(
        self,
        tf: float,
        h: float | None = None,
        on_step: Callable[[float, System], None] | None = None,
        abort_flag: Event | None = None,
        integrator: Literal["trapezoidal", "qndf"] = "trapezoidal",
        tds_config_overrides: dict[str, float] | None = None,
    ) -> TdsBatchResult:
        """Run a time-domain simulation up to ``tf`` seconds.

        ``on_step`` is invoked once per integration step via ANDES's
        ``TDS.callpert`` hook. ``abort_flag``, when set, causes the wrapper
        to set ``ss.TDS.busted = True`` on the next callpert invocation,
        cleanly terminating the integration loop within ~2 steps.

        ``integrator`` selects the DAE solution method:
        - ``"trapezoidal"`` (default) — fixed-step Implicit Trapezoidal
          Method. Maps to ANDES ``ss.TDS.config.method = "trapezoid"``.
          v1.0 default (no behavior change for existing callers).
        - ``"qndf"`` — variable-order, variable-step QNDF (NDF) method.
          Maps to ANDES ``ss.TDS.config.method = "qndf"``. Requires
          ``ss.TDS.config.fixt = 0`` (which the wrapper sets explicitly).

        ``tds_config_overrides`` (optional) is a dict of TDS config
        field names → values. Two key flavours are accepted:

        - Three wrapper-canonical aliases for the common adaptive knobs:
          - ``rtol`` → ``ss.TDS.config.reltol`` (relative tolerance).
          - ``atol`` → ``ss.TDS.config.abstol`` (absolute tolerance).
          - ``max_step`` → ``ss.TDS.config.dtmax`` (maximum step size; the
            ANDES field is ``dtmax``, NOT ``h_max``).
        - Any genuine ``ss.TDS.config`` field name (e.g. ``tol``,
          ``max_iter``, ``fixt``, ``shrinkt``, ``honest``, ``tstep``,
          ``reltol``, ``abstol``, ``dtmax``). These are validated against
          the live config object (``hasattr``) and ``setattr`` directly.
          This is what the GUI's free-form override editor forwards.

        A key that is neither a canonical alias nor a real ``ss.TDS.config``
        field raises ``SetupFailedError`` (the wrapper stays a strict
        gatekeeper — it never sets an attribute that does not exist). The
        Auto preset (``rtol=1e-3, atol=1e-6, max_step=0.05``) is the
        caller's responsibility to set; this method does NOT inject
        defaults.
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

        # Integrator selection. ANDES ``method`` strings: ``"trapezoid"``
        # (fixed-step ITM) and ``"qndf"`` (variable-step NDF). The QNDF
        # path also needs ``fixt = 0`` so ANDES enables LTE-driven step
        # control (verified at andes/routines/tds.py:1278).
        if integrator == "qndf":
            ss.TDS.config.method = "qndf"
            ss.TDS.config.fixt = 0
        elif integrator == "trapezoidal":
            ss.TDS.config.method = "trapezoid"
        else:  # pragma: no cover — guarded by Literal type
            raise SetupFailedError(
                f"unknown integrator {integrator!r}; expected 'trapezoidal' or 'qndf'"
            )

        # Tolerance / max-step overrides. Three keys are wrapper-canonical
        # aliases (``rtol`` / ``atol`` / ``max_step``) that map to the
        # ANDES field names ``reltol`` / ``abstol`` / ``dtmax``. Any other
        # key is treated as a literal ``ss.TDS.config`` field name and is
        # set directly after validating it exists on the live config — this
        # is what the GUI free-form override editor forwards (e.g. ``tol``,
        # ``max_iter``). A key that is neither a canonical alias nor a real
        # config field raises (the wrapper never sets a non-existent attr).
        if tds_config_overrides:
            _OVERRIDE_MAP = {
                "rtol": "reltol",
                "atol": "abstol",
                "max_step": "dtmax",
            }
            for key, value in tds_config_overrides.items():
                andes_field = _OVERRIDE_MAP.get(key, key)
                if not hasattr(ss.TDS.config, andes_field):
                    raise SetupFailedError(
                        f"unknown TDS override key {key!r}; expected a "
                        f"wrapper-canonical alias {list(_OVERRIDE_MAP)!r} or "
                        f"a real ss.TDS.config field name"
                    )
                setattr(ss.TDS.config, andes_field, value)

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
                "Run PFlow first; EIG._pre_check warns but does not "
                "short-circuit on non-converged PFlow"
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
        eigenvalues: list[ComplexNumber] = []
        damping_ratios: list[float] = []
        frequencies_hz: list[float] = []
        if mu is not None:
            try:
                mu_iter = list(mu)
            except TypeError:
                mu_iter = []
            for z in mu_iter:
                z_complex = complex(z)
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

    # ----- CPF (Unit 12) -----

    def run_cpf(
        self,
        *,
        direction: str = "load",
        step: float | None = None,
        max_iter: int | None = None,
    ) -> CpfResult:
        """Run continuation power flow — Unit 12.

        Args:
            direction: ``"load"`` (default) scales loads up via
                ``ss.CPF.run(load_scale=2.0)``. ``"gen"`` scales
                generation up via ``pg_target=2.0``. Any other value
                raises ``ValueError``.
            step: optional initial continuation step size. Pushed onto
                ``ss.CPF.config.step`` before the run when not None.
            max_iter: optional cap on the number of continuation steps.
                Pushed onto ``ss.CPF.config.max_steps`` before the run
                when not None. ANDES's own ``max_iter`` config is the
                Newton corrector iterations per step, *not* the total
                continuation count — we map the user-facing parameter
                name (which the plan inherits from natural-language
                terminology) onto the ANDES ``max_steps`` field where
                it actually controls truncation.

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

        A clean ``False`` return (``ok=False``) does NOT raise — it
        means the run completed but did not reach a nose point (e.g.,
        hit ``max_steps``, or branch-switched). The result is returned
        with ``truncated=True`` and ``nose_idx=-1`` so the UI can
        surface the truncation note.

        An unexpected exception inside ``ss.CPF.run()`` raises
        :class:`CpfDivergedError` so the routes layer can return 422
        with the ANDES detail.
        """
        ss = self._require_loaded()
        self._ensure_setup()
        # Independent PF gate — ANDES's own check is unsafe (only warns).
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise CpfPrerequisiteError(
                "Run PFlow first; CPF.init warns but does not "
                "short-circuit on non-converged PFlow"
            )

        if direction not in ("load", "gen"):
            raise ValueError(
                f"direction must be 'load' or 'gen', got {direction!r}"
            )

        # Push optional config knobs. ANDES exposes ``step`` /
        # ``max_steps`` as config attrs, not run() kwargs.
        if step is not None:
            try:
                ss.CPF.config.step = float(step)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"invalid CPF step: {exc}") from exc
        if max_iter is not None:
            try:
                ss.CPF.config.max_steps = int(max_iter)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"invalid CPF max_iter: {exc}") from exc

        # Default scaling factor for both directions: 2.0 (load doubled
        # / generation doubled). The plan's body does not specify the
        # scaling magnitude; this matches the Unit 1a spike's empirical
        # baseline.
        kwargs: dict[str, Any] = {}
        if direction == "load":
            kwargs["load_scale"] = 2.0
        else:  # direction == "gen"
            kwargs["pg_target"] = 2.0

        try:
            ok = bool(ss.CPF.run(**kwargs))
        except CpfPrerequisiteError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CpfDivergedError(
                f"Continuation power flow failed: {exc}"
            ) from exc

        return _build_cpf_result(ss, mode="pv", ok=ok)

    def run_cpf_qv(self, *, bus_idx: str, q_range: float = 5.0) -> CpfResult:
        """Run a single-bus QV-curve continuation — Unit 12.

        Args:
            bus_idx: ANDES bus idx (string-coerced; ANDES accepts both
                ``int`` and ``str`` here depending on case file format).
            q_range: passed through to ``CPF.run_qv(q_range=...)``.
                Default 5.0 matches ANDES's own default
                (``cpf.py:273``).

        Same prerequisite gate as :meth:`run_cpf`. ``CPF.run_qv``
        requires at least one PQ device at ``bus_idx``; ANDES raises a
        ``ValueError`` on missing PQ — the substrate forwards as
        :class:`CpfDivergedError` (mapped to 422).

        Returns a :class:`CpfResult` with ``mode="qv"`` and a single
        bus key in ``voltages_per_bus`` keyed off ``bus_idx``.
        ``lambdas`` carries the ``qv_q`` array (reactive-power axis);
        the UI labels the X-axis "Q (pu)" instead of "lambda" based on
        ``mode``.
        """
        ss = self._require_loaded()
        self._ensure_setup()
        if not bool(getattr(ss.PFlow, "converged", False)):
            raise CpfPrerequisiteError(
                "Run PFlow first; CPF.init warns but does not "
                "short-circuit on non-converged PFlow"
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
            ss.CPF.run_qv(coerced_idx, q_range=float(q_range))
        except CpfPrerequisiteError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise CpfDivergedError(
                f"QV-curve run failed for bus {bus_idx!r}: {exc}"
            ) from exc

        return _build_cpf_result(ss, mode="qv", ok=True, qv_bus=str(bus_idx))

    # ----- SE (Unit 13) -----

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
                "Run PFlow first; SE.init logs an error but does not "
                "raise on non-converged PFlow"
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
                "Run PFlow first; SE.init logs an error but does not "
                "raise on non-converged PFlow"
            )
        if self._se_measurements is None:
            raise SePrerequisiteError(
                "Generate measurements first; call "
                "/sessions/{id}/se/measurements/generate before /se"
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

    # ----- connectivity / island detection (Unit 17) -----

    def compute_connectivity(self) -> ConnectivityResult:
        """Run topology / island detection on the loaded System — Unit 17.

        Calls ANDES's ``ss.connectivity()`` (which delegates to
        ``ConnMan.check_connectivity``). The routine itself returns
        ``None`` and writes its output as side-effects on ``ss.Bus``:

        - ``Bus.island_sets`` — list of connected components (excluding
          degree-zero buses), each entry a list of 0-based bus
          *addresses* (positions in ``Bus.idx.v``).
        - ``Bus.islanded_buses`` — list of degree-zero bus addresses.
        - ``Bus.islands`` — unified list combining singletons for
          ``islanded_buses`` with the full components from
          ``island_sets``. ``len(Bus.islands)`` is the wire-payload's
          ``island_count``.

        The substrate translates bus addresses to user-facing idx
        values (case-file identifiers) via ``Bus.idx.v[address]`` so
        the SLD can index by the same idx it already uses for bus
        nodes. Idx values are stringified for stable JSON keying.

        Pre-condition: a case must be loaded *and* setup must be
        committed (ANDES populates ``Bus.a.a`` / address arrays during
        ``ss.setup()``; without setup the connectivity check would
        raise on missing attributes).

        Per the v2.0 plan's Unit 17 auto-fix: post-run only — no
        per-frame recomputation. The streaming pipeline's
        ``VAR_GROUPS`` schema (``server/src/andes_app/core/stream.py``)
        is not touched here.

        Side-effects: ANDES's connectivity routine logs at INFO level
        when ``info=True``; we pass ``info=False`` so the substrate
        stays quiet (the wire payload carries everything the UI needs).
        """
        ss = self._require_loaded()
        self._ensure_setup()

        ss.connectivity(info=False)

        bus = ss.Bus
        # ANDES exposes idx values on the dynamically-built ``idx`` param;
        # ``.v`` is the underlying ndarray / list. We coerce to a plain
        # list so indexing is uniform across NumPy and list backings and
        # the result is JSON-friendly without type tagging.
        idx_v = list(bus.idx.v)

        def _addr_to_idx(addr: int) -> str:
            # Defensive: clamp into range so a misordered island never
            # raises on a stale address; in practice ANDES's
            # ``_find_islands`` only emits addresses in [0, n_buses).
            try:
                return str(idx_v[int(addr)])
            except (IndexError, ValueError):
                return str(addr)

        islands_addr_lists = list(getattr(bus, "islands", None) or [])
        islands: list[list[str]] = [
            [_addr_to_idx(a) for a in island] for island in islands_addr_lists
        ]
        islanded_addr_list = list(getattr(bus, "islanded_buses", None) or [])
        islanded_bus_idxes: list[str] = [
            _addr_to_idx(a) for a in islanded_addr_list
        ]
        return ConnectivityResult(
            island_count=len(islands),
            islands=islands,
            islanded_bus_idxes=islanded_bus_idxes,
        )

    # ----- PMU placement (Unit 14) -----
    #
    # PMUs are a separate vertical from generic add_element on the API
    # surface (per Unit 14 plan): the placement dialog, the listing
    # endpoint, and the post-run CSV export are all PMU-scoped. The
    # wrapper-side mechanics still re-use the generic ``add_element`` /
    # ``delete_element`` paths so PMUs participate in the existing
    # ``_replay_buffer`` reload-and-replay machinery without growing a
    # parallel buffer.
    #
    # PMU outputs during TDS:
    # - ``am`` (state) — phase angle measurement, low-pass-filtered with
    #   time constant ``Ta`` (default 0.1s; substrate ships 0.05s).
    # - ``vm`` (state) — voltage magnitude measurement, low-pass-filtered
    #   with time constant ``Tv``. Both states track their respective
    #   bus values via ``e_str = a - am`` / ``v - vm``.
    # ANDES auto-generates ``PMU_<n>`` idx values when not supplied.

    def add_pmu(
        self, bus_idx: int | str, Ta: float = 0.05, Tv: float = 0.05
    ) -> TopologyEntry:
        """Add a PMU instance attached to ``bus_idx`` — Unit 14.

        Pre-setup gate matches ``add_element``: ANDES rejects all
        post-setup ``ss.add()`` calls regardless of model, and the route
        layer maps the resulting ``DisturbanceCommitError`` to a 409 with
        a "reload to recover" hint.

        ``bus_idx`` is forwarded as-is to ANDES. Cases loaded from .raw
        files use integer-typed bus idx values; .xlsx / .json cases use
        strings. The wrapper's bus-existence check looks up against
        ``ss.Bus.idx.v`` with string-equality coercion so either form
        works on the API surface.

        Returns the freshly-built ``TopologyEntry`` for the new PMU
        (``kind="PMU"``, ``params`` includes ``bus`` / ``Ta`` / ``Tv``).

        Raises ``ElementValidationError`` (→ 422) when the bus does not
        exist on the loaded System (the underlying ANDES error is
        opaque; we pre-validate so the user sees an actionable message).
        """
        ss = self._require_loaded()
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        if ss.is_setup:
            raise DisturbanceCommitError()

        # Pre-validate bus existence so the user gets a clean 422 instead
        # of ANDES's internal "no such ACNode" exception inside ss.add.
        bus_obj = getattr(ss, "Bus", None)
        bus_idx_var = getattr(bus_obj, "idx", None) if bus_obj is not None else None
        bus_values = list(
            getattr(bus_idx_var, "v", []) if bus_idx_var is not None else []
        )
        bus_idx_str = str(bus_idx)
        # Look up the resolved bus value with the same type ANDES has on
        # ``ss.Bus.idx.v``. PSS/E .raw cases store integer-typed idxes;
        # .xlsx / .json cases store strings. The API surface always sends
        # strings, so we resolve the matching value and forward it with
        # ANDES's native type — otherwise ``ss.setup`` would later crash
        # with "<Bus>: device not exist with idx=1." (string vs int
        # mismatch in the cross-reference table).
        resolved_bus: int | str | None = None
        for value in bus_values:
            if str(value) == bus_idx_str:
                resolved_bus = value
                break
        if resolved_bus is None:
            raise ElementValidationError(
                f"no Bus with idx={bus_idx!r} on the loaded System; "
                f"PMU placement requires an existing bus"
            )

        params: dict[str, Any] = {
            "bus": resolved_bus,
            "Ta": float(Ta),
            "Tv": float(Tv),
        }
        # Snapshot for replay BEFORE ANDES mutates the dict in-place
        # (ss.add can pop fields during model registration).
        replay_snapshot = dict(params)
        try:
            new_idx = ss.add("PMU", params)
        except Exception as exc:  # noqa: BLE001
            raise ElementValidationError(
                f"ANDES rejected PMU add for bus {bus_idx!r}: "
                f"{_sanitize_message(str(exc))}"
            ) from exc

        # Record via the same buffer ``add_element`` uses so reload-and-
        # replay carries the PMU. Cap-at-REPLAY_BUFFER_MAX semantics
        # mirror ``add_element`` exactly.
        if len(self._replay_buffer) >= REPLAY_BUFFER_MAX:
            dropped, _ = self._replay_buffer.pop(0)
            logging.getLogger("andes-app.wrapper.replay").warning(
                "replay buffer at cap (%d); dropping oldest entry (model=%r)",
                REPLAY_BUFFER_MAX,
                dropped,
            )
        # Ensure the snapshot carries the auto-assigned idx so a replay
        # rebuilds the same identifier (mirrors add_element's idx
        # snapshotting discipline).
        replay_snapshot["idx"] = new_idx
        self._replay_buffer.append(("PMU", replay_snapshot))

        entry = self._lookup_topology_entry("PMU", new_idx)
        if entry is None:
            raise ElementValidationError(
                f"ANDES accepted PMU add but no device with idx={new_idx!r} "
                "was found on read-back"
            )
        return entry

    def list_pmus(self) -> list[TopologyEntry]:
        """Return every PMU instance currently on the loaded System.

        Empty list when no PMUs have been placed (the common case for a
        freshly-loaded stock case — ANDES's bundled IEEE 14 / 39 /
        kundur cases ship with zero PMUs). Works pre- or post-setup —
        the read goes through ``_collect_models`` which is state-agnostic.
        """
        ss = self._require_loaded()
        return _collect_models(ss, ["PMU"])

    def delete_pmu(self, idx: int | str) -> None:
        """Remove a PMU previously added via :meth:`add_pmu` — Unit 14.

        Same pre-setup gate as ``delete_element``. Implementation
        delegates to ``delete_element`` so the buffer rewind +
        reload-and-replay machinery is shared.

        Raises ``ElementNotFoundError`` (→ 404) when no PMU with that
        idx exists; ``DisturbanceCommitError`` (→ 409) when setup is
        committed.
        """
        # delete_element handles the pre-setup gate, the replay-buffer
        # check (which rejects case-file-originated PMUs with an
        # actionable 422), and the cascade walk (PMU has no downstream
        # references so the walk returns empty).
        self.delete_element("PMU", idx)

    def export_pmu_csv(self) -> str:
        """Build a long-form CSV of every PMU's am/vm trajectories from
        the most recent TDS run — Unit 14.

        Columns:
        - ``t`` — simulation time (seconds), one row per integration step
          (full TDS rate; NOT decimated).
        - ``<pmu_idx>_am`` — phase angle measurement (radians) for each PMU.
        - ``<pmu_idx>_vm`` — voltage magnitude measurement (pu) for each PMU.

        PMU idx values appear in the header in the order ANDES holds them
        on ``ss.PMU.idx.v``. Two columns per PMU (am, vm).

        Pre-conditions:
        - A case must be loaded and setup must have been committed (TDS
          requires it). Raises ``NoCaseLoadedError`` (→ 409) otherwise.
        - At least one TDS step must have completed — i.e., ``ss.dae.ts``
          must have populated time-series data. An empty ``ts.t`` array
          surfaces as an empty CSV body (header only) so the caller can
          distinguish "no PMUs placed" (header has only ``t``) from "PMUs
          placed but no TDS run" (header carries the columns, body has
          zero rows).
        - At least one PMU must be present. When the System has zero
          PMUs the CSV body is just the ``t`` column with one row per
          recorded step. Callers should typically gate the export
          button on ``list_pmus()`` returning a non-empty list.

        The CSV is built in-memory (not streamed) — at full TDS rate a
        20-second IEEE 39 run with 5 PMUs is ~50 KB, well under the
        Pipe-send threshold.
        """
        import csv
        import io

        ss = self._require_loaded()
        # Gate on setup so the caller sees a clean 409 rather than an
        # opaque KeyError when ``ss.dae.ts`` hasn't been populated yet.
        if not ss.is_setup:
            raise SetupFailedError(
                "PMU export requires a TDS run; setup() has not been "
                "committed on this session"
            )

        pmu = getattr(ss, "PMU", None)
        pmu_idx_v = list(
            getattr(getattr(pmu, "idx", None), "v", []) if pmu is not None else []
        )

        # ``dae.ts`` exposes ``t`` (1-D) and ``x`` (2-D, [steps, n_states])
        # arrays once unpacked. ``unpack`` is safe to call repeatedly —
        # it's the documented bridge from the dict-based per-step storage
        # to the numpy-array post-run view.
        ts = ss.dae.ts
        # Trigger unpack into numpy arrays (warn_empty=False so an
        # uncalled-TDS session doesn't spam the log; we surface the
        # empty case as a header-only CSV instead).
        ts.unpack_np(attr=None, warn_empty=False)
        t_arr = list(getattr(ts, "t", []))

        # Collect (am.a, vm.a) addresses per PMU. ANDES's ``State.a``
        # array holds the integer addresses into ``dae.x`` for that
        # state's per-device entries (so ``am.a[i]`` is the column in
        # ``dae.ts.x`` for the i-th PMU's am state).
        am_addrs: list[int] = []
        vm_addrs: list[int] = []
        if pmu is not None and pmu_idx_v:
            am_addrs = [int(a) for a in getattr(pmu.am, "a", [])]
            vm_addrs = [int(a) for a in getattr(pmu.vm, "a", [])]

        # Build the column header. Two columns per PMU: <idx>_am, <idx>_vm.
        header: list[str] = ["t"]
        for pidx in pmu_idx_v:
            header.append(f"{pidx}_am")
            header.append(f"{pidx}_vm")

        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\n")
        writer.writerow(header)

        x_matrix = getattr(ts, "x", None)
        # ``x`` shape: (n_steps, n_states). Empty when no TDS step has
        # fired (or the run was aborted at t=0). Either way ship the
        # header-only body and let the caller decide.
        n_steps = len(t_arr)
        for i in range(n_steps):
            row: list[str] = [f"{float(t_arr[i]):.10g}"]
            x_row = x_matrix[i] if x_matrix is not None and i < len(x_matrix) else None
            for j in range(len(pmu_idx_v)):
                am_val: float
                vm_val: float
                if (
                    x_row is not None
                    and j < len(am_addrs)
                    and j < len(vm_addrs)
                    and am_addrs[j] < len(x_row)
                    and vm_addrs[j] < len(x_row)
                ):
                    am_val = float(x_row[am_addrs[j]])
                    vm_val = float(x_row[vm_addrs[j]])
                else:
                    am_val = 0.0
                    vm_val = 0.0
                row.append(f"{am_val:.10g}")
                row.append(f"{vm_val:.10g}")
            writer.writerow(row)

        return buf.getvalue()

    # ----- TimeSeries profiles (Unit 15) -----
    #
    # Workflow: the user uploads an xlsx (or csv) hourly profile, the
    # substrate writes it under ``<workspace>/profiles/<uuid>.xlsx``,
    # then the user assigns the profile to a target device via
    # ``add_timeseries`` which calls ``ss.add('TimeSeries', ...)`` while
    # the System is still pre-setup. ANDES's ``TimeSeries`` model reads
    # the file at ``setup()`` time (see ``andes/models/timeseries.py``
    # ``list2array``), which is why the file MUST be on disk before
    # setup commits — we validate existence at add time so the user
    # gets a clean 422 instead of a setup-time crash.
    #
    # Mode constraint per the Unit 1a spike: ``apply_interpolate``
    # raises ``NotImplementedError`` (line 230 of timeseries.py) so the
    # substrate accepts only ``mode=1`` (exact-match step times). The
    # route layer rejects mode=2 with 422 + actionable hint.

    def upload_profile(
        self, filename: str, content_bytes: bytes
    ) -> str:
        """Persist an uploaded CSV/XLSX profile to ``<workspace>/profiles/``.

        Returns the absolute path of the written xlsx file. CSV uploads
        are transcoded to xlsx (single sheet named ``profile``) using
        openpyxl so ANDES's ``TimeSeries`` reader (which only handles
        xlsx/xls/csv but the substrate canonicalises to xlsx for
        consistency) sees a uniform input.

        ``filename`` is the original upload filename — used only to
        detect the ``.csv`` vs ``.xlsx`` extension. The on-disk filename
        is a fresh uuid to avoid collisions across uploads.

        Raises ``ElementValidationError`` on a malformed payload (CSV
        parse failure, openpyxl write failure, unsupported extension).
        Raises ``NoCaseLoadedError`` (→ 409) when the substrate was
        launched without a workspace — the route layer surfaces a
        "workspace not configured" hint.
        """
        import csv as _csv
        import io
        import uuid

        if self._workspace is None:
            raise NoCaseLoadedError(
                "profile upload requires a workspace; the substrate "
                "was launched without one"
            )
        ext = Path(filename).suffix.lower()
        if ext not in (".csv", ".xlsx"):
            raise ElementValidationError(
                f"unsupported profile extension {ext!r}; "
                "only .csv and .xlsx are accepted"
            )

        profiles_dir = self._workspace / "profiles"
        try:
            profiles_dir.mkdir(mode=0o700, exist_ok=True)
        except OSError as exc:
            raise SetupFailedError(
                f"failed to create profiles directory: "
                f"{_sanitize_message(str(exc))}"
            ) from exc
        target = profiles_dir / f"{uuid.uuid4().hex}.xlsx"

        if ext == ".xlsx":
            try:
                target.write_bytes(content_bytes)
            except OSError as exc:
                raise SetupFailedError(
                    f"failed to write profile file: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
        else:
            # CSV → XLSX via openpyxl. Single-sheet workbook named
            # "profile" so the ``add_timeseries(sheet=...)`` argument
            # has a stable default the UI can pre-fill.
            try:
                import openpyxl  # type: ignore[import-untyped,unused-ignore]
            except ImportError as exc:  # pragma: no cover — listed in deps
                raise SetupFailedError(
                    "openpyxl is required for CSV profile transcoding "
                    "but is not installed"
                ) from exc
            try:
                text = content_bytes.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise ElementValidationError(
                    f"profile CSV is not UTF-8 decodable: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
            try:
                reader = _csv.reader(io.StringIO(text))
                rows = list(reader)
            except _csv.Error as exc:
                raise ElementValidationError(
                    f"profile CSV parse failed: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc
            if not rows:
                raise ElementValidationError(
                    "profile CSV is empty; need at least a header row"
                )
            wb = openpyxl.Workbook()
            ws = wb.active
            assert ws is not None
            ws.title = "profile"
            for row in rows:
                # Best-effort numeric coercion so xlsx cells aren't all
                # strings — pandas (which ANDES uses to read xlsx) will
                # round-trip the right dtypes when we hand it real
                # numbers.
                coerced: list[Any] = []
                for cell in row:
                    try:
                        coerced.append(float(cell))
                    except (TypeError, ValueError):
                        coerced.append(cell)
                ws.append(coerced)
            try:
                wb.save(str(target))
            except OSError as exc:
                raise SetupFailedError(
                    f"failed to write transcoded profile xlsx: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc

        return str(target)

    def add_timeseries(
        self,
        *,
        profile_path: str,
        sheet: str,
        fields: str,
        model: str,
        dev: int | str,
        dests: str,
        tkey: str = "t",
        mode: int = 1,
    ) -> TopologyEntry:
        """Add a TimeSeries device that schedules ``model.dev``'s
        ``dests`` from columns of ``profile_path`` keyed by ``tkey`` —
        Unit 15.

        Pre-conditions:
        - A case must be loaded; ANDES requires the System to exist
          before ``ss.add('TimeSeries', ...)``.
        - The profile file MUST already exist at ``profile_path`` (the
          ``upload_profile`` flow puts it under
          ``<workspace>/profiles/``). ANDES's ``list2array`` reads the
          file during setup; an absent file causes a setup-time
          ``FileNotFoundError`` that the substrate would have to map
          back to 422 anyway. We pre-validate so the failure happens
          synchronously at add time.
        - ``mode`` must be 1 (exact). Mode 2 (interpolated) raises
          ``NotImplementedError`` inside ANDES (verified per Unit 1a
          spike). The route layer rejects mode=2 at the schema before
          reaching the wrapper, but the gate here is the second line
          of defence.
        - The session must be pre-setup. Same gate as ``add_pmu`` /
          ``add_disturbance``.

        On success the call is recorded in ``self._replay_buffer`` so
        the TimeSeries survives a blank-session ``reload_case`` cycle
        (Unit 6.5 disturbance-replay parity for non-disturbance
        ``ss.add`` calls).
        """
        ss = self._require_loaded()
        if self._setup_failed:
            raise SetupFailedError(
                "previous setup() failed; the System is in an inconsistent state"
            )
        if ss.is_setup:
            raise DisturbanceCommitError()
        if int(mode) != 1:
            raise ElementValidationError(
                "TimeSeries mode=2 (interpolated) raises NotImplementedError "
                "in ANDES (verified per Unit 1a spike); use mode=1 (exact)."
            )

        path_obj = Path(profile_path)
        if not path_obj.exists():
            raise ElementValidationError(
                f"profile file does not exist at {profile_path!r}; "
                "upload it first via POST /sessions/{id}/profiles/upload"
            )
        # The substrate only writes profile files under
        # ``<workspace>/profiles/``. Reject attempts to point at files
        # outside the workspace so a malicious payload can't trick the
        # wrapper into reading arbitrary user files at setup time.
        if self._workspace is not None:
            try:
                resolved = path_obj.resolve()
                workspace_resolved = self._workspace.resolve()
                resolved.relative_to(workspace_resolved)
            except (OSError, ValueError) as exc:
                raise ElementValidationError(
                    f"profile path is outside the workspace: "
                    f"{_sanitize_message(str(exc))}"
                ) from exc

        # Pre-validate the target model + device exists so the user
        # sees an actionable 422 rather than ANDES's opaque "device
        # not exist" later.
        target_model_obj = getattr(ss, model, None)
        if target_model_obj is None:
            raise ElementValidationError(
                f"target model {model!r} not present on the loaded System"
            )
        target_idx_var = getattr(target_model_obj, "idx", None)
        target_idx_values = list(
            getattr(target_idx_var, "v", []) if target_idx_var is not None else []
        )
        dev_str = str(dev)
        resolved_dev: int | str | None = None
        for value in target_idx_values:
            if str(value) == dev_str:
                resolved_dev = value
                break
        if resolved_dev is None:
            raise ElementValidationError(
                f"no {model} with idx={dev!r} on the loaded System; "
                "TimeSeries needs an existing target device"
            )

        params: dict[str, Any] = {
            "mode": int(mode),
            "path": str(path_obj),
            "sheet": str(sheet),
            "fields": str(fields),
            "tkey": str(tkey),
            "model": str(model),
            "dev": resolved_dev,
            "dests": str(dests),
        }
        replay_snapshot = dict(params)
        try:
            new_idx = ss.add("TimeSeries", params)
        except Exception as exc:  # noqa: BLE001
            raise ElementValidationError(
                f"ANDES rejected TimeSeries add: "
                f"{_sanitize_message(str(exc))}"
            ) from exc

        # Record into the generic replay buffer so blank-session
        # reload-and-replay carries the TimeSeries (parity with PMU /
        # add_element).
        if len(self._replay_buffer) >= REPLAY_BUFFER_MAX:
            dropped, _ = self._replay_buffer.pop(0)
            logging.getLogger("andes-app.wrapper.replay").warning(
                "replay buffer at cap (%d); dropping oldest entry (model=%r)",
                REPLAY_BUFFER_MAX,
                dropped,
            )
        replay_snapshot["idx"] = new_idx
        self._replay_buffer.append(("TimeSeries", replay_snapshot))

        entry = self._lookup_topology_entry("TimeSeries", new_idx)
        if entry is None:
            raise ElementValidationError(
                f"ANDES accepted TimeSeries add but no device with "
                f"idx={new_idx!r} was found on read-back"
            )
        return entry

    def list_timeseries(self) -> list[TopologyEntry]:
        """Return every TimeSeries instance currently on the loaded
        System — Unit 15.

        Empty list when none have been added. Reads via
        ``_collect_models`` so works pre- or post-setup.
        """
        ss = self._require_loaded()
        return _collect_models(ss, ["TimeSeries"])

    def delete_timeseries(self, idx: int | str) -> None:
        """Remove a TimeSeries previously added via :meth:`add_timeseries`
        — Unit 15.

        Same pre-setup gate as ``delete_element``. Implementation
        delegates to ``delete_element`` so the buffer rewind +
        reload-and-replay machinery is shared. Cascade walk is empty
        for TimeSeries (no other model class references it).

        Raises ``ElementNotFoundError`` (→ 404) when no TimeSeries
        with that idx exists; ``DisturbanceCommitError`` (→ 409) when
        setup is committed.
        """
        self.delete_element("TimeSeries", idx)

    # ----- snapshot (Unit 7) -----

    def save_snapshot(
        self, name: str, *, force: bool = False
    ) -> dict[str, Any]:
        """Save the current System state as a snapshot — Unit 7.

        Composes two artefacts on disk:

        - ``<name>.dill`` — ANDES's ``andes.utils.snapshot.save_ss`` blob.
          Carries the complete System state (DAE arrays, PF / TDS state).
          Version-locked to the current ANDES install.
        - ``<name>.json`` — sidecar metadata: ANDES + andes_app versions,
          case filename + sha256, recorded ``_disturbance_log``,
          ``has_pflow`` / ``has_tds`` flags. The disturbance log is the
          always-works restore path's source of truth (Unit 6.5).

        ``force=False`` (default) refuses to overwrite an existing
        snapshot under the same name, raising
        :class:`SnapshotCollisionError` (mapped to HTTP 409 by the route
        layer). ``force=True`` overwrites silently.
        """
        from andes_app import __version__ as andes_app_version
        from andes_app.core.snapshot import (
            SnapshotCollisionError,
            SnapshotMetadata,
            snapshot_dir,
            snapshot_paths,
            validate_snapshot_name,
            write_snapshot_files,
        )

        ss = self._require_loaded()
        if self._workspace is None:
            raise NoCaseLoadedError(
                "snapshot save requires a workspace; the substrate "
                "was launched without one"
            )
        validated = validate_snapshot_name(name)

        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        # Ensure the directory exists before the dill writer touches it.
        snapshot_dir(self._workspace, case_filename)
        dill_path, json_path = snapshot_paths(
            self._workspace, case_filename, validated
        )
        if not force and (dill_path.exists() or json_path.exists()):
            raise SnapshotCollisionError(
                f"snapshot {validated!r} already exists; pass force=true "
                "to overwrite or pick a different name"
            )

        # Compute case sha256 for the metadata's integrity audit.
        case_sha256: str | None = None
        if self._case_path is not None and self._case_path.exists():
            try:
                case_sha256 = hashlib.sha256(
                    self._case_path.read_bytes()
                ).hexdigest()
            except OSError:
                # Best-effort — a missing-but-was-loaded case can still be
                # snapshotted from the in-memory System; the integrity
                # audit just won't have a hash to compare against.
                case_sha256 = None

        # Capture state flags BEFORE save_ss runs so we record the System's
        # current truth, not whatever side effect the save touches.
        has_pflow = bool(getattr(ss.PFlow, "converged", False))
        tds = getattr(ss, "TDS", None)
        has_tds = bool(getattr(tds, "initialized", False))

        # ANDES's save_ss is dill-based; lazy-import keeps the wrapper's
        # own import cost paid only by callers that hit the snapshot path.
        import andes
        from andes.utils.snapshot import save_ss

        andes_version = str(getattr(andes, "__version__", "unknown"))

        try:
            saved_at = datetime.now(UTC).isoformat()
            metadata = SnapshotMetadata(
                andes_version=andes_version,
                andes_app_version=str(andes_app_version),
                case_filename=case_filename,
                case_sha256=case_sha256,
                disturbance_log=[
                    spec.model_dump() for spec in self._disturbance_log
                ],
                saved_at=saved_at,
                has_pflow=has_pflow,
                has_tds=has_tds,
            )

            def _writer(path: str) -> None:
                save_ss(path, ss)

            dill_bytes, json_bytes = write_snapshot_files(
                dill_path=dill_path,
                json_path=json_path,
                dill_writer=_writer,
                metadata=metadata,
            )
        except SnapshotCollisionError:
            raise
        except Exception as exc:  # noqa: BLE001
            # Best-effort cleanup so a half-written snapshot doesn't get
            # surfaced by the listing endpoint.
            for p in (dill_path, json_path):
                with contextlib.suppress(OSError):
                    if p.exists():
                        p.unlink()
            raise SetupFailedError(
                f"snapshot save failed: {_sanitize_message(str(exc))}"
            ) from exc

        return {
            "name": validated,
            "metadata": metadata.to_dict(),
            "dill_bytes": dill_bytes,
            "metadata_bytes": json_bytes,
        }

    def restore_snapshot(
        self, name: str, *, use_dill_optimization: bool = True
    ) -> dict[str, Any]:
        """Restore a previously-saved snapshot — Unit 7.

        Two-tier restore:

        1. Read the sidecar JSON; validate the version stamp. If the
           ANDES major.minor differs from the current install, the dill
           optimisation is forcibly disabled and ``fallback_reason`` is
           recorded for the response.
        2. Always-works path: ``reload_case`` (drops ``is_setup`` and
           clears the in-memory ``_disturbance_log``) →
           ``replay_disturbances()`` from the JSON's recorded log.
        3. Fast path (dill optimisation enabled and version OK):
           ``andes.utils.snapshot.load_ss`` substitutes a fresh System
           with the captured PF / TDS state. ``_ensure_setup`` +
           ``run_pflow`` are skipped.
        4. Slow path (otherwise): ``_ensure_setup`` + ``run_pflow`` to
           re-converge to the same operating point.

        Raises :class:`SnapshotNotFoundError` (404) when the named
        snapshot does not exist; :class:`SnapshotMetadataError` (422)
        on a corrupted sidecar; :class:`SnapshotVersionMismatchError`
        (422) if the caller forced ``use_dill_optimization=True``
        explicitly AND the dill version-check failed.
        """
        from andes_app.core.snapshot import (
            DISTURBANCE_LOG_CAP,
            RestoreSnapshotResult,
            SnapshotMetadataError,
            read_snapshot_metadata,
            snapshot_paths,
            validate_snapshot_name,
            versions_compatible,
        )

        if self._workspace is None:
            raise NoCaseLoadedError(
                "snapshot restore requires a workspace; the substrate "
                "was launched without one"
            )
        validated = validate_snapshot_name(name)
        if self._ss is None and self._case_path is None:
            raise NoCaseLoadedError(
                "snapshot restore requires a loaded case to scope the "
                "snapshot directory; load a case first"
            )

        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        dill_path, json_path = snapshot_paths(
            self._workspace, case_filename, validated
        )
        metadata = read_snapshot_metadata(json_path)
        if len(metadata.disturbance_log) > DISTURBANCE_LOG_CAP:
            raise SnapshotMetadataError(
                f"snapshot {validated!r} has "
                f"{len(metadata.disturbance_log)} disturbances; cap is "
                f"{DISTURBANCE_LOG_CAP}"
            )

        import andes

        current_version = str(getattr(andes, "__version__", "unknown"))
        version_ok = versions_compatible(metadata.andes_version, current_version)
        dill_available = dill_path.exists()

        used_dill = False
        fallback_reason: str | None = None

        if use_dill_optimization and not dill_available:
            fallback_reason = (
                f"dill blob {dill_path.name} not found alongside the "
                "metadata; falling back to replay+PF"
            )
        elif use_dill_optimization and not version_ok:
            fallback_reason = (
                f"snapshot was written against ANDES "
                f"{metadata.andes_version}; current install is "
                f"{current_version} — dill format is version-locked, "
                "falling back to replay+PF"
            )

        # Disturbance specs come back as plain dicts; rebuild via the
        # discriminated union so wrapper.add_disturbance accepts them.
        from andes_app.core.disturbance import (
            AlterSpec,
            FaultSpec,
            ToggleSpec,
        )

        def _spec_from_dict(d: dict[str, Any]) -> DisturbanceSpec:
            kind = d.get("kind")
            if kind == "fault":
                return FaultSpec(**d)
            if kind == "toggle":
                return ToggleSpec(**d)
            if kind == "alter":
                return AlterSpec(**d)
            raise SnapshotMetadataError(
                f"snapshot disturbance has unknown kind: {kind!r}"
            )

        # Reload (clears ``_disturbance_log`` + ``is_setup``); replay the
        # snapshot's disturbances onto the fresh pre-setup System.
        self.reload_case()
        replayed = 0
        for raw_spec in metadata.disturbance_log:
            spec = _spec_from_dict(raw_spec)
            self.add_disturbance(spec)
            replayed += 1

        if use_dill_optimization and version_ok and dill_available:
            # Fast path: load_ss replaces the System entirely. After this
            # the wrapper's ``_ss`` reference must point at the dill-loaded
            # System; the just-replayed disturbances on the previous
            # pre-setup System are dropped on the floor (the dill blob
            # carries the equivalent in its serialised state).
            from andes.utils.snapshot import load_ss

            try:
                ss_loaded = load_ss(str(dill_path))
            except Exception as exc:  # noqa: BLE001
                # Defensive: a corrupted dill should fall back, not crash.
                fallback_reason = (
                    "dill load failed "
                    f"({type(exc).__name__}); falling back to replay+PF"
                )
                ss_loaded = None
                logging.getLogger("andes-app.wrapper.snapshot").warning(
                    "snapshot %r dill load failed: %s; "
                    "falling back to slow path",
                    validated,
                    _sanitize_message(str(exc)),
                )

            if ss_loaded is not None:
                self._ss = ss_loaded
                used_dill = True

        # Slow path: setup + PF on the post-replay System. PF is
        # idempotent; if the user only wanted the disturbance list back
        # (snapshot was saved pre-setup) the meta's has_pflow=False
        # tells us to stop here.
        if not used_dill and metadata.has_pflow:
            self._ensure_setup()
            ss = self._require_loaded()
            ss.PFlow.run()

        return RestoreSnapshotResult(
            used_dill=used_dill,
            metadata=metadata,
            fallback_reason=fallback_reason,
            disturbances_replayed=replayed,
        ).__dict__ | {"metadata": metadata.to_dict()}

    def list_snapshots(self) -> list[dict[str, Any]]:
        """Return the listing of snapshots for the current case.

        Empty list (NOT an error) when no snapshots have been saved
        against this case yet, when no case has been loaded, or when
        the substrate has no workspace configured. The route layer
        ships an empty array in those cases so the UI's "Load
        snapshot…" menu can render its empty state without a
        round-trip dance.
        """
        from andes_app.core.snapshot import list_snapshots_on_disk

        if self._workspace is None:
            return []
        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        # When no case is loaded AND no blank session has been built,
        # there's nothing meaningful to list — return empty.
        if self._ss is None and self._case_path is None:
            return []
        entries = list_snapshots_on_disk(self._workspace, case_filename)
        return [
            {
                "name": e.name,
                "saved_at": e.saved_at,
                "has_pflow": e.has_pflow,
                "has_tds": e.has_tds,
                "has_dill": e.has_dill,
                "andes_version": e.andes_version,
                "disturbance_count": e.disturbance_count,
            }
            for e in entries
        ]

    def delete_snapshot(self, name: str) -> None:
        """Delete a snapshot by name. No-op-safe — re-deleting a
        previously-deleted snapshot raises :class:`SnapshotNotFoundError`.
        """
        from andes_app.core.snapshot import delete_snapshot_files

        if self._workspace is None:
            raise NoCaseLoadedError(
                "snapshot delete requires a workspace; the substrate "
                "was launched without one"
            )
        case_filename = (
            self._case_path.name if self._case_path is not None else None
        )
        delete_snapshot_files(self._workspace, case_filename, name)

    # ----- sensitivity sweep (Unit 18) -----

    def run_sweep(
        self,
        *,
        snapshot_name: str,
        parameter_kind: str,
        parameter_target: int,
        values: list[float],
        tf: float,
        h: float | None = None,
        on_iteration: Callable[[int, float, dict[str, Any]], None] | None = None,
        abort_flag: Event | None = None,
    ) -> dict[str, Any]:
        """Run a sensitivity sweep — Unit 18.

        For each value in ``values``:

        1. Restore the named snapshot via the always-works replay+PF
           path (``use_dill_optimization=False``). This sidesteps the
           ANDES post-iteration cleanup gap by always returning to a
           pre-setup System with the snapshot's recorded
           ``disturbance_log``.
        2. Override the target disturbance spec's field with the
           current iteration's value (the disturbance log was just
           re-built inside the wrapper by ``restore_snapshot``; we
           re-replay with the override).
        3. Run TDS with the requested ``tf`` / ``h``.
        4. Record the iteration result.

        Diverging or otherwise-failing iterations are recorded with
        ``error`` set and the sweep continues. Aborts (via
        ``abort_flag``) cause the loop to exit at the next iteration
        boundary; iterations completed so far are returned with
        ``truncated=True``.

        ``on_iteration`` is invoked AFTER each iteration with
        ``(iter_idx, parameter_value, result_dict)``. The worker uses
        this to ship per-iteration progress over the data_pipe.

        Returns a dict with ``iterations`` (list of per-iteration
        result dicts) and ``truncated`` (bool). The route layer is
        responsible for adding the sweep_id.
        """
        # Lazy import keeps the module-level import graph free of the
        # sweep types (which import from this module's siblings).
        from andes_app.core.sweep import (
            SweepValidationError,
            parse_sweep_target,
        )

        if self._workspace is None:
            raise NoCaseLoadedError(
                "sweep requires a workspace; the substrate "
                "was launched without one"
            )

        expected_kind, spec_field = parse_sweep_target(parameter_kind)

        log = logging.getLogger("andes-app.wrapper.sweep")

        iterations_out: list[dict[str, Any]] = []
        truncated = False

        for idx, value in enumerate(values):
            # Honor abort BEFORE starting an expensive iteration. The
            # abort flag is also wired into ``run_tds`` via the
            # ``abort_flag`` parameter so a mid-iteration abort fires
            # at the next callpert tick.
            if abort_flag is not None and abort_flag.is_set():
                truncated = True
                break

            iter_error: str | None = None
            converged = False
            final_t = 0.0
            callpert_count = 0

            try:
                # 1. Restore snapshot via the always-works slow path so
                #    every iteration starts from an identical pre-setup
                #    System with the recorded disturbance log replayed.
                #    After this: ``self._disturbance_log`` is populated
                #    from the snapshot's sidecar JSON; the System is
                #    post-setup (when has_pflow=True at save time).
                self.restore_snapshot(
                    snapshot_name, use_dill_optimization=False
                )

                # 2. Capture the snapshot's disturbance log BEFORE we
                #    reload_case (which clears the log). The capture is
                #    the source of truth for what the sweep iterates
                #    over.
                snap_log = list(self._disturbance_log)  # noqa: SLF001
                if parameter_target >= len(snap_log):
                    raise SweepValidationError(
                        f"sweep target index {parameter_target} out of range; "
                        f"snapshot recorded {len(snap_log)} disturbance(s)"
                    )
                target_spec = snap_log[parameter_target]
                # 3. reload_case() returns to a clean pre-setup System
                #    + clears the wrapper's log so we can re-add the
                #    mutated spec via ``add_disturbance`` (ANDES rejects
                #    post-setup add() — the only escape is reload).
                self.reload_case()
                snap_log_after = snap_log
                # Validate the kind matches what the snapshot has.
                if target_spec.kind != expected_kind:
                    raise SweepValidationError(
                        f"sweep kind {parameter_kind!r} expects "
                        f"{expected_kind!r} disturbance at target "
                        f"{parameter_target}, found {target_spec.kind!r}"
                    )
                # Build a new spec with the override applied via
                # Pydantic's ``model_copy`` — preserves the discriminator
                # and any unrelated fields, only the target field is
                # replaced. ``model_copy(update={...})`` is Pydantic v2's
                # immutable update API.
                mutated = target_spec.model_copy(update={spec_field: float(value)})
                # Replace the entry in our reload's log + re-add to the
                # System. We rebuild the wrapper's log from scratch so
                # the in-memory state matches what we're about to
                # commit.
                self._disturbance_log = []
                for j, spec in enumerate(snap_log_after):
                    out_spec = mutated if j == parameter_target else spec
                    self.add_disturbance(out_spec)

                # 3. Run TDS. The wrapper's ``run_tds`` invokes
                #    ``_ensure_setup`` + ``ss.PFlow.run`` itself. The
                #    abort_flag is forwarded so an in-flight iteration
                #    can be terminated.
                tds_result = self.run_tds(
                    tf=tf,
                    h=h,
                    abort_flag=abort_flag,
                )
                converged = bool(tds_result.converged)
                final_t = float(tds_result.final_t)
                callpert_count = int(tds_result.callpert_count)
            except Exception as exc:  # noqa: BLE001
                # Per-iteration failures are recorded but do NOT abort
                # the sweep — researchers want to see WHICH parameter
                # values diverged, not just "sweep died at iter N".
                iter_error = (
                    f"{type(exc).__name__}: {_sanitize_message(str(exc))}"
                )
                log.warning(
                    "sweep iteration %d (value=%g) failed: %s",
                    idx,
                    value,
                    iter_error,
                )

            iter_dict: dict[str, Any] = {
                "iteration": idx,
                "parameter_value": float(value),
                "converged": converged,
                "final_t": final_t,
                "callpert_count": callpert_count,
                "error": iter_error,
            }
            iterations_out.append(iter_dict)

            if on_iteration is not None:
                try:
                    on_iteration(idx, float(value), iter_dict)
                except Exception:  # noqa: BLE001
                    # Progress callback failures must never crash the
                    # sweep; the data_pipe forwarding may have hit a
                    # broken pipe, in which case we just continue.
                    log.exception("sweep on_iteration callback raised")

            # Final post-iteration abort check — the run_tds may have
            # honoured the abort flag mid-integration (busted=True);
            # in that case ``converged`` is False and we should stop
            # the outer loop here.
            if abort_flag is not None and abort_flag.is_set():
                truncated = True
                break

        return {
            "iterations": iterations_out,
            "truncated": truncated,
            "total_requested": len(values),
        }

    # ----- bundle import (Unit 10) -----

    def import_bundle(  # noqa: C901
        self,
        zip_bytes: bytes,
        *,
        force_resolve: bool = False,
        use_bundle_case: bool = True,
        accept_version_mismatch: bool = True,
    ) -> dict[str, Any]:
        """Import a reproducibility bundle — Unit 10.

        Two-phase orchestration:

        1. :func:`validate_bundle` decodes the manifest, verifies the
           case file is present, computes any conflicts (sha mismatch,
           ANDES version mismatch, addfile missing). If conflicts exist
           and ``force_resolve=False``, returns a plan dict so the
           route layer can short-circuit with a 409 + the conflict
           list for the UI to render.
        2. When ``force_resolve=True`` (or no conflicts surfaced):
           :func:`extract_bundle` writes the case file(s) into the
           workspace honouring the resolution choices, then
           :meth:`load_case` boots the new System and
           :meth:`add_disturbance` replays the bundle's disturbance
           list via the same path Unit 6.5's ``replay_disturbances``
           uses (one ``ss.add(...)`` per spec on a fresh pre-setup
           System).

        Returns a dict with keys:

        - ``status``: ``"plan"`` (conflicts surfaced; nothing committed)
          or ``"committed"`` (case + disturbances loaded successfully).
        - ``plan``: serialised :class:`BundleImportPlan` (always
          present, so the UI can echo manifest metadata even on commit).
        - ``warnings``: list of free-form strings from the extraction +
          replay steps. Populated on commit; empty on plan.
        - ``case_filename``, ``addfile_filenames``: post-commit only.
        - ``disturbances_replayed``: post-commit only; count of specs
          successfully re-applied to the new System.
        """
        from andes_app.core.bundle import (
            BundleResolveChoices,
            bundle_plan_to_dict,
            extract_bundle,
            read_bundle_disturbances,
            validate_bundle,
        )

        if self._workspace is None:
            raise NoCaseLoadedError(
                "bundle import requires a workspace; the substrate "
                "was launched without one"
            )

        import andes  # heavy import — kept lazy

        current_andes = str(getattr(andes, "__version__", "unknown"))
        plan = validate_bundle(
            zip_bytes,
            workspace=self._workspace,
            current_andes_version=current_andes,
        )

        plan_dict = bundle_plan_to_dict(plan)

        # Plan-only branch: surface the conflicts so the UI's
        # BundleConflictResolver can render the side-by-side diff.
        if plan.has_conflicts and not force_resolve:
            return {
                "status": "plan",
                "plan": plan_dict,
                "warnings": [],
            }

        # Commit branch — never reached when blocked even with
        # force_resolve, because extract_bundle re-checks ``plan.blocked``
        # and raises BundleValidationError("bundle-blocked") which the
        # worker boundary turns into a 422.
        resolve = BundleResolveChoices(
            use_bundle_case=use_bundle_case,
            accept_version_mismatch=accept_version_mismatch,
        )
        extraction = extract_bundle(
            zip_bytes,
            workspace=self._workspace,
            resolve=resolve,
            plan=plan,
        )

        primary_path = Path(extraction["primary_path"])
        addfile_paths = [Path(p) for p in extraction["addfile_paths"]]
        warnings = list(extraction.get("warnings") or [])

        # Hand off to load_case — it resets disturbance log + replay
        # buffer + se measurements (the contract documented at
        # load_case's docstring), so we replay disturbances AFTER.
        load_addfiles: list[str | Path] | None = (
            [Path(p) for p in addfile_paths] if addfile_paths else None
        )
        self.load_case(primary_path, addfiles=load_addfiles)

        replay_specs = read_bundle_disturbances(zip_bytes)
        replayed = 0
        for raw in replay_specs:
            kind = raw.get("kind")
            if kind == "fault":
                spec: DisturbanceSpec = FaultSpec(**raw)
            elif kind == "toggle":
                spec = ToggleSpec(**raw)
            elif kind == "alter":
                spec = AlterSpec(**raw)
            else:
                # Should be unreachable — read_bundle_disturbances rejects
                # unknown kinds at the validator boundary. Belt-and-braces.
                warnings.append(
                    f"skipped disturbance with unknown kind: {kind!r}"
                )
                continue
            try:
                self.add_disturbance(spec)
                replayed += 1
            except DisturbanceValidationError as exc:
                # ANDES rejected the spec on the new System (e.g., bus
                # idx no longer present after a case-level edit). We
                # surface as a warning rather than aborting the import
                # — the user has the case loaded and can review the
                # disturbance list inline.
                warnings.append(
                    f"disturbance {raw} rejected on new System: {exc}"
                )

        return {
            "status": "committed",
            "plan": plan_dict,
            "warnings": warnings,
            "case_filename": primary_path.name,
            "addfile_filenames": [p.name for p in addfile_paths],
            "disturbances_replayed": replayed,
        }

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


# Maximum number of dependents returned in the 422 ``DeleteBlockedResponse``
# body. The full count is reported separately as ``total`` so the UI can
# render a "Showing 25 of N dependents" footer when truncated. 25 is enough
# to identify the structural problem on any realistic case; deleting the
# first 25 dependents and re-trying is the recovery path.
DELETE_DEPENDENTS_CAP = 25


# Per-model reference attributes for the cascade walker. Each (model_class,
# attribute_name) pair indicates a downstream reference to a Bus idx. The
# walker uses this table when ``delete_element`` targets a Bus.
#
# Coverage invariant: every model in ``_PARAMS_BY_MODEL`` whose schema
# carries ``bus``/``bus1``/``bus2`` reference fields must appear here. A
# coverage assertion in the test suite enforces this.
_REFERENCE_ATTRS: dict[str, tuple[str, ...]] = {
    "Line": ("bus1", "bus2"),
    "PV": ("bus",),
    "Slack": ("bus",),
    "GENROU": ("bus",),
    "GENCLS": ("bus",),
    "PQ": ("bus",),
    "ZIP": ("bus",),
    "Shunt": ("bus",),
    # REGCA1 attaches directly to a Bus via its mandatory ``bus`` IdxParam
    # (regca1.py:22).
    "REGCA1": ("bus",),
    # Unit 14: PMU also references a Bus directly via its mandatory
    # ``bus`` IdxParam (pmu.py:15). Deleting a Bus that has a PMU
    # attached must surface the PMU as a dependent.
    "PMU": ("bus",),
    # The remaining Unit 8 dynamic models reference SynGen (``syn``),
    # Exciter (``avr``), or other non-Bus models — not a Bus directly. The
    # cascade walker only triggers on Bus deletion, so these entries carry
    # an empty tuple: present to satisfy the
    # _find_dependents-coverage invariant (see
    # ``test_find_dependents_covers_every_whitelisted_model``), but
    # contributing no Bus-deletion fan-out.
    "IEEEX1": (),
    "ESDC2A": (),
    "SEXS": (),
    "IEEEG1": (),
    "TGOV1": (),
    "IEEEST": (),
    # Unit 15 (v3.1): REGCP1 attaches directly to a Bus via its
    # ``bus`` IdxParam (regcp1.py / regca1.py:22, the shared
    # REGCAData base), so a Bus deletion must surface it as a
    # dependent. The remaining R15 models reference SynGen (``syn``),
    # Exciter (``avr``), RenGen (``reg``), or RenExciter (``ree``) —
    # never a Bus directly — so they carry an empty tuple purely to
    # satisfy the _find_dependents-coverage invariant.
    "REGCP1": ("bus",),
    "EXST1": (),
    "ESST1A": (),
    "GAST": (),
    "HYGOV": (),
    "IEESGO": (),
    "ST2CUT": (),
    "REECA1": (),
    "REPCA1": (),
    # Unit 15: TimeSeries references a target device via the (model,
    # dev) pair, not a Bus directly. The cascade walker only triggers
    # on Bus deletion today; this entry is present to satisfy the
    # coverage invariant. (Cross-model dev references are deferred —
    # the user gets an ANDES-side error at setup if they delete the
    # target model after staging the TimeSeries; the substrate
    # surfaces the failure via ``SetupFailedError``.)
    "TimeSeries": (),
}


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
ParamKind = Literal["string", "number", "bus_idx", "gen_idx", "bool"]


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
        # ``gen`` links the dynamic machine to its static generator (PV/Slack);
        # ANDES marks it mandatory. Without it the form produced a malformed
        # GENROU (rejected by ANDES + corrupting xlsx save).
        ParamMeta("gen", "gen_idx", required=True),
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
        # See GENROU above — ``gen`` is the mandatory static-generator link.
        ParamMeta("gen", "gen_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        # GENCLS's inertia parameter is ``M`` (ANDES GENCLS has no ``H`` — it
        # was silently dropped before). Mark it required so the machine gets a
        # real inertia instead of a default.
        ParamMeta("M", "number", required=True, unit="MWs/MVA"),
        ParamMeta("D", "number", unit="pu"),
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
    # ----- Dynamic models (Unit 8) -----
    # These extend the topology-edit surface to the 7 highest-priority dynamic
    # device classes researchers attach to synchronous machines: two type-1
    # exciters (IEEEX1, ESDC2A), the simplified SEXS exciter, two governors
    # (IEEEG1 multi-stage steam, TGOV1 single-lag), the IEEEST PSS, and the
    # REGCA1 grid-following converter for renewables. Each entry mirrors the
    # NumParam declarations on the corresponding ANDES model class (excluding
    # ExtParam, which is sourced from a referenced model and not editable).
    #
    # IdxParam refs to non-Bus models (syn → SynGen, syn2 → SynGen optional,
    # avr → Exciter, gen → StaticGen, busr → Bus optional remote, busf →
    # BusFreq optional) carry kind="string" because the substrate has no
    # picker for these device classes today; the form falls back to a plain
    # text input. The mandatory `bus` ref on REGCA1 reuses kind="bus_idx" so
    # the existing Bus picker drives it.
    "IEEEX1": (
        # idx + name from ModelData; syn from ExcBaseData (excbase.py:23,
        # mandatory=True). NumParams from EXDC2Data (exdc2.py:16-93).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("TR", "number", unit="s"),
        ParamMeta("TA", "number", unit="s"),
        ParamMeta("TC", "number", unit="s"),
        ParamMeta("TB", "number", unit="s"),
        ParamMeta("TE", "number", unit="s"),
        ParamMeta("TF1", "number", unit="s"),
        ParamMeta("KF1", "number", unit="pu"),
        ParamMeta("KA", "number", unit="pu"),
        ParamMeta("KE", "number", unit="pu"),
        ParamMeta("VRMAX", "number", unit="pu"),
        ParamMeta("VRMIN", "number", unit="pu"),
        ParamMeta("E1", "number", unit="pu"),
        ParamMeta("SE1", "number", unit="pu"),
        ParamMeta("E2", "number", unit="pu"),
        ParamMeta("SE2", "number", unit="pu"),
    ),
    "ESDC2A": (
        # idx + name from ModelData; syn from ExcBaseData (excbase.py:23).
        # NumParams from ESDC2AData (esdc2a.py:14-92). `Switch` is a numeric
        # mode flag that PSS/E doesn't implement but ANDES exposes.
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("TR", "number", unit="s"),
        ParamMeta("KA", "number", unit="pu"),
        ParamMeta("TA", "number", unit="s"),
        ParamMeta("TB", "number", unit="s"),
        ParamMeta("TC", "number", unit="s"),
        ParamMeta("VRMAX", "number", unit="pu"),
        ParamMeta("VRMIN", "number", unit="pu"),
        ParamMeta("KE", "number", unit="pu"),
        ParamMeta("TE", "number", unit="s"),
        ParamMeta("KF", "number", unit="pu"),
        ParamMeta("TF1", "number", unit="s"),
        ParamMeta("Switch", "number"),
        ParamMeta("E1", "number", unit="pu"),
        ParamMeta("SE1", "number", unit="pu"),
        ParamMeta("E2", "number", unit="pu"),
        ParamMeta("SE2", "number", unit="pu"),
    ),
    "SEXS": (
        # idx + name from ModelData; syn from ExcBaseData (excbase.py:23).
        # NumParams from SEXSData (sexs.py:13-43).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("TATB", "number"),
        ParamMeta("TB", "number", unit="s"),
        ParamMeta("K", "number", unit="pu"),
        ParamMeta("TE", "number", unit="s"),
        ParamMeta("EMIN", "number", unit="pu"),
        ParamMeta("EMAX", "number", unit="pu"),
    ),
    "IEEEG1": (
        # idx + name from ModelData; syn (mandatory) + Tn + wref0 from
        # TGBaseData (tgbase.py:17-32). syn2 (optional) plus the K, T*, U*,
        # PMAX/PMIN, K1-K8 NumParams from IEEEG1Data (ieeeg1.py:16-104).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("syn2", "string"),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("K", "number", unit="pu"),
        ParamMeta("T1", "number", unit="s"),
        ParamMeta("T2", "number", unit="s"),
        ParamMeta("T3", "number", unit="s"),
        ParamMeta("UO", "number", unit="pu/s"),
        ParamMeta("UC", "number", unit="pu/s"),
        ParamMeta("PMAX", "number", unit="pu"),
        ParamMeta("PMIN", "number", unit="pu"),
        ParamMeta("T4", "number", unit="s"),
        ParamMeta("K1", "number", unit="pu"),
        ParamMeta("K2", "number", unit="pu"),
        ParamMeta("T5", "number", unit="s"),
        ParamMeta("K3", "number", unit="pu"),
        ParamMeta("K4", "number", unit="pu"),
        ParamMeta("T6", "number", unit="s"),
        ParamMeta("K5", "number", unit="pu"),
        ParamMeta("K6", "number", unit="pu"),
        ParamMeta("T7", "number", unit="s"),
        ParamMeta("K7", "number", unit="pu"),
        ParamMeta("K8", "number", unit="pu"),
    ),
    "TGOV1": (
        # idx + name from ModelData; syn + Tn + wref0 from TGBaseData
        # (tgbase.py:17-32). NumParams from TGOV1Data (tgov1.py:10-42).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("R", "number", unit="pu"),
        ParamMeta("VMAX", "number", unit="pu"),
        ParamMeta("VMIN", "number", unit="pu"),
        ParamMeta("T1", "number", unit="s"),
        ParamMeta("T2", "number", unit="s"),
        ParamMeta("T3", "number", unit="s"),
        ParamMeta("Dt", "number", unit="pu"),
    ),
    "IEEEST": (
        # idx + name from ModelData; avr (mandatory) from PSSBaseData
        # (pssbase.py:19-20). MODE (mandatory), busr/busf (optional refs),
        # and A1-A6, T1-T6, KS, LSMAX/LSMIN, VCU/VCL from IEEESTData
        # (ieeest.py:15-41).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("avr", "string", required=True),
        ParamMeta("MODE", "number", required=True),
        ParamMeta("busr", "string"),
        ParamMeta("busf", "string"),
        ParamMeta("A1", "number", unit="s"),
        ParamMeta("A2", "number", unit="s"),
        ParamMeta("A3", "number", unit="s"),
        ParamMeta("A4", "number", unit="s"),
        ParamMeta("A5", "number", unit="s"),
        ParamMeta("A6", "number", unit="s"),
        ParamMeta("T1", "number", unit="s"),
        ParamMeta("T2", "number", unit="s"),
        ParamMeta("T3", "number", unit="s"),
        ParamMeta("T4", "number", unit="s"),
        ParamMeta("T5", "number", unit="s"),
        ParamMeta("T6", "number", unit="s"),
        ParamMeta("KS", "number", unit="pu"),
        ParamMeta("LSMAX", "number", unit="pu"),
        ParamMeta("LSMIN", "number", unit="pu"),
        ParamMeta("VCU", "number", unit="pu"),
        ParamMeta("VCL", "number", unit="pu"),
    ),
    "REGCA1": (
        # idx + name from ModelData; bus (mandatory ACNode → Bus) and gen
        # (mandatory StaticGen) from REGCA1Data (regca1.py:22-31). NumParams
        # Sn, Tg, Rrpwr, Brkpt, Zerox, Lvplsw, Lvpl1, Volim, Lvpnt0/1,
        # Iolim, Tfltr, Khv, Iqrmax/min, Accel, gammap, gammaq from
        # REGCA1Data (regca1.py:32-108).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("gen", "string", required=True),
        ParamMeta("Sn", "number", unit="MVA"),
        ParamMeta("Tg", "number", unit="s"),
        ParamMeta("Rrpwr", "number", unit="pu"),
        ParamMeta("Brkpt", "number", unit="pu"),
        ParamMeta("Zerox", "number", unit="pu"),
        ParamMeta("Lvplsw", "number"),
        ParamMeta("Lvpl1", "number", unit="pu"),
        ParamMeta("Volim", "number", unit="pu"),
        ParamMeta("Lvpnt1", "number", unit="pu"),
        ParamMeta("Lvpnt0", "number", unit="pu"),
        ParamMeta("Iolim", "number", unit="pu"),
        ParamMeta("Tfltr", "number", unit="s"),
        ParamMeta("Khv", "number", unit="pu"),
        ParamMeta("Iqrmax", "number", unit="pu"),
        ParamMeta("Iqrmin", "number", unit="pu"),
        ParamMeta("Accel", "number"),
        ParamMeta("gammap", "number"),
        ParamMeta("gammaq", "number"),
    ),
    # Unit 15 (v3.1): R15 dynamic-model whitelist expansion. Param names,
    # kinds and units are introspected from the real ANDES 2.0 model classes
    # (see _gen_params provenance). PSS/E names ST6BU / PSS2A have NO ANDES
    # class, so they map to the nearest ANDES-native siblings ESST1A / ST2CUT.
    # Selection mirrors the existing controller entries: idx + name + reference
    # IdxParams + NumParams; the ``u`` flag and ExtParams are excluded.
    "EXST1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("TR", "number"),
        ParamMeta("VIMAX", "number"),
        ParamMeta("VIMIN", "number"),
        ParamMeta("TC", "number"),
        ParamMeta("TB", "number"),
        ParamMeta("KA", "number"),
        ParamMeta("TA", "number"),
        ParamMeta("VRMAX", "number"),
        ParamMeta("VRMIN", "number"),
        ParamMeta("KC", "number"),
        ParamMeta("KF", "number"),
        ParamMeta("TF", "number"),
    ),
    "ESST1A": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("TR", "number"),
        ParamMeta("VIMAX", "number"),
        ParamMeta("VIMIN", "number"),
        ParamMeta("TB", "number"),
        ParamMeta("TC", "number"),
        ParamMeta("TB1", "number"),
        ParamMeta("TC1", "number"),
        ParamMeta("VAMAX", "number", unit="pu"),
        ParamMeta("VAMIN", "number", unit="pu"),
        ParamMeta("KA", "number"),
        ParamMeta("TA", "number"),
        ParamMeta("ILR", "number"),
        ParamMeta("KLR", "number"),
        ParamMeta("VRMAX", "number", unit="pu"),
        ParamMeta("VRMIN", "number", unit="pu"),
        ParamMeta("KF", "number"),
        ParamMeta("TF", "number"),
        ParamMeta("KC", "number"),
        ParamMeta("UELc", "number"),
        ParamMeta("VOSc", "number"),
    ),
    "GAST": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("R", "number", unit="pu"),
        ParamMeta("VMAX", "number", unit="pu"),
        ParamMeta("VMIN", "number", unit="pu"),
        ParamMeta("KT", "number"),
        ParamMeta("AT", "number"),
        ParamMeta("T1", "number"),
        ParamMeta("T2", "number"),
        ParamMeta("T3", "number"),
        ParamMeta("Dt", "number"),
    ),
    "HYGOV": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("R", "number", unit="pu"),
        ParamMeta("r", "number", unit="pu"),
        ParamMeta("GMAX", "number", unit="pu"),
        ParamMeta("GMIN", "number", unit="pu"),
        ParamMeta("VELM", "number", unit="pu"),
        ParamMeta("Tf", "number"),
        ParamMeta("Tr", "number"),
        ParamMeta("Tg", "number"),
        ParamMeta("Dt", "number"),
        ParamMeta("qNL", "number"),
        ParamMeta("Tw", "number"),
        ParamMeta("At", "number"),
    ),
    "IEESGO": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "string", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("T1", "number"),
        ParamMeta("T2", "number"),
        ParamMeta("T3", "number"),
        ParamMeta("T4", "number"),
        ParamMeta("T5", "number"),
        ParamMeta("T6", "number"),
        ParamMeta("K1", "number"),
        ParamMeta("K2", "number"),
        ParamMeta("K3", "number"),
        ParamMeta("PMAX", "number"),
        ParamMeta("PMIN", "number"),
    ),
    "ST2CUT": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("avr", "string", required=True),
        ParamMeta("MODE", "number"),
        ParamMeta("busr", "string", required=True),
        ParamMeta("busf", "string", required=True),
        ParamMeta("MODE2", "number"),
        ParamMeta("busr2", "string", required=True),
        ParamMeta("busf2", "string", required=True),
        ParamMeta("K1", "number"),
        ParamMeta("K2", "number"),
        ParamMeta("T1", "number"),
        ParamMeta("T2", "number"),
        ParamMeta("T3", "number"),
        ParamMeta("T4", "number"),
        ParamMeta("T5", "number"),
        ParamMeta("T6", "number"),
        ParamMeta("T7", "number"),
        ParamMeta("T8", "number"),
        ParamMeta("T9", "number"),
        ParamMeta("T10", "number"),
        ParamMeta("LSMAX", "number"),
        ParamMeta("LSMIN", "number"),
        ParamMeta("VCU", "number", unit="pu"),
        ParamMeta("VCL", "number", unit="pu"),
    ),
    "REGCP1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("gen", "string", required=True),
        ParamMeta("Sn", "number", unit="MVA"),
        ParamMeta("Tg", "number", unit="s"),
        ParamMeta("Rrpwr", "number", unit="pu"),
        ParamMeta("Brkpt", "number", unit="pu"),
        ParamMeta("Zerox", "number", unit="pu"),
        ParamMeta("Lvplsw", "number"),
        ParamMeta("Lvpl1", "number", unit="pu"),
        ParamMeta("Volim", "number", unit="pu"),
        ParamMeta("Lvpnt1", "number", unit="pu"),
        ParamMeta("Lvpnt0", "number", unit="pu"),
        ParamMeta("Iolim", "number", unit="pu (mach base)"),
        ParamMeta("Tfltr", "number", unit="s"),
        ParamMeta("Khv", "number"),
        ParamMeta("Iqrmax", "number", unit="pu"),
        ParamMeta("Iqrmin", "number", unit="pu"),
        ParamMeta("Accel", "number"),
        ParamMeta("gammap", "number"),
        ParamMeta("gammaq", "number"),
        ParamMeta("pll", "string", required=True),
    ),
    "REECA1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("reg", "string", required=True),
        ParamMeta("busr", "string", required=True),
        ParamMeta("PFFLAG", "number"),
        ParamMeta("VFLAG", "number"),
        ParamMeta("QFLAG", "number"),
        ParamMeta("PFLAG", "number"),
        ParamMeta("PQFLAG", "number"),
        ParamMeta("Vdip", "number", unit="pu"),
        ParamMeta("Vup", "number", unit="pu"),
        ParamMeta("Trv", "number"),
        ParamMeta("dbd1", "number"),
        ParamMeta("dbd2", "number"),
        ParamMeta("Kqv", "number"),
        ParamMeta("Iqh1", "number"),
        ParamMeta("Iql1", "number"),
        ParamMeta("Vref0", "number"),
        ParamMeta("Iqfrz", "number"),
        ParamMeta("Thld", "number", unit="s"),
        ParamMeta("Thld2", "number", unit="s"),
        ParamMeta("Tp", "number", unit="s"),
        ParamMeta("QMax", "number"),
        ParamMeta("QMin", "number"),
        ParamMeta("VMAX", "number"),
        ParamMeta("VMIN", "number"),
        ParamMeta("Kqp", "number"),
        ParamMeta("Kqi", "number"),
        ParamMeta("Kvp", "number"),
        ParamMeta("Kvi", "number"),
        ParamMeta("Vref1", "number"),
        ParamMeta("Tiq", "number"),
        ParamMeta("dPmax", "number"),
        ParamMeta("dPmin", "number"),
        ParamMeta("PMAX", "number"),
        ParamMeta("PMIN", "number"),
        ParamMeta("Imax", "number"),
        ParamMeta("Tpord", "number"),
        ParamMeta("Vq1", "number"),
        ParamMeta("Iq1", "number"),
        ParamMeta("Vq2", "number"),
        ParamMeta("Iq2", "number"),
        ParamMeta("Vq3", "number"),
        ParamMeta("Iq3", "number"),
        ParamMeta("Vq4", "number"),
        ParamMeta("Iq4", "number"),
        ParamMeta("Vp1", "number"),
        ParamMeta("Ip1", "number"),
        ParamMeta("Vp2", "number"),
        ParamMeta("Ip2", "number"),
        ParamMeta("Vp3", "number"),
        ParamMeta("Ip3", "number"),
        ParamMeta("Vp4", "number"),
        ParamMeta("Ip4", "number"),
    ),
    "REPCA1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("ree", "string", required=True),
        ParamMeta("line", "string", required=True),
        ParamMeta("busr", "string", required=True),
        ParamMeta("busf", "string", required=True),
        ParamMeta("VCFlag", "number"),
        ParamMeta("RefFlag", "number"),
        ParamMeta("Fflag", "number"),
        ParamMeta("PLflag", "number"),
        ParamMeta("Tfltr", "number"),
        ParamMeta("Kp", "number"),
        ParamMeta("Ki", "number"),
        ParamMeta("Tft", "number"),
        ParamMeta("Tfv", "number"),
        ParamMeta("Vfrz", "number"),
        ParamMeta("Rc", "number"),
        ParamMeta("Xc", "number"),
        ParamMeta("Kc", "number"),
        ParamMeta("emax", "number"),
        ParamMeta("emin", "number"),
        ParamMeta("dbd1", "number"),
        ParamMeta("dbd2", "number"),
        ParamMeta("Qmax", "number"),
        ParamMeta("Qmin", "number"),
        ParamMeta("Kpg", "number"),
        ParamMeta("Kig", "number"),
        ParamMeta("Tp", "number"),
        ParamMeta("fdbd1", "number", unit="pu (Hz)"),
        ParamMeta("fdbd2", "number", unit="pu (Hz)"),
        ParamMeta("femax", "number"),
        ParamMeta("femin", "number"),
        ParamMeta("Pmax", "number", unit="pu (MW)"),
        ParamMeta("Pmin", "number", unit="pu (MW)"),
        ParamMeta("Tg", "number"),
        ParamMeta("Ddn", "number"),
        ParamMeta("Dup", "number"),
    ),
    # Unit 14: PMU (PhasorMeasurement). Tracks bus voltage magnitude
    # (vm) + angle (am) via low-pass filters during TDS. Mirrors
    # ``andes/models/measurement/pmu.py:13-19``: ``bus`` (mandatory
    # ACNode → Bus), ``Ta`` (angle filter time constant, default 0.1),
    # ``Tv`` (voltage filter time constant, default 0.1). The defaults
    # the substrate ships through ``add_pmu`` are 0.05 / 0.05 (Unit 14
    # spike) — researchers can edit per-instance via ``edit_element``
    # because PMU is a known model class on the substrate.
    "PMU": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Ta", "number", unit="s"),
        ParamMeta("Tv", "number", unit="s"),
    ),
    # Unit 15: TimeSeries profile. Imports an xlsx hourly profile and
    # applies its values to a target device's parameters at exact step
    # times. Mirrors ``andes/models/timeseries.py:38-72``: ``mode``
    # (1=exact, 2=interpolated; 2 raises NotImplementedError at line 230,
    # the substrate accepts only mode=1), ``path`` (xlsx file path,
    # mandatory and must exist before setup), ``sheet``, ``fields``
    # (comma-separated source columns), ``tkey`` (timestamp column),
    # ``model`` (target ANDES model class), ``dev`` (target device idx),
    # ``dests`` (comma-separated target device fields). Listed here so
    # ``delete_element('TimeSeries', idx)`` shares the cascade /
    # reload-and-replay machinery with the rest of the topology.
    "TimeSeries": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("mode", "number", required=True),
        ParamMeta("path", "string", required=True),
        ParamMeta("sheet", "string", required=True),
        ParamMeta("fields", "string", required=True),
        ParamMeta("tkey", "string"),
        ParamMeta("model", "string", required=True),
        ParamMeta("dev", "string", required=True),
        ParamMeta("dests", "string", required=True),
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


def _reference_angle_drift(ss: System) -> float:
    """Common-mode bus-angle drift to subtract so displayed angles stay
    physical after TDS.

    ANDES integrates bus angles against a system reference frame that
    *rotates*; after a TDS run every ``Bus.a`` carries a large common-mode
    offset (e.g. ~9.5 rad) even though angle DIFFERENCES — the only physical
    quantity — are preserved. The PF convention pins the slack bus at its
    ``a0`` setpoint, so the drift is ``(slack bus angle now) - (slack a0)``.

    Subtracting this drift:
    - leaves PF results unchanged (drift ≈ 0 right after PF, since the slack
      bus sits at a0), and
    - removes only the accumulated rotation after TDS, returning the slack
      bus to a0 and every other bus to its physical relative angle.

    Anchors to the FIRST ENABLED slack (each slack is pinned at its ``a0``, so
    any enabled slack is a valid reference; the first is deterministic). Falls
    back to mean-centring only when NO slack is enabled — an islanded / all-PV
    system has no canonical reference. Non-finite angles are skipped; returns a
    finite float (0.0 if nothing usable).
    """
    if not hasattr(ss, "Bus") or getattr(ss.Bus, "a", None) is None:
        return 0.0

    slack = getattr(ss, "Slack", None)
    # Index of the first ENABLED slack (u != 0). Don't assume row 0 is enabled.
    slack_row: int | None = None
    if slack is not None and getattr(slack, "n", 0):
        for j, u in enumerate(slack.u.v):
            if float(u) != 0.0:
                slack_row = j
                break

    if slack_row is not None:
        slack_bus = slack.bus.v[slack_row]
        for i, idx in enumerate(ss.Bus.idx.v):
            if str(idx) == str(slack_bus):
                a_now = float(ss.Bus.a.v[i])
                a0 = float(slack.a0.v[slack_row])
                drift = a_now - a0
                return drift if math.isfinite(drift) else 0.0
        # Slack references a missing bus → fall through to mean-centring.

    finite = [float(a) for a in ss.Bus.a.v if math.isfinite(float(a))]
    if not finite:
        return 0.0
    return sum(finite) / len(finite)


def _extract_generator_outputs(ss: System) -> dict[str, GeneratorOutput]:
    """Walk PV, Slack, GENROU, GENCLS devices and read each one's
    converged P / Q output + terminal voltage.

    For PV/Slack: ANDES stores these directly on the model (``p``,
    ``q``, ``v`` algebraic variables). For dynamic generators
    (GENROU/GENCLS): the same fields exist after PF init.

    All values are in pu; we scale P/Q by ``ss.config.mva`` to MW/MVAr.
    Best-effort: defaults to 0.0 / 0.0 / 1.0 on any missing attribute.
    Returns dict keyed by stringified idx.
    """
    log = logging.getLogger("andes-app.wrapper.gen_outputs")
    out: dict[str, GeneratorOutput] = {}
    try:
        mva_base = float(getattr(ss.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0
    for model_name in ("PV", "Slack", "GENROU", "GENCLS"):
        model = getattr(ss, model_name, None)
        if model is None:
            continue
        idx_var = getattr(model, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        if not idx_values:
            continue
        bus_var = getattr(model, "bus", None)
        bus_values = list(getattr(bus_var, "v", []) if bus_var is not None else [])
        p_arr = _safe_list(getattr(model, "p", None))
        q_arr = _safe_list(getattr(model, "q", None))
        v_arr = _safe_list(getattr(model, "v", None))
        for i, idx in enumerate(idx_values):
            try:
                p_pu = float(p_arr[i]) if i < len(p_arr) else 0.0
                q_pu = float(q_arr[i]) if i < len(q_arr) else 0.0
                v_pu = float(v_arr[i]) if i < len(v_arr) else 1.0
            except (TypeError, ValueError) as exc:
                log.warning(
                    "%s output extraction failed for idx=%r: %s",
                    model_name, idx, exc,
                )
                continue
            if not (math.isfinite(p_pu) and math.isfinite(q_pu) and math.isfinite(v_pu)):
                continue
            bus = bus_values[i] if i < len(bus_values) else ""
            bus_coerced = _coerce_scalar(bus)
            bus_final: int | str = bus_coerced if isinstance(bus_coerced, int | str) and not isinstance(bus_coerced, bool) else str(bus)
            out[str(idx)] = GeneratorOutput(
                p=p_pu * mva_base,
                q=q_pu * mva_base,
                v=v_pu,
                bus=bus_final,
            )
    return out


def _extract_load_consumption(ss: System) -> dict[str, LoadConsumption]:
    """Per-load P/Q draw from the converged PF.

    PQ loads expose ``Ppf`` and ``Qpf`` (the post-PF active/reactive
    consumption, in pu). ZIP loads expose the same; the ZIP composition
    is rolled into the same Ppf/Qpf at the converged voltage.

    Best-effort — falls back to ``p0`` / ``q0`` (the input setpoint) if
    ``Ppf`` / ``Qpf`` are unavailable. Always converts to MW / MVAr.
    """
    log = logging.getLogger("andes-app.wrapper.load_consumption")
    out: dict[str, LoadConsumption] = {}
    try:
        mva_base = float(getattr(ss.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0
    for model_name in ("PQ", "ZIP"):
        model = getattr(ss, model_name, None)
        if model is None:
            continue
        idx_var = getattr(model, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        if not idx_values:
            continue
        bus_var = getattr(model, "bus", None)
        bus_values = list(getattr(bus_var, "v", []) if bus_var is not None else [])
        # Try Ppf/Qpf first; fall back to p0/q0.
        p_arr = _safe_list(
            getattr(model, "Ppf", None) or getattr(model, "p0", None)
        )
        q_arr = _safe_list(
            getattr(model, "Qpf", None) or getattr(model, "q0", None)
        )
        for i, idx in enumerate(idx_values):
            try:
                p_pu = float(p_arr[i]) if i < len(p_arr) else 0.0
                q_pu = float(q_arr[i]) if i < len(q_arr) else 0.0
            except (TypeError, ValueError) as exc:
                log.warning(
                    "%s consumption extraction failed for idx=%r: %s",
                    model_name, idx, exc,
                )
                continue
            if not (math.isfinite(p_pu) and math.isfinite(q_pu)):
                continue
            bus = bus_values[i] if i < len(bus_values) else ""
            bus_coerced = _coerce_scalar(bus)
            bus_final: int | str = bus_coerced if isinstance(bus_coerced, int | str) and not isinstance(bus_coerced, bool) else str(bus)
            out[str(idx)] = LoadConsumption(
                p=p_pu * mva_base,
                q=q_pu * mva_base,
                bus=bus_final,
            )
    return out


def _safe_list(param: Any) -> list[Any]:
    """Defensive ``.v`` reader. Returns [] for None / non-iterable."""
    if param is None:
        return []
    values = getattr(param, "v", None)
    if values is None:
        return []
    try:
        return list(values)
    except TypeError:
        return []


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


# ---- EIG helpers (Unit 6) --------------------------------------------------


def _compute_damping_ratio(z: complex) -> float:
    """Per-mode damping ratio.

    Convention used by power-systems texts (and ANDES's own
    plotting): ``zeta = -Re(z) / |z|``. NaN guards collapse to 0.0
    so the wire payload never carries non-finite floats (which would
    fail JSON serialization in the routes layer).
    """
    magnitude = (z.real * z.real + z.imag * z.imag) ** 0.5
    if magnitude == 0.0 or not math.isfinite(magnitude):
        return 0.0
    zeta = -z.real / magnitude
    if not math.isfinite(zeta):
        return 0.0
    return float(zeta)


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


# ---- CPF helpers (Unit 12) ------------------------------------------------


def _build_cpf_result(
    ss: System, *, mode: str, ok: bool, qv_bus: str | None = None
) -> CpfResult:
    """Build a :class:`CpfResult` from the post-run ``ss.CPF`` state.

    Handles both PV-curve (``mode="pv"``, full multi-bus sweep) and
    QV-curve (``mode="qv"``, single-bus reactive-injection sweep)
    payloads. The two share the same wire shape so the UI can use one
    chart component for both.

    Per Unit 1a spike:

    - PV: ``CPF.lam`` (1-D length nsteps), ``CPF.V`` (nbus, nsteps).
    - QV: ``CPF.qv_q`` (1-D), ``CPF.qv_v`` (1-D, single bus).

    Truncation detection: a successful nose-finding run carries a
    ``NOSE`` event in ``CPF.events``. When ``ok=False`` OR no NOSE event
    is present, ``nose_idx=-1`` and ``truncated=True`` so the UI can
    surface the "did not reach nose" note.
    """
    cpf = ss.CPF
    done_msg = str(getattr(cpf, "done_msg", "") or "")
    events = list(getattr(cpf, "events", None) or [])

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
        max_lam = float(getattr(cpf, "max_lam", 0.0) or 0.0)
        if lambdas and ok:
            nose_idx = int(_argmax(lambdas))
        truncated = (not ok) or nose_idx < 0
        if not max_lam and lambdas:
            max_lam = max(lambdas)
        return CpfResult(
            lambdas=lambdas,
            voltages_per_bus=voltages_per_bus,
            bus_idxes=bus_idxes,
            nose_idx=nose_idx,
            max_lam=max_lam,
            truncated=truncated,
            done_msg=done_msg,
            mode="qv",
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

    # Nose detection: a NOSE event in CPF.events tells us the run hit
    # the maximum-loadability point. argmax over the lambda series
    # mirrors what ANDES reports as ``max_lam``.
    has_nose_event = any(
        isinstance(ev, dict) and ev.get("type") == "NOSE" for ev in events
    )
    nose_idx = -1
    if lambdas and ok and has_nose_event:
        nose_idx = int(_argmax(lambdas))
    truncated = (not ok) or (not has_nose_event)

    max_lam = float(getattr(cpf, "max_lam", 0.0) or 0.0)
    if not max_lam and lambdas:
        max_lam = max(lambdas)

    return CpfResult(
        lambdas=lambdas,
        voltages_per_bus=voltages_per_bus,
        bus_idxes=bus_idxes,
        nose_idx=nose_idx,
        max_lam=max_lam,
        truncated=truncated,
        done_msg=done_msg,
        mode="pv",
    )


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
