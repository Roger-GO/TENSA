"""Controllers a time-domain run can close a loop with.

ANDES integrates the models the case holds and nothing else. A study of what a
battery does for the frequency needs something that reads the frequency while the
run is going and tells the battery what to deliver, which on ANDES's Python API
is a function assigned to ``TDS.callpert``. A server cannot take such a function
from a client: it would be the client's code running in the worker. So a run
takes the *parameters* of controllers written here, and nothing that is
evaluated. There are two, the two a frequency study starts with:

**Frequency droop** (``droop``). Power in proportion to the frequency deviation
beyond a dead band, positive (discharging) when the frequency is low::

    deviation = f_nominal - f                               Hz
    command   = gain * (|deviation| - deadband)             MW, with the sign of
                                                            the deviation
    command   = 0 inside the dead band

limited to ``p_max`` either way. Left out, the limit is the device's own: the
smaller of its power limit ``pmx`` and its current limit ``ialim``.

**Fast frequency response** (``ffr``). A fixed power, delivered once. The
controller waits until the frequency is ``trigger_deviation`` below nominal, or
falls faster than ``trigger_rocof``, then commands ``power`` for ``hold`` seconds
and lets go. It does not arm again in the same run. A negative ``power`` makes it
the mirror image: it waits for the frequency to be that much above nominal, or to
rise that fast, and absorbs.

Either may be given a ``ramp``, the most its command moves per second.

**What it commands.** A device of ANDES's ``DG`` group (``ESD1``, the battery the
element builder adds, and ``PVD1``, ``EV1``, ``EV2`` where a case file has them).
Those models add an external signal to their active power set-point, the service
``Pext0``, which ANDES declares as their ``paux`` set-point and gives in per unit
of the system base. The controller writes its command there, in MW over the
system base, on top of what the input held. The device does the rest: its own
limits (``pmx``, the current limit, a battery's state of charge) decide what is
delivered, so a command the device cannot meet is simply not met, and the
difference shows in what the run records. Two controllers on one device add up.
A synchronous machine's governor has an auxiliary input too, but what a unit of
it means differs from one governor model to the next, so those are not offered.

**What it measures.** Either the centre-of-inertia frequency (``coi``): the mean
of the rotor speeds of the synchronous machines in service, each weighted by its
inertia ``M`` on the system base, times the system's nominal frequency. Or the
frequency at the device's own bus (``bus``): the ``fHz`` the device measures
through its ``BusFreq``, which follows the bus angle through a washout filter
and so jumps during a fault, as a real converter's measurement does.

**When it acts.** ANDES calls ``TDS.callpert(t, system)`` before it solves the
step that ends at ``t``; what the System holds at that moment is the solution of
the step before, at ``t - TDS.h``. The controllers keep their clock on that
solved instant. A controller samples at the first solved instant at or after
each multiple of its ``period`` counted from ``t_start``, and holds its command
until the next sample, so the command computed from the state at one instant
applies from that instant on (a zero-order hold, with no extra delay). A step
ANDES has to retry with a smaller size calls the hook again with the same solved
instant; the sample is already taken, so nothing is computed twice. The rate of
change of frequency an FFR triggers on is the difference of two consecutive
samples over the time between them. (The run's own record of its variables,
``tensa.core.stream``, labels each row with the time the hook was called with,
one step after the instant the row holds. A controller's samples carry the
instant itself.)

**What a run leaves behind.** Nothing: when the run ends, however it ends, each
device's input is put back to what it held. A later run on the same System that
names the same controllers and starts where this one stopped (a larger ``tf``)
carries them on: an FFR that has fired stays fired, a ramp goes on from the
command it had reached. Any other run starts its controllers afresh. So does a
run on a System a reload or a restored snapshot put in this one's place: what a
controller has done is kept beside the System and not in it, so a snapshot does
not hold it, and an FFR that fired before the snapshot was taken can fire again
in a run that goes on from it.

An ``Alter`` event on the same device's ``Pext0`` would be overwritten at the
next sample, so a run with both is refused; an ``Alter`` on ``pref0`` steps the
set-point under the controller and is fine.

The rules rest on how ANDES 2.0.0 lays these things out (contract 13 in
``server/ANDES_VERSIONS.md``).
"""

from __future__ import annotations

import logging
import math
import weakref
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, Any, Final, Literal, cast

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, model_validator

from tensa.core.dae_vars import dae_var_name
from tensa.core.errors import TdsRequestError, short_repr
from tensa.core.messages import NOTICE_LOGGER

