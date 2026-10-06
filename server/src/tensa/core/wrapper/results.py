"""The records the Wrapper's routines return."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from tensa.core.case_events import CaseEvent
from tensa.core.edit_log import EditStep
from tensa.core.pflow_options import PflowSettings

# JSON-friendly scalar union surfaced through topology / line-flow APIs.
# Mirrored on the API layer (``schemas.TopologyEntry.params``); see api/schemas/topology.py.
ParamValue = float | int | str | bool


@dataclass
class TopologyEntry:
    """One element in a topology summary, keyed by ANDES idx + name."""

    idx: int | str
    name: str
    kind: str  # ANDES model class name (e.g., "Bus", "Line", "GENROU")
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class TopologySnapshot:
    """Substrate's structural view of the loaded case.

    ``state`` is "pre-setup" until ``ss.setup()`` has run; afterwards it's
    "committed". Some computed fields on each element are only populated
    after setup — the schema in the API surface (Unit 4) declares which
    fields are pre-setup-stable vs post-setup-required.

    Lines vs transformers split (Unit 2): ANDES models 2-winding transformers
    within the ``Line`` model class with a non-default ``tap`` or ``phi``.
    The substrate splits them into two buckets at the boundary so the SLD
    can render the transformer-2w icon at the line midpoint.
    """

    state: Literal["pre-setup", "committed"]
    buses: list[TopologyEntry]
    lines: list[TopologyEntry]
    transformers: list[TopologyEntry]
    generators: list[TopologyEntry]
    loads: list[TopologyEntry]
    shunts: list[TopologyEntry] = field(default_factory=list)
    # Unit 8.1: dynamic controllers (exciters, governors, PSS, renewable
    # converters) surfaced by the Unit-8 whitelist additions. Empty when the
    # case carries no entries for any of the seven Unit-8 model classes —
    # e.g., a stock IEEE 14 .raw without the .dyr addfile.
    controllers: list[TopologyEntry] = field(default_factory=list)
    # System nominal frequency in Hz (``ss.config.freq``): the base a
    # per-unit rotor speed converts to Hz with. A RAW header or the ``_config``
    # of an xlsx / json file sets it; any other case has ANDES's default of 60.
    # ``None`` when the System carries no usable value, so a client never
    # converts with a guess.
    freq_hz: float | None = None
    # System MVA base (``ss.config.mva``): what a per-unit power on the system
    # base times this is in MW. The case sets it (a RAW header, a MATPOWER
    # ``baseMVA``, the ``_config`` of an xlsx / json file); any other case has
    # ANDES's default of 100. ``None`` when the System carries no usable value.
    base_mva: float | None = None
    # Idx of the buses whose rated voltage (``Vn``) the case does not give:
    # ANDES holds its 110 kV fill-in there, which a client must not read as
    # the bus's voltage base. See ``tensa.core.rated_voltage``.
    buses_without_vn: list[int | str] = field(default_factory=list)
    # Timed events the next time-domain run applies besides the ones a client
    # commits itself: those the case file defines (a ``Toggle`` that trips a
    # line, say) and those a bundle import or snapshot restore replayed. See
    # ``tensa.core.case_events``.
    events: list[CaseEvent] = field(default_factory=list)
    # The edit ``undo_last_edit`` would take back and the one ``redo_edit`` would
    # put back, or ``None`` when there is none. See ``tensa.core.edit_log``.
    undo: EditStep | None = None
    redo: EditStep | None = None


@dataclass
class DeletedDisturbance:
    """A disturbance that acts on something a delete removes, or would remove.

    ``source`` says where it came from: the case file (``case``), a bundle
    import or snapshot restore (``restored``), or a client's own commit
    (``committed``). ``t`` is when it starts, or ``None`` for one that never
    fires.
    """

    source: Literal["case", "restored", "committed"]
    kind: Literal["fault", "toggle", "alter"]
    model: str | None
    dev_idx: int | str | None
    t: float | None = None
    name: str | None = None


@dataclass
class DeleteResult:
    """What ``Wrapper.delete_element`` did.

    ``deleted`` is every element that went, the one asked for last, and
    ``disturbances`` every disturbance that went with them.
    """

    topology: TopologySnapshot
    deleted: list[TopologyEntry] = field(default_factory=list)
    disturbances: list[DeletedDisturbance] = field(default_factory=list)


@dataclass
class LineFlow:
    """Per-line P/Q flow at both terminals, in MW / MVAr.

    ``p`` / ``q`` are the power injected into the line at ``bus1`` and
    ``p_to`` / ``q_to`` the power injected at ``bus2``, each computed from the
    standard pi-equivalent line equations ANDES itself solves (the line's
    ``a1`` / ``v1`` and ``a2`` / ``v2`` terms). ``loss`` is their sum, the
    active power the line dissipates. ``rate_a`` is the line's long-term rating
    in MVA and ``loading_pct`` the larger of the two terminal apparent powers
    as a percentage of it; both are ``None`` for a line the case gives no
    rating (a ``rate_a`` of zero).
    """

    p: float
    q: float
    from_idx: int | str
    to_idx: int | str
    p_to: float
    q_to: float
    loss: float
    rate_a: float | None
    loading_pct: float | None


@dataclass
class GeneratorOutput:
    """Per-generator PF output: active + reactive power injection at the
    generator's terminal bus, plus the terminal voltage (pu).

    These come straight from the ``p`` / ``q`` / ``v`` variables of ANDES's
    static generators (PV, Slack). A dynamic machine (GENROU/GENCLS) has
    no row of its own: it carries no ``p`` / ``q`` until TDS initialises,
    and its operating point is the one of the static generator it names in
    its ``gen`` parameter.

    ``q_min`` / ``q_max`` are the reactive limits the case sets, in MVAr; the
    power flow does not enforce them, so ``q`` can lie outside. ``None`` for a
    generator that is switched off, which has no limit to be held to.
    """

    p: float  # MW (scaled by ss.config.mva)
    q: float  # MVAr
    v: float  # terminal voltage (pu)
    bus: int | str
    q_min: float | None = None  # MVAr
    q_max: float | None = None  # MVAr


@dataclass
class LoadConsumption:
    """Per-load PF consumption: P + Q draw at the load's terminal bus."""

    p: float  # MW
    q: float  # MVAr
    bus: int | str


