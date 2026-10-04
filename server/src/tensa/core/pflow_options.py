"""The settings one power-flow request can change, and how they reach ANDES.

ANDES keeps the solver's tolerance and iteration limit in ``ss.PFlow.config``
and the flat-start switch in ``ss.Bus.config``, both read while the solver runs.
Reactive-power limit enforcement (``pv2pq``) is different: the PV and Slack
models build their ``qlim`` limiter once, with ``enable`` copied from the config
at that moment, so writing ``PV.config.pv2pq`` to a loaded System does nothing.
The switch that works on a live System is the limiter's own ``enable``, and the
flags the limiter sets while it runs (``zl``, ``zu``, ``zi``, ``ql``, ``qu``)
stay where the last run left them when it is switched off, which would hold
generators at their limits in the next, unenforced, run.

:func:`pflow_options_applied` therefore writes the requested settings for the
length of one run and puts back what it found, and it starts every run with the
limiter flags cleared, so a result depends on the request alone and never on an
earlier run. A setting the request leaves out keeps the System's own value, which
is ANDES's default unless the case file's ``_config`` section says otherwise.
"""

from __future__ import annotations

import contextlib
import math
from collections.abc import Iterator
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from tensa.core.errors import PflowRequestError, short_repr

if TYPE_CHECKING:
    from andes.system import System

# The range of values a request may ask for. Below 1e-12 the mismatch cannot be
# reached in double precision on anything but a toy case, and above 1e-2 pu
# (1 MW on a 100 MVA base) a "converged" solution is not a solution. ANDES
# stops after ``max_iter + 1`` iterations, and 1000 is well past any case that
# is going to converge.
TOLERANCE_MIN = 1e-12
TOLERANCE_MAX = 1e-2
MAX_ITERATIONS_MIN = 1
MAX_ITERATIONS_MAX = 1000


@dataclass(frozen=True)
class PflowSettings:
    """The settings a power flow ran with, after the request was applied."""

    tolerance: float
    max_iterations: int
    flat_start: bool
    enforce_q_limits: bool


def validate_pflow_options(
    *,
    tolerance: object = None,
    max_iterations: object = None,
    flat_start: object = None,
    enforce_q_limits: object = None,
) -> None:
    """Refuse a power-flow setting ANDES would take and then misbehave on.

    ``None`` means the request leaves the setting alone. The REST body carries
    the same ranges as field constraints; the worker calls this too, so a value
    that did not come through the REST body is held to them.

    Raises:
        PflowRequestError: a value is outside its range or of the wrong type.
    """
    if tolerance is not None:
        in_range = False
        # ``bool`` is an ``int`` subclass; ``true`` is not a tolerance.
        if isinstance(tolerance, int | float) and not isinstance(tolerance, bool):
            with contextlib.suppress(OverflowError):  # an int too large for a float
                in_range = TOLERANCE_MIN <= float(tolerance) <= TOLERANCE_MAX
        if not in_range:
            raise PflowRequestError(
                f"tolerance must be a number from {TOLERANCE_MIN:g} to {TOLERANCE_MAX:g}, "
                f"got {short_repr(tolerance)}"
            )
    if max_iterations is not None and (
        isinstance(max_iterations, bool)
        or not isinstance(max_iterations, int)
        or not MAX_ITERATIONS_MIN <= max_iterations <= MAX_ITERATIONS_MAX
    ):
        raise PflowRequestError(
            f"max_iterations must be a whole number from {MAX_ITERATIONS_MIN} to "
            f"{MAX_ITERATIONS_MAX}, got {short_repr(max_iterations)}"
        )
    for name, value in (("flat_start", flat_start), ("enforce_q_limits", enforce_q_limits)):
        if value is not None and not isinstance(value, bool):
            raise PflowRequestError(f"{name} must be true or false, got {short_repr(value)}")


def q_limiters(ss: System) -> list[Any]:
    """The reactive-power limiters of the static generators (PV and Slack)."""
    found: list[Any] = []
    for model_name in ("PV", "Slack"):
        limiter = getattr(getattr(ss, model_name, None), "qlim", None)
        if limiter is not None and hasattr(limiter, "enable"):
            found.append(limiter)
    return found


def clear_q_limiters(limiters: list[Any]) -> None:
    """Put each limiter's flags back to "no generator at a limit"."""
    for limiter in limiters:
        for flag, value in (("zl", 0.0), ("zu", 0.0), ("zi", 1.0), ("ql", 0.0), ("qu", 0.0)):
            values = getattr(limiter, flag, None)
            if values is not None:
                values[:] = value
        # The count of flagged inputs, which the limiter keeps between iterations.
        for count in ("nql", "nqu"):
            if hasattr(limiter, count):
                setattr(limiter, count, 0)


def _finite(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


@contextlib.contextmanager
def pflow_options_applied(
    ss: System,
    *,
    tolerance: float | None = None,
    max_iterations: int | None = None,
    flat_start: bool | None = None,
    enforce_q_limits: bool | None = None,
) -> Iterator[PflowSettings]:
    """Apply a request's power-flow settings for one run and restore them after.

    Yields the settings the run uses: the request's where it gave one, the
    System's own where it did not. Everything written is put back on exit, so a
    setting is the request's for that run only. The limiter flags are the
    exception: a run that converged leaves them as the solution needs them (a
    time-domain run that follows starts from that solution), and a run that did
    not leaves them cleared. The caller validates the values
    (:func:`validate_pflow_options`) and sets the System up first.
    """
    pflow_config = ss.PFlow.config
    bus_config = ss.Bus.config
    limiters = q_limiters(ss)
    before = (
        pflow_config.tol,
        pflow_config.max_iter,
        bus_config.flat_start,
        [limiter.enable for limiter in limiters],
    )
    try:
        if tolerance is not None:
            pflow_config.tol = float(tolerance)
        if max_iterations is not None:
            pflow_config.max_iter = int(max_iterations)
        if flat_start is not None:
            bus_config.flat_start = 1 if flat_start else 0
        if enforce_q_limits is not None:
            for limiter in limiters:
                limiter.enable = bool(enforce_q_limits)
        clear_q_limiters(limiters)
        yield PflowSettings(
            tolerance=_finite(pflow_config.tol, 1e-6),
            max_iterations=int(_finite(pflow_config.max_iter, 25)),
            flat_start=bool(bus_config.flat_start),
            enforce_q_limits=any(bool(limiter.enable) for limiter in limiters),
        )
    finally:
        pflow_config.tol, pflow_config.max_iter, bus_config.flat_start = before[:3]
        for limiter, enable in zip(limiters, before[3], strict=True):
            limiter.enable = enable
        if not bool(getattr(ss.PFlow, "converged", False)):
            clear_q_limiters(limiters)
