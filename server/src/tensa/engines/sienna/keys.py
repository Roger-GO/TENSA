"""Assign keys to the elements of a case from the Sienna topology JSON.

Section 4 of ``design/multiengine/spec.md``: this module does for the Sienna
engine what ``tensa.engines.andes.keys`` does for ANDES, from the parsed JSON
the Julia module answers instead of a live System, and must reach the same
keys. PowerSystems keeps the ids of a PSS/E file but not its order, and gives
a MATPOWER branch the row number of the file's branch matrix as its circuit,
so the identity read from the case file (``tensa.engines.identity``) supplies
the circuit ids, the device ids and the bus order of a branch.

Branches, generators and loads are matched to the identity per unordered bus
pair or per bus, by three rules: by id when the JSON's ids and the file's are
the same set (PSS/E); in order when only the counts agree (MATPOWER, where
the JSON's ids are row numbers); otherwise each JSON element whose id the file
gives on that pair or bus takes that record (PSS/E only, since a MATPOWER row
number is no id), and the rest take an ordinal. Shunts, which PowerSystems
numbers by a running count, are matched in order, fixed ones before switched
ones. An ordinal is the first one on the bus or bus pair that the file does
not give there and whose key no element of the book holds (decision 28), so
it never reaches the ``~N`` suffix of ``KeyBook.assign``. The elements given
an ordinal the first time a case is keyed are counted in one problem note per
kind. An element already in the book keeps its key.

This module imports no engine: every input is a plain mapping.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from typing import Any

from tensa.engines.identity import CaseIdentity
from tensa.engines.keys import (
    KeyBook,
    KeyEntry,
    branch_key,
    bus_key,
    generator_key,
    load_key,
    shunt_key,
    unit_model_key,
)
from tensa.engines.roles import role_of_model


@dataclass(frozen=True)
class _Item:
    """One element of the JSON: its handle ``(model, idx)``, its id or circuit
    as the JSON gives it, its bucket and its place in the JSON (which keeps
    two items with equal fields apart)."""

    model: str
    idx: str
    id: str
    bucket: str
    row: int


def _rows(document: Mapping[str, Any], name: str) -> list[Mapping[str, Any]]:
    """The rows under ``name``, or ``[]``."""
    value = document.get(name)
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, Mapping)]


def _text(value: Any) -> str:
    """``value`` as stripped text (``""`` for ``None``)."""
    if value is None:
        return ""
    return str(value).strip()


def _int(value: Any) -> int:
    """A bus number as an int (a whole float or numeric text is read too)."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return int(float(_text(value)))


def _id_of(row: Mapping[str, Any], field: str) -> str:
    """The id or circuit of a row as text, ``"1"`` when it is empty."""
    return _text(row.get(field)) or "1"


def _is_integer(text: str) -> bool:
    """Whether ``text`` reads as an integer."""
    try:
        int(text)
    except ValueError:
        return False
    return True


def _match(
    items: Sequence[_Item], file_ids: Sequence[str], by_id_fallback: bool
) -> dict[_Item, int]:
    """The position in ``file_ids`` each item of one bus or bus pair takes.

    ``file_ids`` are the identity's ids there, in file order. When the ids are
    the same set, each once on both sides: by id. When the counts agree: in
    order, the items sorted by id, by value when every id is an integer (a
    MATPOWER row number, so ``"2"`` comes before ``"10"``), else as text.
    Otherwise, when ``by_id_fallback``, each item in JSON order takes the
    first record not yet taken whose id is its own; an item left out of the
    answer takes an ordinal.
    """
    if not items or not file_ids:
        return {}
    json_ids = [item.id for item in items]
    if (
        set(json_ids) == set(file_ids)
        and len(set(json_ids)) == len(json_ids)
        and len(set(file_ids)) == len(file_ids)
    ):
        position_of = {text: position for position, text in enumerate(file_ids)}
        return {item: position_of[item.id] for item in items}
    if len(items) == len(file_ids):
        if all(_is_integer(text) for text in json_ids):
            ordered = sorted(items, key=lambda item: (int(item.id), item.row))
        else:
            ordered = sorted(items, key=lambda item: (item.id, item.row))
        return {item: position for position, item in enumerate(ordered)}
    matched: dict[_Item, int] = {}
    if by_id_fallback:
        free = list(range(len(file_ids)))
        for item in items:
            for position in free:
                if file_ids[position] == item.id:
                    free.remove(position)
                    matched[item] = position
                    break
    return matched


