"""Reading a solved power flow off the System: flows, outputs, loads and totals."""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from tensa.core.wrapper.results import GeneratorOutput, LineFlow, LoadConsumption, PflowSummary
from tensa.core.wrapper.topology import _coerce_scalar

if TYPE_CHECKING:
    from andes.system import System


def _reference_angle_drift(ss: System) -> float:
    """Common-mode bus-angle drift to subtract so displayed angles stay
    physical after TDS.

    ANDES integrates bus angles against a system reference frame that
    *rotates*; after a TDS run every ``Bus.a`` carries a large common-mode
    offset (e.g. ~9.5 rad) even though angle DIFFERENCES — the only physical
    quantity — are preserved. The PF convention pins the slack bus at its
    ``a0`` setpoint, so the drift is ``(slack bus angle now) - (slack a0)``.

    Subtracting this drift:
    - leaves PF results unchanged (drift ≈ 0 right after PF, since the slack
      bus sits at a0), and
    - removes only the accumulated rotation after TDS, returning the slack
      bus to a0 and every other bus to its physical relative angle.

    Anchors to the FIRST ENABLED slack (each slack is pinned at its ``a0``, so
    any enabled slack is a valid reference; the first is deterministic). Falls
    back to mean-centring only when NO slack is enabled — an islanded / all-PV
    system has no canonical reference. Non-finite angles are skipped; returns a
    finite float (0.0 if nothing usable).
    """
    if not hasattr(ss, "Bus") or getattr(ss.Bus, "a", None) is None:
        return 0.0

    slack = getattr(ss, "Slack", None)
    # Index of the first ENABLED slack (u != 0). Don't assume row 0 is enabled.
    slack_row: int | None = None
    if slack is not None and (getattr(slack, "n", None) or 0):
        for j, u in enumerate(slack.u.v):
            if float(u) != 0.0:
                slack_row = j
                break

    if slack is not None and slack_row is not None:
        slack_bus = slack.bus.v[slack_row]
        for i, idx in enumerate(ss.Bus.idx.v):
            if str(idx) == str(slack_bus):
                a_now = float(ss.Bus.a.v[i])
                a0 = float(slack.a0.v[slack_row])
                drift = a_now - a0
                return drift if math.isfinite(drift) else 0.0
        # Slack references a missing bus → fall through to mean-centring.

    finite = [float(a) for a in ss.Bus.a.v if math.isfinite(float(a))]
    if not finite:
        return 0.0
    return sum(finite) / len(finite)


