"""The neutral result of a Sienna multi-stage simulation, from the sim JSON.

Pure Python, mirroring ``dispatch.py``'s contract: every function takes plain
mappings (the parsed JSON) and the key book. ``SimRequestError`` is a
:class:`DispatchRequestError`, so the worker and the route treat it exactly as
the dispatch's own request errors.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from tensa.engines.keys import KeyBook
from tensa.engines.sienna.convert import _float, _int, _rows, _text
from tensa.engines.sienna.dispatch import DispatchRequestError

# The message of a load profile whose length is not 96. The Julia module
# (TensaSiennaOps.jl, BAD_PROFILE) throws the same string; the Python check
# fires first for requests over the wire.
BAD_PROFILE_MESSAGE = (
    "load_profile must hold 96 numbers, one per 15-minute step of the day"
)

PROFILE_STEPS: int = 96
PROFILE_STEP_MINUTES: int = 15


class SimRequestError(DispatchRequestError):
    """A sim request the Sienna engine does not take, named for the user.

    A :class:`DispatchRequestError`, so the worker sends its class name as
    the error category and the route answers 422. Nothing has run when it is
    raised: the caller changes the request or the case.
    """


def check_load_profile(profile: object) -> list[float]:
    """The load profile, validated; anything else is a :class:`SimRequestError`."""
    if not isinstance(profile, list) or len(profile) != PROFILE_STEPS:
        raise SimRequestError(BAD_PROFILE_MESSAGE)
    out: list[float] = []
    for entry in profile:
        if (
            isinstance(entry, bool)
            or not isinstance(entry, int | float)
            or not math.isfinite(float(entry))
            or float(entry) < 0.0
        ):
            raise SimRequestError(
                f"load_profile entries must be finite numbers >= 0, got {entry!r}"
            )
        out.append(float(entry))
    if all(v == 0.0 for v in out):
        raise SimRequestError("load_profile is all zero; the day has no load to serve")
    return out


@dataclass
class SimGeneratorSeries:
    """One generator's series in one stage: per-step values."""

    bus: int
    id: str
    values: list[float]  # MW for dispatch, 0/1 for commitment


@dataclass
class SimStageResult:
    """One stage of the simulation."""

    name: str  # "DA" or "RT"
    kind: str  # "uc" or "dispatch"
    resolution_minutes: int
    steps: int
    horizon_hours: float
    objective: float
    commitment: dict[str, SimGeneratorSeries]  # empty for the RT stage
    dispatch: dict[str, SimGeneratorSeries]


@dataclass
class SimResult:
    """The neutral result of one multi-stage simulation."""

    status: str
    network_model: str
    base_mva: float
    interval_minutes: int
    stages: list[SimStageResult]
    slacks: list[dict[str, Any]]
    store_dir: str
    keys: dict[str, dict[str, str]]
    notes: list[str]


def _series(row: dict[str, Any], field: str) -> SimGeneratorSeries:
    return SimGeneratorSeries(
        bus=_int(row.get("bus")),
        id=_text(row.get("id")),
        values=[_float(v) for v in row.get(field, [])],
    )


def sim_result(sim: dict[str, Any], book: KeyBook) -> SimResult:
    """The sim JSON as a :class:`SimResult`.

    ``commitment`` and ``dispatch`` of each stage are keyed by the
    PowerSystems component name (the idx), as ``dispatch_result`` keys
    ``generators`` by name. ``keys`` has one entry, ``"generator"``: the key
    of each generator the book holds, found by matching the book's entries'
    idx to the component names. A generator the book has no entry for is
    still in the stage and simply has no key.
    """
    stages: list[SimStageResult] = []
    for stage in _rows(sim, "stages"):
        commitment: dict[str, SimGeneratorSeries] = {}
        for row in _rows(stage, "commitment"):
            commitment[_text(row.get("name"))] = _series(row, "on")
        dispatch: dict[str, SimGeneratorSeries] = {}
        for row in _rows(stage, "dispatch"):
            dispatch[_text(row.get("name"))] = _series(row, "p_mw")
        stages.append(
            SimStageResult(
                name=_text(stage.get("name")),
                kind=_text(stage.get("kind")),
                resolution_minutes=_int(stage.get("resolution_minutes")),
                steps=_int(stage.get("steps")),
                horizon_hours=_float(stage.get("horizon_hours")),
                objective=_float(stage.get("objective")),
                commitment=commitment,
                dispatch=dispatch,
            )
        )
    key_by_idx: dict[str, str] = {}
    for entry in book.entries():
        if entry.bucket == "generator":
            key_by_idx[str(entry.idx)] = entry.key
    names: set[str] = set()
    for built in stages:
        names.update(built.commitment)
        names.update(built.dispatch)
    generator_keys = {name: key_by_idx[name] for name in names if name in key_by_idx}
    notes: list[str] = []
    for note in sim.get("notes", []):
        if isinstance(note, str):
            notes.append(note)
        elif isinstance(note, dict):
            notes.append(_text(note.get("text")))
    return SimResult(
        status=_text(sim.get("status")),
        network_model=_text(sim.get("network_model")),
        base_mva=_float(sim.get("base_mva")),
        interval_minutes=_int(sim.get("interval_minutes")),
        stages=stages,
        slacks=[dict(row) for row in _rows(sim, "slacks")],
        store_dir=_text(sim.get("store_dir")),
        keys={"generator": generator_keys},
        notes=notes,
    )
