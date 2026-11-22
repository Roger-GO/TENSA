"""The neutral case document of section 5 of ``design/multiengine/spec.md``.

The pydantic models of the document, ``validate_case_document`` for one a
client sends back, and ``upgrade_case_document``. One builder per engine lives
in ``engines/andes/case_doc.py`` and ``engines/sienna/case_doc.py``. This
module imports no engine.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from tensa.engines.op_series import CaseSeries, CostCurveRecord, GeneratorOp, SeriesProfile

TENSA_CASE_VERSION: Final = 1

# The note every served document carries while the dynamics records hold no
# parameter values (the positional tables are a later unit).
DYNAMICS_NOTE: Final = "dynamic model parameters are not in this version of the document"


class CaseDocumentError(ValueError):
    """A case document a client sent back that cannot be accepted."""


class CaseSource(BaseModel):
    """Where the case came from: its format, its files and their digests."""

    model_config = ConfigDict(extra="forbid")

    format: str = Field(
        description="The format of the case file: psse-raw, matpower, xlsx or the like."
    )
    files: list[str] = Field(
        description="The names of the files the case was read from, the case file first."
    )
    sha256: list[str] | None = Field(
        default=None,
        description="The SHA-256 of each file, in the order of files; null when one could not be read.",
    )


class ZipFractions(BaseModel):
    """The constant impedance, current and power fractions of a load at 1.0 pu."""

    model_config = ConfigDict(extra="forbid")

    p: list[float] = Field(
        min_length=3,
        max_length=3,
        description="The active power's constant impedance, current and power fractions, summing to 1.",
    )
    q: list[float] = Field(
        min_length=3,
        max_length=3,
        description="The reactive power's constant impedance, current and power fractions, summing to 1.",
    )


class BusRecord(BaseModel):
    """One bus of the case."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="The bus's TENSA key, as GET /sessions/{id}/keys lists it.")
    number: int = Field(description="The bus number of the case.")
    name: str | None = Field(default=None, description="The bus's name in the case.")
    vn_kv: float | None = Field(default=None, description="The base voltage, in kV.")
    type: Literal["pq", "pv", "ref", "isolated"] = Field(
        description="The bus type: pq, pv, ref (the angle reference) or isolated."
    )
    v_pu: float | None = Field(
        default=None, description="The voltage magnitude the case stores, per unit of vn_kv."
    )
    angle_deg: float | None = Field(
        default=None, description="The voltage angle the case stores, in degrees."
    )
    area: int | None = Field(default=None, description="The area number, when the case has one.")
    zone: int | None = Field(default=None, description="The zone number, when the case has one.")
    area_slack: bool | None = Field(
        default=None,
        description="True for a bus the case names as its area's interchange slack; null when not known.",
    )
    in_service: bool = Field(default=True, description="Whether the bus is in service.")


class LineRecord(BaseModel):
    """One non-transformer branch; impedances per unit on ``base_mva``."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    key: str = Field(description="The branch's TENSA key.")
    from_bus: int = Field(alias="from", description="The number of the bus the branch leaves.")
    to_bus: int = Field(alias="to", description="The number of the bus the branch reaches.")
    ckt: str = Field(description="The circuit id that tells parallel branches apart.")
    r_pu: float | None = Field(
        default=None, description="The series resistance, per unit on base_mva and the bus voltage."
    )
    x_pu: float | None = Field(
        default=None, description="The series reactance, per unit on base_mva and the bus voltage."
    )
    b_pu: float | None = Field(
        default=None,
        description="The total line charging susceptance, per unit on base_mva and the bus voltage.",
    )
    rate_a_mva: float | None = Field(
        default=None, description="The long-term flow limit, in MVA; 0 where the case gives none."
    )
    in_service: bool = Field(default=True, description="Whether the branch is in service.")


class TransformerRecord(BaseModel):
    """One two-winding transformer. ``r_pu`` and ``x_pu`` are per unit on the
    bases the record states: ``rate_mva`` and the rated voltages
    ``vn_from_kv`` and ``vn_to_kv`` (the transformer's own rating where the
    engine holds it so, the system base and the bus voltages where it holds
    them on those). ``rate_a_mva`` is a flow limit, not a base."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    key: str = Field(description="The transformer's TENSA key.")
    from_bus: int = Field(alias="from", description="The number of the bus of the first winding.")
    to_bus: int = Field(alias="to", description="The number of the bus of the second winding.")
    ckt: str = Field(description="The circuit id that tells parallel branches apart.")
    r_pu: float | None = Field(
        default=None, description="The series resistance, per unit on rate_mva and vn_from_kv."
    )
    x_pu: float | None = Field(
        default=None, description="The series reactance, per unit on rate_mva and vn_from_kv."
    )
    rate_mva: float | None = Field(
        default=None, description="The MVA base the impedances are given on."
    )
    vn_from_kv: float | None = Field(
        default=None, description="The rated voltage of the first winding, in kV."
    )
    vn_to_kv: float | None = Field(
        default=None, description="The rated voltage of the second winding, in kV."
    )
    tap: float | None = Field(default=None, description="The off-nominal turns ratio, per unit.")
    shift_deg: float | None = Field(default=None, description="The phase shift, in degrees.")
    rate_a_mva: float | None = Field(
        default=None, description="The long-term flow limit, in MVA; 0 where the case gives none."
    )
    in_service: bool = Field(default=True, description="Whether the transformer is in service.")


