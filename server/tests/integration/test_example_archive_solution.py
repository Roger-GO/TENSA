"""TENSA's power flow reproduces the solution the IEEE 14-bus archive stores, on the archive's data.

The example case ``ieee14`` is not the archive's system (its loads, dispatch and voltage
set-points differ, as its caveats in the catalog say), so no published solution applies to its
file. The solver is checked on the archive's own data instead: MATPOWER's ``case14`` is the
archive's data, ANDES ships it as ``matpower/case14.m``, and the archive stores a solution
with it.

The stored solution is the final voltage and angle of each bus in ``ieee14cdf.txt``, taken from
https://labs.ece.uw.edu/pstca/pf14/ieee14cdf.txt (University of Washington Power Systems Test
Case Archive, retrieved 2026-11-17, SHA-256
``7e9a2dfeaabef5c5a041dbc75529a5fbcd44d3868dadee2434e9935512d294f5``). The archive's page says the
data "has not been run through a power flow to check the answers", and the values carry three
decimals in voltage and two in angle, so the tolerance is the precision they are stored in and
not that of the solver: 2e-3 pu and 0.03 degrees (ANDES differs from them by 1.3e-3 pu and
0.017 degrees at its worst, at bus 4).
"""

from __future__ import annotations

import numpy as np
import pytest

from tensa.core import examples

pytestmark = pytest.mark.integration

# Final voltage (pu) and angle (degrees) of buses 1 to 14, columns "Final Voltage" and "Final
# Angle" of the bus data of ieee14cdf.txt.
ARCHIVE_VOLTAGE = [
    1.060,
    1.045,
    1.010,
    1.019,
    1.020,
    1.070,
    1.062,
    1.090,
    1.056,
    1.051,
    1.057,
    1.055,
    1.050,
    1.036,
]
ARCHIVE_ANGLE = [
    0.0,
    -4.98,
    -12.72,
    -10.33,
    -8.78,
    -14.22,
    -13.37,
    -13.36,
    -14.94,
    -15.10,
    -14.79,
    -15.07,
    -15.16,
    -16.04,
]


def test_the_power_flow_on_the_archives_data_gives_the_solution_the_archive_stores() -> None:
    import andes

    cases = examples._andes_cases_dir()  # noqa: SLF001
    if cases is None or not (cases / "matpower" / "case14.m").is_file():
        pytest.skip("ANDES does not hold matpower/case14.m")
    system = andes.load(
        str(cases / "matpower" / "case14.m"), setup=True, no_output=True, default_config=True
    )
    system.PFlow.run()
    assert system.PFlow.converged
    assert list(system.Bus.idx.v) == list(range(1, 15))
    assert np.asarray(system.Bus.v.v) == pytest.approx(ARCHIVE_VOLTAGE, abs=2e-3)
    assert np.degrees(system.Bus.a.v) == pytest.approx(ARCHIVE_ANGLE, abs=0.03)


def test_the_example_case_is_not_the_archives_system_and_the_catalog_says_so() -> None:
    """The caveat's numbers are held to the stored solution: the example case's solution
    differs from it by up to 0.06 pu and 11.8 degrees, at bus 8."""
    from tensa.core.example_references import load_reference

    reference = load_reference("ieee14")
    assert reference is not None
    by_name = {c.name: c for c in reference.checks}
    voltage = by_name["Bus voltage magnitudes against pandapower"].expected
    angle = by_name["Bus voltage angles against pandapower"].expected
    assert isinstance(voltage, dict) and isinstance(angle, dict)
    dv = [abs(voltage[str(i + 1)] - ARCHIVE_VOLTAGE[i]) for i in range(14)]
    da = [abs(angle[str(i + 1)] - ARCHIVE_ANGLE[i]) for i in range(14)]
    assert max(dv) == pytest.approx(0.06, abs=1e-3) and int(np.argmax(dv)) == 7
    assert max(da) == pytest.approx(11.8, abs=0.05) and int(np.argmax(da)) == 7
