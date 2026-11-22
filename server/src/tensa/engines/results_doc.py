"""The neutral results document (section 6.5 of ``design/multiengine/spec.md``):
what came back, in which units and frame. Pydantic models, builders from what
the engines already return, and a session-less validation of a document a
client sends back. Pure Python; imports no engine.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from tensa.core.eig_result import EigResult
from tensa.core.wrapper.results import PflowResult
from tensa.engines.keys import KeyBook, is_key
from tensa.engines.series_names import (
    QUANTITY_BY_NAME,
    neutral_name_andes,
    parse_name,
    parse_state_name,
)

if TYPE_CHECKING:
    # Only a type here: importing the API schemas package from this engines module
    # would make it import itself through the schemas that re-export the document.
    from tensa.api.schemas.tds import TdsTraces

__all__ = [
    "EngineBlock",
    "EigenvalueRow",
    "EigenvalueTable",
    "OptimizationDualTable",
    "OptimizationExpressionTable",
    "OptimizationParameterTable",
    "OptimizationRow",
    "OptimizationSlackRow",
    "OptimizationTable",
    "OptimizationVariableTable",
    "PflowBranchRow",
    "PflowBusRow",
    "PflowGeneratorRow",
    "PflowLoadRow",
    "PflowTable",
    "ResultsDocError",
    "ResultsDocument",
    "ResultsTables",
    "Series",
    "SkippedSeries",
    "eig_document",
    "pflow_document",
    "tds_document",
    "validate_results_document",
]

# The reason a ``dae_vars`` column (an engine's raw states) is left out of the
# document. Named once so the route's answer and the tests share the spelling.
DAE_VARS_SKIPPED_REASON = "raw engine state; not part of the neutral document yet"


class ResultsDocError(ValueError):
    """A results document or an engine result cannot become or be a document."""


class EngineBlock(BaseModel):
    """The engine that produced the result and the versions it ran with."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="The engine's registry name: ``andes`` or ``sienna``.")
    versions: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "The package versions the engine ran with, caller-supplied. Empty "
            "until the adapter reports them; the builders never invent one."
        ),
    )


class Series(BaseModel):
    """One series of the document: a quantity of one element over time."""

    model_config = ConfigDict(extra="forbid")

    quantity: str = Field(..., description="The quantity, a name of the section 6.5 catalogue.")
    of: str = Field(
        ...,
        description=(
            "What the quantity is of: a key (``bus:7``, ``gen:1-1``), or for a "
            "``state`` series ``<key>#<state name>``."
        ),
    )
    unit: str = Field(..., description="The unit the values are in, the catalogue's for the quantity.")
    t: list[float] = Field(..., description="Sample times in seconds, not decreasing.")
    y: list[float | None] = Field(
        ...,
        description="The value at each time. ``null`` is a gap (a diverged step).",
    )


class PflowBusRow(BaseModel):
    """One bus of a power flow table."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(..., description="The bus's key (``bus:7``).")
    v_pu: float = Field(..., description="Voltage magnitude, per unit.")
    angle_rad: float = Field(..., description="Voltage angle, in radians.")


class PflowBranchRow(BaseModel):
    """One branch of a power flow table, flows at both ends."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(..., description="The branch's key (``branch:7-8-1``).")
    p_from_mw: float = Field(..., description="Active power into the branch at its from end, in MW.")
    q_from_mvar: float | None = Field(
        default=None, description="Reactive power into the branch at its from end, in MVAr."
    )
    p_to_mw: float | None = Field(
        default=None, description="Active power into the branch at its to end, in MW."
    )
    q_to_mvar: float | None = Field(
        default=None, description="Reactive power into the branch at its to end, in MVAr."
    )


