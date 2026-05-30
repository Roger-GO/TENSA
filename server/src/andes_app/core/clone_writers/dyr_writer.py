"""PSS/E ``.dyr`` dynamics clone writer (Unit 21 / KTD-9).

CRITICAL writer requirement (from the Unit-0 spike): edit the target token
**in place**, preserving every other token and ALL sibling records. A naive
"tokenize the record → re-join the whole record" collapse drops sibling
devices of the same model (the spike observed editing the first of two
``ST2CUT`` records dropped it, leaving only the second). This writer locates
the target field by walking tokens with their source character offsets within
the matching ``(BUS, MODEL, ID)`` record and splices only that token's
character span, leaving the rest of the file byte-identical.

Record format: ``BUS 'MODEL' ID f0 f1 ... /`` — a record may span multiple
physical lines; fields follow the model's ``inputs`` order. The file inserts
the quoted model name between BUS and ID, so the file token for ``inputs[k]``
(k >= 1) is at file-token index ``k + 1`` (``inputs[0] == BUS`` is token 0).
``field_index`` in the spike index is the position in ``inputs``; the file
token to splice is therefore at ``field_index + 1``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from andes_app.core.clone_writers import DyrLocator, index_entry_for
from andes_app.core.errors import CloneEditError

# A value token is any run of non-whitespace characters that is not the lone
# ``/`` record terminator. Quoted model names (``'ST2CUT'``) are captured as a
# single token because they contain no whitespace.
_TOKEN_RE = re.compile(r"[^\s/]+")


@dataclass(frozen=True)
class _Token:
    text: str
    start: int  # absolute char offset into the file text
    end: int  # exclusive


@dataclass(frozen=True)
class _Record:
    tokens: list[_Token]


def _split_records(text: str) -> list[_Record]:
    """Split the file text into records on the ``/`` terminator.

    Tokens carry absolute character offsets so the caller can splice a single
    token without disturbing surrounding whitespace / sibling records. The
    ``/`` itself is not a token — it only closes the current record.
    """
    records: list[_Record] = []
    current: list[_Token] = []
    pos = 0
    n = len(text)
    while pos < n:
        ch = text[pos]
        if ch == "/":
            records.append(_Record(tokens=current))
            current = []
            pos += 1
            continue
        if ch.isspace():
            pos += 1
            continue
        match = _TOKEN_RE.match(text, pos)
        if match is None:  # pragma: no cover — defensive
            pos += 1
            continue
        current.append(_Token(text=match.group(0), start=match.start(), end=match.end()))
        pos = match.end()
    if current:
        # Trailing tokens with no closing ``/`` still form a record.
        records.append(_Record(tokens=current))
    return records


def _unquote(token: str) -> str:
    """Strip surrounding single/double quotes from a PSS/E identifier token."""
    if len(token) >= 2 and token[0] in "'\"" and token[-1] == token[0]:
        return token[1:-1]
    return token


def _format_value(value: Any) -> str:
    """Render ``value`` as a PSS/E-style numeric / token string.

    Integers stay bare; floats use ``repr`` (round-trippable). Strings pass
    through verbatim. The token is whitespace-free by construction so it
    splices cleanly into the record.
    """
    if isinstance(value, bool):
        # PSS/E flags are 0/1 ints, never Python True/False text.
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value == int(value):
            # Keep an integral float readable (``30.0`` not ``30``) so the
            # token stays a float for ANDES's reader.
            return f"{value:.1f}"
        return repr(value)
    return str(value)


def apply_edit(
    file_path: str | Path,
    model: str,
    idx: str,
    param: str,
    value: Any,
    *,
    locator: DyrLocator | None = None,
) -> None:
    """Splice ``model.param`` for the located device in the ``.dyr`` clone.

    ``locator`` carries the ``(bus, id)`` resolved from the loaded System;
    the writer matches the record whose BUS (token 0) and ID (token 2) equal
    the locator's, and whose model name (token 1, unquoted) equals ``model``.

    Raises :class:`CloneEditError` when the param is not ``.dyr``-editable (a
    ``null`` ``dyr`` entry in the spike index), when no matching record is
    found, or when the target token index is out of the record's range
    (malformed file).
    """
    path = Path(file_path)
    if locator is None:
        raise CloneEditError(
            f"a (bus, id) locator is required to edit {model}.{param} in a "
            ".dyr clone"
        )

    param_entry = index_entry_for(model, param)
    dyr_meta = param_entry.get("dyr")
    if not isinstance(dyr_meta, dict) or "field_index" not in dyr_meta:
        raise CloneEditError(
            f"param {param!r} on model {model!r} is not editable in .dyr "
            "format (it is an ANDES-added or derived param); edit the .xlsx "
            "form of the case instead, or use Save As to a .xlsx"
        )
    field_index = int(dyr_meta["field_index"])
    # file-token index = position in ``inputs`` + 1 (model name sits between
    # BUS (token 0) and the first non-BUS field).
    file_token_index = field_index + 1

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise CloneEditError(
            f"could not read clone file {path.name!r}: {exc}"
        ) from exc

    records = _split_records(text)
    bus_str = str(locator.bus)
    id_str = str(locator.id)

    target: _Record | None = None
    for record in records:
        toks = record.tokens
        if len(toks) < 3:
            continue
        if _unquote(toks[1].text) != model:
            continue
        if _normalize_numeric(toks[0].text) != _normalize_numeric(bus_str):
            continue
        if _normalize_numeric(toks[2].text) != _normalize_numeric(id_str):
            continue
        target = record
        break

    if target is None:
        raise CloneEditError(
            f"no {model} record matching bus={locator.bus!r} id={locator.id!r} "
            f"found in clone file {path.name!r}"
        )

    if file_token_index >= len(target.tokens):
        raise CloneEditError(
            f"{model} record at bus={locator.bus!r} has only "
            f"{len(target.tokens)} fields; cannot edit field at index "
            f"{file_token_index} ({param}). The .dyr record is malformed or "
            "truncated."
        )

    token = target.tokens[file_token_index]
    new_token = _format_value(value)
    # Splice ONLY this token's character span; everything before/after —
    # including sibling records, line breaks, and column alignment — is
    # preserved byte-for-byte.
    new_text = text[: token.start] + new_token + text[token.end :]

    try:
        path.write_text(new_text, encoding="utf-8")
    except OSError as exc:  # pragma: no cover — fs failure
        raise CloneEditError(
            f"could not write clone file {path.name!r}: {exc}"
        ) from exc


def _normalize_numeric(token: str) -> str:
    """Normalise a BUS / ID token for equality matching.

    ANDES surfaces a bus as ``1.0`` while the file holds ``1``; both should
    match. Falls back to the raw (unquoted) string for non-numeric IDs.
    """
    raw = _unquote(token)
    try:
        f = float(raw)
    except ValueError:
        return raw
    if f == int(f):
        return str(int(f))
    return repr(f)
