"""What one continuation power flow can be asked for, and how it reaches ANDES.

ANDES's CPF (``andes/routines/cpf.py``) follows the solution of the power flow
equations with a tangent predictor and a Newton corrector while a parameter
lambda moves every load and generator set-point from its base value towards a
target. It keeps lambda and the bus voltages of each point it accepts and nothing
else. A study needs four things on top of that, and this module is where each is
turned into something ANDES 2.0.0 does (contract 11 in
``server/ANDES_VERSIONS.md``):

**The direction of the increase.** ``CPF.run`` takes either one factor for
everything (``load_scale``) or a target for each PQ load and each PV generator.
:func:`direction_targets` builds those from the four directions a request can
name: every load and every PV generator in proportion (``load``, what the routine
did before), the loads alone (``load-only``), the PV generators alone (``gen``),
or increases given device by device in MW and MVAr (``custom``). Lambda counts
multiples of the direction, so with the three built-in ones ``lambda = 1`` is
twice the base value, and with a custom one it is the increases as given. The
slack generator is never part of a direction: it supplies whatever the rest
leaves, losses included.

**Reactive limits.** ANDES says the PV model's PV to PQ switching also works
during CPF, and it does not as shipped: the routine evaluates the limiters with
``niter=0, err=1.0``, which the limiter reads as "too early in the iteration to
switch" (``min_iter`` is 2 and ``err_tol`` 0.01), so no generator switches along
the path and only those the base power flow already held stay held.
:func:`cpf_run_applied` therefore sets the limiters' ``min_iter`` to 0 for the
run, which makes them check at every evaluation. Three more things are needed
for the result to be worth having, and the run does them through the routine's
corrector (``CPF._corrector``), which it wraps:

- *Where a generator switches.* A limiter latches: it switches a generator the
  moment an iterate puts it past a limit, and with the routine's adaptive step
  that can be far beyond where the limit is reached (on IEEE 14 the nose came
  out 7% early, followed by a jump to a negative lambda). When a step converges
  with a generator newly held, shorter steps along the same tangent are solved
  until one with the switch and one without it are no more than
  :data:`SWITCH_STEP` apart, and the routine is given the one with the switch.
- *A step that fails.* The routine goes back to its last point and halves the
  step. The limiters would keep what the failed step switched, so they are put
  back to what they held at that point.
- *A switch that ends the path.* A generator held at ``qmax`` has given up its
  voltage, which from there can only sink below the set-point. If the next step
  raises it instead, the path has nowhere to go: with the generator holding its
  voltage it is past the limit, and held at the limit its voltage is on the
  wrong side. The loadability ends at the switch (a limit-induced collapse, as
  opposed to the smooth fold of a nose), and following the equations on, as the
  routine would, leads to voltages of several per unit. Such a step is refused,
  the routine finds no point beyond the switch, and it calls that point the
  nose, which is what it is.

One thing is left as ANDES has it. A limiter does not let go, so a generator
held at a limit stays held for the rest of the path, also where its voltage has
moved back across the set-point and a real exciter would take control again
(typically one that the base case holds at ``qmin`` while the load grows). From
there the curve is the one for a generator pinned at its limit. The result says
where that happens (``would_release_step`` of the generator's event), so a
reader can tell how much of the path it touches.

The solver the routine shares between its two matrices keeps a symbolic
factorisation and reuses it for any matrix of the same size. A generator that
switches changes which entries are non-zero, and KLU then reads past the end of
the old factorisation (a segmentation fault that takes the worker with it). A
run that enforces limits sets the routine's own ``linsolve`` option, which
factorises afresh at every solve; ANDES documents it as the setting for exactly
that.

The continuation starts from the power flow as it was solved. If that left a
generator past a limit, holding it there from the first step would open the curve
with a jump, so the run is refused instead and the caller is told to solve the
power flow with the limits on (:func:`generators_past_limits`). Without
enforcement the limiters are switched off for the run: the generators the base
power flow holds stay held (their flags are what the solution rests on) and no
other switches.

**The generators along the path.** The routine reads the bus voltages through
``CPF._bus_vmag`` once for every point it keeps. The run wraps that method and
reads the reactive output and the limiter flags of every PV and Slack generator
at the same moment. The routine reads a point twice when it refines the last one
(a full curve's return to ``lambda = 0``), so the readings are matched to the
columns of ``CPF.V`` by the voltages themselves.

**The lower branch.** ``CPF.config.stop_at`` set to ``FULL`` makes the routine
turn at the nose and follow the lower-voltage solutions back to ``lambda = 0``.

Everything written to the System is put back when the run ends: the routine's
``step``, ``max_steps``, ``stop_at`` and ``linsolve``, the limiters' ``enable`` and
``min_iter``, the two wrapped methods, and the limiter flags, which the routine
does not restore with the rest of the base case.
"""