class GeneratorRecord(BaseModel):
    """One static generator."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="The generating unit's TENSA key.")
    bus: int = Field(description="The number of the bus the generator is on.")
    id: str = Field(description="The generator's id on its bus.")
    p_mw: float | None = Field(default=None, description="The scheduled active power, in MW.")
    q_mvar: float | None = Field(
        default=None, description="The reactive power the case stores, in MVAr."
    )
    v_set_pu: float | None = Field(
        default=None, description="The voltage setpoint, per unit of the bus's base voltage."
    )
    q_min_mvar: float | None = Field(default=None, description="The lower reactive limit, in MVAr.")
    q_max_mvar: float | None = Field(default=None, description="The upper reactive limit, in MVAr.")
    mbase_mva: float | None = Field(
        default=None, description="The machine's MVA rating, the base of its dynamic parameters."
    )
    op: GeneratorOp | None = Field(
        default=None,
        description=(
            "The operations data (limits, ramps, cost, initial state); null "
            "for a case that has none, which is every PSS/E .raw case."
        ),
    )
    in_service: bool = Field(default=True, description="Whether the generator is in service.")


class LoadRecord(BaseModel):
    """One load."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="The load's TENSA key.")
    bus: int = Field(description="The number of the bus the load is on.")
    id: str = Field(description="The load's id on its bus.")
    p_mw: float | None = Field(default=None, description="The active power at 1.0 pu voltage, in MW.")
    q_mvar: float | None = Field(
        default=None, description="The reactive power at 1.0 pu voltage, in MVAr."
    )
    zip: ZipFractions | None = Field(
        default=None,
        description="How the power varies with the voltage; null when the engine does not hold it.",
    )
    in_service: bool = Field(default=True, description="Whether the load is in service.")


class ShuntRecord(BaseModel):
    """One shunt."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="The shunt's TENSA key.")
    bus: int = Field(description="The number of the bus the shunt is on.")
    id: str = Field(description="The shunt's id on its bus.")
    g_mw: float | None = Field(
        default=None, description="The active power it draws at 1.0 pu voltage, in MW."
    )
    b_mvar: float | None = Field(
        default=None,
        description="The reactive power it supplies at 1.0 pu voltage, in MVAr (positive for a capacitor).",
    )
    in_service: bool = Field(default=True, description="Whether the shunt is in service.")


class DynamicRecord(BaseModel):
    """One dynamic model of a generating unit.

    ``values`` and ``names`` are null in this version of the document (the
    positional parameter tables are a later unit); the document's ``notes``
    say so.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="The model's TENSA key, the unit's key and its role.")
    unit: str = Field(description="The key of the generator the model belongs to.")
    role: str = Field(description="What the model does in the unit: machine, exciter, governor, ...")
    model: str = Field(description="The model's name, as its dynamic data file names it.")
    values: list[float] | None = Field(
        default=None,
        description="The parameters in the order of the model's PSS/E record; null in this version.",
    )
    names: list[str] | None = Field(
        default=None, description="The names of values, for people; never read back."
    )
    vocabulary: Literal["psse", "andes", "sienna"] = Field(
        default="psse",
        description="Whose parameter names the record uses: psse (values by position) or an engine's (params).",
    )
    params: dict[str, float] | None = Field(
        default=None,
        description="The parameters by the engine's own names, for a model with no PSS/E record.",
    )