class PflowGeneratorRow(BaseModel):
    """One generator of a power flow table."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(..., description="The generator's key (``gen:1-1``).")
    p_mw: float = Field(..., description="Active power injected, in MW.")
    q_mvar: float | None = Field(default=None, description="Reactive power injected, in MVAr.")


class PflowLoadRow(BaseModel):
    """One load of a power flow table."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(..., description="The load's key (``load:7-1``).")
    p_mw: float = Field(..., description="Active power absorbed, in MW.")
    q_mvar: float | None = Field(default=None, description="Reactive power absorbed, in MVAr.")


class PflowTable(BaseModel):
    """The power flow table of a results document. Rows are keyed by key."""

    model_config = ConfigDict(extra="forbid")

    converged: bool = Field(..., description="Whether the power flow converged.")
    buses: list[PflowBusRow] = Field(default_factory=list, description="One row per keyed bus.")
    branches: list[PflowBranchRow] = Field(
        default_factory=list, description="One row per keyed branch."
    )
    generators: list[PflowGeneratorRow] = Field(
        default_factory=list, description="One row per keyed static generator."
    )
    loads: list[PflowLoadRow] = Field(default_factory=list, description="One row per keyed load.")


class EigenvalueRow(BaseModel):
    """One mode of an eigenvalue table."""

    model_config = ConfigDict(extra="forbid")

    re: float = Field(..., description="Real part of the eigenvalue, in 1/s.")
    im: float = Field(..., description="Imaginary part of the eigenvalue, in 1/s.")
    frequency_hz: float = Field(..., description="Oscillation frequency, in hertz.")
    damping_ratio: float = Field(..., description="Damping ratio; 1.0 for a zero eigenvalue.")


class EigenvalueTable(BaseModel):
    """The eigenvalue table of a results document, one row per mode."""

    model_config = ConfigDict(extra="forbid")

    eigenvalues: list[EigenvalueRow] = Field(
        default_factory=list,
        description="One row per mode, index-aligned with the source result.",
    )


class OptimizationRow(BaseModel):
    """One row of an optimization table: an element's value at one time step."""

    model_config = ConfigDict(extra="forbid")

    element: str = Field(
        description=(
            "What the row is for: a key (gen:1-1, load:7-1) where the row is "
            "an element of the case, or the PowerSimulations name where it is "
            "not (a system-wide slack or balance)."
        )
    )
    t: list[float] = Field(description="The time steps of the horizon, in hours from its start.")
    y: list[float | None] = Field(description="The value at each step; null is a gap.")


class OptimizationVariableTable(BaseModel):
    """One decision variable of the model, one row per element."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(
        description="The variable's name as PowerSimulations names it (ActivePowerVariable__ThermalStandard)."
    )
    unit: str = Field(description="The unit the values are in: MW, MVA, $/h or 1 (a commitment state).")
    rows: list[OptimizationRow] = Field(default_factory=list, description="One row per element.")


class OptimizationDualTable(BaseModel):
    """One dual variable of the model."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="The dual's name as PowerSimulations names it.")
    unit: str = Field(description="The unit the values are in, $/MWh for a balance dual.")
    rows: list[OptimizationRow] = Field(default_factory=list, description="One row per element.")


class OptimizationParameterTable(BaseModel):
    """One parameter of the model (a time series the model read)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="The parameter's name as PowerSimulations names it.")
    unit: str = Field(description="The unit the values are in.")
    rows: list[OptimizationRow] = Field(default_factory=list, description="One row per element.")


class OptimizationExpressionTable(BaseModel):
    """One expression of the model (a derived quantity, such as production cost)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(description="The expression's name as PowerSimulations names it.")
    unit: str = Field(description="The unit the values are in.")
    rows: list[OptimizationRow] = Field(default_factory=list, description="One row per element.")


class OptimizationSlackRow(BaseModel):
    """One slack variable whose value is past 1e-6 at some step (spec section
    13: slack variables always read back and reported when non-zero)."""

    model_config = ConfigDict(extra="forbid")

    variable: str = Field(description="The slack variable's name as PowerSimulations names it.")
    element: str = Field(description="The element the slack is on, as PowerSimulations names it.")
    t: list[float] = Field(description="The time steps where the slack is non-zero, in hours.")
    y: list[float] = Field(description="The slack's value at each of those steps, in MW.")