from __future__ import annotations

import contextlib
import math
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final, Literal

import numpy as np

from tensa.core.cpf_result import CpfGeneratorTrace, CpfLimitEvent
from tensa.core.errors import CpfPrerequisiteError, CpfRequestError, short_repr

if TYPE_CHECKING:
    from andes.system import System

DIRECTIONS: Final = ("load", "load-only", "gen", "custom")
STOP_AT: Final = ("nose", "full")

# The built-in directions aim at twice the base value, so lambda reads as the
# increase in units of the base case: 0.5 is 50% more load.
BASE_MULTIPLE: Final = 2.0

# How closely a switch is placed: the first point with a generator held lies no
# further than this beyond where it reached its limit. It is a distance in the
# space of every variable and lambda together, so lambda itself is off by less.
SWITCH_STEP: Final = 1e-3

# How far, in pu, a generator's terminal voltage has to move from where it
# switched before the move counts as one. The corrector converges to 1e-6.
VOLTAGE_MOVE: Final = 1e-5

# How far, in pu, a held generator's terminal voltage has to be on the far side of
# its set-point before the result says a real exciter would have let go there.
VOLTAGE_PAST_SETPOINT: Final = 1e-3

# How far past a limit, in pu, the base power flow may leave a generator before a
# run that enforces limits is refused. The power flow itself converges to 1e-6.
PAST_LIMIT_TOLERANCE: Final = 1e-4

# A direction whose increases add up to less than this, in pu, moves nothing.
_ZERO_DIRECTION: Final = 1e-12

# A limiter flag is 0.0 or 1.0; anything above this counts as set.
_SET: Final = 0.5

_FLAGS: Final = ("zl", "zu", "zi", "ql", "qu")
_COUNTS: Final = ("nql", "nqu")
_CONFIG: Final = ("step", "max_steps", "stop_at", "linsolve")


# ---- validation -------------------------------------------------------------


def _number(value: object) -> float | None:
    """``value`` as a finite float, or ``None`` when it is not a number."""
    # ``bool`` is an ``int`` subclass; ``true`` is not a number here.
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        number = float(value)
    except OverflowError:  # an int too large for a float
        return None
    return number if math.isfinite(number) else None


def validate_cpf_options(
    *,
    direction: object = "load",
    stop_at: object = "nose",
    step: object = None,
    max_steps: object = None,
    enforce_q_limits: object = None,
) -> None:
    """Refuse a continuation setting before anything is written to the System.

    ``None`` means the request leaves the setting alone. The REST body carries
    the same rules as field constraints; the worker calls this too, so a value
    that did not come through the REST body is held to them.

    Raises:
        CpfRequestError: a value is of the wrong type or outside its range.
    """
    if direction not in DIRECTIONS:
        raise CpfRequestError(
            f"direction must be one of {', '.join(DIRECTIONS)}, got {short_repr(direction)}"
        )
    if stop_at not in STOP_AT:
        raise CpfRequestError(
            f"stop_at must be one of {', '.join(STOP_AT)}, got {short_repr(stop_at)}"
        )
    step_size = _number(step)
    if step is not None and (step_size is None or step_size <= 0):
        raise CpfRequestError(f"step must be a number above zero, got {short_repr(step)}")
    if max_steps is not None and (
        isinstance(max_steps, bool) or not isinstance(max_steps, int) or max_steps < 1
    ):
        raise CpfRequestError(
            f"max_iter must be a whole number of at least 1, got {short_repr(max_steps)}"
        )
    if enforce_q_limits is not None and not isinstance(enforce_q_limits, bool):
        raise CpfRequestError(
            f"enforce_q_limits must be true or false, got {short_repr(enforce_q_limits)}"
        )


# ---- the direction of the increase ------------------------------------------


def _values(holder: Any, count: int) -> np.ndarray:
    """The ``v`` array of a parameter or service as ``count`` floats."""
    raw = getattr(holder, "v", None)
    values = np.atleast_1d(np.asarray([] if raw is None else raw, dtype=float))
    return values if values.size == count else np.zeros(count)


