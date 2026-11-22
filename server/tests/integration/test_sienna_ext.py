"""The ``ext.sienna`` dynamic components against the real Julia engine.

Marked ``sienna`` and ``integration``; skipped where the Sienna engine is not
available. The case is the shipped Kundur files in a temporary workspace.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tensa.core.disturbance import ToggleSpec
from tensa.core.errors import TdsRequestError
from tensa.core.examples import _andes_cases_dir
from tensa.engines.sienna.environment import sienna_unavailable_reason
from tensa.engines.sienna.ext import (
    DynamicBranchSpec,
    InverterSpec,
    SiennaExtSpec,
)
from tensa.engines.sienna.state import SiennaState

_REASON = sienna_unavailable_reason()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.sienna,
    pytest.mark.skipif(_REASON is not None, reason=f"the Sienna engine is not available: {_REASON}"),
]


def _series(payload: dict[str, Any]) -> dict[str, list[float | None]]:
    return {v["name"]: v["values"] for v in payload["traces"]["variables"]}


def _genrou_only(text: str, without_bus: int | None = None) -> str:
    """The GENROU records of a .dyr text (the Sienna engine refuses Kundur's
    EXDC2 exciters), less the one of ``without_bus`` when given."""
    records = [r.strip() for r in text.split("/") if r.strip()]
    kept = []
    for record in records:
        parts = record.replace(",", " ").split()
        if parts[1].strip("'") != "GENROU":
            continue
        if without_bus is not None and parts[0] == str(without_bus):
            continue
        kept.append(record)
    return "".join(f"{r} /\n" for r in kept)


@pytest.fixture(scope="module")
def workspace(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    cases = _andes_cases_dir()
    assert cases is not None
    ws = tmp_path_factory.mktemp("sienna-ext") / "ws"
    ws.mkdir(mode=0o700)
    (ws / "kundur.raw").write_bytes((cases / "kundur" / "kundur.raw").read_bytes())
    full = (cases / "kundur" / "kundur_full.dyr").read_text()
    (ws / "kundur_genrou.dyr").write_text(_genrou_only(full))
    (ws / "kundur_no_gen2.dyr").write_text(_genrou_only(full, without_bus=2))
    yield ws


def _state(workspace: Path, dyr: str = "kundur_genrou.dyr") -> SiennaState:
    state = SiennaState(str(workspace), "ext-test", None)
    state.load_case(workspace / "kundur.raw", addfiles=[workspace / dyr])
    result = state.run_pflow()
    assert result.converged is True
    return state


def _tripped(workspace: Path) -> SiennaState:
    """A Kundur state with circuit 7-8-2 tripped at 0.1 s: the event that
    excites the fast dynamics of its parallel circuit 7-8-1."""
    state = _state(workspace)
    entry = state.keys().entry_of("branch:7-8-2")
    assert entry is not None
    state.add_disturbance(ToggleSpec(model="Line", dev_idx=entry.idx, t=0.1))
    return state


def _at(t: list[float], y: list[float | None], when: float) -> float:
    """``y`` at the time ``when``, linear between the two rows around it.

    A run's rows are the solver's accepted steps, so two runs have rows at
    different times; an instant a disturbance acts at appears more than once,
    and the row taken there is the last one at or before ``when``."""
    i = bisect_right(t, when)
    assert 0 < i <= len(t)
    y0 = y[i - 1]
    assert y0 is not None
    if i == len(t) or t[i - 1] == when:
        return y0
    y1 = y[i]
    assert y1 is not None
    return y0 + (y1 - y0) * (when - t[i - 1]) / (t[i] - t[i - 1])


def test_dynamic_line_differs_early_agrees_late(workspace: Path) -> None:
    plain = _tripped(workspace).run_tds(tf=1.0, h=1 / 240)
    dynamic = _tripped(workspace).run_tds(
        tf=1.0,
        h=1 / 240,
        ext_sienna=SiennaExtSpec(dynamic_branches=[DynamicBranchSpec(target="branch:7-8-1")]),
    )
    assert plain["status"] == "completed" and plain["final_t"] == 1.0
    assert dynamic["status"] == "completed" and dynamic["final_t"] == 1.0
    # The rows are the solver's accepted steps, and the dynamic run resolves
    # the line's transient with steps of microseconds after the trip (327
    # rows against the plain run's 250 when this was written), so the two
    # are compared at the plain run's times, the dynamic run read between its
    # own rows. The trip's own instant is left out: each run has it more than
    # once, before and after the trip.
    t = plain["traces"]["t"]
    a = _series(plain)["voltage|bus:8"]
    t_dyn = dynamic["traces"]["t"]
    b = _series(dynamic)["voltage|bus:8"]
    gaps = [
        (ti, abs(x - _at(t_dyn, b, ti)))
        for ti, x in zip(t, a, strict=True)
        if x is not None and ti != 0.1
    ]
    before = [g for ti, g in gaps if ti < 0.1]
    early = [g for ti, g in gaps if 0.1 < ti <= 0.13]
    late = [g for ti, g in gaps if ti >= 0.5]
    assert before and early and late
    # Before the trip the two runs hold the same network, so the same steady
    # state (a dynamic line that changed the network would show here). PSID's
    # initialisation of the dynamic run meets its relaxed tolerance (1e-6)
    # but not its strict one (1e-9), so the run starts 1.2e-7 pu off the
    # power flow at bus 8 and settles within 2 ms: measured, the largest gap
    # before the trip is 1.19e-7, at t = 0. The dynamic branch adds states to
    # the line, so the milliseconds after the trip differ: measured, 2.8e-3
    # at most in 0.1 to 0.13 s (at 0.102 s). Its transient gives the rotors a
    # slightly different push, so the electromechanical swing that follows
    # differs a little, and the gap swings with it: measured, 4.7e-5 at most
    # from 0.5 s on (at 0.50 s), through zero near 0.92 s and 1e-5 at 0.99 s.
    # A static-line-equals-dynamic-line implementation fails the second
    # assertion.
    assert max(before) < 1e-6
    assert max(early) > 1e-6
    assert max(late) < 1e-4


def test_dynamic_line_adds_current_series(workspace: Path) -> None:
    payload = _state(workspace).run_tds(
        tf=1.0,
        h=1 / 240,
        ext_sienna=SiennaExtSpec(dynamic_branches=[DynamicBranchSpec(target="branch:7-8-1")]),
    )
    series = _series(payload)
    for name in ("i_from|branch:7-8-1", "i_to|branch:7-8-1"):
        values = series[name]
        assert len(values) == len(payload["traces"]["t"])
        assert all(v is not None and math.isfinite(v) for v in values)


def test_inverter_replaces_machine_runs_to_end(workspace: Path) -> None:
    # PowerSystems' PSS/E reader replaces a generator with no .dyr record by
    # a PSY.Source (a voltage source behind the record's ZSORCE), which PSID
    # holds as a static infinite bus, so without the ext the run completes.
    # PSID cannot put an inverter on a Source (its wrapper for one asks the
    # dynamic device for X_th), so the run's copy of the System gives the
    # inverter a ThermalStandard with the Source's dispatch in its place
    # (_generator_for_inverter! in TensaSiennaDyn.jl).
    assert _state(workspace, "kundur_no_gen2.dyr").run_tds(tf=1.0)["status"] == "completed"
    payload = _state(workspace, "kundur_no_gen2.dyr").run_tds(
        tf=1.0,
        ext_sienna=SiennaExtSpec(
            inverters=[InverterSpec(target="gen:2-1", parameter_set="gfl-omib")]
        ),
    )
    assert payload["status"] == "completed"
    assert payload["final_t"] == 1.0
    post = {v["name"]: v["values"] for v in payload["post"]["variables"]}
    for name in ("p|gen:2-1", "q|gen:2-1"):
        assert name in post
        assert all(v is not None and math.isfinite(v) for v in post[name])
    # The inverter starts from, and with nothing acting holds, the power
    # flow's dispatch of bus 2 (700 MW in kundur.raw): measured, within 1e-8
    # MW over the run.
    assert post["p|gen:2-1"][0] == pytest.approx(700.0, abs=1e-3)
    assert post["p|gen:2-1"][-1] == pytest.approx(700.0, abs=1e-3)


def test_inverter_unknown_set_refused(workspace: Path) -> None:
    spec = SiennaExtSpec(
        inverters=[InverterSpec(target="gen:2-1", parameter_set="nope")]
    )
    with pytest.raises(TdsRequestError) as excinfo:
        _state(workspace).run_tds(tf=1.0, ext_sienna=spec)
    assert str(excinfo.value) == (
        "ext.sienna: unknown inverter parameter set nope; the sets are gfl-omib, gfm-omib"
    )
