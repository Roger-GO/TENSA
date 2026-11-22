"""Build the neutral case document of the ANDES engine's loaded case.

Reads the ANDES ``System`` the wrapper holds, through the wrapper's own
surfaces (the topology snapshot, the key book, the identity and the case
events); the file is never re-read here. What the case does not give is null,
never an engine default (section 13 of ``design/multiengine/spec.md``).
"""

from __future__ import annotations

import hashlib
import math
from typing import TYPE_CHECKING, Any

from tensa.core.case_events import CaseEvent
from tensa.core.wrapper.topology import _system_base_mva, _system_frequency_hz
from tensa.engines.case_doc import (
    DYNAMICS_NOTE,
    BusRecord,
    CaseDocument,
    CaseSource,
    DynamicRecord,
    GeneratorRecord,
    LineRecord,
    LoadRecord,
    ShuntRecord,
    TransformerRecord,
    ZipFractions,
)
from tensa.engines.keys import branch_key, bus_key, generator_key, load_key, shunt_key
from tensa.engines.roles import role_of_model

if TYPE_CHECKING:
    from tensa.core.wrapper import Wrapper
    from tensa.core.wrapper.results import TopologyEntry
    from tensa.engines.identity import CaseIdentity, DeviceId

# The dynamic kinds the snapshot's ``generators`` bucket can hold beside the
# static ones; they are machines, listed under ``dynamics``.
_MACHINE_KINDS = frozenset({"GENROU", "GENCLS", "GENSAL", "GENSAE", "GENROE"})


def _number(value: Any) -> float | None:
    """``value`` as a finite float, or ``None``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _int_or_none(value: Any) -> int | None:
    """``value`` as an int, or ``None`` when it is not a whole number."""
    number = _number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _sha256(paths: list[Any]) -> list[str] | None:
    """The SHA-256 of each file, or ``None`` when one cannot be read."""
    digests: list[str] = []
    for path in paths:
        try:
            digests.append(hashlib.sha256(path.read_bytes()).hexdigest())
        except OSError:
            return None
    return digests


def _bus_type(
    number: int,
    ref_buses: set[int],
    pv_buses: set[int],
    identity: CaseIdentity | None,
) -> str:
    """The neutral bus type: the case's own record first, then the generators."""
    if identity is not None and number in identity.isolated_buses:
        return "isolated"
    if number in ref_buses:
        return "ref"
    if number in pv_buses:
        return "pv"
    return "pq"


def _branch_ckt(
    identity: CaseIdentity | None,
    from_bus: int,
    to_bus: int,
    used: set[tuple[int, int, str]],
) -> str:
    """The circuit id of a branch, from the identity's records of its bus pair.

    The records of a pair are taken in file order, each at most once, so two
    parallel circuits keep their own ids. With no identity, or no record left,
    the first free ordinal.
    """
    if identity is not None:
        for record in identity.branches:
            pair = {record.from_bus, record.to_bus}
            if pair == {from_bus, to_bus}:
                marker = (record.from_bus, record.to_bus, record.ckt)
                if marker not in used:
                    used.add(marker)
                    return record.ckt
    ordinal = 1
    while (from_bus, to_bus, str(ordinal)) in used:
        ordinal += 1
    used.add((from_bus, to_bus, str(ordinal)))
    return str(ordinal)


def _device_id(
    identity: CaseIdentity | None,
    which: str,
    bus: int,
    used: set[tuple[int, str]],
) -> str:
    """The PSS/E id of the device on ``bus``, from the identity in file order."""
    records: tuple[DeviceId, ...] = ()
    if identity is not None:
        if which == "generator":
            records = identity.generators
        elif which == "load":
            records = identity.loads
        elif which == "shunt":
            records = (*identity.fixed_shunts, *identity.switched_shunts)
    record: DeviceId
    for record in records:
        if record.bus == bus and (bus, record.id) not in used:
            used.add((bus, record.id))
            return record.id
    ordinal = 1
    while (bus, str(ordinal)) in used:
        ordinal += 1
    used.add((bus, str(ordinal)))
    return str(ordinal)


