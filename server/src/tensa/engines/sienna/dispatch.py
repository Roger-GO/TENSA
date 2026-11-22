"""The neutral result of a Sienna economic dispatch, from the dispatch JSON.

Pure Python, mirroring ``convert.py``'s contract: every function takes plain
mappings (the parsed JSON) and the key book. ``DispatchRequestError`` lives
here and not in ``tensa.core.errors`` because the unit's paths do not include
that module; it is the dispatch counterpart of ``PflowRequestError``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tensa.core.errors import AndesAppError, short_repr
from tensa.engines.keys import KeyBook
from tensa.engines.sienna.convert import _float, _int, _rows, _text

# The message of a case with no cost data. The Julia module
# (TensaSiennaOps.jl, NO_COST_DATA) throws the same string and the route maps
# it to 422; the two copies are pinned together by the route test, which
# sends this exact text through the worker.
NO_COST_DATA_MESSAGE = (
    "the case has no generator cost data; economic dispatch needs gencost records"
)

# The network models the engine takes.
NETWORK_MODELS = ("copper_plate", "dc", "ptdf", "ac")


class DispatchRequestError(AndesAppError):
    """A dispatch request the Sienna engine does not take, named for the user.

    An :class:`AndesAppError`, so the worker sends its class name as the
    error category (any other exception arrives as an internal error) and the
    route answers 422. Nothing has run when it is raised: the caller changes
    the request or the case.
    """

    recovery_kind: str | None = "none"


@dataclass
class DispatchGenerator:
    """One dispatched generator: its MW, bus and id, and its MVAr for AC."""

    p_mw: float
    bus: int
    id: str
    q_mvar: float | None = None


@dataclass
class DispatchBus:
    """One bus of an AC dispatch: voltage and angle."""

    v_pu: float
    bus: int
    angle_rad: float


@dataclass
class DispatchBranch:
    """One branch of an AC dispatch: flows at both ends and the losses."""

    from_bus: int
    to_bus: int
    ckt: str
    p_from_mw: float
    q_from_mvar: float
    p_to_mw: float
    q_to_mvar: float
    losses_mw: float
    losses_mvar: float


@dataclass
class DispatchResult:
    """The neutral result of one economic dispatch."""

    status: str
    network_model: str
    objective_per_h: float
    objective_check_per_h: float
    fixed_per_h: float
    base_mva: float
    total_load_mw: float
    total_dispatch_mw: float
    generators: dict[str, DispatchGenerator]
    buses: dict[str, DispatchBus]
    branches: dict[str, DispatchBranch]
    total_losses_mw: float | None
    duals: list[dict[str, Any]]
    slacks: list[dict[str, Any]]
    parameters: list[str]
    expressions: list[str]
    keys: dict[str, dict[str, str]]
    notes: list[str]


def dispatch_result(dispatch: dict[str, Any], book: KeyBook) -> DispatchResult:
    """The dispatch JSON as a :class:`DispatchResult`.

    ``generators`` is keyed by the PowerSystems component name (the idx), as
    ``pflow_result`` keys ``generator_outputs`` by name. ``buses`` and
    ``branches`` are keyed by the component name as well; they are empty for
    the lossless models, and ``total_losses_mw`` is ``None`` there. ``keys``
    has one entry per kind (``"generator"``, ``"bus"``, ``"branch"``): the
    key of each element the book holds, found by matching the book's entries'
    idx to the component names, so the conversion needs no topology JSON
    (unlike ``pflow_result``, which reads the kind from it). An element the
    book has no entry for is still in the result and simply has no key, the
    ``pflow_result`` behaviour for unmatched names.
    """
    generators: dict[str, DispatchGenerator] = {}
    for row in _rows(dispatch, "generators"):
        name = _text(row.get("name"))
        generators[name] = DispatchGenerator(
            p_mw=_float(row.get("p_mw")),
            bus=_int(row.get("bus")),
            id=_text(row.get("id")),
            q_mvar=None if row.get("q_mvar") is None else _float(row.get("q_mvar")),
        )
    buses: dict[str, DispatchBus] = {}
    for row in _rows(dispatch, "buses"):
        name = _text(row.get("name"))
        buses[name] = DispatchBus(
            v_pu=_float(row.get("v_pu")),
            bus=_int(row.get("bus")),
            angle_rad=_float(row.get("angle_rad")),
        )
    branches: dict[str, DispatchBranch] = {}
    for row in _rows(dispatch, "branches"):
        name = _text(row.get("name"))
        branches[name] = DispatchBranch(
            from_bus=_int(row.get("from")),
            to_bus=_int(row.get("to")),
            ckt=_text(row.get("ckt")),
            p_from_mw=_float(row.get("p_from_mw")),
            q_from_mvar=_float(row.get("q_from_mvar")),
            p_to_mw=_float(row.get("p_to_mw")),
            q_to_mvar=_float(row.get("q_to_mvar")),
            losses_mw=_float(row.get("losses_mw")),
            losses_mvar=_float(row.get("losses_mvar")),
        )
    # The key of each element the book holds, found by the component name,
    # which is the idx the book keys an element under. The bus and id of the
    # answer are not used: the Julia module reads the id off the name, which
    # for a MATPOWER generator ("gen-<row>") is the row, not the generator's
    # place on its bus.
    # The book keeps a bus under its number, and a branch under the
    # ``line`` or ``transformer`` bucket by its component name.
    key_by_idx: dict[str, dict[str, str]] = {"generator": {}, "bus": {}, "branch": {}}
    for entry in book.entries():
        bucket = "branch" if entry.bucket in ("line", "transformer") else entry.bucket
        if bucket in key_by_idx:
            key_by_idx[bucket][str(entry.idx)] = entry.key
    generator_keys = {name: key_by_idx["generator"][name] for name in generators if name in key_by_idx["generator"]}
    bus_keys = {
        name: key_by_idx["bus"][str(bus.bus)] for name, bus in buses.items() if str(bus.bus) in key_by_idx["bus"]
    }
    branch_keys = {name: key_by_idx["branch"][name] for name in branches if name in key_by_idx["branch"]}
    notes: list[str] = []
    for note in dispatch.get("notes", []):
        if isinstance(note, str):
            notes.append(note)
        elif isinstance(note, dict):
            notes.append(_text(note.get("text")))
    return DispatchResult(
        status=_text(dispatch.get("status")),
        network_model=_text(dispatch.get("network_model")),
        objective_per_h=_float(dispatch.get("objective_per_h")),
        objective_check_per_h=_float(dispatch.get("objective_check_per_h")),
        fixed_per_h=_float(dispatch.get("fixed_per_h")),
        base_mva=_float(dispatch.get("base_mva")),
        total_load_mw=_float(dispatch.get("total_load_mw")),
        total_dispatch_mw=_float(dispatch.get("total_dispatch_mw")),
        generators=generators,
        buses=buses,
        branches=branches,
        total_losses_mw=(
            None
            if dispatch.get("total_losses_mw") is None
            else _float(dispatch.get("total_losses_mw"))
        ),
        duals=[dict(row) for row in _rows(dispatch, "duals")],
        slacks=[dict(row) for row in _rows(dispatch, "slacks")],
        parameters=[_text(name) for name in dispatch.get("parameters", [])],
        expressions=[_text(name) for name in dispatch.get("expressions", [])],
        keys={"generator": generator_keys, "bus": bus_keys, "branch": branch_keys},
        notes=notes,
    )


def check_network_model(network_model: object) -> str:
    """The network model, validated; anything else is a :class:`DispatchRequestError`."""
    if network_model not in NETWORK_MODELS:
        raise DispatchRequestError(
            f"network_model must be copper_plate, dc, ptdf or ac, got "
            f"{short_repr(network_model)}"
        )
    return str(network_model)
