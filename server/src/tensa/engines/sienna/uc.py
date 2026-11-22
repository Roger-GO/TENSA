"""The neutral result of a Sienna unit commitment, from the uc JSON.

Pure Python, mirroring ``dispatch.py``'s contract: every function takes plain
mappings (the parsed JSON) and the key book. ``UcRequestError`` lives here and
not in ``tensa.core.errors`` because the unit's paths do not include that
module; it is a :class:`DispatchRequestError`, so the worker and the route
treat it exactly as the dispatch's own request errors.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from tensa.core.errors import short_repr
from tensa.engines.keys import KeyBook
from tensa.engines.sienna.convert import _float, _int, _rows, _text
from tensa.engines.sienna.dispatch import DispatchRequestError

# The network models a unit commitment takes: the linear ones, never "ac"
# (the dispatch's tuple holds "ac"; a commitment is a MILP).
NETWORK_MODELS = ("copper_plate", "dc", "ptdf")
# The period lengths the engine takes, in minutes.
RESOLUTION_MINUTES = (15, 30, 60)
# The horizon bounds, in hours.
HORIZON_HOURS_MIN = 1
HORIZON_HOURS_MAX = 168

# The override fields the engine takes, named for the refusal message.
OVERRIDE_FIELDS = ("startup_cost", "min_up_h", "min_down_h", "must_run")


class UcRequestError(DispatchRequestError):
    """A unit commitment request the Sienna engine does not take.

    A :class:`DispatchRequestError`, so the worker and the route treat it
    exactly as the dispatch's own request errors: the category is the class
    name and the route answers 422.
    """


@dataclass
class UcGenerator:
    """One committed generator: its on/off and MW per period, bus, id and costs."""

    bus: int
    id: str
    on: list[bool]
    p_mw: list[float]
    energy: float
    startup: float
    fixed: float


@dataclass
class UcCost:
    """The objective split over the horizon: energy, start-up, fixed, total."""

    energy: float
    startup: float
    fixed: float
    total: float


@dataclass
class UcResult:
    """The neutral result of one unit commitment."""

    status: str
    network_model: str
    horizon_h: int
    resolution_min: int
    periods: list[str]
    base_mva: float
    objective: float
    objective_check: float
    cost: UcCost
    total_load_mw: list[float]
    generators: dict[str, UcGenerator]
    slacks: list[dict[str, Any]]
    parameters: list[str]
    expressions: list[str]
    keys: dict[str, dict[str, str]]
    notes: list[str]


def check_uc_request(
    network_model: object,
    horizon_h: object,
    resolution_min: object,
    series: object,
) -> None:
    """Validate a unit commitment request, before any Julia call.

    The messages mirror ``run_pflow`` and ``check_network_model``'s
    (``short_repr`` for values). Anything the request gets wrong raises
    :class:`UcRequestError`; nothing has run when it is raised.
    """
    if network_model not in NETWORK_MODELS:
        raise UcRequestError(
            f"network_model must be copper_plate, dc or ptdf, got "
            f"{short_repr(network_model)}"
        )
    if (
        isinstance(horizon_h, bool)
        or not isinstance(horizon_h, int)
        or horizon_h < HORIZON_HOURS_MIN
        or horizon_h > HORIZON_HOURS_MAX
    ):
        raise UcRequestError(
            f"horizon_h must be a whole number of hours from "
            f"{HORIZON_HOURS_MIN} to {HORIZON_HOURS_MAX}, got "
            f"{short_repr(horizon_h)}"
        )
    if isinstance(resolution_min, bool) or resolution_min not in RESOLUTION_MINUTES:
        raise UcRequestError(
            f"resolution_min must be 15, 30 or 60, got {short_repr(resolution_min)}"
        )
    assert isinstance(resolution_min, int)  # noqa: S101 - in RESOLUTION_MINUTES
    if horizon_h * 60 % resolution_min != 0:
        raise UcRequestError(
            f"horizon_h must be a whole number of periods at resolution_min "
            f"{resolution_min}"
        )
    expected = horizon_h * 60 // resolution_min
    if not isinstance(series, list) or not series or len(series) != expected:
        raise UcRequestError(
            f"series must give one factor per period: {expected} periods of "
            f"{resolution_min} minutes over {horizon_h} hours, got "
            f"{short_repr(series)}"
        )
    for i, factor in enumerate(series, start=1):
        if (
            isinstance(factor, bool)
            or not isinstance(factor, int | float)
            or not math.isfinite(float(factor))
            or float(factor) <= 0.0
        ):
            raise UcRequestError(
                f"series factors must be finite numbers above 0, got "
                f"{short_repr(factor)} at period {i}"
            )


def check_uc_overrides(
    overrides: object, book: KeyBook
) -> dict[str, dict[str, Any]]:
    """Validate the per-generator block and turn keys into component names.

    The request addresses generators by key; Julia sees only names. A key the
    book does not hold as a generator, an unknown field, or a value of the
    wrong shape raises :class:`UcRequestError`.
    """
    if overrides is None:
        return {}
    if not isinstance(overrides, dict):
        raise UcRequestError(
            f"overrides must be a mapping of generator key to fields, got "
            f"{short_repr(overrides)}"
        )
    named: dict[str, dict[str, Any]] = {}
    for key, fields in overrides.items():
        entry = book.entry_of(str(key))
        if entry is None or entry.bucket != "generator":
            raise UcRequestError(f"no generator with key {short_repr(key)}")
        if not isinstance(fields, dict):
            raise UcRequestError(
                f"the overrides of {key} must be a mapping of field to value, "
                f"got {short_repr(fields)}"
            )
        out: dict[str, Any] = {}
        for field, value in fields.items():
            if field not in OVERRIDE_FIELDS:
                raise UcRequestError(
                    f"unknown override field {short_repr(field)} for {key}; "
                    f"the fields are startup_cost, min_up_h, min_down_h, must_run"
                )
            if field == "must_run":
                if not isinstance(value, bool):
                    raise UcRequestError(
                        f"must_run must be true or false, got "
                        f"{short_repr(value)} for {key}"
                    )
                out[field] = value
            else:
                if (
                    isinstance(value, bool)
                    or not isinstance(value, int | float)
                    or not math.isfinite(float(value))
                    or float(value) < 0.0
                ):
                    raise UcRequestError(
                        f"{field} must be a finite number of dollars or hours "
                        f"at or above 0, got {short_repr(value)} for {key}"
                    )
                out[field] = float(value)
        named[str(entry.idx)] = out
    return named


def uc_result(payload: dict[str, Any], book: KeyBook) -> UcResult:
    """The uc JSON as a :class:`UcResult`.

    ``generators`` is keyed by the PowerSystems component name (the idx), as
    ``dispatch_result`` keys ``generators`` by name. ``keys`` has one entry,
    ``"generator"``: the key of each generator the book holds, found by
    matching the book's entries' idx to the component names.
    """
    generators: dict[str, UcGenerator] = {}
    for row in _rows(payload, "generators"):
        name = _text(row.get("name"))
        generators[name] = UcGenerator(
            bus=_int(row.get("bus")),
            id=_text(row.get("id")),
            on=[bool(v) for v in row.get("on", [])],
            p_mw=[_float(v) for v in row.get("p_mw", [])],
            energy=_float(row.get("energy")),
            startup=_float(row.get("startup")),
            fixed=_float(row.get("fixed")),
        )
    key_by_idx: dict[str, str] = {}
    for entry in book.entries():
        if entry.bucket == "generator":
            key_by_idx[str(entry.idx)] = entry.key
    generator_keys = {
        name: key_by_idx[name] for name in generators if name in key_by_idx
    }
    cost_row = payload.get("cost") or {}
    notes: list[str] = []
    for note in payload.get("notes", []):
        if isinstance(note, str):
            notes.append(note)
        elif isinstance(note, dict):
            notes.append(_text(note.get("text")))
    return UcResult(
        status=_text(payload.get("status")),
        network_model=_text(payload.get("network_model")),
        horizon_h=_int(payload.get("horizon_h")),
        resolution_min=_int(payload.get("resolution_min")),
        periods=[_text(p) for p in payload.get("periods", [])],
        base_mva=_float(payload.get("base_mva")),
        objective=_float(payload.get("objective")),
        objective_check=_float(payload.get("objective_check")),
        cost=UcCost(
            energy=_float(cost_row.get("energy")),
            startup=_float(cost_row.get("startup")),
            fixed=_float(cost_row.get("fixed")),
            total=_float(cost_row.get("total")),
        ),
        total_load_mw=[_float(v) for v in payload.get("total_load_mw", [])],
        generators=generators,
        slacks=[dict(row) for row in _rows(payload, "slacks")],
        parameters=[_text(name) for name in payload.get("parameters", [])],
        expressions=[_text(name) for name in payload.get("expressions", [])],
        keys={"generator": generator_keys},
        notes=notes,
    )
