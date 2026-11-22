"""Turn the Sienna JSON documents into TENSA's topology and power flow shapes.

The Julia module answers three documents (``topology``, ``report``,
``pflow``); this module is the pure-Python step from them to the
``TopologySnapshot`` and ``PflowResult`` the ANDES engine returns, so the API
and the web client work unchanged whichever engine a session uses. Nothing
here starts Julia or imports an engine: every function takes plain mappings
(the parsed JSON) and the key book ``assign_sienna_keys`` filled.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any

from tensa.core.wrapper.results import (
    GeneratorOutput,
    LineFlow,
    LoadConsumption,
    ParamValue,
    PflowResult,
    PflowSummary,
    TopologyEntry,
    TopologySnapshot,
)
from tensa.engines.keys import KeyBook, branch_key
from tensa.engines.roles import role_of_model

Row = dict[str, Any]


def _rows(document: Mapping[str, Any], name: str) -> list[Row]:
    """The list of rows under ``name``, or ``[]``."""
    value = document.get(name)
    if not isinstance(value, list):
        return []
    return [dict(row) for row in value if isinstance(row, Mapping)]


def _float(value: Any, default: float = 0.0) -> float:
    """``value`` as a float, ``default`` when it is missing or not numeric."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _float_or_none(value: Any) -> float | None:
    """``value`` as a float, ``None`` when the JSON carries null.

    A DC power flow computes no reactive power, so its reactive fields are
    JSON null; an AC power flow always carries a number.
    """
    if value is None:
        return None
    return _float(value)


def _int(value: Any) -> int:
    """``value`` as an int (a float or numeric text is truncated)."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return int(float(_text(value)))


def _text(value: Any) -> str:
    """``value`` as stripped text (``""`` for ``None``)."""
    if value is None:
        return ""
    return str(value).strip()


def _key(book: KeyBook, kind: str, idx: Any) -> str | None:
    """The entry's key from the book (``None`` where the book has none)."""
    return book.key_of(kind, idx)


def file_ratings(
    document: Mapping[str, Any] | None, book: KeyBook
) -> tuple[dict[str, float] | None, int]:
    """The file's branch ratings of a corrections document, keyed by branch key.

    Each ``"ratings"`` row, ``[from, to, ckt, rate_mva]``, is keyed by
    ``branch_key(from, to, ckt)``, the key the book gives that record's
    branch. The answer is the mapping and the count of rows whose key the
    book does not hold (left out of the mapping); a non-zero count is a
    problem the caller reports. ``(None, 0)`` when the document is ``None``
    or carries no ``"ratings"`` key (an older document): the caller then
    keeps what the engine reported.
    """
    if document is None or "ratings" not in document:
        return None, 0
    rows = document.get("ratings")
    if not isinstance(rows, list):
        return None, 0
    ratings: dict[str, float] = {}
    unmatched = 0
    for row in rows:
        if not isinstance(row, list | tuple) or len(row) < 4:
            unmatched += 1
            continue
        key = branch_key(_int(row[0]), _int(row[1]), _text(row[2]) or "1")
        if book.entry_of(key) is None:
            unmatched += 1
            continue
        ratings[key] = _float(row[3])
    return ratings, unmatched


