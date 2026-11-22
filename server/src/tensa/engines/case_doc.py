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

TENSA_CASE_VERSION: Final = 1

# The note every served document carries while the dynamics records hold no
# parameter values (the positional tables are a later unit).
DYNAMICS_NOTE: Final = "dynamic model parameters are not in this version of the document"


class CaseDocumentError(ValueError):
    """A case document a client sent back that cannot be accepted."""


class CaseSource(BaseModel):
    """Where the case came from: its format, its files and their digests."""

    model_config = ConfigDict(extra="forbid")

    format: str
    files: list[str]
    sha256: list[str] | None = None


class ZipFractions(BaseModel):
    """The constant impedance, current and power fractions of a load at 1.0 pu."""

    model_config = ConfigDict(extra="forbid")

    p: list[float] = Field(min_length=3, max_length=3)
    q: list[float] = Field(min_length=3, max_length=3)


class BusRecord(BaseModel):
    """One bus of the case."""

    model_config = ConfigDict(extra="forbid")

    key: str
    number: int
    name: str | None = None
    vn_kv: float | None = None
    type: Literal["pq", "pv", "ref", "isolated"]
    v_pu: float | None = None
    angle_deg: float | None = None
    area: int | None = None
    zone: int | None = None
    area_slack: bool | None = None
    in_service: bool = True


class LineRecord(BaseModel):
    """One non-transformer branch; impedances per unit on ``base_mva``."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    key: str
    from_bus: int = Field(alias="from")
    to_bus: int = Field(alias="to")
    ckt: str
    r_pu: float | None = None
    x_pu: float | None = None
    b_pu: float | None = None
    rate_a_mva: float | None = None
    in_service: bool = True


class TransformerRecord(BaseModel):
    """One two-winding transformer. ``r_pu`` and ``x_pu`` are per unit on the
    bases the record states: ``rate_mva`` and the rated voltages
    ``vn_from_kv`` and ``vn_to_kv`` (the transformer's own rating where the
    engine holds it so, the system base and the bus voltages where it holds
    them on those). ``rate_a_mva`` is a flow limit, not a base."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    key: str
    from_bus: int = Field(alias="from")
    to_bus: int = Field(alias="to")
    ckt: str
    r_pu: float | None = None
    x_pu: float | None = None
    rate_mva: float | None = None
    vn_from_kv: float | None = None
    vn_to_kv: float | None = None
    tap: float | None = None
    shift_deg: float | None = None
    rate_a_mva: float | None = None
    in_service: bool = True


class GeneratorRecord(BaseModel):
    """One static generator."""

    model_config = ConfigDict(extra="forbid")

    key: str
    bus: int
    id: str
    p_mw: float | None = None
    q_mvar: float | None = None
    v_set_pu: float | None = None
    q_min_mvar: float | None = None
    q_max_mvar: float | None = None
    mbase_mva: float | None = None
    in_service: bool = True


class LoadRecord(BaseModel):
    """One load."""

    model_config = ConfigDict(extra="forbid")

    key: str
    bus: int
    id: str
    p_mw: float | None = None
    q_mvar: float | None = None
    zip: ZipFractions | None = None
    in_service: bool = True


class ShuntRecord(BaseModel):
    """One shunt."""

    model_config = ConfigDict(extra="forbid")

    key: str
    bus: int
    id: str
    g_mw: float | None = None
    b_mvar: float | None = None
    in_service: bool = True


class DynamicRecord(BaseModel):
    """One dynamic model of a generating unit.

    ``values`` and ``names`` are null in this version of the document (the
    positional parameter tables are a later unit); the document's ``notes``
    say so.
    """

    model_config = ConfigDict(extra="forbid")

    key: str
    unit: str
    role: str
    model: str
    values: list[float] | None = None
    names: list[str] | None = None
    vocabulary: Literal["psse", "andes", "sienna"] = "psse"
    params: dict[str, float] | None = None


class CaseDocument(BaseModel):
    """The neutral case document, version 1."""

    model_config = ConfigDict(extra="forbid")

    tensa_case: Literal[1] = 1
    name: str
    base_mva: float | None = None
    freq_hz: float | None = None
    source: CaseSource | None = None
    buses: list[BusRecord] = Field(default_factory=list)
    lines: list[LineRecord] = Field(default_factory=list)
    transformers: list[TransformerRecord] = Field(default_factory=list)
    generators: list[GeneratorRecord] = Field(default_factory=list)
    loads: list[LoadRecord] = Field(default_factory=list)
    shunts: list[ShuntRecord] = Field(default_factory=list)
    dynamics: list[DynamicRecord] = Field(default_factory=list)
    events: list[dict[str, Any]] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)
    ext: dict[str, Any] = Field(default_factory=dict)


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
    "CaseSource",
    "DYNAMICS_NOTE",
    "DynamicRecord",
    "GeneratorRecord",
    "LineRecord",
    "LoadRecord",
    "ShuntRecord",
    "TENSA_CASE_VERSION",
    "TransformerRecord",
    "ZipFractions",
    "upgrade_case_document",
    "validate_case_document",
]