class OptimizationTable(BaseModel):
    """The optimization table of a results document: what the model held and
    what it decided. The template is recorded verbatim (spec section 13)."""

    model_config = ConfigDict(extra="forbid")

    routine: Literal["dispatch", "uc", "sim"] = Field(description="The operations routine that ran.")
    template: dict[str, Any] = Field(
        description=(
            "The template as run: its name (economic_dispatch, "
            "unit_commitment) or the explicit device formulations, the "
            "network model, horizon and resolution, stored verbatim."
        )
    )
    status: str = Field(
        description="The solver's termination status as PowerSimulations reports it."
    )
    objective_usd: float | None = Field(
        default=None, description="The objective value, in $ for the whole horizon."
    )
    variables: list[OptimizationVariableTable] = Field(
        default_factory=list, description="The decision variables read back."
    )
    duals: list[OptimizationDualTable] = Field(
        default_factory=list, description="The duals read back; empty when none were asked for."
    )
    parameters: list[OptimizationParameterTable] = Field(
        default_factory=list, description="The parameters (time series) the model read."
    )
    expressions: list[OptimizationExpressionTable] = Field(
        default_factory=list, description="The expressions read back."
    )
    slacks: list[OptimizationSlackRow] = Field(
        default_factory=list,
        description="Every slack variable past 1e-6 at some step; empty when all are zero.",
    )


class ResultsTables(BaseModel):
    """The tables of a results document: a power flow under ``pflow``, the
    eigenvalues under ``eig``; either, both or neither. Each name holds its own
    table only, and no other name is taken."""

    model_config = ConfigDict(extra="forbid")

    pflow: PflowTable | None = Field(default=None, description="The power flow table.")
    eig: EigenvalueTable | None = Field(default=None, description="The eigenvalue table.")
    optimization: OptimizationTable | None = Field(
        default=None, description="The operations table of a dispatch, uc or sim run."
    )


class ResultsDocument(BaseModel):
    """The neutral results document, field by field the section 6.5 JSON."""

    model_config = ConfigDict(extra="forbid")

    tensa_results: Literal[1] = Field(..., description="Document version. A reader refuses a newer major.")
    engine: EngineBlock = Field(..., description="The engine that produced the result.")
    study: dict[str, Any] | None = Field(
        default=None, description="The study as run, stored verbatim; ``null`` when there is none."
    )
    status: Literal["completed", "aborted", "failed"] = Field(
        ..., description="How the run ended."
    )
    series: list[Series] = Field(default_factory=list, description="The time series.")
    tables: ResultsTables = Field(
        default_factory=ResultsTables,
        description="The tables, under ``pflow`` and ``eig``; either, both or neither.",
    )


