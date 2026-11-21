"""Assign keys to the elements of a loaded ANDES ``System``.

Section 4 of ``design/multiengine/spec.md``: ANDES keeps file order but drops
the circuit id of a branch and the id of a load or shunt, so the identity read
from the case file (``tensa.engines.identity``) supplies them. Lines are
matched to the file's branches by unordered bus pair rather than by position,
because ANDES keeps a MATPOWER file's branch rows in file order with the
transformers in between while the identity lists the non-transformer rows
first. Every two-terminal AC branch, line or transformer, gets a
``branch:<from>-<to>-<ckt>`` key; whether it is a line or a transformer is the
``bucket`` of its entry, decided by the file's record when there is one and by
ANDES's own rule otherwise. Elements ANDES adds on its own (the star bus of a
three-winding transformer and the three lines to it) have no counterpart in
the file and get engine keys. This module never imports ``andes``: the system
is read through attributes, and every access is guarded so a missing model or
parameter is skipped rather than raised.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from functools import partial
from typing import Any

from tensa.engines.identity import CaseIdentity
from tensa.engines.keys import (
    KeyBook,
    KeyEntry,
    branch_key,
    bus_key,
    device_key,
    engine_key,
    generator_key,
    load_key,
    shunt_key,
    unit_model_key,
)

# Models step 6 leaves out: the static ones steps 1 to 5 cover, the timed
# events, and the bookkeeping models.
_STATIC_MODELS = frozenset(
    {"Bus", "Line", "PV", "Slack", "PQ", "Shunt", "ShuntSw", "ShuntTD"}
)
_EXCLUDED_MODELS = _STATIC_MODELS | frozenset(
    {"Toggle", "Fault", "Alter", "Summary", "Area", "Output"}
)

# Reference chains to a static generator, followed in this order: a parameter
# of this name points at the model the next step looks up.
_REF_CHAIN: tuple[str, ...] = ("gen", "syn", "avr", "reg", "ree", "rego", "rea", "rep")
_MAX_REF_STEPS = 8


def _values(model: Any, name: str) -> list[Any]:
    """The values of parameter ``name`` of ``model`` as a list, or ``[]``."""
    param = getattr(model, name, None)
    values = getattr(param, "v", None)
    if values is None:
        return []
    try:
        return list(values)
    except TypeError:
        return []


def _number(value: Any) -> float | None:
    """``value`` as a finite float, or ``None``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _bus_number(idx: Any) -> int | None:
    """The bus number of an ANDES bus idx, or ``None`` when it is not numeric."""
    if isinstance(idx, bool):
        return None
    if isinstance(idx, int):
        return idx
    if isinstance(idx, float):
        return int(idx) if idx.is_integer() else None
    text = str(idx).strip()
    return int(text) if text.isdigit() else None


