"""Arrow IPC encoder + decimation aggregator for TDS streaming.

Each emitted Arrow batch is a self-contained IPC stream chunk (schema
header + one RecordBatch with one or more rows). The schema is ``t:
float64`` plus one float64 column per selected state variable; the
WebSocket ``start_tds`` config's ``vars`` list selects which variable
groups are included in each frame.

The variable groups (and the columns each contributes, in canonical
order) are:

- ``bus_v``     — ``Bus_<idx>_v`` (voltage magnitude, pu) +
  ``Bus_<idx>_a`` (voltage angle, rad) per bus.
- ``gen_state`` — ``Gen_<idx>_delta`` (rotor angle, rad) +
  ``Gen_<idx>_omega`` (per-unit speed, the frequency proxy) per SynGen.
- ``gen_power`` — ``Gen_<idx>_Pe`` (electrical active power, MW) +
  ``Gen_<idx>_Qe`` (electrical reactive power, MVar) per SynGen.
- ``line_flow`` — ``Line_<idx>_p`` (active power at terminal 1, MW) +
  ``Line_<idx>_q`` (reactive power at terminal 1, MVar) per line.
- ``load_pq``   — ``Load_<idx>_p`` (active consumption, MW) +
  ``Load_<idx>_q`` (reactive consumption, MVar) per PQ load.

The default selection is ``bus_v`` + ``gen_state`` so voltages, angles,
and the frequency proxy are always plottable without re-running.

Two streaming modes:

- ``decimation="none"`` — every callpert step is one row. If
  ``max_rate_hz`` is also configured, multiple source steps are batched
  into one Arrow batch every ``1/max_rate_hz`` simulated seconds (cuts
  Arrow framing overhead from ~50% to ~3% per the plan's N-rows-per-batch
  guidance). Otherwise every step is its own one-row batch (highest
  fidelity, highest overhead, useful for spectral debugging).
- ``decimation="mean"`` — every aggregation window emits one row whose
  values are the boxcar mean of source steps in that window. Anti-aliases
  oscillations above the output Nyquist *when the integrator is fixed-step*;
  on adaptive-step integrators (ANDES default) the math is best-effort,
  declared honestly via ``algorithm: "boxcar-mean-best-effort"`` in the
  stream-start metadata.

The ``StreamAggregator`` owns the buffering decision; the worker just
calls ``push(t, values)`` per callpert step and ``flush()`` at run end,
and emits whatever rows the aggregator returns as one Arrow batch.
"""

from __future__ import annotations

import io
import logging
import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import pyarrow as pa
import pyarrow.ipc

if TYPE_CHECKING:
    from andes.system import System


DecimationAlgorithm = Literal["none", "boxcar-mean", "boxcar-mean-best-effort"]
DecimationMode = Literal["none", "mean"]

# ``vars`` selector: each entry expands into a contiguous run of
# columns in the Arrow schema (in the order listed in ``VAR_GROUPS``).
# Adding a group here + its column/collect helpers extends the combined
# schema, the per-tick collector, the worker idx-snapshot, AND the WS
# vars-validation gate automatically (they all iterate ``VAR_GROUPS``).
VarGroup = Literal["bus_v", "gen_state", "gen_power", "line_flow", "load_pq"]
VAR_GROUPS: tuple[VarGroup, ...] = (
    "bus_v",
    "gen_state",
    "gen_power",
    "line_flow",
    "load_pq",
)
# Default streamed vars: voltage (+ angle) + generator state so frequency
# (omega) is always plottable without re-running. The UI may default to a
# narrower display selection, but the wire carries both groups.
DEFAULT_VARS: tuple[VarGroup, ...] = ("bus_v", "gen_state")

log = logging.getLogger("andes-app.stream")


# ---- schema -----------------------------------------------------------------