if TYPE_CHECKING:
    from andes.system import System

CONTROLLER_TYPES: Final = ("droop", "ffr")
FREQUENCY_SOURCES: Final = ("coi", "bus")

# The ANDES group whose devices a controller commands, and the set-point of
# theirs it writes (a key of the model's ``_setpoints``).
TARGET_GROUP: Final = "DG"
SETPOINT: Final = "paux"

# The most controllers one run takes. Each costs a few array reads a sample.
MAX_CONTROLLERS: Final = 32

# The sample period a controller gets when the request names none, and the
# bounds one may name: under a millisecond is below any step a run takes, and a
# controller that samples less than once a minute is not one.
DEFAULT_PERIOD: Final = 0.1
MIN_PERIOD: Final = 1e-3
MAX_PERIOD: Final = 60.0

# How many values the samples a batch run returns may hold in all (five a
# sample: time, frequency, command, output, state of charge). The samples after
# that are left out and the trace says so.
MAX_SAMPLE_VALUES: Final = 500_000
_VALUES_PER_SAMPLE: Final = 5

# Slack on the comparisons of times, which are sums of binary fractions.
_EPS: Final = 1e-9

# A status flag is 0.0 or 1.0; anything above this counts as set.
_SET: Final = 0.5

_log = logging.getLogger(NOTICE_LOGGER)


# ---- what a request names ---------------------------------------------------


class _ControllerBase(BaseModel):
    """What every controller names: its device, its measurement, its timing."""

    model_config = ConfigDict(extra="forbid")

    model: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description=(
            "ANDES model of the device the controller commands: one of the "
            "distributed generation models (``ESD1``, ``PVD1``, ``EV1``, ``EV2``). "
            "``GET /sessions/{id}/tds/controllers`` lists the devices of the "
            "loaded case that can be named."
        ),
    )
    idx: int | str = Field(
        ...,
        description="The device's idx. ``5`` and ``\"5\"`` name the same device.",
    )
    frequency: Literal["coi", "bus"] = Field(
        "coi",
        description=(
            "The frequency the controller reads. ``coi``: the centre-of-inertia "
            "frequency, the inertia-weighted mean speed of the synchronous "
            "machines in service times the system's nominal frequency. ``bus``: "
            "the frequency the device measures at its own bus (its ``fHz``), "
            "which jumps during a fault."
        ),
    )
    period: float = Field(
        DEFAULT_PERIOD,
        ge=MIN_PERIOD,
        le=MAX_PERIOD,
        allow_inf_nan=False,
        description=(
            "Seconds between two samples. The controller reads the frequency and "
            "sets its command once a period and holds it in between. A period "
            "shorter than the integration step samples at every step."
        ),
    )
    t_start: float = Field(
        0.0,
        ge=0.0,
        allow_inf_nan=False,
        description="Simulation time, in seconds, before which the controller commands nothing.",
    )
    ramp: float | None = Field(
        None,
        gt=0.0,
        allow_inf_nan=False,
        description=(
            "The most the command may change, in MW per second. ``null`` lets it "
            "jump from one sample to the next."
        ),
    )


class DroopController(_ControllerBase):
    """Frequency droop: power in proportion to the frequency deviation beyond a
    dead band, positive (discharging) when the frequency is below nominal."""

    type: Literal["droop"] = Field(..., description="Discriminator: a frequency droop.")
    gain: float = Field(
        ...,
        gt=0.0,
        allow_inf_nan=False,
        description="MW commanded per Hz of deviation beyond the dead band.",
    )
    deadband: float = Field(
        0.0,
        ge=0.0,
        allow_inf_nan=False,
        description="Deviation from nominal, in Hz either way, the controller ignores.",
    )
    p_max: float | None = Field(
        None,
        gt=0.0,
        allow_inf_nan=False,
        description=(
            "The largest command, in MW, discharging or charging. ``null`` uses "
            "the device's own limit: the smaller of its power limit ``pmx`` and "
            "its current limit ``ialim``."
        ),
    )


