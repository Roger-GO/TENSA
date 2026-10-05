"""What the element builder fills in, checks and says about an ESD1 battery.

``ESD1`` is ANDES's distributed energy storage model: the ``PVD1`` converter with a
state of charge. It stands in for a static generator on its bus when a time-domain
run starts (``gen``), starts from that generator's power-flow output times
``gammap`` and ``gammaq`` (a negative active power charges it), and integrates what
it delivers into the state of charge, the state ``pIG_y``::

    d(SOC)/dt = -P / (EtaD * En * Tf)    discharging, P > 0
    d(SOC)/dt = -P * EtaC / (En * Tf)    charging, P < 0

per hour, with ``P`` the delivered power in MW and ``En`` in MWh. Discharging stops
at ``SOCmin`` and charging at ``SOCmax``.

ANDES takes any value for these at ``add()``. A zero ``En``, ``EtaD`` or ``Tf``
then makes the first time-domain step singular, a ``pqflag`` other than 0 or 1
fails ``setup()``, a ``gen`` that names no static generator fails when the
time-domain run starts, a nominal frequency outside ``ft1`` to ``ft2`` leaves the
battery tripped from the first step, and a ``SOCinit`` outside ``SOCmin`` to
``SOCmax`` is simulated as given. :func:`prepare_add` and :func:`check_edit`
refuse these where they are entered, each with the reason.

**Two per-unit bases.** ANDES reads the limits ``pmx``, ``qmx``, ``qmn`` and
``ialim`` (and the gains ``ddn`` and ``dqdv``) per unit of the device rating
``Sn``, and the set-point and the output per unit of the system base, which is
also the power the state of charge integrates. With ``Sn`` at half the system
base, ``pmx = 1`` caps the output at 0.5 pu and a set-point of 0.4 pu is 0.8 of
the rating. The megawatts and the state of charge are right either way, but the
same number is a different power on each side, so a study that sizes the battery
in per unit is off by the ratio of the bases. With ``Sn`` equal to the system base
the two read alike. An add that leaves ``Sn`` out therefore gets the system base
(ANDES's own default is 100 MVA whatever the base), and an add or edit that sets
another value is accepted and answered with a warning on the ``tensa.notice``
logger, which the message capture puts in the session's Messages log. A different
``Sn`` stays a choice a case may make: ANDES's bundled ``ieee14_esd1.xlsx`` rates
its ten batteries at 1 MVA on a 100 MVA base.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Collection, Mapping
from typing import Any, Final

from tensa.core.errors import ElementValidationError, short_repr
from tensa.core.messages import NOTICE_LOGGER

MODEL: Final = "ESD1"

_log = logging.getLogger(NOTICE_LOGGER)

Values = Mapping[str, float]


def _number(name: str, value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ElementValidationError(
            f"ESD1 param {name!r} must be a number; got {short_repr(value)}"
        ) from exc
    if not math.isfinite(number):
        raise ElementValidationError(
            f"ESD1 param {name!r} must be a finite number; got {short_repr(value)}"
        )
    return number


def _rated(v: Values) -> str | None:
    if v["Sn"] > 0.0:
        return None
    return (
        f"ESD1 Sn must be above zero; got {v['Sn']:g}. It is the rating the limits "
        "pmx, qmx, qmn and ialim are per unit of."
    )


def _priority(v: Values) -> str | None:
    if v["pqflag"] in (0.0, 1.0):
        return None
    return (
        f"ESD1 pqflag must be 0 (reactive power has priority at the current limit) "
        f"or 1 (active power has priority); got {v['pqflag']:g}."
    )


def _power_limit(v: Values) -> str | None:
    if v["pmx"] >= 0.0:
        return None
    return (
        f"ESD1 pmx must not be negative; got {v['pmx']:g}. The battery discharges "
        "up to pmx and charges down to -pmx."
    )


def _energy(v: Values) -> str | None:
    if v["En"] > 0.0:
        return None
    return (
        f"ESD1 En must be above zero; got {v['En']:g}. The state of charge moves by "
        "the delivered MW over En (MWh) each hour."
    )


def _integrator(v: Values) -> str | None:
    if v["Tf"] > 0.0:
        return None
    return (
        f"ESD1 Tf must be above zero; got {v['Tf']:g}. It divides the rate of the "
        "state of charge, and 1 gives the rate En implies."
    )


def _efficiency(name: str, what: str) -> Callable[[Values], str | None]:
    def rule(v: Values) -> str | None:
        if 0.0 < v[name] <= 1.0:
            return None
        return (
            f"ESD1 {name} must be above 0 and at most 1; got {v[name]:g}. It is the "
            f"{what} efficiency."
        )

    return rule


def _soc_window(v: Values) -> str | None:
    if 0.0 <= v["SOCmin"] < v["SOCmax"] <= 1.0:
        return None
    return (
        "ESD1 needs 0 <= SOCmin < SOCmax <= 1; got "
        f"SOCmin={v['SOCmin']:g}, SOCmax={v['SOCmax']:g}."
    )


def _soc_start(v: Values) -> str | None:
    if v["SOCmin"] <= v["SOCinit"] <= v["SOCmax"]:
        return None
    return (
        f"ESD1 SOCinit must lie between SOCmin and SOCmax; got SOCinit={v['SOCinit']:g} "
        f"with SOCmin={v['SOCmin']:g}, SOCmax={v['SOCmax']:g}."
    )


def _rising(what: str, names: tuple[str, ...]) -> Callable[[Values], str | None]:
    def rule(v: Values) -> str | None:
        for low, high in zip(names, names[1:], strict=False):
            if v[low] < v[high]:
                continue
            return (
                f"ESD1 {what} trip points must rise, {' < '.join(names)}; got "
                f"{low}={v[low]:g} and {high}={v[high]:g}."
            )
        return None

    return rule


def _nominal_frequency(v: Values) -> str | None:
    if v["ft1"] <= v["fn"] <= v["ft2"]:
        return None
    return (
        f"ESD1 fn={v['fn']:g} Hz is outside ft1 to ft2 ({v['ft1']:g} to {v['ft2']:g} Hz), "
        "so the battery would be tripped from the start of a run. Set ft0 to ft3 "
        "around fn: left out, they are ANDES's values for 60 Hz."
    )


# Each rule with the params it reads. A rule runs when the device holds all of
# them and, on an edit, when the edit changes one of them.
_RULES: Final[tuple[tuple[tuple[str, ...], Callable[[Values], str | None]], ...]] = (
    (("Sn",), _rated),
    (("pqflag",), _priority),
    (("pmx",), _power_limit),
    (("En",), _energy),
    (("Tf",), _integrator),
    (("EtaC",), _efficiency("EtaC", "charging")),
    (("EtaD",), _efficiency("EtaD", "discharging")),
    (("SOCmin", "SOCmax"), _soc_window),
    (("SOCmin", "SOCinit", "SOCmax"), _soc_start),
    (("vt0", "vt1", "vt2", "vt3"), _rising("voltage", ("vt0", "vt1", "vt2", "vt3"))),
    (("ft0", "ft1", "ft2", "ft3"), _rising("frequency", ("ft0", "ft1", "ft2", "ft3"))),
    (("fn", "ft1", "ft2"), _nominal_frequency),
)

# Every param a rule reads.
CHECKED_PARAMS: Final[tuple[str, ...]] = tuple(
    dict.fromkeys(name for names, _ in _RULES for name in names)
)


def check_values(values: Mapping[str, Any], changed: Collection[str] | None = None) -> None:
    """Refuse the values of an ESD1 that a time-domain run cannot use.

    ``values`` is what the device would hold: for an add the request's params
    over ANDES's defaults, for an edit the changes over what it holds now. A
    param that is absent or ``None`` is not checked (ANDES names a mandatory
    one that is missing). ``changed`` limits the rules to those reading one of
    these params, so an edit is never refused for a value it did not touch.

    Raises :class:`ElementValidationError` with the first problem found.
    """
    numbers = {
        name: _number(name, values[name])
        for name in CHECKED_PARAMS
        if values.get(name) is not None
    }
    for names, rule in _RULES:
        if changed is not None and not any(name in changed for name in names):
            continue
        if not all(name in numbers for name in names):
            continue
        problem = rule(numbers)
        if problem is not None:
            raise ElementValidationError(problem)


def _same(a: Any, b: Any) -> bool:
    return str(a) == str(b)


def check_link(ss: Any, bus: Any, gen: Any) -> None:
    """Refuse an ESD1 whose ``gen`` is not a static generator on its ``bus``.

    The battery takes over that generator's power-flow output, so a ``gen``
    that names none fails when the time-domain run starts, and one on another
    bus starts the run from an operating point the power flow did not solve.
    A missing ``bus`` or ``gen`` is left for ANDES to name.
    """
    if bus is None or gen is None:
        return
    bus_idx = getattr(getattr(getattr(ss, "Bus", None), "idx", None), "v", None) or []
    if not any(_same(bus, known) for known in bus_idx):
        raise ElementValidationError(f"ESD1 bus={short_repr(bus)} names no bus of the case.")
    static: Any = getattr(ss, "StaticGen", None)
    known_gens = list(static.get_all_idxes()) if static is not None else []
    native = next((known for known in known_gens if _same(gen, known)), None)
    if static is None or native is None:
        raise ElementValidationError(
            f"ESD1 gen={short_repr(gen)} names no static generator. The battery takes "
            "over a PV or Slack generator on its bus when a time-domain run starts, "
            "and starts at that generator's power-flow output; add one first."
        )
    # Read from the generator's own model: the group's ``get`` answers with a
    # float array, which turns bus 7 into 7.0.
    gen_model = static.idx2model(native)
    gen_bus = gen_model.bus.v[gen_model.idx2uid(native)]
    if not _same(gen_bus, bus):
        raise ElementValidationError(
            f"ESD1 is on bus {bus} but its static generator {native} is on bus "
            f"{gen_bus}. The battery takes over that generator's power-flow output, "
            "so the two must be on the same bus."
        )


def _defaults(ss: Any) -> dict[str, Any]:
    """ANDES's default of every checked param that has one (``pqflag`` has none)."""
    model = getattr(ss, MODEL, None)
    return {
        name: getattr(getattr(model, name, None), "default", None)
        for name in CHECKED_PARAMS
    }