def topology_snapshot(
    topology: Mapping[str, Any],
    report: Mapping[str, Any],
    book: KeyBook,
    ratings: Mapping[str, float] | None = None,
) -> TopologySnapshot:
    """The ``TopologySnapshot`` of the Sienna ``topology`` JSON.

    Every entry's ``key`` is ``book.key_of(kind, idx)`` with ``idx`` as the
    JSON gives it (the branch, generator, load and shunt names, the bus
    numbers, ``"<generator>/<model>"`` for a dynamic record). ``report`` is
    unused for now: the snapshot's ``events`` stay empty and the report's
    messages go to the session log through ``report_messages``.

    With ``ratings`` given (``file_ratings`` of the case's corrections
    document), a branch's ``rate_a`` is the file's rating for its key (0.0
    where the file gives none), whatever ``rate_mva`` the JSON holds: where
    the file gives no rating PowerSystems invents one from the branch's
    impedance and voltage. A branch whose key is not in ``ratings`` keeps the
    JSON's value. With ``ratings`` ``None`` the JSON's value is used.
    """
    del report  # the snapshot carries no part of the report yet
    base_mva = _float(topology.get("base_mva"), 100.0)
    freq_value = topology.get("freq_hz")
    freq_hz = _float(freq_value) if freq_value is not None else None

    bus_vn: dict[int, float] = {}
    buses: list[TopologyEntry] = []
    buses_without_vn: list[int | str] = []
    for row in _rows(topology, "buses"):
        number = _int(row["number"])
        vn_kv = _float(row.get("vn_kv"))
        bus_vn[number] = vn_kv
        if vn_kv == 0.0:
            buses_without_vn.append(number)
        buses.append(
            TopologyEntry(
                idx=number,
                name=_text(row.get("name")),
                kind="Bus",
                params={"Vn": vn_kv},
                key=_key(book, "Bus", number),
            )
        )

    lines: list[TopologyEntry] = []
    transformers: list[TopologyEntry] = []
    for row in _rows(topology, "branches"):
        name = _text(row.get("name"))
        key = _key(book, "Line", name)
        if ratings is not None and key is not None and key in ratings:
            rate_a = ratings[key]
        else:
            rate = row.get("rate_mva")
            rate_a = _float(rate) if rate is not None else 0.0
        params: dict[str, ParamValue] = {
            "bus1": _int(row["from"]),
            "bus2": _int(row["to"]),
            "r": _float(row.get("r_pu")),
            "x": _float(row.get("x_pu")),
            "b": _float(row.get("b_pu")),
            "tap": _float(row.get("tap"), 1.0),
            "phi": _float(row.get("shift_rad")),
            "rate_a": rate_a,
            "u": 1 if row.get("available", True) else 0,
        }
        entry = TopologyEntry(
            idx=name,
            name=name,
            kind="Line",
            params=params,
            key=key,
        )
        if row.get("kind") == "transformer":
            transformers.append(entry)
        else:
            lines.append(entry)

    generators: list[TopologyEntry] = []
    for row in _rows(topology, "generators"):
        name = _text(row.get("name"))
        bus = _int(row["bus"])
        kind = _text(row.get("kind")) or "PV"
        params = {
            "bus": bus,
            "Sn": _float(row.get("mbase_mva")),
            "Vn": bus_vn.get(bus, 0.0),
            "p0": _float(row.get("p_mw")) / base_mva,
            "v0": _float(row.get("v_set_pu")),
            "qmax": _float(row.get("q_max_mvar")) / base_mva,
            "qmin": _float(row.get("q_min_mvar")) / base_mva,
            "u": 1 if row.get("available", True) else 0,
        }
        generators.append(
            TopologyEntry(
                idx=name,
                name=name,
                kind=kind,
                params=params,
                key=_key(book, kind, name),
            )
        )

    dynamics = _rows(topology, "dynamics")
    machine_idx_of: dict[str, str] = {}
    # The first exciter of each unit, read before the controllers are listed
    # so a stabiliser names its exciter whichever comes first in the JSON.
    exciter_idx_of: dict[str, str] = {}
    for row in dynamics:
        model = _text(row.get("model"))
        generator = _text(row.get("generator"))
        if role_of_model(model) == "exciter":
            exciter_idx_of.setdefault(generator, f"{generator}/{model}")
    for row in dynamics:
        if role_of_model(_text(row.get("model"))) != "machine":
            continue
        generator = _text(row.get("generator"))
        model = _text(row.get("model"))
        idx = f"{generator}/{model}"
        machine_idx_of.setdefault(generator, idx)
        generators.append(
            TopologyEntry(
                idx=idx,
                name=idx,
                kind=model,
                params={"bus": _int(row["bus"]), "gen": generator},
                key=_key(book, model, idx),
            )
        )

    loads: list[TopologyEntry] = []
    for row in _rows(topology, "loads"):
        name = _text(row.get("name"))
        bus = _int(row["bus"])
        params = {
            "bus": bus,
            "Vn": bus_vn.get(bus, 0.0),
            "p0": _float(row.get("p_mw")) / base_mva,
            "q0": _float(row.get("q_mvar")) / base_mva,
            "u": 1 if row.get("available", True) else 0,
        }
        loads.append(
            TopologyEntry(
                idx=name,
                name=name,
                kind="PQ",
                params=params,
                key=_key(book, "PQ", name),
            )
        )

    shunts: list[TopologyEntry] = []
    for row in _rows(topology, "shunts"):
        name = _text(row.get("name"))
        bus = _int(row["bus"])
        params = {
            "bus": bus,
            "Vn": bus_vn.get(bus, 0.0),
            "g": _float(row.get("g_mw")) / base_mva,
            "b": _float(row.get("b_mvar")) / base_mva,
            "u": 1 if row.get("available", True) else 0,
        }
        shunts.append(
            TopologyEntry(
                idx=name,
                name=name,
                kind="Shunt",
                params=params,
                key=_key(book, "Shunt", name),
            )
        )

    controllers: list[TopologyEntry] = []
    for row in dynamics:
        model = _text(row.get("model"))
        role = role_of_model(model)
        if role == "machine":
            continue
        generator = _text(row.get("generator"))
        idx = f"{generator}/{model}"
        machine_idx = machine_idx_of.get(generator)
        exciter_idx = exciter_idx_of.get(generator)
        controller_params: dict[str, ParamValue]
        if role in ("exciter", "governor") and machine_idx is not None:
            controller_params = {"syn": machine_idx}
        elif role == "pss" and exciter_idx is not None:
            controller_params = {"avr": exciter_idx}
        else:
            controller_params = {"gen": generator}
        controllers.append(
            TopologyEntry(
                idx=idx,
                name=idx,
                kind=model,
                params=controller_params,
                key=_key(book, model, idx),
            )
        )

    return TopologySnapshot(
        state="pre-setup",
        buses=buses,
        lines=lines,
        transformers=transformers,
        generators=generators,
        loads=loads,
        shunts=shunts,
        controllers=controllers,
        freq_hz=freq_hz,
        base_mva=base_mva,
        buses_without_vn=buses_without_vn,
        events=[],
        undo=None,
        redo=None,
        has_dynamics=len(dynamics) > 0,
    )


