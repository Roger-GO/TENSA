"""Read the identity columns of a case file, without an engine.

Section 4 of ``design/multiengine/spec.md``: engines lose the identifiers a case
file gives its elements (ANDES keeps file order but drops the circuit id of a
branch and the id of a load or shunt; PowerSystems keeps ids but not file order),
so TENSA reads the file itself. This module is that reader. It is pure Python,
imports no engine, and does not interpret electrical data beyond what an identity
needs (which bus, which id, in which order).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass


class IdentityError(ValueError):
    """A case file whose identity cannot be read (unknown extension, unsupported revision)."""


@dataclass(frozen=True)
class BranchId:
    """One non-transformer branch or two-winding transformer record.

    ``from_bus`` and ``to_bus`` are the ``I`` and ``J`` fields (``J`` taken by
    absolute value: PSS/E uses its sign as a metering flag). ``ckt`` is the
    ``CKT`` field stripped of quotes and spaces, ``"1"`` when the format has
    none. ``transformer`` is True for a two-winding transformer record.
    """

    from_bus: int
    to_bus: int
    ckt: str
    transformer: bool


@dataclass(frozen=True)
class Transformer3Id:
    """One three-winding transformer record: buses ``I``, ``J``, ``K`` and ``CKT``."""

    buses: tuple[int, int, int]
    ckt: str


@dataclass(frozen=True)
class DeviceId:
    """One device on a bus: the bus number and the PSS/E ``ID`` field stripped.

    For a format with no id (MATPOWER), ``id`` is the ordinal of the device on
    that bus as a string, from ``"1"``.
    """

    bus: int
    id: str


@dataclass(frozen=True)
class CaseIdentity:
    """The identity of every element a case file names, in file order."""

    format: str
    version: int | None
    base_mva: float | None
    freq_hz: float | None
    buses: tuple[int, ...]
    isolated_buses: tuple[int, ...]
    swing_buses: tuple[int, ...]
    loads: tuple[DeviceId, ...]
    fixed_shunts: tuple[DeviceId, ...]
    switched_shunts: tuple[DeviceId, ...]
    generators: tuple[DeviceId, ...]
    branches: tuple[BranchId, ...]
    transformers3: tuple[Transformer3Id, ...]
    area_slack_buses: dict[int, int]
    counts: dict[str, int]
    unread_blocks: tuple[str, ...]


# ---------------------------------------------------------------------------
# PSS/E RAW block layout per revision, as andes/io/psse.py describes it.
# ---------------------------------------------------------------------------

# Blocks of each revision, in file order, without the trailing "Q" marker.
# Names match psse.py's so counts and unread_blocks read the same.
_BLOCKS_33: tuple[str, ...] = (
    "bus", "load", "fshunt", "gen", "branch", "transf", "area",
    "twotermdc", "vscdc", "impedcorr", "mtdc", "msline", "zone",
    "interarea", "owner", "facts", "swshunt", "gne",
)
_BLOCKS_34: tuple[str, ...] = (
    "bus", "load", "fshunt", "gen", "branch", "swdev", "transf",
    "area", "twotermdc", "vscdc", "impedcorr", "mtdc", "msline",
    "zone", "interarea", "owner", "facts", "swshunt", "gne",
    "indmach", "substation",
)
_BLOCKS_BY_REVISION: dict[int, tuple[str, ...]] = {
    32: _BLOCKS_33,
    33: _BLOCKS_33,
    34: _BLOCKS_34,
}

# Blocks after the transformer block that this reader turns into identity.
# Everything else non-empty there is reported in unread_blocks.
_READ_AFTER_TRANSF: frozenset[str] = frozenset({"area", "swshunt"})


def _split_quoted(line: str, separator: str) -> list[str]:
    """Split ``line`` on ``separator``, ignoring separators inside single quotes."""
    parts: list[str] = []
    current: list[str] = []
    in_quotes = False
    for char in line:
        if char == "'":
            in_quotes = not in_quotes
            current.append(char)
        elif char == separator and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


def _strip_field(text: str) -> str:
    """Strip surrounding spaces and one pair of single quotes, then spaces again."""
    text = text.strip()
    if len(text) >= 2 and text[0] == "'" and text[-1] == "'":
        text = text[1:-1]
    return text.strip()


def _fields(line: str) -> list[str]:
    """The comma-separated fields of a data line, comment after ``/`` dropped.

    Quoted strings may contain commas and slashes; quotes are removed and each
    field stripped of surrounding spaces.
    """
    data_part = _split_quoted(line, "/")[0]
    return [_strip_field(part) for part in _split_quoted(data_part, ",")]


def _int_field(text: str) -> int:
    """An integer field, which PSS/E may write with a decimal point."""
    return int(float(text))


def read_psse_raw_identity(text: str) -> CaseIdentity:
    """Read the identity of a PSS/E RAW file (revisions 32, 33 and 34).

    The revision is the third field of the first header line (``REV``); a header
    with no usable revision is read as 33. ``base_mva`` is the header's
    ``SBASE``, ``freq_hz`` its ``BASFRQ`` when present and positive. A bus with
    ``IDE`` 4 goes to ``isolated_buses`` (and stays in ``buses``), ``IDE`` 3 to
    ``swing_buses``. A branch's ``J`` is taken by absolute value. An area record
    with a non-zero ``ISW`` gives an ``area_slack_buses`` entry.
    """
    lines = text.splitlines()
    if not lines:
        raise IdentityError("empty PSS/E RAW file")

    header = _fields(lines[0])
    version: int | None = None
    if len(header) >= 3:
        try:
            version = int(header[2])
        except ValueError:
            version = None
    if version is None:
        version = 33
    if version not in _BLOCKS_BY_REVISION:
        raise IdentityError(
            f"unsupported PSS/E RAW revision {version}; supported: 32, 33, 34"
        )
    blocks = _BLOCKS_BY_REVISION[version]

    base_mva: float | None = None
    if len(header) >= 2:
        try:
            base_mva = float(header[1])
        except ValueError:
            base_mva = None
    freq_hz: float | None = None
    if len(header) >= 6:
        try:
            freq = float(header[5])
        except ValueError:
            freq = 0.0
        if freq > 0:
            freq_hz = freq

    counts: dict[str, int] = dict.fromkeys(blocks, 0)
    buses: list[int] = []
    isolated_buses: list[int] = []
    swing_buses: list[int] = []
    loads: list[DeviceId] = []
    fixed_shunts: list[DeviceId] = []
    switched_shunts: list[DeviceId] = []
    generators: list[DeviceId] = []
    plain_branches: list[BranchId] = []
    transformers2: list[BranchId] = []
    transformers3: list[Transformer3Id] = []
    area_slack_buses: dict[int, int] = {}

    # Revision 34 files open with an extra "END OF SYSTEM-WIDE DATA" delimiter
    # before the bus block; psse.py starts its block counter at -1 for them.
    block_idx = -1 if version >= 34 else 0
    # Lines of the multi-line record being collected (transformers only).
    pending: list[list[str]] = []

    def flush_transformer(record: list[list[str]]) -> None:
        first = record[0]
        i_bus = _int_field(first[0])
        j_bus = abs(_int_field(first[1]))
        k_bus = _int_field(first[2]) if len(first) > 2 else 0
        ckt = first[3] if len(first) > 3 and first[3] else "1"
        counts["transf"] += 1
        if k_bus == 0:
            transformers2.append(BranchId(i_bus, j_bus, ckt, transformer=True))
        else:
            transformers3.append(Transformer3Id((i_bus, j_bus, k_bus), ckt))

    def take_record(block: str, record: list[list[str]]) -> None:
        if block == "transf":
            flush_transformer(record)
            return
        counts[block] += 1
        row = record[0]
        if block == "bus":
            number = _int_field(row[0])
            buses.append(number)
            ide = _int_field(row[3]) if len(row) > 3 else 1
            if ide == 4:
                isolated_buses.append(number)
            elif ide == 3:
                swing_buses.append(number)
        elif block == "load":
            loads.append(DeviceId(_int_field(row[0]), row[1] if len(row) > 1 else "1"))
        elif block == "fshunt":
            fixed_shunts.append(
                DeviceId(_int_field(row[0]), row[1] if len(row) > 1 else "1")
            )
        elif block == "gen":
            generators.append(
                DeviceId(_int_field(row[0]), row[1] if len(row) > 1 else "1")
            )
        elif block == "branch":
            ckt = row[2] if len(row) > 2 and row[2] else "1"
            plain_branches.append(
                BranchId(_int_field(row[0]), abs(_int_field(row[1])), ckt, transformer=False)
            )
        elif block == "area":
            isw = _int_field(row[1]) if len(row) > 1 else 0
            if isw != 0:
                area_slack_buses[_int_field(row[0])] = isw
        elif block == "swshunt":
            switched_shunts.append(DeviceId(_int_field(row[0]), "1"))

    for raw_line in lines[3:]:
        line = raw_line.strip()
        if not line or line.startswith("@!"):
            continue
        if line[0] == "Q":
            break
        first_fields = _fields(line)
        if first_fields and first_fields[0] == "0":
            # Block terminator: a line whose first field is 0. The comment
            # after "/" may name the next block; the order is relied on instead.
            if block_idx == 0 and not pending and not any(counts.values()):
                # A revision 33 file may open with an "END OF SYSTEM-WIDE
                # DATA" delimiter before the bus block; it is not a block of
                # its own, so the block counter does not move for it.
                continue
            pending = []
            block_idx += 1
            continue
        if block_idx < 0 or block_idx >= len(blocks):
            # Data before the first delimiter (rev 34 system-wide block) or
            # past the last known block: counted nowhere, never fatal.
            continue
        block = blocks[block_idx]
        pending.append(first_fields)
        if block == "transf":
            # A transformer record is four lines (two-winding, K == 0) or five
            # (three-winding); the first line's third field tells them apart.
            k_bus = _int_field(first_fields[2]) if len(first_fields) > 2 else 0
            want = 4 if k_bus == 0 else 5
            if len(pending) >= want:
                take_record(block, pending)
                pending = []
        else:
            take_record(block, pending)
            pending = []

    unread = tuple(
        name
        for name in blocks[blocks.index("transf") + 1:]
        if counts[name] > 0 and name not in _READ_AFTER_TRANSF
    )

    return CaseIdentity(
        format="psse-raw",
        version=version,
        base_mva=base_mva,
        freq_hz=freq_hz,
        buses=tuple(buses),
        isolated_buses=tuple(isolated_buses),
        swing_buses=tuple(swing_buses),
        loads=tuple(loads),
        fixed_shunts=tuple(fixed_shunts),
        switched_shunts=tuple(switched_shunts),
        generators=tuple(generators),
        branches=tuple(plain_branches + transformers2),
        transformers3=tuple(transformers3),
        area_slack_buses=area_slack_buses,
        counts=counts,
        unread_blocks=unread,
    )


# ---------------------------------------------------------------------------
# MATPOWER .m
# ---------------------------------------------------------------------------

_MATRIX_START = re.compile(r"\s*mpc\.(bus|gen|branch)\s*=\s*\[")
_BASE_MVA = re.compile(r"\s*mpc\.baseMVA\s*=\s*([0-9.eE+-]+)")


def _matpower_rows(text: str, name: str) -> list[list[float]]:
    """The rows of the ``mpc.<name>`` matrix, as floats.

    Rows are separated by ``;`` or newlines, ``%`` starts a comment and ``...``
    continues a line. The matrix ends at ``]``.
    """
    start = re.compile(r"\s*mpc\." + name + r"\s*=\s*\[")
    rows: list[list[float]] = []
    in_matrix = False
    carried = ""
    for raw_line in text.splitlines():
        line = raw_line.split("%", 1)[0]
        if not in_matrix:
            if start.search(line):
                in_matrix = True
                line = line.split("[", 1)[1]
            else:
                continue
        if "..." in line:
            carried += line.split("...", 1)[0] + " "
            continue
        line = carried + line
        carried = ""
        end = "]" in line
        if end:
            line = line.split("]", 1)[0]
        for row_text in line.split(";"):
            row_text = row_text.strip()
            if not row_text:
                continue
            try:
                rows.append([float(value) for value in row_text.split()])
            except ValueError as exc:
                raise IdentityError(
                    f"cannot parse a row of mpc.{name}: {row_text!r}"
                ) from exc
        if end:
            break
    return rows


def read_matpower_identity(text: str) -> CaseIdentity:
    """Read the identity of a MATPOWER ``.m`` case.

    Buses are in row order; type 3 goes to ``swing_buses``, type 4 to
    ``isolated_buses``. A bus row with non-zero ``Pd`` or ``Qd`` gives one load
    with id ``"1"``; non-zero ``Gs`` or ``Bs`` gives one fixed shunt with id
    ``"1"``. A generator's id is its ordinal on its bus. A branch row is a
    transformer when its ``ratio`` column is non-zero; ``ckt`` is the ordinal
    among the rows with the same unordered bus pair, from ``"1"``. ``freq_hz``
    is None: the format does not give it.
    """
    base_mva: float | None = None
    match = _BASE_MVA.search(text)
    if match:
        base_mva = float(match.group(1))

    bus_rows = _matpower_rows(text, "bus")
    gen_rows = _matpower_rows(text, "gen")
    branch_rows = _matpower_rows(text, "branch")

    buses: list[int] = []
    isolated_buses: list[int] = []
    swing_buses: list[int] = []
    loads: list[DeviceId] = []
    fixed_shunts: list[DeviceId] = []
    for row in bus_rows:
        number = int(row[0])
        buses.append(number)
        bus_type = int(row[1])
        if bus_type == 3:
            swing_buses.append(number)
        elif bus_type == 4:
            isolated_buses.append(number)
        if row[2] != 0.0 or row[3] != 0.0:
            loads.append(DeviceId(number, "1"))
        if row[4] != 0.0 or row[5] != 0.0:
            fixed_shunts.append(DeviceId(number, "1"))

    generators: list[DeviceId] = []
    gen_ordinals: dict[int, int] = {}
    for row in gen_rows:
        bus = int(row[0])
        gen_ordinals[bus] = gen_ordinals.get(bus, 0) + 1
        generators.append(DeviceId(bus, str(gen_ordinals[bus])))

    plain_branches: list[BranchId] = []
    transformers2: list[BranchId] = []
    pair_ordinals: dict[tuple[int, int], int] = {}
    for row in branch_rows:
        from_bus = int(row[0])
        to_bus = int(row[1])
        pair = (min(from_bus, to_bus), max(from_bus, to_bus))
        pair_ordinals[pair] = pair_ordinals.get(pair, 0) + 1
        ckt = str(pair_ordinals[pair])
        ratio = row[8] if len(row) > 8 else 0.0
        branch = BranchId(from_bus, to_bus, ckt, transformer=ratio != 0.0)
        if branch.transformer:
            transformers2.append(branch)
        else:
            plain_branches.append(branch)

    counts = {
        "bus": len(bus_rows),
        "gen": len(gen_rows),
        "branch": len(branch_rows),
    }

    return CaseIdentity(
        format="matpower",
        version=None,
        base_mva=base_mva,
        freq_hz=None,
        buses=tuple(buses),
        isolated_buses=tuple(isolated_buses),
        swing_buses=tuple(swing_buses),
        loads=tuple(loads),
        fixed_shunts=tuple(fixed_shunts),
        switched_shunts=(),
        generators=tuple(generators),
        branches=tuple(plain_branches + transformers2),
        transformers3=(),
        area_slack_buses={},
        counts=counts,
        unread_blocks=(),
    )


def read_identity(path: str | os.PathLike[str]) -> CaseIdentity:
    """Read the identity of a case file, picking the reader by extension.

    ``.raw`` goes to the PSS/E reader, ``.m`` to the MATPOWER one; anything
    else raises ``IdentityError``. The file is read as UTF-8, falling back to
    Latin-1.
    """
    file_path = path if isinstance(path, str) else os.fspath(path)
    extension = os.path.splitext(file_path)[1].lower()
    if extension not in (".raw", ".m"):
        raise IdentityError(
            f"unsupported case file extension {extension!r}; expected '.raw' or '.m'"
        )
    try:
        with open(file_path, encoding="utf-8") as handle:
            text = handle.read()
    except UnicodeDecodeError:
        with open(file_path, encoding="latin-1") as handle:
            text = handle.read()
    if extension == ".raw":
        return read_psse_raw_identity(text)
    return read_matpower_identity(text)