@dataclass
class PflowSummary:
    """System totals of a converged power flow, in MW / MVAr.

    Generation, load, bus shunts and lines balance: ``generation = load + shunt
    + loss``, in P and in Q, to the solver's tolerance. ``load`` and ``shunt``
    are what they absorb (so a capacitor's ``shunt_q`` is negative), and
    ``loss_q`` is what the lines absorb net of their charging. Devices switched
    off count for nothing. ``slack_p`` / ``slack_q`` are the output of the
    in-service slack generators, ``None`` when there is none.
    """

    generation_p: float
    generation_q: float
    load_p: float
    load_q: float
    shunt_p: float
    shunt_q: float
    loss_p: float
    loss_q: float
    slack_p: float | None
    slack_q: float | None


@dataclass
class PflowResult:
    """Power-flow run result. Keyed by ANDES idx."""

    converged: bool
    iterations: int
    mismatch: float
    bus_voltages: dict[int | str, float]
    bus_angles: dict[int | str, float]
    line_flows: dict[str, LineFlow] = field(default_factory=dict)
    generator_outputs: dict[str, GeneratorOutput] = field(default_factory=dict)
    load_consumption: dict[str, LoadConsumption] = field(default_factory=dict)
    # Set by ``run_pflow`` only: the settings the run used, and (when it
    # converged) the system totals. ``operating_point`` leaves both ``None``.
    settings: PflowSettings | None = None
    summary: PflowSummary | None = None


@dataclass
class TdsBatchResult:
    """Time-domain simulation batch result (post-completion delivery).

    Streaming TDS uses a different code path (Unit 6) where the worker emits
    Arrow IPC frames per integration step into the data Pipe.
    """

    converged: bool
    final_t: float
    callpert_count: int  # how many times the per-step hook fired
