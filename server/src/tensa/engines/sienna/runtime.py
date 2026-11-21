"""The Sienna engine's runtime: a handler table over ``SiennaState``.

Shaped like the worker's own table (``tensa.core.worker.HANDLERS``): each
handler takes the state and the op's args and answers the payload the worker
sends back, serialised with the worker's ``_serialize_dataclass``. The ops
are exactly the six the engine has; an op outside the table is refused by
the worker before dispatch.
"""

from __future__ import annotations

import logging
from typing import Any

from tensa.core.errors import NoCaseLoadedError
from tensa.core.worker import _serialize_dataclass
from tensa.engines.base import EngineRuntime
from tensa.engines.sienna.bridge import JuliaBridge
from tensa.engines.sienna.state import SiennaState

log = logging.getLogger("tensa.sienna")


def _handle_load_case(state: SiennaState, args: dict[str, Any]) -> Any:
    from pathlib import Path

    addfiles_raw = args.get("addfiles")
    addfiles = [Path(a) for a in addfiles_raw] if addfiles_raw else None
    on_unsupported = args.get("on_unsupported")
    return _serialize_dataclass(
        state.load_case(
            Path(args["path"]),
            addfiles=addfiles,
            on_unsupported=on_unsupported if on_unsupported is not None else "refuse",
        )
    )


def _handle_reload_case(state: SiennaState, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(state.reload_case())


def _handle_topology(state: SiennaState, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(state.topology())


def _handle_operating_point(state: SiennaState, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(state.operating_point())


def _handle_run_pflow(state: SiennaState, args: dict[str, Any]) -> Any:
    options = {
        key: args[key]
        for key in (
            "tolerance",
            "max_iterations",
            "flat_start",
            "enforce_q_limits",
            "method",
            "n_factorize",
            "linesearch",
        )
        if args.get(key) is not None
    }
    return _serialize_dataclass(state.run_pflow(**options))


def _handle_list_keys(state: SiennaState, args: dict[str, Any]) -> Any:
    """The keys of the loaded case's elements, in assignment order, with the
    problems the assignment noted. A listing is a read: with no case loaded
    the truthful answer is empty lists."""
    try:
        book = state.keys()
    except NoCaseLoadedError:
        return {"keys": [], "problems": []}
    return {
        "keys": [
            {
                "key": entry.key,
                "bucket": entry.bucket,
                "model": entry.model,
                "idx": entry.idx,
                "source": entry.source,
            }
            for entry in book.entries()
        ],
        "problems": list(book.problems),
    }


_HANDLERS: dict[str, Any] = {
    "load_case": _handle_load_case,
    "reload_case": _handle_reload_case,
    "topology": _handle_topology,
    "operating_point": _handle_operating_point,
    "run_pflow": _handle_run_pflow,
    "list_keys": _handle_list_keys,
}


def _dispatch(
    state: Any,
    op: str,
    args: dict[str, Any],
    abort_event: Any,
    data: Any,
    seq: Any,
) -> Any:
    """Answer one op on a ``SiennaState``."""
    return _HANDLERS[op](state, args)


def _warm_up() -> None:
    """Start the bridge, so the first op does not pay for Julia's start.

    Best effort: a failure only means the first op reports the real error
    itself, as the ANDES warm-up treats one.
    """
    try:
        bridge = JuliaBridge()
        bridge.start()
    except Exception as exc:  # noqa: BLE001 — warming is an optimisation
        log.warning(
            "could not start Julia ahead of the first op (%s: %s); "
            "the first op will try again",
            exc.__class__.__name__,
            exc,
        )


def sienna_runtime() -> EngineRuntime:
    """The Sienna engine: a ``SiennaState`` per session, the six ops."""
    return EngineRuntime(
        name="sienna",
        make_state=lambda workspace, session_id, owner_pid: SiennaState(
            workspace=workspace, session_id=session_id, owner_pid=owner_pid
        ),
        dispatch=_dispatch,
        warm_up=_warm_up,
    )
