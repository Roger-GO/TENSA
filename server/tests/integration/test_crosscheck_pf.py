"""``scripts/crosscheck_pf.py``: the network ANDES holds, written as a MATPOWER case.

The independent power flow of an example case is solved by pandapower, which TENSA does not
depend on, from the network this script dumps out of ANDES. A dump that did not hold what ANDES
solves would give a reference for another system, so the dump is held here to ANDES's own
solution: with the voltages ANDES's power flow found, the MATPOWER equations of the dumped
network leave no power unaccounted for at any bus. That needs ANDES and no pandapower, so it
runs everywhere the suite does. The pandapower half runs when ``TENSA_VERIFY_PYTHON`` names the
Python of the verification environment, and checks that the reference files that ship are what
the script writes. The tests skip when run away from a checkout.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core import examples
from tensa.core.example_references import load_reference
from tests._repo import SCRIPTS_DIR, load_module

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def script() -> ModuleType:
    return load_module("crosscheck_pf_under_test", SCRIPTS_DIR / "crosscheck_pf.py")


def _case_path(relative: str) -> Path:
    pytest.importorskip("andes")
    cases = examples._andes_cases_dir()  # noqa: SLF001
    if cases is None or not (cases / relative).is_file():
        pytest.skip(f"ANDES does not hold {relative}")
    return cases / relative


def _dumped_and_solved(script: ModuleType, relative: str) -> tuple[dict[str, Any], Any]:
    import andes

    system = andes.load(str(_case_path(relative)), setup=False, no_output=True, default_config=True)
    system.setup()
    network = script.dump_network(system)
    system.PFlow.run()
    assert system.PFlow.converged
    return network, system


def _unaccounted_power(network: dict[str, Any], system: Any) -> np.ndarray:
    """What MATPOWER's equations of ``network`` leave at each bus at ANDES's solution, in pu."""
    base = network["baseMVA"]
    bus = np.array(network["bus"])
    branch = np.array(network["branch"])
    n = len(bus)
    v = np.asarray(system.Bus.v.v) * np.exp(1j * np.asarray(system.Bus.a.v))
    y = np.zeros((n, n), dtype=complex)
    for row in branch:
        if not row[10]:
            continue
        f, t = int(row[0]) - 1, int(row[1]) - 1
        tap = (row[8] or 1.0) * np.exp(1j * math.radians(row[9]))
        # ANDES adds 1e-8 to r and x to keep a zero impedance off a division by zero. The dump
        # leaves that out (see ``MODELLING``), and a transformer with no resistance and a small
        # reactance would be off by 1e-5 pu without it.
        ys = 1 / complex(row[2] + 1e-8, row[3] + 1e-8)
        y[f, f] += (ys + 0.5j * row[4]) / abs(tap) ** 2
        y[t, t] += ys + 0.5j * row[4]
        y[f, t] -= ys / np.conj(tap)
        y[t, f] -= ys / tap
    shunt = (bus[:, 4] + 1j * bus[:, 5]) / base
    injected = v * np.conj(y @ v) + np.abs(v) ** 2 * np.conj(shunt)
    generated = np.zeros(n, dtype=complex)
    for g in network["gen"]:
        if g[7]:
            generated[int(g[0]) - 1] += complex(g[1], g[2]) / base
    return injected - (generated - (bus[:, 2] + 1j * bus[:, 3]) / base)


@pytest.mark.parametrize(
    "relative",
    ["ieee14/ieee14_full.xlsx", "kundur/kundur_full.xlsx", "wscc9/wscc9.xlsx"],
)
def test_the_dumped_network_is_in_balance_at_the_solution_andes_finds(
    script: ModuleType, relative: str
) -> None:
    network, system = _dumped_and_solved(script, relative)
    mismatch = _unaccounted_power(network, system)
    kinds = np.array(network["bus"])[:, 1]
    # A load bus has both its powers fixed, a generator bus its active power: the slack's own
    # output is what is left over.
    assert np.max(np.abs(mismatch[kinds == 1])) < 1e-6
    assert np.max(np.abs(mismatch[kinds == 2].real)) < 1e-6
    assert list(kinds).count(3) == 1
    assert network["bus_idx"] == list(system.Bus.idx.v)


def test_the_ieee_14_dump_has_what_the_file_has(script: ModuleType) -> None:
    network, system = _dumped_and_solved(script, "ieee14/ieee14_full.xlsx")
    assert (len(network["bus"]), len(network["gen"]), len(network["branch"])) == (14, 5, 20)
    taps = [row[8] for row in network["branch"] if row[8] != 1.0]
    # Four transformers, whose ratio is the one ANDES uses (not the one the book prints).
    assert taps == [pytest.approx(0.99677)] * 4
    base = network["baseMVA"]
    assert sum(row[2] for row in network["bus"]) == pytest.approx(
        float(np.sum(system.PQ.p0.v)) * base
    )
    assert sum(row[5] for row in network["bus"]) == pytest.approx(
        float(np.sum(system.Shunt.b.v)) * base
    )
    # The first bus is the slack, at the angle the case gives it, with its generator.
    assert network["bus"][0][1] == 3 and network["bus"][0][8] == 0.0


def test_a_device_the_dump_does_not_translate_stops_it(script: ModuleType) -> None:
    flags = SimpleNamespace(pflow=True)
    system = SimpleNamespace(
        models={
            "Bus": SimpleNamespace(flags=flags, n=2),
            "ShuntSw": SimpleNamespace(flags=flags, n=1),
            "Area": SimpleNamespace(flags=flags, n=1),
            "ACEc": SimpleNamespace(flags=SimpleNamespace(pflow=False), n=1),
        }
    )
    with pytest.raises(script.CrosscheckError, match="ShuntSw"):
        script.dump_network(system)


def test_json_is_written_with_a_map_of_numbers_on_one_line_and_reads_back_the_same(
    script: ModuleType,
) -> None:
    document = {
        "version": 1,
        "checks": [
            {
                "name": "x" * 90,
                "expected": {"1": 1.0, "2": -0.5},
                "tolerance": {"abs": 0.01},
                "window_hz": [0.3, 0.9],
                "empty": {},
                "none": None,
                "flag": True,
            }
        ],
    }
    text = script.format_json(document)
    assert json.loads(text) == document
    assert '"expected": {"1": 1.0, "2": -0.5}' in text
    assert '"window_hz": [0.3, 0.9]' in text
    assert '"tolerance": {"abs": 0.01}' in text


def test_writing_a_reference_replaces_its_own_checks_and_keeps_the_others(
    script: ModuleType, tmp_path: Path
) -> None:
    path = tmp_path / "demo.json"
    mine = {"name": "pandapower", "generated_by": script.GENERATED_BY, "expected": 1.0}
    script.write_reference("demo", [mine], path)
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["id"] == "demo" and written["version"] == 1

    by_hand = {"name": "a book", "expected": 2.0}
    written["checks"].append(by_hand)
    written["disturbance"] = {"description": "kept"}
    path.write_text(json.dumps(written), encoding="utf-8")
    script.write_reference("demo", [{**mine, "expected": 3.0}], path)
    again = json.loads(path.read_text(encoding="utf-8"))
    assert [c["expected"] for c in again["checks"]] == [3.0, 2.0]
    assert again["disturbance"] == {"description": "kept"}

    with pytest.raises(script.CrosscheckError, match="reference of 'demo'"):
        script.write_reference("other", [mine], path)


def test_the_interpreter_for_each_half_is_found_or_the_error_says_what_to_set(
    script: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert script._python_for("/x/python", "TENSA_PYTHON", "json") == "/x/python"  # noqa: SLF001
    assert script._python_for(None, "TENSA_PYTHON", "json") == sys.executable  # noqa: SLF001
    monkeypatch.setenv("TENSA_VERIFY_PYTHON", "/env/python")
    assert script._python_for(None, "TENSA_VERIFY_PYTHON", "no_such_module_x") == "/env/python"  # noqa: SLF001
    monkeypatch.delenv("TENSA_VERIFY_PYTHON")
    with pytest.raises(script.CrosscheckError, match="TENSA_VERIFY_PYTHON"):
        script._python_for(None, "TENSA_VERIFY_PYTHON", "no_such_module_x")  # noqa: SLF001


@pytest.mark.skipif(
    not os.environ.get("TENSA_VERIFY_PYTHON"),
    reason="TENSA_VERIFY_PYTHON does not name a Python with pandapower",
)
@pytest.mark.parametrize("example_id", ["ieee14", "kundur", "wscc9"])
def test_pandapower_gives_the_values_that_ship_in_the_reference_files(
    example_id: str, tmp_path: Path
) -> None:
    _case_path("ieee14/ieee14_full.xlsx")  # skips without ANDES
    target = tmp_path / f"{example_id}.json"
    subprocess.run(
        [
            sys.executable,
            str(SCRIPTS_DIR / "crosscheck_pf.py"),
            "run",
            example_id,
            "--write",
            "--reference",
            str(target),
        ],
        check=True,
        env={**os.environ},
        capture_output=True,
        text=True,
        timeout=300,
    )
    written = json.loads(target.read_text(encoding="utf-8"))["checks"]
    shipped = load_reference(example_id)
    assert shipped is not None
    # Only what this script wrote: another script writes the classical model's checks.
    expected = {
        c.quantity: c.expected
        for c in shipped.checks
        if c.generated_by == "scripts/crosscheck_pf.py"
    }
    assert {c["quantity"] for c in written} == set(expected)
    for check in written:
        want = expected[check["quantity"]]
        if isinstance(want, dict):
            assert check["expected"] == pytest.approx(want, abs=1e-6)
        else:
            assert check["expected"] == pytest.approx(want, abs=1e-5)


@pytest.mark.skipif(
    not os.environ.get("TENSA_VERIFY_PYTHON"),
    reason="TENSA_VERIFY_PYTHON does not name a Python with pandapower",
)
def test_a_matpower_file_is_solved_with_no_andes_and_agrees_with_andes() -> None:
    import andes

    path = _case_path("matpower/case14.m")
    done = subprocess.run(
        [
            os.environ["TENSA_VERIFY_PYTHON"],
            str(SCRIPTS_DIR / "crosscheck_pf.py"),
            "solve",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    solved = json.loads(done.stdout)
    assert solved["admittance_gap_pu"] < 1e-9
    system = andes.load(str(path), setup=True, no_output=True, default_config=True)
    system.PFlow.run()
    assert system.PFlow.converged
    for idx, v, a in zip(system.Bus.idx.v, system.Bus.v.v, system.Bus.a.v, strict=True):
        assert solved["bus_voltage"][str(idx)] == pytest.approx(v, abs=1e-6)
        assert solved["bus_angle"][str(idx)] == pytest.approx(math.degrees(a), abs=1e-3)