def _in_service(model: Any, count: int) -> np.ndarray:
    """1.0 for each device that takes part in the equations, 0.0 for the rest.

    ANDES writes ``ue`` into the bus equations: ``u`` unless the bus the device
    hangs on is out of service.
    """
    for name in ("ue", "u"):
        raw = getattr(getattr(model, name, None), "v", None)
        if raw is not None:
            values = np.atleast_1d(np.asarray(raw, dtype=float))
            if values.size == count:
                return (values > _SET).astype(float)
    return np.ones(count)


def _positions(model: Any) -> dict[str, int]:
    """Where each device of a model sits in its arrays, by its idx as text."""
    idx = getattr(getattr(model, "idx", None), "v", None)
    return {str(device): i for i, device in enumerate(idx if idx is not None else [])}


def _increase_items(name: str, items: object, fields: tuple[str, ...]) -> list[Mapping[str, Any]]:
    """The entries of one list of increases, checked for shape."""
    if items is None:
        return []
    if not isinstance(items, list | tuple):
        raise CpfRequestError(f"{name} must be a list, got {short_repr(items)}")
    checked: list[Mapping[str, Any]] = []
    for item in items:
        if not isinstance(item, Mapping):
            raise CpfRequestError(f"each entry of {name} must be an object, got {short_repr(item)}")
        idx = item.get("idx")
        if isinstance(idx, bool) or not isinstance(idx, int | str) or idx == "":
            raise CpfRequestError(f"an entry of {name} has no usable idx: {short_repr(idx)}")
        for field_name in fields:
            value = item.get(field_name, 0.0)
            if _number(value) is None:
                raise CpfRequestError(
                    f"{name}: {field_name} of {short_repr(idx)} must be a finite number, "
                    f"got {short_repr(value)}"
                )
        checked.append(item)
    return checked


