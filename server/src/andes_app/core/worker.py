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
  Pipe keeps abort responsive even if ``callpert`` is sleeping at the credit
  ceiling.
- **Orphan-detection thread (macOS only)** — polls ``os.getppid()`` every 1 s.
  When the parent dies, ``getppid()`` returns 1 (init). The thread then
  ``os.kill(os.getpid(), SIGTERM)``. On Linux this thread is unnecessary
  because ``PR_SET_PDEATHSIG(SIGTERM)`` is set at entry.

Wire protocol on the control Pipe (parent → worker):

    {"op": "load_case", "args": {"path": ..., "addfiles": [...]}, "seq": N}
    {"op": "add_disturbance", "args": {"spec": <dict>}, "seq": N}
    {"op": "run_pflow", "args": {}, "seq": N}
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
import os
import signal
import sys
import threading
import time
from collections.abc import Callable
from multiprocessing.connection import Connection
from multiprocessing.synchronize import Event as EventType
from typing import Any

from andes_app.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from andes_app.core.errors import (
    AndesAppError,
    DisturbanceCommitError,
    ElementHasDependentsError,
    NoCaseLoadedError,
)

# AndesAppError catches the new ElementValidationError /
# ElementNotFoundError / SystemAlreadyLoadedError subclasses and forwards
# them with their class name as ``category``; the routes layer maps each
# to the right HTTP status (see api/error_mapping.py:map_worker_error).
from andes_app.core.stream import (
    DEFAULT_VARS,
    VAR_GROUPS,
    StreamAggregator,
    VarGroup,
    bus_idx_values_from_system,
    collect_combined_values,
    encode_batch,
    line_idx_values_from_system,
    make_combined_schema,
    syngen_idx_values_from_system,
)
from andes_app.core.wrapper import Wrapper


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

    log = logging.getLogger("andes-app.worker.audit")
    workspace_str = os.path.realpath(workspace)

    def _hook(event: str, args: tuple[Any, ...]) -> None:
        if event != "open":
            return
        # PEP 578 'open' event args: (path, mode, flags). path may be a
        # str, bytes, int (fd), or PathLike. We only care about string-like
        # paths for the workspace boundary check.
        if not args:
            return
        path = args[0]
        if not isinstance(path, (str, bytes, os.PathLike)):
            return
        try:
            real = os.path.realpath(os.fsdecode(path))
        except (OSError, ValueError):
            return
        # Allow opens inside the workspace and ANDES's own install tree
        if real.startswith(workspace_str):
            return
        # Allow Python stdlib + site-packages (the ANDES code itself reads many
        # files from its own install tree). We only want to *log* opens from
        # case-file-driven secondary reads, not every stdlib import.
        # Heuristic: ignore .py / .pyc / .so / .pyd / .pth / .json (in
        # site-packages) opens.
        if any(
            real.endswith(ext) for ext in (".py", ".pyc", ".so", ".pyd", ".pth")
        ):
            return
        if "site-packages" in real or real.startswith("/usr/lib/python"):
            return
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