def make_bus_voltage_schema(bus_idx_values: list[int | str]) -> pa.Schema:
    """Build the Arrow schema for a stream emitting bus state over time.

    ``t`` is the simulation time; for each bus two columns are emitted in
    idx order: ``Bus_<idx>_v`` (voltage magnitude, pu) then
    ``Bus_<idx>_a`` (voltage angle, rad). Column names are stable across
    the stream and surfaced in the stream-start metadata.
    """
    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    fields.extend(_bus_voltage_columns(bus_idx_values))
    return pa.schema(fields)


def _bus_voltage_columns(bus_idx_values: list[int | str]) -> list[pa.Field]:
    fields: list[pa.Field] = []
    for idx in bus_idx_values:
        fields.append(pa.field(f"Bus_{idx}_v", pa.float64()))
        fields.append(pa.field(f"Bus_{idx}_a", pa.float64()))
    return fields


def make_generator_state_schema(syngen_idx_values: list[int | str]) -> pa.Schema:
    """Build the Arrow schema for a stream emitting generator state over time.

    Two columns per generator: ``Gen_<idx>_delta`` (rotor angle, rad) and
    ``Gen_<idx>_omega`` (per-unit speed). Order: delta then omega for each
    idx, in the listed idx order. ``syngen_idx_values`` covers the
    ``SynGen`` group (parent of GENROU / GENCLS / PLBVFU1); static
    generators (``PV`` / ``Slack``) have no rotor state and are NOT
    included. An empty list yields a schema with only the ``t`` column,
    which is well-formed but useless on its own — callers compose with
    other schemas via :func:`make_combined_schema`.
    """
    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    fields.extend(_generator_state_columns(syngen_idx_values))
    return pa.schema(fields)


def _generator_state_columns(syngen_idx_values: list[int | str]) -> list[pa.Field]:
    fields: list[pa.Field] = []
    for idx in syngen_idx_values:
        fields.append(pa.field(f"Gen_{idx}_delta", pa.float64()))
        fields.append(pa.field(f"Gen_{idx}_omega", pa.float64()))
    return fields


def make_generator_power_schema(syngen_idx_values: list[int | str]) -> pa.Schema:
    """Build the Arrow schema for a stream emitting generator electrical
    power over time.

    Two columns per generator: ``Gen_<idx>_Pe`` (electrical active power,
    MW) and ``Gen_<idx>_Qe`` (electrical reactive power, MVar). Order: Pe
    then Qe for each idx, in the listed idx order. ``syngen_idx_values``
    covers the ``SynGen`` group (same membership as
    :func:`make_generator_state_schema`); static generators have no
    electrical-power states and are NOT included. An empty list yields a
    schema with only the ``t`` column — well-formed for composition via
    :func:`make_combined_schema`.
    """
    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    fields.extend(_generator_power_columns(syngen_idx_values))
    return pa.schema(fields)


def _generator_power_columns(syngen_idx_values: list[int | str]) -> list[pa.Field]:
    fields: list[pa.Field] = []
    for idx in syngen_idx_values:
        fields.append(pa.field(f"Gen_{idx}_Pe", pa.float64()))
        fields.append(pa.field(f"Gen_{idx}_Qe", pa.float64()))
    return fields


def make_line_flow_schema(line_idx_values: list[int | str]) -> pa.Schema:
    """Build the Arrow schema for a stream emitting per-line power flow.

    Two columns per line: ``Line_<idx>_p`` (active power, MW) then
    ``Line_<idx>_q`` (reactive power, MVar), both measured at terminal 1
    (the ``bus1`` end) and computed in pu then multiplied by the system
    base MVA. An empty list yields a schema with only the ``t`` column —
    useful in combination with other groups via
    :func:`make_combined_schema`, and required to keep ``vars=[
    "line_flow"]`` well-formed on cases with zero lines.
    """
    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    fields.extend(_line_flow_columns(line_idx_values))
    return pa.schema(fields)