def prepare_add(ss: Any, params: dict[str, Any], base_mva: float | None) -> None:
    """Fill in and check the params of an ESD1 about to be added, in place.

    ``Sn`` left out becomes the system base (see the module docstring). The
    values are then checked over ANDES's defaults, and ``gen`` against the
    static generators of the case.
    """
    if params.get("Sn") is None and base_mva is not None:
        params["Sn"] = base_mva
    given = {name: value for name, value in params.items() if value is not None}
    check_values({**_defaults(ss), **given})
    check_link(ss, params.get("bus"), params.get("gen"))


def check_edit(ss: Any, position: int, edits: Mapping[str, Any]) -> None:
    """Check an edit of the ESD1 at ``position`` against what the device holds."""
    model = getattr(ss, MODEL, None)
    held: dict[str, Any] = {}
    for name in (*CHECKED_PARAMS, "bus", "gen"):
        values = getattr(getattr(model, name, None), "v", None)
        if values is not None and position < len(values):
            held[name] = values[position]
    merged = {**held, **edits}
    check_values(merged, changed=set(edits))
    if "bus" in edits or "gen" in edits:
        check_link(ss, merged.get("bus"), merged.get("gen"))


def base_notice(idx: Any, sn: Any, base_mva: float | None) -> str | None:
    """The warning for an ESD1 rated on another base than the system's, else ``None``."""
    try:
        rating = float(sn)
    except (TypeError, ValueError):
        return None
    if base_mva is None or not math.isfinite(rating) or math.isclose(rating, base_mva):
        return None
    return (
        f"ESD1 {idx} has Sn = {rating:g} MVA on a system base of {base_mva:g} MVA. Its "
        "limits (pmx, qmx, qmn, ialim) are per unit of Sn, while its set-point and "
        "its output are per unit of the system base, so the same number is a "
        f"different power on each side. Set Sn to {base_mva:g} MVA for them to agree."
    )


def log_base_notice(idx: Any, sn: Any, base_mva: float | None) -> None:
    """Say so when an ESD1 just added or edited is rated on another base."""
    text = base_notice(idx, sn, base_mva)
    if text is not None:
        _log.warning(text)
