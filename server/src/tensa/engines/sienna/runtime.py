"""The Sienna engine's runtime: a handler table over ``SiennaState``.

Shaped like the worker's own table (``tensa.core.worker.HANDLERS``): each
handler takes the state and the op's args and answers the payload the worker
sends back, serialised with the worker's ``_serialize_dataclass``. The ops
are exactly the sixteen the engine has; an op outside the table is refused
by the worker before dispatch. ``run_tds`` is dispatched directly, as the
ANDES table special-cases it: it needs the abort event.
"""

from __future__ import annotations

import logging
import math
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import TypeAdapter

from tensa.core.disturbance import DisturbanceSpec
from tensa.core.errors import (
    AndesAppError,
    ElementNotFoundError,
    ElementValidationError,
    NoCaseLoadedError,
    SetupFailedError,
    short_repr,
)
from tensa.core.messages import NOTICE_LOGGER
from tensa.core.stream import run_tds_stream
from tensa.core.worker import _serialize_dataclass
from tensa.core.wrapper.results import TopologyEntry, TopologySnapshot
from tensa.engines.base import EngineRuntime, TdsStreamPlan
from tensa.engines.series_names import build_name
from tensa.engines.sienna.bridge import JuliaBridge
from tensa.engines.sienna.ext import SiennaExtSpec
from tensa.engines.sienna.state import SiennaState

log = logging.getLogger("tensa.sienna")

# The load models a dynamic run takes (spec section 6.3).
_LOAD_MODELS = ("impedance", "power", "as-case")

# The default ``vars`` the WebSocket route sends when the client named none;
# for a Sienna session it means "not given" and is accepted and ignored.
_WS_DEFAULT_VARS = ["bus_v", "gen_state"]


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


def _sienna_tds_stream_plan(state: SiennaState, args: dict[str, Any]) -> TdsStreamPlan:
    """The Sienna engine's column plan for one streaming run: neutral names
    (``<quantity>|<key>``), fixed when the run starts, from the bridge's
    ``dyn_plan``; ``collect`` copies the row the Julia callback delivers.
    """
    load_model = args.get("load_model") or "impedance"
    state._require_session()  # noqa: SLF001 - the runtime is the state's own layer
    plan_answer = state._require_bridge().dyn_plan(  # noqa: SLF001
        state._session, load_model=load_model  # noqa: SLF001
    )
    if not plan_answer.get("ready", False):
        raise SetupFailedError(str(plan_answer.get("reason", "the run cannot be built")))
    columns = plan_answer.get("columns", [])
    var_columns: list[str] = []
    for entry in columns:
        quantity = str(entry.get("quantity"))
        if entry.get("kind") == "bus":
            key = f"bus:{int(entry.get('bus', 0))}"
        else:
            key = f"gen:{int(entry.get('bus', 0))}-{entry.get('id', '')}"
        var_columns.append(build_name(quantity, key))

    def collect(t: float, values: Any) -> Any:
        n = len(values)
        if n != len(var_columns):
            raise AndesAppError(
                f"sienna on_step row has {n} values; the column plan has {len(var_columns)}"
            )
        # The Julia hook is called after the step it reports, at its time.
        return t, np.asarray(values, dtype=np.float64)

    return TdsStreamPlan(
        var_columns=var_columns,
        metadata_extra={"load_model": load_model, "vars": [], "dae_vars": []},
        collect=collect,
    )


