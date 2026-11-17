"""``scripts/crosscheck_classical.py`` end to end: the values that ship are what it computes.

The script needs ANDES (to dump the network and the machines of the case) and pandapower (the
power flow that gives the classical model its operating point), which live in two environments.
The test runs both halves, and so runs when ``TENSA_VERIFY_PYTHON`` names the Python of the
verification environment, as ``test_crosscheck_pf.py`` does for the power flow. The dump of the
machines, which needs no pandapower, is held to the file it comes from in every run. The tests
skip when run away from a checkout.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

from tensa.core.example_catalog import bundled_cases_dir
from tensa.core.example_references import load_reference, references_dir
from tests._repo import SCRIPTS_DIR, load_module

pytestmark = pytest.mark.integration


def test_the_dump_carries_the_machines_of_the_case_and_says_what_it_leaves_out() -> None:
    andes = pytest.importorskip("andes")
    case = bundled_cases_dir() / "wscc9.xlsx"
    if not case.is_file():
        pytest.skip("the bundled WSCC 9-bus file is not next to the tests")
    pf: ModuleType = load_module("crosscheck_pf_for_machines", SCRIPTS_DIR / "crosscheck_pf.py")
    system = andes.load(str(case), setup=False, no_output=True, default_config=True)
    system.setup()
    machines = pf.dump_network(system)["machines"]
    assert [m["bus"] for m in machines["classical"]] == [1.0, 2.0, 3.0]
    assert [m["H"] for m in machines["classical"]] == pytest.approx([23.64, 6.40, 3.01])
    assert [m["xd1"] for m in machines["classical"]] == pytest.approx([0.0608, 0.1198, 0.1813])
    assert machines["other_models"] == [] and machines["events"] == []

    # A case with round-rotor machines and controllers says so, and the classical check refuses it.
    kundur = pytest.importorskip("tensa.core.examples")._andes_cases_dir()  # noqa: SLF001
    if kundur is None or not (kundur / "kundur" / "kundur_full.xlsx").is_file():
        return
    other = andes.load(
        str(kundur / "kundur" / "kundur_full.xlsx"),
        setup=False,
        no_output=True,
        default_config=True,
    )
    other.setup()
    rest = pf.dump_network(other)["machines"]
    assert rest["classical"] == []
    assert {"GENROU", "TGOV1", "EXDC2"} <= set(rest["other_models"])
    assert rest["events"] == ["Toggle"]


@pytest.mark.skipif(
    not os.environ.get("TENSA_VERIFY_PYTHON"),
    reason="TENSA_VERIFY_PYTHON does not name a Python with pandapower",
)
def test_the_independent_values_that_ship_for_wscc9_are_what_the_script_computes(
    tmp_path: Path,
) -> None:
    pytest.importorskip("andes")
    script = "scripts/crosscheck_classical.py"
    target = tmp_path / "wscc9.json"
    shutil.copy(references_dir() / "wscc9.json", target)
    subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "crosscheck_classical.py"), "run", "wscc9", "--write"]
        + ["--reference", str(target)],
        check=True,
        env={**os.environ},
        capture_output=True,
        text=True,
        timeout=300,
    )
    written = {c["name"]: c for c in json.loads(target.read_text(encoding="utf-8"))["checks"]}
    shipped = load_reference("wscc9")
    assert shipped is not None
    mine = [c for c in shipped.checks if c.generated_by == script]
    assert len(mine) == 8
    for check in mine:
        assert check.name in written, check.name
        assert written[check.name]["expected"] == pytest.approx(check.expected, abs=1e-5), (
            check.name
        )
        window = written[check.name].get("window_hz")
        assert (window is None and check.window_hz is None) or tuple(window) == check.window_hz
