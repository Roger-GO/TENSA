"""Read the facts of a case file an engine's own reader can get wrong.

Decision 25 of ``design/multiengine/decisions.md``: the case file is the
reference for what a system is, and where an engine's reader departs from the
file its adapter puts the file's value back. Comparing ANDES and PowerSystems.jl
on six PSS/E cases found three such departures on the PowerSystems side: the
voltage setpoint of a generator bus (the file's ``VS``, not the bus record's
stored voltage), a transformer's off-nominal ratio (not snapped to a tap-step
grid), and the total line charging of a branch record. This module reads those
three facts from the file itself, without an engine, so an adapter can be handed
them. A fourth was found later: where a branch record gives no rating (0),
PowerSystems makes one up from the branch's impedance and voltage, so the
module also reads each branch's first rating. It is pure Python and imports
no engine.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

from tensa.engines.identity import (
    _BLOCKS_BY_REVISION,
    _fields,
    _int_field,
    _matpower_rows,
)


class CaseFactsError(ValueError):
    """A case file whose facts cannot be read.

    An unknown extension, an unsupported revision, two setpoints for one bus,
    or a transformer whose ratio needs a bus base voltage the file does not give.
    """


@dataclass(frozen=True)
class TransformerFact:
    """One two-winding transformer record: buses, circuit id, ratio and phase shift.

    ``from_bus``, ``to_bus`` and ``ckt`` are what ``tensa.engines.identity``
    gives for the record (``I``, ``J`` by absolute value, ``CKT`` stripped).
    ``tap`` is the off-nominal ratio seen from ``from_bus`` in per unit, from
    the ``WINDV1``, ``WINDV2``, ``NOMV1`` and ``NOMV2`` fields as ``CW`` reads
    them; 1.0 when the file gives none. ``shift_rad`` is ``ANG1`` in radians.
    ``b_total`` is the line charging of a MATPOWER transformer row (its ``b``,
    per unit on the system base), half at each end inside the ratio; a PSS/E
    transformer record has none, and 0.0 is given.
    """

    from_bus: int
    to_bus: int
    ckt: str
    tap: float
    shift_rad: float
    b_total: float = 0.0


@dataclass(frozen=True)
class LineFact:
    """One non-transformer branch record: buses, circuit id and total line charging.

    ``b_total`` is the branch's ``B`` field, per unit on the system base.
    """

    from_bus: int
    to_bus: int
    ckt: str
    b_total: float


@dataclass(frozen=True)
class RatingFact:
    """One two-terminal branch record: buses, circuit id and first rating.

    ``rate_mva`` is the branch's first rating in MVA: ``RATEA`` of a
    non-transformer branch (``RATE1`` at revision 34), ``RATA1`` of a
    two-winding transformer (``RATE1`` of winding 1 at revision 34), ``rateA``
    of a MATPOWER branch row. 0 when the file gives none; a negative or
    non-finite value is read as 0. ``CaseFacts.ratings`` lists the
    non-transformer branches first and the two-winding transformers after,
    each in file order: the order of ``lines`` then ``transformers`` and of
    the identity's ``branches``.
    """

    from_bus: int
    to_bus: int
    ckt: str
    rate_mva: float


@dataclass(frozen=True)
class GeneratorOpFact:
    """The operations data of one generator of a MATPOWER case.

    ``p_min_mw`` and ``p_max_mw`` are the PMIN and PMAX columns (10 and 9).
    ``ramp_up_mw_per_min`` and ``ramp_down_mw_per_min`` are the ramp rate in
    MW per minute (``matpower_ramp_mw_per_min``): RAMP_AGC (column 17) where
    it is non-zero, else RAMP_10 (column 18) divided by 10, else None. ``cost``
    is the gencost row: ``kind`` is "polynomial" for model 2, "piecewise" for
    model 1; ``coefficients`` or ``points`` hold the row's numbers;
    ``startup_usd`` and ``shutdown_usd`` are the row's second and third
    columns. ``row`` is the generator's row of ``mpc.gen``, from 1, which is
    the number PowerSystems names it by (``gen-<row>``).
    """

    bus: int
    gen_id: str
    p_min_mw: float | None
    p_max_mw: float | None
    ramp_up_mw_per_min: float | None
    ramp_down_mw_per_min: float | None
    cost_kind: str | None
    cost_coefficients: tuple[float, ...] | None
    cost_points: tuple[tuple[float, float], ...] | None
    startup_usd: float | None
    shutdown_usd: float | None
    row: int | None = None


def matpower_ramp_mw_per_min(gen_row: list[float]) -> float | None:
    """The ramp rate of a MATPOWER ``mpc.gen`` row, in MW per minute.

    The MATPOWER manual (table B-2) gives three ramp columns: RAMP_AGC
    (column 17), the ramp rate for load following and AGC, in MW per minute;
    RAMP_10 (column 18), the ramp rate for 10 minute reserves, in MW; and
    RAMP_30 (column 19), in MW per 30 minutes. A dispatch or commitment step
    is load following, so RAMP_AGC is the rate where the file gives one; a
    file that gives only RAMP_10 has its 10 minute capability spread over the
    10 minutes, RAMP_10 / 10. A column of 0 is MATPOWER's "no data", never a
    limit (as a limit it would pin the generator), and with neither column
    the answer is None. This is the rate the ``op`` block publishes and the
    rate the Sienna engine's commitment and simulation enforce.
    """
    ramp_agc = gen_row[16] if len(gen_row) > 16 else 0.0
    if ramp_agc != 0.0:
        return abs(ramp_agc)
    ramp_10 = gen_row[17] if len(gen_row) > 17 else 0.0
    if ramp_10 != 0.0:
        return abs(ramp_10) / 10.0
    return None


@dataclass(frozen=True)
class CaseFacts:
    """The facts of a case file an engine's reader can get wrong, in file order.

    ``notes`` says what the facts cannot carry: one line per two-winding
    transformer whose winding-2 ratio, in per unit of its bus base, is not 1.0
    (see ``_winding_ratios``). A MATPOWER case has a single ratio per branch
    and gives none.
    """

    v_setpoints: dict[int, float]
    transformers: tuple[TransformerFact, ...]
    lines: tuple[LineFact, ...]
    ratings: tuple[RatingFact, ...] = ()
    generator_ops: tuple[GeneratorOpFact, ...] = ()
    notes: tuple[str, ...] = ()


def _record_setpoint(v_setpoints: dict[int, float], bus: int, vs: float) -> None:
    """Record the voltage setpoint of a bus, refusing two that differ."""
    if bus in v_setpoints and abs(v_setpoints[bus] - vs) > 1e-9:
        raise CaseFactsError(
            f"bus {bus} has in-service generators with different voltage "
            f"setpoints ({v_setpoints[bus]} and {vs})"
        )
    v_setpoints[bus] = vs


def _number(fields: list[str], index: int, default: float) -> float:
    """Field ``index`` of a record as a float; ``default`` when it is missing or blank."""
    if index >= len(fields) or not fields[index]:
        return default
    return float(fields[index])


def _rating(fields: list[str], index: int) -> float:
    """Field ``index`` of a record as a rating in MVA.

    A missing or blank field, a negative value and a non-finite one are 0.
    """
    value = _number(fields, index, 0.0)
    if not math.isfinite(value) or value < 0.0:
        return 0.0
    return value


def _winding_ratios(
    cw: int,
    windv1: float,
    windv2: float,
    nomv1: float,
    nomv2: float,
    bus_kv1: float,
    bus_kv2: float,
) -> tuple[float, float]:
    """The ratio of each winding of a two-winding record, per unit of its bus base.

    What the file means, by the ``CW`` code of the record's first line:
    ``CW`` 1 gives ``WINDV1`` and ``WINDV2`` in per unit of the bus base
    voltage; ``CW`` 2 gives them in kV, so each is divided by its bus's
    ``BASKV``; ``CW`` 3 gives them in per unit of the nominal winding voltage,
    so each is multiplied by ``NOMV / BASKV`` (a ``NOMV`` of 0 meaning the bus
    base voltage). A ``WINDV`` of 0 means that winding is at its nominal: a
    ratio of 1.0 for that winding, before the two are divided. Any other
    ``CW`` is read as 1. The off-nominal ratio seen from bus ``I`` is the first
    ratio over the second.

    ANDES 2.0.0's reader departs from this whenever the winding-2 ratio is not
    1: ``andes/io/psse.py`` (``_parse_transf_v33``) sets ``tap = data[2][0]``
    (``WINDV1`` alone, line 641) and under ``CW`` 3 only scales it, ``tap = tap
    * (Vn1 / bus_Vn1) / (Vn2 / bus_Vn2)`` (line 651), so ``WINDV2`` is left
    out under ``CW`` 1 and 3; it reads it only under ``CW`` 2 (line 649), and
    it turns a zero ratio into 1.0 after the whole conversion (lines 654-655),
    not per winding. The reader follows the file and says so in a note
    (``read_psse_raw_facts``).
    """
    def nominal(windv: float) -> float:
        return windv if windv != 0.0 else 1.0

    if cw == 2:
        ratio1 = windv1 / bus_kv1 if windv1 != 0.0 else 1.0
        ratio2 = windv2 / bus_kv2 if windv2 != 0.0 else 1.0
    elif cw == 3:
        vn1 = nomv1 if nomv1 != 0.0 else bus_kv1
        vn2 = nomv2 if nomv2 != 0.0 else bus_kv2
        ratio1 = nominal(windv1) * vn1 / bus_kv1
        ratio2 = nominal(windv2) * vn2 / bus_kv2
    else:
        ratio1 = nominal(windv1)
        ratio2 = nominal(windv2)
    return ratio1, ratio2


def read_psse_raw_facts(text: str) -> CaseFacts:
    """Read the facts of a PSS/E RAW file (revisions 32, 33 and 34).

    ``v_setpoints`` comes from the generator block's ``VS`` field of in-service
    machines (``STAT`` equal to 1; a record too short to have ``STAT`` counts as
    in service), keyed by the machine's bus ``I`` (``IREG`` is ignored).
    ``lines`` comes from the branch block's ``I``, ``J``, ``CKT`` and ``B``.
    ``transformers`` comes from the two-winding records of the transformer
    block (``K`` equal to 0, four lines: ``I, J, K, CKT, CW, ...``, then
    ``R1-2, X1-2, SBASE1-2``, then ``WINDV1, NOMV1, ANG1, ...``, then ``WINDV2,
    NOMV2``; a three-winding record is skipped). ``tap`` is the winding-1
    ratio over the winding-2 ratio, each in per unit of its bus base as the
    file means it (``_winding_ratios``, which also says where ANDES departs
    from it); ``CW`` 2 and 3 need the ``BASKV`` of both buses and a record
    whose bus has none raises ``CaseFactsError``. A record whose winding-2
    ratio differs from 1.0 by more than 1e-9 gets a line in ``notes``.
    ``shift_rad`` is ``ANG1`` in radians. ``ratings`` gives each branch record
    its ``RATEA`` (the seventh field; at revision 34 ``RATE1``, the eighth,
    after ``NAME``) and each two-winding record its ``RATA1`` (the fourth
    field of its third line). A blank field takes its default, and
    a file that ends early is read as far as it goes (a record cut short is
    dropped).
    """
    lines = text.splitlines()
    if not lines:
        raise CaseFactsError("empty PSS/E RAW file")

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
        raise CaseFactsError(
            f"unsupported PSS/E RAW revision {version}; supported: 32, 33, 34"
        )
    blocks = _BLOCKS_BY_REVISION[version]

    base_kv: dict[int, float] = {}
    v_setpoints: dict[int, float] = {}
    line_facts: list[LineFact] = []
    transformer_facts: list[TransformerFact] = []
    rating_facts: list[RatingFact] = []
    notes: list[str] = []

    block_idx = -1 if version >= 34 else 0
    pending: list[list[str]] = []
    seen_data = False

    def flush_transformer(record: list[list[str]]) -> None:
        first = record[0]
        if len(first) > 2 and _int_field(first[2]) != 0:
            return  # a three-winding record (K not 0): no two-winding fact
        i_bus = _int_field(first[0])
        j_bus = abs(_int_field(first[1]))
        ckt = first[3] if len(first) > 3 and first[3] else "1"
        cw = int(_number(first, 4, 1.0))
        winding1, winding2 = record[2], record[3]
        bus_kv1 = base_kv.get(i_bus, 0.0)
        bus_kv2 = base_kv.get(j_bus, 0.0)
        if cw in (2, 3) and (bus_kv1 == 0.0 or bus_kv2 == 0.0):
            raise CaseFactsError(
                f"transformer {i_bus}-{j_bus} circuit {ckt!r} has CW {cw}, which "
                f"needs the base voltage of both buses, and one has none"
            )
        ratio1, ratio2 = _winding_ratios(
            cw,
            windv1=_number(winding1, 0, 0.0),
            windv2=_number(winding2, 0, 0.0),
            nomv1=_number(winding1, 1, 0.0),
            nomv2=_number(winding2, 1, 0.0),
            bus_kv1=bus_kv1,
            bus_kv2=bus_kv2,
        )
        if abs(ratio2 - 1.0) > 1e-9:
            notes.append(
                f"transformer {i_bus}-{j_bus} circuit {ckt!r}: winding 1 ratio "
                f"{ratio1!r}, winding 2 ratio {ratio2!r} (per unit of the bus "
                f"base). The tap is their quotient, but engines differ in how "
                f"they treat a winding-2 ratio (ANDES ignores it), and the "
                f"transformer's impedance is defined on winding 1's side, which "
                f"a single ratio does not carry."
            )
        ang1 = _number(winding1, 2, 0.0)
        transformer_facts.append(
            TransformerFact(i_bus, j_bus, ckt, ratio1 / ratio2, math.radians(ang1))
        )
        # RATA1 (RATE1 of winding 1 at revision 34): the fourth field of the
        # record's third line, after WINDV1, NOMV1, ANG1.
        rating_facts.append(RatingFact(i_bus, j_bus, ckt, _rating(winding1, 3)))

    def take_record(block: str, record: list[list[str]]) -> None:
        if block == "transf":
            flush_transformer(record)
            return
        row = record[0]
        if block == "bus":
            base_kv[_int_field(row[0])] = _number(row, 2, 0.0)
        elif block == "gen":
            if int(_number(row, 14, 1.0)) == 1:
                _record_setpoint(v_setpoints, _int_field(row[0]), _number(row, 6, 1.0))
        elif block == "branch":
            ckt = row[2] if len(row) > 2 and row[2] else "1"
            b_total = _number(row, 5, 0.0)
            from_bus = _int_field(row[0])
            to_bus = abs(_int_field(row[1]))
            line_facts.append(LineFact(from_bus, to_bus, ckt, b_total))
            # RATEA is the seventh field, after I, J, CKT, R, X, B; at
            # revision 34 a NAME field follows B, so RATE1 is the eighth.
            rating_facts.append(
                RatingFact(from_bus, to_bus, ckt, _rating(row, 7 if version >= 34 else 6))
            )

    for raw_line in lines[3:]:
        line = raw_line.strip()
        if not line or line.startswith("@!"):
            continue
        if line[0] == "Q":
            break
        first_fields = _fields(line)
        if first_fields and first_fields[0] == "0":
            if block_idx == 0 and not pending and not seen_data:
                # A revision 33 file may open with an "END OF SYSTEM-WIDE
                # DATA" delimiter before the bus block; it is not a block of
                # its own, so the block counter does not move for it.
                continue
            pending = []
            block_idx += 1
            continue
        if block_idx < 0 or block_idx >= len(blocks):
            continue
        block = blocks[block_idx]
        seen_data = True
        pending.append(first_fields)
        if block == "transf":
            # The record's line count is decided by the K field of its first
            # line (4 lines when K is 0, 5 otherwise); the later lines of a
            # record carry no K.
            record_first = pending[0]
            k_bus = _int_field(record_first[2]) if len(record_first) > 2 else 0
            want = 4 if k_bus == 0 else 5
            if len(pending) >= want:
                take_record(block, pending)
                pending = []
        else:
            take_record(block, pending)
            pending = []

    return CaseFacts(
        v_setpoints=v_setpoints,
        transformers=tuple(transformer_facts),
        lines=tuple(line_facts),
        ratings=tuple(rating_facts),
        notes=tuple(notes),
    )


def read_matpower_facts(text: str) -> CaseFacts:
    """Read the facts of a MATPOWER ``.m`` case.

    ``v_setpoints`` comes from the ``Vg`` column (6) of the ``mpc.gen`` rows
    whose status (column 8) is greater than 0, keyed by the generator's bus
    (column 1). A ``mpc.branch`` row with a non-zero ratio (column 9) is a
    transformer whose ``tap`` is that ratio, whose ``shift_rad`` is its angle
    (column 10, degrees) in radians and whose ``b_total`` is its ``b`` (column
    5); any other row is a line whose ``b_total`` is its ``b``. ``ckt`` is the
    ordinal among the rows of the same unordered bus pair, from ``"1"``, as
    ``identity.py`` assigns it. Every row
    gives a rating, its ``rateA`` (column 6); ``ratings`` holds the lines'
    first and then the transformers', as ``identity.py`` orders ``branches``.
    ``generator_ops`` reads the PMIN, PMAX, RAMP_AGC and RAMP_10 columns of
    ``mpc.gen`` and the ``mpc.gencost`` rows, one entry per ``mpc.gen`` row in
    file order.
    """
    gen_rows = _matpower_rows(text, "gen")
    branch_rows = _matpower_rows(text, "branch")
    gencost_rows = _matpower_rows(text, "gencost")

    v_setpoints: dict[int, float] = {}
    for row in gen_rows:
        status = row[7] if len(row) > 7 else 1.0
        if status > 0:
            vg = row[5] if len(row) > 5 else 1.0
            _record_setpoint(v_setpoints, int(row[0]), vg)

    line_facts: list[LineFact] = []
    transformer_facts: list[TransformerFact] = []
    line_ratings: list[RatingFact] = []
    transformer_ratings: list[RatingFact] = []
    pair_ordinals: dict[tuple[int, int], int] = {}
    for row in branch_rows:
        from_bus = int(row[0])
        to_bus = int(row[1])
        pair = (min(from_bus, to_bus), max(from_bus, to_bus))
        pair_ordinals[pair] = pair_ordinals.get(pair, 0) + 1
        ckt = str(pair_ordinals[pair])
        ratio = row[8] if len(row) > 8 else 0.0
        rate_a = row[5] if len(row) > 5 else 0.0
        if not math.isfinite(rate_a) or rate_a < 0.0:
            rate_a = 0.0
        rating = RatingFact(from_bus, to_bus, ckt, rate_a)
        b_total = row[4] if len(row) > 4 else 0.0
        if ratio != 0.0:
            angle = row[9] if len(row) > 9 else 0.0
            transformer_facts.append(
                TransformerFact(from_bus, to_bus, ckt, ratio, math.radians(angle), b_total)
            )
            transformer_ratings.append(rating)
        else:
            line_facts.append(LineFact(from_bus, to_bus, ckt, b_total))
            line_ratings.append(rating)

    # Read generator operations data
    generator_ops: list[GeneratorOpFact] = []
    gen_ordinals: dict[int, int] = {}
    for i, row in enumerate(gen_rows):
        bus = int(row[0])
        gen_ordinals[bus] = gen_ordinals.get(bus, 0) + 1
        gen_id = str(gen_ordinals[bus])

        # PMIN is column 10 (index 9), PMAX is column 9 (index 8)
        p_min_mw = row[9] if len(row) > 9 else None
        p_max_mw = row[8] if len(row) > 8 else None

        # RAMP_AGC (column 17) in MW per minute, else RAMP_10 (column 18) in
        # MW per 10 minutes, divided by 10; the same rate up and down.
        ramp_up_mw_per_min = matpower_ramp_mw_per_min(row)
        ramp_down_mw_per_min = ramp_up_mw_per_min

        # Read gencost if available
        cost_kind = None
        cost_coefficients = None
        cost_points = None
        startup_usd = None
        shutdown_usd = None

        if i < len(gencost_rows):
            gencost = gencost_rows[i]
            if len(gencost) >= 4:
                model = int(gencost[0])
                startup_usd = gencost[1] if len(gencost) > 1 else None
                shutdown_usd = gencost[2] if len(gencost) > 2 else None
                ncost = int(gencost[3]) if len(gencost) > 3 else 0

                if model == 2:  # polynomial
                    cost_kind = "polynomial"
                    # Coefficients start at index 4, highest order first
                    cost_coefficients = tuple(gencost[4:4+ncost])
                elif model == 1:  # piecewise
                    cost_kind = "piecewise"
                    # Points are (MW, $/h) pairs starting at index 4
                    points = []
                    for j in range(ncost):
                        if 4 + 2*j + 1 < len(gencost):
                            points.append((gencost[4 + 2*j], gencost[4 + 2*j + 1]))
                    cost_points = tuple(points)

        generator_ops.append(GeneratorOpFact(
            bus=bus,
            gen_id=gen_id,
            p_min_mw=p_min_mw,
            p_max_mw=p_max_mw,
            ramp_up_mw_per_min=ramp_up_mw_per_min,
            ramp_down_mw_per_min=ramp_down_mw_per_min,
            cost_kind=cost_kind,
            cost_coefficients=cost_coefficients,
            cost_points=cost_points,
            startup_usd=startup_usd,
            shutdown_usd=shutdown_usd,
            row=i + 1,
        ))

    # The lines' ratings, then the transformers', each in row order: the order
    # of ``lines`` followed by ``transformers`` and of the identity's
    # ``branches``, which is not the row order where the rows interleave them.
    return CaseFacts(
        v_setpoints=v_setpoints,
        transformers=tuple(transformer_facts),
        lines=tuple(line_facts),
        ratings=tuple(line_ratings + transformer_ratings),
        generator_ops=tuple(generator_ops),
    )


def read_case_facts(path: str | os.PathLike[str]) -> CaseFacts:
    """Read the facts of a case file, picking the reader by extension.

    ``.raw`` goes to the PSS/E reader, ``.m`` to the MATPOWER one; anything else
    raises ``CaseFactsError``. The file is read as UTF-8, falling back to
    Latin-1.
    """
    file_path = path if isinstance(path, str) else os.fspath(path)
    extension = os.path.splitext(file_path)[1].lower()
    if extension not in (".raw", ".m"):
        raise CaseFactsError(
            f"unsupported case file extension {extension!r}; expected '.raw' or '.m'"
        )
    try:
        with open(file_path, encoding="utf-8") as handle:
            text = handle.read()
    except UnicodeDecodeError:
        with open(file_path, encoding="latin-1") as handle:
            text = handle.read()
    if extension == ".raw":
        return read_psse_raw_facts(text)
    return read_matpower_facts(text)


def corrections_document(facts: CaseFacts) -> dict[str, object]:
    """The JSON-ready shape the Sienna adapter takes.

    ``v_setpoints`` is keyed by the bus number as a string; ``transformers``
    holds ``[from_bus, to_bus, ckt, tap, shift_rad]`` per two-winding
    transformer and ``line_charging`` holds ``[from_bus, to_bus, ckt, b_total]``
    per non-transformer branch, both in file order; ``transformer_charging``
    holds ``[from_bus, to_bus, ckt, b_total]`` per transformer whose charging
    is not 0 (a MATPOWER row with a ratio and a ``b``), in file order;
    ``ratings`` holds ``[from_bus, to_bus, ckt, rate_mva]`` per two-terminal
    branch, the rows of
    ``line_charging`` first and those of ``transformers`` after, in the same
    order and with the same ``[from_bus, to_bus, ckt]``; ``generator_ops``
    holds the operations data of each generator; ``notes`` is the
    list of ``facts.notes``.
    """
    return {
        "v_setpoints": {str(bus): vs for bus, vs in facts.v_setpoints.items()},
        "transformers": [
            [t.from_bus, t.to_bus, t.ckt, t.tap, t.shift_rad]
            for t in facts.transformers
        ],
        "line_charging": [
            [line.from_bus, line.to_bus, line.ckt, line.b_total]
            for line in facts.lines
        ],
        "transformer_charging": [
            [t.from_bus, t.to_bus, t.ckt, t.b_total]
            for t in facts.transformers
            if t.b_total != 0.0
        ],
        "ratings": [
            [rating.from_bus, rating.to_bus, rating.ckt, rating.rate_mva]
            for rating in facts.ratings
        ],
        "generator_ops": [
            {
                "bus": op.bus,
                "gen_id": op.gen_id,
                "p_min_mw": op.p_min_mw,
                "p_max_mw": op.p_max_mw,
                "ramp_up_mw_per_min": op.ramp_up_mw_per_min,
                "ramp_down_mw_per_min": op.ramp_down_mw_per_min,
                "cost_kind": op.cost_kind,
                "cost_coefficients": list(op.cost_coefficients) if op.cost_coefficients else None,
                "cost_points": [list(p) for p in op.cost_points] if op.cost_points else None,
                "startup_usd": op.startup_usd,
                "shutdown_usd": op.shutdown_usd,
                "row": op.row,
            }
            for op in facts.generator_ops
        ],
        "notes": list(facts.notes),
    }


__all__ = [
    "CaseFacts",
    "CaseFactsError",
    "LineFact",
    "RatingFact",
    "TransformerFact",
    "corrections_document",
    "matpower_ramp_mw_per_min",
    "read_case_facts",
    "read_matpower_facts",
    "read_psse_raw_facts",
]