def _handle_run_tds(
    state: SiennaState,
    args: dict[str, Any],
    abort_event: Any,
    data: Any = None,
    seq: Any = None,
) -> Any:
    """The Sienna ``run_tds``, batch or streamed.

    A batch request is the state's own run (``SiennaState.run_tds``), which
    refuses the options the engine does not have by name. A ``start_tds``
    frame for a Sienna session takes ``tf``, ``step`` (or
    ``h``, the wire's step field, mapped to the Julia ``dtmax``),
    ``load_model``, ``decimation`` and ``max_rate_hz``. Every other field the
    frame can carry (a non-default ``integrator`` or ``vars``,
    ``tds_config_overrides``, ``dae_vars``, ``controllers``) is refused by
    name before the run starts, so a refused run never opens a stream. The
    route always sends ``integrator`` and ``vars``; their schema defaults
    (``"trapezoidal"``, ``["bus_v", "gen_state"]``) mean "the client named
    nothing" and are accepted and ignored.
    """
    if not args.get("stream"):
        # The batch run is the state's own (P5-A): the dispatch passes the
        # abort event through, as the ANDES table's special case does.
        ext_raw = args.get("ext_sienna")
        ext = SiennaExtSpec.model_validate(ext_raw) if ext_raw is not None else None
        return _serialize_dataclass(
            state.run_tds(
                tf=args["tf"],
                h=args.get("h") if args.get("h") is not None else args.get("step"),
                load_model=args.get("load_model") or "impedance",
                ext_sienna=ext,
                abort_event=abort_event,
                integrator=args.get("integrator"),
                tds_config_overrides=args.get("tds_config_overrides"),
                dae_vars=args.get("dae_vars"),
                controllers=args.get("controllers"),
            )
        )
    if data is None or seq is None:
        raise AndesAppError(
            "streaming mode requires data_pipe + seq context (worker bug)"
        )

    integrator = args.get("integrator")
    if integrator is not None and integrator != "trapezoidal":
        raise AndesAppError(
            "sienna tds has no integrator selection; the solver is IDA on the "
            "ResidualModel (ext.sienna.solver in a study)"
        )
    if args.get("tds_config_overrides") is not None:
        raise AndesAppError(
            "tds_config_overrides is an ANDES feature; sienna takes ext.sienna "
            "options in a study"
        )
    vars_raw = args.get("vars")
    if vars_raw is not None and vars_raw != [] and vars_raw != _WS_DEFAULT_VARS:
        raise AndesAppError(
            "var groups are ANDES columns; a sienna stream always carries its "
            "neutral column plan"
        )
    if args.get("dae_vars"):
        raise AndesAppError("dae_vars are ANDES variable names; a sienna stream has none")
    if args.get("controllers"):
        raise AndesAppError("droop and ffr controllers are ANDES-only")
    if args.get("ext_sienna") is not None:
        raise AndesAppError("ext.sienna is not taken on a streamed run yet; run it batch")
    h = args.get("h")
    step = args.get("step")
    if h is not None and step is not None:
        raise AndesAppError("name only one of 'h' and 'step'")
    if step is None:
        step = h
    if step is not None:
        if (
            isinstance(step, bool)
            or not isinstance(step, int | float)
            or not math.isfinite(float(step))
            or float(step) <= 0
        ):
            raise AndesAppError(
                f"step must be a finite number of seconds above 0, got {short_repr(step)}"
            )
        step = float(step)
    tf_raw = args.get("tf")
    if (
        isinstance(tf_raw, bool)
        or not isinstance(tf_raw, int | float)
        or not math.isfinite(float(tf_raw))
        or float(tf_raw) <= 0
    ):
        raise AndesAppError(
            f"tf must be a finite number of seconds above 0, got {short_repr(tf_raw)}"
        )
    tf = float(tf_raw)
    load_model = args.get("load_model") or "impedance"
    if load_model not in _LOAD_MODELS:
        raise AndesAppError(
            f"unknown load_model {short_repr(load_model)}; expected 'impedance', "
            "'power' or 'as-case'"
        )
    decimation_raw = args.get("decimation") or "none"
    if decimation_raw not in ("none", "mean"):
        raise AndesAppError(
            f"unknown decimation mode: {decimation_raw!r}; expected 'none' or 'mean'"
        )
    max_rate_hz_raw = args.get("max_rate_hz")
    max_rate_hz = float(max_rate_hz_raw) if max_rate_hz_raw is not None else None

    plan = _sienna_tds_stream_plan(state, args)

    def _run(on_step: Any) -> Any:
        # Polarity: the driver's callback returns True to stop; the bridge's
        # callable must return False to Julia to stop (P5-A's contract), so the
        # adapter negates it.
        return state.run_tds(
            tf=tf,
            h=step,
            load_model=load_model,
            abort_event=None,
            on_step=lambda t, values: not on_step(t, values),
        )

    try:
        result = run_tds_stream(
            plan=plan,
            run=_run,
            abort_event=abort_event,
            data_pipe=data,
            seq=seq,
            decimation=decimation_raw,  # type: ignore[arg-type]
            max_rate_hz=max_rate_hz,
            # IDA is variable-step, so a mean decimation is honestly best-effort.
            fixed_step=False,
        )
    except ValueError as exc:
        raise AndesAppError(str(exc)) from exc
    finally:
        # As after a batch run: the abort is spent by the run it stopped,
        # however the run ended.
        abort_event.clear()

    payload = _serialize_dataclass(result)
    # The rows went out frame by frame; the end of a stream carries the summary
    # only, as an ANDES stream's does.
    payload.pop("traces", None)
    payload.pop("post", None)
    return payload


def _handle_init_tds(state: SiennaState, args: dict[str, Any]) -> Any:
    return state.init_tds(test_init=args.get("test_init", True))


def _handle_network_matrix(state: SiennaState, args: dict[str, Any]) -> Any:
    return state.network_matrix(args["kind"])