class CaseDocument(BaseModel):
    """The neutral case document, version 1."""

    model_config = ConfigDict(extra="forbid")

    tensa_case: Literal[1] = Field(default=1, description="The version of the document's form.")
    name: str = Field(description="The case's name, its file's name without the extension.")
    base_mva: float | None = Field(default=None, description="The system MVA base.")
    freq_hz: float | None = Field(default=None, description="The system frequency, in Hz.")
    source: CaseSource | None = Field(
        default=None, description="Where the case came from; null for a case built in the session."
    )
    buses: list[BusRecord] = Field(default_factory=list, description="The buses, in the case's order.")
    lines: list[LineRecord] = Field(default_factory=list, description="The branches that are not transformers.")
    transformers: list[TransformerRecord] = Field(
        default_factory=list, description="The two-winding transformers."
    )
    generators: list[GeneratorRecord] = Field(default_factory=list, description="The static generators.")
    loads: list[LoadRecord] = Field(default_factory=list, description="The loads.")
    shunts: list[ShuntRecord] = Field(default_factory=list, description="The fixed shunts.")
    dynamics: list[DynamicRecord] = Field(
        default_factory=list, description="The dynamic models of the generating units."
    )
    series: CaseSeries | None = Field(
        default=None,
        description="The time series the case carries; null when it carries none.",
    )
    events: list[dict[str, Any]] = Field(
        default_factory=list, description="What the case file says happens in time, as neutral events."
    )
    notes: list[str] = Field(
        default_factory=list, description="What the document leaves out or holds only in part, and why."
    )
    ext: dict[str, Any] = Field(
        default_factory=dict, description="What only one engine holds, under that engine's name."
    )


def _element_lists(document: CaseDocument) -> list[tuple[str, list[Any]]]:
    """The seven element lists of a document, each with its name."""
    return [
        ("buses", document.buses),
        ("lines", document.lines),
        ("transformers", document.transformers),
        ("generators", document.generators),
        ("loads", document.loads),
        ("shunts", document.shunts),
        ("dynamics", document.dynamics),
    ]