class FfrController(_ControllerBase):
    """Fast frequency response: a fixed power, delivered once for a set time
    when the frequency leaves a threshold or moves too fast."""

    type: Literal["ffr"] = Field(..., description="Discriminator: a fast frequency response.")
    power: float = Field(
        ...,
        allow_inf_nan=False,
        description=(
            "MW commanded once triggered. Positive discharges and answers a low "
            "frequency; negative absorbs and answers a high one. Not zero."
        ),
    )
    trigger_deviation: float | None = Field(
        None,
        gt=0.0,
        allow_inf_nan=False,
        description=(
            "Triggers when the frequency is this many Hz below nominal (above, "
            "for a negative ``power``). ``null`` leaves the deviation out."
        ),
    )
    trigger_rocof: float | None = Field(
        None,
        gt=0.0,
        allow_inf_nan=False,
        description=(
            "Triggers when the frequency falls this many Hz per second or faster "
            "(rises, for a negative ``power``), measured between two samples. "
            "``null`` leaves the rate out. At least one of the two triggers must "
            "be given."
        ),
    )
    hold: float = Field(
        10.0,
        gt=0.0,
        allow_inf_nan=False,
        description="Seconds the power is held before the controller lets go.",
    )

    @model_validator(mode="after")
    def _usable(self) -> FfrController:
        if self.power == 0.0:
            raise ValueError("power must not be zero")
        if self.trigger_deviation is None and self.trigger_rocof is None:
            raise ValueError("give trigger_deviation, trigger_rocof or both")
        return self


# Discriminated union: Pydantic picks the variant by ``type``.
ControllerSpec = Annotated[DroopController | FfrController, Field(discriminator="type")]

_SPECS: Final[TypeAdapter[list[ControllerSpec]]] = TypeAdapter(list[ControllerSpec])


# The longest field name a refusal repeats. The models' own are shorter; a key
# a client made up is as long as the client likes.
_MAX_FIELD_NAME: Final = 40


def _first_problem(exc: ValidationError) -> str:
    """The first thing wrong with a ``controllers`` list, as one sentence.

    Nothing a client sent is repeated at length. Pydantic's message for a
    ``type`` it does not know quotes the value in full, so that one is written
    here, and a key that is not a field is part of the location, so it is cut.
    """
    error = exc.errors(include_url=False, include_context=False, include_input=False)[0]
    where = "controllers"
    for part in error.get("loc", ()):
        if isinstance(part, int):
            where += f"[{part}]"
        elif part not in CONTROLLER_TYPES:  # the discriminator's tag is not a field
            name = str(part)
            if len(name) > _MAX_FIELD_NAME:
                name = f"{name[: _MAX_FIELD_NAME - 3]}..."
            where += f".{name}"
    if error.get("type") in ("union_tag_invalid", "union_tag_not_found"):
        kinds = " or ".join(repr(kind) for kind in CONTROLLER_TYPES)
        return f"{where}.type: must be {kinds}"
    message = str(error.get("msg", "is not valid")).removeprefix("Value error, ")
    return f"{where}: {message}"


def parse_controllers(raw: object) -> list[ControllerSpec]:
    """The controllers a run request names, checked.

    ``raw`` is the request's ``controllers`` as it arrived: ``None`` or a list
    of objects. The REST body is validated against the same models before it
    gets here; the WebSocket's ``start_tds`` frame and the worker call this, so
    a list that did not come through the REST body is held to the same rules.

    Raises:
        TdsRequestError: not a list, too long, or an entry breaks a rule. Raised
            before anything is written to the System.
    """
    if raw is None:
        return []
    if not isinstance(raw, list | tuple):
        raise TdsRequestError(
            f"'controllers' must be a list of controller objects, got {short_repr(raw)}"
        )
    if len(raw) > MAX_CONTROLLERS:
        raise TdsRequestError(
            f"'controllers' names {len(raw)} controllers; a run takes at most {MAX_CONTROLLERS}"
        )
    plain = [
        item.model_dump() if isinstance(item, BaseModel) else item for item in raw
    ]
    try:
        return _SPECS.validate_python(plain)
    except ValidationError as exc:
        raise TdsRequestError(_first_problem(exc)) from None


# ---- the devices a controller can command -----------------------------------


def device_label(model: str, idx: int | str) -> str:
    """A device in words: ``ESD1 1``, and ``ESD1_1`` alone for an idx that
    already says what it is."""
    return idx if isinstance(idx, str) and model in idx else f"{model} {idx}"


def _plain(value: Any) -> Any:
    """``value`` as a plain Python scalar (ANDES holds some idx as numpy types)."""
    return value.item() if isinstance(value, np.generic) else value