def _handle_delete_element(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(
        wrapper.delete_element(args["model"], args["idx"])
    )


def _handle_alterable_params(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return list(wrapper.alterable_params(args["model"]))


def _handle_run_pflow(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.run_pflow())


def _handle_generate_report(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Generate a routine report (Unit 4 of the v2.0 plan; Unit 6 added EIG).

    Routines: ``pflow``, ``tds``, ``eig``. The handler reaches into
    the wrapper's loaded System (private accessor) — the report
    generator does not mutate state, only reads + tempfile-roundtrips
    the ``ss.PFlow.report()`` / ``ss.EIG.report()`` output.
    """
    from andes_app.core.report import (
        EigReportPrerequisiteError,
        PflowNotConvergedError,
        ReportGenerationError,
        ReportRoutine,
        TdsNotRunError,
        generate_report,
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

    Forwards ``direction`` / ``step`` / ``max_iter`` from the request
    body. Returns a serialized :class:`CpfResult` dict
    (``lambdas``, ``voltages_per_bus``, ``bus_idxes``, ``nose_idx``,
    ``max_lam``, ``truncated``, ``done_msg``, ``mode``).
    """
    direction = str(args.get("direction", "load"))
    step_raw = args.get("step")
    step = float(step_raw) if step_raw is not None else None
    max_iter_raw = args.get("max_iter")
    max_iter = int(max_iter_raw) if max_iter_raw is not None else None
    return _serialize_dataclass(
        wrapper.run_cpf(direction=direction, step=step, max_iter=max_iter)
    )


def _handle_run_cpf_qv(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.run_cpf_qv`` for Unit 12.

    The bus_idx is required; ``q_range`` is optional (default 5.0
    matches ANDES's own default).
    """
    bus_idx = str(args["bus_idx"])
    q_range_raw = args.get("q_range")
    q_range = float(q_range_raw) if q_range_raw is not None else 5.0
    return _serialize_dataclass(
        wrapper.run_cpf_qv(bus_idx=bus_idx, q_range=q_range)
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
      wrapper's ``_replay_buffer`` is empty (no edits since load), or
      written via ``Wrapper.save_case('xlsx', ...)`` when the case is
      dirty. ``case_canonical_export`` in the manifest reflects which
      path was taken.
    - The ANDES + ``andes_app`` version strings.

    Returns the zip bytes (under a few MB for typical sessions —
    well within Pipe-send-tolerance).
    """
    import tempfile
    from pathlib import Path

    # ANDES version is the only ANDES-side fact we need; lazy-import keeps
    # the worker startup cost paid by other handlers.
    import andes

    from andes_app import __version__ as andes_app_version
    from andes_app.core.bundle import (
        BundleInputs,
        assemble_bundle,
        case_files_from_workspace,
    )

    # _replay_buffer is the only substrate-side signal of "case has been
    # edited since load". Length > 0 with a non-None case path means the
    # user added elements on top of the loaded case — the bundle must
    # ship the canonical export, not the original file.
    replay_buffer = wrapper._replay_buffer  # noqa: SLF001 — internal access by design
    case_path = wrapper._case_path  # noqa: SLF001
    addfiles = wrapper._addfiles  # noqa: SLF001

    if case_path is None and not replay_buffer:
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
    elif replay_buffer:
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
        andes_app_version=str(andes_app_version),
    )
    return assemble_bundle(inputs)


def _handle_save_snapshot(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.save_snapshot`` for Unit 7.

    Args: ``{"name": str, "force": bool}``. Returns the metadata dict +
    file sizes so the route layer can echo them in the success response.
    """
    name = args.get("name")
    if not isinstance(name, str):
        raise AndesAppError("'name' must be a string")
    force = bool(args.get("force", False))
    return wrapper.save_snapshot(name, force=force)


def _handle_restore_snapshot(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    """Wire ``Wrapper.restore_snapshot`` for Unit 7.

    Args: ``{"name": str, "use_dill_optimization": bool}``. Returns the
    restore-result dict (``used_dill``, ``fallback_reason``,
    ``disturbances_replayed``, ``metadata``).
    """
    name = args.get("name")
    if not isinstance(name, str):
        raise AndesAppError("'name' must be a string")
    use_dill = bool(args.get("use_dill_optimization", True))
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
    h_raw = args.get("h")
    h = float(h_raw) if h_raw is not None else None
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
    ``{"type": "stream_start", ...}`` message carrying the schema metadata.
    The final ``{"type": "result", ...}`` message lands as usual at end of run.
    """
    abort_flag = threading.Event()
    if abort_event.is_set():
        abort_flag.set()

    def _bridge() -> None:
        while not abort_flag.is_set():
            if abort_event.wait(timeout=0.1):
                abort_flag.set()
                return

    bridge_thread = threading.Thread(target=_bridge, name="abort-bridge", daemon=True)
    bridge_thread.start()

    stream = bool(args.get("stream"))
    on_step: Callable[[float, Any], None] | None = None
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
            if not vars_raw:
                raise AndesAppError(
                    "'vars' must be a non-empty list when provided"
                )
            # Dedupe while preserving canonical ordering (the schema
            # composer also iterates VAR_GROUPS canonically, but normalize
            # here so the metadata's ``vars`` list is stable too).
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

        # Resolve the System ONCE (after load); we need its Bus model to build
        # the schema. If the wrapper has no System loaded the run will fail
        # later — surface the same error path as before.
        ss = wrapper._require_loaded()  # noqa: SLF001 — internal access by design
        # Ensure setup so Bus.v exists; the wrapper would do this anyway when
        # run_tds runs PF first.
        wrapper._ensure_setup()  # noqa: SLF001
        if not bool(getattr(ss.PFlow, "converged", False)):
            ss.PFlow.run()

        # Read the integrator config so the algorithm label can be honest:
        # boxcar mean over adaptive-step samples is best-effort.
        fixed_step = bool(getattr(ss.TDS.config, "fixt", False))

        try:
            aggregator = StreamAggregator(
                decimation=decimation_raw,  # type: ignore[arg-type]
                max_rate_hz=max_rate_hz,
                fixed_step=fixed_step,
            )
        except ValueError as exc:
            raise AndesAppError(str(exc)) from exc

        # Snapshot the topology indices ONCE per run so each callpert tick
        # only does the (cheap) value reads. The schema mirrors the same
        # snapshot, so column order and value order line up.
        bus_idx_values = bus_idx_values_from_system(ss)
        syngen_idx_values = syngen_idx_values_from_system(ss)
        line_idx_values = line_idx_values_from_system(ss)
        schema, var_columns = make_combined_schema(var_groups, ss)

        # Send the stream-start metadata BEFORE the run begins so the WS
        # sender can forward it as a text frame ahead of any binary frames.
        data_pipe.send(
            {
                "type": "stream_start",
                "seq": seq,
                "metadata": {
                    "schema_version": "1.0",
                    "decimation": {
                        "algorithm": aggregator.algorithm,
                        "mode": aggregator.decimation,
                        "source_rate_hz": None,
                        "output_rate_hz": aggregator.output_rate_hz,
                        "fixed_step": fixed_step,
                    },
                    "vars": list(var_groups),
                    "var_columns": var_columns,
                    "bus_idx_values": [str(idx) for idx in bus_idx_values],
                    "syngen_idx_values": [str(idx) for idx in syngen_idx_values],
                    "line_idx_values": [str(idx) for idx in line_idx_values],
                },
            }
        )

        # Single-element list to allow mutation from inside the closure without
        # stacking ``nonlocal`` declarations across both _emit_rows and the
        # post-run tail-flush below.
        frame_seq_holder = [0]

        def _emit_rows(
            rows: list[tuple[float, list[float]]], *, tail: bool = False
        ) -> None:
            frame_seq_holder[0] += 1
            payload = encode_batch(schema, rows)
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
                data_pipe.send(envelope)
            except (BrokenPipeError, OSError):
                abort_flag.set()

        def _emit(t: float, system: Any) -> None:
            assert aggregator is not None
            values = collect_combined_values(
                system,
                var_groups,
                syngen_idx_values=syngen_idx_values,
                line_idx_values=line_idx_values,
            )
            rows = aggregator.push(t, values)
            if rows:
                _emit_rows(rows)

        on_step = _emit

    # Unit 16: integrator selection + adaptive-tolerance overrides.
    # ``integrator`` defaults to ``"trapezoidal"`` so existing callers
    # (and the streaming WS path which doesn't yet pipe these args)
    # see no behaviour change. Validation of the literal value lives in
    # the wrapper; we only normalise the wire shape here.
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
            except (TypeError, ValueError) as exc:
                raise AndesAppError(
                    f"'tds_config_overrides[{key!r}]' must be a float-coercible value"
                ) from exc
        tds_config_overrides = coerced

    try:
        result = wrapper.run_tds(
            tf=args["tf"],
            h=args.get("h"),
            on_step=on_step,
            abort_flag=abort_flag,
            integrator=integrator_raw,
            tds_config_overrides=tds_config_overrides,
        )
    finally:
        abort_flag.set()

    # Drain any buffered rows that didn't reach an emit boundary before run end.
    if stream and aggregator is not None:
        tail_rows = aggregator.flush()
        if tail_rows:
            _emit_rows(tail_rows, tail=True)

    abort_event.clear()
    return _serialize_dataclass(result)


HANDLERS: dict[str, Callable[..., Any]] = {
    "load_case": _handle_load_case,
    "reload_case": _handle_reload_case,
    "topology": _handle_topology,
    "add_disturbance": _handle_add_disturbance,
    "list_disturbances": _handle_list_disturbances,
    "replay_disturbances": _handle_replay_disturbances,
    "clear_disturbances": _handle_clear_disturbances,
    "add_element": _handle_add_element,
    "edit_element": _handle_edit_element,
    "create_blank": _handle_create_blank,
    "save_case": _handle_save_case,
    "undo_last_edit": _handle_undo_last_edit,
    "delete_element": _handle_delete_element,
    "run_pflow": _handle_run_pflow,
    "alterable_params": _handle_alterable_params,
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
    # run_tds is special-cased — it needs the abort_event. Dispatched separately.
}


# ---- main entry point -------------------------------------------------------


def worker_main(
    ctrl: Connection,
    data: Connection,
    abort_event: EventType,
    workspace: str | None = None,
) -> int:
    """Subprocess entry. Runs until a ``shutdown`` command arrives, the parent
    dies, or an unrecoverable error occurs.

    ``workspace``, when provided, enables the best-effort ``sys.audit`` hook
    that warns on out-of-workspace file opens (see
    ``_install_strict_fs_audit_hook`` for caveats).

    Returns the process exit code (0 = clean shutdown).
    """
    _set_parent_death_signal()
    _spawn_orphan_detector()
    _install_strict_fs_audit_hook(workspace)

    # ``workspace`` is forwarded so the wrapper's snapshot methods
    # (Unit 7) can resolve ``<workspace>/snapshots/<case>/<name>.{dill,json}``
    # without re-deriving the directory from the FastAPI app state (which
    # the worker subprocess can't read).
    wrapper = Wrapper(workspace=workspace)

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

        try:
            if op == "run_tds":
                payload = _handle_run_tds(wrapper, args, abort_event, data, seq)
            elif op == "run_sweep":
                # Sweep is also long-running + uses the data pipe for
                # progress events + needs the abort event for
                # cancellation. Same special-cased dispatch as run_tds.
                payload = _handle_run_sweep(wrapper, args, abort_event, data, seq)
            else:
                handler = HANDLERS.get(op)
                if handler is None:
                    raise AndesAppError(f"unknown op: {op!r}")
                payload = handler(wrapper, args)
            data.send({"type": "result", "seq": seq, "payload": payload})
        except DisturbanceCommitError as exc:
            data.send(
                {
                    "type": "error",
                    "seq": seq,
                    "category": "disturbance-commit",
                    "detail": str(exc),
                }
            )
        except NoCaseLoadedError as exc:
            data.send(
                {
                    "type": "error",
                    "seq": seq,
                    "category": "no-case-loaded",
                    "detail": str(exc),
                }
            )
        except ElementHasDependentsError as exc:
            # Carry the (capped) dependents list + total count over the
            # Pipe so the routes layer can build a typed
            # ``DeleteBlockedResponse`` body. ``extra`` is the worker
            # side's structured-extra escape hatch; the parent's
            # ``WorkerError`` exposes it via ``exc.extra``.
            data.send(
                {
                    "type": "error",
                    "seq": seq,
                    "category": exc.__class__.__name__,
                    "detail": str(exc),
                    "extra": {
                        "dependents": exc.dependents,
                        "total": exc.total,
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
            data.send(error_payload)
        except Exception as exc:  # noqa: BLE001 — last-resort
            data.send(
                {
                    "type": "error",
                    "seq": seq,
                    "category": "internal-error",
                    "detail": f"{exc.__class__.__name__}: {exc}",
                }
            )