# ANDES param name -> (neutral field, per unit on the system base), by model.
_ADD_PARAMS: dict[str, dict[str, tuple[str, bool]]] = {
    "PQ": {"bus": ("bus", False), "p0": ("p_mw", True), "q0": ("q_mvar", True), "u": ("in_service", False)},
    "Shunt": {"bus": ("bus", False), "g": ("g_mw", True), "b": ("b_mvar", True), "u": ("in_service", False)},
}
_EDIT_PARAMS: dict[str, dict[str, tuple[str, bool]]] = {
    "PQ": {"p0": ("p_mw", True), "q0": ("q_mvar", True), "u": ("in_service", False)},
    "PV": {"p0": ("p_mw", True), "v0": ("v_set_pu", False), "u": ("in_service", False)},
    "Slack": {"p0": ("p_mw", True), "v0": ("v_set_pu", False), "u": ("in_service", False)},
    "Line": {"u": ("in_service", False)},
    "Shunt": {"g": ("g_mw", True), "b": ("b_mvar", True), "u": ("in_service", False)},
}

# The neutral kind each addable model maps to.
_ADD_KINDS = {"PQ": "load", "Shunt": "shunt"}


def _neutral_fields(
    state: SiennaState,
    model: str,
    params: dict[str, Any],
    table: dict[str, dict[str, tuple[str, bool]]],
) -> dict[str, Any]:
    """Map ANDES param names to neutral fields, converting per-unit values
    with the system base. A param the model's table does not hold is refused
    by name."""
    mapping = table.get(model, {})
    base = state.base_mva()
    out: dict[str, Any] = {}
    for name, value in params.items():
        held = mapping.get(name)
        if held is None:
            allowed = ", ".join(sorted(mapping))
            raise ElementValidationError(
                f"the Sienna engine does not take {model} param {name!r}; it takes {allowed}"
            )
        field, per_unit = held
        if field == "in_service":
            if value not in (0, 1, True, False):
                raise ElementValidationError(f"u must be 0 or 1; got {value!r}")
            out[field] = bool(int(value))
        elif field == "bus":
            out[field] = value
        elif per_unit:
            out[field] = float(value) * base
        else:
            out[field] = float(value)
    return out


def _key_of(state: SiennaState, model: str, idx: Any) -> str:
    """The key of the element the route names, or a 404."""
    key = state.keys().key_of(model, idx)
    if key is None:
        raise ElementNotFoundError(f"no {model} with idx={idx!r}")
    return key


def _entries(snapshot: TopologySnapshot) -> list[TopologyEntry]:
    """Every element entry of a topology, in its lists' order."""
    return [
        *snapshot.buses,
        *snapshot.lines,
        *snapshot.transformers,
        *snapshot.generators,
        *snapshot.loads,
        *snapshot.shunts,
        *snapshot.controllers,
    ]


def _entry_of(snapshot: TopologySnapshot, model: str, idx: Any) -> TopologyEntry:
    """The entry the element routes name by ``model`` and ``idx``."""
    for entry in _entries(snapshot):
        if entry.kind == model and str(entry.idx) == str(idx):
            return entry
    raise ElementNotFoundError(f"no {model} with idx={idx!r}")


def _handle_add_element(state: SiennaState, args: dict[str, Any]) -> Any:
    """The added element's topology entry, as the route answers it (the
    ANDES engine's ``add_element`` answers the same)."""
    model = str(args["model"])
    kind = _ADD_KINDS.get(model)
    if kind is None:
        raise ElementValidationError(
            f"the Sienna engine adds a load or a shunt; got model {model!r}"
        )
    fields = _neutral_fields(state, model, dict(args["params"]), _ADD_PARAMS)
    before = {(entry.kind, str(entry.idx)) for entry in _entries(state.topology())}
    after = state.add_element(kind, fields)
    added = [e for e in _entries(after) if (e.kind, str(e.idx)) not in before]
    if len(added) != 1:
        raise ElementValidationError(f"the add changed {len(added)} entries of the topology, not one")
    return _serialize_dataclass(added[0])


def _handle_edit_element(state: SiennaState, args: dict[str, Any]) -> Any:
    model = str(args["model"])
    params = dict(args["params"])
    if len(params) != 1:
        raise ElementValidationError(
            f"the Sienna engine edits one field at a time; got {sorted(params)}"
        )
    key = _key_of(state, model, args["idx"])
    fields = _neutral_fields(state, model, params, _EDIT_PARAMS)
    field, value = next(iter(fields.items()))
    # The edited element's entry, as the route answers it.
    return _serialize_dataclass(_entry_of(state.edit_element(key, field, value), model, args["idx"]))


