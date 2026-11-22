"""The neutral edit log of a Sienna session.

The Sienna engine follows the ANDES engine's rule (``tensa.core.edit_log``):
the System a session holds is the case file with the session's edit log
applied, so taking the last edit back is rebuilding without it and putting it
back is rebuilding with it. The log's operations are neutral: an element is
named by its key (``load:7-1``) and a field by the case document's name
(``p_mw``), and the Julia module's ``apply_edits!`` maps them to PowerSystems
setters. This module is pure Python and imports no engine.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from tensa.engines.keys import KeyBook, load_key, shunt_key

# The fields an edit can set, by the bucket of the element's key, with the
# type each value must have. This is the Python half of the mapping; the
# Julia half (the PowerSystems setter per field) is the table in
# TensaSienna.jl, and the two are held to each other by a test that sends
# every field and reads it back.
EDITABLE_FIELDS: dict[str, dict[str, type]] = {
    "load": {"p_mw": float, "q_mvar": float, "in_service": bool},
    "generator": {"p_mw": float, "v_set_pu": float, "in_service": bool},
    "branch": {"in_service": bool},
    "shunt": {"g_mw": float, "b_mvar": float, "in_service": bool},
}

# The kinds an add can make, with the fields it must give and may give.
ADDABLE: dict[str, dict[str, Any]] = {
    "load": {
        "required": {"bus": int, "p_mw": float, "q_mvar": float},
        "optional": {"in_service": bool},
    },
    "shunt": {
        "required": {"bus": int, "g_mw": float, "b_mvar": float},
        "optional": {"in_service": bool},
    },
}

# The bucket each key prefix names.
_BUCKETS = {
    "load": "load",
    "shunt": "shunt",
    "gen": "generator",
    "branch": "branch",
    "bus": "bus",
}


@dataclass(frozen=True)
class SetFieldOp:
    """One field of one element set.

    ``name`` is the element's name in the topology JSON (the book entry's
    ``idx``), which the Julia side looks the component up by; the key stays
    for the echo and the bus-number checks.
    """

    key: str
    name: str
    field: str
    value: float | bool


@dataclass(frozen=True)
class AddElementOp:
    """One element added on an existing bus.

    ``key`` is the key the session gave the element (decision 28: the
    smallest free ordinal on its bus); it is part of the operation so a
    replay gives the element the same key. ``fields`` holds ``bus``,
    ``p_mw``/``q_mvar`` or ``g_mw``/``b_mvar``, and ``in_service`` when not
    true.
    """

    key: str
    fields: dict[str, Any]


@dataclass(frozen=True)
class RemoveElementOp:
    """One element removed, by key, with its topology name as ``SetFieldOp``'s."""

    key: str
    name: str


NeutralOp = SetFieldOp | AddElementOp | RemoveElementOp


def bucket_of_key(key: str) -> str | None:
    """The bucket a key names: ``"load"``, ``"shunt"``, ``"generator"``,
    ``"branch"`` or ``"bus"`` from its prefix; ``None`` for any other shape
    (a dynamic model's ``gen:1-1/machine``, an engine key, text that is no
    key)."""
    if "/" in key:
        return None
    prefix, _, rest = key.partition(":")
    if not rest:
        return None
    return _BUCKETS.get(prefix)


