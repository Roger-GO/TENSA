"""Pending disturbances of a Sienna session, in the neutral form of section
6.4 of ``design/multiengine/spec.md``.

The disturbance route's specs stay as they are; this module maps them onto the
neutral kinds the Sienna engine stores (a ``Fault`` on a bus is ``bus_fault``;
a ``Toggle`` on a line is ``branch_trip``, on a generator ``gen_trip``) and
refuses what it cannot map, naming what the engine takes. At the start of a
run the pending list becomes the JSON list ``tds_run_json`` takes, with bus
numbers and ids from the key book.
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