def _first_free(
    book: KeyBook, makers: Sequence[Callable[[str], str]], reserved: set[str]
) -> str:
    """The first ordinal, from ``"1"``, not in ``reserved`` whose key, as each
    of ``makers`` writes it, no element of ``book`` holds."""
    ordinal = 1
    while str(ordinal) in reserved or any(
        book.entry_of(make(str(ordinal))) is not None for make in makers
    ):
        ordinal += 1
    return str(ordinal)


def _place(
    book: KeyBook,
    item: _Item,
    file_key: str | None,
    first_keying: bool,
    makers: Sequence[Callable[[str], str]],
    reserved: set[str],
) -> bool:
    """Key one item; ``True`` when it took an ordinal on the first keying.

    An item the book holds keeps its key. A file key is taken on the first
    keying even when another element holds it (the file's own clash, which
    the book stores with a suffix and a note, so the fault is seen); later it
    is taken only while it is free, and an item whose file key is held (an
    element of the file deleted and another added in its place) takes an
    ordinal. The ordinal key is ``makers[0]`` of the first ordinal that is not
    in ``reserved`` and whose key, as each of ``makers`` writes it, is free.
    """
    if book.has(item.model, item.idx):
        return False
    if file_key is not None and (first_keying or book.entry_of(file_key) is None):
        book.assign(KeyEntry(file_key, item.bucket, item.model, item.idx, "file"))
        return False
    key = makers[0](_first_free(book, makers, reserved))
    book.assign(KeyEntry(key, item.bucket, item.model, item.idx, "ordinal"))
    return first_keying


def _assign_buses(topology: Mapping[str, Any], book: KeyBook) -> None:
    """Key every bus by its number, handle ``("Bus", number)``."""
    for row in _rows(topology, "buses"):
        number = _int(row["number"])
        book.assign(KeyEntry(bus_key(number), "bus", "Bus", number, "engine"))


def _branch_bucket(row: Mapping[str, Any]) -> str:
    """``"transformer"`` or ``"line"``, as the JSON's ``kind`` says."""
    return "transformer" if row.get("kind") == "transformer" else "line"


def _branch_ends(key: str) -> tuple[int, int] | None:
    """The ``(from, to)`` of a ``branch:<from>-<to>-<ckt>`` key, else ``None``."""
    if not key.startswith("branch:"):
        return None
    parts = key[len("branch:"):].split("-", 2)
    if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
        return None
    return (int(parts[0]), int(parts[1]))


