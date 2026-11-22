"""Build the neutral case document of the Sienna engine's loaded case.

Reads the topology and report JSON the Julia module answered and the
corrections document the state holds; nothing starts Julia here. What the
case does not give is null, never an engine default (section 13 of
``design/multiengine/spec.md``).
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tensa.engines.case_doc import (
    DYNAMICS_NOTE,
    BusRecord,
    CaseDocument,
    CaseSource,
    CostCurveRecord,
    DynamicRecord,
    GeneratorOp,
    GeneratorRecord,
    LineRecord,
    LoadRecord,
    ShuntRecord,
    TransformerRecord,
    ZipFractions,
)
from tensa.engines.keys import KeyBook, branch_key, bus_key, generator_key, load_key, shunt_key
from tensa.engines.roles import role_of_model
from tensa.engines.sienna.convert import file_ratings

if TYPE_CHECKING:
    from tensa.engines.identity import CaseIdentity


def _float(value: Any) -> float | None:
    """``value`` as a finite float, or ``None``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _int(value: Any) -> int | None:
    """``value`` as an int, or ``None`` when it is not a whole number."""
    number = _float(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _text(value: Any) -> str:
    """``value`` as stripped text (``""`` for ``None``)."""
    if value is None:
        return ""
    return str(value).strip()


def _rows(document: Mapping[str, Any], name: str) -> list[dict[str, Any]]:
    """The list of rows under ``name``, or ``[]``."""
    value = document.get(name)
    if not isinstance(value, list):
        return []
    return [dict(row) for row in value if isinstance(row, Mapping)]


def _sha256(paths: list[Path]) -> list[str] | None:
    """The SHA-256 of each file, or ``None`` when one cannot be read."""
    digests: list[str] = []
    for path in paths:
        try:
            digests.append(hashlib.sha256(path.read_bytes()).hexdigest())
        except OSError:
            return None
    return digests


def _zip_of(row: Mapping[str, Any]) -> ZipFractions | None:
    """The ZIP fractions of a load row, when the JSON carries them."""
    zip_row = row.get("zip")
    if not isinstance(zip_row, Mapping):
        return None
    p = zip_row.get("p")
    q = zip_row.get("q")
    if not isinstance(p, list) or not isinstance(q, list) or len(p) != 3 or len(q) != 3:
        return None
    p_values = [_float(v) for v in p]
    q_values = [_float(v) for v in q]
    if None in p_values or None in q_values:
        return None
    return ZipFractions(
        p=[v for v in p_values if v is not None],
        q=[v for v in q_values if v is not None],
    )


def _neutral_events(
    report: Mapping[str, Any] | None, notes: list[str]
) -> list[dict[str, Any]]:
    """The events of the Sienna load report, mapped to the neutral kinds.

    A row whose kind has no neutral kind is listed in ``notes`` and left out.
    """
    events: list[dict[str, Any]] = []
    for row in _rows(report or {}, "events"):
        kind = _text(row.get("kind"))
        if kind in ("branch_trip", "branch_close", "bus_fault", "gen_trip", "load_step", "setpoint", "set"):
            event = {str(k): v for k, v in row.items()}
            event.setdefault("source", "case")
            events.append(event)
        else:
            notes.append(
                f"case event of kind {kind!r} has no neutral kind and is left "
                "out of the document"
            )
    return events


def build_case_document(
    topology: Mapping[str, Any],
    report: Mapping[str, Any] | None,
    document: Mapping[str, Any] | None,
    identity: CaseIdentity | None,
    book: KeyBook,
    case_path: Path | None,
    addfiles: list[Path] | None,
) -> CaseDocument:
    """The neutral case document from the topology JSON and the key book."""
    base_mva = _float(topology.get("base_mva"))
    freq_hz = _float(topology.get("freq_hz"))
    ratings, _unmatched = file_ratings(document, book)

    bus_vn: dict[int, float] = {}
    gen_kind_by_bus: dict[int, str] = {}
    for row in _rows(topology, "generators"):
        bus = _int(row.get("bus"))
        if bus is not None:
            gen_kind_by_bus.setdefault(bus, _text(row.get("kind")) or "PV")

    isolated: set[int] = set(identity.isolated_buses) if identity is not None else set()
    area_slack: dict[int, int] = identity.area_slack_buses if identity is not None else {}
    slack_marked = set(area_slack.values())

    buses: list[BusRecord] = []
    for row in _rows(topology, "buses"):
        number = _int(row.get("number"))
        if number is None:
            continue
        vn_kv = _float(row.get("vn_kv"))
        if vn_kv is not None:
            bus_vn[number] = vn_kv
        angle_rad = _float(row.get("angle_rad"))
        if number in isolated:
            bus_type = "isolated"
        elif gen_kind_by_bus.get(number) == "Slack":
            bus_type = "ref"
        elif number in gen_kind_by_bus:
            bus_type = "pv"
        else:
            bus_type = "pq"
        buses.append(
            BusRecord(
                key=book.key_of("Bus", number) or bus_key(number),
                number=number,
                name=_text(row.get("name")) or None,
                vn_kv=vn_kv if vn_kv != 0.0 else None,
                type=bus_type,  # type: ignore[arg-type]
                v_pu=_float(row.get("v_pu")),
                angle_deg=math.degrees(angle_rad) if angle_rad is not None else None,
                area=None,
                zone=None,
                area_slack=True if number in slack_marked else None,
                in_service=bool(row.get("available", True)),
            )
        )

    lines: list[LineRecord] = []
    transformers: list[TransformerRecord] = []
    for row in _rows(topology, "branches"):
        name = _text(row.get("name"))
        from_bus = _int(row.get("from"))
        to_bus = _int(row.get("to"))
        if from_bus is None or to_bus is None:
            continue
        ckt = _text(row.get("ckt")) or "1"
        key = book.key_of("Line", name) or branch_key(from_bus, to_bus, ckt)
        rate_a: float | None
        if ratings is not None and key in ratings:
            rate_a = ratings[key]
        else:
            rate_a = _float(row.get("rate_mva"))
        shift_rad = _float(row.get("shift_rad"))
        if row.get("kind") == "transformer":
            transformers.append(
                TransformerRecord(
                    key=key,
                    **{"from": from_bus, "to": to_bus},
                    ckt=ckt,
                    r_pu=_float(row.get("r_pu")),
                    x_pu=_float(row.get("x_pu")),
                    # The Julia side writes r and x on the system base and the
                    # bus voltages (SYSTEM_BASE), so that is the base stated;
                    # the row's ``rate_mva`` is a flow rating, not this base.
                    rate_mva=base_mva,
                    vn_from_kv=bus_vn.get(from_bus) or None,
                    vn_to_kv=bus_vn.get(to_bus) or None,
                    tap=_float(row.get("tap")),
                    shift_deg=math.degrees(shift_rad) if shift_rad is not None else None,
                    rate_a_mva=rate_a,
                    in_service=bool(row.get("available", True)),
                )
            )
        else:
            lines.append(
                LineRecord(
                    key=key,
                    **{"from": from_bus, "to": to_bus},
                    ckt=ckt,
                    r_pu=_float(row.get("r_pu")),
                    x_pu=_float(row.get("x_pu")),
                    b_pu=_float(row.get("b_pu")),
                    rate_a_mva=rate_a,
                    in_service=bool(row.get("available", True)),
                )
            )

    generators: list[GeneratorRecord] = []
    # Build a map of generator operations data by (bus, gen_id)
    gen_ops_map: dict[tuple[int, str], Mapping[str, Any]] = {}
    if document is not None:
        for op_data in document.get("generator_ops", []):
            if isinstance(op_data, Mapping):
                op_bus = op_data.get("bus")
                op_gen_id = op_data.get("gen_id")
                if op_bus is not None and op_gen_id is not None:
                    gen_ops_map[(int(op_bus), str(op_gen_id))] = op_data

    for row in _rows(topology, "generators"):
        name = _text(row.get("name"))
        bus = _int(row.get("bus"))
        if bus is None:
            continue
        kind = _text(row.get("kind")) or "PV"
        device_id = _text(row.get("id")) or name.rsplit("-", 1)[-1] or "1"

        # Build the op block if we have operations data for this generator
        op_block = None
        op_data = gen_ops_map.get((bus, device_id))
        if op_data is not None:
            cost = None
            cost_kind = op_data.get("cost_kind")
            if cost_kind == "polynomial":
                coefficients = op_data.get("cost_coefficients")
                if coefficients:
                    cost = CostCurveRecord(
                        kind="polynomial",
                        coefficients=[float(c) for c in coefficients],
                        startup_usd=_float(op_data.get("startup_usd")),
                        shutdown_usd=_float(op_data.get("shutdown_usd")),
                    )
            elif cost_kind == "piecewise":
                points = op_data.get("cost_points")
                if points:
                    cost = CostCurveRecord(
                        kind="piecewise",
                        points=[[float(p[0]), float(p[1])] for p in points],
                        startup_usd=_float(op_data.get("startup_usd")),
                        shutdown_usd=_float(op_data.get("shutdown_usd")),
                    )

            op_block = GeneratorOp(
                p_min_mw=_float(op_data.get("p_min_mw")),
                p_max_mw=_float(op_data.get("p_max_mw")),
                ramp_up_mw_per_min=_float(op_data.get("ramp_up_mw_per_min")),
                ramp_down_mw_per_min=_float(op_data.get("ramp_down_mw_per_min")),
                cost=cost,
                initial_p_mw=_float(row.get("p_mw")),
                initial_status="on" if row.get("available", True) else "off",
            )

        generators.append(
            GeneratorRecord(
                key=book.key_of(kind, name) or generator_key(bus, device_id),
                bus=bus,
                id=device_id,
                p_mw=_float(row.get("p_mw")),
                q_mvar=_float(row.get("q_mvar")),
                v_set_pu=_float(row.get("v_set_pu")),
                q_min_mvar=_float(row.get("q_min_mvar")),
                q_max_mvar=_float(row.get("q_max_mvar")),
                mbase_mva=_float(row.get("mbase_mva")),
                op=op_block,
                in_service=bool(row.get("available", True)),
            )
        )

    loads: list[LoadRecord] = []
    for row in _rows(topology, "loads"):
        name = _text(row.get("name"))
        bus = _int(row.get("bus"))
        if bus is None:
            continue
        device_id = _text(row.get("id")) or "1"
        loads.append(
            LoadRecord(
                key=book.key_of("PQ", name) or load_key(bus, device_id),
                bus=bus,
                id=device_id,
                p_mw=_float(row.get("p_mw")),
                q_mvar=_float(row.get("q_mvar")),
                zip=_zip_of(row),
                in_service=bool(row.get("available", True)),
            )
        )

    shunts: list[ShuntRecord] = []
    for row in _rows(topology, "shunts"):
        name = _text(row.get("name"))
        bus = _int(row.get("bus"))
        if bus is None:
            continue
        device_id = _text(row.get("id")) or "1"
        shunts.append(
            ShuntRecord(
                key=book.key_of("Shunt", name) or shunt_key(bus, device_id),
                bus=bus,
                id=device_id,
                g_mw=_float(row.get("g_mw")),
                b_mvar=_float(row.get("b_mvar")),
                in_service=bool(row.get("available", True)),
            )
        )

    dynamics: list[DynamicRecord] = []
    for row in _rows(topology, "dynamics"):
        model = _text(row.get("model"))
        generator = _text(row.get("generator"))
        if not model or not generator:
            continue
        gen_bus = _int(row.get("bus"))
        gen_id = generator.rsplit("-", 1)[-1] or "1"
        unit_key: str | None = None
        for kind in ("PV", "Slack"):
            unit_key = book.key_of(kind, generator)
            if unit_key is not None:
                break
        if unit_key is None and gen_bus is not None:
            unit_key = generator_key(gen_bus, gen_id)
        if unit_key is None:
            continue
        idx = f"{generator}/{model}"
        dynamic_key = book.key_of(model, idx)
        if dynamic_key is None:
            continue
        dynamics.append(
            DynamicRecord(
                key=dynamic_key,
                unit=unit_key,
                role=role_of_model(model),
                model=model,
                values=None,
                names=None,
            )
        )

    notes: list[str] = []
    events = _neutral_events(report, notes)
    if dynamics:
        notes.append(DYNAMICS_NOTE)

    paths = [case_path, *(addfiles or [])] if case_path is not None else []
    source: CaseSource | None = None
    if paths:
        source = CaseSource(
            format=identity.format if identity is not None else "unknown",
            files=[path.name for path in paths],
            sha256=_sha256(paths),
        )

    return CaseDocument(
        name=case_path.stem if case_path is not None else "case",
        base_mva=base_mva,
        freq_hz=freq_hz,
        source=source,
        buses=buses,
        lines=lines,
        transformers=transformers,
        generators=generators,
        loads=loads,
        shunts=shunts,
        dynamics=dynamics,
        events=events,
        notes=notes,
        ext={},
    )


__all__ = ["build_case_document"]