def _floats(holder: object, count: int) -> np.ndarray | None:
    """The ``count`` current values of a parameter, service or variable, or
    ``None`` when it has none, another count, or values that are not numbers."""
    raw = getattr(holder, "v", None)
    if raw is None:
        return None
    try:
        values = np.asarray(raw, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    return values if values.shape == (count,) else None


def _at(model: object, name: str, position: int) -> float | None:
    """One device's value of ``model.<name>``, ``None`` where the model has no
    such thing or the value is not a finite number."""
    raw = getattr(getattr(model, name, None), "v", None)
    if raw is None:
        return None
    try:
        value = float(raw[position])
    except (TypeError, ValueError, IndexError):
        return None
    return value if math.isfinite(value) else None


def controllable_models(system: System) -> dict[str, Any]:
    """The models of ``system`` whose devices a controller can command, by name:
    those of the ``DG`` group that declare the ``paux`` set-point."""
    group = getattr(system, "groups", {}).get(TARGET_GROUP)
    models = getattr(group, "models", {}) if group is not None else {}
    return {
        name: model
        for name, model in models.items()
        if SETPOINT in getattr(model, "_setpoints", {})
    }


def _base_mva(system: System) -> float:
    try:
        mva = float(getattr(system.config, "mva", 100.0))
    except (TypeError, ValueError):
        return 100.0
    return mva if math.isfinite(mva) and mva > 0.0 else 100.0


def _nominal_frequency(system: System) -> float:
    try:
        freq = float(getattr(system.config, "freq", 60.0))
    except (TypeError, ValueError):
        return 60.0
    return freq if math.isfinite(freq) and freq > 0.0 else 60.0


def _machines(system: System) -> list[Any]:
    """The synchronous machine models with devices that have a speed and an inertia."""
    group = getattr(system, "groups", {}).get("SynGen")
    models = getattr(group, "models", {}) if group is not None else {}
    return [
        model
        for model in models.values()
        if int(getattr(model, "n", 0)) > 0 and hasattr(model, "omega") and hasattr(model, "M")
    ]


def coi_speed(system: System) -> float | None:
    """The centre-of-inertia speed, per unit: the speeds of the synchronous
    machines in service, each weighted by its inertia ``M``. ``None`` when no
    machine is in service, or their values are not there to read."""
    weighted = total = 0.0
    for model in _machines(system):
        count = int(model.n)
        speed = _floats(model.omega, count)
        inertia = _floats(model.M, count)
        if speed is None or inertia is None:
            continue
        status = _floats(getattr(model, "u", None), count)
        weight = inertia if status is None else inertia * (status > _SET)
        weighted += float(np.dot(weight, speed))
        total += float(weight.sum())
    if total <= 0.0:
        return None
    speed_coi = weighted / total
    return speed_coi if math.isfinite(speed_coi) else None


def _limit(model: Any, position: int) -> float | None:
    """The most active power a device delivers, per unit of whatever base the
    model holds its limits on: the smaller of its power limit ``pmx`` and its
    current limit ``ialim`` (the power that current carries at rated voltage).
    ``None`` where the model has neither. ANDES's default ``pmx`` is 9999, no
    limit at all, so on most cases it is the current limit that counts."""
    limits = [
        value
        for value in (_at(model, "pmx", position), _at(model, "ialim", position))
        if value is not None
    ]
    return min(limits) if limits else None


def _device_limit(system: System, model: Any, position: int, mva: float) -> float | None:
    """:func:`_limit` in MW. ``setup()`` moves the limits from the device
    rating to the system base, so which base they are on depends on whether
    that has run."""
    limit = _limit(model, position)
    if limit is None:
        return None
    if bool(getattr(system, "is_setup", False)):
        return limit * mva
    rating = _at(model, "Sn", position)
    return limit * (rating if rating is not None else mva)


def controller_targets(system: System) -> list[dict[str, Any]]:
    """Every device of ``system`` a controller can command, with what a client
    needs to name it and to record what the controller does to it.

    ``variables`` holds the ANDES variables (the names ``dae_vars`` takes) that
    show the loop at work: the command as the device receives it (``Pext``, per
    unit of the system base), the frequency it measures (``fHz``, Hz), its
    active current (``Ipout_y``, which times the bus voltage is the output in
    per unit) and, for a model with one, its state of charge (``pIG_y``).
    Needs no ``setup()``.
    """
    mva = _base_mva(system)
    targets: list[dict[str, Any]] = []
    for name, model in controllable_models(system).items():
        for position, idx in enumerate(list(model.idx.v)):
            status = _at(model, "u", position)
            names = getattr(getattr(model, "name", None), "v", None)
            buses = getattr(getattr(model, "bus", None), "v", None)
            targets.append(
                {
                    "model": name,
                    "idx": _plain(idx),
                    "name": str(names[position]) if names is not None else str(idx),
                    "bus": _plain(buses[position]) if buses is not None else None,
                    "in_service": status is None or status > _SET,
                    "p_limit": _device_limit(system, model, position, mva),
                    "fn": _at(model, "fn", position),
                    "variables": {
                        "command": dae_var_name(name, "Pext", idx),
                        "frequency": dae_var_name(name, "fHz", idx),
                        "active_current": dae_var_name(name, "Ipout_y", idx),
                        "soc": dae_var_name(name, "pIG_y", idx)
                        if hasattr(model, "pIG_y")
                        else None,
                    },
                }
            )
    return targets


def controller_catalogue(system: System | None) -> dict[str, Any]:
    """What a client needs to offer controllers for the loaded case: the kinds
    there are, the devices they can command, and whether the case has the
    synchronous machines the centre-of-inertia frequency is read from."""
    if system is None:
        return {
            "types": list(CONTROLLER_TYPES),
            "coi_available": False,
            "freq_hz": None,
            "base_mva": None,
            "targets": [],
        }
    return {
        "types": list(CONTROLLER_TYPES),
        "coi_available": bool(_machines(system)),
        "freq_hz": _nominal_frequency(system),
        "base_mva": _base_mva(system),
        "targets": controller_targets(system),
    }


# ---- one run's controllers --------------------------------------------------


@dataclass
class _Device:
    """One device's auxiliary power input, and what is read off the device."""

    model: Any
    model_name: str
    idx: int | str
    position: int
    #: The service the command is written to (``Pext0``).
    attr: str
    #: What the input held before a controller wrote it, per unit. ``None``
    #: until the first step of a run and again once the run has ended.
    base: float | None = None

    def write(self, value: float) -> None:
        getattr(self.model, self.attr).v[self.position] = value

    def bus_frequency(self) -> float | None:
        return _at(self.model, "fHz", self.position)

    def nominal_frequency(self) -> float | None:
        return _at(self.model, "fn", self.position)

    def output(self, mva: float) -> float | None:
        """The active power the device delivers, in MW."""
        voltage = _at(self.model, "v", self.position)
        current = _at(self.model, "Ipout_y", self.position)
        return None if voltage is None or current is None else voltage * current * mva

    def soc(self) -> float | None:
        return _at(self.model, "pIG_y", self.position)


@dataclass
class _Loop:
    """One controller's state: what it holds between samples and what it did."""

    spec: DroopController | FfrController
    #: The command it holds, in MW.
    command: float = 0.0
    #: The solved instant from which the next sample is due.
    next_sample: float = 0.0
    last_t: float | None = None
    last_f: float | None = None
    #: The first sample that commanded a power, and, for an FFR, the sample it
    #: let go at.
    first_action_t: float | None = None
    released_t: float | None = None
    #: The multiple of the period an FFR's trigger sample stood for.
    trigger_tick: float | None = None
    peak_command: float = 0.0
    lowest_f: float | None = None
    highest_f: float | None = None
    #: This run's samples: how many, and the ones kept for the result.
    samples: int = 0
    truncated: bool = False
    trace: list[tuple[float, float, float, float | None, float | None]] = field(
        default_factory=list
    )

    def __post_init__(self) -> None:
        self.next_sample = self.spec.t_start

    def due(self, now: float) -> bool:
        return now + _EPS >= self.next_sample

    def _tick(self, now: float) -> float:
        """The multiple of the period, counted from ``t_start``, that a sample
        taken at ``now`` stands for: the last one at or before it."""
        spec = self.spec
        done = math.floor((now - spec.t_start) / spec.period + _EPS)
        return spec.t_start + done * spec.period

    def skip(self, now: float) -> None:
        """Let a sample go by that had nothing to read."""
        self.next_sample = self._tick(now) + self.spec.period

    def sample(self, now: float, f: float, nominal: float, limit: float | None) -> None:
        """Read the frequency ``f`` at the solved instant ``now`` and set the command."""
        spec = self.spec
        elapsed = 0.0 if self.last_t is None else now - self.last_t
        moving = elapsed > _EPS
        rocof = (f - self.last_f) / elapsed if moving and self.last_f is not None else 0.0
        deviation = nominal - f
        if isinstance(spec, DroopController):
            wanted = _droop(spec, deviation, limit)
        else:
            wanted = self._ffr(spec, now, deviation, rocof)
        if spec.ramp is not None:
            # The first sample has no earlier one to measure from: it may move
            # what one period allows.
            reach = spec.ramp * (elapsed if moving else spec.period)
            wanted = min(max(wanted, self.command - reach), self.command + reach)
        self.command = wanted
        if wanted != 0.0 and self.first_action_t is None:
            self.first_action_t = now
        if abs(wanted) > abs(self.peak_command):
            self.peak_command = wanted
        self.lowest_f = f if self.lowest_f is None else min(self.lowest_f, f)
        self.highest_f = f if self.highest_f is None else max(self.highest_f, f)
        self.last_t, self.last_f = now, f
        self.next_sample = self._tick(now) + spec.period

    def _ffr(self, spec: FfrController, now: float, deviation: float, rocof: float) -> float:
        """What an FFR wants at this sample: its power from the sample a trigger
        is met until ``hold`` seconds later, nothing before or after.

        The hold is counted in sample periods, not between the instants the
        samples happened to be taken at, so it does not stretch by however far
        the solver's steps fall from the multiples of the period.
        """
        if self.released_t is not None:
            return 0.0
        tick = self._tick(now)
        if self.trigger_tick is None:
            # A negative power answers a high frequency: the same rule on a
            # frequency mirrored about nominal.
            side = 1.0 if spec.power > 0.0 else -1.0
            far = spec.trigger_deviation is not None and side * deviation >= spec.trigger_deviation
            fast = spec.trigger_rocof is not None and side * rocof <= -spec.trigger_rocof
            if not (far or fast):
                return 0.0
            self.trigger_tick = tick
        elif tick - self.trigger_tick >= spec.hold - _EPS:
            self.released_t = now
            return 0.0
        return spec.power

    def keep(
        self, now: float, f: float, output: float | None, soc: float | None, room: int
    ) -> None:
        """Count this run's sample, and keep it while the result has room."""
        self.samples += 1
        if len(self.trace) >= room:
            self.truncated = True
            return
        self.trace.append((now, f, self.command, output, soc))

    def begin_run(self) -> None:
        self.samples = 0
        self.truncated = False
        self.trace = []


def _droop(spec: DroopController, deviation: float, limit: float | None) -> float:
    beyond = abs(deviation) - spec.deadband
    if beyond <= 0.0:
        return 0.0
    wanted = math.copysign(spec.gain * beyond, deviation)
    cap = spec.p_max if spec.p_max is not None else limit
    if cap is not None:
        wanted = min(max(wanted, -cap), cap)
    return wanted


def _native_idx(model: Any, idx: int | str) -> int | str | None:
    """The idx the case holds for a device a request names as ``5`` or ``"5"``."""
    known = list(getattr(getattr(model, "idx", None), "v", None) or [])
    for candidate in known:
        if type(candidate) is type(idx) and candidate == idx:
            return cast("int | str", _plain(candidate))
    for candidate in known:
        if str(candidate) == str(idx):
            return cast("int | str", _plain(candidate))
    return None


def _altered(system: System, model_name: str, idx: int | str, attr: str) -> bool:
    """Whether an ``Alter`` event of the case writes ``attr`` of this device."""
    alter = getattr(system, "Alter", None)
    if alter is None or not int(getattr(alter, "n", 0)):
        return False
    try:
        rows = zip(alter.model.v, alter.dev.v, alter.src.v, strict=False)
        return any(
            model == model_name and str(dev) == str(idx) and src == attr
            for model, dev, src in rows
        )
    except (AttributeError, TypeError):
        return False


def _bind(system: System, specs: Sequence[ControllerSpec]) -> list[_Device]:
    """The device each controller commands, in the order of ``specs``; two
    controllers on one device share one entry.

    Raises:
        TdsRequestError: a controller names a model no controller can command
            or a device the case does not have, asks for the centre-of-inertia
            frequency on a case with no synchronous machine, or commands an
            input an ``Alter`` event also writes.
    """
    models = controllable_models(system)
    has_machines = bool(_machines(system))
    shared: dict[tuple[str, str], _Device] = {}
    devices: list[_Device] = []
    for number, spec in enumerate(specs):
        where = f"controllers[{number}]"
        model = models.get(spec.model)
        if model is None:
            offered = ", ".join(sorted(name for name, m in models.items() if int(m.n) > 0))
            raise TdsRequestError(
                f"{where}: {short_repr(spec.model)} is not a model a controller can command. "
                "A controller sets the auxiliary power input of a distributed generation "
                "device (ESD1, PVD1, EV1, EV2)"
                + (f"; the loaded case has {offered}" if offered else "; the loaded case has none")
            )
        idx = _native_idx(model, spec.idx)
        if idx is None:
            raise TdsRequestError(
                f"{where}: the loaded case has no {spec.model} with idx {short_repr(spec.idx)}"
            )
        if spec.frequency == "coi" and not has_machines:
            raise TdsRequestError(
                f"{where}: the centre-of-inertia frequency needs a synchronous machine and "
                "the loaded case has none; use frequency \"bus\""
            )
        attr = model._setpoints[SETPOINT]  # noqa: SLF001 (ANDES's own declaration)
        if _altered(system, spec.model, idx, attr):
            raise TdsRequestError(
                f"{where}: an Alter event of the case writes {attr} of "
                f"{device_label(spec.model, idx)}, which the controller sets at every sample; "
                "step pref0 instead, or leave the controller out"
            )
        key = (spec.model, str(idx))
        device = shared.get(key)
        if device is None:
            device = shared[key] = _Device(
                model=model,
                model_name=spec.model,
                idx=idx,
                position=int(model.idx2uid(idx)),
                attr=attr,
            )
        devices.append(device)
    return devices


class ControllerBank:
    """The controllers of a time-domain run on one System.

    Built from a request's controllers before the run starts, which is when a
    controller that cannot be bound is refused. ``Wrapper.run_tds`` then calls
    :meth:`begin_run`, :meth:`step` from the per-step hook, and :meth:`end_run`
    whatever the outcome. Between runs the bank keeps the controllers' state
    and no reference to the System, so a run that carries on where the last one
    stopped can be given the same bank (:meth:`continues`, :meth:`rebind`).
    The state is the bank's alone: a System loaded or restored in that one's
    place is another System, and its runs get a new bank.
    """

    def __init__(self, system: System, specs: Sequence[ControllerSpec]) -> None:
        self.specs: list[ControllerSpec] = list(specs)
        self._devices: list[_Device] | None = _bind(system, self.specs)
        # Each controller's device as the case holds its idx, for the results.
        self._idx: list[int | str] = [device.idx for device in self._devices]
        self._system: Any = weakref.ref(system)
        self._loops = [_Loop(spec) for spec in self.specs]
        self._mva = _base_mva(system)
        self._nominal = _nominal_frequency(system)
        self._stopped_at: float | None = None
        self._room = max(1, MAX_SAMPLE_VALUES // (_VALUES_PER_SAMPLE * max(1, len(self.specs))))

    # ----- between runs -----

    def continues(self, system: System, specs: Sequence[ControllerSpec]) -> bool:
        """Whether a run of ``specs`` on ``system`` carries on from this bank's
        last run: the same System, stopped where that run left it, with the
        same controllers."""
        if self._system() is not system or self._stopped_at is None:
            return False
        if list(specs) != self.specs:
            return False
        try:
            now = float(system.dae.t)
        except (AttributeError, TypeError, ValueError):
            return False
        return abs(now - self._stopped_at) <= _EPS

    def rebind(self, system: System) -> None:
        """Find the devices again for a run that :meth:`continues`."""
        self._devices = _bind(system, self.specs)

    # ----- one run -----

    def begin_run(self) -> None:
        """Start counting a run's samples. Nothing is written until the first step."""
        for loop in self._loops:
            loop.begin_run()

    def step(self, t: float, system: System) -> None:
        """What ``TDS.callpert(t, system)`` does for the controllers.

        The System holds the solution at ``t - TDS.h`` (the module docstring
        says why that is the clock). Every controller whose sample is due reads
        its frequency and sets its command; then each device's input is written
        as what it held plus its controllers' commands.
        """
        devices = self._devices
        if devices is None:  # the run has ended; a stray call changes nothing
            return
        now = max(float(t) - float(getattr(system.TDS, "h", 0.0) or 0.0), 0.0)
        coi: float | None = None
        coi_read = False
        for loop, device in zip(self._loops, devices, strict=True):
            if device.base is None:
                # The first step of the run: ``TDS.init()`` has built the
                # services by now, so this is what the input holds of its own.
                device.base = _at(device.model, device.attr, device.position) or 0.0
            if not loop.due(now):
                continue
            if loop.spec.frequency == "coi":
                if not coi_read:
                    speed = coi_speed(system)
                    coi = None if speed is None else speed * self._nominal
                    coi_read = True
                frequency, nominal = coi, self._nominal
            else:
                frequency = device.bus_frequency()
                nominal = device.nominal_frequency() or self._nominal
            if frequency is None:
                # No machine left in service, or a value that is not a number:
                # the command stays where it is.
                loop.skip(now)
                continue
            limit = _limit(device.model, device.position)
            loop.sample(now, frequency, nominal, None if limit is None else limit * self._mva)
            loop.keep(now, frequency, device.output(self._mva), device.soc(), self._room)
        totals: dict[int, float] = {}
        for loop, device in zip(self._loops, devices, strict=True):
            totals[id(device)] = totals.get(id(device), 0.0) + loop.command
        for device in {id(device): device for device in devices}.values():
            device.write((device.base or 0.0) + totals[id(device)] / self._mva)

    def end_run(self, system: System) -> None:
        """Put every device's input back to what it held, and let go of the System."""
        devices, self._devices = self._devices, None
        for device in {id(device): device for device in devices or []}.values():
            if device.base is not None:
                device.write(device.base)
                device.base = None
        try:
            self._stopped_at = float(system.dae.t)
        except (AttributeError, TypeError, ValueError):
            self._stopped_at = None

    # ----- what the run did -----

    def results(self, *, traces: bool) -> list[dict[str, Any]]:
        """One entry per controller, in the order asked: what it commanded and,
        with ``traces``, its samples.

        The times an FFR triggered and let go, and the peak, count from when
        the controller started, so a run that carries an earlier one on still
        reports them. ``samples`` and the trace are this run's.
        """
        out: list[dict[str, Any]] = []
        for loop, idx in zip(self._loops, self._idx, strict=True):
            spec = loop.spec
            entry: dict[str, Any] = {
                "type": spec.type,
                "model": spec.model,
                "idx": idx,
                "samples": loop.samples,
                "first_action_t": loop.first_action_t,
                "released_t": loop.released_t,
                "peak_command": loop.peak_command,
                "final_command": loop.command,
            }
            if traces:
                names = ("t", "frequency", "command", "output", "soc")
                entry["trace"] = {
                    **{name: [row[i] for row in loop.trace] for i, name in enumerate(names)},
                    "truncated": loop.truncated,
                }
            out.append(entry)
        return out

    def notices(self) -> list[str]:
        """One sentence per controller on what it did, for the session's messages."""
        lines: list[str] = []
        for loop, idx in zip(self._loops, self._idx, strict=True):
            spec = loop.spec
            who = (
                f"{'Droop' if isinstance(spec, DroopController) else 'Fast frequency response'} "
                f"on {device_label(spec.model, idx)}"
            )
            if loop.samples == 0 and loop.first_action_t is None:
                lines.append(f"{who} took no sample in this run (it starts at t = {spec.t_start:g} s).")
            elif loop.first_action_t is None:
                never = (
                    "left its dead band" if isinstance(spec, DroopController) else "met a trigger"
                )
                seen = (
                    ""
                    if loop.lowest_f is None or loop.highest_f is None
                    else f" (it read {loop.lowest_f:.5g} to {loop.highest_f:.5g} Hz)"
                )
                lines.append(f"{who} commanded nothing: the frequency never {never}{seen}.")
            elif isinstance(spec, DroopController):
                lines.append(
                    f"{who} acted from t = {loop.first_action_t:.4g} s: its command peaked at "
                    f"{loop.peak_command:.4g} MW and was {loop.command:.4g} MW when the run ended."
                )
            else:
                until = (
                    f"until t = {loop.released_t:.4g} s"
                    if loop.released_t is not None
                    else "and was still holding it when the run ended"
                )
                lines.append(
                    f"{who} triggered at t = {loop.first_action_t:.4g} s and commanded "
                    f"{spec.power:g} MW {until}."
                )
        return lines


def log_notices(bank: ControllerBank) -> None:
    """Say what each controller of a finished run did, on the ``tensa.notice``
    logger the message capture listens to."""
    for line in bank.notices():
        _log.info(line)


__all__ = [
    "CONTROLLER_TYPES",
    "DEFAULT_PERIOD",
    "FREQUENCY_SOURCES",
    "MAX_CONTROLLERS",
    "MAX_PERIOD",
    "MAX_SAMPLE_VALUES",
    "MIN_PERIOD",
    "ControllerBank",
    "ControllerSpec",
    "DroopController",
    "FfrController",
    "coi_speed",
    "controllable_models",
    "controller_catalogue",
    "controller_targets",
    "device_label",
    "log_notices",
    "parse_controllers",
]
