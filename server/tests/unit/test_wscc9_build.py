"""``scripts/build_wscc9.py``: the dynamic WSCC 9-bus case is what the script builds, and the book's.

The case is a file TENSA writes (ANDES's own ``wscc9`` has no machines, and its reactances differ
from the book's). Three things are held here. The file that ships is what the script builds, and
the build is reproducible, so the checksum in the catalog means something. The file loads as a
case of three classical machines and carries no ``_config`` sheet, which ANDES would apply to
every setting of whoever opens it. And the numbers are the book's: from the file and its power
flow solution, the reduced admittance matrix, the internal voltages and the mechanical powers
come out as Wang, Liu and Sun print them for Example 2.6 of Anderson and Fouad (arXiv:1512.05185,
Table I and equations 5 and 6), to the four decimals they print, and the power flow solution is
the one the book prints (as quoted in ETAP's validation case TCS-LF-008, Table 1), to its
precision. The tests need ANDES and skip when run away from a checkout.
"""

from __future__ import annotations

from pathlib import Path
from types import ModuleType

import numpy as np
import pandas as pd
import pytest

from tensa.core import examples
from tensa.core.example_catalog import bundled_cases_dir
from tests._repo import SCRIPTS_DIR, load_module

pytestmark = pytest.mark.unit

# Table I of arXiv:1512.05185 (classical model): internal voltage magnitude, mechanical power.
PUBLISHED_E = [1.0566, 1.0502, 1.0170]
PUBLISHED_PM = [0.7164, 1.6300, 0.8500]
# Its equation 5: the admittance matrix reduced to the machines' internal nodes, G + jB, in
# the order machine 1, 2, 3 (the matrix is symmetric).
PUBLISHED_Y = np.array(
    [
        [0.8455 - 2.9883j, 0.2871 + 1.5129j, 0.2096 + 1.2256j],
        [0.2871 + 1.5129j, 0.4200 - 2.7239j, 0.2133 + 1.0879j],
        [0.2096 + 1.2256j, 0.2133 + 1.0879j, 0.2770 - 2.3681j],
    ]
)
# The solution the book prints: voltage magnitudes to 0.001 pu, angles to 0.1 degree.
PUBLISHED_V = [1.040, 1.025, 1.025, 1.026, 0.996, 1.013, 1.026, 1.016, 1.032]
PUBLISHED_ANGLE_2_3 = (9.3, 4.7)
# Four decimals are printed: half a unit in the last, and a little over.
FOUR_DECIMALS = 6e-5


@pytest.fixture(scope="module")
def script() -> ModuleType:
    pytest.importorskip("andes")
    return load_module("build_wscc9_under_test", SCRIPTS_DIR / "build_wscc9.py")


@pytest.fixture(scope="module")
def classical() -> ModuleType:
    return load_module("crosscheck_classical_for_wscc9", SCRIPTS_DIR / "crosscheck_classical.py")


@pytest.fixture(scope="module")
def shipped() -> Path:
    path = bundled_cases_dir() / "wscc9.xlsx"
    if not path.is_file():
        pytest.skip("the bundled WSCC 9-bus file is not next to the tests")
    return path