def _neutral_event(event: CaseEvent, wrapper: Wrapper, notes: list[str]) -> dict[str, Any] | None:
    """One case event as a neutral event of spec section 6.4, or ``None``.

    A ``Toggle`` on a line is a ``branch_trip``, on a generator a
    ``gen_trip``; a ``Fault`` is a ``bus_fault``; an ``Alter`` is a ``set``.
    Anything else is listed in ``notes`` and left out.
    """
    book = wrapper.keys()
    if event.kind == "fault":
        bus = event.dev_idx
        key = book.key_of("Bus", bus) if bus is not None else None
        if key is None:
            key = bus_key(int(bus)) if isinstance(bus, int) else f"bus:{bus}"
        neutral: dict[str, Any] = {
            "kind": "bus_fault",
            "bus": key,
            "t_on": event.t,
            "source": event.source,
        }
        if event.tc is not None:
            neutral["t_clear"] = event.tc
        return neutral
    if event.kind == "toggle":
        model = event.model or ""
        dev_idx = event.dev_idx
        key = book.key_of(model, dev_idx) if dev_idx is not None else None
        if model == "Line":
            return {
                "kind": "branch_trip",
                "target": key if key is not None else str(dev_idx),
                "t": event.t,
                "source": event.source,
            }
        if model in ("PV", "Slack", "GENROU", "GENCLS"):
            return {
                "kind": "gen_trip",
                "target": key if key is not None else str(dev_idx),
                "t": event.t,
                "source": event.source,
            }
        notes.append(
            f"case event {event.name!r}: a Toggle on {model} has no neutral "
            "kind and is left out of the document"
        )
        return None
    if event.kind == "alter":
        model = event.model or ""
        dev_idx = event.dev_idx
        key = book.key_of(model, dev_idx) if dev_idx is not None else None
        return {
            "kind": "set",
            "target": key if key is not None else str(dev_idx),
            "param": event.src,
            "value": event.amount,
            "t": event.t,
            "source": event.source,
        }
    notes.append(
        f"case event {event.name!r} of kind {event.kind!r} has no neutral "
        "kind and is left out of the document"
    )
    return None


def _unit_key_of(wrapper: Wrapper, gen_idx: Any) -> str | None:
    """The key of the static generator an ANDES idx names, or ``None``."""
    for model in ("PV", "Slack"):
        key = wrapper.keys().key_of(model, gen_idx)
        if key is not None:
            return key
    return None


def _dynamic_unit(
    entry: TopologyEntry,
    by_idx: dict[str, TopologyEntry],
    wrapper: Wrapper,
) -> str | None:
    """The unit key a dynamic entry belongs to, following gen/syn/avr."""
    params = entry.params
    gen_ref = params.get("gen")
    if gen_ref is not None:
        key = _unit_key_of(wrapper, gen_ref)
        if key is not None:
            return key
    syn_ref = params.get("syn")
    if syn_ref is not None:
        machine = by_idx.get(str(syn_ref))
        if machine is not None:
            machine_gen = machine.params.get("gen")
            if machine_gen is not None:
                key = _unit_key_of(wrapper, machine_gen)
                if key is not None:
                    return key
    avr_ref = params.get("avr")
    if avr_ref is not None:
        exciter = by_idx.get(str(avr_ref))
        if exciter is not None:
            return _dynamic_unit(exciter, by_idx, wrapper)
    return None


def _model_column(ss: Any, model_name: str, param: str) -> dict[str, float]:
    """The values of one numeric parameter of one model, keyed by idx as text.

    The snapshot's params hold only what ``params.py`` lists; the bus's stored
    voltage and angle, a generator's reactive setpoint and a transformer's
    rated voltages are read from the System itself.
    """
    model = getattr(ss, model_name, None)
    if model is None:
        return {}
    idx_values = getattr(getattr(model, "idx", None), "v", None)
    values = getattr(getattr(model, param, None), "v", None)
    if idx_values is None or values is None:
        return {}
    column: dict[str, float] = {}
    for idx, raw in zip(list(idx_values), list(values), strict=False):
        number = _number(raw)
        if number is not None:
            column[str(idx)] = number
    return column


def _input_column(ss: Any, model_name: str, param: str) -> dict[str, float]:
    """One parameter as the case gave it, on the device's own base, by idx.

    ANDES keeps the case's value in ``vin`` once ``setup()`` has run and puts
    the system-base value in ``v`` (``System.calc_pu_coeff``); before setup
    ``v`` is the case's value and ``vin`` is not set yet. Reading ``vin`` first
    keeps the document the same before and after a power flow.
    """
    model = getattr(ss, model_name, None)
    if model is None:
        return {}
    idx_values = getattr(getattr(model, "idx", None), "v", None)
    instance = getattr(model, param, None)
    values = getattr(instance, "vin", None)
    if values is None:
        values = getattr(instance, "v", None)
    if idx_values is None or values is None:
        return {}
    column: dict[str, float] = {}
    for idx, raw in zip(list(idx_values), list(values), strict=False):
        number = _number(raw)
        if number is not None:
            column[str(idx)] = number
    return column


