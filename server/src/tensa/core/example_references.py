"""The reference values an example case's results are checked against.

``server/src/tensa/examples/references/<id>.json`` holds, for the case of that id in the
catalog (``tensa.core.example_catalog``), what ``scripts/verify_example_cases.py`` compares a
run of TENSA with: each value with where it comes from, how close the run has to be and what
kind of reference it is, and how the case's runs are set up (the events of the file that the
undisturbed runs leave out, the disturbance the case is shown with, the small disturbance
whose ring-down is looked at).

A value is a ``ReferenceCheck``. ``quantity`` names what the harness measures from the run
(``QUANTITIES``), ``kind`` says what ``expected`` is (the kinds of the catalog's
``VerificationCheck``: ``independent-solver``, ``published``, ``stored-solution``,
``ring-down``, ``regression-baseline``, which is TENSA's own earlier output and so no
verification, and ``cross-engine``, which holds the case run under another engine of the
same server to the ANDES run, compared through ``POST /compare``), and ``reference`` names
the source so that it can be found.

The models are validated when a file is read, so a reference that does not hold together
(a map where a number belongs, a mode with no frequency window) fails the tests, not a
verification run half way through. This module imports nothing heavy (no ANDES).
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from tensa.core.disturbance import DisturbanceSpec
from tensa.core.example_catalog import CheckKind, examples_dir

REFERENCE_VERSION = 1

Quantity = Literal[
    "pf.bus_voltage_pu",
    "pf.bus_angle_deg",
    "pf.loss_mw",
    "pf.slack_p_mw",
    "tds.max_angle_spread_deg",
    "tds.final_angle_spread_deg",
    "tds.min_voltage_pu",
    "tds.frequency_nadir_hz",
    "eig.mode_frequency_hz",
    "eig.mode_damping_ratio",
]

# Quantities that hold one number per bus (``expected`` is a map from the bus's idx).
MAP_QUANTITIES: frozenset[str] = frozenset({"pf.bus_voltage_pu", "pf.bus_angle_deg"})
# Quantities of the eigenvalue analysis: the least damped oscillatory eigenvalue in a window.
EIG_QUANTITIES: frozenset[str] = frozenset({"eig.mode_frequency_hz", "eig.mode_damping_ratio"})

_Id = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]*$", max_length=40)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Tolerance(_Model):
    """How far a measured value may be from the expected one: ``abs + rel * |expected|``."""

    abs: float | None = Field(
        None, ge=0, description="Absolute tolerance, in the unit of the quantity."
    )
    rel: float | None = Field(None, ge=0, description="Tolerance relative to the expected value.")

    @model_validator(mode="after")
    def _has_a_bound(self) -> Self:
        if self.abs is None and self.rel is None:
            raise ValueError("a tolerance needs abs, rel or both")
        return self

    def bound(self, expected: float) -> float:
        """The largest difference from ``expected`` that is still inside the tolerance."""
        return (self.abs or 0.0) + (self.rel or 0.0) * abs(expected)

    def allows(self, expected: float, measured: float) -> bool:
        return abs(measured - expected) <= self.bound(expected)

    def text(self) -> str:
        parts = []
        if self.abs is not None:
            parts.append(f"{self.abs:g}")
        if self.rel is not None:
            parts.append(f"{self.rel:g} of the value")
        return " + ".join(parts)


class PFlowSettings(_Model):
    """How the power flow a check reads is run, as ``POST /sessions/{id}/pflow`` takes it."""

    enforce_q_limits: bool = Field(
        ...,
        description=(
            "Hold a generator at its reactive limit when its reactive power would go past one. "
            "It is off by default, in TENSA and in the independent solver of the other checks; "
            "a stored or published solution made with the limits on is compared with a power "
            "flow run with them on."
        ),
    )


class ReferenceCheck(_Model):
    name: str = Field(..., description="What is checked, as the report names it.", max_length=200)
    quantity: Quantity = Field(..., description="What the harness measures from the run.")
    kind: CheckKind = Field(..., description="What ``expected`` is (see the catalog's kinds).")
    reference: str = Field(..., description="The source of ``expected``, named so it can be found.")
    expected: float | dict[str, float] = Field(
        ..., description="The value; a map from the bus's idx for a per-bus quantity."
    )
    tolerance: Tolerance
    window_hz: tuple[float, float] | None = Field(
        None,
        description=(
            "Eigenvalue quantities only: the frequency window, in Hz, whose least damped "
            "oscillatory eigenvalue is the mode that is meant."
        ),
    )
    pflow: PFlowSettings | None = Field(
        None,
        description=(
            "Power flow quantities only: the settings of the power flow whose result is "
            "compared. ``null`` is the power flow at TENSA's defaults."
        ),
    )
    generated_by: str | None = Field(
        None, description="The script that wrote this check, which may write it again."
    )

    @model_validator(mode="after")
    def _holds_together(self) -> Self:
        problems: list[str] = []
        if self.pflow is not None and not self.quantity.startswith("pf."):
            problems.append("pflow belongs to a power flow quantity only")
        if self.quantity in MAP_QUANTITIES:
            if not isinstance(self.expected, dict) or not self.expected:
                problems.append(f"{self.quantity} needs a map of the buses' values")
        elif isinstance(self.expected, dict):
            problems.append(f"{self.quantity} is one number, not a map")
        if self.quantity in EIG_QUANTITIES:
            if self.window_hz is None or not 0 <= self.window_hz[0] < self.window_hz[1]:
                problems.append(f"{self.quantity} needs window_hz as [low, high] with low < high")
        elif self.window_hz is not None:
            problems.append("window_hz belongs to an eigenvalue quantity only")
        if self.kind == "cross-engine" and self.reference and "sienna" not in self.reference.lower():
            problems.append("a cross-engine check names the engine it compares with in its reference")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @property
    def analysis(self) -> Literal["pf", "tds", "eig"]:
        return self.quantity.split(".", 1)[0]  # type: ignore[return-value]


class EventRef(_Model):
    """An event the case file defines, by the model and idx the elements route takes."""

    model: str = Field(
        ..., description="ANDES model of the event: ``Toggle``, ``Fault`` or ``Alter``."
    )
    idx: int | str = Field(..., description="The event's idx in the case file (not its name).")


class DisturbancePlan(_Model):
    """The disturbance the case is shown with: the events of its file plus ``specs``."""

    description: str = Field(..., description="What happens, in a sentence.")
    specs: list[DisturbanceSpec] = Field(
        default_factory=list,
        description=(
            "Disturbances committed before the run, as ``POST /sessions/{id}/disturbances`` "
            "takes them. Empty when the case's file already holds its events."
        ),
    )
    tf: float = Field(10.0, gt=0, description="End time of the run, in seconds.")
    h: float | None = Field(
        None,
        gt=0,
        description=(
            "Integration step of the run, in seconds. ``null`` is TENSA's default. A case whose "
            "numbers are compared with a continuous solution gives a step small enough for "
            "the trapezoidal rule's phase error to be far under the tolerance."
        ),
    )
    stable_below_deg: float = Field(
        180.0,
        gt=0,
        description="The run counts as stable when its rotor angles end closer together than this.",
    )
    settles_within_deg: float | None = Field(
        None,
        gt=0,
        description=(
            "For a disturbance that is cleared and leaves the network as it was: the run must "
            "also end with the spread of its rotor angles within this many degrees of what it "
            "was before the disturbance. A loaded network starts with machines tens of degrees "
            "apart, so ``stable_below_deg`` alone cannot tell a swing that dies out from one "
            "that has drifted. ``null`` makes no such check."
        ),
    )


class RingDownCompare(_Model):
    """Another case whose ring-down this case's is compared with, in the time domain."""

    case: _Id = Field(
        ...,
        description=(
            "The example the case is a variant of (the same system without what this one adds). "
            "Its own reference gives the events its run takes out."
        ),
    )
    window_hz: tuple[float, float] = Field(
        ...,
        description=(
            "The frequency window, in Hz, of the mode compared: the ring-down pole in it with "
            "the most energy is taken in each case."
        ),
    )
    change: tuple[float, float] = Field(
        ...,
        description=(
            "How far this case's damping ratio of that pole may lie from the other case's: "
            "``[lowest, highest]`` of this one's minus the other's. A stabiliser that adds "
            "damping gives a range above zero; one that does nothing, a range about zero."
        ),
    )

    @model_validator(mode="after")
    def _holds_together(self) -> Self:
        if not 0 <= self.window_hz[0] < self.window_hz[1]:
            raise ValueError("window_hz is [low, high] with low < high")
        if self.change[0] > self.change[1]:
            raise ValueError("change is [lowest, highest] with lowest <= highest")
        return self