def _custom_increases(
    ss: System,
    load_increase: object,
    generator_increase: object,
    mva: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A custom direction as pu increases per PQ load (P, Q) and per PV generator (P)."""
    pq, pv = ss.PQ, ss.PV
    loads = _increase_items("load_increase", load_increase, ("p", "q"))
    generators = _increase_items("generator_increase", generator_increase, ("p",))
    if not loads and not generators:
        raise CpfRequestError(
            "a custom direction needs at least one entry in load_increase or generator_increase"
        )

    dp0, dq0, dpg = np.zeros(int(pq.n)), np.zeros(int(pq.n)), np.zeros(int(pv.n))
    load_at, generator_at = _positions(pq), _positions(pv)
    slack_at = _positions(getattr(ss, "Slack", None))
    seen: set[str] = set()
    for item in loads:
        key = str(item["idx"])
        if key not in load_at:
            raise CpfRequestError(f"load_increase names {short_repr(key)}, which is not a PQ load")
        if key in seen:
            raise CpfRequestError(f"load_increase names {short_repr(key)} more than once")
        seen.add(key)
        dp0[load_at[key]] = float(item.get("p", 0.0)) / mva
        dq0[load_at[key]] = float(item.get("q", 0.0)) / mva
    seen = set()
    for item in generators:
        key = str(item["idx"])
        if key not in generator_at:
            if key in slack_at:
                raise CpfRequestError(
                    f"generator_increase names {short_repr(key)}, which is the slack generator: "
                    "it supplies whatever the rest of the direction leaves and cannot be "
                    "given an increase"
                )
            raise CpfRequestError(
                f"generator_increase names {short_repr(key)}, which is not a PV generator"
            )
        if key in seen:
            raise CpfRequestError(f"generator_increase names {short_repr(key)} more than once")
        seen.add(key)
        dpg[generator_at[key]] = float(item.get("p", 0.0)) / mva
    return dp0, dq0, dpg


_NOTHING_TO_MOVE: Final = {
    "load": "the case has no load and no PV generator output in service to scale",
    "load-only": "the case has no load in service to scale",
    "gen": (
        "the case has no PV generator output in service to scale (the slack generator is "
        "not part of a direction)"
    ),
    "custom": "every increase is zero, or is given to a device that is out of service",
}


def direction_targets(
    ss: System,
    *,
    direction: str = "load",
    load_increase: object = None,
    generator_increase: object = None,
) -> dict[str, Any]:
    """The arguments of ``CPF.run`` for the direction a request names.

    ``load_increase`` and ``generator_increase`` are the entries of a custom
    direction: ``{"idx", "p", "q"}`` per PQ load and ``{"idx", "p"}`` per PV
    generator, in MW and MVAr for each unit of lambda. A device left out does
    not move.

    Raises:
        CpfRequestError: the lists do not go with the direction, name a device
            the case does not have, or add up to no increase at all.
    """
    if direction != "custom" and (load_increase is not None or generator_increase is not None):
        raise CpfRequestError(
            "load_increase and generator_increase go with direction 'custom', "
            f"not {short_repr(direction)}"
        )
    pq, pv = ss.PQ, ss.PV
    p0, q0 = _values(pq.p0, int(pq.n)), _values(pq.q0, int(pq.n))
    # ``PV.p`` is what the routine itself moves: a copy of ``p0`` taken at setup.
    pg = _values(pv.p, int(pv.n))
    kwargs: dict[str, Any]
    if direction == "custom":
        mva = float(getattr(ss.config, "mva", 100.0)) or 100.0
        dp0, dq0, dpg = _custom_increases(ss, load_increase, generator_increase, mva)
        kwargs = {"p0_target": p0 + dp0, "q0_target": q0 + dq0, "pg_target": pg + dpg}
    else:
        more = BASE_MULTIPLE - 1.0
        zeros_pq, zeros_pv = np.zeros(int(pq.n)), np.zeros(int(pv.n))
        if direction == "load":
            dp0, dq0, dpg = p0 * more, q0 * more, pg * more
            kwargs = {"load_scale": BASE_MULTIPLE}
        elif direction == "load-only":
            dp0, dq0, dpg = p0 * more, q0 * more, zeros_pv
            kwargs = {"p0_target": p0 * BASE_MULTIPLE, "q0_target": q0 * BASE_MULTIPLE}
        else:
            dp0, dq0, dpg = zeros_pq, zeros_pq, pg * more
            kwargs = {"pg_target": pg * BASE_MULTIPLE}

    loads_on, generators_on = _in_service(pq, int(pq.n)), _in_service(pv, int(pv.n))
    moved = float(
        np.abs(dp0 * loads_on).sum() + np.abs(dq0 * loads_on).sum()
        + np.abs(dpg * generators_on).sum()
    )
    if not moved > _ZERO_DIRECTION:
        raise CpfRequestError(
            f"There is nothing to increase: {_NOTHING_TO_MOVE[direction]}."
        )
    return kwargs


# ---- reactive limits --------------------------------------------------------


@dataclass(frozen=True)
class _Generators:
    """One static generator model (PV or Slack) and its reactive limiter."""

    name: str
    model: Any
    limiter: Any


def _static_generators(ss: System) -> list[_Generators]:
    """The PV and Slack models that have devices and a reactive limiter."""
    found: list[_Generators] = []
    for name in ("PV", "Slack"):
        model = getattr(ss, name, None)
        limiter = getattr(model, "qlim", None)
        if model is None or limiter is None or not hasattr(limiter, "enable"):
            continue
        if int(getattr(model, "n", 0)) > 0 and getattr(model, "q", None) is not None:
            found.append(_Generators(name, model, limiter))
    return found


@dataclass(frozen=True)
class PastLimit:
    """A generator whose reactive output is beyond a limit it is not held at."""

    model: str
    idx: Any
    limit: Literal["qmin", "qmax"]


def generators_past_limits(
    ss: System, *, tolerance: float = PAST_LIMIT_TOLERANCE
) -> list[PastLimit]:
    """The in-service generators the solved power flow leaves past a reactive limit.

    A generator the power flow holds at a limit is on it, not past it, so a
    power flow solved with limits enforced gives an empty list.
    """
    past: list[PastLimit] = []
    for group in _static_generators(ss):
        count = int(group.model.n)
        q = _values(group.model.q, count)
        qmin, qmax = _values(group.model.qmin, count), _values(group.model.qmax, count)
        on = _in_service(group.model, count)
        zl, zu = _flag(group.limiter, "zl", count), _flag(group.limiter, "zu", count)
        for i, device in enumerate(group.model.idx.v):
            if on[i] < _SET:
                continue
            if q[i] > qmax[i] + tolerance and zu[i] < _SET:
                past.append(PastLimit(group.name, device, "qmax"))
            elif q[i] < qmin[i] - tolerance and zl[i] < _SET:
                past.append(PastLimit(group.name, device, "qmin"))
    return past


def _flag(limiter: Any, name: str, count: int) -> np.ndarray:
    """A limiter flag as ``count`` floats (it is one element long before setup)."""
    raw = getattr(limiter, name, None)
    values = np.atleast_1d(np.asarray([] if raw is None else raw, dtype=float))
    return values if values.size == count else np.zeros(count)


def _past_limits_message(past: list[PastLimit]) -> str:
    n = len(past)
    shown = ", ".join(f"{p.model} {p.idx} past {p.limit}" for p in past[:8])
    if n > 8:
        shown = f"{shown} and {n - 8} more"
    return (
        f"The power flow this continuation starts from leaves {n} "
        f"generator{'s' if n != 1 else ''} past a reactive limit ({shown}), so holding "
        "generators to their limits would open the curve with a jump. Run the power flow "
        "with reactive limits enforced first, then the continuation."
    )


def _flag_state(groups: list[_Generators]) -> list[dict[str, Any]]:
    """A copy of every limiter's flags and counts."""
    state: list[dict[str, Any]] = []
    for group in groups:
        saved: dict[str, Any] = {}
        for name in _FLAGS:
            values = getattr(group.limiter, name, None)
            if values is not None:
                saved[name] = np.array(values, copy=True)
        for name in _COUNTS:
            if hasattr(group.limiter, name):
                saved[name] = getattr(group.limiter, name)
        state.append(saved)
    return state


def _restore_flag_state(groups: list[_Generators], state: list[dict[str, Any]]) -> None:
    for group, saved in zip(groups, state, strict=True):
        for name in _FLAGS:
            if name in saved:
                getattr(group.limiter, name)[:] = saved[name]
        for name in _COUNTS:
            if name in saved:
                setattr(group.limiter, name, saved[name])


def _same_flags(groups: list[_Generators], state: list[dict[str, Any]]) -> bool:
    """Whether every limiter still holds the generators ``state`` says it held."""
    for group, saved in zip(groups, state, strict=True):
        for name in ("zl", "zu"):
            if name in saved and not np.array_equal(getattr(group.limiter, name), saved[name]):
                return False
    return True


# ---- the generators along the path ------------------------------------------


@dataclass(frozen=True)
class _Point:
    """What was read when the routine kept a point."""

    voltages: np.ndarray
    q: list[np.ndarray]
    # Each generator's terminal voltage, per model.
    v: list[np.ndarray]
    zl: list[np.ndarray]
    zu: list[np.ndarray]
    # The generators (model position, device position) whose switch at a limit
    # the path could not get past from this point. Filled in after the point is
    # read, while the routine tries the steps that follow it.
    blocked: set[tuple[int, int]]


@dataclass(frozen=True)
class _Watch:
    """A generator switched at a limit during the run that has not yet moved away
    from the point where it switched."""

    # +1 held at ``qmax`` (its voltage may only fall), -1 held at ``qmin``.
    sign: float
    # The terminal voltage at the first point with the generator held.
    v_switch: float
    v0: float


class GeneratorPath:
    """The static generators at the points of a finished run, one entry per column
    of ``CPF.V``."""

    def __init__(self, ss: System, groups: list[_Generators], points: list[_Point]) -> None:
        self._groups = groups
        self._points = points
        try:
            self._mva = float(getattr(ss.config, "mva", 100.0)) or 100.0
        except (TypeError, ValueError):
            self._mva = 100.0

    def finite_steps(self) -> int:
        """How many leading points have a finite reactive output for every generator."""
        for k, point in enumerate(self._points):
            if not all(bool(np.all(np.isfinite(q))) for q in point.q):
                return k
        return len(self._points)

    def traces(
        self, lambdas: list[float], nose_idx: int
    ) -> tuple[list[CpfGeneratorTrace], list[CpfLimitEvent]]:
        """Each in-service generator's reactive output, in MVAr, at the points
        ``lambdas`` covers, and the first point at which each one is held at a limit.

        An event is ``at_nose`` when the nose (``nose_idx``, ``-1`` for none) is
        where that generator switched: the path could not get past the switch
        from the nose point, or lambda turned in the step that switched it or
        the one after. Its ``would_release_step`` is the first later point at
        which the generator's terminal voltage is back across its set-point, so
        that it would no longer be at the limit; ANDES holds it there all the
        same (see the module docstring).
        """
        points = self._points[: len(lambdas)]
        blocked = points[nose_idx].blocked if 0 <= nose_idx < len(points) else set()
        traces: list[CpfGeneratorTrace] = []
        events: list[CpfLimitEvent] = []
        for g, group in enumerate(self._groups):
            model = group.model
            count = int(model.n)
            on = _in_service(model, count)
            qmin, qmax = _values(model.qmin, count), _values(model.qmax, count)
            setpoint = _values(model.v0, count)
            bus_values = getattr(getattr(model, "bus", None), "v", None)
            buses = list(bus_values) if bus_values is not None else []
            for i, device in enumerate(model.idx.v):
                if on[i] < _SET:
                    continue
                bus = str(buses[i]) if i < len(buses) else ""
                traces.append(
                    CpfGeneratorTrace(
                        idx=str(device),
                        model=group.name,
                        bus=bus,
                        q=[float(point.q[g][i]) * self._mva for point in points],
                        q_min=_scaled(qmin[i], self._mva),
                        q_max=_scaled(qmax[i], self._mva),
                    )
                )
                for k, point in enumerate(points):
                    at_upper, at_lower = point.zu[g][i] > _SET, point.zl[g][i] > _SET
                    if at_upper or at_lower:
                        turned_here = k >= 1 and nose_idx >= 0 and k in {nose_idx, nose_idx + 1}
                        # A generator whose two limits are one has a fixed output
                        # and no side of the set-point to be on.
                        sign = 0.0 if qmax[i] <= qmin[i] else (1.0 if at_upper else -1.0)
                        events.append(
                            CpfLimitEvent(
                                step=k,
                                lam=lambdas[k],
                                idx=str(device),
                                model=group.name,
                                bus=bus,
                                limit="qmax" if at_upper else "qmin",
                                at_nose=turned_here or (g, i) in blocked,
                                would_release_step=next(
                                    (
                                        later
                                        for later in range(k, len(points))
                                        if (points[later].v[g][i] - setpoint[i]) * sign
                                        > VOLTAGE_PAST_SETPOINT
                                    ),
                                    None,
                                ),
                            )
                        )
                        break
        events.sort(key=lambda event: event.step)
        return traces, events


def _scaled(value: float, mva: float) -> float | None:
    return float(value) * mva if math.isfinite(float(value)) else None


class CpfRun:
    """One continuation run in progress: what it was asked for, and what it read."""

    def __init__(self, ss: System, *, enforce_q_limits: bool, stop_at: str) -> None:
        self.enforce_q_limits = enforce_q_limits
        self.stop_at = stop_at
        self._ss = ss
        self._groups = _static_generators(ss)
        self._points: list[_Point] = []
        self._accepted: list[dict[str, Any]] = _flag_state(self._groups)
        self._watch: dict[tuple[int, int], _Watch] = {}

    # -- the two methods of the routine that the run wraps --

    def _install(self, cpf: Any) -> None:
        read_voltages = cpf._bus_vmag  # noqa: SLF001 - contract 11

        def bus_vmag() -> Any:
            voltages = read_voltages()
            self._keep(voltages)
            return voltages

        cpf._bus_vmag = bus_vmag  # noqa: SLF001
        if not self.enforce_q_limits:
            return
        correct = cpf._corrector  # noqa: SLF001 - contract 11

        def corrector(
            lam: Any, xy_prev: Any, lam_prev: Any, step: Any, z: Any, dfg: Any
        ) -> tuple[bool, int, float]:
            result = correct(lam, xy_prev, lam_prev, step, z, dfg)
            if result[0] and float(step) > SWITCH_STEP and self._switched():
                result = self._place_switch(cpf, correct, xy_prev, lam_prev, float(step), z)
            if result[0]:
                blocked = self._moving_the_wrong_way()
                if not blocked:
                    return bool(result[0]), int(result[1]), float(result[2])
                if self._points:
                    self._points[-1].blocked.update(blocked)
            # The routine returns to the last point it kept; the limiters go back
            # to what they held there.
            _restore_flag_state(self._groups, self._accepted)
            return False, int(result[1]), float(result[2])

        cpf._corrector = corrector  # noqa: SLF001

    def _switched(self) -> bool:
        """Whether a limiter holds a generator it did not hold at the last point."""
        return not _same_flags(self._groups, self._accepted)

    def _place_switch(
        self, cpf: Any, correct: Any, xy_prev: Any, lam_prev: Any, step: float, z: Any
    ) -> tuple[bool, int, float]:
        """Find the first switch along a step that converged with one, by bisection.

        ``step`` took the path from the last point to one where a generator is
        held. Shorter steps along the same tangent are solved, each from the last
        point with the limiters as they were there, until a step with the switch
        and one without it are no more than :data:`SWITCH_STEP` apart. The System
        is left at the step with the switch, which is what the routine then
        keeps. A step that does not converge on the way is handed back as failed,
        and the routine halves its own step as it does for any other.
        """
        dae = self._ss.dae
        n, m = int(dae.n), int(dae.m)
        nm = n + m
        start = np.asarray(xy_prev, dtype=float)
        tangent = np.asarray(z, dtype=float)

        def attempt(length: float) -> tuple[bool, int, float]:
            _restore_flag_state(self._groups, self._accepted)
            predicted = start + length * tangent[:nm]
            dae.x[:n] = predicted[:n]
            dae.y[:m] = predicted[n:]
            self._ss.vars_to_models()
            lam = float(lam_prev) + length * float(tangent[nm])
            # The derivative with respect to lambda is taken with the limiters
            # still: one that switched between its two evaluations would put the
            # jump of a generator's equation into it.
            for group in self._groups:
                group.limiter.enable = False
            try:
                dfg = cpf._dfg_dlam(lam)  # noqa: SLF001 - contract 11
            finally:
                for group in self._groups:
                    group.limiter.enable = True
            success, niter, lam_new = correct(lam, start, lam_prev, length, tangent, dfg)
            return bool(success), int(niter), float(lam_new)

        free, held = 0.0, step
        at_held = False
        result: tuple[bool, int, float] = (False, 0, float(lam_prev))
        while held - free > SWITCH_STEP:
            middle = 0.5 * (free + held)
            result = attempt(middle)
            if not result[0]:
                return result
            at_held = self._switched()
            if at_held:
                held = middle
            else:
                free = middle
        if not at_held:
            result = attempt(held)
        return result

    def _moving_the_wrong_way(self) -> set[tuple[int, int]]:
        """The watched generators a converged step has taken to the wrong side.

        A generator held at ``qmax`` gives up its voltage, which can only sink
        below the set-point from there; one whose voltage rises above it would
        have to supply less than ``qmax``, and is not at its limit at all. When
        the step after a switch does that, the path has no way forward with the
        generator either holding its voltage (past the limit) or held at the
        limit (voltage on the wrong side): the switch is where lambda turns. The
        step is refused, so the routine finds no point beyond and calls the last
        one the nose.
        """
        wrong: set[tuple[int, int]] = set()
        for (g, i), watch in self._watch.items():
            model = self._groups[g].model
            voltage = float(_values(model.v, int(model.n))[i])
            moved = (voltage - watch.v_switch) * watch.sign
            past = (voltage - watch.v0) * watch.sign
            if moved > VOLTAGE_MOVE and past > VOLTAGE_MOVE:
                wrong.add((g, i))
        return wrong

    @staticmethod
    def _remove(cpf: Any) -> None:
        for name in ("_bus_vmag", "_corrector"):
            vars(cpf).pop(name, None)

    def _keep(self, voltages: Any) -> None:
        """Read the generators at a point the routine has just accepted."""
        point = _Point(
            voltages=np.array(voltages, dtype=float, copy=True),
            q=[_values(g.model.q, int(g.model.n)).copy() for g in self._groups],
            v=[_values(g.model.v, int(g.model.n)).copy() for g in self._groups],
            zl=[_flag(g.limiter, "zl", int(g.model.n)).copy() for g in self._groups],
            zu=[_flag(g.limiter, "zu", int(g.model.n)).copy() for g in self._groups],
            blocked=set(),
        )
        if self.enforce_q_limits and self._points:
            self._update_watch(self._points[-1], point)
        self._points.append(point)
        self._accepted = _flag_state(self._groups)

    def _update_watch(self, before: _Point, now: _Point) -> None:
        """Start watching the generators this point is the first to hold, and stop
        watching those whose voltage has moved clear of where they switched."""
        for g, group in enumerate(self._groups):
            count = int(group.model.n)
            voltage, setpoint = _values(group.model.v, count), _values(group.model.v0, count)
            for i in range(count):
                held_before = before.zu[g][i] > _SET or before.zl[g][i] > _SET
                at_upper, at_lower = now.zu[g][i] > _SET, now.zl[g][i] > _SET
                watch = self._watch.get((g, i))
                if (at_upper or at_lower) and not held_before:
                    self._watch[g, i] = _Watch(
                        sign=1.0 if at_upper else -1.0,
                        v_switch=float(voltage[i]),
                        v0=float(setpoint[i]),
                    )
                elif watch is not None and (
                    (watch.v_switch - float(voltage[i])) * watch.sign > VOLTAGE_MOVE
                ):
                    del self._watch[g, i]

    # -- after the run --

    def path(self, v_matrix: Any) -> GeneratorPath | None:
        """The generators at each column of ``CPF.V``, or ``None`` when the
        readings cannot be matched to the columns.

        The routine reads a point it then replaces (the refinement of the last
        one), so there can be one reading more than there are columns; each
        column is matched to the next reading that has its voltages.
        """
        try:
            matrix = np.asarray(v_matrix, dtype=float)
        except (TypeError, ValueError):
            return None
        if matrix.ndim != 2:
            return None
        matched: list[_Point] = []
        at = 0
        for k in range(matrix.shape[1]):
            column = matrix[:, k]
            while at < len(self._points) and not np.array_equal(
                self._points[at].voltages, column, equal_nan=True
            ):
                at += 1
            if at == len(self._points):
                return None
            matched.append(self._points[at])
            at += 1
        return GeneratorPath(self._ss, self._groups, matched)


@contextlib.contextmanager
def cpf_run_applied(
    ss: System,
    *,
    enforce_q_limits: bool | None = None,
    stop_at: str = "nose",
    step: float | None = None,
    max_steps: int | None = None,
) -> Iterator[CpfRun]:
    """Apply a request's continuation settings for one run and restore them after.

    Yields the run, which says whether limits are enforced (the request's
    setting, or the case's own where it gave none) and, once ``CPF.run`` has
    returned, gives the generators along the path. The caller validates the
    values (:func:`validate_cpf_options`) and checks that the power flow has
    converged first.

    Raises:
        CpfPrerequisiteError: limits are to be enforced and the solved power
            flow leaves a generator past one. Nothing has been written.
    """
    cpf = ss.CPF
    config = cpf.config
    groups = _static_generators(ss)
    enforce = (
        any(bool(g.limiter.enable) for g in groups)
        if enforce_q_limits is None
        else bool(enforce_q_limits)
    )
    if enforce:
        past = generators_past_limits(ss)
        if past:
            raise CpfPrerequisiteError(_past_limits_message(past))

    before_config = {name: getattr(config, name) for name in _CONFIG if hasattr(config, name)}
    before_limiters = [(g.limiter.enable, g.limiter.min_iter) for g in groups]
    before_flags = _flag_state(groups)
    run = CpfRun(ss, enforce_q_limits=enforce, stop_at=stop_at)
    try:
        # A factorisation kept from an earlier run belongs to the limits that run
        # started from, which a power flow since may have changed.
        solver = getattr(cpf, "solver", None)
        if solver is not None and hasattr(solver, "clear"):
            solver.clear()
        if step is not None:
            config.step = float(step)
        if max_steps is not None:
            config.max_steps = int(max_steps)
        config.stop_at = "FULL" if stop_at == "full" else "NOSE"
        for group in groups:
            group.limiter.enable = enforce
            if enforce:
                group.limiter.min_iter = 0
        if enforce:
            config.linsolve = 1
        run._install(cpf)  # noqa: SLF001
        yield run
    finally:
        run._remove(cpf)  # noqa: SLF001
        for name, value in before_config.items():
            setattr(config, name, value)
        for group, (enable, min_iter) in zip(groups, before_limiters, strict=True):
            group.limiter.enable = enable
            group.limiter.min_iter = min_iter
        # The routine puts the base case's variables back; the flags that go
        # with them are ours to put back.
        _restore_flag_state(groups, before_flags)


__all__ = [
    "BASE_MULTIPLE",
    "DIRECTIONS",
    "PAST_LIMIT_TOLERANCE",
    "STOP_AT",
    "SWITCH_STEP",
    "VOLTAGE_MOVE",
    "VOLTAGE_PAST_SETPOINT",
    "CpfRun",
    "GeneratorPath",
    "PastLimit",
    "cpf_run_applied",
    "direction_targets",
    "generators_past_limits",
    "validate_cpf_options",
]
