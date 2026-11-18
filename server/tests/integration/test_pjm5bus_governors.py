"""The governors of the PJM 5-bus example case do nothing in ANDES 2.0.0.

The catalog's entry for the case says so, and its independent reference (the swing equations of
classical machines with a constant mechanical power) rests on it. Each machine has a ``TG2``
governor, whose speed input goes through a dead band block that ANDES leaves disabled
(``TG2.config.deadband`` is 0). A disabled ``DeadBandRT`` holds its flags at "inside the band",
so the input of the governor is zero whatever the speed does, and the mechanical power stays where
the power flow put it. With the dead band enabled the governors act.

These tests run the case through ANDES itself: TENSA does not expose the configuration option, so
the case is loaded with it set. A step of the 400 MW load at bus 4 by half again, at 1 s, is the
scenario the catalog's numbers are for. Should ANDES change this, the entry's caveat and the
checks that compare the case with the classical model need to change with it.

Markers: ``integration``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from tensa.core.example_catalog import load_catalog
from tensa.core.examples import _andes_cases_dir

pytestmark = pytest.mark.integration

LOAD = 2  # idx of PQ 3, the 400 MW load, which stands at bus 4
STEP = 1.5  # the load rises by half
AT = 1.0


def _run(deadband: int) -> tuple[Any, np.ndarray, np.ndarray]:
    """Load the case, step the load, run 10 s: the system, the speeds and the governor outputs."""
    andes = pytest.importorskip("andes")
    cases = _andes_cases_dir()
    if cases is None:
        pytest.skip("ANDES's cases are not installed")
    # No ``andes.config_logger`` here: it puts the ``andes`` logger at DEBUG with two handlers for
    # every test that runs after this one, and ``tests/unit/test_messages.py`` reads that logger.
    ss = andes.load(
        str(cases / "5bus" / "pjm5bus.xlsx"),
        setup=False,
        no_output=True,
        default_config=True,
        config_option=[f"TG2.deadband={deadband}"],
    )
    # In a time-domain run a load is a constant impedance, which reads its equivalent resistance.
    ss.add(
        "Alter",
        {"idx": "step", "model": "PQ", "dev": LOAD, "src": "Req", "attr": "v", "method": "*"}
        | {"amount": 1.0 / STEP, "t": AT},
    )
    ss.setup()
    ss.Toggle.u.v[:] = 0  # the line trip the file holds at 2 s
    ss.PFlow.run()
    ss.TDS.config.tf = 10.0
    ss.TDS.config.criteria = 0
    ss.TDS.run()
    assert ss.TDS.converged
    speeds = np.asarray(ss.dae.ts.x[:, ss.GENCLS.omega.a])
    outputs = np.asarray(ss.dae.ts.y[:, ss.TG2.pout.a])
    return ss, speeds, outputs


def test_with_the_dead_band_off_the_governors_leave_the_mechanical_power_where_it_was() -> None:
    ss, speeds, outputs = _run(deadband=0)
    assert ss.TG2.n == 4
    # The flags of the block stand at "inside the band" for the whole run.
    assert np.all(ss.TG2.w_db.zi == 1.0)
    # So the output of every governor is the one the power flow gave, to rounding.
    assert np.max(np.abs(outputs - outputs[0])) < 1e-9
    # And the machines slow down with nothing to stop them: the numbers of the catalog's caveat.
    assert speeds.min() == pytest.approx(0.840, abs=0.001)


def test_with_the_dead_band_on_the_governors_act_and_the_machines_slow_down_far_less() -> None:
    ss, speeds, outputs = _run(deadband=1)
    assert np.all(ss.TG2.w_db.zi == 0.0)
    assert np.max(np.abs(outputs - outputs[0])) > 0.05
    assert speeds.min() == pytest.approx(0.973, abs=0.001)


def test_the_entry_says_what_these_runs_show() -> None:
    entry = load_catalog().get("pjm5bus")
    assert entry is not None
    caveat = next(c for c in entry.caveats if c.startswith("The governors do nothing."))
    assert "TG2.config.deadband" in caveat
    assert "0.840" in caveat and "0.973" in caveat
