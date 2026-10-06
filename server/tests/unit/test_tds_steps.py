"""The step a time-domain run is on when ANDES calls its hook.

``tensa.core.tds_steps`` works from three numbers ANDES keeps while it runs
(``dae.t``, ``TDS.h``, ``TDS.config.tf``) and the event times. The loop below
is ``TDS.run`` of ANDES 2.0.0 reduced to what moves them, with a solver that
is scripted: it marks the System with the time ANDES stores each solved step
under, which is what a row of the record has to be labelled with. The
integration tests (``tests/integration/test_tds_record_times.py``) hold the
same against ANDES itself.
"""

from __future__ import annotations

from collections.abc import Collection
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core.tds_steps import StepClock, land_on_time, solved_instant, stored_step

pytestmark = pytest.mark.unit

# The shortest step the scripted solver takes. ANDES's own gives up between
# 1e-8 s and 1e-10 s (measured on IEEE 14).
_SHORTEST_STEP = 1e-9


def _system(tf: float, step: float, *, start: float = 0.0, events: Collection[float] = ()) -> Any:
    """What the hook is handed: the clock, the step, and the solution's label."""
    return SimpleNamespace(
        dae=SimpleNamespace(t=np.array(start)),
        TDS=SimpleNamespace(
            h=0.0, deltat=step, busted=False, callpert=None, config=SimpleNamespace(tf=tf)
        ),
        switch_times=np.array(sorted(events), dtype=float),
        # The time ANDES stored the solution the System holds under.
        holds=start,
        stored=[],
    )


def _calc_h(system: Any) -> None:
    """``TDS.calc_h``: the step, clipped at ``tf`` and at the next event time."""
    tds, now = system.TDS, float(system.dae.t)
    tds.h = max(min(tds.deltat, tds.config.tf - now), 0.0)
    later = [s for s in system.switch_times if s > now]
    if later and now + tds.h > later[0]:
        tds.h = later[0] - now


def _run(system: Any, *, failing: Collection[int] = ()) -> None:
    """``TDS.run``: ``failing`` are the calls (counted from 0) whose step the
    solver does not converge on, besides any step shorter than it can take."""
    tds, dae = system.TDS, system.dae
    _calc_h(system)
    if float(dae.t) > 0:  # ``init_resume``
        dae.t += tds.h
    call = 0
    while float(dae.t) - tds.h < tds.config.tf and not tds.busted:
        tds.callpert(dae.t, system)
        solved = call not in failing and tds.h >= _SHORTEST_STEP
        call += 1
        if solved:
            system.holds = float(dae.t)
            system.stored.append(float(dae.t))
            _calc_h(system)
            dae.t += tds.h
        else:
            dae.t -= tds.h
            tds.deltat *= 0.5
            if tds.deltat < _SHORTEST_STEP:
                tds.deltat = 0.0
            _calc_h(system)
            if tds.h == 0:
                tds.busted = True
                break
            dae.t += tds.h


def _record(
    system: Any,
    *,
    landing: bool = True,
    stop_at_call: int | None = None,
    failing: Collection[int] = (),
) -> list[tuple[float, float]]:
    """Run with the hook the worker installs; return ``(label, what the System held)``."""
    clock = StepClock()
    rows: list[tuple[float, float]] = []
    calls = 0

    def hook(t: Any, system: Any) -> None:
        nonlocal calls
        if landing:
            land_on_time(system)
        if stop_at_call is not None and calls >= stop_at_call:
            system.TDS.busted = True
        calls += 1
        at = clock.hook(t, system)
        if at is not None:
            rows.append((at, system.holds))

    system.TDS.callpert = hook
    _run(system, failing=failing)
    at = clock.end(system)
    if at is not None:
        rows.append((at, system.holds))
    return rows


def test_a_row_is_labelled_with_the_time_andes_stored_its_step_under() -> None:
    system = _system(tf=1.0, step=0.25)
    rows = _record(system)
    assert [label for label, _ in rows] == [0.0, 0.25, 0.5, 0.75, 1.0]
    assert all(label == held for label, held in rows)
    assert [label for label, _ in rows] == system.stored


def test_the_hook_s_own_time_is_one_step_ahead_of_what_the_system_holds() -> None:
    """What the fix is for: the values at a call are the step before."""
    system = _system(tf=1.0, step=0.25)
    seen: list[tuple[float, float, float]] = []
    system.TDS.callpert = lambda t, s: seen.append((float(t), s.holds, solved_instant(t, s)))
    _run(system)
    # The first call holds what the run starts from; every later one the step before.
    assert [(t, held) for t, held, _ in seen] == [
        (0.0, 0.0), (0.25, 0.0), (0.5, 0.25), (0.75, 0.5), (1.0, 0.75)
    ]
    assert [instant for _, _, instant in seen[1:]] == [0.0, 0.25, 0.5, 0.75]
    assert seen[0][2] == -0.25