class CrossEnginePlan(_Model):
    """How the case is compared between the ANDES and Sienna engines."""

    engine: Literal["sienna"] = Field(
        "sienna",
        description="The engine the case is run under besides ANDES. Only Sienna exists.",
    )
    pf_voltage_pu: float = Field(
        2e-5, gt=0, description="Largest allowed difference of any bus voltage magnitude, pu."
    )
    pf_angle_rad: float = Field(
        2e-5, gt=0, description="Largest allowed difference of any bus angle, rad."
    )
    pf_power_mw: float = Field(
        1e-3, gt=0, description="Largest allowed difference of losses and slack power, MW."
    )
    series_rms_pu: float = Field(
        2e-4, gt=0, description="Largest allowed time-weighted RMS difference of any compared series."
    )
    series_max_pu: float = Field(
        2e-3, gt=0, description="Largest allowed difference at one instant of any compared series."
    )
    known_difference: str | None = Field(
        None,
        description=(
            "The id of the entry of engines/known_differences.json that explains a difference "
            "the checks of this case allow. ``null`` expects exact agreement."
        ),
    )
    sienna: str = Field(
        "unchecked",
        pattern=r"^(pass|differ:[a-z0-9][a-z0-9_-]*|refused|unchecked)$",
        description=(
            "What the Sienna engine is expected to do with this case: ``pass`` the comparison, "
            "``differ:<id>`` pass with the known difference of that id, ``refused`` refuse the "
            "case (the checks then assert the refusal, not agreement), or ``unchecked``, which "
            "every expectation is until the reviewer runs the script and records what the case "
            "does. The worker does not guess outcomes."
        ),
    )
    refusal_stage: str | None = Field(
        None,
        description=(
            "For sienna = refused: the stage of the refusal, from the vocabulary of decision 38 "
            "(not_ready, arguments, disturbances, matrix, build, eig, internal), when the case "
            "loads but the run is refused; ``null`` when the load itself is refused."
        ),
    )