def _extract_generator_outputs(ss: System) -> dict[str, GeneratorOutput]:
    """Walk the PV and Slack devices and read each one's converged P / Q
    output + terminal voltage.

    ANDES stores these directly on the static model (``p``, ``q``, ``v``
    algebraic variables). The dynamic machines (GENROU/GENCLS) are left
    out on purpose: they have no ``p`` / ``q`` before TDS initialises, so
    reading them would invent a zero output, and a machine whose idx
    equals a static generator's (kundur_full numbers both 1..4) would
    overwrite that generator's real row with it.

    All values are in pu; we scale P/Q by ``ss.config.mva`` to MW/MVAr.
    Best-effort: defaults to 0.0 / 0.0 / 1.0 on any missing attribute.
    Each row also carries the generator's reactive limits (``qmin`` /
    ``qmax``, scaled the same way), left ``None`` for a generator that is
    out of service (``ue`` of 0, see :func:`_in_service_flags`) or whose limit
    is missing or not finite. A generator that is out of service reports no
    output.
    Returns dict keyed by stringified idx.
    """
    log = logging.getLogger("tensa.wrapper.gen_outputs")
    out: dict[str, GeneratorOutput] = {}
    try:
        mva_base = float(getattr(ss.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0
    for model_name in ("PV", "Slack"):
        model = getattr(ss, model_name, None)
        if model is None:
            continue
        idx_var = getattr(model, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        if not idx_values:
            continue
        bus_var = getattr(model, "bus", None)
        bus_values = list(getattr(bus_var, "v", []) if bus_var is not None else [])
        p_arr = _safe_list(getattr(model, "p", None))
        q_arr = _safe_list(getattr(model, "q", None))
        v_arr = _safe_list(getattr(model, "v", None))
        u_arr = _in_service_flags(model)
        qmin_arr = _safe_list(getattr(model, "qmin", None))
        qmax_arr = _safe_list(getattr(model, "qmax", None))
        for i, idx in enumerate(idx_values):
            try:
                p_pu = float(p_arr[i]) if i < len(p_arr) else 0.0
                q_pu = float(q_arr[i]) if i < len(q_arr) else 0.0
                v_pu = float(v_arr[i]) if i < len(v_arr) else 1.0
            except (TypeError, ValueError) as exc:
                log.warning(
                    "%s output extraction failed for idx=%r: %s",
                    model_name, idx, exc,
                )
                continue
            if not (math.isfinite(p_pu) and math.isfinite(q_pu) and math.isfinite(v_pu)):
                continue
            bus = bus_values[i] if i < len(bus_values) else ""
            bus_coerced = _coerce_scalar(bus)
            bus_final: int | str = bus_coerced if isinstance(bus_coerced, int | str) and not isinstance(bus_coerced, bool) else str(bus)
            switched_off = i < len(u_arr) and _is_zero(u_arr[i])
            # A PV generator's ``p`` is a copy of ``p0`` whatever ``u`` says, but
            # the bus equation multiplies it by ``ue``: a machine that is off, or
            # sits on a bus that is, injects nothing.
            out[str(idx)] = GeneratorOutput(
                p=0.0 if switched_off else p_pu * mva_base,
                q=0.0 if switched_off else q_pu * mva_base,
                v=v_pu,
                bus=bus_final,
                q_min=None if switched_off else _scaled(qmin_arr, i, mva_base),
                q_max=None if switched_off else _scaled(qmax_arr, i, mva_base),
            )
    return out


def _is_zero(value: Any) -> bool:
    """True for a number equal to zero; anything that is not a number is not."""
    try:
        return float(value) == 0.0
    except (TypeError, ValueError):
        return False


def _in_service_flags(model: Any) -> list[Any]:
    """The flags that say which devices of a model take part in the equations.

    ANDES writes ``ue`` into every bus equation, not ``u``: ``ue`` is ``u``
    unless a device's status parent (the bus it hangs on) is out of service, which
    leaves ``u`` at 1 and ``ue`` at 0. A model that does not carry ``ue`` is read
    by its ``u``.
    """
    effective = _safe_list(getattr(model, "ue", None))
    return effective if effective else _safe_list(getattr(model, "u", None))


def _scaled(values: list[Any], i: int, factor: float) -> float | None:
    """``values[i] * factor`` when that is a finite number, else ``None``."""
    if i >= len(values):
        return None
    try:
        scaled = float(values[i]) * factor
    except (TypeError, ValueError):
        return None
    return scaled if math.isfinite(scaled) else None


def _extract_load_consumption(ss: System) -> dict[str, LoadConsumption]:
    """Per-load P/Q draw from the converged PF.

    PQ loads expose ``Ppf`` and ``Qpf`` (the post-PF active/reactive
    consumption, in pu). ZIP loads expose the same; the ZIP composition
    is rolled into the same Ppf/Qpf at the converged voltage.

    Best-effort — falls back to ``p0`` / ``q0`` (the input setpoint) if
    ``Ppf`` / ``Qpf`` are unavailable. Always converts to MW / MVAr. A load
    that is out of service (``ue`` of 0, see :func:`_in_service_flags`) draws
    nothing.
    """
    log = logging.getLogger("tensa.wrapper.load_consumption")
    out: dict[str, LoadConsumption] = {}
    try:
        mva_base = float(getattr(ss.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0
    for model_name in ("PQ", "ZIP"):
        model = getattr(ss, model_name, None)
        if model is None:
            continue
        idx_var = getattr(model, "idx", None)
        idx_values = list(getattr(idx_var, "v", []) if idx_var is not None else [])
        if not idx_values:
            continue
        bus_var = getattr(model, "bus", None)
        bus_values = list(getattr(bus_var, "v", []) if bus_var is not None else [])
        # Try Ppf/Qpf first; fall back to p0/q0.
        p_arr = _safe_list(
            getattr(model, "Ppf", None) or getattr(model, "p0", None)
        )
        q_arr = _safe_list(
            getattr(model, "Qpf", None) or getattr(model, "q0", None)
        )
        u_arr = _in_service_flags(model)
        for i, idx in enumerate(idx_values):
            try:
                p_pu = float(p_arr[i]) if i < len(p_arr) else 0.0
                q_pu = float(q_arr[i]) if i < len(q_arr) else 0.0
            except (TypeError, ValueError) as exc:
                log.warning(
                    "%s consumption extraction failed for idx=%r: %s",
                    model_name, idx, exc,
                )
                continue
            if not (math.isfinite(p_pu) and math.isfinite(q_pu)):
                continue
            bus = bus_values[i] if i < len(bus_values) else ""
            bus_coerced = _coerce_scalar(bus)
            bus_final: int | str = bus_coerced if isinstance(bus_coerced, int | str) and not isinstance(bus_coerced, bool) else str(bus)
            # ``Ppf`` / ``Qpf`` ignore ``u``, but a load that is off, or on a bus
            # that is, draws nothing.
            switched_off = i < len(u_arr) and _is_zero(u_arr[i])
            out[str(idx)] = LoadConsumption(
                p=0.0 if switched_off else p_pu * mva_base,
                q=0.0 if switched_off else q_pu * mva_base,
                bus=bus_final,
            )
    return out


def _safe_list(param: Any) -> list[Any]:
    """Defensive ``.v`` reader. Returns [] for None / non-iterable."""
    if param is None:
        return []
    values = getattr(param, "v", None)
    if values is None:
        return []
    try:
        return list(values)
    except TypeError:
        return []


def _extract_line_flows(ss: System) -> dict[str, LineFlow]:
    """Compute per-line P/Q flow at terminal 1 from a converged power-flow
    solution. Returns MW / MVAr (scaled by ``ss.config.mva``).

    ANDES does NOT expose ``ss.Line.p1.v`` directly. We compute the same
    expression that ANDES injects at the ``bus1`` power-balance equation
    (``ss.Line.a1.e_str`` / ``ss.Line.v1.e_str``). This is the standard
    pi-equivalent line model with off-nominal tap and phase shift:

        P1 = ue * (v1^2 * (gh + ghk) * itap2
                   - v1 * v2 * (ghk * cos(a1 - a2 - phi)
                                + bhk * sin(a1 - a2 - phi)) * itap)

        Q1 = ue * (-v1^2 * (bh + bhk) * itap2
                   - v1 * v2 * (ghk * sin(a1 - a2 - phi)
                                - bhk * cos(a1 - a2 - phi)) * itap)

    where ``ue`` is the line's in-service flag, ``gh+ghk`` and ``bh+bhk`` are
    the line's series + shunt admittance services on the bus1 end,
    ``itap = 1 / |tap|``, ``itap2 = itap**2``, and ``phi`` is the phase shift.

    The terminal-2 injection is the line's ``a2`` / ``v2`` equation, which
    ANDES writes with the same shunt terms:

        P2 = ue * (v2^2 * (gh + ghk)
                   - v1 * v2 * (ghk * cos(a1 - a2 - phi)
                                - bhk * sin(a1 - a2 - phi)) * itap)

        Q2 = ue * (-v2^2 * (bh + bhk)
                   + v1 * v2 * (ghk * sin(a1 - a2 - phi)
                                + bhk * cos(a1 - a2 - phi)) * itap)

    Both ends follow the equations the power flow solved, so a bus's balance
    holds with them. ``loss`` is ``P1 + P2``, and the loading is the larger of
    the two terminal apparent powers over ``Line.rate_a`` (MVA; a rating of
    zero means the case sets none, and leaves the rating and loading ``None``).

    All inputs are pulled defensively via ``getattr``; any missing attribute
    (e.g., on an unexpected ANDES API change) returns an empty dict and logs
    a warning. The PF run itself is not affected — line flows are
    best-effort. A missing or malformed ``rate_a`` only leaves every line
    unrated.
    """
    log = logging.getLogger("tensa.wrapper.line_flows")

    line = getattr(ss, "Line", None)
    if line is None:
        return {}
    idx_var = getattr(line, "idx", None)
    if idx_var is None:
        return {}
    idx_values = list(getattr(idx_var, "v", []))
    if not idx_values:
        return {}

    needed = (
        "v1", "v2", "a1", "a2", "phi", "ue",
        "gh", "bh", "ghk", "bhk", "itap", "itap2",
        "bus1", "bus2",
    )
    arrays: dict[str, list[Any]] = {}
    for name in needed:
        attr = getattr(line, name, None)
        if attr is None:
            log.warning("line attribute %r missing; cannot extract line flows", name)
            return {}
        values = getattr(attr, "v", None)
        if values is None:
            log.warning("line.%s.v is None; cannot extract line flows", name)
            return {}
        try:
            arrays[name] = list(values)
        except TypeError:
            log.warning("line.%s.v not iterable; cannot extract line flows", name)
            return {}

    n = len(idx_values)
    for name, vlist in arrays.items():
        if len(vlist) != n:
            log.warning(
                "line.%s.v length %d != idx length %d; cannot extract line flows",
                name, len(vlist), n,
            )
            return {}

    try:
        mva_base = float(getattr(ss.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0

    rate_a_values = _safe_list(getattr(line, "rate_a", None))
    if len(rate_a_values) != n:
        rate_a_values = []

    flows: dict[str, LineFlow] = {}
    try:
        for i, line_idx in enumerate(idx_values):
            v1 = float(arrays["v1"][i])
            v2 = float(arrays["v2"][i])
            a1 = float(arrays["a1"][i])
            a2 = float(arrays["a2"][i])
            phi = float(arrays["phi"][i])
            ue = float(arrays["ue"][i])
            gh = float(arrays["gh"][i])
            bh = float(arrays["bh"][i])
            ghk = float(arrays["ghk"][i])
            bhk = float(arrays["bhk"][i])
            itap = float(arrays["itap"][i])
            itap2 = float(arrays["itap2"][i])
            d = a1 - a2 - phi
            cos_d = math.cos(d)
            sin_d = math.sin(d)
            p_pu = ue * (
                v1 * v1 * (gh + ghk) * itap2
                - v1 * v2 * (ghk * cos_d + bhk * sin_d) * itap
            )
            q_pu = ue * (
                -v1 * v1 * (bh + bhk) * itap2
                - v1 * v2 * (ghk * sin_d - bhk * cos_d) * itap
            )
            p2_pu = ue * (
                v2 * v2 * (gh + ghk)
                - v1 * v2 * (ghk * cos_d - bhk * sin_d) * itap
            )
            q2_pu = ue * (
                -v2 * v2 * (bh + bhk)
                + v1 * v2 * (ghk * sin_d + bhk * cos_d) * itap
            )
            if not all(math.isfinite(x) for x in (p_pu, q_pu, p2_pu, q2_pu)):
                continue
            p_mw = p_pu * mva_base
            q_mvar = q_pu * mva_base
            p_to_mw = p2_pu * mva_base
            q_to_mvar = q2_pu * mva_base
            rate_a = _scaled(rate_a_values, i, 1.0)
            if rate_a is not None and rate_a <= 0.0:
                rate_a = None
            loading_pct = (
                None
                if rate_a is None
                else max(math.hypot(p_mw, q_mvar), math.hypot(p_to_mw, q_to_mvar))
                / rate_a
                * 100.0
            )
            from_idx = arrays["bus1"][i]
            to_idx = arrays["bus2"][i]
            # Coerce numpy scalars (bus indices may be numpy ints from ANDES)
            from_coerced = _coerce_scalar(from_idx)
            to_coerced = _coerce_scalar(to_idx)
            # Bus indices must be int|str — bool/float are unexpected here
            from_bus: int | str
            to_bus: int | str
            if isinstance(from_coerced, int | str) and not isinstance(from_coerced, bool):
                from_bus = from_coerced
            else:
                from_bus = str(from_idx)
            if isinstance(to_coerced, int | str) and not isinstance(to_coerced, bool):
                to_bus = to_coerced
            else:
                to_bus = str(to_idx)
            flows[str(line_idx)] = LineFlow(
                p=p_mw,
                q=q_mvar,
                from_idx=from_bus,
                to_idx=to_bus,
                p_to=p_to_mw,
                q_to=q_to_mvar,
                loss=p_mw + p_to_mw,
                rate_a=rate_a,
                loading_pct=loading_pct,
            )
    except Exception as exc:  # noqa: BLE001 — defensive: never crash PF
        log.warning("line-flow extraction failed: %s", exc)
        return {}
    return flows


def _static_shunts(ss: System) -> list[Any]:
    """Every model of ANDES's ``StaticShunt`` group (``Shunt``, the switched
    ``ShuntSw`` and ``ShuntTD``), or just ``Shunt`` where the group is absent."""
    models = getattr(getattr(ss, "StaticShunt", None), "models", None)
    if isinstance(models, Mapping) and models:
        return list(models.values())
    shunt = getattr(ss, "Shunt", None)
    return [] if shunt is None else [shunt]


def _shunt_absorption(ss: System, mva_base: float) -> tuple[float, float]:
    """The P and Q (MW, MVAr) the in-service bus shunts absorb at the solved
    voltages: ANDES's own ``v**2 * g`` and ``-v**2 * b`` terms, so a capacitor
    (``b`` > 0) absorbs a negative Q. A switched shunt contributes the
    admittance it has switched to (``geff`` / ``beff``), not the ``g`` / ``b`` it
    started from. A model whose arrays do not read is left out; ``(0.0, 0.0)``
    when there is no shunt at all."""
    p_total = q_total = 0.0
    for shunt in _static_shunts(ss):
        switched = hasattr(shunt, "geff") and hasattr(shunt, "beff")
        g_name, b_name = ("geff", "beff") if switched else ("g", "b")
        arrays = [
            _in_service_flags(shunt),
            _safe_list(getattr(shunt, g_name, None)),
            _safe_list(getattr(shunt, b_name, None)),
            _safe_list(getattr(shunt, "v", None)),
        ]
        p_model = q_model = 0.0
        try:
            for u, g, b, v in zip(*arrays, strict=True):
                v2 = float(v) ** 2
                p = float(u) * v2 * float(g)
                q = -float(u) * v2 * float(b)
                if math.isfinite(p) and math.isfinite(q):
                    p_model += p
                    q_model += q
        except (TypeError, ValueError):
            continue
        p_total += p_model
        q_total += q_model
    return p_total * mva_base, q_total * mva_base


def _summarize_pflow(
    ss: System,
    line_flows: dict[str, LineFlow],
    generator_outputs: dict[str, GeneratorOutput],
    load_consumption: dict[str, LoadConsumption],
) -> PflowSummary:
    """Add up a converged power flow: generation, load, bus shunts, line losses
    and the slack generators' output (see :class:`PflowSummary`).

    Built from the rows the other extractors made, which already leave out
    anything switched off, so the totals are the ones the rows on screen add up
    to. The slack output is read off the rows of the in-service ``Slack``
    devices; ``None`` when there is none.
    """
    try:
        mva_base = float(getattr(ss.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0
    shunt_p, shunt_q = _shunt_absorption(ss, mva_base)

    slack = getattr(ss, "Slack", None)
    slack_u = _in_service_flags(slack)
    slack_rows = [
        generator_outputs[str(idx)]
        for i, idx in enumerate(_safe_list(getattr(slack, "idx", None)))
        if str(idx) in generator_outputs and not (i < len(slack_u) and _is_zero(slack_u[i]))
    ]
    return PflowSummary(
        generation_p=sum(g.p for g in generator_outputs.values()),
        generation_q=sum(g.q for g in generator_outputs.values()),
        load_p=sum(load.p for load in load_consumption.values()),
        load_q=sum(load.q for load in load_consumption.values()),
        shunt_p=shunt_p,
        shunt_q=shunt_q,
        loss_p=sum(f.loss for f in line_flows.values()),
        loss_q=sum(f.q + f.q_to for f in line_flows.values()),
        slack_p=sum(g.p for g in slack_rows) if slack_rows else None,
        slack_q=sum(g.q for g in slack_rows) if slack_rows else None,
    )