def _line_flow_columns(line_idx_values: list[int | str]) -> list[pa.Field]:
    fields: list[pa.Field] = []
    for idx in line_idx_values:
        fields.append(pa.field(f"Line_{idx}_p", pa.float64()))
        fields.append(pa.field(f"Line_{idx}_q", pa.float64()))
    return fields


def make_load_pq_schema(pq_idx_values: list[int | str]) -> pa.Schema:
    """Build the Arrow schema for a stream emitting per-load consumption.

    Two columns per PQ load: ``Load_<idx>_p`` (active consumption, MW)
    then ``Load_<idx>_q`` (reactive consumption, MVar). Values come from
    the PQ model's post-PF power (``Ppf``/``Qpf``, pu) scaled by the
    system base MVA. An empty list yields a schema with only the ``t``
    column — well-formed for composition via :func:`make_combined_schema`
    and on cases with zero PQ loads.
    """
    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    fields.extend(_load_pq_columns(pq_idx_values))
    return pa.schema(fields)


def _load_pq_columns(pq_idx_values: list[int | str]) -> list[pa.Field]:
    fields: list[pa.Field] = []
    for idx in pq_idx_values:
        fields.append(pa.field(f"Load_{idx}_p", pa.float64()))
        fields.append(pa.field(f"Load_{idx}_q", pa.float64()))
    return fields


def make_combined_schema(
    var_groups: list[VarGroup] | tuple[VarGroup, ...],
    system: System,
) -> tuple[pa.Schema, list[str]]:
    """Build a unified Arrow schema for the requested variable groups.

    ``var_groups`` is an ordered, deduplicated subset of :data:`VAR_GROUPS`.
    The returned schema has ``t`` as its first column followed by, for
    each requested group in canonical :data:`VAR_GROUPS` order, the
    columns that group contributes (sourced live from ``system``). The
    second tuple element is the column-name list (excluding ``t``) — the
    same list ``stream_start.metadata.var_columns`` advertises to the
    client so the picker tree can be wired without the client having to
    re-introspect the topology.
    """
    if not var_groups:
        raise ValueError("var_groups must be a non-empty subset of VAR_GROUPS")
    requested = set(var_groups)
    unknown = requested - set(VAR_GROUPS)
    if unknown:
        raise ValueError(f"unknown var groups: {sorted(unknown)!r}")

    fields: list[pa.Field] = [pa.field("t", pa.float64())]
    var_columns: list[str] = []

    # Iterate in canonical group order so the schema layout is stable
    # regardless of how the client ordered ``vars`` in the request.
    for group in VAR_GROUPS:
        if group not in requested:
            continue
        if group == "bus_v":
            cols = _bus_voltage_columns(bus_idx_values_from_system(system))
        elif group == "gen_state":
            cols = _generator_state_columns(syngen_idx_values_from_system(system))
        elif group == "gen_power":
            cols = _generator_power_columns(syngen_idx_values_from_system(system))
        elif group == "line_flow":
            cols = _line_flow_columns(line_idx_values_from_system(system))
        elif group == "load_pq":
            cols = _load_pq_columns(pq_idx_values_from_system(system))
        else:  # pragma: no cover — exhaustively handled above
            raise ValueError(f"unexpected var group: {group!r}")
        fields.extend(cols)
        var_columns.extend(f.name for f in cols)

    return pa.schema(fields), var_columns


# ---- encoding ---------------------------------------------------------------