def _number(field: str, key: str, value: Any) -> float:
    """A numeric field's value as a float, with the two refusal messages of
    the ANDES wrapper's ``_edit_number``."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"{field} of {key!r} must be a number; got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(
            f"{field} of {key!r} must be a finite number; got {value!r}"
        )
    return number


def _bool(field: str, key: str, value: Any) -> bool:
    """An ``in_service`` value as a bool."""
    if not isinstance(value, bool):
        raise ValueError(
            f"{field} of {key!r} must be true or false; got {value!r}"
        )
    return value


def make_set_field(book: KeyBook, key: str, field: str, value: Any) -> SetFieldOp:
    """Validate one field edit against the book and the field table.

    Raises ``ValueError`` when the book holds no entry for ``key``, when the
    element's bucket does not take ``field``, or when the value is of the
    wrong type. A numeric field takes an int or a float (not a bool) and
    stores it as a float; ``in_service`` stores a bool.
    """
    entry = book.entry_of(key)
    if entry is None:
        raise ValueError(f"no element with key {key!r} in the loaded case")
    # The book stores a branch's bucket as "line" or "transformer"; the
    # editable table keys both as "branch".
    bucket = "branch" if entry.bucket in ("line", "transformer") else entry.bucket
    fields = EDITABLE_FIELDS.get(bucket)
    if fields is None or field not in fields:
        allowed = ", ".join(sorted(fields)) if fields else "none"
        raise ValueError(
            f"the {bucket} fields that can be edited are {allowed}; "
            f"{key!r} is a {bucket}"
        )
    if fields[field] is bool:
        checked: float | bool = _bool(field, key, value)
    else:
        checked = _number(field, key, value)
    return SetFieldOp(key=key, name=str(entry.idx), field=field, value=checked)


def make_add(book: KeyBook, kind: str, fields: Mapping[str, Any]) -> AddElementOp:
    """Validate an add of a load or a shunt and give it its key.

    The key is ``load_key(bus, ordinal)`` or ``shunt_key(bus, ordinal)`` with
    ``ordinal`` the first, from ``"1"``, whose key no entry of the book holds
    (decision 28 of the specification), found with the key makers only, so an
    added element never reaches the ``~N`` suffix of ``KeyBook.assign``.
    """
    spec = ADDABLE.get(kind)
    if spec is None:
        raise ValueError(f"only a load or a shunt can be added; got {kind!r}")
    required: dict[str, type] = spec["required"]
    optional: dict[str, type] = spec["optional"]
    allowed = {**required, **optional}
    names = ", ".join(sorted(required))
    given = set(fields)
    if not set(required) <= given or not given <= set(allowed):
        raise ValueError(
            f"a {kind} needs {names}; got {sorted(given)}"
        )
    bus_value = fields["bus"]
    if isinstance(bus_value, bool) or not isinstance(bus_value, int):
        raise ValueError(
            f"bus of the new {kind} must be a bus number; got {bus_value!r}"
        )
    bus = bus_value
    if book.key_of("Bus", bus) is None:
        raise ValueError(f"no bus {bus} in the loaded case")
    checked: dict[str, Any] = {"bus": bus}
    for name, value in fields.items():
        if name == "bus":
            continue
        if allowed[name] is bool:
            checked[name] = _bool(name, f"the new {kind}", value)
        else:
            checked[name] = _number(name, f"the new {kind}", value)
    make = load_key if kind == "load" else shunt_key
    ordinal = 1
    while book.entry_of(make(bus, str(ordinal))) is not None:
        ordinal += 1
    return AddElementOp(key=make(bus, str(ordinal)), fields=checked)


def make_remove(book: KeyBook, key: str) -> RemoveElementOp:
    """Validate a remove of a load or a shunt."""
    entry = book.entry_of(key)
    if entry is None:
        raise ValueError(f"no element with key {key!r} in the loaded case")
    if entry.bucket not in ("load", "shunt"):
        raise ValueError(
            f"only a load or a shunt can be removed; {key!r} is a {entry.bucket}"
        )
    return RemoveElementOp(key=key, name=str(entry.idx))


def ops_to_json(ops: Iterable[NeutralOp]) -> str:
    """The log as JSON text for ``apply_edits!``: a list of objects, each
    ``{"op": "set"|"add"|"remove", ...}`` with the record's fields."""
    out: list[dict[str, Any]] = []
    for op in ops:
        if isinstance(op, SetFieldOp):
            out.append(
                {
                    "op": "set",
                    "key": op.key,
                    "name": op.name,
                    "field": op.field,
                    "value": op.value,
                }
            )
        elif isinstance(op, AddElementOp):
            out.append({"op": "add", "key": op.key, "fields": dict(op.fields)})
        else:
            out.append({"op": "remove", "key": op.key, "name": op.name})
    return json.dumps(out)


def step_of(op: NeutralOp) -> dict[str, Any]:
    """What one entry did, for the topology snapshot's ``undo``/``redo``:
    ``{"op": "set", "key": ..., "field": ...}``, ``{"op": "add", "key": ...}``
    or ``{"op": "remove", "key": ...}``."""
    if isinstance(op, SetFieldOp):
        return {"op": "set", "key": op.key, "field": op.field}
    if isinstance(op, AddElementOp):
        return {"op": "add", "key": op.key}
    return {"op": "remove", "key": op.key}
