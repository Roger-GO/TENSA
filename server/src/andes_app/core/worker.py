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


def _handle_run_pflow(wrapper: Wrapper, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(wrapper.run_pflow())


def _handle_run_tds(
    wrapper: Wrapper,
    args: dict[str, Any],
    abort_event: EventType,
) -> Any:
    abort_flag = threading.Event()
    if abort_event.is_set():
        # Honor any pending abort even before run starts
        abort_flag.set()

    def _bridge() -> None:
        # Bridges the multiprocessing Event to the threading Event so the
        # wrapper's per-step abort poll is fast (threading.Event check is
        # cheap; checking a multiprocessing.Event each step would be slower).
        while not abort_flag.is_set():
            if abort_event.wait(timeout=0.1):
                abort_flag.set()
                return

    bridge_thread = threading.Thread(target=_bridge, name="abort-bridge", daemon=True)
    bridge_thread.start()
    try:
        result = wrapper.run_tds(
            tf=args["tf"],
            h=args.get("h"),
            abort_flag=abort_flag,
        )
    finally:
        # Force the bridge thread to exit cleanly
        abort_flag.set()
    abort_event.clear()  # ready for the next run
    return _serialize_dataclass(result)


HANDLERS: dict[str, Callable[..., Any]] = {
    "load_case": _handle_load_case,
    "reload_case": _handle_reload_case,
    "topology": _handle_topology,
    "add_disturbance": _handle_add_disturbance,
    "run_pflow": _handle_run_pflow,
    # run_tds is special-cased — it needs the abort_event. Dispatched separately.
}


# ---- main entry point -------------------------------------------------------


def worker_main(
    ctrl: Connection,
    data: Connection,
    abort_event: EventType,
) -> int:
    """Subprocess entry. Runs until a ``shutdown`` command arrives, the parent
    dies, or an unrecoverable error occurs.

    Returns the process exit code (0 = clean shutdown).
    """
    _set_parent_death_signal()
    _spawn_orphan_detector()

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
                payload = _handle_run_tds(wrapper, args, abort_event)
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
