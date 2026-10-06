"""Per-session subprocess worker.

This module is the entry point for ``multiprocessing.Process``. It runs in a
fresh Python process spawned by ``SessionManager`` (one worker per session)
and communicates with the FastAPI parent via two ``multiprocessing.Pipe``
endpoints (``ctrl`` for commands, ``data`` for responses).

Threading model inside the worker:

- **Main thread** — owns the ``Wrapper`` instance and the integration loop
  during ``run_tds``. Reads commands off the control Pipe, dispatches to the
  wrapper, writes results to the data Pipe. The TDS integration runs on this
  thread because ``ss.TDS.run()`` is synchronous and ``callpert`` fires from
  inside it.
- **Abort thread** — watches a ``multiprocessing.Event`` (``abort_event``).
  The parent sets the event via the control channel; the wrapper's
  ``callpert`` callback checks the event each invocation and sets
  ``ss.TDS.busted = True`` on detect. Decoupling abort polling from the data
  Pipe keeps the abort flag current even while ``callpert`` is blocked
  writing a frame to a full data Pipe.
- **Orphan-detection thread (macOS only)** — polls ``os.getppid()`` every 1 s.
  When the parent dies, ``getppid()`` returns 1 (init). The thread then
  ``os.kill(os.getpid(), SIGTERM)``. On Linux this thread is unnecessary
  because ``PR_SET_PDEATHSIG(SIGTERM)`` is set at entry.

A streaming run has no credit protocol. Frames go out on the data Pipe as fast
as the solver produces them, and the one thing that paces the solver is that
``Pipe.send`` blocks while the pipe's buffer is full, so it can run no faster
than the parent reads. The parent reads without waiting for any client; a
client that falls behind is sent a ``resync`` (see
``SessionManager.attach_to_run``), never waited for.

The worker ignores SIGINT: a terminal sends Ctrl+C to every process in the
foreground group, and the parent alone decides when workers stop.

The worker enables ``faulthandler``: a crash inside a C extension (a segfault in
the sparse solver, an abort from a BLAS thread) otherwise kills the process
without a word, and the parent only learns that the pipe broke. With it, the
Python stack of every thread goes to the worker's stderr, which is the server's.

Wire protocol on the control Pipe (parent → worker):

    {"op": "load_case", "args": {"path": ..., "addfiles": [...]}, "seq": N}
    {"op": "add_disturbance", "args": {"spec": <dict>}, "seq": N}
    {"op": "run_pflow", "args": {"tolerance": ..., "max_iterations": ..., "flat_start": ..., "enforce_q_limits": ...}, "seq": N}
    {"op": "run_tds", "args": {"tf": ..., "h": ...}, "seq": N}
    {"op": "reload_case", "args": {}, "seq": N}
    {"op": "topology", "args": {}, "seq": N}
    {"op": "alterable_params", "args": {"model": "Bus"}, "seq": N}
    {"op": "shutdown", "args": {}, "seq": N}

Wire protocol on the data Pipe (worker → parent):

    {"type": "result", "seq": N, "payload": <serializable>}
    {"type": "error", "seq": N, "category": "...", "detail": "..."}

Abort is signaled out-of-band via ``abort_event.set()``; the worker does NOT
acknowledge the abort, it only cooperatively terminates the active TDS.
"""

from __future__ import annotations

import contextlib
import dataclasses
import faulthandler
import os
import signal
import site
import sys
import sysconfig
import threading
import time
from collections.abc import Callable, Sequence
from multiprocessing.connection import Connection
from multiprocessing.synchronize import Event as EventType
from typing import Any

from tensa.core.dae_vars import as_dict, dae_variables, resolve_dae_vars, search_dae_variables
from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from tensa.core.errors import (
    AndesAppError,
    DisturbanceCommitError,
    ElementHasDependentsError,
    NoCaseLoadedError,
    TdsRequestError,
    short_repr,
)
from tensa.core.messages import (
    PathScrubber,
    attach_log,
    begin_command,
    install_capture,
    uninstall_capture,
)
from tensa.core.pflow_notices import log_pflow_notices

# AndesAppError catches the new ElementValidationError /
# ElementNotFoundError / SystemAlreadyLoadedError subclasses and forwards
# them with their class name as ``category``; the routes layer maps each
# to the right HTTP status (see api/error_mapping.py:map_worker_error).
from tensa.core.stream import (
    DEFAULT_VARS,
    VAR_GROUPS,
    StreamAggregator,
    StreamCollector,
    StreamRow,
    TraceRecorder,
    VarGroup,
    bus_idx_values_from_system,
    encode_batch,
    line_idx_values_from_system,
    pq_idx_values_from_system,
    syngen_idx_values_from_system,
    var_column_names,
)
from tensa.core.tds_controllers import log_notices as log_controller_notices
from tensa.core.tds_controllers import parse_controllers
from tensa.core.tds_steps import StepClock, stored_step
from tensa.core.wrapper import Wrapper, tds_fixed_step, validate_step_size


def _set_parent_death_signal() -> None:
    """On Linux, request SIGTERM when the parent process dies.

    Uses ``prctl(PR_SET_PDEATHSIG, SIGTERM)`` via ctypes. No-op on non-Linux
    systems. The macOS orphan-detection thread covers Darwin separately.
    """
    if sys.platform != "linux":
        return
    try:
        import ctypes

        # PR_SET_PDEATHSIG = 1 (linux/prctl.h)
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        PR_SET_PDEATHSIG = 1
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
    except OSError:  # pragma: no cover — libc not available
        pass


def _spawn_orphan_detector() -> None:
    """On macOS, spawn a daemon thread that self-SIGTERMs when the parent
    process dies (``os.getppid() == 1``).
    """
    if sys.platform != "darwin":
        return

    def _watch() -> None:
        while True:
            if os.getppid() == 1:
                os.kill(os.getpid(), signal.SIGTERM)
                return
            time.sleep(1.0)

    t = threading.Thread(target=_watch, name="orphan-detector", daemon=True)
    t.start()


def _ignore_sigint() -> None:
    """Leave Ctrl+C to the parent.

    A terminal delivers SIGINT to every process in the foreground group, workers
    included. The server stops its workers itself (a ``shutdown`` command, then
    SIGTERM), and a worker that raised ``KeyboardInterrupt`` instead would only
    print a traceback and die before the server asked it to. A TDS run is aborted
    through ``abort_event``, never by a signal.

    This runs when ``worker_main`` starts, so a Ctrl+C in the first seconds, while
    the child is still importing numpy and ANDES, is not covered.
    """
    # ValueError: not the main thread. OSError: the platform refuses.
    with contextlib.suppress(ValueError, OSError):
        signal.signal(signal.SIGINT, signal.SIG_IGN)


def _enable_faulthandler() -> None:
    """Have a native crash print the stack of every Python thread to stderr.

    Covers SIGSEGV, SIGFPE, SIGABRT, SIGBUS and SIGILL, and on Windows an access
    violation. A handler that is already installed (pytest's, when a test runs the
    worker in its own process, or ``PYTHONFAULTHANDLER``) is left as it is.

    Best effort: with no usable stderr (a Windows ``pythonw`` process has none) there
    is nowhere to write, and the worker runs without it.
    """
    if faulthandler.is_enabled():
        return
    # RuntimeError: ``sys.stderr`` is None. OSError and ValueError: it has no file
    # descriptor (``io.UnsupportedOperation`` is both), or it is closed.
    with contextlib.suppress(RuntimeError, OSError, ValueError, AttributeError):
        faulthandler.enable(all_threads=True)


def _warm_andes() -> None:
    """Import what the first case load would otherwise import, while the worker
    has nothing else to do.

    A fresh worker has not imported ANDES, so its first ``load_case`` pays for
    ``import andes``, for every model module the System builds, and for pandas,
    scipy and openpyxl, which the case readers pull in: about 1.0 s for IEEE 14,
    against 0.2 s for the same load once they are in. The web UI opens a session
    when the page loads, seconds before anyone picks a case, so imports done here
    cost the user nothing.

    The generated code in ``~/.andes/pycode`` is left alone on purpose. ANDES
    reloads it for every System it builds, so importing it here saves nothing.

    Best effort: a failure only means the first load imports whatever is missing,
    and reports the real error itself if there is one.
    """
    import importlib
    import logging

    try:
        import andes.models
        import andes.routines

        # The modules ``System()`` imports to build its models and routines: the two
        # lists ANDES's own registry walks (a test fails if an upgrade renames them).
        for module_name, _classes in andes.models.file_classes:
            importlib.import_module(f"andes.models.{module_name}")
        for module_name in andes.routines.all_routines:
            importlib.import_module(f"andes.routines.{module_name}")
    except Exception as exc:  # noqa: BLE001 — warming is an optimisation, never a failure
        logging.getLogger("tensa.worker").warning(
            "could not pre-import ANDES (%s: %s); the first case load will import it",
            exc.__class__.__name__,
            exc,
        )
        return
    for name in ("pandas", "scipy.sparse.linalg", "openpyxl"):
        with contextlib.suppress(ImportError):
            importlib.import_module(name)