def _g6(value: Any) -> str:
    """A number with ``:g`` formatting at 6 significant digits."""
    try:
        return f"{float(value):.6g}"
    except (TypeError, ValueError):
        return _text(value)


_DIGITS = re.compile(r"[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")

# Notes PowerSystems logs at warning level (the Julia module keeps no lower
# level) on every read, whatever the file holds, so they say nothing about the
# case: the PSS/E parser announces its substation step and says it never reads
# storage data (the identity reader's block count is where a block the engine
# skipped is reported, section 13 of the specification), and every reader says
# when the file has no substation data, from which PowerSystems takes only the
# buses' map coordinates. Each pattern is matched against the whole text of a
# note; a note that matches is not passed on to the user.
_PARSER_CHATTER: tuple[re.Pattern[str], ...] = (
    re.compile(r"Parsing PSS\(R\)E Substation data into a PowerModels Dict\.\.\."),
    re.compile(r"This PSS\(R\)E parser currently doesn't support Storage data parsing\.\.\."),
    re.compile(r"No substation data found"),
)

# PowerSystems writes the whole PowerModels record of a transformer it cannot
# classify into its note (``... from the COD1 field for Dict{String, Any}(...)``),
# hundreds of characters a user cannot read; the note is kept and the record
# cut off.
_RECORD_DUMP = re.compile(r" for Dict\{.*$", re.DOTALL)

# The note PowerSystems logs when it moves a ratio onto its tap-step grid. Where
# the adapter put the file's ratio back (an ``applied`` tap entry with the same
# two numbers), the note describes a System the user does not have and is not
# passed on; the ``applied`` line says what happened.
_TAP_STEP = re.compile(
    r"winding tap setting is not on a step; (?P<file>\S+) set to (?P<read>\S+)$"
)


