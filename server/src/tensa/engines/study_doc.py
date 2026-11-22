"""The study document (section 6 of ``design/multiengine/spec.md``): what to do to a case. Pydantic models and validation. Pure Python; imports no engine."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from tensa.engines.keys import is_key
from tensa.engines.ops import ENGINE_NAMES, ENGINE_OPS
from tensa.engines.series_names import QUANTITY_BY_NAME

__all__ = [
    "ROUTINE_OPS",
    "SUPPORTED_ROUTINES",
    "Disturbance",
    "RecordSpec",
    "StudyDocError",
    "StudyDocument",
    "engines_refusing",
    "upgrade_study_document",
]

# First scope of the study route: the routines the ops and routes already
# serve end to end through neutral documents. ``dcpflow``, ``cpf``, ``se``,
# ``uc`` and ``sim`` of section 6.1 are not accepted.
SUPPORTED_ROUTINES: tuple[str, ...] = ("pflow", "tds", "eig", "matrices", "dispatch")

# The worker op the engine's session must have for each routine, per
# ``ENGINE_OPS`` in ``ops.py``: andes has run_pflow, run_tds and run_eig and
# refuses matrices (its op is bus_admittance_matrix) and dispatch; sienna has
# all five.
ROUTINE_OPS: dict[str, str] = {
    "pflow": "run_pflow",
    "tds": "run_tds",
    "eig": "run_eig",
    "matrices": "network_matrix",
    "dispatch": "run_dispatch",
}

# The key kinds a record wildcard (``<kind>:*``) can name.
_WILDCARD_KINDS: tuple[str, ...] = ("bus", "branch", "gen", "load", "shunt")


class StudyDocError(ValueError):
    """A study document cannot be read or run."""


class Disturbance(BaseModel):
    """One disturbance of a study (section 6.4)."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["branch_trip", "branch_close", "bus_fault", "gen_trip", "load_step", "setpoint", "set"] = Field(
        ..., description="What happens."
    )
    target: str | None = Field(default=None, description="The key it acts on; ``bus_fault`` uses ``bus``.")
    bus: str | None = Field(default=None, description="The bus key of a ``bus_fault``.")
    t: float | None = Field(default=None, ge=0.0, description="When it happens, in seconds.")
    t_on: float | None = Field(default=None, ge=0.0, description="When a fault is applied, in seconds.")
    t_clear: float | None = Field(default=None, ge=0.0, description="When a fault is cleared, in seconds.")
    r_pu: float | None = Field(default=None, ge=0.0, description="Fault resistance, per unit.")
    x_pu: float | None = Field(default=None, ge=0.0, description="Fault reactance, per unit.")
    p_mw: float | None = Field(default=None, description="Active power of a load step, in MW.")
    q_mvar: float | None = Field(default=None, description="Reactive power of a load step, in MVAr.")
    signal: Literal["p_ref", "v_ref", "q_ref", "omega_ref"] | None = Field(
        default=None, description="The reference a setpoint changes."
    )
    param: str | None = Field(default=None, max_length=100, description="The parameter a ``set`` changes.")
    value: float | None = Field(default=None, description="The value a setpoint or a ``set`` takes.")

    @model_validator(mode="after")
    def _check_fields(self) -> Disturbance:
        if self.kind == "bus_fault":
            if self.bus is None or not is_key(self.bus):
                raise StudyDocError("a bus_fault needs a bus key")
            if self.target is not None:
                raise StudyDocError("disturbance bus_fault takes no field 'target'")
            for name in ("t_on", "t_clear", "r_pu", "x_pu"):
                if getattr(self, name) is None:
                    raise StudyDocError(f"a bus_fault needs {name}")
            assert self.t_on is not None and self.t_clear is not None
            if self.t_clear <= self.t_on:
                raise StudyDocError(
                    "a bus_fault clears after it starts: t_clear must be greater than t_on"
                )
            for name in ("t", "p_mw", "q_mvar", "signal", "param", "value"):
                if getattr(self, name) is not None:
                    raise StudyDocError(f"disturbance bus_fault takes no field '{name}'")
            return self
        if self.target is None or not is_key(self.target):
            raise StudyDocError(f"disturbance {self.kind} needs a target key")
        if self.bus is not None:
            raise StudyDocError(f"disturbance {self.kind} takes no field 'bus'")
        required: tuple[str, ...]
        allowed: tuple[str, ...]
        if self.kind in ("branch_trip", "branch_close", "gen_trip"):
            required = ("t",)
            allowed = ("t",)
        elif self.kind == "load_step":
            required = ("t", "p_mw", "q_mvar")
            allowed = required
        elif self.kind == "setpoint":
            required = ("t", "signal", "value")
            allowed = required
        else:  # set
            required = ("t", "param", "value")
            allowed = required
        for name in required:
            if getattr(self, name) is None:
                raise StudyDocError(f"disturbance {self.kind} needs {name}")
        for name in ("t_on", "t_clear", "r_pu", "x_pu", "p_mw", "q_mvar", "signal", "param", "value"):
            if name not in allowed and getattr(self, name) is not None:
                raise StudyDocError(f"disturbance {self.kind} takes no field '{name}'")
        return self