def _id_text(value: Any) -> str | None:
    """A device id as text: a whole number as an integer string, ``None`` when
    the value is empty or ``None``."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        return text if text else None
    number = _number(value)
    if number is not None:
        if number.is_integer():
            return str(int(number))
        return str(number)
    text = str(value).strip()
    return text if text else None


def _group_name(model: Any) -> str:
    """The name of the ANDES group a model belongs to, or ``""``."""
    group = getattr(model, "group", None)
    name = getattr(group, "class_name", None)
    if isinstance(name, str):
        return name
    if name is not None:
        return str(name)
    return str(group) if group is not None else ""


def _role_of(group: str) -> str:
    """The unit role of an ANDES group name."""
    if group == "SynGen":
        return "machine"
    if group == "Exciter":
        return "exciter"
    if group == "TurbineGov":
        return "governor"
    if group == "PSS":
        return "pss"
    if group.startswith("Ren") or group == "DG":
        return "renewable"
    if group in ("PhasorMeasurement", "FreqMeasurement"):
        return "measurement"
    if group == "DataSeries":
        return "profile"
    return "other"


def is_transformer_row(ss: Any, i: int) -> bool:
    """Whether ANDES line ``i`` is a transformer by ANDES's own data.

    The rule of ``_split_lines_transformers`` and ``_marked_as_transformers``
    in ``tensa.core.wrapper.topology``: a tap that is not 1, a phase shift that
    is not 0, a true ``trans`` flag, or two rated voltages ``Vn1`` and ``Vn2``
    that differ.
    """
    model = getattr(ss, "Line", None)
    if model is None:
        return False
    tap = _number(_values(model, "tap")[i] if i < len(_values(model, "tap")) else None)
    if tap is not None and abs(tap - 1.0) > 1e-9:
        return True
    phi = _number(_values(model, "phi")[i] if i < len(_values(model, "phi")) else None)
    if phi is not None and abs(phi) > 1e-9:
        return True
    trans = _number(
        _values(model, "trans")[i] if i < len(_values(model, "trans")) else None
    )
    if trans is not None and trans != 0.0:
        return True
    vn1 = _number(_values(model, "Vn1")[i] if i < len(_values(model, "Vn1")) else None)
    vn2 = _number(_values(model, "Vn2")[i] if i < len(_values(model, "Vn2")) else None)
    if vn1 is not None and vn2 is not None and vn1 > 0.0 and vn2 > 0.0:
        return abs(vn1 - vn2) > 0.001 * max(vn1, vn2)
    return False


def _first_free_id(
    book: KeyBook,
    *makers: Callable[[str], str],
    reserved: frozenset[str] | set[str] = frozenset(),
) -> str:
    """The first ordinal, from ``"1"``, that is not in ``reserved`` and whose
    key, as each of ``makers`` writes it from the id, no element of ``book``
    holds.

    Every ordinal key (a load, shunt, generator or circuit made up from order)
    is chosen this way: an element added to a case takes an id that no element
    holds, and never reaches the ``~N`` suffix of ``KeyBook.assign``.
    """
    ordinal = 1
    while str(ordinal) in reserved or any(
        book.entry_of(make(str(ordinal))) is not None for make in makers
    ):
        ordinal += 1
    return str(ordinal)


def _branch_ends(key: str) -> tuple[int, int] | None:
    """The ``(from, to)`` bus numbers of a ``branch:<from>-<to>-<ckt>`` key, or
    ``None`` for any other key."""
    if not key.startswith("branch:"):
        return None
    parts = key[len("branch:"):].split("-", 2)
    if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
        return None
    return (int(parts[0]), int(parts[1]))


def _assign_buses(
    ss: Any, identity: CaseIdentity | None, book: KeyBook
) -> tuple[dict[str, int], set[int]]:
    """Step 1: key every bus and map each ANDES bus idx to its bus number.

    When an identity is given, a bus whose number is not in ``identity.buses``
    is one the engine added (the star bus of a three-winding transformer): it
    gets an engine key, bucket ``"other"``, not a ``bus:`` key. The returned
    set holds the bus numbers of those buses.
    """
    model = getattr(ss, "Bus", None)
    idx_values = _values(model, "idx") if model is not None else []
    numbers: dict[str, int] = {}
    added: set[int] = set()
    numeric: list[int] = []
    for idx in idx_values:
        number = _bus_number(idx)
        if number is not None:
            numeric.append(number)
    next_free = max(numeric, default=0) + 1
    for idx in idx_values:
        number = _bus_number(idx)
        if number is not None:
            if identity is not None and number not in identity.buses:
                added.add(number)
                numbers[str(idx)] = number
                book.assign(
                    KeyEntry(
                        engine_key("andes", "Bus", idx), "other", "Bus", idx, "engine"
                    )
                )
                continue
            source = "engine"
        else:
            number = next_free
            next_free += 1
            source = "ordinal"
            book.problems.append(
                f"bus {idx} has no number; numbered {number} in ANDES order"
            )
        numbers[str(idx)] = number
        book.assign(KeyEntry(bus_key(number), "bus", "Bus", idx, source))
    return numbers, added


def _assign_lines(
    ss: Any,
    identity: CaseIdentity | None,
    book: KeyBook,
    bus_numbers: dict[str, int],
    added_buses: set[int],
) -> None:
    """Step 2: key every line and transformer of ``ss.Line``, in ANDES order.

    With an identity, the file's branch records are queued per unordered bus
    pair, transformers and plain lines apart, and each ANDES line takes the
    next record of its pair and kind (of the other kind when its own is out),
    keeping the record's circuit, bus order and kind as its bucket. A line
    with an end on a bus the engine added gets an engine key. A line with no
    record left (or whose record's key another line already holds) gets a
    circuit by ordinal: the first one, counted over all branches of its bus
    pair (lines and transformers together), that the file does not give the
    pair and no branch of the book holds in either orientation. It is written
    in the orientation the pair's other branches have, so an added parallel
    circuit is ``branch:6-5-2`` beside ``branch:6-5-1``; a pair with none is
    written in bus-number order. A line the book has keyed keeps its key. Every
    key is a ``branch:`` key; the bucket (``"line"`` or ``"transformer"``)
    says which kind the branch is. The notes about lines and records that did
    not match are made the first time the case is keyed, when they say
    something about the file.
    """
    model = getattr(ss, "Line", None)
    if model is None:
        return
    idx_values = _values(model, "idx")
    bus1_values = _values(model, "bus1")
    bus2_values = _values(model, "bus2")
    n = int(getattr(model, "n", len(idx_values)) or 0)

    def pair(i: int) -> tuple[int, int] | None:
        if i >= len(bus1_values) or i >= len(bus2_values):
            return None
        first = bus_numbers.get(str(bus1_values[i]))
        second = bus_numbers.get(str(bus2_values[i]))
        if first is None or second is None:
            return None
        return (min(first, second), max(first, second))

    def raw_end(i: int) -> int | None:
        if i >= len(bus1_values) or i >= len(bus2_values):
            return None
        first = bus_numbers.get(str(bus1_values[i]))
        second = bus_numbers.get(str(bus2_values[i]))
        if first in added_buses:
            return first
        if second in added_buses:
            return second
        return None

    # Queues of identity records per unordered pair, transformer records and
    # plain ones apart, each in the order of ``identity.branches``.
    queues: dict[tuple[int, int], dict[bool, list[int]]] = {}
    if identity is not None:
        for position, branch in enumerate(identity.branches):
            branch_pair = (
                min(branch.from_bus, branch.to_bus),
                max(branch.from_bus, branch.to_bus),
            )
            queues.setdefault(branch_pair, {False: [], True: []})[branch.transformer].append(
                position
            )

    # The circuits the file gives each unordered pair, so an ordinal circuit
    # never repeats one of them, whichever line of the pair ANDES lists first.
    file_ckts: dict[tuple[int, int], set[str]] = {}
    if identity is not None:
        for branch in identity.branches:
            file_ckts.setdefault(
                (min(branch.from_bus, branch.to_bus), max(branch.from_bus, branch.to_bus)),
                set(),
            ).add(branch.ckt)
    # The orientation every branch key of an unordered pair already has in the
    # book, so a circuit added to a corridor is written as the corridor is
    # (``branch:6-5-2`` beside the file's ``branch:6-5-1``), not reversed.
    oriented: dict[tuple[int, int], tuple[int, int]] = {}
    for entry in book.entries():
        if entry.model == "Line" and entry.key.startswith("branch:"):
            ends = _branch_ends(entry.key)
            if ends is not None:
                oriented.setdefault((min(ends), max(ends)), ends)
    # Lines are measured against the file the first time the case is keyed;
    # a line an edit adds later matches no record and is no problem of the file.
    first_keying = not any(entry.model == "Line" for entry in book.entries())
    unmatched_lines = 0
    added_bus_lines = 0

    def assign_line(entry: KeyEntry, line_pair: tuple[int, int] | None) -> None:
        stored = book.assign(entry)
        ends = _branch_ends(stored.key)
        if line_pair is not None and ends is not None:
            oriented.setdefault(line_pair, ends)

    for i in range(n):
        idx = idx_values[i] if i < len(idx_values) else i
        if identity is not None and raw_end(i) is not None:
            # A line to a bus the engine added (a three-winding transformer's
            # star bus): the file does not name it.
            added_bus_lines += 1
            book.assign(
                KeyEntry(
                    engine_key("andes", "Line", idx), "other", "Line", idx, "engine"
                )
            )
            continue
        line_pair = pair(i)
        record_position: int | None = None
        if identity is not None and line_pair is not None:
            by_kind = queues.get(line_pair)
            if by_kind is not None:
                want_transformer = is_transformer_row(ss, i)
                same_kind = by_kind[want_transformer]
                if same_kind:
                    record_position = same_kind.pop(0)
                else:
                    other_kind = by_kind[not want_transformer]
                    if other_kind:
                        record_position = other_kind.pop(0)
        if book.has("Line", idx):
            # Keyed before (a reload, an edit): the book keeps its key. The
            # record it took above stays taken, so the lines after it are
            # matched as they were.
            continue
        if record_position is not None and identity is not None:
            branch = identity.branches[record_position]
            key = branch_key(branch.from_bus, branch.to_bus, branch.ckt)
            if first_keying or book.entry_of(key) is None:
                # On the first keying a held key is the file's own clash (two
                # records with one circuit): it is stored with a suffix and a
                # note, so the file's fault is seen.
                bucket = "transformer" if branch.transformer else "line"
                assign_line(KeyEntry(key, bucket, "Line", idx, "file"), line_pair)
                continue
            # The record's key is held (a line of the file was deleted and a
            # line of the pair added): the added line takes an ordinal below.
        if line_pair is None:
            # A line whose buses have no number cannot be keyed by pair; give
            # it an engine key so it is still named.
            book.assign(
                KeyEntry(engine_key("andes", "Line", idx), "other", "Line", idx, "engine")
            )
            continue
        if identity is not None and first_keying and record_position is None:
            unmatched_lines += 1
        # A circuit by ordinal: the first one of the pair that the file does not
        # give and no branch of the book holds, in either orientation, written
        # in the orientation the pair already has (the pair in bus order when
        # it has none).
        from_bus, to_bus = oriented.get(line_pair, line_pair)
        taken = file_ckts.get(line_pair, set())
        ckt = _first_free_id(
            book,
            partial(branch_key, from_bus, to_bus),
            partial(branch_key, to_bus, from_bus),
            reserved=taken,
        )
        bucket = "transformer" if is_transformer_row(ss, i) else "line"
        assign_line(
            KeyEntry(branch_key(from_bus, to_bus, ckt), bucket, "Line", idx, "ordinal"),
            line_pair,
        )

    if identity is not None and first_keying:
        unused = sum(len(by_kind[kind]) for by_kind in queues.values() for kind in (False, True))
        if unused > 0:
            book.problems.append(
                f"{unused} branch record(s) of the case file matched no line "
                "ANDES holds and were left unused"
            )
        if unmatched_lines > 0:
            book.problems.append(
                f"{unmatched_lines} line(s) ANDES holds matched no branch "
                "record of the case file; circuits assigned by ordinal"
            )
        if added_buses or added_bus_lines:
            book.problems.append(
                f"{len(added_buses)} bus(es) and {added_bus_lines} line(s) "
                "come from three-winding transformers or other elements the "
                "engine added; they get engine keys and are left out of "
                "comparison"
            )


def _assign_generators(ss: Any, book: KeyBook, bus_numbers: dict[str, int]) -> None:
    """Step 3: key the static generators, ``ss.PV`` then ``ss.Slack``.

    A generator keeps the key the book has for it. A new one takes the machine
    id ANDES holds (``subidx``) when no element holds that key, and otherwise,
    or with no id, the first ordinal on its bus that no element holds.
    """
    first_keying = not any(entry.model in ("PV", "Slack") for entry in book.entries())
    for model_name in ("PV", "Slack"):
        model = getattr(ss, model_name, None)
        if model is None:
            continue
        idx_values = _values(model, "idx")
        bus_values = _values(model, "bus")
        subidx_values = _values(model, "subidx")
        for i, idx in enumerate(idx_values):
            bus = bus_numbers.get(str(bus_values[i])) if i < len(bus_values) else None
            if bus is None:
                book.assign(
                    KeyEntry(
                        engine_key("andes", model_name, idx),
                        "other",
                        model_name,
                        idx,
                        "engine",
                    )
                )
                continue
            if book.has(model_name, idx):
                continue
            id_text = _id_text(subidx_values[i]) if i < len(subidx_values) else None
            if id_text is not None and (
                first_keying or book.entry_of(generator_key(bus, id_text)) is None
            ):
                # On the first keying a held key is the file's own clash (two
                # machines of one id on a bus), stored with a suffix and a note.
                source = "engine"
            else:
                id_text = _first_free_id(book, partial(generator_key, bus))
                source = "ordinal"
            book.assign(
                KeyEntry(
                    generator_key(bus, id_text), "generator", model_name, idx, source
                )
            )


def _assign_devices_on_buses(
    ss: Any,
    identity: CaseIdentity | None,
    book: KeyBook,
    bus_numbers: dict[str, int],
) -> None:
    """Steps 4 and 5: key the loads and the shunts, from the identity when the
    count and the buses match, else by ordinal on the bus: a device not keyed
    yet takes the first ordinal whose key no element of the book holds, which
    for a fresh book is its place among the devices of its bus."""
    plans: list[tuple[list[str], str, str]] = [
        (["PQ"], "load", "load"),
        (["Shunt", "ShuntSw", "ShuntTD"], "shunt", "shunt"),
    ]
    identity_lists: list[tuple[int, str]] = []
    if identity is not None:
        identity_lists = [
            *[(device.bus, device.id) for device in identity.loads],
        ]
    shunt_identity: list[tuple[int, str]] = []
    if identity is not None:
        shunt_identity = [
            *[(device.bus, device.id) for device in identity.fixed_shunts],
            *[(device.bus, device.id) for device in identity.switched_shunts],
        ]

    for model_names, bucket, key_kind in plans:
        devices: list[tuple[str, Any, int | None]] = []
        for model_name in model_names:
            model = getattr(ss, model_name, None)
            if model is None or int(getattr(model, "n", 0) or 0) <= 0:
                continue
            idx_values = _values(model, "idx")
            bus_values = _values(model, "bus")
            for i, idx in enumerate(idx_values):
                bus = (
                    bus_numbers.get(str(bus_values[i]))
                    if i < len(bus_values)
                    else None
                )
                devices.append((model_name, idx, bus))

        wanted = identity_lists if bucket == "load" else shunt_identity
        matched = (
            identity is not None
            and len(wanted) == len(devices)
            and all(
                bus is not None and wanted[i][0] == bus
                for i, (_, _, bus) in enumerate(devices)
            )
        )
        make_key = load_key if key_kind == "load" else shunt_key
        for i, (model_name, idx, bus) in enumerate(devices):
            if bus is None:
                book.assign(
                    KeyEntry(
                        engine_key("andes", model_name, idx),
                        "other",
                        model_name,
                        idx,
                        "engine",
                    )
                )
                continue
            if matched:
                id_text = wanted[i][1]
                source = "file"
            elif book.has(model_name, idx):
                # Keyed before (a reload, an edit): the book keeps its key.
                continue
            else:
                # The first ordinal on the bus whose key no element holds, so a
                # device added beside one whose file id is not its ordinal (a
                # load with id 2 alone on its bus) takes a key of its own.
                id_text = _first_free_id(book, partial(make_key, bus))
                source = "ordinal"
            book.assign(KeyEntry(make_key(bus, id_text), bucket, model_name, idx, source))


def _model_index(ss: Any) -> dict[str, list[tuple[str, int]]]:
    """Every idx value of every model, mapped to the ``(model name, position)``
    pairs that hold it. An idx is only unique within a model, so a value can
    name a bus, a static generator and a machine at once; the reference being
    followed decides which is meant."""
    index: dict[str, list[tuple[str, int]]] = {}
    models = getattr(ss, "models", None)
    if models is None:
        return index
    try:
        items = list(models.items())
    except AttributeError:
        return index
    for name, model in items:
        for i, idx in enumerate(_values(model, "idx")):
            index.setdefault(str(idx), []).append((name, i))
    return index


def _unit_of_device(
    ss: Any, model_name: str, position: int, index: dict[str, list[tuple[str, int]]]
) -> tuple[str, Any] | None:
    """The ``(model name, idx)`` of the static generator a device leads back
    to, following ``gen``, ``syn``, ``avr`` and the converter chain, at most 8
    steps; ``None`` when it reaches none.

    A ``gen`` reference is meant for a static generator (``PV`` or ``Slack``);
    any other reference is meant for a dynamic model, so among the models that
    hold the value the static and bookkeeping ones are passed over.
    """
    current_model_name = model_name
    current_position = position
    for _ in range(_MAX_REF_STEPS):
        if current_model_name in ("PV", "Slack"):
            idx_values = _values(getattr(ss, current_model_name, None), "idx")
            if current_position < len(idx_values):
                return (current_model_name, idx_values[current_position])
            return None
        current_model = getattr(ss, current_model_name, None)
        if current_model is None:
            return None
        reference: Any = None
        reference_param = ""
        for param_name in _REF_CHAIN:
            values = _values(current_model, param_name)
            if current_position < len(values):
                candidate = values[current_position]
                if candidate is not None and str(candidate) != "":
                    reference = candidate
                    reference_param = param_name
                    break
        if reference is None:
            return None
        candidates = index.get(str(reference))
        if not candidates:
            return None
        picked: tuple[str, int] | None
        if reference_param == "gen":
            picked = next(
                (c for c in candidates if c[0] in ("PV", "Slack")), None
            )
        else:
            picked = next(
                (c for c in candidates if c[0] not in _EXCLUDED_MODELS), None
            )
        if picked is None:
            return None
        current_model_name, current_position = picked
    return None


def _assign_dynamic_and_other(
    ss: Any, book: KeyBook, bus_numbers: dict[str, int]
) -> None:
    """Step 6: key every other model with ``n > 0``.

    A device of a generating unit takes ``unit_model_key(unit, role)``; when
    that is taken, the key with the model name; when that is taken too (two
    devices of one model and role on one unit), the key with the model name
    and ``-2``, ``-3``, ... the first that is free, without a problem note.
    """
    models = getattr(ss, "models", None)
    if models is None:
        return
    try:
        items = list(models.items())
    except AttributeError:
        return
    index = _model_index(ss)
    bus_ordinals: dict[tuple[str, int], int] = {}
    for model_name, model in items:
        if model_name in _EXCLUDED_MODELS:
            continue
        n = int(getattr(model, "n", 0) or 0)
        if n <= 0:
            continue
        idx_values = _values(model, "idx")
        role = _role_of(_group_name(model))
        bus_values = _values(model, "bus")
        for position in range(n):
            idx = idx_values[position] if position < len(idx_values) else position
            unit = _unit_of_device(ss, model_name, position, index)
            if unit is not None:
                unit_model_name, unit_idx = unit
                unit_key = book.key_of(unit_model_name, unit_idx)
            else:
                unit_key = None
            if unit_key is not None:
                key = unit_model_key(unit_key, role)
                existing = book.entry_of(key)
                if existing is not None and (
                    existing.model != model_name or str(existing.idx) != str(idx)
                ):
                    key = unit_model_key(unit_key, role, model_name)
                    existing = book.entry_of(key)
                    if existing is not None and (
                        existing.model != model_name or str(existing.idx) != str(idx)
                    ):
                        suffix = 2
                        while book.entry_of(f"{key}-{suffix}") is not None:
                            suffix += 1
                        key = f"{key}-{suffix}"
                book.assign(KeyEntry(key, "dynamic", model_name, idx, "engine"))
                continue
            bus = (
                bus_numbers.get(str(bus_values[position]))
                if position < len(bus_values)
                else None
            )
            if bus is not None:
                ordinal_key = (model_name, bus)
                bus_ordinals[ordinal_key] = bus_ordinals.get(ordinal_key, 0) + 1
                key = device_key(model_name, bus, str(bus_ordinals[ordinal_key]))
                book.assign(KeyEntry(key, "other", model_name, idx, "ordinal"))
                continue
            book.assign(
                KeyEntry(
                    engine_key("andes", model_name, idx),
                    "other",
                    model_name,
                    idx,
                    "engine",
                )
            )


def assign_andes_keys(
    ss: Any, identity: CaseIdentity | None, book: KeyBook | None = None
) -> KeyBook:
    """Assign a key to every element of the ANDES ``System`` ``ss``.

    ``identity`` is what ``tensa.engines.identity.read_identity`` gave for the
    file the system was loaded from, or ``None``. When ``book`` is given,
    elements that already have a key keep it and only new ones are assigned,
    and a problem the book already notes is not noted a second time.
    """
    if book is None:
        book = KeyBook()
    noted = len(book.problems)
    bus_numbers, added_buses = _assign_buses(ss, identity, book)
    _assign_lines(ss, identity, book, bus_numbers, added_buses)
    _assign_generators(ss, book, bus_numbers)
    _assign_devices_on_buses(ss, identity, book, bus_numbers)
    _assign_dynamic_and_other(ss, book, bus_numbers)
    seen = set(book.problems[:noted])
    fresh: list[str] = []
    for problem in book.problems[noted:]:
        if problem not in seen:
            seen.add(problem)
            fresh.append(problem)
    book.problems[noted:] = fresh
    return book