def _handle_delete_element(state: SiennaState, args: dict[str, Any]) -> Any:
    if args.get("cascade"):
        raise ElementValidationError(
            "the Sienna engine does not cascade a delete: "
            "a load or a shunt has no dependents"
        )
    model = str(args["model"])
    key = _key_of(state, model, args["idx"])
    gone = _entry_of(state.topology(), model, args["idx"])
    # The new topology with what went beside it, as the ANDES engine answers;
    # a load or a shunt takes no disturbance with it.
    payload: dict[str, Any] = _serialize_dataclass(state.delete_element(key))
    payload["deleted"] = [_serialize_dataclass(gone)]
    payload["disturbances"] = []
    return payload


def _handle_undo_last_edit(state: SiennaState, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(state.undo_last_edit())


def _handle_redo_edit(state: SiennaState, args: dict[str, Any]) -> Any:
    return _serialize_dataclass(state.redo_edit())
def _handle_run_dispatch(state: SiennaState, args: dict[str, Any]) -> Any:
    # A missing network_model reaches the state's validation as None, which it
    # refuses by name, as a missing pflow method is handled there.
    return _serialize_dataclass(
        state.run_dispatch(
            network_model=args.get("network_model"),
            duals=bool(args.get("duals", False)),
        )
    )


def _handle_run_uc(state: SiennaState, args: dict[str, Any]) -> Any:
    # Missing fields reach the state's validation as None, which it refuses
    # by name, as a missing network_model is handled there.
    return _serialize_dataclass(
        state.run_uc(
            network_model=args.get("network_model"),
            horizon_h=args.get("horizon_h"),
            resolution_min=args.get("resolution_min"),
            series=args.get("series"),
            overrides=args.get("overrides"),
        )
    )


def _handle_run_sim(state: SiennaState, args: dict[str, Any]) -> Any:
    # A missing load_profile reaches the state's validation as None, which it
    # refuses by name, as a missing network_model is handled there.
    return _serialize_dataclass(
        state.run_sim(
            load_profile=args.get("load_profile"),
            network_model=args.get("network_model", "copper_plate"),
        )
    )


def _handle_fidelity(state: SiennaState, args: dict[str, Any]) -> Any:
    """The fidelity entries of the loaded case. With no case loaded the
    state's :class:`NoCaseLoadedError` propagates, as ``topology``'s does."""
    from tensa.engines.fidelity import fidelity_entries

    topology, report, _document, _identity, _book, _path, _addfiles = (
        state.case_document_parts()
    )
    return fidelity_entries(
        "sienna",
        list(topology.get("dynamics", [])),
        list((report or {}).get("unsupported", [])),
    )


def _handle_case_document(state: SiennaState, args: dict[str, Any]) -> Any:
    """The neutral case document of the loaded case. With no case loaded the
    state's :class:`NoCaseLoadedError` propagates, as ``topology``'s does."""
    from tensa.engines.sienna.case_doc import build_case_document

    topology, report, document, identity, book, case_path, addfiles = (
        state.case_document_parts()
    )
    return build_case_document(
        topology, report, document, identity, book, case_path, addfiles
    ).model_dump(mode="json", by_alias=True)


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
    "fidelity": _handle_fidelity,
    "run_pflow": _handle_run_pflow,
    "list_keys": _handle_list_keys,
    "network_matrix": _handle_network_matrix,
    "run_eig": _handle_run_eig,
    "eig_participation": _handle_eig_participation,
    "add_disturbance": _handle_add_disturbance,
    "list_disturbances": _handle_list_disturbances,
    "clear_disturbances": _handle_clear_disturbances,
    "init_tds": _handle_init_tds,
    "case_document": _handle_case_document,
    "add_element": _handle_add_element,
    "edit_element": _handle_edit_element,
    "delete_element": _handle_delete_element,
    "undo_last_edit": _handle_undo_last_edit,
    "redo_edit": _handle_redo_edit,
    "run_dispatch": _handle_run_dispatch,
    "run_uc": _handle_run_uc,
    "run_sim": _handle_run_sim,
}


def _dispatch(
    state: Any,
    op: str,
    args: dict[str, Any],
    abort_event: Any,
    data: Any,
    seq: Any,
) -> Any:
    """Answer one op on a ``SiennaState``. ``run_tds`` is special-cased, as the
    worker's ANDES dispatch special-cases it: it needs the abort event, the
    data pipe and the seq."""
    if op == "run_tds":
        return _handle_run_tds(state, args, abort_event, data, seq)
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
    """The Sienna engine: a ``SiennaState`` per session, the ops table."""
    return EngineRuntime(
        name="sienna",
        make_state=lambda workspace, session_id, owner_pid: SiennaState(
            workspace=workspace, session_id=session_id, owner_pid=owner_pid
        ),
        dispatch=_dispatch,
        warm_up=_warm_up,
    )