def _note_shape(text: str) -> str:
    """``text`` with every run of digits (sign, point, exponent) as ``#``."""
    return _DIGITS.sub("#", text)


def _is_chatter(text: str) -> bool:
    """Whether a note is parser chatter (``_PARSER_CHATTER``)."""
    return any(pattern.fullmatch(text) for pattern in _PARSER_CHATTER)


def _undone_by(text: str, taps: list[tuple[float, float]]) -> bool:
    """Whether a note of a ratio moved onto its tap grid is one that an
    ``applied`` tap entry, ``(from, to)``, put back."""
    found = _TAP_STEP.search(text)
    if found is None:
        return False
    try:
        file_ratio = float(found["file"])
        read_ratio = float(found["read"])
    except ValueError:
        return False
    return any(
        math.isclose(file_ratio, to, rel_tol=1e-9, abs_tol=1e-12)
        and math.isclose(read_ratio, read, rel_tol=1e-9, abs_tol=1e-12)
        for read, to in taps
    )


def report_messages(report: Mapping[str, Any]) -> list[tuple[str, str]]:
    """What the Sienna ``report`` JSON sends to the session's message log.

    One warning per ``unsupported`` record, one info line per ``applied``
    entry, then the notes with runs of the same text (once every number is
    replaced by ``#``) collapsed to their first, followed by ``" (and N more
    like it)"`` when there were more. A note of level ``"warning"`` or
    ``"error"`` is a warning, any other an info line. Three kinds of note are
    not passed on, because they would tell the user nothing or something
    untrue: parser chatter (``_PARSER_CHATTER``), a note whose text is the
    reason of an ``unsupported`` record (the record's own warning says it),
    and a note of a ratio moved onto its tap grid that an ``applied`` entry
    put back. A note carrying a dump of a PowerModels record keeps its words
    and loses the dump.
    """
    messages: list[tuple[str, str]] = []
    for row in _rows(report, "unsupported"):
        messages.append(
            (
                "warning",
                f"Sienna: {_text(row.get('model'))} at bus {_text(row.get('bus'))}, "
                f"id {_text(row.get('id'))}, is not in the System: "
                f"{_text(row.get('reason'))}",
            )
        )
    for row in _rows(report, "applied"):
        kind = _text(row.get("kind"))
        to_text = _g6(row.get("to"))
        from_text = _g6(row.get("from"))
        if kind == "setpoint":
            messages.append(
                (
                    "info",
                    f"Sienna: the voltage setpoint at bus {_text(row.get('bus'))} "
                    f"is the file's {to_text}, where PowerSystems read {from_text}",
                )
            )
        elif kind == "tap":
            messages.append(
                (
                    "info",
                    f"Sienna: the ratio of {_text(row.get('branch'))} is the "
                    f"file's {to_text}, where PowerSystems read {from_text}",
                )
            )
        elif kind == "charging":
            messages.append(
                (
                    "info",
                    f"Sienna: the line charging of {_text(row.get('branch'))} is "
                    f"the file's {to_text}, where PowerSystems kept {from_text}",
                )
            )
        elif kind == "phase_shift":
            shift_deg = _g6(math.degrees(_float(row.get("shift_rad"))))
            messages.append(
                (
                    "info",
                    f"Sienna: the branch {_text(row.get('from_bus'))}-"
                    f"{_text(row.get('to_bus'))} has a ratio of 0 and a phase shift of "
                    f"{shift_deg} deg in the file, which MATPOWER reads as a phase "
                    f"shifter of ratio 1; it is held as one",
                )
            )
        elif kind == "bustype":
            messages.append(
                (
                    "info",
                    f"Sienna: bus {_text(row.get('bus'))} is type PV in the file with "
                    f"no generator in service, and is solved as a PQ bus",
                )
            )
    reported = {_text(row.get("reason")) for row in _rows(report, "unsupported")}
    taps = [
        (_float(row.get("from"), math.nan), _float(row.get("to"), math.nan))
        for row in _rows(report, "applied")
        if _text(row.get("kind")) == "tap"
    ]
    collapsed: dict[str, tuple[str, str, int]] = {}
    order: list[str] = []
    for row in _rows(report, "notes"):
        text = _RECORD_DUMP.sub("", _text(row.get("text")))
        if _is_chatter(text) or text in reported or _undone_by(text, taps):
            continue
        level = _text(row.get("level"))
        shape = _note_shape(text)
        if shape not in collapsed:
            order.append(shape)
            collapsed[shape] = (level, text, 0)
        stored_level, stored_text, count = collapsed[shape]
        collapsed[shape] = (stored_level, stored_text, count + 1)
    for shape in order:
        level, text, count = collapsed[shape]
        if count > 1:
            text = f"{text} (and {count - 1} more like it)"
        messages.append(("warning" if level in ("warning", "error") else "info", text))
    return messages


