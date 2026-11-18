"""The type-3 wind turbine example case has one slowly growing mode, in the eigenvalues and in a run.

The catalog's entry for ``ieee14_wt3`` says so, and does not call the case stable. ANDES's
eigenvalue analysis of the case returns one real eigenvalue with a positive real part, 0.0713
per second (an e-folding time of 14 s), and the wind turbine's drive-train speed does move away
from its equilibrium at that rate once something disturbs it: the entry's numbers are this
test's. The growth is far too slow to show in a run of the length TENSA offers by default (the
speed has moved 3e-7 per unit after 10 s and 5e-5 after 80 s), and the run of the harness that checks the case does
not see it; but a reader who opens the Eigenvalues panel does, and should know that the mode is
in the simulation and not a leftover of the linearisation.

The test runs the case through ANDES itself, with a 2% step of the largest load at 0.5 s (the
disturbance of the harness's ring-down) and the line trip the file holds taken out. The solar
case, which has the same network and the same converter stack but no turbine, has no such mode.

Markers: ``integration``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from tensa.core.example_catalog import load_catalog
from tensa.core.examples import _andes_cases_dir

pytestmark = pytest.mark.integration

STATE = "s2_y WTDTA1 1"  # the drive train's second speed, the generator's
LOAD = "PQ_2"  # the load with the most power
STEP = 1.02
RUN = 80.0  # seconds; the growth is read from 50 s on


def _system(file: str, with_step: bool) -> Any:
    andes = pytest.importorskip("andes")
    cases = _andes_cases_dir()
    if cases is None:
        pytest.skip("ANDES's cases are not installed")
    # No ``andes.config_logger`` here: it puts the ``andes`` logger at DEBUG with two handlers for
    # every test that runs after this one, and ``tests/unit/test_messages.py`` reads that logger.
    ss = andes.load(str(cases / "ieee14" / file), setup=False, no_output=True, default_config=True)
    if with_step:
        # A load is a constant impedance in a time-domain run, which reads ``Req``.
        ss.add(
            "Alter",
            {"idx": "step", "model": "PQ", "dev": LOAD, "src": "Req", "attr": "v", "method": "*"}
            | {"amount": 1.0 / STEP, "t": 0.5},
        )
    ss.setup()
    ss.Toggle.u.v[:] = 0  # the trip and the reclose of Line_1 that the file holds
    ss.PFlow.run()
    return ss


def _largest_real_part(file: str) -> float:
    ss = _system(file, with_step=False)
    ss.EIG.run()
    return float(np.max(ss.EIG.mu.real))


def test_the_eigenvalue_analysis_returns_one_growing_real_mode() -> None:
    ss = _system("ieee14_wt3.xlsx", with_step=False)
    ss.EIG.run()
    growing = [m for m in ss.EIG.mu if m.real > 1e-3]
    assert len(growing) == 1
    assert growing[0].imag == 0.0
    assert growing[0].real == pytest.approx(0.0713, abs=0.0005)


def test_the_solar_case_has_no_such_mode() -> None:
    # Its largest real part is the zero eigenvalue and the 2e-9 that ANDES's own offset gives.
    assert _largest_real_part("ieee14_solar.xlsx") < 1e-6
    assert _largest_real_part("ieee14_full.xlsx") < 1e-6


def test_the_wind_turbine_speed_moves_away_from_its_equilibrium_at_the_rate_of_that_eigenvalue() -> (
    None
):
    eigenvalue = _largest_real_part("ieee14_wt3.xlsx")
    ss = _system("ieee14_wt3.xlsx", with_step=True)
    ss.TDS.config.tf = RUN
    ss.TDS.config.criteria = 0
    ss.TDS.run()
    assert ss.TDS.converged
    t = np.asarray(ss.dae.ts.t)
    x = np.asarray(ss.dae.ts.x)[:, list(ss.dae.x_name).index(STATE)]
    moved = np.abs(x - x[0])

    def at(seconds: float) -> float:
        return float(moved[np.searchsorted(t, seconds)])

    # Nothing of it shows in a run of the default length (3e-7 after 10 s), and by 80 s it is
    # a hundred times that.
    assert at(10.0) < 1e-6
    assert at(RUN) > 100 * at(10.0)
    # From 50 s on, once the oscillations have died away, the deviation is an exponential with
    # the rate of the eigenvalue (the entry quotes 0.0713 per second).
    late = (t >= 50.0) & (moved > 0)
    rate = float(np.polyfit(t[late], np.log(moved[late]), 1)[0])
    assert rate == pytest.approx(eigenvalue, rel=0.01)
    assert rate == pytest.approx(0.0713, abs=0.001)


def test_the_entry_does_not_call_the_case_stable_and_quotes_the_rate() -> None:
    entry = load_catalog().get("ieee14_wt3")
    assert entry is not None and entry.verification is not None
    caveat = next(c for c in entry.caveats if c.startswith("The case has a growing mode."))
    state, model = STATE.split(" ", 1)  # the entry says "state s2_y of WTDTA1 1"
    assert "0.0713" in caveat and f"state {state} of {model}" in caveat
    assert "growing mode" in entry.summary
    assert "not stable" in entry.verification.summary