def _assign_branches(
    topology: Mapping[str, Any], identity: CaseIdentity | None, book: KeyBook
) -> None:
    """Key every branch, handle ``("Line", name)``, matched to the identity's
    branch records per unordered bus pair.

    A matched branch takes the record's bus order and circuit, source
    ``"file"``. One that is not takes the first circuit of the pair that the
    file does not give it and no branch of the book holds in either bus
    order, source ``"ordinal"``. It is written in the bus order the pair
    already has in the book (as the ANDES assigner writes an added parallel
    circuit), else in the order the file gives the pair (section 4 of the
    specification: ends in the order the case gives them), else in the
    JSON's own. Without an identity the JSON's own ``from``, ``to`` and
    ``ckt`` are used, source ``"engine"``.
    """
    rows = _rows(topology, "branches")
    if identity is None:
        for row in rows:
            book.assign(
                KeyEntry(
                    branch_key(_int(row["from"]), _int(row["to"]), _id_of(row, "ckt")),
                    _branch_bucket(row),
                    "Line",
                    _text(row.get("name")),
                    "engine",
                )
            )
        return

    first_keying = not any(entry.model == "Line" for entry in book.entries())
    by_pair: dict[tuple[int, int], list[tuple[_Item, tuple[int, int]]]] = {}
    for position, row in enumerate(rows):
        ends = (_int(row["from"]), _int(row["to"]))
        item = _Item(
            "Line", _text(row.get("name")), _id_of(row, "ckt"), _branch_bucket(row), position
        )
        by_pair.setdefault((min(ends), max(ends)), []).append((item, ends))
    records: dict[tuple[int, int], list[tuple[int, int, str]]] = {}
    for branch in identity.branches:
        pair = (min(branch.from_bus, branch.to_bus), max(branch.from_bus, branch.to_bus))
        records.setdefault(pair, []).append((branch.from_bus, branch.to_bus, branch.ckt))
    oriented: dict[tuple[int, int], tuple[int, int]] = {}
    for entry in book.entries():
        held = _branch_ends(entry.key) if entry.model == "Line" else None
        if held is not None:
            oriented.setdefault((min(held), max(held)), held)
    by_id_fallback = identity.format != "matpower"

    ordinals = 0
    for pair, pair_items in by_pair.items():
        pair_records = records.get(pair, [])
        file_ckts = [ckt for _, _, ckt in pair_records]
        matched = _match([item for item, _ in pair_items], file_ckts, by_id_fallback)
        # Matched branches first, so an ordinal is written in the bus order
        # the file gives the pair.
        for item, ends in sorted(pair_items, key=lambda pair_item: pair_item[0] not in matched):
            taken = matched.get(item)
            file_key = branch_key(*pair_records[taken]) if taken is not None else None
            first, second = oriented.get(pair, pair_records[0][:2] if pair_records else ends)
            makers = (partial(branch_key, first, second), partial(branch_key, second, first))
            if _place(book, item, file_key, first_keying, makers, set(file_ckts)):
                ordinals += 1
            stored = book.key_of(item.model, item.idx)
            held = _branch_ends(stored) if stored is not None else None
            if held is not None:
                oriented.setdefault(pair, held)
    if ordinals > 0:
        book.problems.append(
            f"{ordinals} branch(es) of the Sienna topology matched no branch "
            "record of the case file; circuits assigned by ordinal"
        )


def _assign_on_buses(
    book: KeyBook,
    items_on_bus: Mapping[int, list[_Item]],
    file_ids_on_bus: Mapping[int, list[str]],
    make_key: Callable[[int, str], str],
    by_id_fallback: bool,
    first_keying: bool,
    note_kind: str,
) -> None:
    """Key the items of each bus against the identity's ids on that bus by the
    three rules of ``_match``; an item left over takes the first ordinal on
    its bus that the file does not give there and no element holds."""
    ordinals = 0
    for bus, items in items_on_bus.items():
        file_ids = file_ids_on_bus.get(bus, [])
        matched = _match(items, file_ids, by_id_fallback)
        for item in sorted(items, key=lambda item: item not in matched):
            taken = matched.get(item)
            file_key = make_key(bus, file_ids[taken]) if taken is not None else None
            makers = (partial(make_key, bus),)
            if _place(book, item, file_key, first_keying, makers, set(file_ids)):
                ordinals += 1
    if ordinals > 0:
        book.problems.append(
            f"{ordinals} {note_kind}(s) of the Sienna topology matched no record "
            "of the case file; ids assigned by ordinal"
        )


