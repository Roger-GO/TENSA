"""Pending disturbances of a Sienna session, in the neutral form of section
6.4 of ``design/multiengine/spec.md``.

The disturbance route's specs stay as they are; this module maps them onto the
neutral kinds the Sienna engine stores (a ``Fault`` on a bus is ``bus_fault``;
a ``Toggle`` on a line is ``branch_trip``, on a generator ``gen_trip``) and
refuses what it cannot map, naming what the engine takes. At the start of a
run the pending list becomes the JSON list ``tds_run_json`` takes, with bus
numbers and ids from the key book.

It also holds the islanding check of spec section 4: a ``NetworkSwitch`` takes
a whole admittance matrix and PSID refuses one that splits the network, so a
branch trip that would island the system is refused here, before the run.
``islanded_buses`` is a pure function of the topology JSON; it imports no
Julia and no engine.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from tensa.core.disturbance import AlterSpec, FaultSpec, ToggleSpec
from tensa.core.errors import DisturbanceValidationError
from tensa.engines.keys import KeyBook

NeutralKind = Literal["branch_trip", "bus_fault", "gen_trip"]

# What a refusal names as the kinds the engine takes.
_TAKES = (
    "the Sienna engine takes a Fault on a bus, a Toggle on a Line "
    "(a branch trip) or on a generator (a generator trip)"
)

# How many bus numbers the islanding refusal lists before "and N more".
_LISTED_BUSES = 10


@dataclass(frozen=True)
class PendingDisturbance:
    """One disturbance a Sienna session holds for its next run.

    ``spec`` is the route's spec as accepted, so ``list_disturbances`` answers
    exactly what was posted, as the ANDES wrapper's log does. ``neutral`` is
    the section 6.4 form: ``kind``, the target's key (``bus`` for a fault),
    and the times and values on the system base.
    """

    spec: FaultSpec | ToggleSpec
    neutral: dict[str, Any]


def unit_key_of(book: KeyBook, bus: int, id: str) -> str | None:
    """The unit key (``gen:<bus>-<id>``) of the generator at ``bus`` with
    ``id``, or ``None`` when the book holds none.

    A machine entry's key is ``<unit key>/<role>``; the unit key is the part
    before the ``/``. Static generator entries (``PV``, ``Slack``) hold the
    unit key itself. The first entry found in assignment order wins.
    """
    wanted = f"gen:{bus}-{id}"
    for entry in book.entries():
        if entry.bucket != "generator" and not (
            entry.bucket == "dynamic" and entry.key.startswith(wanted + "/")
        ):
            continue
        if entry.bucket == "generator" and entry.key == wanted:
            return entry.key
        if entry.bucket == "dynamic":
            head, separator, _role = entry.key.partition("/")
            if separator and head == wanted:
                return head
    return None


def to_pending(
    spec: FaultSpec | ToggleSpec | AlterSpec, book: KeyBook
) -> PendingDisturbance:
    """Map one accepted spec to its neutral form.

    Raises :class:`DisturbanceValidationError` for what the Sienna engine does
    not take, with a message that names what it does take.
    """
    if isinstance(spec, FaultSpec):
        bus_key_found = book.key_of("Bus", spec.bus_idx)
        if bus_key_found is None:
            raise DisturbanceValidationError(
                f"the Sienna engine has no bus {spec.bus_idx!r} for the fault"
            )
        neutral: dict[str, Any] = {
            "kind": "bus_fault",
            "bus": bus_key_found,
            "t_on": spec.tf,
            "t_clear": spec.tc,
            "r_pu": spec.rf,
            "x_pu": spec.xf,
        }
        return PendingDisturbance(spec=spec, neutral=neutral)
    if isinstance(spec, ToggleSpec):
        if spec.model == "Line":
            branch_key_found = book.key_of("Line", spec.dev_idx)
            if branch_key_found is None:
                raise DisturbanceValidationError(
                    f"the Sienna engine has no branch {spec.dev_idx!r} for the toggle"
                )
            neutral = {"kind": "branch_trip", "target": branch_key_found, "t": spec.t}
            return PendingDisturbance(spec=spec, neutral=neutral)
        # A machine entry (``GENROU`` with idx ``generator-2-1/GENROU``) or
        # the static generator the toggle names (``PV`` or ``Slack``). The
        # first key found that is a generator's or a machine's wins; a key of
        # another bucket (a load, a shunt) is not a generator trip.
        key: str | None = None
        for model in (spec.model, "PV", "Slack"):
            candidate = book.key_of(model, spec.dev_idx)
            if candidate is None:
                continue
            entry = book.entry_of(candidate)
            if entry is not None and entry.bucket in ("dynamic", "generator"):
                key = candidate
                break
        if key is not None:
            unit_key = key.split("/", 1)[0]
            neutral = {"kind": "gen_trip", "target": unit_key, "t": spec.t}
            return PendingDisturbance(spec=spec, neutral=neutral)
        # A model that can name a generator (a static generator model, or a
        # dynamic-machine model the case holds) whose idx the book does not
        # hold is a toggle on a generator the case lacks. Any other model is
        # not a generator at all and is refused with what the engine takes.
        if spec.model in ("PV", "Slack") or any(
            entry.model == spec.model and entry.bucket == "dynamic"
            for entry in book.entries()
        ):
            raise DisturbanceValidationError(
                f"the Sienna engine has no generator {spec.dev_idx!r} for the toggle"
            )
        raise DisturbanceValidationError(
            f"{_TAKES}; it does not take a Toggle on {spec.model}"
        )
    raise DisturbanceValidationError(f"{_TAKES}; it does not take an Alter")


def _parse_branch_key(key: str) -> tuple[int, int, str] | None:
    """``branch:7-8-1`` to ``(7, 8, "1")``, else ``None``."""
    if not key.startswith("branch:"):
        return None
    parts = key[len("branch:") :].split("-", 2)
    if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
        return None
    return (int(parts[0]), int(parts[1]), parts[2])


def _parse_gen_key(key: str) -> tuple[int, str] | None:
    """``gen:1-1`` to ``(1, "1")``, else ``None``."""
    if not key.startswith("gen:"):
        return None
    parts = key[len("gen:") :].split("-", 1)
    if len(parts) != 2 or not parts[0].isdigit():
        return None
    return (int(parts[0]), parts[1])


def _parse_bus_key(key: str) -> int | None:
    """``bus:7`` to ``7``, else ``None``."""
    if not key.startswith("bus:"):
        return None
    text = key[len("bus:") :]
    return int(text) if text.isdigit() else None


def _components(
    buses: list[int], edges: list[tuple[int, int]]
) -> list[list[int]]:
    """The connected components of ``buses`` over ``edges``, each sorted, the
    largest first (ties by the smallest bus number)."""
    neighbours: dict[int, set[int]] = {bus: set() for bus in buses}
    for from_bus, to_bus in edges:
        if from_bus in neighbours and to_bus in neighbours:
            neighbours[from_bus].add(to_bus)
            neighbours[to_bus].add(from_bus)
    components: list[list[int]] = []
    unseen = set(buses)
    while unseen:
        start = min(unseen)
        component: list[int] = []
        stack = [start]
        unseen.discard(start)
        while stack:
            bus = stack.pop()
            component.append(bus)
            for neighbour in neighbours[bus]:
                if neighbour in unseen:
                    unseen.discard(neighbour)
                    stack.append(neighbour)
        components.append(sorted(component))
    components.sort(key=lambda part: (-len(part), part[0]))
    return components


def islanded_buses(
    topology: dict[str, Any], tripped: set[str]
) -> list[int]:
    """The buses the branch trips of ``tripped`` cut off from the largest
    component of the network, sorted, or the empty list.

    ``topology`` is the topology JSON the state holds: ``buses`` (each with
    its ``number``) and ``branches`` (each with ``from``, ``to``, ``ckt`` and
    ``available``). Only ``available`` branches connect buses. ``tripped``
    holds branch keys (``branch:<from>-<to>-<ckt>``); a key that parses and
    names a branch of the topology removes that branch, any other is ignored
    (the run's own checks refuse it). A branch already out of service
    (``available`` false) connects nothing, so tripping it changes nothing.
    """
    buses = [int(row["number"]) for row in topology.get("buses", [])]
    edges: list[tuple[int, int]] = []
    for branch in topology.get("branches", []):
        if not branch.get("available", True):
            continue
        from_bus = int(branch["from"])
        to_bus = int(branch["to"])
        ckt = str(branch.get("ckt", ""))
        if f"branch:{from_bus}-{to_bus}-{ckt}" in tripped:
            continue
        edges.append((from_bus, to_bus))
    components = _components(buses, edges)
    if len(components) <= 1:
        return []
    return [bus for part in components[1:] for bus in part]


def islanding_refusal(
    topology: dict[str, Any], pending_trips: set[str], new_trip: str
) -> str | None:
    """The refusal message for tripping ``new_trip`` with ``pending_trips``
    already held, or ``None`` when the trip splits nothing.

    The comparison is against the network with the pending trips alone, so a
    case whose file is already split is not refused for that, and two trips
    that together split the network refuse the second. The message names the
    branch key and the buses of the smallest new component (sorted, at most
    ten listed, then "and N more").
    """
    before = _components(
        [int(row["number"]) for row in topology.get("buses", [])],
        _available_edges(topology, pending_trips),
    )
    after = _components(
        [int(row["number"]) for row in topology.get("buses", [])],
        _available_edges(topology, pending_trips | {new_trip}),
    )
    if len(after) <= len(before):
        return None
    # The smallest component the new trip made: the last of the sorted list.
    cut_off = after[-1]
    listed = ", ".join(str(bus) for bus in cut_off[:_LISTED_BUSES])
    if len(cut_off) > _LISTED_BUSES:
        listed += f" and {len(cut_off) - _LISTED_BUSES} more"
    return (
        f"tripping {new_trip} islands the network: buses {listed} lose their "
        f"connection to the rest; PowerSimulationsDynamics cannot simulate a "
        f"network that splits, so the Sienna engine refuses it before the run"
    )


def _available_edges(
    topology: dict[str, Any], tripped: set[str]
) -> list[tuple[int, int]]:
    """The ends of the available branches with the trips of ``tripped``
    removed, as ``islanded_buses`` reads them."""
    edges: list[tuple[int, int]] = []
    for branch in topology.get("branches", []):
        if not branch.get("available", True):
            continue
        from_bus = int(branch["from"])
        to_bus = int(branch["to"])
        ckt = str(branch.get("ckt", ""))
        if f"branch:{from_bus}-{to_bus}-{ckt}" in tripped:
            continue
        edges.append((from_bus, to_bus))
    return edges


def run_json_entries(
    pending: list[PendingDisturbance], book: KeyBook
) -> list[dict[str, Any]]:
    """The ``disturbances`` list ``tds_run_json`` takes, in pending order.

    Keys become bus numbers and ids through ``book``. A key whose text does
    not parse, or that the book no longer holds (the case was reloaded under
    it; the run must not guess), raises :class:`DisturbanceValidationError`
    naming the key.
    """
    entries: list[dict[str, Any]] = []
    for item in pending:
        neutral = item.neutral
        kind = neutral["kind"]
        key = str(neutral.get("target") or neutral.get("bus"))
        parsed: dict[str, Any] | None = None
        if book.entry_of(key) is not None:
            if kind == "branch_trip":
                ends = _parse_branch_key(key)
                if ends is not None:
                    parsed = {
                        "kind": "branch_trip",
                        "from": ends[0],
                        "to": ends[1],
                        "ckt": ends[2],
                        "t": neutral["t"],
                    }
            elif kind == "gen_trip":
                address = _parse_gen_key(key)
                if address is not None:
                    parsed = {
                        "kind": "gen_trip",
                        "bus": address[0],
                        "id": address[1],
                        "t": neutral["t"],
                    }
            else:
                bus = _parse_bus_key(key)
                if bus is not None:
                    parsed = {
                        "kind": "bus_fault",
                        "bus": bus,
                        "t_on": neutral["t_on"],
                        "t_clear": neutral["t_clear"],
                        "r_pu": neutral["r_pu"],
                        "x_pu": neutral["x_pu"],
                    }
        if parsed is None:
            raise DisturbanceValidationError(
                f"the disturbance on {key} cannot be run: "
                "the case no longer holds it"
            )
        entries.append(parsed)
    return entries
