"""The timed events a case carries that its client did not schedule.

A case file can define events of its own, and so can its add-on files: ANDES's bundled
``kundur_full.xlsx`` has a ``Toggle`` that trips ``Line_8`` at 2 s, and ``ieee14.dyr``
trips ``Line_1`` at 1 s and recloses it at 1.1 s, so a time-domain run of either swings
with nothing scheduled in the UI. A bundle or a snapshot that is imported or restored
replays the disturbances it recorded onto the new System in the same way. None of these
is in the list the client keeps, so the topology names them for it:

- ``source="case"``: a ``Fault``, ``Toggle`` or ``Alter`` device the case file (or an
  add-on file) defines, read from the System right after it is loaded and before
  anything is added to it;
- ``source="restored"``: a disturbance a bundle import or a snapshot restore replayed.

What a client commits itself (``POST /sessions/{id}/disturbances``) is not reported:
the client already holds it.

A device is left out when it cannot act. ANDES skips a device whose ``u`` is 0, and a
``TimerParam`` below zero (its default is -1) is deactivated, so a ``Toggle`` with no
time, or a ``Fault`` that starts at -1, never fires.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from tensa.core.disturbance import AlterSpec, DisturbanceSpec, FaultSpec, ToggleSpec

EventSource = Literal["case", "restored"]
EventKind = Literal["fault", "toggle", "alter"]


@dataclass
class CaseEvent:
    """One timed event the next time-domain run will apply, besides the client's own.

    ``t`` is when it starts (a fault's ``tf``). The other fields depend on ``kind``:
    a fault has ``tc`` and names its bus as ``dev_idx`` (``model`` is ``"Bus"``), a
    toggle names the device it flips, and an alter also has the parameter ``src``
    changed by ``method`` and ``amount``.
    """

    source: EventSource
    kind: EventKind
    t: float
    name: str | None = None
    tc: float | None = None
    model: str | None = None
    dev_idx: int | str | None = None
    src: str | None = None
    method: str | None = None
    amount: float | None = None


def events_in_case(ss: Any) -> list[CaseEvent]:
    """The events the case file defines, from the System just loaded from it.

    ``ss`` is still before ``setup()`` and nothing has been added to it, so every
    ``Fault``, ``Toggle`` and ``Alter`` device it holds came from the case's files.
    """
    events = [*_faults(ss), *_toggles(ss), *_alters(ss)]
    return sorted(events, key=lambda event: event.t)


def event_from_spec(spec: DisturbanceSpec) -> CaseEvent:
    """The event a disturbance spec a bundle or snapshot replayed amounts to."""
    if isinstance(spec, FaultSpec):
        return CaseEvent(
            source="restored",
            kind="fault",
            t=spec.tf,
            tc=spec.tc if spec.tc >= 0 else None,
            model="Bus",
            dev_idx=spec.bus_idx,
        )
    if isinstance(spec, ToggleSpec):
        return CaseEvent(
            source="restored",
            kind="toggle",
            t=spec.t,
            model=spec.model,
            dev_idx=spec.dev_idx,
        )
    assert isinstance(spec, AlterSpec)
    return CaseEvent(
        source="restored",
        kind="alter",
        t=spec.t,
        model=spec.model,
        dev_idx=spec.dev_idx,
        src=spec.src,
        method=spec.method,
        amount=spec.amount,
    )


def _faults(ss: Any) -> list[CaseEvent]:
    events: list[CaseEvent] = []
    for row in _rows(ss, "Fault", ("bus", "tf", "tc")):
        tf = _number(row["tf"])
        if tf is None or tf < 0:
            continue
        tc = _number(row["tc"])
        events.append(
            CaseEvent(
                source="case",
                kind="fault",
                t=tf,
                name=row["name"],
                tc=tc if tc is not None and tc >= 0 else None,
                model="Bus",
                dev_idx=_native(row["bus"]),
            )
        )
    return events


def _toggles(ss: Any) -> list[CaseEvent]:
    events: list[CaseEvent] = []
    for row in _rows(ss, "Toggle", ("model", "dev", "t")):
        t = _number(row["t"])
        if t is None or t < 0:
            continue
        events.append(
            CaseEvent(
                source="case",
                kind="toggle",
                t=t,
                name=row["name"],
                model=_text(row["model"]),
                dev_idx=_native(row["dev"]),
            )
        )
    return events


def _alters(ss: Any) -> list[CaseEvent]:
    events: list[CaseEvent] = []
    for row in _rows(ss, "Alter", ("model", "dev", "src", "t", "method", "amount")):
        t = _number(row["t"])
        if t is None or t < 0:
            continue
        events.append(
            CaseEvent(
                source="case",
                kind="alter",
                t=t,
                name=row["name"],
                model=_text(row["model"]),
                dev_idx=_native(row["dev"]),
                src=_text(row["src"]),
                method=_text(row["method"]),
                amount=_number(row["amount"]),
            )
        )
    return events


def _rows(ss: Any, model_name: str, columns: tuple[str, ...]) -> list[dict[str, Any]]:
    """The devices of one event model that can act, one dict per device.

    Each dict has the ``columns``, plus ``name``. A device whose connectivity ``u``
    is 0 is skipped.
    """
    model = getattr(ss, model_name, None)
    idx_values = _values(model, "idx")
    if not idx_values:
        return []
    names = _values(model, "name")
    online = _values(model, "u")
    data = {column: _values(model, column) for column in columns}
    rows: list[dict[str, Any]] = []
    for i, idx in enumerate(idx_values):
        if i < len(online) and _number(online[i]) == 0:
            continue
        row: dict[str, Any] = {
            column: values[i] if i < len(values) else None for column, values in data.items()
        }
        row["name"] = str(names[i]) if i < len(names) else str(idx)
        rows.append(row)
    return rows


def _values(model: Any, param: str) -> list[Any]:
    values = getattr(getattr(model, param, None), "v", None)
    return [] if values is None else list(values)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # NaN is no time


def _text(value: Any) -> str | None:
    return None if value is None else str(value)


def _native(value: Any) -> int | str | None:
    """An idx as a plain ``int`` or ``str``: ANDES hands back numpy scalars too."""
    if value is None:
        return None
    item = value.item() if hasattr(value, "item") else value
    return item if isinstance(item, int | str) else str(item)
