"""Which step a time-domain run is on when ANDES calls its per-step hook.

``TDS.run`` calls ``TDS.callpert(dae.t, system)`` at the top of every pass of
its loop, before it solves the step that ends at ``dae.t``. What the System
holds at that call is the solution of the step before, which ANDES stored (in
``dae.ts``) under the time that step ended at; the state at ``tf`` is solved
after the last call and no call sees it. A step ANDES has to retry with a
smaller size calls the hook again with the same state, and the first call of a
run holds what the run starts from, a step of no run: the initial values, or
the last step of the run it carries on.

Three things follow, and all live here.

**A record of the run** (the streamed rows, a batch run's ``traces``) cannot
take the System's values at a call and label them with that call's time: every
row would be one step late and the record would stop a step short of ``tf``.
:class:`StepClock` gives each call the time of the step solved since the call
before, if there is one, and is asked once more when ``TDS.run`` has returned,
for the step the run ended on. What comes out is one row per solved step under
the time ANDES itself stored it at, the same instants a controller samples at
(``tensa.core.tds_controllers``).

**What an event leaves in the arrays.** Between a step and the next call ANDES
applies the events due at the step's time, and one of them writes variables: a
fault that clears puts every algebraic variable but the bus angles back to what
it was before the fault, as the starting point for the step after. Read then,
the row of the instant a fault is cleared would show a network that has
recovered in full, one sample before it has begun to. ANDES has the step as it
solved it (``dae.ts``), and :func:`stored_step` puts that in place for as long
as the row is read.

**The step ANDES cannot take.** ANDES clips a step that would pass ``tf`` or an
event time, and compares by subtraction: steps that add up to a rounding error
short of that time (fifteen steps of 1/30 s towards 0.5 s) are not clipped, and
what is left is a last step of some 1e-17 s. The solver cannot take a step
shorter than about a nanosecond, so it shrinks the step until it gives up and
the run ends "not converged" on the time it was asked to reach.
:func:`land_on_time` lets the step about to be solved run that rounding error
further, onto the time itself.

The rules rest on how ANDES 2.0.0 runs its loop (contract 13 in
``server/ANDES_VERSIONS.md``).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Final

import numpy as np
from numpy.typing import NDArray

# Slack on the comparisons of times, which are sums of binary fractions. It is
# also the shortest time left before ``tf`` or an event that counts as a step of
# its own: ANDES's solver does not converge on a shorter one.
_EPS: Final = 1e-9


def solved_instant(t: float, system: Any) -> float:
    """The time of the solution ``system`` holds when the hook is called with
    ``t``: the step that ends at ``t`` is ``TDS.h`` long and not solved yet.

    The first call of a run from zero has ``t = 0`` with ``h`` already set, so
    this is below zero there.
    """
    return float(t) - float(getattr(system.TDS, "h", 0.0) or 0.0)


class StepClock:
    """Tells a run's record which solved step the System holds, and when.

    :meth:`hook` is called from the per-step hook and :meth:`end` once
    ``TDS.run`` has returned. Each answers with the time of a step this run
    has solved and the clock has not yet told of, or ``None``: the run's first
    call (nothing solved yet), a call for a step ANDES is retrying, a run that
    stopped on a step it could not solve.
    """

    def __init__(self) -> None:
        # The time the last call was made with, which is where the step ANDES
        # went on to solve ends, and the instant the System held at that call.
        self._target: float | None = None
        self._instant = 0.0

    def hook(self, t: float, system: Any) -> float | None:
        """What ``TDS.callpert(t, system)`` means for the record."""
        target = float(t)
        instant = solved_instant(target, system)
        solved: float | None = None
        if self._target is not None and instant > self._instant + _EPS:
            # ANDES stored the step under the very time it called the hook
            # with, so the label is that number and not one worked back to.
            solved = self._target
        self._target, self._instant = target, instant
        return solved

    def end(self, system: Any) -> float | None:
        """The step the run ended on, once ``TDS.run`` has returned: ``dae.t``
        less ``TDS.h`` is then where the System stands, whether the run reached
        ``tf`` (``h`` is zero), was stopped, or gave up on a step."""
        if self._target is None:
            return None  # the run took no step
        target, self._target = self._target, None
        instant = solved_instant(float(system.dae.t), system)
        if instant <= self._instant + _EPS:
            return None
        # The time the last call announced, unless a call was missed in between.
        return target if abs(target - instant) <= _EPS else instant


def _stored_arrays(
    system: Any, at: float
) -> tuple[NDArray[np.float64], NDArray[np.float64]] | None:
    """The states and the algebraic variables ANDES stored for the step at
    ``at``, or ``None`` when it did not keep that step whole: nothing is stored
    (``save_every``), only a selection is (an ``Output`` device), or the storage
    has been written out and emptied (``limit_store``). None of the three is
    ANDES's default."""
    dae = system.dae
    series = getattr(dae, "ts", None)
    found = []
    for name, live in (("_xs", dae.x), ("_ys", dae.y)):
        steps = getattr(series, name, None)
        kept = steps.get(at) if isinstance(steps, dict) else None
        if not isinstance(kept, np.ndarray) or kept.shape != np.shape(live):
            return None
        found.append(kept)
    return found[0], found[1]


@contextmanager
def stored_step(system: Any, at: float) -> Iterator[None]:
    """Have ``system`` hold the step ANDES stored under ``at`` while the block
    runs, when an event has written over it since (the module docstring says
    which does). The arrays are as the event left them afterwards, so the next
    step starts from what ANDES meant it to.

    Costs a comparison when the System still holds the step, which is every
    step but the one an event rewrote, and nothing is changed when ANDES did
    not keep the step: the row is then read from the arrays as they are.
    """
    stored = _stored_arrays(system, at)
    dae = system.dae
    if stored is None or (np.array_equal(stored[0], dae.x) and np.array_equal(stored[1], dae.y)):
        yield
        return
    left = (np.array(dae.x), np.array(dae.y))
    dae.x[:], dae.y[:] = stored
    system.vars_to_models()
    try:
        yield
    finally:
        dae.x[:], dae.y[:] = left
        system.vars_to_models()


def land_on_time(system: Any) -> None:
    """Let the step about to be solved end on ``tf`` or on the next event time
    when it would end a rounding error before it (the module docstring says
    what happens otherwise). Called from the hook, where ``dae.t`` is already
    the end of that step: both ``dae.t`` and ``TDS.h`` move by the difference.
    """
    tds = system.TDS
    end = float(system.dae.t)
    landing = float(tds.config.tf)
    switch_times = np.asarray(getattr(system, "switch_times", ()), dtype=np.float64)
    following = int(np.searchsorted(switch_times, end, side="right"))
    if following < len(switch_times):
        landing = min(landing, float(switch_times[following]))
    gap = landing - end
    if 0.0 < gap <= _EPS:
        system.dae.t += gap
        tds.h += gap


__all__ = ["StepClock", "land_on_time", "solved_instant", "stored_step"]
