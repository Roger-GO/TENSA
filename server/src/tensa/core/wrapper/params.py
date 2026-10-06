"""The models and parameters a client may add, edit or see, and the dynamic
models the topology snapshot lists apart."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

# Unit-8 dynamic-model class names surfaced as a separate ``controllers``
# bucket on the topology snapshot (Unit 8.1). Order is the canonical
# rendering order: exciters → governors → PSS → renewable-interface.
# Each name must match the ANDES System attribute name 1:1
# (``ss.IEEEX1``, ``ss.IEEEG1``, etc.). Models with no instances on a given
# case are simply absent from the bucket — ``_collect_models`` skips empty
# / missing model attrs.
_CONTROLLER_MODEL_NAMES: tuple[str, ...] = (
    "IEEEX1",
    "ESDC2A",
    "SEXS",
    "IEEEG1",
    "TGOV1",
    "IEEEST",
    "REGCA1",
    # Unit 15 (v3.1): the R15 dynamic-model expansion — nine more
    # controller classes researchers attach to machines / renewable
    # plants. Exciters first (EXST1, ESST1A), then governors (GAST,
    # HYGOV, IEESGO), then the dual-input PSS (ST2CUT), then the
    # renewable interface stack (REGCP1 grid-following converter,
    # REECA1 electrical control, REPCA1 plant control).
    #
    # NOTE ON NAMES: the v3.1 plan named this set using PSS/E
    # identifiers (``ST6BU``, ``PSS2A``). ANDES 2.0.0 ships no model
    # class under those names — ``_PARAMS_BY_MODEL`` / this tuple key
    # on the ANDES System attribute name 1:1, so guessed names would
    # silently never match a loaded device. The two PSS/E-only names
    # are mapped to their nearest ANDES-native equivalents in the same
    # device family: ST6BU (a static ST-family exciter) → ``ESST1A``;
    # PSS2A (a dual-input stabilizer) → ``ST2CUT`` (the only ANDES PSS
    # besides the already-whitelisted ``IEEEST``). All param metadata
    # below is introspected from the real ANDES model classes.
    "EXST1",
    "ESST1A",
    "GAST",
    "HYGOV",
    "IEESGO",
    "ST2CUT",
    "REGCP1",
    "REECA1",
    "REPCA1",
    # ESD1, ANDES's distributed energy storage: a converter with a state of
    # charge that takes over a static generator on its bus, as REGCA1 does.
    # ``tensa.core.esd1`` holds what an add or an edit of one is checked for.
    "ESD1",
    # Unit 14: PMU instances (PhasorMeasurement group) appear in the
    # controllers bucket so the SLD/topology view can surface their
    # placement alongside exciters/governors. PMU has ``flags.tds=True``
    # only — it contributes nothing to PFlow but tracks bus voltage
    # phasor (am, vm) state during TDS for post-run CSV export.
    "PMU",
    # Unit 15: TimeSeries profiles (DataSeries group) ship in the same
    # bucket so the topology view can surface scheduled profile drivers
    # alongside other auxiliary devices. ``flags.tds=True`` only — the
    # model has no PFlow contribution.
    "TimeSeries",
)


# Per-model ConstService sources that ANDES accepts as an ``Alter`` ``src`` but
# which are NOT NumParams (so ``alterable_params``' NumParam scan misses them).
# A PQ load's time-domain power lives in ``Ppf``/``Qpf``; altering ``p0``/``q0``
# only changes power flow and is a silent no-op in TDS — so a "load increase"
# disturbance MUST target these services to move the simulation. Conservative
# whitelist; extend per model as needed.
_ALTERABLE_SERVICES: dict[str, tuple[str, ...]] = {
    "PQ": ("Ppf", "Qpf"),
    # A battery's power in a run is its set-point ``pref0`` (taken from the
    # static generator at the start) plus the external signal ``Pext0``, both
    # per unit of the system base. Altering either steps what it delivers; its
    # NumParams only move the limits on that.
    "ESD1": ("pref0", "Pext0"),
}


# Per-model parameter metadata. Drives three things:
#
# 1. The Inspector Properties tab read-back (legacy path; idx + name are
#    handled separately in ``_collect_models`` and skipped during extract).
# 2. The Add / Edit form schema published to the web client at
#    ``GET /api/topology/schema`` — consumed by Unit 6's polymorphic form
#    generator. ``kind``, ``required``, and ``unit`` flow through to form
#    rendering (input type, required asterisk, inline unit suffix).
# 3. The whitelist check in ``add_element`` / ``edit_element`` — any param
#    key absent from this table for a given model is rejected with 422
#    ``ElementValidationError`` BEFORE any ANDES call.
#
# Required vs. optional reflects ANDES's own contract: parameters without
# a sensible default (e.g., the bus a generator attaches to) are required.
# Defaulted params (limits, area / zone, etc.) are optional.
#
# Trafo (2W) note: ANDES 2.0 has no separate ``Trafo`` model class —
# transformers live in the ``Line`` model with non-default ``tap`` (and
# optionally ``phi``). The Add panel's "Transformer 2W" form maps to
# ``model='Line'`` with ``tap`` required; downstream ``_topology_snapshot``
# splits them via the ``tap != 1.0 OR phi != 0.0`` heuristic.
ParamKind = Literal["string", "number", "bus_idx", "gen_idx", "syn_idx", "bool"]


@dataclass(frozen=True)
class ParamMeta:
    """One parameter row in ``_PARAMS_BY_MODEL`` — name + form metadata."""

    name: str
    kind: ParamKind
    required: bool = False
    unit: str | None = None


_PARAMS_BY_MODEL: dict[str, tuple[ParamMeta, ...]] = {
    "Bus": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("vmax", "number", unit="pu"),
        ParamMeta("vmin", "number", unit="pu"),
        ParamMeta("area", "number"),
        ParamMeta("zone", "number"),
    ),
    "Line": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus1", "bus_idx", required=True),
        ParamMeta("bus2", "bus_idx", required=True),
        ParamMeta("r", "number", required=True, unit="pu"),
        ParamMeta("x", "number", required=True, unit="pu"),
        ParamMeta("b", "number", unit="pu"),
        ParamMeta("g", "number", unit="pu"),
        ParamMeta("tap", "number"),
        ParamMeta("phi", "number", unit="rad"),
        # Long-term flow limit. The power flow does not use it: it is the
        # rating a line's loading is read against (0 means the case sets none).
        ParamMeta("rate_a", "number", unit="MVA"),
        # Connection status (1 = in service, 0 = out of service). Editable so
        # contingency studies can outage a branch through the API / inspector
        # and re-run PF, instead of faking an open line with huge impedance.
        ParamMeta("u", "number"),
    ),
    "PV": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("p0", "number", required=True, unit="pu"),
        ParamMeta("v0", "number", required=True, unit="pu"),
        ParamMeta("pmax", "number", unit="pu"),
        ParamMeta("pmin", "number", unit="pu"),
        ParamMeta("qmax", "number", unit="pu"),
        ParamMeta("qmin", "number", unit="pu"),
    ),
    "Slack": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("p0", "number", unit="pu"),
        ParamMeta("v0", "number", required=True, unit="pu"),
        ParamMeta("a0", "number", unit="rad"),
        ParamMeta("pmax", "number", unit="pu"),
        ParamMeta("pmin", "number", unit="pu"),
        ParamMeta("qmax", "number", unit="pu"),
        ParamMeta("qmin", "number", unit="pu"),
    ),
    "GENROU": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        # ``gen`` links the dynamic machine to its static generator (PV/Slack);
        # ANDES marks it mandatory. Without it the form produced a malformed
        # GENROU (rejected by ANDES + corrupting xlsx save).
        ParamMeta("gen", "gen_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("H", "number", required=True, unit="MWs/MVA"),
        ParamMeta("D", "number", unit="pu"),
        ParamMeta("M", "number", unit="MWs/MVA"),
        ParamMeta("ra", "number", unit="pu"),
        ParamMeta("xl", "number", unit="pu"),
        ParamMeta("xd", "number", unit="pu"),
        ParamMeta("xq", "number", unit="pu"),
        ParamMeta("xd1", "number", unit="pu"),
        ParamMeta("xq1", "number", unit="pu"),
        # Subtransient reactances + open-circuit time constants (full
        # standard GENROU parameter set; names verified against ANDES
        # ``System().GENROU.params``). Optional — ANDES carries defaults —
        # but ``add_element`` validates the merged reactance ordering
        # (xd > xd1 > xd2 > xl and xq > xq1 > xq2 > xl) so a textbook
        # transient set doesn't silently conflict with subtransient
        # defaults and destabilise the TDS.
        ParamMeta("xd2", "number", unit="pu"),
        ParamMeta("xq2", "number", unit="pu"),
        ParamMeta("Td10", "number", unit="s"),
        ParamMeta("Td20", "number", unit="s"),
        ParamMeta("Tq10", "number", unit="s"),
        ParamMeta("Tq20", "number", unit="s"),
    ),
    "GENCLS": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        # See GENROU above — ``gen`` is the mandatory static-generator link.
        ParamMeta("gen", "gen_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        # GENCLS's inertia parameter is ``M`` (ANDES GENCLS has no ``H`` — it
        # was silently dropped before). Mark it required so the machine gets a
        # real inertia instead of a default.
        ParamMeta("M", "number", required=True, unit="MWs/MVA"),
        ParamMeta("D", "number", unit="pu"),
        ParamMeta("ra", "number", unit="pu"),
        ParamMeta("xl", "number", unit="pu"),
    ),
    "PQ": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("p0", "number", required=True, unit="pu"),
        ParamMeta("q0", "number", required=True, unit="pu"),
    ),
    # ANDES's ZIP is a dynamic load, not a load on a bus of its own: when a
    # time-domain run starts it takes over the static load ``pq`` names and
    # splits that load's active and its reactive power into shares of constant
    # power, current and impedance, in percent (each three add up to 100). The
    # bus and the powers are the static load's.
    "ZIP": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("pq", "string", required=True),
        ParamMeta("kpp", "number", required=True, unit="%"),
        ParamMeta("kpi", "number", required=True, unit="%"),
        ParamMeta("kpz", "number", required=True, unit="%"),
        ParamMeta("kqp", "number", required=True, unit="%"),
        ParamMeta("kqi", "number", required=True, unit="%"),
        ParamMeta("kqz", "number", required=True, unit="%"),
        ParamMeta("u", "number"),
    ),
    "Shunt": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Vn", "number", required=True, unit="kV"),
        ParamMeta("g", "number", unit="pu"),
        ParamMeta("b", "number", unit="pu"),
    ),
    # ----- Dynamic models (Unit 8) -----
    # These extend the topology-edit surface to the 7 highest-priority dynamic
    # device classes researchers attach to synchronous machines: two type-1
    # exciters (IEEEX1, ESDC2A), the simplified SEXS exciter, two governors
    # (IEEEG1 multi-stage steam, TGOV1 single-lag), the IEEEST PSS, and the
    # REGCA1 grid-following converter for renewables. Each entry mirrors the
    # NumParam declarations on the corresponding ANDES model class (excluding
    # ExtParam, which is sourced from a referenced model and not editable).
    #
    # IdxParam refs to non-Bus models (syn → SynGen, syn2 → SynGen optional,
    # avr → Exciter, gen → StaticGen, busr → Bus optional remote, busf →
    # BusFreq optional) carry kind="string" because the substrate has no
    # picker for these device classes today; the form falls back to a plain
    # text input. The mandatory `bus` ref on REGCA1 reuses kind="bus_idx" so
    # the existing Bus picker drives it.
    "IEEEX1": (
        # idx + name from ModelData; syn from ExcBaseData (excbase.py:23,
        # mandatory=True). NumParams from EXDC2Data (exdc2.py:16-93).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("TR", "number", unit="s"),
        ParamMeta("TA", "number", unit="s"),
        ParamMeta("TC", "number", unit="s"),
        ParamMeta("TB", "number", unit="s"),
        ParamMeta("TE", "number", unit="s"),
        ParamMeta("TF1", "number", unit="s"),
        ParamMeta("KF1", "number", unit="pu"),
        ParamMeta("KA", "number", unit="pu"),
        ParamMeta("KE", "number", unit="pu"),
        ParamMeta("VRMAX", "number", unit="pu"),
        ParamMeta("VRMIN", "number", unit="pu"),
        ParamMeta("E1", "number", unit="pu"),
        ParamMeta("SE1", "number", unit="pu"),
        ParamMeta("E2", "number", unit="pu"),
        ParamMeta("SE2", "number", unit="pu"),
    ),
    "ESDC2A": (
        # idx + name from ModelData; syn from ExcBaseData (excbase.py:23).
        # NumParams from ESDC2AData (esdc2a.py:14-92). `Switch` is a numeric
        # mode flag that PSS/E doesn't implement but ANDES exposes.
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("TR", "number", unit="s"),
        ParamMeta("KA", "number", unit="pu"),
        ParamMeta("TA", "number", unit="s"),
        ParamMeta("TB", "number", unit="s"),
        ParamMeta("TC", "number", unit="s"),
        ParamMeta("VRMAX", "number", unit="pu"),
        ParamMeta("VRMIN", "number", unit="pu"),
        ParamMeta("KE", "number", unit="pu"),
        ParamMeta("TE", "number", unit="s"),
        ParamMeta("KF", "number", unit="pu"),
        ParamMeta("TF1", "number", unit="s"),
        ParamMeta("Switch", "number"),
        ParamMeta("E1", "number", unit="pu"),
        ParamMeta("SE1", "number", unit="pu"),
        ParamMeta("E2", "number", unit="pu"),
        ParamMeta("SE2", "number", unit="pu"),
    ),
    "SEXS": (
        # idx + name from ModelData; syn from ExcBaseData (excbase.py:23).
        # NumParams from SEXSData (sexs.py:13-43).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("TATB", "number"),
        ParamMeta("TB", "number", unit="s"),
        ParamMeta("K", "number", unit="pu"),
        ParamMeta("TE", "number", unit="s"),
        ParamMeta("EMIN", "number", unit="pu"),
        ParamMeta("EMAX", "number", unit="pu"),
    ),
    "IEEEG1": (
        # idx + name from ModelData; syn (mandatory) + Tn + wref0 from
        # TGBaseData (tgbase.py:17-32). syn2 (optional) plus the K, T*, U*,
        # PMAX/PMIN, K1-K8 NumParams from IEEEG1Data (ieeeg1.py:16-104).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("syn2", "string"),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("K", "number", unit="pu"),
        ParamMeta("T1", "number", unit="s"),
        ParamMeta("T2", "number", unit="s"),
        ParamMeta("T3", "number", unit="s"),
        ParamMeta("UO", "number", unit="pu/s"),
        ParamMeta("UC", "number", unit="pu/s"),
        ParamMeta("PMAX", "number", unit="pu"),
        ParamMeta("PMIN", "number", unit="pu"),
        ParamMeta("T4", "number", unit="s"),
        ParamMeta("K1", "number", unit="pu"),
        ParamMeta("K2", "number", unit="pu"),
        ParamMeta("T5", "number", unit="s"),
        ParamMeta("K3", "number", unit="pu"),
        ParamMeta("K4", "number", unit="pu"),
        ParamMeta("T6", "number", unit="s"),
        ParamMeta("K5", "number", unit="pu"),
        ParamMeta("K6", "number", unit="pu"),
        ParamMeta("T7", "number", unit="s"),
        ParamMeta("K7", "number", unit="pu"),
        ParamMeta("K8", "number", unit="pu"),
    ),
    "TGOV1": (
        # idx + name from ModelData; syn + Tn + wref0 from TGBaseData
        # (tgbase.py:17-32). NumParams from TGOV1Data (tgov1.py:10-42).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("R", "number", unit="pu"),
        ParamMeta("VMAX", "number", unit="pu"),
        ParamMeta("VMIN", "number", unit="pu"),
        ParamMeta("T1", "number", unit="s"),
        ParamMeta("T2", "number", unit="s"),
        ParamMeta("T3", "number", unit="s"),
        ParamMeta("Dt", "number", unit="pu"),
    ),
    "IEEEST": (
        # idx + name from ModelData; avr (mandatory) from PSSBaseData
        # (pssbase.py:19-20). MODE (mandatory), busr/busf (optional refs),
        # and A1-A6, T1-T6, KS, LSMAX/LSMIN, VCU/VCL from IEEESTData
        # (ieeest.py:15-41).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("avr", "string", required=True),
        ParamMeta("MODE", "number", required=True),
        ParamMeta("busr", "string"),
        ParamMeta("busf", "string"),
        ParamMeta("A1", "number", unit="s"),
        ParamMeta("A2", "number", unit="s"),
        ParamMeta("A3", "number", unit="s"),
        ParamMeta("A4", "number", unit="s"),
        ParamMeta("A5", "number", unit="s"),
        ParamMeta("A6", "number", unit="s"),
        ParamMeta("T1", "number", unit="s"),
        ParamMeta("T2", "number", unit="s"),
        ParamMeta("T3", "number", unit="s"),
        ParamMeta("T4", "number", unit="s"),
        ParamMeta("T5", "number", unit="s"),
        ParamMeta("T6", "number", unit="s"),
        ParamMeta("KS", "number", unit="pu"),
        ParamMeta("LSMAX", "number", unit="pu"),
        ParamMeta("LSMIN", "number", unit="pu"),
        ParamMeta("VCU", "number", unit="pu"),
        ParamMeta("VCL", "number", unit="pu"),
    ),
    "REGCA1": (
        # idx + name from ModelData; bus (mandatory ACNode → Bus) and gen
        # (mandatory StaticGen) from REGCA1Data (regca1.py:22-31). NumParams
        # Sn, Tg, Rrpwr, Brkpt, Zerox, Lvplsw, Lvpl1, Volim, Lvpnt0/1,
        # Iolim, Tfltr, Khv, Iqrmax/min, Accel, gammap, gammaq from
        # REGCA1Data (regca1.py:32-108).
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("gen", "string", required=True),
        ParamMeta("Sn", "number", unit="MVA"),
        ParamMeta("Tg", "number", unit="s"),
        ParamMeta("Rrpwr", "number", unit="pu"),
        ParamMeta("Brkpt", "number", unit="pu"),
        ParamMeta("Zerox", "number", unit="pu"),
        ParamMeta("Lvplsw", "number"),
        ParamMeta("Lvpl1", "number", unit="pu"),
        ParamMeta("Volim", "number", unit="pu"),
        ParamMeta("Lvpnt1", "number", unit="pu"),
        ParamMeta("Lvpnt0", "number", unit="pu"),
        ParamMeta("Iolim", "number", unit="pu"),
        ParamMeta("Tfltr", "number", unit="s"),
        ParamMeta("Khv", "number", unit="pu"),
        ParamMeta("Iqrmax", "number", unit="pu"),
        ParamMeta("Iqrmin", "number", unit="pu"),
        ParamMeta("Accel", "number"),
        ParamMeta("gammap", "number"),
        ParamMeta("gammaq", "number"),
    ),
    # Unit 15 (v3.1): R15 dynamic-model whitelist expansion. Param names,
    # kinds and units are introspected from the real ANDES 2.0 model classes
    # (see _gen_params provenance). PSS/E names ST6BU / PSS2A have NO ANDES
    # class, so they map to the nearest ANDES-native siblings ESST1A / ST2CUT.
    # Selection mirrors the existing controller entries: idx + name + reference
    # IdxParams + NumParams; the ``u`` flag and ExtParams are excluded.
    "EXST1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("TR", "number"),
        ParamMeta("VIMAX", "number"),
        ParamMeta("VIMIN", "number"),
        ParamMeta("TC", "number"),
        ParamMeta("TB", "number"),
        ParamMeta("KA", "number"),
        ParamMeta("TA", "number"),
        ParamMeta("VRMAX", "number"),
        ParamMeta("VRMIN", "number"),
        ParamMeta("KC", "number"),
        ParamMeta("KF", "number"),
        ParamMeta("TF", "number"),
    ),
    "ESST1A": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("TR", "number"),
        ParamMeta("VIMAX", "number"),
        ParamMeta("VIMIN", "number"),
        ParamMeta("TB", "number"),
        ParamMeta("TC", "number"),
        ParamMeta("TB1", "number"),
        ParamMeta("TC1", "number"),
        ParamMeta("VAMAX", "number", unit="pu"),
        ParamMeta("VAMIN", "number", unit="pu"),
        ParamMeta("KA", "number"),
        ParamMeta("TA", "number"),
        ParamMeta("ILR", "number"),
        ParamMeta("KLR", "number"),
        ParamMeta("VRMAX", "number", unit="pu"),
        ParamMeta("VRMIN", "number", unit="pu"),
        ParamMeta("KF", "number"),
        ParamMeta("TF", "number"),
        ParamMeta("KC", "number"),
        ParamMeta("UELc", "number"),
        ParamMeta("VOSc", "number"),
    ),
    "GAST": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("R", "number", unit="pu"),
        ParamMeta("VMAX", "number", unit="pu"),
        ParamMeta("VMIN", "number", unit="pu"),
        ParamMeta("KT", "number"),
        ParamMeta("AT", "number"),
        ParamMeta("T1", "number"),
        ParamMeta("T2", "number"),
        ParamMeta("T3", "number"),
        ParamMeta("Dt", "number"),
    ),
    "HYGOV": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("R", "number", unit="pu"),
        ParamMeta("r", "number", unit="pu"),
        ParamMeta("GMAX", "number", unit="pu"),
        ParamMeta("GMIN", "number", unit="pu"),
        ParamMeta("VELM", "number", unit="pu"),
        ParamMeta("Tf", "number"),
        ParamMeta("Tr", "number"),
        ParamMeta("Tg", "number"),
        ParamMeta("Dt", "number"),
        ParamMeta("qNL", "number"),
        ParamMeta("Tw", "number"),
        ParamMeta("At", "number"),
    ),
    "IEESGO": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("syn", "syn_idx", required=True),
        ParamMeta("Tn", "number", unit="MVA"),
        ParamMeta("wref0", "number", unit="pu"),
        ParamMeta("T1", "number"),
        ParamMeta("T2", "number"),
        ParamMeta("T3", "number"),
        ParamMeta("T4", "number"),
        ParamMeta("T5", "number"),
        ParamMeta("T6", "number"),
        ParamMeta("K1", "number"),
        ParamMeta("K2", "number"),
        ParamMeta("K3", "number"),
        ParamMeta("PMAX", "number"),
        ParamMeta("PMIN", "number"),
    ),
    "ST2CUT": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("avr", "string", required=True),
        ParamMeta("MODE", "number"),
        ParamMeta("busr", "string", required=True),
        ParamMeta("busf", "string", required=True),
        ParamMeta("MODE2", "number"),
        ParamMeta("busr2", "string", required=True),
        ParamMeta("busf2", "string", required=True),
        ParamMeta("K1", "number"),
        ParamMeta("K2", "number"),
        ParamMeta("T1", "number"),
        ParamMeta("T2", "number"),
        ParamMeta("T3", "number"),
        ParamMeta("T4", "number"),
        ParamMeta("T5", "number"),
        ParamMeta("T6", "number"),
        ParamMeta("T7", "number"),
        ParamMeta("T8", "number"),
        ParamMeta("T9", "number"),
        ParamMeta("T10", "number"),
        ParamMeta("LSMAX", "number"),
        ParamMeta("LSMIN", "number"),
        ParamMeta("VCU", "number", unit="pu"),
        ParamMeta("VCL", "number", unit="pu"),
    ),
    "REGCP1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("gen", "string", required=True),
        ParamMeta("Sn", "number", unit="MVA"),
        ParamMeta("Tg", "number", unit="s"),
        ParamMeta("Rrpwr", "number", unit="pu"),
        ParamMeta("Brkpt", "number", unit="pu"),
        ParamMeta("Zerox", "number", unit="pu"),
        ParamMeta("Lvplsw", "number"),
        ParamMeta("Lvpl1", "number", unit="pu"),
        ParamMeta("Volim", "number", unit="pu"),
        ParamMeta("Lvpnt1", "number", unit="pu"),
        ParamMeta("Lvpnt0", "number", unit="pu"),
        ParamMeta("Iolim", "number", unit="pu (mach base)"),
        ParamMeta("Tfltr", "number", unit="s"),
        ParamMeta("Khv", "number"),
        ParamMeta("Iqrmax", "number", unit="pu"),
        ParamMeta("Iqrmin", "number", unit="pu"),
        ParamMeta("Accel", "number"),
        ParamMeta("gammap", "number"),
        ParamMeta("gammaq", "number"),
        ParamMeta("pll", "string", required=True),
    ),
    "REECA1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("reg", "string", required=True),
        ParamMeta("busr", "string", required=True),
        ParamMeta("PFFLAG", "number"),
        ParamMeta("VFLAG", "number"),
        ParamMeta("QFLAG", "number"),
        ParamMeta("PFLAG", "number"),
        ParamMeta("PQFLAG", "number"),
        ParamMeta("Vdip", "number", unit="pu"),
        ParamMeta("Vup", "number", unit="pu"),
        ParamMeta("Trv", "number"),
        ParamMeta("dbd1", "number"),
        ParamMeta("dbd2", "number"),
        ParamMeta("Kqv", "number"),
        ParamMeta("Iqh1", "number"),
        ParamMeta("Iql1", "number"),
        ParamMeta("Vref0", "number"),
        ParamMeta("Iqfrz", "number"),
        ParamMeta("Thld", "number", unit="s"),
        ParamMeta("Thld2", "number", unit="s"),
        ParamMeta("Tp", "number", unit="s"),
        ParamMeta("QMax", "number"),
        ParamMeta("QMin", "number"),
        ParamMeta("VMAX", "number"),
        ParamMeta("VMIN", "number"),
        ParamMeta("Kqp", "number"),
        ParamMeta("Kqi", "number"),
        ParamMeta("Kvp", "number"),
        ParamMeta("Kvi", "number"),
        ParamMeta("Vref1", "number"),
        ParamMeta("Tiq", "number"),
        ParamMeta("dPmax", "number"),
        ParamMeta("dPmin", "number"),
        ParamMeta("PMAX", "number"),
        ParamMeta("PMIN", "number"),
        ParamMeta("Imax", "number"),
        ParamMeta("Tpord", "number"),
        ParamMeta("Vq1", "number"),
        ParamMeta("Iq1", "number"),
        ParamMeta("Vq2", "number"),
        ParamMeta("Iq2", "number"),
        ParamMeta("Vq3", "number"),
        ParamMeta("Iq3", "number"),
        ParamMeta("Vq4", "number"),
        ParamMeta("Iq4", "number"),
        ParamMeta("Vp1", "number"),
        ParamMeta("Ip1", "number"),
        ParamMeta("Vp2", "number"),
        ParamMeta("Ip2", "number"),
        ParamMeta("Vp3", "number"),
        ParamMeta("Ip3", "number"),
        ParamMeta("Vp4", "number"),
        ParamMeta("Ip4", "number"),
    ),
    "REPCA1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("ree", "string", required=True),
        ParamMeta("line", "string", required=True),
        ParamMeta("busr", "string", required=True),
        ParamMeta("busf", "string", required=True),
        ParamMeta("VCFlag", "number"),
        ParamMeta("RefFlag", "number"),
        ParamMeta("Fflag", "number"),
        ParamMeta("PLflag", "number"),
        ParamMeta("Tfltr", "number"),
        ParamMeta("Kp", "number"),
        ParamMeta("Ki", "number"),
        ParamMeta("Tft", "number"),
        ParamMeta("Tfv", "number"),
        ParamMeta("Vfrz", "number"),
        ParamMeta("Rc", "number"),
        ParamMeta("Xc", "number"),
        ParamMeta("Kc", "number"),
        ParamMeta("emax", "number"),
        ParamMeta("emin", "number"),
        ParamMeta("dbd1", "number"),
        ParamMeta("dbd2", "number"),
        ParamMeta("Qmax", "number"),
        ParamMeta("Qmin", "number"),
        ParamMeta("Kpg", "number"),
        ParamMeta("Kig", "number"),
        ParamMeta("Tp", "number"),
        ParamMeta("fdbd1", "number", unit="pu (Hz)"),
        ParamMeta("fdbd2", "number", unit="pu (Hz)"),
        ParamMeta("femax", "number"),
        ParamMeta("femin", "number"),
        ParamMeta("Pmax", "number", unit="pu (MW)"),
        ParamMeta("Pmin", "number", unit="pu (MW)"),
        ParamMeta("Tg", "number"),
        ParamMeta("Ddn", "number"),
        ParamMeta("Dup", "number"),
    ),
    # ESD1, the distributed energy storage model: PVD1's converter params
    # (pvd1.py, PVD1Data) followed by the state-of-charge ones (esd1.py,
    # ESD1Data), in ANDES's order and with its units. ``gen`` is the static
    # generator the battery takes over, picked like a machine's. Required here
    # are the two links, ``pqflag`` (ANDES has no default for it) and what
    # sizes the battery: ANDES's defaults for ``pmx`` (9999, no limit) and
    # ``En`` (100 MWh) describe no real device. ``Sn`` is required in the form
    # and filled with the system base by ``add_element`` when a request leaves
    # it out; ``tensa.core.esd1`` says why that is the value to keep.
    "ESD1": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("gen", "gen_idx", required=True),
        ParamMeta("Sn", "number", required=True, unit="MVA"),
        ParamMeta("fn", "number", unit="Hz"),
        ParamMeta("busf", "string"),
        ParamMeta("xc", "number", unit="pu"),
        ParamMeta("pqflag", "number", required=True),
        ParamMeta("igreg", "string"),
        ParamMeta("qmx", "number", unit="pu"),
        ParamMeta("qmn", "number", unit="pu"),
        ParamMeta("pmx", "number", required=True, unit="pu"),
        ParamMeta("v0", "number", unit="pu"),
        ParamMeta("v1", "number", unit="pu"),
        ParamMeta("dqdv", "number"),
        ParamMeta("fdbd", "number", unit="Hz"),
        ParamMeta("ddn", "number", unit="pu/Hz"),
        ParamMeta("ialim", "number", unit="pu"),
        ParamMeta("vt0", "number", unit="pu"),
        ParamMeta("vt1", "number", unit="pu"),
        ParamMeta("vt2", "number", unit="pu"),
        ParamMeta("vt3", "number", unit="pu"),
        ParamMeta("vrflag", "number"),
        ParamMeta("ft0", "number", unit="Hz"),
        ParamMeta("ft1", "number", unit="Hz"),
        ParamMeta("ft2", "number", unit="Hz"),
        ParamMeta("ft3", "number", unit="Hz"),
        ParamMeta("frflag", "number"),
        ParamMeta("tip", "number", unit="s"),
        ParamMeta("tiq", "number", unit="s"),
        ParamMeta("gammap", "number"),
        ParamMeta("gammaq", "number"),
        ParamMeta("recflag", "number"),
        ParamMeta("Tf", "number"),
        ParamMeta("SOCmin", "number"),
        ParamMeta("SOCmax", "number"),
        ParamMeta("SOCinit", "number"),
        ParamMeta("En", "number", required=True, unit="MWh"),
        ParamMeta("EtaC", "number"),
        ParamMeta("EtaD", "number"),
    ),
    # Unit 14: PMU (PhasorMeasurement). Tracks bus voltage magnitude
    # (vm) + angle (am) via low-pass filters during TDS. Mirrors
    # ``andes/models/measurement/pmu.py:13-19``: ``bus`` (mandatory
    # ACNode → Bus), ``Ta`` (angle filter time constant, default 0.1),
    # ``Tv`` (voltage filter time constant, default 0.1). The defaults
    # the substrate ships through ``add_pmu`` are 0.05 / 0.05 (Unit 14
    # spike) — researchers can edit per-instance via ``edit_element``
    # because PMU is a known model class on the substrate.
    "PMU": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("bus", "bus_idx", required=True),
        ParamMeta("Ta", "number", unit="s"),
        ParamMeta("Tv", "number", unit="s"),
    ),
    # Unit 15: TimeSeries profile. Imports an xlsx hourly profile and
    # applies its values to a target device's parameters at exact step
    # times. Mirrors ``andes/models/timeseries.py:38-72``: ``mode``
    # (1=exact, 2=interpolated; 2 raises NotImplementedError at line 230,
    # the substrate accepts only mode=1), ``path`` (xlsx file path,
    # mandatory and must exist before setup), ``sheet``, ``fields``
    # (comma-separated source columns), ``tkey`` (timestamp column),
    # ``model`` (target ANDES model class), ``dev`` (target device idx),
    # ``dests`` (comma-separated target device fields). Listed here so
    # ``delete_element('TimeSeries', idx)`` shares the cascade /
    # reload-and-replay machinery with the rest of the topology.
    "TimeSeries": (
        ParamMeta("idx", "string", required=True),
        ParamMeta("name", "string", required=True),
        ParamMeta("mode", "number", required=True),
        ParamMeta("path", "string", required=True),
        ParamMeta("sheet", "string", required=True),
        ParamMeta("fields", "string", required=True),
        ParamMeta("tkey", "string"),
        ParamMeta("model", "string", required=True),
        ParamMeta("dev", "string", required=True),
        ParamMeta("dests", "string", required=True),
    ),
}


def allowed_param_names(model: str) -> tuple[str, ...]:
    """Return the param names allowed for a given ANDES model class.

    Used by the wrapper-side whitelist check before any ANDES call. Returns
    an empty tuple for unknown models — callers should treat that as
    'unknown model' and reject the request.
    """
    return tuple(p.name for p in _PARAMS_BY_MODEL.get(model, ()))


def param_metadata_for_form(model: str) -> tuple[ParamMeta, ...]:
    """Return the form-renderable param metadata for an ANDES model.

    Includes idx + name (the form's identifier inputs). Used by the
    ``GET /api/topology/schema`` endpoint that drives the web client's
    polymorphic form generator (Unit 6).
    """
    return _PARAMS_BY_MODEL.get(model, ())