def encode_batch(
    schema: pa.Schema,
    rows: Iterable[tuple[float, list[float]]],
) -> bytes:
    """Encode one or more rows into a self-contained Arrow IPC stream chunk.

    ``rows`` is an iterable of ``(t, values)`` tuples. Each value list must
    match the schema's variable columns in order. ``t`` and each variable
    value may arrive as numpy scalars or 0-d ndarrays (ANDES's ``dae.t`` is a
    numpy scalar); we coerce to ``float`` so pyarrow's array constructor
    doesn't need to introspect the wrapper type.
    """
    rows_list = list(rows)
    if not rows_list:
        # Empty batch is meaningless; signal up to caller.
        raise ValueError("encode_batch called with no rows")

    n_vars = len(rows_list[0][1])
    t_array = pa.array([float(t) for t, _ in rows_list], type=pa.float64())
    var_arrays = [
        pa.array(
            [float(row_values[i]) for _t, row_values in rows_list],
            type=pa.float64(),
        )
        for i in range(n_vars)
    ]
    columns: list[pa.Array] = [t_array, *var_arrays]
    batch = pa.RecordBatch.from_arrays(columns, schema=schema)
    sink = io.BytesIO()
    # pyarrow ships partial stubs; new_stream is untyped in the published type
    # information but is a stable API.
    with pa.ipc.new_stream(sink, schema) as writer:  # type: ignore[no-untyped-call]
        writer.write_batch(batch)
    return sink.getvalue()


# ---- ANDES wiring -----------------------------------------------------------


def collect_bus_voltages(system: System) -> list[float]:
    """Read the current bus voltage magnitude + angle off the System's Bus
    model, interleaved ``[v_0, a_0, v_1, a_1, ...]`` in bus idx order.

    Magnitudes come from ``Bus.v.v`` (pu); angles from ``Bus.a.v`` (rad).
    The interleave matches :func:`_bus_voltage_columns`'s ``Bus_<idx>_v``
    then ``Bus_<idx>_a`` layout. If the angle algebraic variable is
    missing (an unexpected ANDES API change), angles emit as ``nan`` so
    the run never crashes over a single bad read.
    """
    mags = [float(v) for v in system.Bus.v.v]
    a_var = getattr(system.Bus, "a", None)
    a_values = getattr(a_var, "v", None) if a_var is not None else None
    if a_values is None:
        log.warning("Bus.a.v missing; emitting NaN angle columns")
        angles = [float("nan")] * len(mags)
    else:
        angles = [float(a) for a in a_values]
        if len(angles) != len(mags):
            log.warning(
                "Bus.a.v length %d != Bus.v.v length %d; emitting NaN angles",
                len(angles), len(mags),
            )
            angles = [float("nan")] * len(mags)
    out: list[float] = []
    for v, a in zip(mags, angles, strict=True):
        out.append(v)
        out.append(a)
    return out


def bus_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES bus idx values in the order their voltage +
    angle columns will appear in each Arrow batch."""
    return list(system.Bus.idx.v)


def syngen_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES SynGen idx values (across GENROU / GENCLS / etc.)
    in the order :func:`collect_generator_state` will read them.

    ``ss.SynGen`` is the ANDES *group* parent of the dynamic generator
    models (``GENROU``, ``GENCLS``, ``PLBVFU1``). Static generators
    (``PV``, ``Slack``) are NOT in this group — they have no rotor state
    and contribute zero columns to the gen_state stream. On a case with
    no dynamic generators (e.g., a .raw loaded without a .dyr addfile),
    this returns ``[]`` and the gen_state schema is well-formed-empty.
    """
    syngen = getattr(system, "SynGen", None)
    if syngen is None:
        return []
    try:
        return list(syngen.get_all_idxes())
    except AttributeError:  # pragma: no cover — older ANDES versions
        return []


def collect_generator_state(
    system: System, syngen_idx_values: list[int | str]
) -> list[float]:
    """Read the SynGen group's ``delta`` + ``omega`` for each idx, in the
    same order :func:`make_generator_state_schema` lays out: ``[delta_0,
    omega_0, delta_1, omega_1, ...]``. ``syngen_idx_values`` is captured
    once at run start (it does not change mid-run).
    """
    if not syngen_idx_values:
        return []
    syngen = system.SynGen
    deltas = list(syngen.get("delta", syngen_idx_values, "v"))
    omegas = list(syngen.get("omega", syngen_idx_values, "v"))
    out: list[float] = []
    for d, o in zip(deltas, omegas, strict=True):
        out.append(float(d))
        out.append(float(o))
    return out


