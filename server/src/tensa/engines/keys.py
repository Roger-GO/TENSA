"""Keys for the elements of a case (section 4 of ``design/multiengine/spec.md``).

A key is a string that names an element of a case the same way in every engine:
``bus:7``, ``branch:7-8-1``, ``gen:1-1``, ``gen:1-1/exciter``. This module builds
the key vocabulary and keeps the book of the keys one case has been given. It
is pure Python and imports no engine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


def _clean_id(text: object) -> str:
    """An id or circuit as written, stripped; spaces and ``/`` become ``_``.

    An empty one becomes ``"1"``. A key never contains a space, and the only
    ``/`` a key holds is the one that separates a unit from its role.
    """
    cleaned = str(text).strip().replace(" ", "_").replace("/", "_")
    return cleaned if cleaned else "1"


def bus_key(number: int) -> str:
    """The key of a bus: ``bus:7``."""
    return f"bus:{number}"


def branch_key(from_bus: int, to_bus: int, ckt: str) -> str:
    """The key of a two-terminal AC branch, line or transformer: ``branch:7-8-1``.

    Whether the branch is a line or a transformer is not part of the key; it
    is reported beside it (the ``bucket`` of its ``KeyEntry``).
    """
    return f"branch:{from_bus}-{to_bus}-{_clean_id(ckt)}"


def generator_key(bus: int, id: str) -> str:
    """The key of a static generator: ``gen:1-1``."""
    return f"gen:{bus}-{_clean_id(id)}"


def load_key(bus: int, id: str) -> str:
    """The key of a load: ``load:7-1``."""
    return f"load:{bus}-{_clean_id(id)}"


def shunt_key(bus: int, id: str) -> str:
    """The key of a shunt: ``shunt:7-1``."""
    return f"shunt:{bus}-{_clean_id(id)}"


def device_key(kind: str, bus: int, id: str) -> str:
    """The key of another device on a bus: ``<kind lower-case>:<bus>-<id>``."""
    return f"{kind.lower()}:{bus}-{_clean_id(id)}"


def unit_model_key(unit_key: str, role: str, kind: str | None = None) -> str:
    """The key of a dynamic model of a generating unit.

    ``gen:1-1/exciter``, or ``gen:1-1/renewable:REGCA1`` when two models of one
    role on a unit are told apart by kind.
    """
    if kind is None:
        return f"{unit_key}/{role}"
    return f"{unit_key}/{role}:{kind}"


def engine_key(engine: str, model: str, idx: object) -> str:
    """The key of an element only an engine names: ``engine:andes:PMU:3``."""
    return f"engine:{engine}:{model}:{idx}"


_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9]*:.+$")


def is_key(text: str) -> bool:
    """Whether ``text`` has the shape of a key: a lower-case kind, a colon,
    something after it."""
    return _KEY_PATTERN.match(text) is not None


@dataclass(frozen=True)
class KeyEntry:
    """One element of a case and the key it was given.

    ``source`` is ``"file"`` for ids read from the case file, ``"engine"`` for
    ids the engine holds, and ``"ordinal"`` for ids made up from order.
    """

    key: str
    bucket: str
    model: str
    idx: int | str
    source: str


@dataclass
class KeyBook:
    """The keys assigned to the elements of one case, in assignment order.

    A ``(model, idx)`` handle is matched with ``idx`` compared as ``str(idx)``,
    so ``5`` and ``"5"`` are the same handle. A key never changes once given:
    assigning a handle that has one returns the stored entry, and assigning a
    key string another element holds stores it with a suffix ``~2``, ``~3``,
    ... and notes the collision in ``problems``.
    """

    problems: list[str] = field(default_factory=list)
    _entries: list[KeyEntry] = field(default_factory=list)
    _by_handle: dict[tuple[str, str], KeyEntry] = field(default_factory=dict)
    _by_key: dict[str, KeyEntry] = field(default_factory=dict)

    def assign(self, entry: KeyEntry) -> KeyEntry:
        """Record ``entry`` and return the entry actually stored.

        A handle that already has a key keeps it; a key string that is taken is
        suffixed until it is free.
        """
        handle = (entry.model, str(entry.idx))
        stored = self._by_handle.get(handle)
        if stored is not None:
            return stored
        key = entry.key
        if key in self._by_key:
            other = self._by_key[key]
            suffix = 2
            while f"{key}~{suffix}" in self._by_key:
                suffix += 1
            new_key = f"{key}~{suffix}"
            self.problems.append(
                f"key {key} of {entry.model} {entry.idx} is already held by "
                f"{other.model} {other.idx}; stored as {new_key}"
            )
            entry = KeyEntry(
                key=new_key,
                bucket=entry.bucket,
                model=entry.model,
                idx=entry.idx,
                source=entry.source,
            )
        self._entries.append(entry)
        self._by_handle[handle] = entry
        self._by_key[entry.key] = entry
        return entry

    def key_of(self, model: str, idx: int | str) -> str | None:
        """The key of a ``(model, idx)`` handle, or ``None``."""
        entry = self._by_handle.get((model, str(idx)))
        return entry.key if entry is not None else None

    def entry_of(self, key: str) -> KeyEntry | None:
        """The entry stored under ``key``, or ``None``."""
        return self._by_key.get(key)

    def entries(self) -> list[KeyEntry]:
        """Every entry, in assignment order."""
        return list(self._entries)

    def has(self, model: str, idx: int | str) -> bool:
        """Whether a ``(model, idx)`` handle already has a key."""
        return (model, str(idx)) in self._by_handle

    def retain(self, handles: set[tuple[str, str]]) -> None:
        """Drop every entry whose ``(model, idx)`` handle is not in ``handles``.

        ``idx`` is compared as ``str``, as everywhere in the book. The entries
        that stay keep their order and their keys; a handle that is assigned
        again after being dropped gets a key afresh.
        """
        kept = [
            entry
            for entry in self._entries
            if (entry.model, str(entry.idx)) in handles
        ]
        self._entries = kept
        self._by_handle = {
            (entry.model, str(entry.idx)): entry for entry in kept
        }
        self._by_key = {entry.key: entry for entry in kept}