def _impedance_ratios(
    ss: Any, model_name: str, bus_param: str, vn_param: str, base_mva: float | None
) -> dict[str, float]:
    """``Zn / Zb`` of each device of a model, by idx: what multiplies an
    impedance on the device's base (``Sn``, its ``vn_param``) to put it on the
    system base and the base voltage of its bus, as ``System.calc_pu_coeff``
    has it. An admittance is divided by it. A device whose bases are not all
    known is left out."""
    if base_mva is None:
        return {}
    sn = _input_column(ss, model_name, "Sn")
    vn = _input_column(ss, model_name, vn_param)
    bus_of = _model_column_any(ss, model_name, bus_param)
    bus_vn = _input_column(ss, "Bus", "Vn")
    ratios: dict[str, float] = {}
    for idx, rating in sn.items():
        device_vn = vn.get(idx)
        vb = bus_vn.get(str(bus_of.get(idx)))
        if rating <= 0 or device_vn is None or device_vn <= 0 or vb is None or vb <= 0:
            continue
        ratios[idx] = (device_vn**2 / rating) / (vb**2 / base_mva)
    return ratios


def _model_column_any(ss: Any, model_name: str, param: str) -> dict[str, Any]:
    """One parameter of one model as stored (an idx reference included), by idx."""
    model = getattr(ss, model_name, None)
    if model is None:
        return {}
    idx_values = getattr(getattr(model, "idx", None), "v", None)
    values = getattr(getattr(model, param, None), "v", None)
    if idx_values is None or values is None:
        return {}
    return {str(idx): raw for idx, raw in zip(list(idx_values), list(values), strict=False)}


def _scaled(value: float | None, factor: float | None) -> float | None:
    """``value * factor``, or ``None`` when either is unknown."""
    if value is None or factor is None:
        return None
    return value * factor