def pflow_result(
    pflow: Mapping[str, Any],
    topology: Mapping[str, Any],
    book: KeyBook,
    ratings: Mapping[str, float] | None = None,
) -> PflowResult:
    """The ``PflowResult`` of the Sienna ``pflow`` JSON.

    A run that did not converge has every map empty, ``summary`` ``None`` and
    ``keys`` ``{}``. The maps are keyed as the ANDES result keys them: a bus
    by its number, a branch, generator or load by its name (its idx), with
    ``keys`` going from that idx to the element's key.

    With ``ratings`` given (``file_ratings`` of the case's corrections
    document), a branch's ``rate_a`` is the file's rating for its key,
    ``None`` when that is 0, and ``loading_pct`` is computed from it, as the
    ANDES result has them; a branch whose key is not in ``ratings`` keeps the
    JSON's ``rate_mva``. With ``ratings`` ``None`` the JSON's value is used.
    """
    # PowerFlows reports neither an iteration count nor a final mismatch, so
    # both are 0 here; no number is made up for them.
    converged = bool(pflow.get("converged", False))
    if not converged:
        return PflowResult(
            converged=False,
            iterations=0,
            mismatch=0.0,
            bus_voltages={},
            bus_angles={},
            line_flows={},
            generator_outputs={},
            load_consumption={},
            settings=None,
            summary=None,
            keys={},
        )

    bus_voltages: dict[int | str, float] = {}
    bus_angles: dict[int | str, float] = {}
    bus_keys: dict[str, str] = {}
    for row in _rows(pflow, "buses"):
        number = _int(row["number"])
        bus_voltages[number] = _float(row.get("v_pu"))
        bus_angles[number] = _float(row.get("angle_rad"))
        key = book.key_of("Bus", number)
        if key is not None:
            bus_keys[str(number)] = key

    rate_of: dict[str, float | None] = {}
    for row in _rows(topology, "branches"):
        name = _text(row.get("name"))
        key = book.key_of("Line", name)
        if ratings is not None and key is not None and key in ratings:
            value = ratings[key]
        else:
            rate = row.get("rate_mva")
            value = _float(rate) if rate is not None else 0.0
        rate_of[name] = value if value != 0.0 else None

    line_flows: dict[str, LineFlow] = {}
    line_keys: dict[str, str] = {}
    for row in _rows(pflow, "branches"):
        name = _text(row.get("name"))
        p_from = _float(row.get("p_from_mw"))
        q_from = _float_or_none(row.get("q_from_mvar"))
        p_to = _float(row.get("p_to_mw"))
        q_to = _float_or_none(row.get("q_to_mvar"))
        rate_a = rate_of.get(name)
        loading = None
        if rate_a is not None:
            # A null q (a DC power flow) counts as 0 in the apparent power:
            # the loading is then the active power over the rating, which is
            # the honest DC loading.
            loading = (
                100.0
                * max(
                    math.hypot(p_from, q_from or 0.0),
                    math.hypot(p_to, q_to or 0.0),
                )
                / rate_a
            )
        line_flows[name] = LineFlow(
            p=p_from,
            q=q_from,
            from_idx=_int(row["from"]),
            to_idx=_int(row["to"]),
            p_to=p_to,
            q_to=q_to,
            loss=p_from + p_to,
            rate_a=rate_a,
            loading_pct=loading,
        )
        key = book.key_of("Line", name)
        if key is not None:
            line_keys[name] = key

    topo_generators: dict[str, Row] = {
        _text(row.get("name")): row for row in _rows(topology, "generators")
    }
    generator_outputs: dict[str, GeneratorOutput] = {}
    generator_keys: dict[str, str] = {}
    for row in _rows(pflow, "generators"):
        name = _text(row.get("name"))
        bus = _int(row["bus"])
        topo_row = topo_generators.get(name, {})
        available = bool(topo_row.get("available", True))
        generator_outputs[name] = GeneratorOutput(
            p=_float(row.get("p_mw")),
            q=_float_or_none(row.get("q_mvar")),
            v=bus_voltages.get(bus, 0.0),
            bus=bus,
            q_min=_float(topo_row.get("q_min_mvar")) if available else None,
            q_max=_float(topo_row.get("q_max_mvar")) if available else None,
        )
        kind = _text(topo_row.get("kind")) or "PV"
        key = book.key_of(kind, name)
        if key is not None:
            generator_keys[name] = key

    load_consumption: dict[str, LoadConsumption] = {}
    load_keys: dict[str, str] = {}
    for row in _rows(pflow, "loads"):
        name = _text(row.get("name"))
        bus = _int(row["bus"])
        load_consumption[name] = LoadConsumption(
            p=_float(row.get("p_mw")),
            q=_float_or_none(row.get("q_mvar")),
            bus=bus,
        )
        key = book.key_of("PQ", name)
        if key is not None:
            load_keys[name] = key

    generation_p = sum(output.p for output in generator_outputs.values())
    load_p = sum(load.p for load in load_consumption.values())
    # A DC power flow names its method in the answer; it computes no reactive
    # power, so its reactive totals are null, never zero. The active totals
    # are computed as for an AC result.
    is_dc = pflow.get("method") in ("dc", "ptdf-dc")
    shunt_p = 0.0
    shunt_q_value = 0.0
    for row in _rows(topology, "shunts"):
        if not row.get("available", True):
            continue
        v = bus_voltages.get(_int(row["bus"]))
        if v is None:
            continue
        shunt_p += _float(row.get("g_mw")) * v * v
        shunt_q_value -= _float(row.get("b_mvar")) * v * v
    loss_p = sum(flow.p + flow.p_to for flow in line_flows.values())
    slack_names = [
        name
        for name, row in topo_generators.items()
        if _text(row.get("kind")) == "Slack"
    ]
    slack_p: float | None = None
    if slack_names:
        slack_p = sum(generator_outputs[name].p for name in slack_names if name in generator_outputs)
    if is_dc:
        generation_q: float | None = None
        load_q: float | None = None
        shunt_q: float | None = None
        loss_q: float | None = None
        slack_q: float | None = None
    else:
        generation_q = sum(
            output.q for output in generator_outputs.values() if output.q is not None
        )
        load_q = sum(
            load.q for load in load_consumption.values() if load.q is not None
        )
        shunt_q = shunt_q_value
        loss_q = sum(
            flow.q + flow.q_to
            for flow in line_flows.values()
            if flow.q is not None and flow.q_to is not None
        )
        slack_q = None
        if slack_names:
            slack_qs = [
                generator_outputs[name].q for name in slack_names if name in generator_outputs
            ]
            slack_q = sum(q for q in slack_qs if q is not None)

    summary = PflowSummary(
        generation_p=generation_p,
        generation_q=generation_q,
        load_p=load_p,
        load_q=load_q,
        shunt_p=shunt_p,
        shunt_q=shunt_q,
        loss_p=loss_p,
        loss_q=loss_q,
        slack_p=slack_p,
        slack_q=slack_q,
    )

    return PflowResult(
        converged=True,
        iterations=0,
        mismatch=0.0,
        bus_voltages=bus_voltages,
        bus_angles=bus_angles,
        line_flows=line_flows,
        generator_outputs=generator_outputs,
        load_consumption=load_consumption,
        settings=None,
        summary=summary,
        keys={
            "bus": bus_keys,
            "line": line_keys,
            "generator": generator_keys,
            "load": load_keys,
        },
    )