class RingDownPlan(_Model):
    """The small disturbance whose ring-down the harness compares with the eigenvalues."""

    specs: list[DisturbanceSpec] = Field(
        default_factory=list,
        description=(
            "The small disturbance, as the disturbances route takes it. Empty: the load with "
            "the most power is stepped up by ``load_step`` at ``start_t``."
        ),
    )
    load_step: float = Field(0.02, gt=0, le=0.2, description="Fraction the load is stepped by.")
    start_t: float = Field(0.5, gt=0, description="When the disturbance acts, in seconds.")
    tf: float = Field(20.0, gt=0, description="End time of the run, in seconds.")
    band_hz: tuple[float, float] = Field(
        (0.1, 3.0), description="The band, in Hz, the oscillations are looked for in."
    )
    modes: int = Field(
        3, ge=1, le=10, description="How many of the strongest oscillations are compared."
    )
    tolerance_hz: float = Field(
        0.05, gt=0, description="How far a ring-down frequency may be from its eigenvalue's."
    )
    tolerance_damping: float = Field(
        0.05, gt=0, description="How far a ring-down damping ratio may be from its eigenvalue's."
    )
    max_damping_ratio: float | None = Field(
        None,
        gt=0,
        description=(
            "Poles damped more than this are not compared. In a network with many modes a run "
            "of a few tens of seconds cannot tell a pole that dies within a second or two from "
            "its neighbours, so what the fit finds there is not a fair test of an eigenvalue. "
            "``null`` compares every pole."
        ),
    )
    compare: RingDownCompare | None = Field(
        None,
        description=(
            "Hold the damping of a mode to the damping the same disturbance gives in another "
            "case (a variant without what this one adds, such as a stabiliser). Both are read "
            "from time-domain runs, so the comparison does not rest on the eigenvalue analysis "
            "of either."
        ),
    )


