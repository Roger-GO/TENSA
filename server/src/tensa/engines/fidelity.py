"""The fidelity states of the elements of a loaded case (spec section 8).

Four states for one dynamic model of one element, for one engine: ``exact``,
``known-difference:<id>``, ``unverified`` and ``unsupported``. ANDES is the
reference engine for the models it has (spec section 8), so every model it
holds is exact; a Sienna model of the common set is a known difference where
the register says so, exact where the audit register says so, and unverified
otherwise, and a model only Sienna simulates stays unverified until it is
checked against a published result.

The known-difference register (``known_differences.json`` beside this module)
and the audit register (``model_audits.json``) are read once at import, so a
malformed register fails the test suite at import time, never a session at
request time. It is pure Python and imports no engine.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from tensa.engines.keys import generator_key, unit_model_key
from tensa.engines.ops import ENGINE_NAMES
from tensa.engines.roles import role_of_model

EXACT: Final = "exact"
KNOWN_DIFFERENCE_PREFIX: Final = "known-difference:"
UNVERIFIED: Final = "unverified"
UNSUPPORTED: Final = "unsupported"

# The 14 models both engines simulate: the rows of
# ``design/multiengine/reports/model_matrix.md`` whose Status is ``both``.
COMMON_MODELS: Final = frozenset(
    {
        "ESAC1A",
        "ESST1A",
        "EXAC1",
        "EXST1",
        "SEXS",
        "IEEEST",
        "REECB1",
        "REGCA1",
        "REPCA1",
        "GENCLS",
        "GENROU",
        "GAST",
        "HYGOV",
        "TGOV1",
    }
)

_REGISTER_PATH: Final = Path(__file__).with_name("known_differences.json")
_AUDITS_PATH: Final = Path(__file__).with_name("model_audits.json")

# The fields a register entry carries, and which must be non-empty strings.
_STRING_FIELDS: Final = ("id", "model", "summary", "effect", "evidence", "check")


@dataclass(frozen=True)
class KnownDifference:
    """One entry of the known-difference register (spec section 8)."""

    id: str
    model: str
    engines: tuple[str, ...]
    summary: str
    effect: str
    small_signal: bool
    evidence: str
    check: str


def _register_error(index: int, field: str, problem: str) -> ValueError:
    return ValueError(f"known_differences.json entry {index}: {field} {problem}")


def _parse_entry(raw: Any, index: int) -> KnownDifference:
    """One register entry checked against the field rules."""
    if not isinstance(raw, dict):
        raise _register_error(index, "entry", "must be an object")
    values: dict[str, str] = {}
    for field in _STRING_FIELDS:
        value = raw.get(field)
        if not isinstance(value, str) or not value:
            raise _register_error(index, field, "must be a non-empty string")
        values[field] = value
    engines_raw = raw.get("engines")
    if (
        not isinstance(engines_raw, list)
        or len(engines_raw) != 2
        or not all(isinstance(name, str) for name in engines_raw)
        or len(set(engines_raw)) != 2
        or any(name not in ENGINE_NAMES for name in engines_raw)
    ):
        raise _register_error(
            index,
            "engines",
            f"must be a list of exactly two distinct engine names of {list(ENGINE_NAMES)}",
        )
    small_signal = raw.get("small_signal")
    if not isinstance(small_signal, bool):
        raise _register_error(index, "small_signal", "must be a bool")
    model = values["model"]
    if model not in COMMON_MODELS:
        raise _register_error(index, "model", f"{model} is not one of the common models")
    return KnownDifference(
        id=values["id"],
        model=model,
        engines=(str(engines_raw[0]), str(engines_raw[1])),
        summary=values["summary"],
        effect=values["effect"],
        small_signal=small_signal,
        evidence=values["evidence"],
        check=values["check"],
    )


def load_known_differences(path: Path | None = None) -> tuple[KnownDifference, ...]:
    """Parse the register. ``path`` defaults to ``known_differences.json`` beside
    this module. Raises ``ValueError`` naming the entry index and field for a
    missing or mistyped field, a duplicate ``id``, an ``engines`` list that does
    not name two engines, or a ``model`` not in ``COMMON_MODELS``."""
    file = _REGISTER_PATH if path is None else path
    raw = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"{file.name}: the register must be a JSON array")
    entries = [_parse_entry(row, index) for index, row in enumerate(raw)]
    seen: set[str] = set()
    for entry in entries:
        if entry.id in seen:
            raise ValueError(
                f"known_differences.json: duplicate id {entry.id}"
            )
        seen.add(entry.id)
    return tuple(entries)


def load_audited_models(path: Path | None = None) -> frozenset[tuple[str, str]]:
    """The ``(engine, model)`` pairs whose audit test passed, from
    ``model_audits.json`` beside this module. A missing file answers an empty
    set. When the file exists it is a JSON array of ``{"engine", "model",
    "test"}`` objects and a malformed one raises ``ValueError`` as the
    register's loader does."""
    file = _AUDITS_PATH if path is None else path
    if not file.is_file():
        return frozenset()
    raw = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"{file.name}: the audit register must be a JSON array")
    pairs: set[tuple[str, str]] = set()
    for index, row in enumerate(raw):
        if not isinstance(row, dict):
            raise ValueError(f"{file.name} entry {index}: entry must be an object")
        engine = row.get("engine")
        model = row.get("model")
        test = row.get("test")
        if not isinstance(engine, str) or engine not in ENGINE_NAMES:
            raise ValueError(
                f"{file.name} entry {index}: engine must be one of {list(ENGINE_NAMES)}"
            )
        if not isinstance(model, str) or not model:
            raise ValueError(f"{file.name} entry {index}: model must be a non-empty string")
        if not isinstance(test, str) or not test:
            raise ValueError(f"{file.name} entry {index}: test must be a non-empty string")
        pairs.add((engine, model))
    return frozenset(pairs)