@pytest.fixture(scope="module")
def rebuilt(script: ModuleType, tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("wscc9") / "wscc9.xlsx"
    script.build_file(path)
    return path


def test_the_build_is_reproducible(script: ModuleType, rebuilt: Path, tmp_path: Path) -> None:
    """The same data gives the same bytes, a moment later as well as on another machine."""
    again = tmp_path / "again.xlsx"
    script.build_file(again)
    assert again.read_bytes() == rebuilt.read_bytes()


def test_the_file_that_ships_is_what_the_script_builds(shipped: Path, rebuilt: Path) -> None:
    """Compared sheet by sheet: a change of ANDES's writer shows as the difference it is."""
    ours = pd.read_excel(shipped, sheet_name=None)
    built = pd.read_excel(rebuilt, sheet_name=None)
    assert list(ours) == list(built)
    for name, frame in ours.items():
        pd.testing.assert_frame_equal(frame, built[name], obj=name)


def test_the_file_has_the_models_of_the_case_and_no_config_sheet(shipped: Path) -> None:
    sheets = pd.read_excel(shipped, sheet_name=None)
    # ANDES applies a ``_config`` sheet when it loads a file, which would pin every setting.
    assert "_config" not in sheets
    assert {name: len(frame) for name, frame in sheets.items()} == {
        "Bus": 9,
        "PQ": 3,
        "PV": 2,
        "Slack": 1,
        "Line": 9,
        "Area": 1,
        "GENCLS": 3,
    }
    machines = sheets["GENCLS"]
    assert list(machines["M"]) == pytest.approx([2 * 23.64, 2 * 6.40, 2 * 3.01])
    assert list(machines["xd1"]) == pytest.approx([0.0608, 0.1198, 0.1813])
    assert set(machines["D"]) == {0.0} and set(machines["ra"]) == {0.0}


def _loaded(shipped: Path) -> object:
    import andes

    system = andes.load(str(shipped), setup=True, no_output=True, default_config=True)
    system.PFlow.run()
    assert system.PFlow.converged
    return system


def test_the_power_flow_is_the_solution_the_book_prints(shipped: Path) -> None:
    system = _loaded(shipped)
    voltage = list(system.Bus.v.v)  # type: ignore[attr-defined]
    angle = np.degrees(system.Bus.a.v)  # type: ignore[attr-defined]
    # Half a unit of the third decimal, and a little over.
    assert voltage == pytest.approx(PUBLISHED_V, abs=6e-4)
    assert [angle[1], angle[2]] == pytest.approx(PUBLISHED_ANGLE_2_3, abs=0.06)
    assert float(system.Slack.p.v[0]) * 100 == pytest.approx(71.6, abs=0.1)  # type: ignore[attr-defined]


def test_the_file_started_at_its_solution_converges_in_one_step(shipped: Path) -> None:
    """The solution is stored in the file, so the user's own power flow starts from it."""
    system = _loaded(shipped)
    assert system.PFlow.niter <= 1  # type: ignore[attr-defined]


def test_the_internal_voltages_mechanical_powers_and_reduced_matrix_are_the_books(
    shipped: Path, classical: ModuleType
) -> None:
    import andes

    pf = load_module("crosscheck_pf_for_wscc9", SCRIPTS_DIR / "crosscheck_pf.py")
    system = andes.load(str(shipped), setup=False, no_output=True, default_config=True)
    system.setup()
    network = pf.dump_network(system)
    system.PFlow.run()
    voltages = np.asarray(system.Bus.v.v) * np.exp(1j * np.asarray(system.Bus.a.v))

    model = classical.ClassicalModel(network, voltages)
    assert np.abs(model.e0) == pytest.approx(PUBLISHED_E, abs=FOUR_DECIMALS)
    assert model.pm == pytest.approx(PUBLISHED_PM, abs=FOUR_DECIMALS)
    reduced = model.reduced()
    assert np.max(np.abs(reduced - PUBLISHED_Y)) < FOUR_DECIMALS
    # The classical model has two electromechanical modes for three machines.
    modes = model.modes()
    assert [round(m["frequency_hz"], 3) for m in modes] == [1.383, 2.126]


def test_the_network_is_the_books_and_not_the_one_andes_ships(shipped: Path) -> None:
    """ANDES's ``wscc9.xlsx`` has three line reactances that are not the book's. The catalog says
    so, and this holds what it says to the files."""
    cases = examples._andes_cases_dir()  # noqa: SLF001
    if cases is None or not (cases / "wscc9" / "wscc9.xlsx").is_file():
        pytest.skip("ANDES does not hold wscc9/wscc9.xlsx")
    ours = pd.read_excel(shipped, sheet_name="Line").set_index(["bus1", "bus2"])["x"]
    theirs = pd.read_excel(cases / "wscc9" / "wscc9.xlsx", sheet_name="Line")
    andes_x = {(int(r.bus1), int(r.bus2)): float(r.x) for r in theirs.itertuples()}
    differ = {}
    for (b1, b2), x in ours.items():
        other = andes_x.get((b1, b2), andes_x.get((b2, b1)))
        if other is not None and abs(other - x) > 1e-9:
            differ[(int(b1), int(b2))] = (x, other)
    assert differ == {(4, 5): (0.085, 0.068), (6, 9): (0.17, 0.1738), (7, 8): (0.072, 0.0576)}