class ExampleReference(_Model):
    version: Literal[1] = Field(..., description="The version of this file's schema.")
    id: _Id = Field(..., description="The example case this file belongs to.")
    remove_events: list[EventRef] = Field(
        default_factory=list,
        description=(
            "The events the case's file defines (listed by the topology's ``events``), which the "
            "undisturbed, eigenvalue and ring-down runs take out so that nothing acts on the case."
        ),
    )
    disturbance: DisturbancePlan | None = Field(
        None, description="What the case's disturbance run does. ``null`` for a power-flow case."
    )
    ring_down: RingDownPlan = Field(default_factory=lambda: RingDownPlan.model_validate({}))
    cross_engine: CrossEnginePlan | None = Field(
        None,
        description=(
            "How this case is checked under the Sienna engine against the ANDES run, when the "
            "script runs with --engines andes,sienna. ``null``: no cross-engine check is made."
        ),
    )
    checks: list[ReferenceCheck] = Field(default_factory=list)

    @model_validator(mode="after")
    def _holds_together(self) -> Self:
        names = [c.name for c in self.checks]
        dupes = sorted({n for n in names if names.count(n) > 1})
        if dupes:
            raise ValueError(f"check names must be unique: {', '.join(dupes)}")
        if self.disturbance is None and any(c.analysis == "tds" for c in self.checks):
            raise ValueError("a time-domain check needs a disturbance plan")
        if self.cross_engine is not None:
            if self.cross_engine.sienna == "refused" and any(
                c.kind == "cross-engine" for c in self.checks
            ):
                raise ValueError("a case Sienna refuses carries no cross-engine checks")
            if self.cross_engine.sienna.startswith("differ:"):
                named = self.cross_engine.sienna.split(":", 1)[1]
                if self.cross_engine.known_difference != named:
                    raise ValueError(
                        "sienna = differ:<id> needs known_difference set to the same id"
                    )
            if self.cross_engine.known_difference and not self.cross_engine.sienna.startswith(
                "differ:"
            ):
                raise ValueError("known_difference belongs to sienna = differ:<id>")
        return self


class ReferenceFileError(Exception):
    """A reference file is unreadable or does not validate."""


def references_dir() -> Path:
    """The folder of the package that holds the reference files."""
    return examples_dir() / "references"


def parse_reference(text: str) -> ExampleReference:
    """The reference a JSON text holds, or ``ReferenceFileError`` naming what is wrong with it."""
    try:
        return ExampleReference.model_validate_json(text)
    except ValueError as exc:  # pydantic's ValidationError is a ValueError
        raise ReferenceFileError(f"the reference is not valid: {exc}") from exc


def load_reference(example_id: str, directory: Path | None = None) -> ExampleReference | None:
    """The reference of one case, or ``None`` when it has none yet."""
    path = (directory or references_dir()) / f"{example_id}.json"
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ReferenceFileError(f"cannot read {path.name}: {exc}") from exc
    reference = parse_reference(text)
    if reference.id != example_id:
        raise ReferenceFileError(f"{path.name} is the reference of {reference.id!r}")
    return reference