def _assign_generators(
    topology: Mapping[str, Any], identity: CaseIdentity | None, book: KeyBook
) -> None:
    """Key the static generators, handle ``(kind, name)`` with ``kind`` the
    JSON's (``"Slack"`` or ``"PV"``)."""
    items_on_bus: dict[int, list[_Item]] = {}
    for position, row in enumerate(_rows(topology, "generators")):
        item = _Item(
            _text(row.get("kind")) or "PV",
            _text(row.get("name")),
            _id_of(row, "id"),
            "generator",
            position,
        )
        bus = _int(row["bus"])
        if identity is None:
            book.assign(
                KeyEntry(generator_key(bus, item.id), "generator", item.model, item.idx, "engine")
            )
            continue
        items_on_bus.setdefault(bus, []).append(item)
    if identity is None:
        return
    file_ids: dict[int, list[str]] = {}
    for device in identity.generators:
        file_ids.setdefault(device.bus, []).append(device.id)
    first_keying = not any(entry.model in ("PV", "Slack") for entry in book.entries())
    _assign_on_buses(
        book,
        items_on_bus,
        file_ids,
        generator_key,
        identity.format != "matpower",
        first_keying,
        "generator",
    )


def _assign_loads(
    topology: Mapping[str, Any], identity: CaseIdentity | None, book: KeyBook
) -> None:
    """Key the loads, handle ``("PQ", name)``."""
    items_on_bus: dict[int, list[_Item]] = {}
    for position, row in enumerate(_rows(topology, "loads")):
        item = _Item("PQ", _text(row.get("name")), _id_of(row, "id"), "load", position)
        bus = _int(row["bus"])
        if identity is None:
            book.assign(KeyEntry(load_key(bus, item.id), "load", "PQ", item.idx, "engine"))
            continue
        items_on_bus.setdefault(bus, []).append(item)
    if identity is None:
        return
    file_ids: dict[int, list[str]] = {}
    for device in identity.loads:
        file_ids.setdefault(device.bus, []).append(device.id)
    first_keying = not any(entry.model == "PQ" for entry in book.entries())
    _assign_on_buses(
        book,
        items_on_bus,
        file_ids,
        load_key,
        identity.format != "matpower",
        first_keying,
        "load",
    )


def _assign_shunts(
    topology: Mapping[str, Any], identity: CaseIdentity | None, book: KeyBook
) -> None:
    """Key the shunts, handle ``("Shunt", name)``.

    PowerSystems numbers shunts by a running count (``order``), not by the
    file's id. Per bus, the JSON's shunts sorted fixed ones first and by
    ``order`` are matched in order with the identity's fixed then switched
    shunts of that bus when the counts agree. When they do not, the fixed ones
    are matched in order with the identity's fixed ones and the switched ones
    with its switched ones, as far as each goes, and a shunt left over takes
    the first ordinal on its bus that no shunt of the file and no element of
    the book holds (decision 28: never a letter, never a ``~`` suffix).
    Without an identity a shunt's id is its ``order``, source ``"engine"``.
    """
    rows = _rows(topology, "shunts")
    if identity is None:
        for row in rows:
            book.assign(
                KeyEntry(
                    shunt_key(_int(row["bus"]), _id_of(row, "order")),
                    "shunt",
                    "Shunt",
                    _text(row.get("name")),
                    "engine",
                )
            )
        return

    def order(row: Mapping[str, Any]) -> float:
        try:
            return float(row.get("order", 0))
        except (TypeError, ValueError):
            return 0.0

    on_bus: dict[int, list[tuple[bool, float, _Item]]] = {}
    for position, row in enumerate(rows):
        switched = row.get("kind") == "switched"
        item = _Item("Shunt", _text(row.get("name")), _id_of(row, "order"), "shunt", position)
        on_bus.setdefault(_int(row["bus"]), []).append((switched, order(row), item))
    fixed_ids: dict[int, list[str]] = {}
    for device in identity.fixed_shunts:
        fixed_ids.setdefault(device.bus, []).append(device.id)
    switched_ids: dict[int, list[str]] = {}
    for device in identity.switched_shunts:
        switched_ids.setdefault(device.bus, []).append(device.id)
    first_keying = not any(entry.model == "Shunt" for entry in book.entries())

    ordinals = 0
    for bus, shunts in on_bus.items():
        shunts.sort(key=lambda shunt: (shunt[0], shunt[1], shunt[2].row))
        file_fixed = fixed_ids.get(bus, [])
        file_switched = switched_ids.get(bus, [])
        file_all = [*file_fixed, *file_switched]
        matched: dict[_Item, str] = {}
        if len(shunts) == len(file_all):
            matched = {item: text for (_, _, item), text in zip(shunts, file_all, strict=True)}
        else:
            fixed = [item for switched, _, item in shunts if not switched]
            switched_items = [item for switched, _, item in shunts if switched]
            matched.update(zip(fixed, file_fixed, strict=False))
            matched.update(zip(switched_items, file_switched, strict=False))
        for _, _, item in sorted(shunts, key=lambda shunt: shunt[2] not in matched):
            text = matched.get(item)
            file_key = shunt_key(bus, text) if text is not None else None
            makers = (partial(shunt_key, bus),)
            if _place(book, item, file_key, first_keying, makers, set(file_all)):
                ordinals += 1
    if ordinals > 0:
        book.problems.append(
            f"{ordinals} shunt(s) of the Sienna topology matched no record "
            "of the case file; ids assigned by ordinal"
        )