def build_case_document(wrapper: Wrapper) -> CaseDocument:
    """The neutral case document of the ANDES engine's loaded case.

    Raises :class:`NoCaseLoadedError` when the wrapper holds none, as
    ``topology_snapshot`` does.
    """
    snapshot = wrapper.topology_snapshot()
    ss = wrapper._require_loaded()  # noqa: SLF001 - the builder reads the System
    book = wrapper.keys()
    identity = wrapper._identity  # noqa: SLF001 - the identity the wrapper read
    base_mva = _system_base_mva(ss)
    freq_hz = _system_frequency_hz(ss)
    # The case's stored values, which the snapshot's params do not carry.
    bus_v0 = _model_column(ss, "Bus", "v0")
    bus_a0 = _model_column(ss, "Bus", "a0")
    line_vn1 = _model_column(ss, "Line", "Vn1")
    line_vn2 = _model_column(ss, "Line", "Vn2")
    # Impedances and admittances as the case gave them, on each device's own
    # base, and what puts them on the system base (spec section 5: a line and
    # a shunt are on ``base_mva`` and the bus voltage, a transformer on its
    # own rating and rated voltages).
    line_sn = _input_column(ss, "Line", "Sn")
    line_r = _input_column(ss, "Line", "r")
    line_x = _input_column(ss, "Line", "x")
    line_b = _input_column(ss, "Line", "b")
    line_ratio = _impedance_ratios(ss, "Line", "bus1", "Vn1", base_mva)
    shunt_g = _input_column(ss, "Shunt", "g")
    shunt_b = _input_column(ss, "Shunt", "b")
    shunt_ratio = _impedance_ratios(ss, "Shunt", "bus", "Vn", base_mva)
    gen_q0: dict[str, float] = {}
    for model_name in ("PV", "Slack"):
        gen_q0.update(_model_column(ss, model_name, "q0"))

    ref_buses: set[int] = set()
    pv_buses: set[int] = set()
    for entry in snapshot.generators:
        bus = _int_or_none(entry.params.get("bus"))
        if bus is None:
            continue
        if entry.kind == "Slack":
            ref_buses.add(bus)
        elif entry.kind == "PV":
            pv_buses.add(bus)

    buses: list[BusRecord] = []
    without_vn = {str(idx) for idx in snapshot.buses_without_vn}
    area_slack: dict[int, int] = identity.area_slack_buses if identity is not None else {}
    slack_marked = set(area_slack.values())
    for entry in snapshot.buses:
        number = _int_or_none(entry.idx)
        if number is None:
            continue
        vn = _number(entry.params.get("Vn"))
        if str(entry.idx) in without_vn:
            vn = None
        a0 = bus_a0.get(str(entry.idx))
        bus_type = _bus_type(number, ref_buses, pv_buses, identity)
        buses.append(
            BusRecord(
                key=book.key_of("Bus", entry.idx) or bus_key(number),
                number=number,
                name=entry.name or None,
                vn_kv=vn,
                type=bus_type,  # type: ignore[arg-type]
                v_pu=bus_v0.get(str(entry.idx)),
                angle_deg=math.degrees(a0) if a0 is not None else None,
                area=_int_or_none(entry.params.get("area")),
                zone=_int_or_none(entry.params.get("zone")),
                area_slack=True if number in slack_marked else None,
                in_service=_number(entry.params.get("u")) != 0.0,
            )
        )

    used_ckts: set[tuple[int, int, str]] = set()
    lines: list[LineRecord] = []
    for entry in snapshot.lines:
        from_bus = _int_or_none(entry.params.get("bus1"))
        to_bus = _int_or_none(entry.params.get("bus2"))
        if from_bus is None or to_bus is None:
            continue
        ckt = _branch_ckt(identity, from_bus, to_bus, used_ckts)
        idx = str(entry.idx)
        ratio = line_ratio.get(idx)
        lines.append(
            LineRecord(
                key=book.key_of("Line", entry.idx) or branch_key(from_bus, to_bus, ckt),
                **{"from": from_bus, "to": to_bus},
                ckt=ckt,
                r_pu=_scaled(line_r.get(idx), ratio),
                x_pu=_scaled(line_x.get(idx), ratio),
                b_pu=_scaled(line_b.get(idx), 1.0 / ratio if ratio else None),
                rate_a_mva=_number(entry.params.get("rate_a")),
                in_service=_number(entry.params.get("u")) != 0.0,
            )
        )

    transformers: list[TransformerRecord] = []
    for entry in snapshot.transformers:
        from_bus = _int_or_none(entry.params.get("bus1"))
        to_bus = _int_or_none(entry.params.get("bus2"))
        if from_bus is None or to_bus is None:
            continue
        ckt = _branch_ckt(identity, from_bus, to_bus, used_ckts)
        phi = _number(entry.params.get("phi"))
        transformers.append(
            TransformerRecord(
                key=book.key_of("Line", entry.idx) or branch_key(from_bus, to_bus, ckt),
                **{"from": from_bus, "to": to_bus},
                ckt=ckt,
                # As the case gave them: on the transformer's Sn and Vn1.
                r_pu=line_r.get(str(entry.idx)),
                x_pu=line_x.get(str(entry.idx)),
                rate_mva=line_sn.get(str(entry.idx)),
                vn_from_kv=line_vn1.get(str(entry.idx)),
                vn_to_kv=line_vn2.get(str(entry.idx)),
                tap=_number(entry.params.get("tap")),
                shift_deg=math.degrees(phi) if phi is not None else None,
                rate_a_mva=_number(entry.params.get("rate_a")),
                in_service=_number(entry.params.get("u")) != 0.0,
            )
        )

    used_ids: set[tuple[int, str]] = set()
    generators: list[GeneratorRecord] = []
    machine_entries: list[TopologyEntry] = []
    static_entries: list[TopologyEntry] = []
    for entry in snapshot.generators:
        if entry.kind in _MACHINE_KINDS:
            machine_entries.append(entry)
        else:
            static_entries.append(entry)
    # The document lists the units in bus order, as the file does; ANDES lists
    # the PV entries before the Slack wherever their buses fall.
    static_entries.sort(key=lambda entry: _int_or_none(entry.params.get("bus")) or 0)
    for entry in static_entries:
        bus = _int_or_none(entry.params.get("bus"))
        if bus is None:
            continue
        device_id = _device_id(identity, "generator", bus, used_ids)
        p0 = _number(entry.params.get("p0"))
        q0 = gen_q0.get(str(entry.idx))
        qmin = _number(entry.params.get("qmin"))
        qmax = _number(entry.params.get("qmax"))
        generators.append(
            GeneratorRecord(
                key=book.key_of(entry.kind, entry.idx) or generator_key(bus, device_id),
                bus=bus,
                id=device_id,
                p_mw=p0 * base_mva if p0 is not None and base_mva is not None else None,
                q_mvar=q0 * base_mva if q0 is not None and base_mva is not None else None,
                v_set_pu=_number(entry.params.get("v0")),
                q_min_mvar=qmin * base_mva if qmin is not None and base_mva is not None else None,
                q_max_mvar=qmax * base_mva if qmax is not None and base_mva is not None else None,
                mbase_mva=_number(entry.params.get("Sn")),
                in_service=_number(entry.params.get("u")) != 0.0,
            )
        )

    zip_by_load: dict[str, ZipFractions] = {}
    for entry in snapshot.loads:
        if entry.kind != "ZIP":
            continue
        pq_ref = entry.params.get("pq")
        if pq_ref is None:
            continue
        kpz = _number(entry.params.get("kpz"))
        kpi = _number(entry.params.get("kpi"))
        kpp = _number(entry.params.get("kpp"))
        kqz = _number(entry.params.get("kqz"))
        kqi = _number(entry.params.get("kqi"))
        kqp = _number(entry.params.get("kqp"))
        if None in (kpz, kpi, kpp, kqz, kqi, kqp):
            continue
        zip_by_load[str(pq_ref)] = ZipFractions(
            p=[kpz / 100.0, kpi / 100.0, kpp / 100.0],  # type: ignore[operator]
            q=[kqz / 100.0, kqi / 100.0, kqp / 100.0],  # type: ignore[operator]
        )

    loads: list[LoadRecord] = []
    for entry in snapshot.loads:
        if entry.kind != "PQ":
            continue
        bus = _int_or_none(entry.params.get("bus"))
        if bus is None:
            continue
        device_id = _device_id(identity, "load", bus, used_ids)
        p0 = _number(entry.params.get("p0"))
        q0 = _number(entry.params.get("q0"))
        # An ANDES PQ is constant power in the file: [0, 0, 1] for both, and a
        # ZIP device that names the load overrides with its own split.
        zip_split = zip_by_load.get(str(entry.idx)) or ZipFractions(
            p=[0.0, 0.0, 1.0], q=[0.0, 0.0, 1.0]
        )
        loads.append(
            LoadRecord(
                key=book.key_of("PQ", entry.idx) or load_key(bus, device_id),
                bus=bus,
                id=device_id,
                p_mw=p0 * base_mva if p0 is not None and base_mva is not None else None,
                q_mvar=q0 * base_mva if q0 is not None and base_mva is not None else None,
                zip=zip_split,
                in_service=_number(entry.params.get("u")) != 0.0,
            )
        )

    shunts: list[ShuntRecord] = []
    for entry in snapshot.shunts:
        bus = _int_or_none(entry.params.get("bus"))
        if bus is None:
            continue
        device_id = _device_id(identity, "shunt", bus, used_ids)
        # On the system base, whatever the shunt's own Sn and Vn (the
        # snapshot's shunts are ANDES's ``Shunt`` model).
        ratio = shunt_ratio.get(str(entry.idx))
        divisor = 1.0 / ratio if ratio else None
        g = _scaled(shunt_g.get(str(entry.idx)), divisor)
        b = _scaled(shunt_b.get(str(entry.idx)), divisor)
        shunts.append(
            ShuntRecord(
                key=book.key_of(entry.kind, entry.idx) or shunt_key(bus, device_id),
                bus=bus,
                id=device_id,
                g_mw=g * base_mva if g is not None and base_mva is not None else None,
                b_mvar=b * base_mva if b is not None and base_mva is not None else None,
                in_service=_number(entry.params.get("u")) != 0.0,
            )
        )

    by_idx: dict[str, TopologyEntry] = {}
    for entry in (*machine_entries, *snapshot.controllers):
        by_idx[str(entry.idx)] = entry

    dynamics: list[DynamicRecord] = []
    for entry in (*machine_entries, *snapshot.controllers):
        unit = _dynamic_unit(entry, by_idx, wrapper)
        if unit is None:
            continue
        key = book.key_of(entry.kind, entry.idx)
        if key is None:
            continue
        dynamics.append(
            DynamicRecord(
                key=key,
                unit=unit,
                role=role_of_model(entry.kind),
                model=entry.kind,
                values=None,
                names=None,
            )
        )

    notes: list[str] = []
    events: list[dict[str, Any]] = []
    for event in snapshot.events:
        if event.source != "case":
            continue
        neutral = _neutral_event(event, wrapper, notes)
        if neutral is not None:
            events.append(neutral)
    if dynamics:
        notes.append(DYNAMICS_NOTE)

    case_path = wrapper._case_path  # noqa: SLF001
    addfiles = wrapper._addfiles or []  # noqa: SLF001
    name = case_path.stem if case_path is not None else "case"
    source: CaseSource | None = None
    if case_path is not None:
        paths = [case_path, *addfiles]
        source = CaseSource(
            format=identity.format if identity is not None else "unknown",
            files=[path.name for path in paths],
            sha256=_sha256(paths),
        )

    return CaseDocument(
        name=name,
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