def validate_case_document(data: Mapping[str, Any]) -> CaseDocument:
    """Parse and check a document a client sent back.

    Raises :class:`CaseDocumentError` naming the first problem: a
    ``tensa_case`` newer than this reader, a duplicate key, a bus or unit
    reference no record has, a ``zip`` whose fractions do not each sum to 1.0
    within 1e-6, or a dynamic record whose ``values`` or ``params`` do not
    match its ``vocabulary``. Null ``values`` and ``names`` are accepted (the
    served document carries them until the positional tables land).
    """
    version = data.get("tensa_case")
    if isinstance(version, int) and version > TENSA_CASE_VERSION:
        raise CaseDocumentError(
            f"tensa_case {version} is newer than this reader's version "
            f"{TENSA_CASE_VERSION}"
        )
    try:
        document = CaseDocument.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first["loc"])
        raise CaseDocumentError(f"{location}: {first['msg']}") from exc

    seen: set[str] = set()
    for list_name, records in _element_lists(document):
        for record in records:
            if record.key in seen:
                raise CaseDocumentError(f"duplicate key {record.key!r} in {list_name}")
            seen.add(record.key)

    bus_numbers = {bus.number for bus in document.buses}
    generator_keys = {generator.key for generator in document.generators}
    for line in document.lines:
        for end, number in (("from", line.from_bus), ("to", line.to_bus)):
            if number not in bus_numbers:
                raise CaseDocumentError(
                    f"line {line.key!r} references {end} bus {number}, "
                    "which no bus of the document has"
                )
    for transformer in document.transformers:
        for end, number in (("from", transformer.from_bus), ("to", transformer.to_bus)):
            if number not in bus_numbers:
                raise CaseDocumentError(
                    f"transformer {transformer.key!r} references {end} bus "
                    f"{number}, which no bus of the document has"
                )
    for kind, records in (
        ("generator", document.generators),
        ("load", document.loads),
        ("shunt", document.shunts),
    ):
        for record in records:
            if record.bus not in bus_numbers:
                raise CaseDocumentError(
                    f"{kind} {record.key!r} references bus {record.bus}, "
                    "which no bus of the document has"
                )
    for record in document.dynamics:
        if record.unit not in generator_keys:
            raise CaseDocumentError(
                f"dynamic record {record.key!r} references unit {record.unit!r}, "
                "which no generator of the document has"
            )
        if record.vocabulary == "psse":
            if record.values is not None and record.names is not None and (
                len(record.values) != len(record.names)
            ):
                raise CaseDocumentError(
                    f"dynamic record {record.key!r} has {len(record.values)} values "
                    f"and {len(record.names)} names"
                )
        elif record.params is None:
            raise CaseDocumentError(
                f"dynamic record {record.key!r} has vocabulary "
                f"{record.vocabulary!r} and no params"
            )

    for load in document.loads:
        if load.zip is None:
            continue
        for part, fractions in (("p", load.zip.p), ("q", load.zip.q)):
            if abs(sum(fractions) - 1.0) > 1e-6:
                raise CaseDocumentError(
                    f"load {load.key!r} zip {part} fractions sum to "
                    f"{sum(fractions)}, not 1.0"
                )

    # Validate op blocks
    for record in document.generators:
        if record.op is None:
            continue
        op = record.op
        if op.p_min_mw is not None and op.p_max_mw is not None and op.p_min_mw > op.p_max_mw:
            raise CaseDocumentError(
                f"generator {record.key!r} has p_min_mw {op.p_min_mw} above p_max_mw {op.p_max_mw}"
            )
        if op.cost is not None:
            cost = op.cost
            if cost.kind == "polynomial":
                if cost.coefficients is None or len(cost.coefficients) == 0:
                    raise CaseDocumentError(
                        f"generator {record.key!r} has a polynomial cost without coefficients"
                    )
                if cost.points is not None:
                    raise CaseDocumentError(
                        f"generator {record.key!r} has a polynomial cost without coefficients"
                    )
            elif cost.kind == "piecewise":
                if cost.points is None or len(cost.points) < 2:
                    raise CaseDocumentError(
                        f"generator {record.key!r} has a piecewise cost with malformed points"
                    )
                if cost.coefficients is not None:
                    raise CaseDocumentError(
                        f"generator {record.key!r} has a piecewise cost with malformed points"
                    )
                # Check that points are strictly increasing in MW
                for i in range(1, len(cost.points)):
                    if len(cost.points[i]) != 2 or len(cost.points[i-1]) != 2:
                        raise CaseDocumentError(
                            f"generator {record.key!r} has a piecewise cost with malformed points"
                        )
                    if cost.points[i][0] <= cost.points[i-1][0]:
                        raise CaseDocumentError(
                            f"generator {record.key!r} has a piecewise cost with malformed points"
                        )

    # Validate series block
    if document.series is not None:
        series = document.series
        star_count = sum(1 for p in series.load if p.applies_to == "*")
        if star_count > 1:
            raise CaseDocumentError("series has more than one load profile for \"*\"")

        load_keys = {load.key for load in document.loads}
        seen_keys: set[str] = set()
        for profile in series.load:
            if profile.applies_to != "*":
                if profile.applies_to not in load_keys:
                    raise CaseDocumentError(
                        f"series profile references {profile.applies_to!r}, which no load of the document has"
                    )
                if profile.applies_to in seen_keys:
                    raise CaseDocumentError(
                        f"series has two load profiles for {profile.applies_to!r}"
                    )
                seen_keys.add(profile.applies_to)
            for factor in profile.factors:
                if factor < 0:
                    raise CaseDocumentError(
                        f"series profile for {profile.applies_to!r} has a negative factor"
                    )

    return document


def upgrade_case_document(data: Mapping[str, Any]) -> dict[str, Any]:
    """Upgrade an older document to the current version.

    Version 1 is current; anything else is returned unchanged for
    :func:`validate_case_document` to refuse or accept.
    """
    return dict(data)


__all__ = [
    "BusRecord",
    "CaseDocument",
    "CaseDocumentError",
    "CaseSeries",
    "CaseSource",
    "CostCurveRecord",
    "DYNAMICS_NOTE",
    "DynamicRecord",
    "GeneratorOp",
    "GeneratorRecord",
    "LineRecord",
    "LoadRecord",
    "SeriesProfile",
    "ShuntRecord",
    "TENSA_CASE_VERSION",
    "TransformerRecord",
    "ZipFractions",
    "upgrade_case_document",
    "validate_case_document",
]