def _assign_dynamics(topology: Mapping[str, Any], book: KeyBook) -> None:
    """Key the dynamic records, handle ``(model, "<generator>/<model>")``.

    The unit is the key of the static generator the record's ``generator``
    names; the role is ``role_of_model(model)``. As the ANDES assigner does,
    a second model of one role on a unit takes the key qualified with the
    model name (``gen:1-1/exciter:SEXS``), and one more of the same model the
    same with ``-2``, ``-3``, ... the first that is free, without a problem
    note. A record whose generator has no key is noted and left out.
    """
    for row in _rows(topology, "dynamics"):
        model = _text(row.get("model"))
        generator = _text(row.get("generator"))
        if not model or not generator:
            continue
        idx = f"{generator}/{model}"
        if book.has(model, idx):
            continue
        unit_key = book.key_of("Slack", generator) or book.key_of("PV", generator)
        if unit_key is None:
            book.problems.append(
                f"dynamic record {model} of {generator} names a generator "
                "the topology does not hold; no key assigned"
            )
            continue
        role = role_of_model(model)
        key = unit_model_key(unit_key, role)
        if book.entry_of(key) is not None:
            key = unit_model_key(unit_key, role, model)
            if book.entry_of(key) is not None:
                suffix = 2
                while book.entry_of(f"{key}-{suffix}") is not None:
                    suffix += 1
                key = f"{key}-{suffix}"
        book.assign(KeyEntry(key, "dynamic", model, idx, "engine"))


def assign_sienna_keys(
    topology: Mapping[str, Any],
    identity: CaseIdentity | None,
    book: KeyBook | None = None,
) -> KeyBook:
    """Assign a key to every element of the Sienna ``topology`` JSON.

    ``identity`` is what ``tensa.engines.identity.read_identity`` gave for the
    file the case was loaded from, or ``None``. An element already in ``book``
    keeps its entry: calling twice changes nothing and notes no problem twice.
    The inputs are not changed.
    """
    if book is None:
        book = KeyBook()
    noted = len(book.problems)
    _assign_buses(topology, book)
    _assign_branches(topology, identity, book)
    _assign_generators(topology, identity, book)
    _assign_loads(topology, identity, book)
    _assign_shunts(topology, identity, book)
    _assign_dynamics(topology, book)
    seen = set(book.problems[:noted])
    fresh: list[str] = []
    for problem in book.problems[noted:]:
        if problem not in seen:
            seen.add(problem)
            fresh.append(problem)
    book.problems[noted:] = fresh
    return book