KNOWN_DIFFERENCES: tuple[KnownDifference, ...] = load_known_differences()
AUDITED_MODELS: frozenset[tuple[str, str]] = load_audited_models()


def model_state(engine: str, model: str, *, unsupported: bool) -> str:
    """The fidelity state of one dynamic model of one element, for one engine.

    - ``unsupported`` true: ``"unsupported"`` (the caller adds ``handling``).
    - ANDES, any model: ``"exact"``. ANDES is the reference engine for the
      models it has (spec section 8), so its own models are exact unless
      unsupported.
    - Sienna, model in ``COMMON_MODELS`` with a register entry whose
      ``engines`` holds ``"sienna"``: ``"known-difference:<id>"``.
    - Sienna, model in ``COMMON_MODELS`` with ``("sienna", model)`` in
      ``AUDITED_MODELS``: ``"exact"``.
    - Sienna, model in ``COMMON_MODELS`` otherwise: ``"unverified"``.
    - Sienna, a model outside ``COMMON_MODELS``: ``"unverified"``.
    """
    if unsupported:
        return UNSUPPORTED
    if engine == "andes":
        return EXACT
    if model not in COMMON_MODELS:
        return UNVERIFIED
    for entry in KNOWN_DIFFERENCES:
        if entry.model == model and engine in entry.engines:
            return f"{KNOWN_DIFFERENCE_PREFIX}{entry.id}"
    if (engine, model) in AUDITED_MODELS:
        return EXACT
    return UNVERIFIED


def _unit_key_of(row: Mapping[str, Any]) -> str:
    """The unit key of a dynamics row or an unsupported report row: both carry
    the ``bus`` number and the record's ``id``, which is the generator's id on
    its bus (a dynamics row's ``generator`` is the PowerSystems component name,
    ``generator-<bus>-<id>``, and is not the id)."""
    return generator_key(int(row.get("bus", 0)), str(row.get("id", "")))


def fidelity_entries(
    engine: str,
    dynamics: list[Mapping[str, Any]],
    unsupported_rows: list[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """The fidelity entries of one loaded case: one per dynamic model that is
    not ``exact``, plus one per unsupported record, sorted by key.

    ``dynamics`` is the topology JSON's ``dynamics`` list (rows with
    ``model``, ``bus``, ``id`` and ``generator``); ``unsupported_rows`` is the report
    JSON's ``unsupported`` list (rows with ``model``, ``bus``, ``id``,
    ``reason``). An ``unsupported`` entry carries ``handling`` and ``reason``;
    a ``known-difference`` entry carries ``detail`` from the register.
    """
    entries: list[dict[str, Any]] = []
    for row in dynamics:
        model = str(row.get("model", ""))
        state = model_state(engine, model, unsupported=False)
        if state == EXACT:
            continue
        entry: dict[str, Any] = {
            "key": unit_model_key(_unit_key_of(row), role_of_model(model)),
            "model": model,
            "state": state,
        }
        if state.startswith(KNOWN_DIFFERENCE_PREFIX):
            entry_id = state[len(KNOWN_DIFFERENCE_PREFIX) :]
            for known in KNOWN_DIFFERENCES:
                if known.id == entry_id:
                    entry["detail"] = known.summary
                    break
        entries.append(entry)
    for row in unsupported_rows:
        model = str(row.get("model", ""))
        entries.append(
            {
                "key": unit_model_key(_unit_key_of(row), role_of_model(model)),
                "model": model,
                "state": UNSUPPORTED,
                "handling": "dropped",
                "reason": str(row.get("reason", "")),
            }
        )
    entries.sort(key=lambda entry: str(entry["key"]))
    return entries


def models_map(engine: str) -> dict[str, str]:
    """The ``models`` block of the capabilities of one engine (spec section 7):
    every model of ``COMMON_MODELS`` mapped to its state for that engine, by
    ``model_state(engine, model, unsupported=False)``. Sorted by model name."""
    return {
        model: model_state(engine, model, unsupported=False)
        for model in sorted(COMMON_MODELS)
    }
