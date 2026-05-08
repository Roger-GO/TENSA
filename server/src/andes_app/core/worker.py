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
    NoCaseLoadedError,
)

# AndesAppError catches the new ElementValidationError /
# ElementNotFoundError / SystemAlreadyLoadedError subclasses and forwards
# them with their class name as ``category``; the routes layer maps each
# to the right HTTP status (see api/routes/elements.py:_map_worker_error).
from andes_app.core.stream import (
    StreamAggregator,
    bus_idx_values_from_system,
    collect_bus_voltages,
    encode_batch,
    make_bus_voltage_schema,
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


def _handle_run_pflow(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.run_pflow())


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

        bus_idx_values = bus_idx_values_from_system(ss)
        schema = make_bus_voltage_schema(bus_idx_values)
        var_columns = [f"Bus_{idx}_v" for idx in bus_idx_values]

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
                    "var_columns": var_columns,
                    "bus_idx_values": [str(idx) for idx in bus_idx_values],
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
            values = collect_bus_voltages(system)
            rows = aggregator.push(t, values)
            if rows:
                _emit_rows(rows)

        on_step = _emit

    try:
        result = wrapper.run_tds(
            tf=args["tf"],
            h=args.get("h"),
            on_step=on_step,
            abort_flag=abort_flag,
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
    "add_element": _handle_add_element,
    "edit_element": _handle_edit_element,
    "create_blank": _handle_create_blank,
    "save_case": _handle_save_case,
    "run_pflow": _handle_run_pflow,
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

    wrapper = Wrapper()

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
        except AndesAppError as exc:
            data.send(
                {
                    "type": "error",
                    "seq": seq,
                    "category": exc.__class__.__name__,
                    "detail": str(exc),
                }
            )
        except Exception as exc:  # noqa: BLE001 — last-resort
            data.send(
                {
                    "type": "error",
                    "seq": seq,
                    "category": "internal-error",
                    "detail": f"{exc.__class__.__name__}: {exc}",
                }
            )