class SkippedSeries(BaseModel):
    """One column of an engine result that is not in the document, and why."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="The column's name as the engine gave it.")
    reason: str = Field(..., description="Why it is not part of the document.")


def pflow_document(
    result: PflowResult,
    *,
    engine: EngineBlock,
    study: dict[str, Any] | None,
) -> ResultsDocument:
    """The results document of a converged power flow.

    Rows are keyed through ``result.keys``; an idx with no key is left out.

    Raises:
        ResultsDocError: the run did not converge (a non-converged run carries
            no tables), or a bus has a voltage and no angle.
    """
    if not result.converged:
        raise ResultsDocError(
            "power flow did not converge; a non-converged run has no results document"
        )
    bus_keys = result.keys.get("bus", {})
    line_keys = result.keys.get("line", {})
    generator_keys = result.keys.get("generator", {})
    load_keys = result.keys.get("load", {})

    buses: list[PflowBusRow] = []
    for idx, v_pu in result.bus_voltages.items():
        key = bus_keys.get(str(idx))
        if key is None:
            continue
        if idx not in result.bus_angles:
            raise ResultsDocError(f"bus {idx} has a voltage and no angle")
        buses.append(PflowBusRow(key=key, v_pu=v_pu, angle_rad=result.bus_angles[idx]))

    branches: list[PflowBranchRow] = []
    for idx_str, flow in result.line_flows.items():
        key = line_keys.get(idx_str)
        if key is None:
            continue
        branches.append(
            PflowBranchRow(
                key=key,
                p_from_mw=flow.p,
                q_from_mvar=flow.q,
                p_to_mw=flow.p_to,
                q_to_mvar=flow.q_to,
            )
        )

    generators: list[PflowGeneratorRow] = []
    for idx_str, output in result.generator_outputs.items():
        key = generator_keys.get(idx_str)
        if key is None:
            continue
        generators.append(PflowGeneratorRow(key=key, p_mw=output.p, q_mvar=output.q))

    loads: list[PflowLoadRow] = []
    for idx_str, load in result.load_consumption.items():
        key = load_keys.get(idx_str)
        if key is None:
            continue
        loads.append(PflowLoadRow(key=key, p_mw=load.p, q_mvar=load.q))

    table = PflowTable(
        converged=True, buses=buses, branches=branches, generators=generators, loads=loads
    )
    return ResultsDocument(
        tensa_results=1,
        engine=engine,
        study=study,
        status="completed",
        series=[],
        tables=ResultsTables(pflow=table),
    )


def _is_dae_vars_name(name: str) -> bool:
    """Whether ``name`` is a ``dae_vars`` name (``omega GENROU 1``): a variable,
    a model and an idx, separated by spaces, as ``dae.x_name`` / ``dae.y_name``
    spell them. No neutral column name holds a space, so this cannot take one
    for one."""
    parts = name.split(" ")
    return len(parts) == 3 and all(parts)


def tds_document(
    traces: TdsTraces,
    *,
    engine: EngineBlock,
    study: dict[str, Any] | None,
    status: Literal["completed", "aborted", "failed"] = "completed",
    key_book: KeyBook | None = None,
) -> tuple[ResultsDocument, list[SkippedSeries], list[str]]:
    """The results document of a batch time-domain run's traces.

    Returns ``(document, skipped, notes)``: ``skipped`` names every column
    that is not part of the document and why (a column with no neutral
    mapping, a ``dae_vars`` raw state, a column whose element has no key), and
    ``notes`` reports a truncated result. A truncated run is ``completed``
    with its rows as they are.

    For ``engine.name == "sienna"`` the column names are already neutral
    (``<quantity>|<key>``). Otherwise they are ANDES column names, mapped with
    ``tensa.engines.series_names.neutral_name_andes``, which needs
    ``key_book``.

    Raises:
        ResultsDocError: a Sienna name is not ``<quantity>|<key>``, or an
            ANDES result came without a key book.
    """
    series: list[Series] = []
    skipped: list[SkippedSeries] = []
    notes: list[str] = []
    if traces.truncated:
        notes.append("the result was truncated; the series hold the rows that were kept")
    for variable in traces.variables:
        name = variable.name
        if engine.name == "sienna":
            quantity, separator, of = name.partition("|")
            if not separator:
                raise ResultsDocError(f"series name {name!r} is not neutral (<quantity>|<key>)")
            spec = QUANTITY_BY_NAME.get(quantity)
            if spec is None:
                skipped.append(SkippedSeries(name=name, reason="no neutral mapping for the name"))
                continue
            unit = spec.unit
        elif "|" in name:
            # A column that is already a neutral name (it parses with
            # ``series_names.parse_name``) is taken as it is for an ANDES
            # result too: a run made with ``names: "neutral"`` converts to
            # the same document as an engine-named one.
            try:
                quantity, of = parse_name(name)
            except ValueError:
                quantity, of = "", ""
            if not quantity:
                skipped.append(
                    SkippedSeries(name=name, reason="no neutral mapping for the ANDES column")
                )
                continue
            if quantity == "state":
                key, state = parse_state_name(name)
                of = f"{key}#{state}"
            spec = QUANTITY_BY_NAME[quantity]
            unit = spec.unit
        else:
            if key_book is None:
                raise ResultsDocError("a key book is required to map ANDES column names")
            if _is_dae_vars_name(name):
                skipped.append(SkippedSeries(name=name, reason=DAE_VARS_SKIPPED_REASON))
                continue
            neutral = neutral_name_andes(name, key_book)
            if neutral is None:
                skipped.append(
                    SkippedSeries(name=name, reason="no neutral mapping for the ANDES column")
                )
                continue
            quantity, _, of = neutral.partition("|")
            spec = QUANTITY_BY_NAME[quantity]
            unit = spec.unit
        series.append(Series(quantity=quantity, of=of, unit=unit, t=traces.t, y=variable.values))
    document = ResultsDocument(
        tensa_results=1,
        engine=engine,
        study=study,
        status=status,
        series=series,
        tables=ResultsTables(),
    )
    return document, skipped, notes


def eig_document(
    result: EigResult,
    *,
    engine: EngineBlock,
    study: dict[str, Any] | None,
) -> ResultsDocument:
    """The results document of an eigenvalue analysis.

    Raises:
        ResultsDocError: the result's lists disagree in length.
    """
    if (
        len(result.eigenvalues) != result.mode_count
        or len(result.damping_ratios) != len(result.eigenvalues)
        or len(result.frequencies_hz) != len(result.eigenvalues)
    ):
        raise ResultsDocError(
            f"eig result lengths disagree: {len(result.eigenvalues)} eigenvalues, "
            f"{len(result.damping_ratios)} damping ratios, "
            f"{len(result.frequencies_hz)} frequencies, mode_count {result.mode_count}"
        )
    rows = [
        EigenvalueRow(
            re=z.real,
            im=z.imag,
            frequency_hz=result.frequencies_hz[i],
            damping_ratio=result.damping_ratios[i],
        )
        for i, z in enumerate(result.eigenvalues)
    ]
    return ResultsDocument(
        tensa_results=1,
        engine=engine,
        study=study,
        status="completed",
        series=[],
        tables=ResultsTables(eig=EigenvalueTable(eigenvalues=rows)),
    )


def _key_prefix(of: str) -> str:
    """The kind part of a key: the text before the first colon."""
    return of.split(":", 1)[0]


def _prefix_accepted(quantity: str, prefix: str) -> bool:
    """Whether a key of kind ``prefix`` can carry ``quantity``."""
    spec = QUANTITY_BY_NAME[quantity]
    of = spec.of
    if of == "generating unit, load":
        return prefix in ("gen", "load")
    if of == "generating unit":
        return prefix == "gen"
    return prefix == of


def validate_results_document(doc: ResultsDocument) -> list[str]:
    """The problems of a document a client sent back, empty when it is sound.

    Never raises on document content. Checks each series' quantity against the
    catalogue of ``tensa.engines.series_names``, its ``of`` for key shape and
    the catalogue's kind, its unit against the catalogue's, and its ``t`` for
    length and for running backwards; and the tables for unknown kinds and for
    row keys that are not keys.
    """
    problems: list[str] = []
    for i, s in enumerate(doc.series):
        if s.quantity == "eigenvalue":
            problems.append(f"series {i}: eigenvalue is a table quantity, not a series")
            continue
        if s.quantity == "state":
            try:
                parse_state_name(f"state|{s.of}")
            except ValueError:
                problems.append(f"series {i}: {s.of!r} is not <key>#<state name>")
        elif s.quantity not in QUANTITY_BY_NAME:
            problems.append(f"series {i}: unknown quantity {s.quantity!r}")
        elif not is_key(s.of):
            problems.append(f"series {i}: {s.of!r} is not a key")
        elif not _prefix_accepted(s.quantity, _key_prefix(s.of)):
            problems.append(
                f"series {i}: quantity {s.quantity!r} is not of {_key_prefix(s.of)!r}"
            )
        if s.quantity in QUANTITY_BY_NAME and s.quantity not in ("eigenvalue", "state"):
            expected = QUANTITY_BY_NAME[s.quantity].unit
            if s.unit != expected:
                problems.append(
                    f"series {i}: quantity {s.quantity!r} is in {expected!r}, not {s.unit!r}"
                )
        if len(s.t) != len(s.y):
            problems.append(f"series {i}: t has {len(s.t)} values, y has {len(s.y)}")
        for j in range(1, len(s.t)):
            if s.t[j] < s.t[j - 1]:
                problems.append(f"series {i}: t is not non-decreasing at index {j}")
                break
    table = doc.tables.pflow
    if table is not None:
        rows: list[PflowBusRow | PflowBranchRow | PflowGeneratorRow | PflowLoadRow] = [
            *table.buses,
            *table.branches,
            *table.generators,
            *table.loads,
        ]
        for row in rows:
            if not is_key(row.key):
                problems.append(f"tables.pflow: {row.key!r} is not a key")
        # Each list holds keys of its own kind only: a load key among the buses is
        # a document put together wrongly, which a comparison would then miss.
        kinds: tuple[tuple[str, Sequence[PflowBusRow | PflowBranchRow | PflowGeneratorRow | PflowLoadRow]], ...] = (
            ("bus", table.buses),
            ("branch", table.branches),
            ("gen", table.generators),
            ("load", table.loads),
        )
        for kind, kind_rows in kinds:
            for row in kind_rows:
                if is_key(row.key) and _key_prefix(row.key) != kind:
                    problems.append(f"tables.pflow: {row.key!r} is not a {kind} key")

    # Validate optimization table
    opt_table = doc.tables.optimization
    if opt_table is not None:
        # Check variables, duals, parameters, expressions
        for table_name, opt_tables in (
            ("variables", opt_table.variables),
            ("duals", opt_table.duals),
            ("parameters", opt_table.parameters),
            ("expressions", opt_table.expressions),
        ):
            for opt_tbl in opt_tables:
                for opt_row in opt_tbl.rows:
                    if len(opt_row.t) != len(opt_row.y):
                        problems.append(
                            f"tables.optimization.{table_name} {opt_row.element!r}: "
                            f"t has {len(opt_row.t)} values, y has {len(opt_row.y)}"
                        )
                    for j in range(1, len(opt_row.t)):
                        if opt_row.t[j] < opt_row.t[j - 1]:
                            problems.append(
                                f"tables.optimization.{table_name} {opt_row.element!r}: "
                                "t is not non-decreasing"
                            )
                            break
                    # Check key kind if element is a key and table name has a suffix
                    if is_key(opt_row.element):
                        if opt_tbl.name.endswith("__ThermalStandard"):
                            if _key_prefix(opt_row.element) != "gen":
                                problems.append(
                                    f"tables.optimization.{table_name}: "
                                    f"{opt_row.element!r} is not a gen key"
                                )
                        elif opt_tbl.name.endswith(("__PowerLoad", "__StandardLoad")):
                            if _key_prefix(opt_row.element) != "load":
                                problems.append(
                                    f"tables.optimization.{table_name}: "
                                    f"{opt_row.element!r} is not a load key"
                                )
                        elif opt_tbl.name.endswith("__Line") and _key_prefix(opt_row.element) != "branch":
                            problems.append(
                                f"tables.optimization.{table_name}: "
                                f"{opt_row.element!r} is not a branch key"
                            )

        # Check slacks
        for slack_row in opt_table.slacks:
            if len(slack_row.t) != len(slack_row.y):
                problems.append(
                    f"tables.optimization.slacks {slack_row.element!r}: "
                    f"t has {len(slack_row.t)} values, y has {len(slack_row.y)}"
                )
            for value in slack_row.y:
                if abs(value) <= 1e-6:
                    problems.append(
                        f"tables.optimization.slacks {slack_row.element!r}: "
                        "a listed slack value is not past 1e-6"
                    )
                    break

    return problems