def test_the_record_ends_on_tf_which_no_call_of_the_hook_sees() -> None:
    system = _system(tf=0.6, step=0.25)
    rows = _record(system)
    assert rows[-1] == (0.6, 0.6)
    assert system.holds == 0.6


def test_a_run_that_carries_on_starts_after_the_step_the_last_one_ended_on() -> None:
    system = _system(tf=0.5, step=0.25)
    first = _record(system)
    system.TDS.config.tf = 1.0
    second = _record(system)
    assert [label for label, _ in first] == [0.0, 0.25, 0.5]
    assert [label for label, _ in second] == [0.75, 1.0]
    assert all(label == held for label, held in second)


def test_a_step_andes_retries_is_one_row() -> None:
    system = _system(tf=1.0, step=0.25)
    rows = _record(system, failing={2, 3})
    labels = [label for label, _ in rows]
    assert labels == system.stored
    assert all(label == held for label, held in rows)
    assert labels == sorted(set(labels))
    # The step after 0.25 was halved twice before it was taken.
    assert labels[:3] == [0.0, 0.25, 0.3125]
    assert labels[-1] == 1.0


def test_a_run_that_gives_up_ends_on_the_last_step_it_solved() -> None:
    system = _system(tf=1.0, step=0.25)
    rows = _record(system, failing=set(range(2, 99)))
    assert system.TDS.busted
    assert rows == [(0.0, 0.0), (0.25, 0.25)]


def test_a_run_stopped_from_the_hook_keeps_the_step_andes_still_solves() -> None:
    """Setting ``busted`` in the hook does not stop the step that call announced."""
    system = _system(tf=1.0, step=0.25)
    rows = _record(system, stop_at_call=2)
    assert system.stored == [0.0, 0.25, 0.5]
    assert rows == [(0.0, 0.0), (0.25, 0.25), (0.5, 0.5)]


def test_the_end_tells_the_step_s_time_even_when_a_call_was_missed() -> None:
    """A hook that returns early on a stop request never reaches the clock."""
    system = _system(tf=1.0, step=0.25)
    clock = StepClock()
    rows: list[tuple[float, float]] = []
    calls = 0

    def hook(t: Any, system: Any) -> None:
        nonlocal calls
        calls += 1
        if calls == 3:
            system.TDS.busted = True
            return
        at = clock.hook(t, system)
        if at is not None:
            rows.append((at, system.holds))

    system.TDS.callpert = hook
    _run(system)
    at = clock.end(system)
    assert at is not None
    rows.append((at, system.holds))
    # The step the missed call would have told of is not in the record, and
    # the last one is under its own time, not under that one's.
    assert rows == [(0.0, 0.0), (0.5, 0.5)]


def test_a_run_that_takes_no_step_has_no_row() -> None:
    system = _system(tf=0.5, step=0.25, start=0.5)
    assert _record(system) == []


def test_the_end_tells_nothing_twice() -> None:
    system = _system(tf=0.5, step=0.25)
    clock = StepClock()
    system.TDS.callpert = clock.hook
    _run(system)
    assert clock.end(system) == 0.5
    assert clock.end(system) is None


# ---- what an event leaves in the arrays ----------------------------------------------


class _Arrays:
    """A System as far as ``stored_step`` goes: the live arrays, what ANDES
    stored per step, and a count of the copies to the models."""

    def __init__(self, x: list[float], y: list[float]) -> None:
        self.dae = SimpleNamespace(
            x=np.array(x), y=np.array(y), ts=SimpleNamespace(_xs={}, _ys={})
        )
        self.copies: list[tuple[list[float], list[float]]] = []

    def store(self, at: float) -> None:
        self.dae.ts._xs[at] = np.array(self.dae.x)
        self.dae.ts._ys[at] = np.array(self.dae.y)

    def vars_to_models(self) -> None:
        self.copies.append((self.dae.x.tolist(), self.dae.y.tolist()))

    def live(self) -> tuple[list[float], list[float]]:
        return self.dae.x.tolist(), self.dae.y.tolist()


def test_a_step_an_event_wrote_over_is_read_as_andes_stored_it() -> None:
    system = _Arrays(x=[1.0, 2.0], y=[0.01, 0.02, 0.03])
    system.store(0.6)
    # A fault that clears puts the voltages back to what they were before it.
    system.dae.y[1:] = [1.02, 1.03]
    x_live, y_live = system.dae.x, system.dae.y

    with stored_step(system, 0.6):
        assert system.live() == ([1.0, 2.0], [0.01, 0.02, 0.03])
        # The models hold it too, which is where most of a row is read from.
        assert system.copies == [([1.0, 2.0], [0.01, 0.02, 0.03])]

    # The next step starts from what the event left, in the same arrays.
    assert system.live() == ([1.0, 2.0], [0.01, 1.02, 1.03])
    assert system.copies[-1] == ([1.0, 2.0], [0.01, 1.02, 1.03])
    assert system.dae.x is x_live and system.dae.y is y_live


