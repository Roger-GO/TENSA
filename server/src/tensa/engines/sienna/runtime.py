"""The Sienna engine's runtime: a handler table over ``SiennaState``.

Shaped like the worker's own table (``tensa.core.worker.HANDLERS``): each
handler takes the state and the op's args and answers the payload the worker
sends back, serialised with the worker's ``_serialize_dataclass``. The ops
are exactly the thirteen the engine has; an op outside the table is refused
by the worker before dispatch. ``run_tds`` is dispatched directly, as the
ANDES table special-cases it: it needs the abort event.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter

from tensa.core.disturbance import DisturbanceSpec
from tensa.core.errors import NoCaseLoadedError
from tensa.core.messages import NOTICE_LOGGER
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


def _handle_run_eig(state: SiennaState, args: dict[str, Any]) -> Any:
    from tensa.engines.sienna.state import SIENNA_EIG_NOTE

    load_model = args.get("load_model")
    result = state.run_eig(load_model=load_model if load_model is not None else "impedance")
    payload = _serialize_dataclass(result)
    payload["load_model"] = load_model if load_model is not None else "impedance"
    payload["notes"] = [SIENNA_EIG_NOTE]
    return payload


def _handle_eig_participation(state: SiennaState, args: dict[str, Any]) -> Any:
    return state.eig_participation(int(args["mode_idx"]))


def _handle_add_disturbance(state: SiennaState, args: dict[str, Any]) -> Any:
    spec = TypeAdapter(DisturbanceSpec).validate_python(args["spec"])
    return state.add_disturbance(spec)


def _handle_list_disturbances(state: SiennaState, args: dict[str, Any]) -> Any:
    """The specs accepted since the last load or clear. A listing is a read:
    with no case loaded the truthful answer is an empty list, as
    ``_handle_list_keys`` answers."""
    try:
        return [spec.model_dump() for spec in state.list_disturbances()]
    except NoCaseLoadedError:
        return []


def _handle_clear_disturbances(state: SiennaState, args: dict[str, Any]) -> Any:
    state.clear_disturbances()
    return None


def _handle_run_tds(state: SiennaState, args: dict[str, Any], abort_event: Any) -> Any:
    return state.run_tds(
        tf=args["tf"],
        h=args.get("h"),
        load_model=args.get("load_model") or "impedance",
        abort_event=abort_event,
        integrator=args.get("integrator"),
        tds_config_overrides=args.get("tds_config_overrides"),
        dae_vars=args.get("dae_vars"),
        controllers=args.get("controllers"),
    )


def _handle_init_tds(state: SiennaState, args: dict[str, Any]) -> Any:
    return state.init_tds(test_init=args.get("test_init", True))


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
    "run_eig": _handle_run_eig,
    "eig_participation": _handle_eig_participation,
    "add_disturbance": _handle_add_disturbance,
    "list_disturbances": _handle_list_disturbances,
    "clear_disturbances": _handle_clear_disturbances,
    "init_tds": _handle_init_tds,
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
    if op == "run_tds":
        return _handle_run_tds(state, args, abort_event)
    return _HANDLERS[op](state, args)


def _warm_up() -> None:
    """Start the bridge and run a small case through load, topology and power
    flow, so the first op pays for neither Julia's start nor the compilation of
    the code paths it uses.

    The case is ANDES's own ``kundur.raw``, found without importing ANDES and
    copied into a temporary directory so the Julia session the warm-up opens is
    released with it and never becomes the user's case. When the file is not
    found, the warm-up only starts Julia, as before. Best effort: any failure
    is logged and ends the warm-up; the first op then reports the real error
    itself, as the ANDES warm-up treats one.
    """
    try:
        bridge = JuliaBridge()
        bridge.start()
        from tensa.core.examples import _andes_cases_dir

        cases = _andes_cases_dir()
        raw = cases / "kundur" / "kundur.raw" if cases is not None else None
        if raw is None or not raw.is_file():
            return
        # The warm-up case's own notes (its slack bus, its setpoints) are about a
        # case the user never opened, and the notice logger is what the worker's
        # capture hands to the first reply; so it is off while the case runs.
        # Julia can still hold a file of the folder open when it is removed,
        # which Windows refuses; that is no reason to call the warm-up failed.
        notices = logging.getLogger(NOTICE_LOGGER)
        was_disabled = notices.disabled
        notices.disabled = True
        try:
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
                copy = Path(tmp) / "kundur.raw"
                shutil.copyfile(raw, copy)
                state = SiennaState(
                    workspace=tmp, session_id="warmup", owner_pid=None, bridge=bridge
                )
                state.load_case(copy)
                state.topology()
                state.run_pflow()
        finally:
            notices.disabled = was_disabled
    except Exception as exc:  # noqa: BLE001 — warming is an optimisation
        log.warning(
            "could not warm Julia ahead of the first op (%s: %s); "
            "the first op will try again",
            exc.__class__.__name__,
            exc,
        )


def sienna_runtime() -> EngineRuntime:
    """The Sienna engine: a ``SiennaState`` per session, the thirteen ops."""
    return EngineRuntime(
        name="sienna",
        make_state=lambda workspace, session_id, owner_pid: SiennaState(
            workspace=workspace, session_id=session_id, owner_pid=owner_pid
        ),
        dispatch=_dispatch,
        warm_up=_warm_up,
    )