class RecordSpec(BaseModel):
    """One quantity to record (section 6.5's catalogue, with ``*`` wildcards)."""

    model_config = ConfigDict(extra="forbid")

    quantity: str = Field(..., description="The quantity, a series quantity of the catalogue.")
    of: str = Field(..., description="What it is of: a key, or ``<kind>:*`` for every element of a kind.")

    @model_validator(mode="after")
    def _check_fields(self) -> RecordSpec:
        spec = QUANTITY_BY_NAME.get(self.quantity)
        if spec is None or self.quantity in ("eigenvalue", "state"):
            raise StudyDocError(
                f"record quantity {self.quantity!r} is not a series quantity of the catalogue"
            )
        if is_key(self.of):
            return self
        prefix, separator, star = self.of.partition(":")
        if separator and star == "*" and prefix in _WILDCARD_KINDS:
            return self
        raise StudyDocError("record 'of' must be a key or <kind>:*")


class StudyDocument(BaseModel):
    """The study document, field by field the section 6 JSON."""

    model_config = ConfigDict(extra="forbid")

    tensa_study: int = Field(..., description="Document version. A reader refuses a newer major.")
    routine: Literal["pflow", "tds", "eig", "matrices", "dispatch"] = Field(
        ..., description="The routine the study runs."
    )
    options: dict[str, Any] = Field(
        default_factory=dict, description="The neutral options of section 6.2."
    )
    load_model: Literal["impedance", "power", "as-case"] | None = Field(
        default=None, description="How loads behave in ``tds`` and ``eig``."
    )
    disturbances: list[Disturbance] = Field(
        default_factory=list, description="What happens in a ``tds`` study."
    )
    record: list[RecordSpec] = Field(
        default_factory=list, description="What a ``tds`` study records."
    )
    ext: dict[str, dict[str, Any]] = Field(
        default_factory=dict, description="Engine-specific blocks, one per engine name."
    )

    @field_validator("tensa_study")
    @classmethod
    def _version_supported(cls, v: int) -> int:
        if v < 1:
            raise StudyDocError("tensa_study version must be at least 1")
        if v > 1:
            raise StudyDocError(
                f"tensa_study version {v} is newer than this server reads (1)"
            )
        return v

    @model_validator(mode="after")
    def _check_study(self) -> StudyDocument:
        if self.load_model is not None and self.routine not in ("tds", "eig"):
            raise StudyDocError(
                f"load_model belongs to tds and eig, not {self.routine}"
            )
        if self.disturbances and self.routine != "tds":
            raise StudyDocError(
                f"disturbances belong to a tds study, not {self.routine}"
            )
        if self.record and self.routine != "tds":
            raise StudyDocError(f"record belongs to a tds study, not {self.routine}")
        for name in self.ext:
            if name not in ENGINE_NAMES:
                raise StudyDocError(f"ext.{name} is not an engine this server knows")
        return self


def upgrade_study_document(data: dict[str, Any]) -> dict[str, Any]:
    """The document at the version this server reads. Version 1 is returned as
    it is; there is no older version to upgrade from yet."""
    return data


def engines_refusing(study: StudyDocument) -> list[str]:
    """The engine names whose op table lacks the study's routine, in
    ``ENGINE_NAMES`` order."""
    op = ROUTINE_OPS[study.routine]
    return [name for name in ENGINE_NAMES if op not in ENGINE_OPS[name]]