def collect_generator_power(
    system: System, syngen_idx_values: list[int | str]
) -> list[float]:
    """Read the SynGen group's electrical power for each idx, in the same
    order :func:`make_generator_power_schema` lays out: ``[Pe_0, Qe_0,
    Pe_1, Qe_1, ...]`` in MW / MVar.

    ``Pe``/``Qe`` are SynGen algebraic services in system-base pu; we
    multiply by ``system.config.mva`` to surface MW / MVar. They are only
    populated after ``TDS.init``; during a streaming run (reads fire from
    ``callpert``, post-init) they carry live values. ``syngen_idx_values``
    is captured once at run start.
    """
    if not syngen_idx_values:
        return []
    syngen = system.SynGen
    try:
        mva_base = float(getattr(system.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0
    pes = list(syngen.get("Pe", syngen_idx_values, "v"))
    qes = list(syngen.get("Qe", syngen_idx_values, "v"))
    out: list[float] = []
    for p, q in zip(pes, qes, strict=True):
        out.append(float(p) * mva_base)
        out.append(float(q) * mva_base)
    return out


def line_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES Line idx values in the order
    :func:`collect_line_active_power` will read them. Cases with no Line
    elements yield ``[]`` and a well-formed-empty line_flow schema."""
    line = getattr(system, "Line", None)
    if line is None:
        return []
    idx_var = getattr(line, "idx", None)
    if idx_var is None:
        return []
    return list(getattr(idx_var, "v", []))


# Line-flow attribute set sourced live from the System each callpert tick.
# Mirrors ``andes_app.core.wrapper._extract_line_flows`` — ANDES does not
# expose ``ss.Line.p1`` / ``ss.Line.q1`` directly, so we recompute the same
# pi-equivalent expressions that ANDES injects into the bus1 power-balance
# equations. ``bh`` is needed for the Q1 shunt-susceptance term.
_LINE_FLOW_ATTRS: tuple[str, ...] = (
    "v1", "v2", "a1", "a2", "phi", "ue",
    "gh", "bh", "ghk", "bhk", "itap", "itap2",
)


def collect_line_active_power(
    system: System, line_idx_values: list[int | str]
) -> list[float]:
    """Compute the P + Q flow at terminal 1 for each line, in MW / MVar,
    interleaved ``[p_0, q_0, p_1, q_1, ...]`` in idx order.

    Mirrors :func:`andes_app.core.wrapper._extract_line_flows`'s formulae
    (P1 and Q1 of the standard pi-equivalent line model with off-nominal
    tap + phase shift). Pulls live algebraic-variable values off
    ``ss.Line`` (``v1``/``v2``, ``a1``/``a2``, plus the immutable per-line
    line params) and returns two floats per idx in ``line_idx_values``,
    matching :func:`_line_flow_columns`'s ``Line_<idx>_p`` then
    ``Line_<idx>_q`` layout. Non-finite intermediate results (e.g., a
    divergent step) emit ``nan`` rather than raising — uPlot handles NaN
    gaps and the substrate must not crash a long sim over a single bad
    line value.
    """
    if not line_idx_values:
        return []
    line = system.Line
    n = len(line_idx_values)
    arrays: dict[str, list[float]] = {}
    for name in _LINE_FLOW_ATTRS:
        attr = getattr(line, name, None)
        if attr is None:
            log.warning(
                "line.%s missing; emitting NaN line_flow columns", name
            )
            return [float("nan")] * (2 * n)
        values = getattr(attr, "v", None)
        if values is None:
            log.warning(
                "line.%s.v is None; emitting NaN line_flow columns", name
            )
            return [float("nan")] * (2 * n)
        try:
            arrays[name] = [float(v) for v in values]
        except (TypeError, ValueError):
            log.warning(
                "line.%s.v not iterable as floats; emitting NaN", name
            )
            return [float("nan")] * (2 * n)

    for name, vlist in arrays.items():
        if len(vlist) != n:
            log.warning(
                "line.%s.v length %d != idx length %d; emitting NaN",
                name, len(vlist), n,
            )
            return [float("nan")] * (2 * n)

    try:
        mva_base = float(getattr(system.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0

    out: list[float] = []
    for i in range(n):
        v1 = arrays["v1"][i]
        v2 = arrays["v2"][i]
        a1 = arrays["a1"][i]
        a2 = arrays["a2"][i]
        phi = arrays["phi"][i]
        ue = arrays["ue"][i]
        gh = arrays["gh"][i]
        bh = arrays["bh"][i]
        ghk = arrays["ghk"][i]
        bhk = arrays["bhk"][i]
        itap = arrays["itap"][i]
        itap2 = arrays["itap2"][i]
        d = a1 - a2 - phi
        cos_d = math.cos(d)
        sin_d = math.sin(d)
        p_pu = ue * (
            v1 * v1 * (gh + ghk) * itap2
            - v1 * v2 * (ghk * cos_d + bhk * sin_d) * itap
        )
        # Q1 mirrors wrapper._extract_line_flows exactly: the shunt term
        # uses (bh + bhk) and the series cross-term flips sign vs. P1.
        q_pu = ue * (
            -v1 * v1 * (bh + bhk) * itap2
            - v1 * v2 * (ghk * sin_d - bhk * cos_d) * itap
        )
        p_mw = p_pu * mva_base
        q_mvar = q_pu * mva_base
        out.append(p_mw if math.isfinite(p_mw) else float("nan"))
        out.append(q_mvar if math.isfinite(q_mvar) else float("nan"))
    return out


def pq_idx_values_from_system(system: System) -> list[int | str]:
    """Return the ANDES PQ idx values in the order
    :func:`collect_load_consumption` will read them. Cases with no PQ
    loads yield ``[]`` and a well-formed-empty load_pq schema.

    Only the ``PQ`` model is included (constant-power loads). ZIP loads
    are a separate model and are not part of this group's contract.
    """
    pq = getattr(system, "PQ", None)
    if pq is None:
        return []
    idx_var = getattr(pq, "idx", None)
    if idx_var is None:
        return []
    return list(getattr(idx_var, "v", []))


def collect_load_consumption(
    system: System, pq_idx_values: list[int | str]
) -> list[float]:
    """Compute the P + Q consumption for each PQ load, in MW / MVar,
    interleaved ``[p_0, q_0, p_1, q_1, ...]`` in idx order.

    Mirrors :func:`andes_app.core.wrapper._extract_load_consumption` for
    the PQ model: reads ``Ppf`` / ``Qpf`` (the post-PF active / reactive
    power, pu) and scales by ``system.config.mva``. Falls back to the
    ``p0`` / ``q0`` set-points if ``Ppf`` / ``Qpf`` are unavailable.
    ``pq_idx_values`` is captured once at run start. Non-finite values
    emit ``nan`` rather than raising.
    """
    if not pq_idx_values:
        return []
    pq = getattr(system, "PQ", None)
    if pq is None:
        return [float("nan")] * (2 * len(pq_idx_values))
    try:
        mva_base = float(getattr(system.config, "mva", 100.0))
    except (TypeError, ValueError):
        mva_base = 100.0
    p_arr = _safe_param_list(getattr(pq, "Ppf", None) or getattr(pq, "p0", None))
    q_arr = _safe_param_list(getattr(pq, "Qpf", None) or getattr(pq, "q0", None))
    out: list[float] = []
    for i in range(len(pq_idx_values)):
        try:
            p_pu = float(p_arr[i]) if i < len(p_arr) else float("nan")
            q_pu = float(q_arr[i]) if i < len(q_arr) else float("nan")
        except (TypeError, ValueError):
            p_pu = float("nan")
            q_pu = float("nan")
        p_mw = p_pu * mva_base
        q_mvar = q_pu * mva_base
        out.append(p_mw if math.isfinite(p_mw) else float("nan"))
        out.append(q_mvar if math.isfinite(q_mvar) else float("nan"))
    return out


def _safe_param_list(param: object) -> list[float]:
    """Defensive ``.v`` reader for a PQ NumParam/Service. Returns ``[]``
    for ``None`` / a missing or non-iterable ``.v`` (mirrors the
    wrapper's ``_safe_list``)."""
    if param is None:
        return []
    values = getattr(param, "v", None)
    if values is None:
        return []
    try:
        return [float(v) for v in values]
    except (TypeError, ValueError):
        return []


def collect_combined_values(
    system: System,
    var_groups: list[VarGroup] | tuple[VarGroup, ...],
    *,
    syngen_idx_values: list[int | str],
    line_idx_values: list[int | str],
    pq_idx_values: list[int | str] | None = None,
) -> list[float]:
    """Read all selected groups' values and return them in the schema's
    column order (matching :func:`make_combined_schema`).

    ``syngen_idx_values``, ``line_idx_values``, and ``pq_idx_values`` are
    captured once at run start so we don't re-introspect the topology each
    callpert tick. Bus voltages + angles are read live every call because
    the Bus model is always present; idx-snapshot caching is unnecessary
    there (``Bus.v.v`` / ``Bus.a.v`` are read directly). ``pq_idx_values``
    defaults to ``[]`` for callers that never select the ``load_pq`` group.
    """
    if pq_idx_values is None:
        pq_idx_values = []
    requested = set(var_groups)
    out: list[float] = []
    for group in VAR_GROUPS:
        if group not in requested:
            continue
        if group == "bus_v":
            out.extend(collect_bus_voltages(system))
        elif group == "gen_state":
            out.extend(collect_generator_state(system, syngen_idx_values))
        elif group == "gen_power":
            out.extend(collect_generator_power(system, syngen_idx_values))
        elif group == "line_flow":
            out.extend(collect_line_active_power(system, line_idx_values))
        elif group == "load_pq":
            out.extend(collect_load_consumption(system, pq_idx_values))
    return out


# ---- aggregator -------------------------------------------------------------


@dataclass
class StreamAggregator:
    """Buffers per-step ``(t, values)`` snapshots and decides when to emit.

    Modes:

    - ``decimation="none"`` + ``max_rate_hz=None`` — every push emits as a
      one-row batch (no aggregation; one Arrow batch per source step).
    - ``decimation="none"`` + ``max_rate_hz=N`` — buffer until
      ``next_emit_t``, then emit all buffered rows as one Arrow batch
      (N-rows-per-batch; cuts Arrow framing overhead).
    - ``decimation="mean"`` + ``max_rate_hz=N`` — buffer until
      ``next_emit_t``, then emit one row whose values are the mean of all
      buffered values (anti-aliased decimation; output rate = N Hz).

    ``decimation="mean"`` requires ``max_rate_hz`` (the aggregation window
    is ``1/max_rate_hz`` simulated seconds). The constructor raises
    ``ValueError`` if the combination is invalid.
    """

    decimation: DecimationMode
    max_rate_hz: float | None
    fixed_step: bool = False  # ANDES TDS.config.fixt
    _next_emit_t: float | None = None
    _buffer: list[tuple[float, list[float]]] | None = None

    def __post_init__(self) -> None:
        if self.decimation == "mean" and self.max_rate_hz is None:
            raise ValueError(
                "decimation='mean' requires max_rate_hz to be set "
                "(the aggregation window is 1/max_rate_hz seconds)"
            )
        self._buffer = []

    @property
    def algorithm(self) -> DecimationAlgorithm:
        """Honest algorithm label for the stream-start metadata."""
        if self.decimation == "none":
            return "none"
        # For mean: only label "boxcar-mean" if integrator is fixed-step;
        # otherwise the math is best-effort because samples aren't uniformly
        # spaced in simulated time.
        return "boxcar-mean" if self.fixed_step else "boxcar-mean-best-effort"

    @property
    def output_rate_hz(self) -> float | None:
        """Output emission rate (Hz) declared in the stream-start metadata.

        ``None`` when no rate-bound aggregation is active (every source
        step emits)."""
        return self.max_rate_hz if self.max_rate_hz is not None else None

    @property
    def aggregation_window(self) -> float | None:
        """Aggregation window in simulated seconds, or ``None`` if no rate."""
        return 1.0 / self.max_rate_hz if self.max_rate_hz is not None else None

    def push(
        self, t: float, values: list[float]
    ) -> list[tuple[float, list[float]]] | None:
        """Add a per-step snapshot. Returns the list of rows to emit as one
        Arrow batch, or ``None`` if no emit is due yet.

        Window alignment is anchored to the t=0 simulation origin so windows
        are predictable: [0, W), [W, 2W), ... A sample at exactly the
        boundary t=k*W belongs to window k (the higher-numbered one) and
        seeds the new window's buffer; the previous window's accumulated
        rows emit.
        """
        assert self._buffer is not None  # set in __post_init__
        window = self.aggregation_window

        if window is None:
            # decimation="none" + no rate → emit immediately, no buffering.
            return [(t, values)]

        # Anchor the first emit deadline to the t=0 origin: the next boundary
        # is the smallest k*W strictly greater than t. (k = floor(t/W) + 1)
        if self._next_emit_t is None:
            self._next_emit_t = (int(t // window) + 1) * window

        if t < self._next_emit_t:
            # Still inside the current window — buffer and don't emit.
            self._buffer.append((t, values))
            return None

        # Window boundary crossed. Drain the previous window's contents and
        # emit them now; the just-pushed sample belongs to the new window.
        rows = self._drain_buffer()

        # Advance the window. Multiple boundaries may have passed in rare
        # cases (large jumps in simulated t); align next_emit_t to the next
        # boundary strictly greater than the current sample.
        while self._next_emit_t <= t:
            self._next_emit_t += window

        # Seed the new window with the just-pushed sample.
        self._buffer.append((t, values))
        return rows

    def flush(self) -> list[tuple[float, list[float]]] | None:
        """Emit any buffered rows at end of run. Returns ``None`` if buffer
        is empty (e.g., no callpert fired since the last emit)."""
        assert self._buffer is not None
        if not self._buffer:
            return None
        return self._drain_buffer()

    def _drain_buffer(self) -> list[tuple[float, list[float]]]:
        assert self._buffer is not None
        if self.decimation == "none":
            rows = list(self._buffer)
        else:  # mean
            n = len(self._buffer)
            t_mean = sum(b[0] for b in self._buffer) / n
            n_vars = len(self._buffer[0][1])
            mean_values = [
                sum(b[1][i] for b in self._buffer) / n for i in range(n_vars)
            ]
            rows = [(t_mean, mean_values)]
        self._buffer.clear()
        return rows


__all__ = [
    "DEFAULT_VARS",
    "VAR_GROUPS",
    "DecimationAlgorithm",
    "DecimationMode",
    "StreamAggregator",
    "VarGroup",
    "bus_idx_values_from_system",
    "collect_bus_voltages",
    "collect_combined_values",
    "collect_generator_power",
    "collect_generator_state",
    "collect_line_active_power",
    "collect_load_consumption",
    "encode_batch",
    "line_idx_values_from_system",
    "make_bus_voltage_schema",
    "make_combined_schema",
    "make_generator_power_schema",
    "make_generator_state_schema",
    "make_line_flow_schema",
    "make_load_pq_schema",
    "pq_idx_values_from_system",
    "syngen_idx_values_from_system",
]
