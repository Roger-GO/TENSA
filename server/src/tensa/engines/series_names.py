"""Neutral series names (section 6.5 of ``design/multiengine/spec.md``).

"A client asks for neutral names with ``"names": "neutral"`` in the
``start_tds`` frame or the batch request, and then each entry is
``<quantity>|<key>``, with the relative quantities available. A Sienna session
always uses neutral names."

The quantity catalogue of section 6.5, verbatim:

| Quantity | Of | Unit | Frame or convention |
|---|---|---|---|
| `voltage` | bus | pu | magnitude |
| `angle` | bus | rad | as the engine reports it: its network frame |
| `angle_rel` | bus | rad | minus the reference bus's angle at the same instant |
| `rotor_speed` | generating unit | pu | 1.0 is nominal |
| `rotor_angle` | generating unit | rad | as the engine reports it |
| `rotor_angle_rel` | generating unit | rad | minus the inertia-weighted mean angle of the machines in service at the same instant |
| `p`, `q` | generating unit, load | MW, MVAr | electrical power injected by a unit, absorbed by a load |
| `p_from`, `q_from` | branch | MW, MVAr | into the branch at its `from` end |
| `state` | `<key>` + state name | engine's own | the engine's raw state, for one-engine use only |
| `eigenvalue` | case | 1/s | with `frequency_hz` and `damping_ratio`; a zero eigenvalue is reported as zero (`core/wrapper/eig.py`) |

``eigenvalue`` is tabulated for completeness but is not a streamed series and
this module builds no names for it. ``state`` names carry the state name after
the key, separated by ``#`` (see :func:`build_state_name`).

The ANDES column patterns this module maps, as ``tensa.core.stream``'s module
docstring lists them and ``var_column_names`` builds them
(``<Prefix>_<idx>_<suffix>``), every pattern the stream and the wrapper
produce, mapped or not:

- ``Bus_<idx>_v`` (group ``bus_v``): mapped to ``voltage|<bus key>``.
- ``Bus_<idx>_a`` (group ``bus_v``): mapped to ``angle|<bus key>``.
- ``Gen_<idx>_delta`` (group ``gen_state``): mapped to ``rotor_angle|<unit key>``.
- ``Gen_<idx>_omega`` (group ``gen_state``): mapped to ``rotor_speed|<unit key>``.
- ``Gen_<idx>_Pe`` (group ``gen_power``): mapped to ``p|<unit key>``.
- ``Gen_<idx>_Qe`` (group ``gen_power``): mapped to ``q|<unit key>``.
- ``Line_<idx>_p`` (group ``line_flow``): mapped to ``p_from|<branch key>``.
- ``Line_<idx>_q`` (group ``line_flow``): mapped to ``q_from|<branch key>``.
- ``Load_<idx>_p`` (group ``load_pq``): mapped to ``p|<load key>``.
- ``Load_<idx>_q`` (group ``load_pq``): mapped to ``q|<load key>``.
- A ``dae_vars`` entry such as ``omega GENROU 1`` (``tensa.core.dae_vars``,
  named exactly as ANDES names the variable): NOT mapped;
  :func:`neutral_name_andes` answers ``None`` for it. Raw states are named by
  the caller through :func:`build_state_name` when it wants them neutral.

Nothing here imports an engine; the ANDES mapping reads a ``KeyBook``, not a
``System``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from tensa.engines.keys import KeyBook, is_key

__all__ = [
    "QUANTITIES",
    "QUANTITY_BY_NAME",
    "SEPARATOR",
    "STATE_SEPARATOR",
    "QuantitySpec",
    "build_name",
    "build_state_name",
    "neutral_name_andes",
    "neutral_names_andes",
    "parse_name",
    "parse_state_name",
]

SEPARATOR = "|"
STATE_SEPARATOR = "#"


@dataclass(frozen=True)
class QuantitySpec:
    """One row of the section 6.5 catalogue."""

    quantity: str
    of: str  # "bus", "generating unit", "load", "branch", "case", or "state"
    unit: str  # "pu", "rad", "MW", "MVAr", "1/s", or "engine's own"
    convention: str  # the catalogue's "Frame or convention" text, verbatim


QUANTITIES: tuple[QuantitySpec, ...] = (
    QuantitySpec("voltage", "bus", "pu", "magnitude"),
    QuantitySpec("angle", "bus", "rad", "as the engine reports it: its network frame"),
    QuantitySpec(
        "angle_rel", "bus", "rad", "minus the reference bus's angle at the same instant"
    ),
    QuantitySpec("rotor_speed", "generating unit", "pu", "1.0 is nominal"),
    QuantitySpec("rotor_angle", "generating unit", "rad", "as the engine reports it"),
    QuantitySpec(
        "rotor_angle_rel",
        "generating unit",
        "rad",
        "minus the inertia-weighted mean angle of the machines in service at the same instant",
    ),
    QuantitySpec(
        "p",
        "generating unit, load",
        "MW",
        "electrical power injected by a unit, absorbed by a load",
    ),
    QuantitySpec(
        "q",
        "generating unit, load",
        "MVAr",
        "electrical power injected by a unit, absorbed by a load",
    ),
    QuantitySpec("p_from", "branch", "MW", "into the branch at its `from` end"),
    QuantitySpec("q_from", "branch", "MVAr", "into the branch at its `from` end"),
    QuantitySpec(
        "state", "state", "engine's own", "the engine's raw state, for one-engine use only"
    ),
    QuantitySpec(
        "eigenvalue",
        "case",
        "1/s",
        "with `frequency_hz` and `damping_ratio`; a zero eigenvalue is reported as zero "
        "(`core/wrapper/eig.py`)",
    ),
)

QUANTITY_BY_NAME: dict[str, QuantitySpec] = {spec.quantity: spec for spec in QUANTITIES}


def build_name(quantity: str, key: str) -> str:
    """The neutral series name ``<quantity>|<key>``: ``rotor_speed|gen:1-1``.

    Raises:
        ValueError: ``quantity`` is not in the catalogue or is ``eigenvalue``
            (``unknown quantity ...``; ``eigenvalue`` is in the catalogue but
            has no series name), ``quantity`` is ``state`` (a state series
            needs the state name appended; use :func:`build_state_name`), or
            ``key`` is not a key (``not a key: ...``).
    """
    if quantity == "state":
        raise ValueError("use build_state_name for state series")
    if quantity == "eigenvalue" or quantity not in QUANTITY_BY_NAME:
        raise ValueError(f"unknown quantity {quantity!r}")
    if not is_key(key):
        raise ValueError(f"not a key: {key!r}")
    return f"{quantity}{SEPARATOR}{key}"


def build_state_name(key: str, state_name: str) -> str:
    """The neutral name of a raw state series: ``state|<key>#<state name>``.

    For example ``state|gen:1-1/machine#omega``. The catalogue row is
    "`<key>` + state name"; ``#`` never occurs in a key, so the name parses
    back unambiguously at the first ``#`` after the ``|`` (see
    :func:`parse_state_name`). The state name is used as given.

    Raises:
        ValueError: ``key`` is not a key (``not a key: ...``) or
            ``state_name`` is empty or all whitespace (``empty state name``).
    """
    if not is_key(key):
        raise ValueError(f"not a key: {key!r}")
    if not state_name.strip():
        raise ValueError("empty state name")
    return f"state{SEPARATOR}{key}{STATE_SEPARATOR}{state_name}"


def parse_name(name: str) -> tuple[str, str]:
    """Split a neutral series name into ``(quantity, key)``.

    Splits on the first ``|``. For a ``state`` name the part after ``|`` is
    ``<key>#<state name>``; the key check applies to the portion before the
    first ``#`` after the separator, and the returned second element is the
    full ``<key>#<state name>`` string (use :func:`parse_state_name` to take
    it apart).

    Raises:
        ValueError: there is no ``|``, the quantity part is empty, or the key
            portion fails ``is_key`` (``not a neutral series name: ...``); or
            the quantity part is not in the catalogue (``unknown quantity
            ...``).
    """
    quantity, separator, rest = name.partition(SEPARATOR)
    if not separator or not quantity:
        raise ValueError(f"not a neutral series name: {name!r}")
    key_part = rest.split(STATE_SEPARATOR, 1)[0] if quantity == "state" else rest
    if not is_key(key_part):
        raise ValueError(f"not a neutral series name: {name!r}")
    if quantity not in QUANTITY_BY_NAME:
        raise ValueError(f"unknown quantity {quantity!r}")
    return quantity, rest


def parse_state_name(name: str) -> tuple[str, str]:
    """Split a neutral ``state`` series name into ``(key, state name)``.

    ``state|gen:1-1/machine#omega`` parses to ``("gen:1-1/machine",
    "omega")``: ``#`` never occurs in a key, so the split is at the first
    ``#`` after the ``|``.

    Raises:
        ValueError: ``name`` is not a ``state`` series name, its key part is
            not a key, or it holds no ``#`` after the ``|`` (``not a neutral
            state series name: ...``).
    """
    quantity, rest = parse_name(name)
    if quantity != "state":
        raise ValueError(f"not a neutral state series name: {name!r}")
    key, separator, state_name = rest.partition(STATE_SEPARATOR)
    if not separator or not state_name:
        raise ValueError(f"not a neutral state series name: {name!r}")
    return key, state_name


_COLUMN_PATTERN = re.compile(r"(Bus|Gen|Line|Load)_(.+)_(v|a|delta|omega|Pe|Qe|p|q)")

# The quantity each (prefix, suffix) pair maps to. ``Gen`` is not in this
# table: its key comes from the machine entries of the book, not ``key_of``.
_QUANTITY_OF: dict[tuple[str, str], str] = {
    ("Bus", "v"): "voltage",
    ("Bus", "a"): "angle",
    ("Gen", "delta"): "rotor_angle",
    ("Gen", "omega"): "rotor_speed",
    ("Gen", "Pe"): "p",
    ("Gen", "Qe"): "q",
    ("Line", "p"): "p_from",
    ("Line", "q"): "q_from",
    ("Load", "p"): "p",
    ("Load", "q"): "q",
}

# The ANDES model whose ``key_of`` answers each prefix's key. ``Load`` columns
# come from the ``load_pq`` group, which covers only the ``PQ`` model
# (``pq_idx_values_from_system``). ``Gen`` has no entry: see
# :func:`_unit_key_of_machine`.
_MODEL_OF: dict[str, str] = {"Bus": "Bus", "Line": "Line", "Load": "PQ"}


def _unit_key_of_machine(book: KeyBook, idx: str) -> str | None:
    """The unit key of the SynGen member whose idx string is ``idx``, or
    ``None``.

    The ``gen_state`` and ``gen_power`` groups span every model of the SynGen
    group (``syngen_idx_values_from_system``: "GENROU, GENCLS, PLBVFU1"), and
    this module imports no engine, so the SynGen model names are not
    enumerated. Instead the scan tries, in assignment order, the entries of
    the book whose bucket is ``"dynamic"`` and whose key has the machine role
    (``<unit key>/machine`` or ``<unit key>/machine:<kind>``, as ``_role_of``
    in ``tensa.engines.andes.keys`` assigns it); the unit key is the part
    before ``/machine``. If several entries share the idx string (different
    models), the first in assignment order wins; that cannot happen for SynGen
    members because ANDES idx values are unique within the SynGen group
    (``SynGen.get_all_idxes()``).
    """
    for entry in book.entries():
        if entry.bucket != "dynamic" or str(entry.idx) != idx:
            continue
        head, separator, _role = entry.key.partition("/")
        if separator and _role.split(":", 1)[0] == "machine":
            return head
    return None


def neutral_name_andes(column: str, book: KeyBook) -> str | None:
    """The neutral series name of an ANDES stream column, or ``None``.

    ``column`` is one entry of ``stream_start.metadata.var_columns`` as
    ``tensa.core.stream.var_column_names`` builds it. Returns the neutral name
    for the ten patterns of the module docstring's table. Returns ``None`` for
    a column that matches no pattern and for a column whose element the book
    does not key (a ``dae_vars`` entry such as ``omega GENROU 1`` returns
    ``None``; raw states are named by the caller through
    :func:`build_state_name` when it wants them neutral).
    """
    match = _COLUMN_PATTERN.fullmatch(column)
    if match is None:
        return None
    prefix, idx, suffix = match.group(1), match.group(2), match.group(3)
    quantity = _QUANTITY_OF.get((prefix, suffix))
    if quantity is None:
        return None
    if prefix == "Gen":
        key = _unit_key_of_machine(book, idx)
    else:
        key = book.key_of(_MODEL_OF[prefix], idx)
    if key is None:
        return None
    return build_name(quantity, key)


def neutral_names_andes(columns: list[str], book: KeyBook) -> list[str | None]:
    """``neutral_name_andes`` over a list, order kept."""
    return [neutral_name_andes(column, book) for column in columns]