def test_the_arrays_are_put_back_when_the_reading_raises() -> None:
    system = _Arrays(x=[1.0], y=[0.5])
    system.store(0.6)
    system.dae.y[0] = 1.0
    with pytest.raises(RuntimeError, match="reader"), stored_step(system, 0.6):
        raise RuntimeError("reader failed")
    assert system.live() == ([1.0], [1.0])
    assert len(system.copies) == 2


def test_a_step_the_system_still_holds_costs_no_copy() -> None:
    system = _Arrays(x=[1.0, 2.0], y=[0.5])
    system.store(0.25)
    with stored_step(system, 0.25):
        assert system.live() == ([1.0, 2.0], [0.5])
    assert system.copies == []


@pytest.mark.parametrize("case", ["not stored", "another step", "a selection", "written out"])
def test_a_step_andes_did_not_keep_whole_is_read_from_the_arrays_as_they_are(case: str) -> None:
    system = _Arrays(x=[1.0, 2.0], y=[0.5, 0.6])
    if case == "another step":
        system.store(0.5)
    elif case == "a selection":
        # An ``Output`` device: ANDES stores the variables it selects, not all.
        system.dae.ts._xs[0.6] = np.array([1.0])
        system.dae.ts._ys[0.6] = np.array([0.5])
    elif case == "written out":
        del system.dae.ts
    system.dae.y[1] = 1.0
    with stored_step(system, 0.6):
        assert system.live() == ([1.0, 2.0], [0.5, 1.0])
    assert system.copies == []


# ---- the step ANDES cannot take ------------------------------------------------------


def test_steps_that_add_up_a_rounding_error_short_of_tf_leave_a_step_andes_cannot_take() -> None:
    """Fifteen steps of 1/30 s end at 0.49999999999999994: without help the run
    is left a step of 5.6e-17 s, shrinks it to nothing and gives up."""
    system = _system(tf=0.5, step=1 / 30)
    rows = _record(system, landing=False)
    assert system.TDS.busted
    assert rows[-1][0] == pytest.approx(0.5)
    assert rows[-1][0] != 0.5
    assert float(system.dae.t) != 0.5


def test_the_last_step_lands_on_tf() -> None:
    system = _system(tf=0.5, step=1 / 30)
    rows = _record(system)
    assert not system.TDS.busted
    assert float(system.dae.t) == 0.5
    assert len(rows) == 16
    assert rows[-1] == (0.5, 0.5)
    assert all(label == held for label, held in rows)


def test_a_step_lands_on_the_event_time_it_would_end_a_rounding_error_before() -> None:
    """ANDES applies an event when ``dae.t`` equals its time, and clips a step
    that would pass it; one that ends an ulp short of it does neither."""
    system = _system(tf=0.9, step=1 / 30, events=[0.5, 0.5001])
    without = _record(_system(tf=0.9, step=1 / 30, events=[0.5, 0.5001]), landing=False)
    assert 0.5 not in [label for label, _ in without]

    rows = _record(system)
    labels = [label for label, _ in rows]
    assert not system.TDS.busted
    assert 0.5 in labels and 0.5001 in labels
    assert labels[-1] == 0.9
    assert labels == system.stored


def test_a_step_that_ends_well_before_tf_is_left_alone() -> None:
    system = _system(tf=1.0, step=0.25)
    system.dae.t += 0.75
    system.TDS.h = 0.25
    land_on_time(system)
    assert (float(system.dae.t), system.TDS.h) == (0.75, 0.25)

    # A microsecond is a step ANDES takes.
    system.dae.t += 0.25 - 1e-6
    land_on_time(system)
    assert float(system.dae.t) == pytest.approx(1.0 - 1e-6)
    assert float(system.dae.t) != 1.0


def test_landing_moves_the_step_and_the_clock_together() -> None:
    system = _system(tf=0.5, step=1 / 30)
    system.dae.t += 0.5 - 2e-16
    system.TDS.h = 1 / 30
    before = solved_instant(system.dae.t, system)
    land_on_time(system)
    assert float(system.dae.t) == 0.5
    assert system.TDS.h > 1 / 30
    assert solved_instant(system.dae.t, system) == pytest.approx(before, abs=1e-15)


def test_a_system_without_events_lands_on_tf_alone() -> None:
    system = _system(tf=0.5, step=1 / 30)
    del system.switch_times
    system.dae.t += 0.5 - 2e-16
    system.TDS.h = 1 / 30
    land_on_time(system)
    assert float(system.dae.t) == 0.5