def _warm_up_if_idle(ctrl: Connection) -> None:
    """Run :func:`_warm_andes`, unless a command is already waiting.

    A command that arrives before the worker is up (a script that creates a
    session and loads a case at once) pulls in what it needs itself, and a warm-up
    first would only delay it. Called before the first ``recv``, so a command
    that arrives during the warm-up waits for it, at most a second.
    """
    try:
        if ctrl.poll(0):
            return
    except (EOFError, OSError):
        return
    _warm_andes()


def _normalized_path(path: str) -> str:
    """``realpath`` plus ``normcase``: two spellings of one location (symlinks,
    and on Windows letter case and slashes) compare equal."""
    return os.path.normcase(os.path.realpath(path))


def _is_within(path: str, root: str) -> bool:
    """Whether ``path`` is ``root`` or lies beneath it; both normalized.

    Compares whole path components, so ``/ws/cases2`` is not within ``/ws/cases``.
    """
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        # Different drives on Windows, or one path relative and the other not.
        return False


def _interpreter_roots() -> tuple[str, ...]:
    """Directories that hold the interpreter's own files, normalized.

    ANDES reads data files from its install tree and the standard library reads
    its own, so opens there are not worth a warning. Built from the interpreter's
    own idea of its layout (prefixes, ``sysconfig``, site directories) instead of
    a path pattern, so it holds for a venv, conda, Homebrew, python.org on Windows
    and a distro package alike. On a system-wide interpreter a prefix is a shared
    tree such as ``/usr``; the hook only logs, so a quiet open there costs nothing.
    """
    paths = sysconfig.get_paths()
    candidates = [
        sys.prefix,
        sys.exec_prefix,
        sys.base_prefix,
        sys.base_exec_prefix,
        *(paths.get(key, "") for key in ("stdlib", "platstdlib", "purelib", "platlib")),
        site.getusersitepackages(),
    ]
    # Very old virtualenv releases ship a ``site`` without ``getsitepackages``.
    with contextlib.suppress(AttributeError):
        candidates.extend(site.getsitepackages())
    roots = {_normalized_path(c) for c in candidates if c}
    # A filesystem root would trust every path.
    return tuple(sorted(r for r in roots if os.path.dirname(r) != r))


# Opens of these are the import system reading the interpreter's own code; not
# worth a log line wherever the file lives.
_QUIET_OPEN_SUFFIXES = (".py", ".pyc", ".so", ".pyd", ".pth")


def _out_of_workspace_open(
    path: object, workspace_root: str, interpreter_roots: Sequence[str]
) -> str | None:
    """The resolved path to warn about for an ``open`` audit event, or ``None``
    when the open is inside the workspace, inside the interpreter's own tree, a
    code file, or not a filesystem path at all (an fd).

    ``workspace_root`` and ``interpreter_roots`` are normalized.
    """
    # PEP 578 'open' event args: (path, mode, flags). path may be a str, bytes,
    # int (fd), or PathLike. Only string-like paths matter for the boundary.
    if not isinstance(path, (str, bytes, os.PathLike)):
        return None
    try:
        text = os.fsdecode(path)
        # No file name holds a NUL, and the open itself fails on one. On POSIX
        # ``realpath`` raises ValueError for it; on Windows it returns the path
        # unchanged, so refuse it here to answer the same everywhere.
        if "\0" in text:
            return None
        real = os.path.realpath(text)
    except (OSError, ValueError):
        return None
    key = os.path.normcase(real)
    if _is_within(key, workspace_root):
        return None
    if key.endswith(_QUIET_OPEN_SUFFIXES):
        return None
    if any(_is_within(key, root) for root in interpreter_roots):
        return None
    return real


def _install_strict_fs_audit_hook(workspace: str | None) -> None:
    """Install a Python ``sys.audit`` hook (PEP 578, Python 3.8+) that logs
    file opens occurring outside the configured workspace.

    Best-effort only — the hook fires for ``open()`` events that travel
    through the Python interpreter. Reads from C extensions
    (numpy/openpyxl/pandas/SymEngine) bypass the hook and are NOT caught.
    The trust-model docstring documents this gap. For an actual workspace
    boundary, kernel-level enforcement (Linux seccomp, Landlock) is
    required and is deferred to the SaaS phase.
    """
    if workspace is None:
        return
    import logging

    log = logging.getLogger("tensa.worker.audit")
    workspace_root = _normalized_path(workspace)
    interpreter_roots = _interpreter_roots()

    def _hook(event: str, args: tuple[Any, ...]) -> None:
        if event != "open" or not args:
            return
        real = _out_of_workspace_open(args[0], workspace_root, interpreter_roots)
        if real is not None:
            log.warning("strict-fs: out-of-workspace open: %s", real)

    sys.addaudithook(_hook)


def _serialize_dataclass(obj: Any) -> Any:
    """Convert a dataclass (or list/dict thereof) to a plain Python object
    that can be pickled across the Pipe and re-built on the parent side.

    The payload shape is intentionally simple: nested dicts/lists/primitives.
    The parent reconstructs domain objects using the same dataclass classes
    when needed, or surfaces them directly to the API layer (which converts
    to Pydantic models in Unit 4 / Unit 5).
    """
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _serialize_dataclass(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, list):
        return [_serialize_dataclass(item) for item in obj]
    if isinstance(obj, dict):
        return {k: _serialize_dataclass(v) for k, v in obj.items()}
    return obj


def _disturbance_from_dict(spec_dict: dict[str, Any]) -> FaultSpec | ToggleSpec | AlterSpec:
    """Reconstruct a DisturbanceSpec from a dict that crossed the Pipe."""
    kind = spec_dict.get("kind")
    if kind == "fault":
        return FaultSpec(**spec_dict)
    if kind == "toggle":
        return ToggleSpec(**spec_dict)
    if kind == "alter":
        return AlterSpec(**spec_dict)
    raise ValueError(f"unknown disturbance kind: {kind!r}")


# ---- per-op handlers --------------------------------------------------------


def _handle_load_case(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(
        wrapper.load_case(args["path"], addfiles=args.get("addfiles"))
    )


def _handle_reload_case(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.reload_case())


def _handle_topology(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.topology_snapshot())


def _handle_operating_point(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.operating_point())


def _handle_add_disturbance(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    spec = _disturbance_from_dict(args["spec"])
    return wrapper.add_disturbance(spec)


def _handle_list_disturbances(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Return the current ``_disturbance_log`` as JSON-serialisable dicts.

    Each entry is a Pydantic ``DisturbanceSpec`` (FaultSpec / ToggleSpec /
    AlterSpec); ``model_dump()`` round-trips through the discriminator so
    the parent side can re-build them via ``_disturbance_from_dict`` when
    needed (Unit 7 snapshot replay).
    """
    return [spec.model_dump() for spec in wrapper.list_disturbances()]


def _handle_replay_disturbances(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Replay the recorded disturbance log onto the current pre-setup System.

    Returns the count of specs replayed. No-op when the System is post-setup
    (logs a warning wrapper-side and returns 0).
    """
    return int(wrapper.replay_disturbances())


def _handle_clear_disturbances(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Clear the disturbance replay log without touching the System."""
    wrapper.clear_disturbances()
    return None


def _handle_add_element(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(
        wrapper.add_element(args["model"], args["params"])
    )


def _handle_edit_element(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(
        wrapper.edit_element(args["model"], args["idx"], args["params"])
    )


def _handle_create_blank(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.create_blank())


def _handle_save_case(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    path = wrapper.save_case(args["format"], args["filename"])
    return str(path)


def _handle_undo_last_edit(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.undo_last_edit())


def _handle_redo_edit(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.redo_edit())


def _handle_delete_element(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Delete one element. The reply is the new topology with, beside it,
    what went: ``deleted`` (the elements) and ``disturbances``."""
    result = wrapper.delete_element(
        args["model"], args["idx"], cascade=bool(args.get("cascade", False))
    )
    payload: dict[str, Any] = _serialize_dataclass(result.topology)
    payload["deleted"] = [_serialize_dataclass(entry) for entry in result.deleted]
    payload["disturbances"] = [_serialize_dataclass(d) for d in result.disturbances]
    return payload


def _handle_alterable_params(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return list(wrapper.alterable_params(args["model"]))


# ---- clone-on-write (Unit 21) ----------------------------------------------


def _handle_init_clone(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return wrapper.init_clone()


def _handle_apply_clone_edit(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return wrapper.apply_clone_edit(
        args["model"], args["idx"], args["param"], args["value"]
    )


def _handle_undo_clone_edit(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return wrapper.undo_clone_edit()


def _handle_redo_clone_edit(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return wrapper.redo_clone_edit()


def _handle_save_clone_as(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return wrapper.save_clone_as(args["name"], overwrite=bool(args.get("overwrite", False)))


def _handle_reset_clone(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return wrapper.reset_clone()


def _handle_clone_diff(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return wrapper.clone_diff(args["model"], args["idx"])


def _handle_run_pflow(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    # Only the settings the request names are forwarded; the wrapper refuses a
    # value out of range, so the worker does not rely on the REST body's checks.
    options = {
        key: args[key]
        for key in ("tolerance", "max_iterations", "flat_start", "enforce_q_limits")
        if args.get(key) is not None
    }
    result = wrapper.run_pflow(**options)
    if result.converged:
        # Two effects of a solved power flow that ANDES does not log (a generator held
        # at a reactive limit, a load turned into an impedance): say them as warnings.
        log_pflow_notices(wrapper._require_loaded())  # noqa: SLF001
    return _serialize_dataclass(result)


def _handle_generate_report(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Generate a routine report (Unit 4 of the v2.0 plan; Unit 6 added EIG).

    Routines: ``pflow``, ``tds``, ``eig``. The handler reaches into
    the wrapper's loaded System (private accessor) — the report
    generator does not mutate state, only reads + tempfile-roundtrips
    the ``ss.PFlow.report()`` / ``ss.EIG.report()`` output.

    ANDES writes the case file's full path into the report's header. It is
    taken out before the report leaves the worker, as the paths in the
    messages ANDES logs are: the workspace reads relative to itself.
    """
    from tensa.core.report import (
        EigReportPrerequisiteError,
        PflowNotConvergedError,
        ReportGenerationError,
        ReportRoutine,
        TdsNotRunError,
        generate_report,
        without_server_paths,
    )

    routine_raw = args.get("routine")
    if routine_raw not in ("pflow", "tds", "eig"):
        raise AndesAppError(
            f"unknown report routine: {routine_raw!r}; expected 'pflow', 'tds', or 'eig'"
        )
    routine: ReportRoutine = routine_raw

    ss = wrapper._require_loaded()  # noqa: SLF001 — internal access by design

    try:
        payload = generate_report(ss, routine)
    except (
        PflowNotConvergedError,
        TdsNotRunError,
        EigReportPrerequisiteError,
        ReportGenerationError,
    ):
        # Re-raise so AndesAppError handling at the worker boundary
        # forwards the subclass name as ``category`` for the routes
        # layer to map to the right HTTP status.
        raise
    payload = without_server_paths(payload, PathScrubber(wrapper._workspace))  # noqa: SLF001
    return _serialize_dataclass(payload)


def _handle_run_eig(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.run_eig`` for Unit 6.

    Returns the serialized :class:`EigResult` dict (eigenvalues split
    into ``{real, imag}`` pairs, damping ratios, frequencies, mode
    count, state names, ``tds_initialized`` flag).
    """
    return _serialize_dataclass(wrapper.run_eig())


def _handle_eig_participation(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Slice ``EIG.pfactors[mode_idx]`` and return per-state participation.

    Returns ``{mode_idx, participation: [{state_name, factor}, ...]}``.
    """
    mode_idx = int(args["mode_idx"])
    return wrapper.eig_participation(mode_idx)


def _handle_eig_state_matrix(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Return ``EIG.As`` (and ``EIG.mu``) packed as a ``.mat`` blob."""
    return wrapper.get_eig_state_matrix()


def _handle_run_cpf(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.run_cpf`` for Unit 12.

    Forwards ``direction`` / ``step`` / ``max_iter`` and the settings of
    :mod:`tensa.core.cpf_options` (``load_increase``,
    ``generator_increase``, ``enforce_q_limits``, ``stop_at``) from the
    request body as they are; ``run_cpf`` checks them. Returns a
    serialized :class:`CpfResult` dict.
    """
    return _serialize_dataclass(
        wrapper.run_cpf(
            direction=args.get("direction", "load"),
            step=args.get("step"),
            max_iter=args.get("max_iter"),
            load_increase=args.get("load_increase"),
            generator_increase=args.get("generator_increase"),
            enforce_q_limits=args.get("enforce_q_limits"),
            stop_at=args.get("stop_at", "nose"),
        )
    )


def _handle_run_cpf_qv(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.run_cpf_qv`` for Unit 12.

    The bus_idx is required; ``q_range`` is optional (default 5.0
    matches ANDES's own default), and so is ``enforce_q_limits``.
    """
    bus_idx = str(args["bus_idx"])
    q_range_raw = args.get("q_range")
    q_range = float(q_range_raw) if q_range_raw is not None else 5.0
    return _serialize_dataclass(
        wrapper.run_cpf_qv(
            bus_idx=bus_idx,
            q_range=q_range,
            enforce_q_limits=args.get("enforce_q_limits"),
        )
    )


def _handle_compute_connectivity(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.compute_connectivity`` for Unit 17.

    Returns a serialized :class:`ConnectivityResult` dict
    (``island_count``, ``islands``, ``islanded_bus_idxes``). Empty
    ``args`` — the routine takes no parameters.
    """
    return _serialize_dataclass(wrapper.compute_connectivity())


def _handle_generate_measurements_from_pflow(
    wrapper: Wrapper, args: dict[str, Any]
) -> Any:
    """Wire ``Wrapper.generate_measurements_from_pflow`` for Unit 13.

    Forwards ``noise_seed`` from the request body. Returns a serialized
    :class:`MeasurementsGenerated` dict (``{count: int}``).
    """
    seed_raw = args.get("noise_seed")
    seed = int(seed_raw) if seed_raw is not None else None
    return _serialize_dataclass(
        wrapper.generate_measurements_from_pflow(noise_seed=seed)
    )


def _handle_run_se(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.run_se`` for Unit 13.

    Returns the serialized :class:`SeResult` dict (converged, iterations,
    mismatch, residuals, measurement_count, flagged_indices).
    """
    return _serialize_dataclass(wrapper.run_se())


def _handle_add_pmu(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.add_pmu`` for Unit 14.

    Args: ``{"bus_idx": <int|str>, "Ta": float?, "Tv": float?}``.
    Returns the serialized ``TopologyEntry`` for the newly-added PMU.
    """
    bus_idx = args.get("bus_idx")
    if bus_idx is None:
        raise AndesAppError("'bus_idx' is required for add_pmu")
    Ta_raw = args.get("Ta")
    Tv_raw = args.get("Tv")
    Ta = float(Ta_raw) if Ta_raw is not None else 0.05
    Tv = float(Tv_raw) if Tv_raw is not None else 0.05
    return _serialize_dataclass(
        wrapper.add_pmu(bus_idx, Ta=Ta, Tv=Tv)
    )


def _handle_list_pmus(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.list_pmus`` for Unit 14.

    Returns a list of serialized ``TopologyEntry`` dicts (one per PMU);
    empty list when no PMUs have been placed yet.
    """
    return _serialize_dataclass(wrapper.list_pmus())


def _handle_delete_pmu(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.delete_pmu`` for Unit 14. Returns ``None``."""
    idx = args.get("idx")
    if idx is None:
        raise AndesAppError("'idx' is required for delete_pmu")
    wrapper.delete_pmu(idx)
    return None


def _handle_export_pmu_csv(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.export_pmu_csv`` for Unit 14.

    Returns the CSV text body verbatim (UTF-8 string). The route layer
    sets ``Content-Type: text/csv`` and a ``Content-Disposition``
    suggesting ``andes-pmu-<run_id>.csv``.
    """
    return wrapper.export_pmu_csv()


def _handle_upload_profile(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.upload_profile`` for Unit 15.

    Args: ``{"filename": str, "content_bytes": bytes}``. Returns the
    absolute path of the on-disk xlsx (string). The bytes payload
    crosses the worker Pipe; profiles are typically small (KB range
    for hourly data over 24 h) so this stays well within Pipe
    tolerance.
    """
    filename = args.get("filename")
    if not isinstance(filename, str):
        raise AndesAppError("'filename' is required for upload_profile")
    content_bytes = args.get("content_bytes")
    if not isinstance(content_bytes, (bytes, bytearray)):
        raise AndesAppError(
            "'content_bytes' is required for upload_profile (bytes)"
        )
    return wrapper.upload_profile(filename, bytes(content_bytes))


def _handle_add_timeseries(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.add_timeseries`` for Unit 15.

    Args: ``{"profile_path": str, "sheet": str, "fields": str,
    "model": str, "dev": str|int, "dests": str, "tkey": str?,
    "mode": int?}``. Returns the serialized ``TopologyEntry`` for the
    newly-added TimeSeries.
    """
    required = ("profile_path", "sheet", "fields", "model", "dev", "dests")
    for key in required:
        if args.get(key) is None:
            raise AndesAppError(f"{key!r} is required for add_timeseries")
    return _serialize_dataclass(
        wrapper.add_timeseries(
            profile_path=str(args["profile_path"]),
            sheet=str(args["sheet"]),
            fields=str(args["fields"]),
            model=str(args["model"]),
            dev=args["dev"],
            dests=str(args["dests"]),
            tkey=str(args.get("tkey", "t")),
            mode=int(args.get("mode", 1)),
        )
    )


def _handle_list_timeseries(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.list_timeseries`` for Unit 15.

    Returns a list of serialized ``TopologyEntry`` dicts (one per
    TimeSeries device); empty list when none have been added.
    """
    return _serialize_dataclass(wrapper.list_timeseries())


def _handle_delete_timeseries(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.delete_timeseries`` for Unit 15. Returns ``None``."""
    idx = args.get("idx")
    if idx is None:
        raise AndesAppError("'idx' is required for delete_timeseries")
    wrapper.delete_timeseries(idx)
    return None


def _handle_import_bundle(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire :meth:`Wrapper.import_bundle` for Unit 10.

    Args:
        ``zip_bytes``: required ``bytes`` payload of the .zip bundle.
        ``force_resolve``: optional bool, default False. When False
            and the bundle has conflicts, returns ``status="plan"``
            with the conflict list so the route layer can short-circuit
            with a 409. When True, the substrate proceeds with the
            extraction + replay using the resolution choices below.
        ``use_bundle_case``: optional bool, default True. Controls
            sha-mismatch resolution (True overwrites workspace; False
            preserves workspace + writes sibling).
        ``accept_version_mismatch``: optional bool, default True.
            Carried through for symmetry with the BundleResolveChoices
            dataclass; the substrate currently always proceeds on
            version-mismatch (warning surfaces in the plan).

    Returns the result dict from :meth:`Wrapper.import_bundle`.
    """
    zip_bytes = args.get("zip_bytes")
    if not isinstance(zip_bytes, (bytes, bytearray)):
        raise AndesAppError(
            "'zip_bytes' is required for import_bundle (bytes)"
        )
    force_resolve = bool(args.get("force_resolve", False))
    use_bundle_case = bool(args.get("use_bundle_case", True))
    accept_version_mismatch = bool(args.get("accept_version_mismatch", True))
    return wrapper.import_bundle(
        bytes(zip_bytes),
        force_resolve=force_resolve,
        use_bundle_case=use_bundle_case,
        accept_version_mismatch=accept_version_mismatch,
    )


def _handle_export_bundle(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Assemble a reproducibility-bundle ``.zip`` (Unit 3 of the v2.0 plan).

    The args carry the substrate-side knowledge that lives on the frontend
    today (per Unit 1a's finding that disturbance / sim-params / results
    state lives in the runs slice on the web side, not the substrate):

    - ``disturbances``: list of disturbance-spec dicts as the frontend
      committed them. Empty list when no disturbances were registered.
    - ``sim_params``: optional dict (``tf``, ``h``, ``vars``,
      ``decimation``, ``max_rate_hz``). ``None`` skips the file.
    - ``results_csv``: optional long-form CSV body (UTF-8 string).
      ``None`` skips the file.
    - ``run_id``: optional last run id, surfaced in the manifest.

    The substrate contributes:

    - The case file(s), read verbatim from the workspace when the
      wrapper's ``_edit_log`` is empty (no edits since load), or
      written via ``Wrapper.save_case('xlsx', ...)`` when the case is
      dirty. ``case_canonical_export`` in the manifest reflects which
      path was taken.
    - The ANDES + ``tensa`` version strings.

    Returns the zip bytes (under a few MB for typical sessions —
    well within Pipe-send-tolerance).
    """
    import tempfile
    from pathlib import Path

    # ANDES version is the only ANDES-side fact we need; lazy-import keeps
    # the worker startup cost paid by other handlers.
    import andes

    from tensa import __version__ as tensa_version
    from tensa.core.bundle import (
        BundleInputs,
        assemble_bundle,
        case_files_from_workspace,
        check_exportable_case_files,
    )

    # _edit_log is the substrate-side signal of "case has been edited
    # since load". Length > 0 with a non-None case path means the user
    # added, changed or deleted elements on top of the loaded case — the
    # bundle must ship the canonical export, not the original file.
    edit_log = wrapper._edit_log  # noqa: SLF001 — internal access by design
    case_path = wrapper._case_path  # noqa: SLF001
    addfiles = wrapper._addfiles  # noqa: SLF001

    if case_path is None and not edit_log:
        raise NoCaseLoadedError(
            "no case loaded — load a case (or create a blank one) before exporting a bundle"
        )

    case_canonical_export = False
    case_files: tuple[tuple[str, bytes], ...]
    if case_path is None:
        # Blank session: write a canonical xlsx into a tempfile and read
        # it back. Keeps the bundle assembler ignorant of filesystem
        # plumbing.
        case_canonical_export = True
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "blank-system.xlsx"
            wrapper.save_case("xlsx", str(target))
            case_files = ((target.name, target.read_bytes()),)
    elif edit_log:
        # Edited session: canonicalize via xlsx export. The original case
        # file is intentionally NOT included — the manifest's
        # ``case_canonical_export=True`` flag tells the consumer to expect
        # the xlsx.
        case_canonical_export = True
        with tempfile.TemporaryDirectory() as td:
            stem = case_path.stem
            target = Path(td) / f"{stem}.xlsx"
            wrapper.save_case("xlsx", str(target))
            case_files = ((target.name, target.read_bytes()),)
    else:
        # Pristine session: ship the original case file (and any addfiles)
        # verbatim. ``case_canonical_export=False`` in the manifest.
        case_files = case_files_from_workspace(case_path, addfiles)

    # Import refuses names that are not portable file names (a device name,
    # ``:``, a leading dot). Say so now, naming the file, instead of handing
    # back a bundle that cannot be opened.
    check_exportable_case_files(case_files)

    raw_disturbances = args.get("disturbances") or []
    if not isinstance(raw_disturbances, list):
        raise AndesAppError(
            "'disturbances' must be a list of disturbance-spec dicts"
        )
    disturbances: tuple[dict[str, Any], ...] = tuple(
        d for d in raw_disturbances if isinstance(d, dict)
    )

    sim_params_raw = args.get("sim_params")
    sim_params: dict[str, Any] | None
    if sim_params_raw is None:
        sim_params = None
    elif isinstance(sim_params_raw, dict):
        sim_params = sim_params_raw
    else:
        raise AndesAppError("'sim_params' must be a dict or null")

    results_csv_raw = args.get("results_csv")
    results_csv: str | None
    if results_csv_raw is None:
        results_csv = None
    elif isinstance(results_csv_raw, str):
        results_csv = results_csv_raw
    else:
        raise AndesAppError("'results_csv' must be a string or null")

    run_id_raw = args.get("run_id")
    run_id: str | None
    if run_id_raw is None:
        run_id = None
    elif isinstance(run_id_raw, str):
        run_id = run_id_raw
    else:
        raise AndesAppError("'run_id' must be a string or null")

    inputs = BundleInputs(
        case_files=case_files,
        case_canonical_export=case_canonical_export,
        disturbances=disturbances,
        sim_params=sim_params,
        results_csv=results_csv,
        run_id=run_id,
        andes_version=str(getattr(andes, "__version__", "unknown")),
        tensa_version=str(tensa_version),
    )
    return assemble_bundle(inputs)


def _handle_save_snapshot(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.save_snapshot`` for Unit 7.

    Args: ``{"name": str, "force": bool, "include_dill": bool}``. Returns
    the metadata dict + file sizes so the route layer can echo them in the
    success response.
    """
    name = args.get("name")
    if not isinstance(name, str):
        raise AndesAppError("'name' must be a string")
    force = bool(args.get("force", False))
    include_dill = bool(args.get("include_dill", False))
    return wrapper.save_snapshot(name, force=force, include_dill=include_dill)


def _handle_restore_snapshot(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.restore_snapshot`` for Unit 7.

    Args: ``{"name": str, "use_dill_optimization": bool}``. Returns the
    restore-result dict (``used_dill``, ``fallback_reason``,
    ``disturbances_replayed``, ``metadata``).
    """
    name = args.get("name")
    if not isinstance(name, str):
        raise AndesAppError("'name' must be a string")
    use_dill = bool(args.get("use_dill_optimization", False))
    return wrapper.restore_snapshot(name, use_dill_optimization=use_dill)


def _handle_list_snapshots(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.list_snapshots`` for Unit 7.

    Returns a list of snapshot-entry dicts; empty list when no
    snapshots have been saved against the current case.
    """
    return wrapper.list_snapshots()


def _handle_delete_snapshot(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.delete_snapshot`` for Unit 7."""
    name = args.get("name")
    if not isinstance(name, str):
        raise AndesAppError("'name' must be a string")
    wrapper.delete_snapshot(name)
    return None


def _handle_run_sweep(
    wrapper: Wrapper,
    args: dict[str, Any],
    abort_event: EventType,
    data_pipe: Connection | None = None,
    seq: int | None = None,
) -> Any:
    """Run a sensitivity sweep — Unit 18.

    Long-running, holds the per-session worker lock for the entire sweep.
    Per-iteration progress is emitted on the data_pipe as
    ``{"type": "sweep_progress", "seq": <run_seq>, "iteration": int,
    "value": float, "result": <iter_dict>}``.

    Args (validated by the route layer's Pydantic model before reaching
    here):
        - ``snapshot_name``: str
        - ``parameter_kind``: str (one of the SweepParamKind literals)
        - ``parameter_target``: int
        - ``values``: list[float]
        - ``tf``: float
        - ``h``: float | None
        - ``sweep_id``: str (route-assigned)
    """
    # Checked before the abort bridge starts: a refusal sets no ``abort_flag``,
    # so a bridge started first would keep polling until the session's next abort.
    h = validate_step_size(args.get("h"))

    abort_flag = threading.Event()
    if abort_event.is_set():
        abort_flag.set()

    def _bridge() -> None:
        # Same pattern as run_tds: a daemon thread mirrors the
        # multiprocessing event into a thread-local Event so the
        # wrapper's run_tds (which only knows threading.Event) can
        # cooperate.
        while not abort_flag.is_set():
            if abort_event.wait(timeout=0.1):
                abort_flag.set()
                return

    bridge_thread = threading.Thread(
        target=_bridge, name="sweep-abort-bridge", daemon=True
    )
    bridge_thread.start()

    snapshot_name = args.get("snapshot_name")
    if not isinstance(snapshot_name, str):
        raise AndesAppError("'snapshot_name' must be a string")
    parameter_kind = args.get("parameter_kind")
    if not isinstance(parameter_kind, str):
        raise AndesAppError("'parameter_kind' must be a string")
    parameter_target_raw = args.get("parameter_target")
    if not isinstance(parameter_target_raw, int) or parameter_target_raw < 0:
        raise AndesAppError("'parameter_target' must be a non-negative int")
    parameter_target = int(parameter_target_raw)
    values_raw = args.get("values")
    if not isinstance(values_raw, list) or not values_raw:
        raise AndesAppError("'values' must be a non-empty list of floats")
    try:
        values = [float(v) for v in values_raw]
    except (TypeError, ValueError) as exc:
        raise AndesAppError("'values' must contain float-coercible scalars") from exc
    tf_raw = args.get("tf")
    if not isinstance(tf_raw, (int, float)) or tf_raw <= 0:
        raise AndesAppError("'tf' must be a positive number")
    tf = float(tf_raw)
    sweep_id = args.get("sweep_id") or ""

    total = len(values)

    def _on_iteration(idx: int, value: float, iter_dict: dict[str, Any]) -> None:
        if data_pipe is None:
            return
        envelope = {
            "type": "sweep_progress",
            "seq": seq,
            "sweep_id": sweep_id,
            "iteration": idx,
            "total": total,
            "value": value,
            "result": iter_dict,
        }
        try:
            data_pipe.send(envelope)
        except (BrokenPipeError, OSError):
            abort_flag.set()

    try:
        result = wrapper.run_sweep(
            snapshot_name=snapshot_name,
            parameter_kind=parameter_kind,
            parameter_target=parameter_target,
            values=values,
            tf=tf,
            h=h,
            on_iteration=_on_iteration,
            abort_flag=abort_flag,
        )
    finally:
        abort_flag.set()

    abort_event.clear()

    # Augment the result with the sweep_id so the parent's eventual
    # ``done`` envelope carries it for the WS layer.
    result["sweep_id"] = sweep_id
    result["parameter_kind"] = parameter_kind
    result["parameter_target"] = parameter_target
    result["snapshot_name"] = snapshot_name
    return result


def _handle_sweep_plan(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Read and check a sweep's snapshot, for a sweep the server runs in parallel.

    Takes the first three arguments of ``run_sweep`` and returns what the
    sub-workers need (see ``Wrapper.sweep_plan``). Any problem raises, and the
    server then runs the sweep on this worker instead.
    """
    snapshot_name = args.get("snapshot_name")
    if not isinstance(snapshot_name, str):
        raise AndesAppError("'snapshot_name' must be a string")
    parameter_kind = args.get("parameter_kind")
    if not isinstance(parameter_kind, str):
        raise AndesAppError("'parameter_kind' must be a string")
    parameter_target = args.get("parameter_target")
    if not isinstance(parameter_target, int) or parameter_target < 0:
        raise AndesAppError("'parameter_target' must be a non-negative int")
    return wrapper.sweep_plan(
        snapshot_name=snapshot_name,
        parameter_kind=parameter_kind,
        parameter_target=parameter_target,
    )


def _handle_adopt_sweep_source(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Point a sub-worker of a parallel sweep at the session's case."""
    source = args.get("source")
    if not isinstance(source, dict):
        raise AndesAppError("'source' must be a dict")
    wrapper.adopt_sweep_source(source)
    return None


def _handle_run_sweep_iteration(
    wrapper: Wrapper,
    args: dict[str, Any],
    abort_event: EventType,
) -> Any:
    """Run ONE iteration of a parallel sweep on a sub-worker.

    Args (built by the server from the session's ``sweep_plan``):
        - ``index``: int, the iteration's position in the sweep
        - ``value``: float, the swept parameter's value
        - ``specs``: list of disturbance spec dicts (the snapshot's log)
        - ``parameter_kind``: str, ``parameter_target``: int
        - ``tf``: float, ``h``: float | None

    Returns the iteration's result dict (what ``run_sweep`` records), or
    ``{"skipped": True}`` when the abort event was already set, so nothing ran.

    A sub-worker's ``abort_event`` is not a ``multiprocessing.Event`` but a
    ``PipeAbortEvent`` (see ``core/sweep_pool.py``): the server sends on its pipe
    to stop the sweep. Only ``is_set`` and ``wait`` exist on it, and unlike
    ``_handle_run_sweep`` this never clears it, because once the sweep is aborted
    the server stops handing this worker iterations.
    """
    # Checked before the abort bridge starts: a refusal sets no ``abort_flag``,
    # so a bridge started first would keep polling until the session's next abort.
    h = validate_step_size(args.get("h"))

    index = args.get("index")
    if not isinstance(index, int) or index < 0:
        raise AndesAppError("'index' must be a non-negative int")
    parameter_kind = args.get("parameter_kind")
    if not isinstance(parameter_kind, str):
        raise AndesAppError("'parameter_kind' must be a string")
    parameter_target = args.get("parameter_target")
    if not isinstance(parameter_target, int) or parameter_target < 0:
        raise AndesAppError("'parameter_target' must be a non-negative int")
    try:
        value = float(args["value"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AndesAppError("'value' must be a float-coercible scalar") from exc
    tf_raw = args.get("tf")
    if not isinstance(tf_raw, (int, float)) or tf_raw <= 0:
        raise AndesAppError("'tf' must be a positive number")
    specs_raw = args.get("specs")
    if not isinstance(specs_raw, list):
        raise AndesAppError("'specs' must be a list of disturbance specs")
    try:
        specs = [_disturbance_from_dict(raw) for raw in specs_raw]
    except (AttributeError, TypeError, ValueError) as exc:  # a pydantic error is a ValueError
        raise AndesAppError(f"'specs' holds a disturbance that cannot be read: {exc}") from exc

    if abort_event.is_set():
        return {"skipped": True}

    abort_flag = threading.Event()

    def _bridge() -> None:
        # Same pattern as run_tds: a daemon thread mirrors the abort event into a
        # thread-local Event, so the abort check in each TDS step is cheap.
        while not abort_flag.is_set():
            if abort_event.wait(timeout=0.1):
                abort_flag.set()
                return

    bridge_thread = threading.Thread(
        target=_bridge, name="sweep-abort-bridge", daemon=True
    )
    bridge_thread.start()
    try:
        return wrapper.run_sweep_iteration(
            index=index,
            value=value,
            specs=specs,
            parameter_kind=parameter_kind,
            parameter_target=parameter_target,
            tf=float(tf_raw),
            h=h,
            abort_flag=abort_flag,
        )
    finally:
        abort_flag.set()


def _handle_run_tds(
    wrapper: Wrapper,
    args: dict[str, Any],
    abort_event: EventType,
    data_pipe: Connection | None = None,
    seq: int | None = None,
) -> Any:
    """Run TDS in batch or streaming mode.

    Streaming mode is selected by ``args["stream"] == True``. When streaming,
    each per-step state snapshot is encoded as an Arrow IPC batch and sent on
    the data Pipe as ``{"type": "stream_frame", "seq": <run_seq>, "payload":
    <bytes>}``. The first frame of a run is preceded by a JSON-text-shaped
    ``{"type": "stream_start", ...}`` message carrying the column names, which
    the frames leave out (see ``tensa.core.stream`` for the frame layout).
    The final ``{"type": "result", ...}`` message lands as usual at end of run.
    """
    # Everything the run would refuse for reasons known from the request and the
    # System's state is checked here, before any stream metadata goes out and
    # before the abort bridge starts: a refused run must not start a stream the
    # client then sees fail, nor leave a bridge thread polling (a refusal sets
    # no ``abort_flag``). The route layers validate ``h`` and the integrator
    # too; the worker does not rely on that.
    h = validate_step_size(args.get("h"))

    # Unit 16: integrator selection + adaptive-tolerance overrides.
    # ``integrator`` defaults to ``"trapezoidal"`` so a caller that names
    # none (the REST route and the WS ``start_tds`` frame both pass it on
    # when given) sees no behaviour change. Validation of the literal value
    # lives in the wrapper; we only normalise the wire shape here.
    integrator_raw = args.get("integrator", "trapezoidal")
    if integrator_raw not in ("trapezoidal", "qndf"):
        raise AndesAppError(
            f"unknown integrator {integrator_raw!r}; "
            "expected 'trapezoidal' or 'qndf'"
        )

    overrides_raw = args.get("tds_config_overrides")
    tds_config_overrides: dict[str, float] | None = None
    if overrides_raw is not None:
        if not isinstance(overrides_raw, dict):
            raise AndesAppError(
                "'tds_config_overrides' must be a dict of "
                "{string → float}; keys are canonical aliases "
                "(rtol/atol/max_step) or real ss.TDS.config field names"
            )
        coerced: dict[str, float] = {}
        for key, value in overrides_raw.items():
            if not isinstance(key, str):
                raise AndesAppError(
                    f"'tds_config_overrides' keys must be strings, got {type(key).__name__}"
                )
            try:
                coerced[key] = float(value)
            except (TypeError, ValueError, OverflowError) as exc:
                raise AndesAppError(
                    f"'tds_config_overrides[{short_repr(key)}]' must be a float-coercible value"
                ) from exc
        tds_config_overrides = coerced

    # QNDF on a System that has already stepped, an unknown override key, or an
    # override value that breaks its rule: the same refusals ``Wrapper.run_tds``
    # raises, asked for up front.
    wrapper.check_tds_request(integrator_raw, tds_config_overrides)

    # The ANDES variables the run records beyond the streamed groups: each must be
    # a variable of the loaded case, checked against the models' own definitions
    # (no setup needed), so a bad name is refused before anything is written.
    dae_vars_raw = args.get("dae_vars")
    if dae_vars_raw is None:
        dae_vars_raw = []
    if not isinstance(dae_vars_raw, list) or not all(isinstance(v, str) for v in dae_vars_raw):
        raise TdsRequestError("'dae_vars' must be a list of ANDES variable names")
    dae_names = [v.name for v in resolve_dae_vars(wrapper._require_loaded(), dae_vars_raw)]  # noqa: SLF001

    # The run's controllers (``tensa.core.tds_controllers``): each is checked and
    # bound to its device here, so one that names a device the case does not have
    # is refused like a bad variable name, before a stream starts.
    controllers = wrapper.tds_controllers(parse_controllers(args.get("controllers")))

    abort_flag = threading.Event()
    if abort_event.is_set():
        abort_flag.set()

    stream = bool(args.get("stream"))
    on_step: Callable[[float, Any], None] | None = None
    # Takes the System's values as the row of the step solved at the time given.
    record_step: Callable[[float], None] | None = None
    aggregator: StreamAggregator | None = None

    if stream:
        if data_pipe is None or seq is None:
            raise AndesAppError(
                "streaming mode requires data_pipe + seq context (worker bug)"
            )

        # Decimation config (validated at the WS layer; defaults match the
        # current behavior of "every step is its own one-row batch").
        decimation_raw = args.get("decimation") or "none"
        if decimation_raw not in ("none", "mean"):
            raise AndesAppError(
                f"unknown decimation mode: {decimation_raw!r}; expected 'none' or 'mean'"
            )
        max_rate_hz_raw = args.get("max_rate_hz")
        max_rate_hz = float(max_rate_hz_raw) if max_rate_hz_raw is not None else None

        # ``vars`` selects which variable groups appear in each Arrow batch.
        # The WS layer validates the literal set and rejects empty lists; the
        # worker still defends against missing/empty input (other code paths
        # may invoke streaming without the WS layer in tests).
        vars_raw = args.get("vars")
        if vars_raw is None:
            var_groups: list[VarGroup] = list(DEFAULT_VARS)
        elif isinstance(vars_raw, list) and all(
            isinstance(v, str) for v in vars_raw
        ):
            unknown = [v for v in vars_raw if v not in VAR_GROUPS]
            if unknown:
                raise AndesAppError(
                    f"unknown var group(s): {unknown!r}; expected one of "
                    f"{list(VAR_GROUPS)!r}"
                )
            if not vars_raw and not dae_names:
                raise AndesAppError(
                    "'vars' must be a non-empty list when provided"
                )
            # Dedupe while preserving canonical ordering (``var_column_names``
            # also iterates VAR_GROUPS canonically, but normalize here so the
            # metadata's ``vars`` list is stable too).
            seen: set[str] = set()
            var_groups = []
            for g in VAR_GROUPS:
                if g in vars_raw and g not in seen:
                    var_groups.append(g)
                    seen.add(g)
        else:
            raise AndesAppError(
                "'vars' must be a list of variable-group names"
            )

        # Resolve the System ONCE (after load); we need its Bus model to list
        # the columns. If the wrapper has no System loaded the run will fail
        # later — surface the same error path as before.
        ss = wrapper._require_loaded()  # noqa: SLF001 — internal access by design
        # Ensure setup so Bus.v exists; the wrapper would do this anyway when
        # run_tds runs PF first.
        wrapper._ensure_setup()  # noqa: SLF001
        if not bool(getattr(ss.PFlow, "converged", False)):
            ss.PFlow.run()

        # Whether the run steps at a fixed size, so the algorithm label can be
        # honest: boxcar mean over adaptive-step samples is best-effort. Read
        # from the request, not from ``ss.TDS.config.fixt``, which ``run_tds``
        # has not set yet and which still holds an earlier run's value.
        fixed_step = tds_fixed_step(integrator_raw, tds_config_overrides)

        try:
            aggregator = StreamAggregator(
                decimation=decimation_raw,  # type: ignore[arg-type]
                max_rate_hz=max_rate_hz,
                fixed_step=fixed_step,
            )
        except ValueError as exc:
            raise AndesAppError(str(exc)) from exc

        # Snapshot the topology ONCE per run so each callpert tick only reads
        # values: the collector resolves where each one lives now, and the
        # column names list the same devices, so column order and value order
        # line up.
        bus_idx_values = bus_idx_values_from_system(ss)
        syngen_idx_values = syngen_idx_values_from_system(ss)
        line_idx_values = line_idx_values_from_system(ss)
        pq_idx_values = pq_idx_values_from_system(ss)
        var_columns = var_column_names(var_groups, ss, dae_names)
        collector = StreamCollector(ss, var_groups, dae_names)

        # Send the stream-start metadata BEFORE the run begins so the WS
        # sender can forward it as a text frame ahead of any binary frames.
        data_pipe.send(
            {
                "type": "stream_start",
                "seq": seq,
                "metadata": {
                    "schema_version": "2.0",
                    "decimation": {
                        "algorithm": aggregator.algorithm,
                        "mode": aggregator.decimation,
                        "source_rate_hz": None,
                        "output_rate_hz": aggregator.output_rate_hz,
                        "fixed_step": fixed_step,
                    },
                    "vars": list(var_groups),
                    "dae_vars": dae_names,
                    "var_columns": var_columns,
                    "bus_idx_values": [str(idx) for idx in bus_idx_values],
                    "syngen_idx_values": [str(idx) for idx in syngen_idx_values],
                    "line_idx_values": [str(idx) for idx in line_idx_values],
                    "pq_idx_values": [str(idx) for idx in pq_idx_values],
                },
            }
        )

        # Single-element list to allow mutation from inside the closure without
        # stacking ``nonlocal`` declarations across both _emit_rows and the
        # post-run tail-flush below.
        frame_seq_holder = [0]

        def _emit_rows(rows: list[StreamRow], *, tail: bool = False) -> None:
            frame_seq_holder[0] += 1
            payload = encode_batch(len(var_columns), rows)
            envelope: dict[str, Any] = {
                "type": "stream_frame",
                "seq": seq,
                "frame_seq": frame_seq_holder[0],
                "row_count": len(rows),
                "payload": payload,
            }
            if tail:
                envelope["tail"] = True
            try:
                # What ANDES logged since the last frame goes with this one, so a
                # long run's messages (an event applied at t = 2 s) arrive as it goes.
                data_pipe.send(attach_log(envelope))
            except (BrokenPipeError, OSError):
                abort_flag.set()

        def _emit(t: float) -> None:
            assert aggregator is not None
            # As ANDES solved the step, not as an event at its time left it.
            with stored_step(ss, t):
                row = collector.collect()
            rows = aggregator.push(t, row)
            if rows:
                _emit_rows(rows)

        record_step = _emit

    # A batch run has no frames to carry the values it was asked to record, so it
    # keeps them and returns them with its summary.
    recorder: TraceRecorder | None = None
    if not stream and dae_names:
        loaded = wrapper._require_loaded()  # noqa: SLF001
        recorder = TraceRecorder(StreamCollector(loaded, [], dae_names), dae_names)
        kept = recorder

        def _keep(t: float) -> None:
            with stored_step(loaded, t):
                kept.record(t)

        record_step = _keep

    # The hook is called before the step it names is solved, so a row is the
    # step before, under that step's time (``tensa.core.tds_steps``).
    clock = StepClock()
    if record_step is not None:

        def _on_step(t: float, system: Any) -> None:
            solved = clock.hook(t, system)
            if solved is not None:
                record_step(solved)

        on_step = _on_step

    # Started last, once nothing ahead of the run can refuse: only the run's
    # ``finally`` below sets ``abort_flag``, so a bridge started any earlier
    # would keep polling after a refusal.
    def _bridge() -> None:
        while not abort_flag.is_set():
            if abort_event.wait(timeout=0.1):
                abort_flag.set()
                return

    bridge_thread = threading.Thread(target=_bridge, name="abort-bridge", daemon=True)
    bridge_thread.start()

    try:
        result = wrapper.run_tds(
            tf=args["tf"],
            h=h,
            on_step=on_step,
            abort_flag=abort_flag,
            integrator=integrator_raw,
            tds_config_overrides=tds_config_overrides,
            controllers=controllers,
        )
    finally:
        abort_flag.set()

    # The step the run ended on, which no call of the hook saw: at ``tf`` when
    # the run got there.
    if record_step is not None:
        last = clock.end(wrapper._require_loaded())  # noqa: SLF001
        if last is not None:
            record_step(last)

    # Drain any buffered rows that didn't reach an emit boundary before run end.
    # A mean-decimated run keeps its last step out of the last window's mean, so
    # there can be two rows: each goes in a frame of its own, as every window's
    # row of such a run does.
    if stream and aggregator is not None:
        tail_rows = aggregator.flush()
        if tail_rows and aggregator.decimation == "mean":
            for row in tail_rows:
                _emit_rows([row], tail=True)
        elif tail_rows:
            _emit_rows(tail_rows, tail=True)

    abort_event.clear()
    payload = _serialize_dataclass(result)
    if recorder is not None:
        payload["traces"] = recorder.result()
    if controllers is not None:
        # What each controller did goes into the session's messages, and into the
        # result: with its samples for a batch run, which has no stream to plot
        # them from, and without for a streamed one, whose ``done`` frame is small.
        log_controller_notices(controllers)
        payload["controllers"] = controllers.results(traces=not stream)
    return payload


def _handle_list_tds_controllers(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """The kinds of controller a run takes and the devices of the loaded case
    they can command (see ``tensa.core.tds_controllers``). A listing is a read:
    with no case loaded there are no devices."""
    return wrapper.tds_controller_catalogue()


def _handle_list_dae_variables(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """The ANDES variables of the loaded case (see ``tensa.core.dae_vars``), one
    page of those matching ``q`` / ``kind`` / ``model``, with the total that match."""
    try:
        catalogue = dae_variables(wrapper._require_loaded())  # noqa: SLF001
    except NoCaseLoadedError:
        # A listing is a read: with no case loaded the truthful answer is none.
        catalogue = []
    matches = search_dae_variables(
        catalogue,
        query=args.get("q"),
        kind=args.get("kind"),
        model=args.get("model"),
    )
    offset = int(args.get("offset") or 0)
    limit = int(args.get("limit") or 100)
    return {
        "total": len(matches),
        "items": [as_dict(v) for v in matches[offset : offset + limit]],
    }


HANDLERS: dict[str, Callable[..., Any]] = {
    "load_case": _handle_load_case,
    "reload_case": _handle_reload_case,
    "topology": _handle_topology,
    "operating_point": _handle_operating_point,
    "add_disturbance": _handle_add_disturbance,
    "list_disturbances": _handle_list_disturbances,
    "replay_disturbances": _handle_replay_disturbances,
    "clear_disturbances": _handle_clear_disturbances,
    "add_element": _handle_add_element,
    "edit_element": _handle_edit_element,
    "create_blank": _handle_create_blank,
    "save_case": _handle_save_case,
    "undo_last_edit": _handle_undo_last_edit,
    "redo_edit": _handle_redo_edit,
    "delete_element": _handle_delete_element,
    "run_pflow": _handle_run_pflow,
    "alterable_params": _handle_alterable_params,
    "list_dae_variables": _handle_list_dae_variables,
    "list_tds_controllers": _handle_list_tds_controllers,
    # Unit 21 — clone-on-write file edits (init / edit / undo / redo / save-as / reset).
    "init_clone": _handle_init_clone,
    "apply_clone_edit": _handle_apply_clone_edit,
    "undo_clone_edit": _handle_undo_clone_edit,
    "redo_clone_edit": _handle_redo_clone_edit,
    "save_clone_as": _handle_save_clone_as,
    "reset_clone": _handle_reset_clone,
    "clone_diff": _handle_clone_diff,
    "export_bundle": _handle_export_bundle,
    # Unit 10 — bundle import + conflict resolution.
    "import_bundle": _handle_import_bundle,
    "generate_report": _handle_generate_report,
    "run_eig": _handle_run_eig,
    "eig_participation": _handle_eig_participation,
    "eig_state_matrix": _handle_eig_state_matrix,
    # Unit 12 — CPF (continuation power flow): full PV-curve sweep + per-bus QV.
    "run_cpf": _handle_run_cpf,
    "run_cpf_qv": _handle_run_cpf_qv,
    # Unit 13 — SE (state estimation): two-step (generate measurements, run SE).
    "generate_measurements_from_pflow": _handle_generate_measurements_from_pflow,
    "run_se": _handle_run_se,
    # Unit 14 — PMU placement + post-run CSV export.
    "add_pmu": _handle_add_pmu,
    "list_pmus": _handle_list_pmus,
    "delete_pmu": _handle_delete_pmu,
    "export_pmu_csv": _handle_export_pmu_csv,
    # Unit 15 — TimeSeries profile import + assignment.
    "upload_profile": _handle_upload_profile,
    "add_timeseries": _handle_add_timeseries,
    "list_timeseries": _handle_list_timeseries,
    "delete_timeseries": _handle_delete_timeseries,
    # Unit 17 — connectivity / island detection (post-run only; no per-frame
    # streaming integration per the plan's auto-fix).
    "compute_connectivity": _handle_compute_connectivity,
    # Unit 7 — snapshot save / restore / list / delete.
    "save_snapshot": _handle_save_snapshot,
    "restore_snapshot": _handle_restore_snapshot,
    "list_snapshots": _handle_list_snapshots,
    "delete_snapshot": _handle_delete_snapshot,
    # Parallel sweeps: the session's worker answers ``sweep_plan``; the sub-workers
    # the server spawns for the sweep answer ``adopt_sweep_source`` and (special-cased
    # below, it needs the abort event) ``run_sweep_iteration``.
    "sweep_plan": _handle_sweep_plan,
    "adopt_sweep_source": _handle_adopt_sweep_source,
    # run_tds is special-cased — it needs the abort_event. Dispatched separately.
}


# ---- main entry point -------------------------------------------------------


def worker_main(
    ctrl: Connection,
    data: Connection,
    abort_event: EventType,
    workspace: str | None = None,
    session_id: str | None = None,
    owner_pid: int | None = None,
) -> int:
    """Subprocess entry. Runs until a ``shutdown`` command arrives, the parent
    dies, or an unrecoverable error occurs.

    ``workspace``, when provided, enables the best-effort ``sys.audit`` hook
    that warns on out-of-workspace file opens (see
    ``_install_strict_fs_audit_hook`` for caveats).

    ``session_id`` (Unit 21) is forwarded so the wrapper's clone-on-write
    manager can name its per-session scratch dir
    ``<workspace>/.sessions/<session_id>/clone/`` — the same id the parent
    SessionManager uses to clean up the dir on session reap.

    ``owner_pid`` is the parent server's pid. It goes into the scratch dir's
    owner marker so a later server can tell the dir was abandoned (see
    ``core/session_dirs.py``).

    Unless a command is already waiting, the worker imports ANDES before it reads
    the first one (``_warm_andes``), so the first case load does not pay for it.

    ``abort_event`` is the session's ``multiprocessing.Event``. A sub-worker of
    a parallel sweep gets a ``PipeAbortEvent`` instead, which has only the
    ``is_set`` and ``wait`` that ``run_sweep_iteration`` uses (see
    ``core/sweep_pool.py`` for why it is not an ``Event``).

    Returns the process exit code (0 = clean shutdown).
    """
    _enable_faulthandler()
    _ignore_sigint()
    _set_parent_death_signal()
    _spawn_orphan_detector()
    # What ANDES logs while a command runs goes back with its reply (see
    # ``tensa.core.messages``). Installed before anything imports ANDES, and taken
    # off again when the loop ends so a worker run in-process leaves no handler. The
    # workspace is the root its paths are written relative to, so none is sent in full.
    install_capture(workspace)
    try:
        # Import ANDES now, before the first ``recv``, so the first load does not. This
        # runs ahead of the audit hook on purpose: it reads only library files, and the
        # hook would log some of them (the system's ``mime.types``) as strays.
        _warm_up_if_idle(ctrl)
        _install_strict_fs_audit_hook(workspace)
        return _serve_commands(ctrl, data, abort_event, workspace, session_id, owner_pid)
    finally:
        uninstall_capture()


def _serve_commands(
    ctrl: Connection,
    data: Connection,
    abort_event: EventType,
    workspace: str | None,
    session_id: str | None,
    owner_pid: int | None,
) -> int:
    """The command loop of :func:`worker_main`: read a command, run it, send the
    reply (with what ANDES logged while it ran), until ``shutdown`` or a closed pipe."""

    # ``workspace`` is forwarded so the wrapper's snapshot methods
    # (Unit 7) can resolve ``<workspace>/snapshots/<case>/<name>.{dill,json}``
    # without re-deriving the directory from the FastAPI app state (which
    # the worker subprocess can't read).
    wrapper = Wrapper(workspace=workspace, session_id=session_id, owner_pid=owner_pid)

    def reply(message: dict[str, Any]) -> None:
        data.send(attach_log(message))

    while True:
        try:
            command = ctrl.recv()
        except (EOFError, OSError):
            # Parent closed the pipe; exit cleanly.
            return 0

        op = command.get("op")
        seq = command.get("seq")
        args = command.get("args") or {}

        if op == "shutdown":
            with contextlib.suppress(BrokenPipeError, OSError):
                data.send({"type": "result", "seq": seq, "payload": None})
            return 0

        begin_command(str(op))
        try:
            if op == "run_tds":
                payload = _handle_run_tds(wrapper, args, abort_event, data, seq)
            elif op == "run_sweep":
                # Sweep is also long-running + uses the data pipe for
                # progress events + needs the abort event for
                # cancellation. Same special-cased dispatch as run_tds.
                payload = _handle_run_sweep(wrapper, args, abort_event, data, seq)
            elif op == "run_sweep_iteration":
                payload = _handle_run_sweep_iteration(wrapper, args, abort_event)
            else:
                handler = HANDLERS.get(op)
                if handler is None:
                    raise AndesAppError(f"unknown op: {op!r}")
                payload = handler(wrapper, args)
            reply({"type": "result", "seq": seq, "payload": payload})
        except DisturbanceCommitError as exc:
            reply(
                {
                    "type": "error",
                    "seq": seq,
                    "category": "disturbance-commit",
                    "detail": str(exc),
                }
            )
        except NoCaseLoadedError as exc:
            reply(
                {
                    "type": "error",
                    "seq": seq,
                    "category": "no-case-loaded",
                    "detail": str(exc),
                }
            )
        except ElementHasDependentsError as exc:
            # Carry the (capped) dependents and disturbances lists + their
            # total counts over the Pipe so the routes layer can build a typed
            # ``DeleteBlockedResponse`` body. ``extra`` is the worker
            # side's structured-extra escape hatch; the parent's
            # ``WorkerError`` exposes it via ``exc.extra``.
            reply(
                {
                    "type": "error",
                    "seq": seq,
                    "category": exc.__class__.__name__,
                    "detail": str(exc),
                    "extra": {
                        "dependents": exc.dependents,
                        "total": exc.total,
                        "disturbances": exc.disturbances,
                        "disturbances_total": exc.disturbances_total,
                    },
                }
            )
        except AndesAppError as exc:
            # Bundle-validation errors carry a domain-level ``category``
            # field (e.g., ``corrupt-zip``, ``manifest-malformed``) that
            # the route layer maps to specific HTTP statuses. Surface it
            # via the wire's ``category`` channel so the router doesn't
            # have to peek into ``detail`` strings.
            wire_category = exc.__class__.__name__
            extra: dict[str, Any] | None = None
            bundle_category = getattr(exc, "category", None)
            if isinstance(bundle_category, str) and exc.__class__.__name__ == "BundleValidationError":
                wire_category = f"BundleValidationError:{bundle_category}"
                missing_fields = getattr(exc, "missing_fields", None)
                if missing_fields:
                    extra = {"missing_fields": list(missing_fields)}
            error_payload: dict[str, Any] = {
                "type": "error",
                "seq": seq,
                "category": wire_category,
                "detail": str(exc),
            }
            if extra is not None:
                error_payload["extra"] = extra
            reply(error_payload)
        except Exception as exc:  # noqa: BLE001 — last-resort
            reply(
                {
                    "type": "error",
                    "seq": seq,
                    "category": "internal-error",
                    "detail": f"{exc.__class__.__name__}: {exc}",
                }
            )
