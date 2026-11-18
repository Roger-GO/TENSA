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
import re
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from tensa.core import examples
from tensa.core.example_references import load_reference, references_dir
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


def _unaccounted_power(network: dict[str, Any], system: Any, eps: float = 1e-8) -> np.ndarray:
    """What MATPOWER's equations of ``network`` leave at each bus at ANDES's solution, in pu.

    ``eps`` is what ANDES adds to a line's r and x (zero for the network as a file gives it)."""
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
        ys = 1 / complex(row[2] + eps, row[3] + eps)
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


def _stored(script: ModuleType, relative: str) -> dict[str, Any]:
    import andes

    system = andes.load(str(_case_path(relative)), setup=False, no_output=True, default_config=True)
    return script.stored_solution(system)  # type: ignore[no-any-return]


def test_the_stored_state_of_a_case_file_is_read_as_the_file_gives_it(script: ModuleType) -> None:
    """The NPCC file holds the voltage and angle of bus 1 as its RAW source prints them
    (1.01517 pu, 4.8434 degrees, which the xlsx keeps in radians) and a slack of 466.019 MW."""
    state = _stored(script, "npcc/npcc.xlsx")
    assert len(state["bus_voltage"]) == len(state["bus_angle"]) == 140
    assert state["bus_voltage"]["1"] == 1.01517
    assert state["bus_angle"]["1"] == pytest.approx(4.8434, abs=5e-5)
    assert state["slack_p_mw"] == pytest.approx(466.019, abs=1e-3)


def test_a_stored_state_is_a_reference_where_it_is_a_solution_and_not_for_ieee_39(
    script: ModuleType,
) -> None:
    """ANDES's own power flow lands on the state NPCC and WECC store, to the digits of their
    RAW files, and 0.2 pu from the one IEEE 39 stores. That is why only the first two have a
    stored-solution reference, and what the harness would report for the third."""
    import andes

    gap: dict[str, float] = {}
    for case, relative in (
        ("npcc", "npcc/npcc.xlsx"),
        ("wecc", "wecc/wecc_full.xlsx"),
        ("ieee39", "ieee39/ieee39_full.xlsx"),
    ):
        state = _stored(script, relative)
        system = andes.load(
            str(_case_path(relative)), setup=True, no_output=True, default_config=True
        )
        system.PFlow.run()
        assert system.PFlow.converged
        solved = dict(zip((str(i) for i in system.Bus.idx.v), system.Bus.v.v, strict=True))
        gap[case] = max(abs(solved[k] - v) for k, v in state["bus_voltage"].items())
    assert gap["npcc"] < 5e-5 and gap["wecc"] < 5e-5
    assert gap["ieee39"] > 0.1


def test_the_stored_checks_are_stored_solutions_with_their_own_mark(script: ModuleType) -> None:
    checks = script._stored_checks(  # noqa: SLF001
        {"bus_voltage": {"1": 1.01}, "bus_angle": {"1": 0.5}, "slack_p_mw": 12.5}, "case.xlsx"
    )
    assert [c["quantity"] for c in checks] == [
        "pf.bus_voltage_pu",
        "pf.bus_angle_deg",
        "pf.slack_p_mw",
    ]
    assert {c["kind"] for c in checks} == {"stored-solution"}
    assert {c["generated_by"] for c in checks} == {script.STORED_BY}
    assert script.STORED_BY != script.GENERATED_BY
    assert all(
        "case.xlsx" in c["reference"] and "TENSA did not compute" in c["reference"] for c in checks
    )


def test_writing_the_stored_state_keeps_the_solvers_checks_and_replaces_its_own(
    script: ModuleType, tmp_path: Path
) -> None:
    _case_path("npcc/npcc.xlsx")
    target = tmp_path / "npcc.json"
    solver = {"name": "pandapower", "generated_by": script.GENERATED_BY, "expected": 1.0}
    script.write_reference("npcc", [solver], target)
    args = SimpleNamespace(id="npcc", write=True, reference=str(target))
    assert script.cmd_stored(args) == 0
    first = json.loads(target.read_text(encoding="utf-8"))["checks"]
    assert [c["generated_by"] for c in first] == [script.STORED_BY] * 3 + [script.GENERATED_BY]
    assert script.cmd_stored(args) == 0
    again = json.loads(target.read_text(encoding="utf-8"))["checks"]
    assert again == first  # written again, not added to
    # A file is no example id: a reference needs the case it belongs to.
    with pytest.raises(script.CrosscheckError, match="example id"):
        script.cmd_stored(
            SimpleNamespace(id=str(_case_path("npcc/npcc.xlsx")), write=True, reference=None)
        )


@pytest.mark.parametrize("example_id", ["npcc", "wecc", "ieee118", "ieee300"])
def test_the_stored_checks_that_ship_are_what_the_script_reads_from_the_file(
    script: ModuleType, example_id: str
) -> None:
    relative = {
        "npcc": "npcc/npcc.xlsx",
        "wecc": "wecc/wecc_full.xlsx",
        "ieee118": "matpower/case118.m",
        "ieee300": "matpower/case300.m",
    }[example_id]
    state = _stored(script, relative)
    shipped = load_reference(example_id)
    assert shipped is not None
    mine = {c.quantity: c.expected for c in shipped.checks if c.generated_by == script.STORED_BY}
    if example_id == "ieee300":
        # The file stores no power for its slack (0 MW), so no check of it is written.
        assert state["slack_p_mw"] == 0.0 and "pf.slack_p_mw" not in mine
    else:
        assert mine["pf.slack_p_mw"] == pytest.approx(state["slack_p_mw"], abs=1e-5)
    assert mine["pf.bus_voltage_pu"] == pytest.approx(state["bus_voltage"], abs=1e-8)
    assert mine["pf.bus_angle_deg"] == pytest.approx(state["bus_angle"], abs=1e-6)


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
@pytest.mark.parametrize(
    "example_id",
    [
        "ieee14",
        "kundur",
        "wscc9",
        "ieee39",
        "npcc",
        "wecc",
        "kundur_pss",
        "ieee14_fault",
        "pjm5bus",
        "ieee14_solar",
        "ieee14_wt3",
        "ieee30",
        "ieee57",
        "ieee118",
        "ieee300",
    ],
)
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


def test_a_stored_state_has_a_basis_of_its_own_where_the_file_does_not_keep_a_solver_s_digits(
    script: ModuleType,
) -> None:
    """The RAW files that PSS/E solved keep five decimals of a voltage, and the checks of NPCC
    and WECC hold them to that. The IEEE 118-bus data carries the archive's three decimals, which
    are also 0.0173 pu from a solution, so its checks are held to what that state allows and say
    where it comes from."""
    state = {"bus_voltage": {"1": 1.01}, "bus_angle": {"1": 0.5}, "slack_p_mw": 12.5}
    raw = script._stored_checks(state, "npcc.xlsx")  # noqa: SLF001
    assert [c["tolerance"]["abs"] for c in raw] == [5e-5, 0.005, 0.1]
    assert "taken from the RAW file" in raw[0]["reference"]
    basis = script.STORED_BASES["ieee118"]
    mine = script._stored_checks(state, "case118.m", basis)  # noqa: SLF001
    assert [c["tolerance"]["abs"] for c in mine] == [0.02, 0.35, 3.0]
    assert all("ieee118cdf.txt" in c["reference"] and "case118.m" in c["reference"] for c in mine)
    assert all("not a solution of it" in c["reference"] for c in mine)
    assert all("TENSA did not compute it" in c["reference"] for c in mine)
    # Only the cases that have a basis of their own do: a case that is not listed gets the RAW one.
    assert set(script.STORED_BASES) == {
        "ieee118",
        "ieee300",
        "activsg200",
        "pegase89",
        "activsg2000",
    }


def test_a_stored_state_without_slack_power_has_no_check_of_it(script: ModuleType) -> None:
    """The IEEE 300-bus file stores 0 MW for its slack, which is no output at all, so its basis
    has no tolerance for it and the check is not written. Its state is the archive's, saved with
    a phase shifter the file lacks, so the voltage and the angle are held to the gap that
    leaves (0.0085 pu and 9.76 degrees found)."""
    state = {"bus_voltage": {"1": 1.01}, "bus_angle": {"1": 0.5}, "slack_p_mw": 0.0}
    basis = script.STORED_BASES["ieee300"]
    assert basis.slack_p is None
    mine = script._stored_checks(state, "case300.m", basis)  # noqa: SLF001
    assert [c["quantity"] for c in mine] == ["pf.bus_voltage_pu", "pf.bus_angle_deg"]
    assert [c["tolerance"]["abs"] for c in mine] == [0.01, 10.0]
    assert all("ieee300cdf.txt" in c["reference"] and "case300.m" in c["reference"] for c in mine)
    assert all("-11.4 degree phase shifter on branch 196-2040" in c["reference"] for c in mine)
    assert all("TENSA did not compute it" in c["reference"] for c in mine)
    # A basis that gives a tolerance for the slack still writes its check, after the other two.
    both = script._stored_checks(state, "case.m", script.StoredBasis("x", 0.1, 1.0, 2.0))  # noqa: SLF001
    assert [c["quantity"] for c in both][-1] == "pf.slack_p_mw"


def test_the_stored_command_uses_the_basis_of_the_case_it_is_given(
    script: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = _case_path("matpower/case118.m")
    target = tmp_path / "ieee118.json"
    assert script.cmd_stored(SimpleNamespace(id="ieee118", write=True, reference=str(target))) == 0
    written = json.loads(target.read_text(encoding="utf-8"))["checks"]
    assert [c["tolerance"]["abs"] for c in written] == [0.02, 0.35, 3.0]
    capsys.readouterr()
    # A file path names no case, so it is held to the RAW basis.
    assert script.cmd_stored(SimpleNamespace(id=str(path), write=False, reference=None)) == 0
    shown = json.loads(capsys.readouterr().out)
    assert [c["tolerance"]["abs"] for c in shown] == [5e-5, 0.005, 0.1]


@pytest.mark.skipif(
    not os.environ.get("TENSA_VERIFY_PYTHON"),
    reason="TENSA_VERIFY_PYTHON does not name a Python with pandapower",
)
def test_the_phase_shifter_the_300_bus_file_lacks_is_why_its_stored_state_is_not_a_solution(
    tmp_path: Path,
) -> None:
    """The archive's data has a phase shifter of -11.4 degrees on branch 196-2040 (type 4, limits
    -15 to 0) and the file has none. Solve the file as it is, and solve it with the shifter put back,
    and hold both to the state the file stores: the first is 9.76 degrees off at bus 2040, the
    second is within 0.05 degrees and 5e-4 pu of it everywhere, which is the cause the entry names."""
    source = _case_path("matpower/case300.m")
    text = source.read_text(encoding="utf-8")
    rows = [line for line in text.splitlines() if re.match(r"\s*196\s+2040\s", line)]
    assert len(rows) == 1
    fields = rows[0].rstrip(";").split()
    assert fields[:2] == ["196", "2040"] and fields[8:10] == ["1", "0"]  # ratio 1, shift 0
    fields[9] = "-11.4"
    shifted = tmp_path / "case300_with_shifter.m"
    shifted.write_text(text.replace(rows[0], "\t".join(fields) + ";"), encoding="utf-8")

    def solve(path: Path) -> dict[str, Any]:
        done = subprocess.run(
            [os.environ["TENSA_VERIFY_PYTHON"], str(SCRIPTS_DIR / "crosscheck_pf.py"), "solve", str(path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        return json.loads(done.stdout)  # type: ignore[no-any-return]

    reference = load_reference("ieee300")
    assert reference is not None
    stored = {c.quantity: c.expected for c in reference.checks if c.kind == "stored-solution"}
    stored_v, stored_a = stored["pf.bus_voltage_pu"], stored["pf.bus_angle_deg"]
    assert isinstance(stored_v, dict) and isinstance(stored_a, dict)
    gaps = {}
    for label, path in (("as it is", source), ("with the shifter", shifted)):
        solved = solve(path)
        gaps[label] = (
            max(abs(solved["bus_voltage"][k] - v) for k, v in stored_v.items()),
            max(abs(solved["bus_angle"][k] - a) for k, a in stored_a.items()),
        )
    assert gaps["as it is"][1] > 9.0
    assert gaps["with the shifter"][0] < 5e-4 and gaps["with the shifter"][1] < 0.05


# ---- the PSS/E reader of the script, the RTS-GMLC file and a PSS/E report -----------------


def _bundled(name: str) -> Path:
    from tensa.core.example_catalog import bundled_cases_dir

    return bundled_cases_dir() / name


# The sections of a version 33 RAW file, in order, as the end-of-section lines name them.
_RAW_SECTION_NAMES = (
    "BUS",
    "LOAD",
    "FIXED SHUNT",
    "GENERATOR",
    "BRANCH",
    "TRANSFORMER",
    "AREA",
    "TWO-TERMINAL DC",
    "VOLTAGE SOURCE CONVERTER",
    "IMPEDANCE CORRECTION",
    "MULTI-TERMINAL DC",
    "MULTI-SECTION LINE",
    "ZONE",
    "INTER-AREA TRANSFER",
    "OWNER",
    "FACTS CONTROL DEVICE",
    "SWITCHED SHUNT",
    "GNE DEVICE",
)

# A small system: a swing bus and a generator bus at 138 kV and a load bus at 230 kV.
_RAW_BASIC = {
    "bus": [
        "1,'SWING',138.0,3,1,1,1,1.04,0.0",
        "2,'GEN',138.0,2,1,1,1,1.02,-2.0",
        "3,'LOAD',230.0,1,1,1,1,1.00,-4.0",
    ],
    "load": ["3,'1',1,1,1,50.0,10.0,0.0,0.0,0.0,0.0,1,1"],
    "generator": [
        "1,'1',0.0,0.0,50.0,-50.0,1.04,0,100.0,0.0,1.0,0.0,0.0,1.0,1,100.0,200.0,0.0",
        "2,'1',20.0,0.0,30.0,-30.0,1.02,0,100.0,0.0,1.0,0.0,0.0,1.0,1,100.0,100.0,0.0",
    ],
    "branch": ["1,2,'1',0.01,0.05,0.02,100.0,100.0,100.0,0.0,0.0,0.0,0.0,1,1,10.0"],
    "transformer": [
        "2,3,0,'1',1,1,1,0.0,0.0,2,'T1',1,1,1.0",
        "0.002,0.08,100.0",
        "1.05,138.0,0.0,100.0,100.0,100.0,0,0,1.1,0.9,1.1,0.9,33,0,0.0,0.0",
        "1.0,230.0",
    ],
}


def _raw_text(sections: dict[str, list[str]] | None = None, *, revision: int = 33) -> str:
    """A RAW file of ``_RAW_BASIC``, with the records of the sections named replaced."""
    records = {**_RAW_BASIC, **(sections or {})}
    lines = [f"0, 100.00, {revision}, 0, 0, 60.00 / a test case", "Title one", "Title two"]
    for name in _RAW_SECTION_NAMES:
        lines += records.get(name.lower(), [])
        lines.append(f"0 / END OF {name} DATA")
    lines.append("Q")
    return "\n".join(lines) + "\n"


def _read_raw(script: ModuleType, tmp_path: Path, text: str) -> dict[str, Any]:
    path = tmp_path / "case.raw"
    path.write_text(text, encoding="ascii")
    return script._ppc_from_raw_file(path)  # type: ignore[no-any-return]  # noqa: SLF001


def test_the_raw_reader_reads_a_small_case_as_pss_e_defines_it(
    script: ModuleType, tmp_path: Path
) -> None:
    ppc = _read_raw(script, tmp_path, _raw_text())
    assert ppc["baseMVA"] == 100.0 and ppc["f_hz"] == 60.0
    bus = {int(row[0]): row for row in ppc["bus"]}
    assert [bus[n][1] for n in (1, 2, 3)] == [3.0, 2.0, 1.0]
    assert (bus[3][2], bus[3][3], bus[3][9]) == (50.0, 10.0, 230.0)
    # Generator rows: bus, P, Q, Qmax, Qmin, Vg, base, status, Pmax, Pmin.
    assert [g[:8] for g in ppc["gen"]] == [
        [1.0, 0.0, 0.0, 50.0, -50.0, 1.04, 100.0, 1.0],
        [2.0, 20.0, 0.0, 30.0, -30.0, 1.02, 100.0, 1.0],
    ]
    line, transformer = ppc["branch"]
    # The line keeps its charging; the transformer has its tap as the ratio of the windings and
    # its impedance as given, per unit of the system base.
    assert line[:5] == [1.0, 2.0, 0.01, 0.05, 0.02] and line[8] == 0.0
    assert transformer[:4] == [2.0, 3.0, 0.002, 0.08] and transformer[8] == pytest.approx(1.05)


@pytest.mark.parametrize(
    ("winding1", "winding2", "codes", "ratio", "scale"),
    [
        # CW 1: per unit of the bus voltage, so the ratio is the two taps' quotient.
        ("1.05,138.0,0.0,100.0,100.0,100.0", "1.02,230.0", (1, 1), 1.05 / 1.02, 1.0),
        # CW 2: the taps are kilovolts, and the ratio is that of the per unit values.
        ("145.0,138.0,0.0,100.0,100.0,100.0", "230.0,230.0", (2, 1), (145.0 / 138.0), 1.0),
        # CW 3: per unit of the winding's nominal voltage, which is not the bus's (140 against 138 kV).
        ("1.0,140.0,0.0,100.0,100.0,100.0", "1.0,230.0", (3, 1), 140.0 / 138.0, 1.0),
        # CZ 2: the impedance is per unit of the winding base, here 50 MVA on a system of 100.
        ("1.0,138.0,0.0,100.0,100.0,100.0", "1.0,230.0", (1, 2), 1.0, 2.0),
    ],
)
def test_the_raw_reader_turns_the_windings_and_codes_of_a_transformer_into_a_ratio_and_an_impedance(
    script: ModuleType,
    tmp_path: Path,
    winding1: str,
    winding2: str,
    codes: tuple[int, int],
    ratio: float,
    scale: float,
) -> None:
    sbase = 50.0 if codes[1] == 2 else 100.0
    transformer = [
        f"2,3,0,'1',{codes[0]},{codes[1]},1,0.0,0.0,2,'T1',1,1,1.0",
        f"0.002,0.08,{sbase}",
        winding1 + ",0,0,1.1,0.9,1.1,0.9,33,0,0.0,0.0",
        winding2,
    ]
    ppc = _read_raw(script, tmp_path, _raw_text({"transformer": transformer}))
    row = ppc["branch"][-1]
    assert row[8] == pytest.approx(ratio) and row[2] == pytest.approx(0.002 * scale)
    assert row[3] == pytest.approx(0.08 * scale)


def test_the_raw_reader_leaves_out_what_is_out_of_service_and_what_a_power_flow_does_not_use(
    script: ModuleType, tmp_path: Path
) -> None:
    # The only generator of bus 2 is out of service, so bus 2 is a load bus; a line out of
    # service has no line-end shunt; a load out of service is no load; and a switched shunt that
    # stays where it is is a susceptance at its bus (BINIT, in MVAr).
    sections = {
        "generator": [
            "1,'1',0.0,0.0,50.0,-50.0,1.04,0,100.0,0.0,1.0,0.0,0.0,1.0,1,100.0,200.0,0.0",
            "2,'1',20.0,0.0,30.0,-30.0,1.02,0,100.0,0.0,1.0,0.0,0.0,1.0,0,100.0,100.0,0.0",
        ],
        "branch": [
            "1,2,'1',0.01,0.05,0.02,100.0,100.0,100.0,0.5,0.4,0.0,0.0,1,1,10.0",
            "1,3,'1',0.01,0.05,0.02,100.0,100.0,100.0,0.0,0.0,0.3,0.2,0,1,10.0",
        ],
        "load": [
            "3,'1',1,1,1,50.0,10.0,0.0,0.0,0.0,0.0,1,1",
            "3,'2',0,1,1,99.0,9.0,0.0,0.0,0.0,0.0,1,1",
        ],
        "switched shunt": ["3,0,0,1,1.05,0.95,0,100.0,'',-25.0,1,-25.0"],
        "area": ["1,0,0.0,1.0,'A'"],
    }
    ppc = _read_raw(script, tmp_path, _raw_text(sections))
    bus = {int(row[0]): row for row in ppc["bus"]}
    assert bus[2][1] == 1.0  # a PV bus with no generator in service is a load bus
    assert (bus[3][2], bus[3][3], bus[3][4], bus[3][5]) == (50.0, 10.0, 0.0, -25.0)
    # Only the line in service has its line-end shunt (PSS/E's GI and BI are per unit of the base).
    assert (bus[1][4], bus[1][5]) == (50.0, 40.0)
    assert [row[10] for row in ppc["branch"]] == [1.0, 0.0, 1.0]
    assert [g[7] for g in ppc["gen"]] == [1.0, 0.0]


def test_the_raw_reader_adds_a_fixed_shunt_and_the_magnetising_branch_of_a_transformer_to_a_bus(
    script: ModuleType, tmp_path: Path
) -> None:
    """A fixed shunt is MW and MVAr at 1 pu (one out of service is left out), and a transformer's
    magnetising admittance, per unit of the system base, sits at the bus of its first winding."""
    transformer = [
        "2,3,0,'1',1,1,1,0.001,-0.01,2,'T1',1,1,1.0",
        "0.002,0.08,100.0",
        "1.05,138.0,0.0,100.0,100.0,100.0,0,0,1.1,0.9,1.1,0.9,33,0,0.0,0.0",
        "1.0,230.0",
    ]
    sections = {
        "fixed shunt": ["3,'1',1,2.0,15.0", "3,'2',0,99.0,99.0"],
        "transformer": transformer,
    }
    bus = {int(r[0]): r for r in _read_raw(script, tmp_path, _raw_text(sections))["bus"]}
    assert (bus[3][4], bus[3][5]) == (2.0, 15.0)
    assert (bus[2][4], bus[2][5]) == (pytest.approx(0.1), pytest.approx(-1.0))


@pytest.mark.parametrize(
    ("section", "records", "message"),
    [
        ("two-terminal dc", ["'DC1',1,100.0,500.0,5.0,0,0,0,'I',0,0,1", "3,2,16,16", "2,2,16,16"], "two-terminal dc data"),
        ("facts control device", ["'F1',3,0,1"], "facts control device data"),
        ("load", ["3,'1',1,1,1,50.0,10.0,5.0,0.0,0.0,0.0,1,1"], "constant-current"),
        ("load", ["3,'1',1,1,1,50.0,10.0,0.0,0.0,2.0,0.0,1,1"], "constant-admittance"),
        (
            "generator",
            ["1,'1',0.0,0.0,50.0,-50.0,1.04,3,100.0,0.0,1.0,0.0,0.0,1.0,1,100.0,200.0,0.0"],
            "regulates bus 3",
        ),
        ("switched shunt", ["3,1,0,1,1.05,0.95,0,100.0,'',-25.0,1,-25.0"], "adjustable"),
        (
            "transformer",
            [
                "2,3,0,'1',1,1,1,0.0,0.0,2,'T1',1,1,1.0",
                "0.002,0.08,100.0",
                "1.0,138.0,30.0,100.0,100.0,100.0,0,0,1.1,0.9,1.1,0.9,33,0,0.0,0.0",
                "1.0,230.0",
            ],
            "phase shifter",
        ),
        (
            "transformer",
            [
                "2,3,1,'1',1,1,1,0.0,0.0,2,'T1',1,1,1.0",
                "0.002,0.08,100.0,0.002,0.08,100.0,0.002,0.08,100.0,1.0,0.0",
            ],
            "three windings",
        ),
        (
            "transformer",
            [
                "2,3,0,'1',1,3,1,0.0,0.0,2,'T1',1,1,1.0",
                "1500.0,0.08,100.0",
                "1.0,138.0,0.0,100.0,100.0,100.0,0,0,1.1,0.9,1.1,0.9,33,0,0.0,0.0",
                "1.0,230.0",
            ],
            "codes CW 1 and CZ 3",
        ),
        (
            "transformer",
            [
                "2,3,0,'1',1,1,2,1500.0,0.01,2,'T1',1,1,1.0",
                "0.002,0.08,100.0",
                "1.0,138.0,0.0,100.0,100.0,100.0,0,0,1.1,0.9,1.1,0.9,33,0,0.0,0.0",
                "1.0,230.0",
            ],
            "magnetising branch as losses",
        ),
        ("load", ["9,'1',1,1,1,50.0,10.0,0.0,0.0,0.0,0.0,1,1"], "on bus 9, which the file lacks"),
    ],
)
def test_the_raw_reader_refuses_what_would_make_its_network_another_one(
    script: ModuleType, tmp_path: Path, section: str, records: list[str], message: str
) -> None:
    """A power flow of a file the reader did not model would be a reference for another network,
    so a file with a DC line, a FACTS device, a three-winding transformer, a phase shifter, a load
    with a constant-current part, a generator that regulates another bus, an adjustable shunt or a
    transformer whose data it does not convert stops with an error that names it."""
    with pytest.raises(script.CrosscheckError, match=message):
        _read_raw(script, tmp_path, _raw_text({section: records}))


def test_the_raw_reader_refuses_a_file_that_is_not_version_33_or_is_cut_short(
    script: ModuleType, tmp_path: Path
) -> None:
    with pytest.raises(script.CrosscheckError, match="revision 34"):
        _read_raw(script, tmp_path, _raw_text(revision=34))
    cut = "\n".join(_raw_text().splitlines()[:12]) + "\nQ\n"
    with pytest.raises(script.CrosscheckError, match="sections where version 33 has 19"):
        _read_raw(script, tmp_path, cut)
    with pytest.raises(script.CrosscheckError, match="too short"):
        _read_raw(script, tmp_path, "0, 100.00, 33\n")


def test_the_raw_reader_splits_a_line_at_its_commas_outside_quotes_and_drops_the_comment(
    script: ModuleType,
) -> None:
    assert script._raw_fields("  101,'AB, CD  ', 138.0 ,2 / the rest, is a comment") == [  # noqa: SLF001
        "101",
        "AB, CD",
        "138.0",
        "2",
    ]
    assert script._raw_number(["1", ""], 1, 7.0) == 7.0  # noqa: SLF001
    assert script._raw_number(["1"], 4) == 0.0  # noqa: SLF001


def test_the_rts_gmlc_file_has_what_its_entry_counts_and_no_dc_line(script: ModuleType) -> None:
    path = _bundled("RTS-GMLC.RAW")
    ppc = script._ppc_from_raw_file(path)  # noqa: SLF001
    assert (len(ppc["bus"]), len(ppc["gen"]), len(ppc["branch"])) == (73, 160, 120)
    assert sum(1 for g in ppc["gen"] if g[7]) == 98
    assert sum(g[3] for g in ppc["gen"] if g[7]) > 0 and ppc["baseMVA"] == 100.0
    assert sum(row[2] for row in ppc["bus"]) == pytest.approx(8550.0)
    assert sum(row[3] for row in ppc["bus"]) == pytest.approx(1740.0)
    assert sorted(row[5] for row in ppc["bus"] if row[5]) == [-100.0] * 3
    assert sum(1 for row in ppc["branch"] if row[8]) == 15 and {
        round(row[8], 3) for row in ppc["branch"] if row[8]
    } == {1.015, 1.03}
    # The one bus of the swing is bus 113, which has six of the generator records, and a type 2
    # bus with nothing in service on it was made a load bus (45 of the file's, 32 left).
    types = {int(row[0]): int(row[1]) for row in ppc["bus"]}
    assert [n for n, t in types.items() if t == 3] == [113]
    assert sum(1 for t in types.values() if t == 2) == 32
    assert sum(1 for g in ppc["gen"] if g[0] == 113) == 6
    # Its two-terminal DC section is empty, and the DC line is two generator records named DC.
    header, sections = script._raw_sections(path.read_text(encoding="ascii"))  # noqa: SLF001
    assert sections["two-terminal dc"] == [] and header[1].strip() == "100.00"
    named = [(f[0], f[2], f[14]) for f in sections["generator"] if f[1] == "DC"]
    assert named == [("113", "0.000", "1"), ("316", "0.000", "1")]


def test_andes_reads_the_rts_gmlc_file_as_the_independent_reader_does(script: ModuleType) -> None:
    """The reference solves the network the script's reader makes of the RAW file, so the reader
    is held to ANDES's: every load, shunt, generator (160, with its set-point and limits) and
    branch (120, with its tap, impedance and charging) of the file is the same in both."""
    import andes

    path = _bundled("RTS-GMLC.RAW")
    mine = script._ppc_from_raw_file(path)  # noqa: SLF001
    system = andes.load(str(path), setup=False, no_output=True, default_config=True)
    system.setup()
    base = float(system.config.mva)
    for row in mine["bus"]:
        number = int(row[0])
        loads = [k for k in range(system.PQ.n) if system.PQ.bus.v[k] == number and system.PQ.u.v[k]]
        assert sum(system.PQ.p0.v[k] for k in loads) * base == pytest.approx(row[2], abs=1e-9)
        assert sum(system.PQ.q0.v[k] for k in loads) * base == pytest.approx(row[3], abs=1e-9)
        shunts = [k for k in range(system.Shunt.n) if system.Shunt.bus.v[k] == number]
        assert sum(system.Shunt.b.v[k] for k in shunts) * base == pytest.approx(row[5], abs=1e-9)
    ours = sorted(
        (int(g[0]), round(g[1], 6), round(g[2], 6), round(g[3], 6), round(g[4], 6), round(g[5], 6), int(g[7]))
        for g in mine["gen"]
    )
    theirs = sorted(
        (
            int(model.bus.v[k]),
            round(model.p0.v[k] * base, 6),
            round(model.q0.v[k] * base, 6),
            round(model.qmax.v[k] * base, 6),
            round(model.qmin.v[k] * base, 6),
            round(model.v0.v[k], 6),
            int(model.u.v[k]),
        )
        for model in (system.PV, system.Slack)
        for k in range(model.n)
    )
    assert ours == theirs and len(ours) == 160
    line = system.Line

    def andes_branch(k: int) -> tuple[float, ...]:
        tap = line.tap.v[k] or 1.0
        ends = sorted((int(line.bus1.v[k]), int(line.bus2.v[k]))) if tap == 1.0 else [
            int(line.bus1.v[k]),
            int(line.bus2.v[k]),
        ]
        return (*ends, *(round(float(v), 9) for v in (line.r.v[k], line.x.v[k], line.b.v[k], tap)), int(line.u.v[k]))

    def my_branch(row: list[float]) -> tuple[float, ...]:
        tap = row[8] or 1.0
        ends = sorted((int(row[0]), int(row[1]))) if tap == 1.0 else [int(row[0]), int(row[1])]
        return (*ends, *(round(v, 9) for v in (row[2], row[3], row[4], tap)), int(row[10]))

    assert sorted(andes_branch(k) for k in range(line.n)) == sorted(my_branch(r) for r in mine["branch"])


def test_andes_reads_no_dc_line_from_a_raw_file_and_says_nothing_of_it(
    script: ModuleType, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A two-terminal DC line put in the file's DC section is skipped by ANDES's reader with no
    message and no model, and the script's reader refuses the file. The RTS-GMLC entry says this;
    if a release of ANDES reads DC lines this fails and the entry has to be revised."""
    import logging

    import andes

    lines = _bundled("RTS-GMLC.RAW").read_text(encoding="ascii").splitlines()
    at = next(i for i, line in enumerate(lines) if "BEGIN TWO-TERMINAL DC DATA" in line)
    record = [
        "'DC1',1,100.0,500.0,5.0,0.0,0.0,0,'I',0.0,0.0,1.0",
        "113,2,16.0,16.0,0.0,0.0,0.0,0.0,1.0,0.0,0.0,1.0,0.0,0.0,'1',0.0",
        "316,2,16.0,16.0,0.0,0.0,0.0,0.0,1.0,0.0,0.0,1.0,0.0,0.0,'1',0.0",
    ]
    with_dc = tmp_path / "with_dc.raw"
    with_dc.write_text("\n".join([*lines[: at + 1], *record, *lines[at + 1 :]]) + "\n", encoding="ascii")
    with pytest.raises(script.CrosscheckError, match="two-terminal dc data"):
        script._ppc_from_raw_file(with_dc)  # noqa: SLF001
    said: list[list[str]] = []
    for path in (_bundled("RTS-GMLC.RAW"), with_dc):
        caplog.clear()
        with caplog.at_level(logging.WARNING):
            system = andes.load(str(path), setup=True, no_output=True, default_config=True)
        said.append([r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING])
    # What it says of the file with the DC line is what it says of the file without it (the
    # five slack generators on one bus), and nothing of the line.
    assert said[0] == said[1] and "slack generators" in said[0][0]
    assert (system.Bus.n, system.Line.n, system.PV.n + system.Slack.n) == (73, 120, 160)
    assert not [name for name, model in system.models.items() if model.n and "DC" in name.upper()]


# A PSS/E report of the small system above, in the layout PSS/E prints: a block per bus, with the
# voltage and angle on its first line and the generation under it for a bus that has any.
_REPORT = """\
This report is provided by someone on a date.

 BUS      1     SWING       138.00 CKT     MW     MVAR     MVA   % 1.0400PU    0.00  X--- LOSSES ---X X---- AREA -----X
  FROM GENERATION                         70.2    12.3R   71.3  71 143.52KV               MW     MVAR    1 1
  TO    2     GEN         138.00  1     70.2    12.3     71.3  71                       0.10    0.20    1 1

 BUS      2     GEN         138.00 CKT     MW     MVAR     MVA   % 1.0200PU   -2.00  X--- LOSSES ---X X---- AREA -----X
  FROM GENERATION                         20.0     4.0H   20.4  20 140.76KV               MW     MVAR    1 1

 BUS      3     LOAD        230.00 CKT     MW     MVAR     MVA   % 0.9900PU   -4.50  X--- LOSSES ---X X---- AREA -----X
"""


def test_a_pss_e_report_gives_each_buss_voltage_and_angle_and_the_generation_of_those_with_any(
    script: ModuleType,
) -> None:
    state, generation = script.parse_psse_report(_REPORT)
    assert state == {1: (1.04, 0.0), 2: (1.02, -2.0), 3: (0.99, -4.5)}
    assert generation == {1: 70.2, 2: 20.0}
    with pytest.raises(script.CrosscheckError, match="no bus block"):
        script.parse_psse_report("nothing of the kind\n")


def test_two_raw_files_are_one_network_apart_from_what_a_power_flow_does_not_use(
    script: ModuleType, tmp_path: Path
) -> None:
    base = _read_raw(script, tmp_path, _raw_text())
    # Not compared: the state a bus is stored at, a generator out of service, the order of the
    # branches and the end a line is listed from.
    reversed_line = ["2,1,'1',0.01,0.05,0.02,100.0,100.0,100.0,0.0,0.0,0.0,0.0,1,1,10.0"]
    stored = [row.replace("1.04,0.0", "1.0431,-0.3") for row in _RAW_BASIC["bus"]]
    same = _read_raw(script, tmp_path, _raw_text({"branch": reversed_line, "bus": stored}))
    assert script.network_differences(base, same) == []
    # Compared: the dispatch, the loads, a transformer's tap, the branches, the system base.
    other_gen = _RAW_BASIC["generator"][:1] + [
        "2,'1',25.0,0.0,30.0,-30.0,1.02,0,100.0,0.0,1.0,0.0,0.0,1.0,1,100.0,100.0,0.0"
    ]
    assert "generators in service" in "; ".join(
        script.network_differences(base, _read_raw(script, tmp_path, _raw_text({"generator": other_gen})))
    )
    heavier = _read_raw(script, tmp_path, _raw_text({"load": ["3,'1',1,1,1,51.0,10.0,0,0,0,0,1,1"]}))
    assert "bus 3 differs" in "; ".join(script.network_differences(base, heavier))
    longer = _read_raw(script, tmp_path, _raw_text({"branch": [_RAW_BASIC["branch"][0].replace("0.05", "0.06")]}))
    assert "branches and transformers differ" in "; ".join(script.network_differences(base, longer))
    tapped = _RAW_BASIC["transformer"][:2] + ["1.04,138.0,0.0,100.0,100.0,100.0,0,0,1.1,0.9,1.1,0.9,33,0,0.0,0.0", "1.0,230.0"]
    assert script.network_differences(base, _read_raw(script, tmp_path, _raw_text({"transformer": tapped})))
    # A transformer's ends are not interchangeable the way a line's are.
    flipped = ["3,2,0,'1',1,1,1,0.0,0.0,2,'T1',1,1,1.0", *_RAW_BASIC["transformer"][1:]]
    assert script.network_differences(base, _read_raw(script, tmp_path, _raw_text({"transformer": flipped})))
    smaller = dict(base, baseMVA=50.0)
    assert "system base differs" in "; ".join(script.network_differences(base, smaller))


def _report_args(tmp_path: Path, **more: Any) -> SimpleNamespace:
    (tmp_path / "case.raw").write_text(_raw_text(), encoding="ascii")
    (tmp_path / "solved.raw").write_text(_raw_text(), encoding="ascii")
    (tmp_path / "report.txt").write_text(_REPORT, encoding="utf-8")
    values: dict[str, Any] = {
        "report": str(tmp_path / "report.txt"),
        "raw": str(tmp_path / "case.raw"),
        "solved_raw": str(tmp_path / "solved.raw"),
        "example": "demo",
        "origin": "a report of someone",
        "write": True,
        "reference": str(tmp_path / "demo.json"),
        "enforce_q_limits": False,
    }
    return SimpleNamespace(**{**values, **more})


def test_a_pss_e_report_is_written_as_published_checks_with_its_rounding_as_the_tolerance(
    script: ModuleType, tmp_path: Path
) -> None:
    assert script.cmd_report(_report_args(tmp_path)) == 0
    checks = json.loads((tmp_path / "demo.json").read_text(encoding="utf-8"))["checks"]
    assert [c["quantity"] for c in checks] == [
        "pf.bus_voltage_pu",
        "pf.bus_angle_deg",
        "pf.slack_p_mw",
    ]
    assert {c["kind"] for c in checks} == {"published"}
    assert {c["generated_by"] for c in checks} == {script.REPORT_BY}
    assert all("pflow" not in c for c in checks)
    assert checks[0]["expected"] == {"1": 1.04, "2": 1.02, "3": 0.99}
    assert checks[1]["expected"] == {"1": 0.0, "2": -2.0, "3": -4.5}
    assert checks[2]["expected"] == 70.2  # the generation of the swing bus
    assert [c["tolerance"]["abs"] for c in checks] == [2e-4, 0.02, 0.1]
    assert all(
        "a report of someone" in c["reference"] and "TENSA did not compute it" in c["reference"]
        and "same network and dispatch as case.raw" in c["reference"]
        for c in checks
    )


def test_a_report_solved_with_the_reactive_limits_is_written_beside_the_one_without(
    script: ModuleType, tmp_path: Path
) -> None:
    assert script.cmd_report(_report_args(tmp_path)) == 0
    assert script.cmd_report(_report_args(tmp_path, enforce_q_limits=True)) == 0
    checks = json.loads((tmp_path / "demo.json").read_text(encoding="utf-8"))["checks"]
    limited = [c for c in checks if c.get("pflow")]
    assert len(checks) == 6 and len(limited) == 3
    assert {c["generated_by"] for c in limited} == {script.REPORT_BY + script.LIMITS_FLAG}
    assert all(c["pflow"] == {"enforce_q_limits": True} for c in limited)
    assert all(c["name"].endswith(", reactive limits enforced") for c in limited)
    assert [c["tolerance"]["abs"] for c in limited] == [1e-4, 0.01, 0.1]
    assert all("run that way" in c["reference"] for c in limited)
    # Written again, each replaces its own and leaves the other.
    assert script.cmd_report(_report_args(tmp_path, enforce_q_limits=True)) == 0
    again = json.loads((tmp_path / "demo.json").read_text(encoding="utf-8"))["checks"]
    assert [c["name"] for c in again].count("Slack active power against the PSS/E solution") == 1
    assert len(again) == 6
    # The checks the script writes are the ones the reference schema takes.
    from tensa.core.example_references import parse_reference

    assert len(parse_reference((tmp_path / "demo.json").read_text(encoding="utf-8")).checks) == 6


def test_a_report_of_another_network_or_missing_a_bus_is_refused(
    script: ModuleType, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    args = _report_args(tmp_path)
    heavier = _raw_text({"load": ["3,'1',1,1,1,60.0,10.0,0.0,0.0,0.0,0.0,1,1"]})
    Path(args.solved_raw).write_text(heavier, encoding="ascii")
    with pytest.raises(script.CrosscheckError, match=r"solved.raw is not the network of case.raw: bus 3 differs"):
        script.cmd_report(args)
    Path(args.solved_raw).write_text(_raw_text(), encoding="ascii")
    Path(args.report).write_text(_REPORT.split(" BUS      3")[0], encoding="utf-8")
    with pytest.raises(script.CrosscheckError, match="no block for bus 3"):
        script.cmd_report(args)
    Path(args.report).write_text(_REPORT.replace("FROM GENERATION", "FROM OTHER"), encoding="utf-8")
    with pytest.raises(script.CrosscheckError, match="no generation for the slack"):
        script.cmd_report(args)
    # Not asked to write, it prints the checks.
    Path(args.report).write_text(_REPORT, encoding="utf-8")
    assert script.cmd_report(_report_args(tmp_path, write=False)) == 0
    assert json.loads(capsys.readouterr().out)[0]["quantity"] == "pf.bus_voltage_pu"


def test_the_stored_checks_of_a_power_flow_with_the_reactive_limits_say_so_and_ask_for_it(
    script: ModuleType,
) -> None:
    state = {"bus_voltage": {"1": 1.01}, "bus_angle": {"1": 0.5}, "slack_p_mw": 12.5}
    basis = script.STORED_BASES_ENFORCED["activsg200"]
    checks = script._stored_checks(state, "case_ACTIVSg200.m", basis, True)  # noqa: SLF001
    assert [c["pflow"] for c in checks] == [{"enforce_q_limits": True}] * 3
    assert {c["generated_by"] for c in checks} == {script.STORED_BY + script.LIMITS_FLAG}
    assert all(c["name"].endswith(", reactive limits enforced") for c in checks)
    assert [c["tolerance"]["abs"] for c in checks] == [1e-4, 0.005, 0.05]
    assert all("run with the reactive limits enforced" in c["reference"] for c in checks)
    assert all("PowerWorld Simulator's solution" in c["reference"] for c in checks)
    # The default stored checks of the same case are those that came before, with no settings.
    plain = script._stored_checks(state, "case_ACTIVSg200.m", script.STORED_BASES["activsg200"])  # noqa: SLF001
    assert all("pflow" not in c for c in plain)
    assert [c["tolerance"]["abs"] for c in plain] == [0.005, 0.05, 0.05]
    assert set(script.STORED_BASES_ENFORCED) == {"activsg200", "activsg2000"}


def test_the_stored_command_with_the_reactive_limits_needs_a_state_solved_so(
    script: ModuleType, tmp_path: Path
) -> None:
    _case_path("ieee14/ieee14_full.xlsx")  # skips without ANDES
    with pytest.raises(script.CrosscheckError, match="no stored state solved with the reactive limits"):
        script.cmd_stored(
            SimpleNamespace(id="ieee14", write=False, reference=None, enforce_q_limits=True)
        )
    target = tmp_path / "activsg200.json"
    for flag in (False, True):
        args = SimpleNamespace(id="activsg200", write=True, reference=str(target), enforce_q_limits=flag)
        assert script.cmd_stored(args) == 0
    checks = json.loads(target.read_text(encoding="utf-8"))["checks"]
    assert [c.get("pflow") for c in checks] == [{"enforce_q_limits": True}] * 3 + [None] * 3


def test_the_stored_checks_of_activsg_200_that_ship_are_what_the_script_reads_from_the_file(
    script: ModuleType,
) -> None:
    import andes

    system = andes.load(
        str(_bundled("case_ACTIVSg200.m")), setup=False, no_output=True, default_config=True
    )
    state = script.stored_solution(system)
    shipped = load_reference("activsg200")
    assert shipped is not None
    stored = [c for c in shipped.checks if c.kind == "stored-solution"]
    assert len(stored) == 6
    for check in stored:
        if check.quantity == "pf.slack_p_mw":
            assert check.expected == pytest.approx(state["slack_p_mw"], abs=1e-5)
            assert state["slack_p_mw"] == pytest.approx(384.37)
        elif check.quantity == "pf.bus_voltage_pu":
            assert check.expected == pytest.approx(state["bus_voltage"], abs=1e-8)
        else:
            assert check.expected == pytest.approx(state["bus_angle"], abs=1e-6)


@pytest.mark.skipif(
    not os.environ.get("TENSA_VERIFY_PYTHON"),
    reason="TENSA_VERIFY_PYTHON does not name a Python with pandapower",
)
@pytest.mark.parametrize(
    ("example_id", "name"),
    [
        ("rts24", "pglib_opf_case24_ieee_rts.m"),
        ("rts_gmlc", "RTS-GMLC.RAW"),
        ("activsg200", "case_ACTIVSg200.m"),
        ("pegase89", "case89pegase.m"),
        ("pegase1354", "case1354pegase.m"),
        ("activsg2000", "case_ACTIVSg2000.m"),
    ],
)
def test_pandapower_solves_the_bundled_files_to_the_values_that_ship_in_their_references(
    example_id: str, name: str
) -> None:
    """Solved from the file itself (the .m by matpowercaseframes, the RAW by the script's reader),
    with no ANDES: the reference of a bundled case holds what ``solve`` prints for its file."""
    done = subprocess.run(
        [
            os.environ["TENSA_VERIFY_PYTHON"],
            str(SCRIPTS_DIR / "crosscheck_pf.py"),
            "solve",
            str(_bundled(name)),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    solved = json.loads(done.stdout)
    assert solved["admittance_gap_pu"] < 1e-9
    shipped = load_reference(example_id)
    assert shipped is not None
    expected = {
        c.quantity: c.expected
        for c in shipped.checks
        if c.generated_by == "scripts/crosscheck_pf.py"
    }
    assert solved["bus_voltage"] == pytest.approx(expected["pf.bus_voltage_pu"], abs=1e-6)
    assert solved["bus_angle"] == pytest.approx(expected["pf.bus_angle_deg"], abs=1e-5)
    assert solved["loss_mw"] == pytest.approx(expected["pf.loss_mw"], abs=1e-5)
    assert solved["slack_p_mw"] == pytest.approx(expected["pf.slack_p_mw"], abs=1e-5)


# ---- the phase shift of a branch with a ratio of 0, and the stored states of three more files --


def _branch_row(
    f: int, t: int, tap: float, shift: float, status: float = 1.0
) -> list[float]:
    """A MATPOWER branch row: from, to, r, x, b, the three ratings, ratio, shift, status, limits."""
    return [f, t, 0.01, 0.1, 0.0, 0.0, 0.0, 0.0, tap, shift, status, -360.0, 360.0]


def test_andes_reads_a_branch_with_a_ratio_of_0_without_its_phase_shift(script: ModuleType) -> None:
    """MATPOWER reads a ratio of 0 as 1 and applies the shift; ANDES's reader calls such a branch
    a plain line and drops the shift. A branch with a ratio, or with a ratio of 1 and a shift, is a
    transformer for both, and a branch with no shift has nothing to drop."""
    branch = np.array(
        [
            _branch_row(1, 2, 0.0, 0.5),
            _branch_row(2, 3, 0.0, 0.0),
            _branch_row(3, 4, 1.02, 0.3),
            _branch_row(4, 5, 1.0, 0.2),
            _branch_row(5, 6, 0.0, -1.25, status=0.0),
        ]
    )
    ppc = {"baseMVA": 100.0, "bus": [], "gen": [], "branch": branch}
    held = script.andes_reads(ppc)
    assert held["dropped_shifts"] == [[1, 2, 0.5], [5, 6, -1.25]]
    assert list(held["branch"][:, 9]) == [0.0, 0.0, 0.3, 0.2, 0.0]
    # Nothing else changes, and the case it was given is left as it was.
    assert np.array_equal(held["branch"][:, [0, 1, 8, 10]], branch[:, [0, 1, 8, 10]])
    assert list(branch[:, 9]) == [0.5, 0.0, 0.3, 0.2, -1.25]
    assert script.andes_reads({**ppc, "branch": branch[1:4]})["dropped_shifts"] == []


def test_the_effect_of_the_dropped_shifts_names_the_worst_bus_of_each_kind(
    script: ModuleType,
) -> None:
    held = {"bus_voltage": {"1": 1.0, "2": 1.0}, "bus_angle": {"1": 0.0, "2": 5.0}}
    kept = {"bus_voltage": {"1": 1.0002, "2": 0.9999}, "bus_angle": {"1": 0.1, "2": 5.4}}
    effect = script._shift_effect(held, kept)  # noqa: SLF001
    assert effect == {
        "bus_voltage_pu": pytest.approx(2e-4),
        "bus_voltage_bus": "1",
        "bus_angle_deg": pytest.approx(0.4),
        "bus_angle_bus": "2",
    }
    # The reference says which shifts it left out and how far the solution with them is.
    result = {
        "pandapower": "3.5.6",
        "bus_voltage": held["bus_voltage"],
        "bus_angle": held["bus_angle"],
        "loss_mw": 1.0,
        "slack_p_mw": 2.0,
        "dropped_shifts": [[1, 2, 0.4]],
        "shift_effect": effect,
    }
    checks = script._reference_checks(result, "case.m")  # noqa: SLF001
    assert all("phase shift of 1 branches that have a ratio of 0 left out" in c["reference"] for c in checks)
    assert all(
        "differs from this one by at most 0.0002 pu in a bus voltage and 0.4 degrees in a bus angle"
        in c["reference"]
        for c in checks
    )
    plain = script._reference_checks({**result, "dropped_shifts": []}, "case.m")  # noqa: SLF001
    assert not any("phase shift" in c["reference"] for c in plain)


def _branch_rows(name: str) -> list[list[float]]:
    from tests.unit.test_example_catalog import _matpower_rows

    text = _bundled(name).read_text(encoding="utf-8")
    return _matpower_rows(text, "branch")


@pytest.mark.parametrize(
    ("name", "shifts"),
    [
        ("case89pegase.m", [-0.428189, 0.178581, -0.153178]),
        (
            "case1354pegase.m",
            [0.072386, -0.072388, 0.084507, -0.086984, 0.04898, -0.06138],
        ),
        ("case_ACTIVSg2000.m", []),
    ],
)
def test_andes_drops_the_shifts_the_pegase_files_give_branches_with_a_ratio_of_0(
    name: str, shifts: list[float]
) -> None:
    """The reason the references of the PEGASE cases leave six or fewer shifts out (the entries
    say so): ANDES 2.0.0 holds a branch of the file with a ratio of 0 and a shift as a line with no
    shift. If a later ANDES applies them, this fails, and the references and the caveats are
    to be rewritten."""
    import andes

    rows = _branch_rows(name)
    system = andes.load(str(_bundled(name)), setup=False, no_output=True, default_config=True)
    assert system.Line.n == len(rows)
    phi = np.degrees(np.asarray(system.Line.phi.v))
    dropped = [row[9] for row in rows if row[8] == 0.0 and row[9] != 0.0]
    assert dropped == shifts
    for k, row in enumerate(rows):
        if row[8] == 0.0:
            assert phi[k] == 0.0 and system.Line.tap.v[k] == 1.0, (name, k)
        else:
            assert system.Line.tap.v[k] == pytest.approx(row[8]), (name, k)
            assert phi[k] == pytest.approx(row[9], abs=1e-9), (name, k)


def test_the_stored_checks_leave_out_the_angle_of_the_buses_named_and_only_that(
    script: ModuleType,
) -> None:
    state = {
        "bus_voltage": {"1": 1.01, "2": 1.02, "3": 1.03},
        "bus_angle": {"1": 0.1, "2": 0.2, "3": 0.3},
        "slack_p_mw": 5.0,
    }
    basis = script.StoredBasis("somewhere", 1e-5, 0.01, 0.5, omitted=("2",))
    by = {c["quantity"]: c for c in script._stored_checks(state, "case.m", basis)}  # noqa: SLF001
    assert set(by["pf.bus_voltage_pu"]["expected"]) == {"1", "2", "3"}
    assert set(by["pf.bus_angle_deg"]["expected"]) == {"1", "3"}
    assert by["pf.slack_p_mw"]["expected"] == 5.0
    # A basis that names none leaves every bus in.
    plain = script._stored_checks(state, "case.m", script.StoredBasis("x", 1e-5, 0.01, 0.5))  # noqa: SLF001
    assert set(plain[1]["expected"]) == {"1", "2", "3"}
    assert script.STORED_BASES["pegase89"].omitted == ("8581", "7526", "2154")


@pytest.mark.parametrize(
    ("example_id", "name", "buses", "omitted"),
    [
        ("pegase89", "case89pegase.m", 89, 3),
        ("activsg2000", "case_ACTIVSg2000.m", 2000, 0),
    ],
)
def test_the_stored_checks_of_the_pegase_89_and_activsg_2000_files_that_ship_are_what_the_script_reads(
    script: ModuleType, example_id: str, name: str, buses: int, omitted: int
) -> None:
    import andes

    system = andes.load(str(_bundled(name)), setup=False, no_output=True, default_config=True)
    state = script.stored_solution(system)
    assert len(state["bus_voltage"]) == buses
    shipped = load_reference(example_id)
    assert shipped is not None
    stored = [c for c in shipped.checks if c.kind == "stored-solution" and c.pflow is None]
    assert [c.quantity for c in stored] == ["pf.bus_voltage_pu", "pf.bus_angle_deg", "pf.slack_p_mw"]
    for check in stored:
        if check.quantity == "pf.slack_p_mw":
            assert check.expected == pytest.approx(state["slack_p_mw"], abs=1e-5)
        elif check.quantity == "pf.bus_voltage_pu":
            assert check.expected == pytest.approx(state["bus_voltage"], abs=1e-8)
        else:
            assert isinstance(check.expected, dict) and len(check.expected) == buses - omitted
            for bus, angle in check.expected.items():
                assert angle == pytest.approx(state["bus_angle"][bus], abs=1e-6)
    if example_id == "activsg2000":
        assert state["slack_p_mw"] == pytest.approx(1236.1)
        # The state is also compared with a power flow that holds the generators to their limits.
        assert len([c for c in shipped.checks if c.pflow is not None]) == 3
    else:
        assert state["slack_p_mw"] == pytest.approx(1249.4)


def _stored_mismatch(script: ModuleType, name: str) -> tuple[np.ndarray, dict[str, Any], Any]:
    """What the equations of the file's network leave unaccounted for, at each bus, in the state the
    file stores (MW), with the network ANDES holds and the system."""
    import andes

    path = str(_bundled(name))
    stored = script.stored_solution(
        andes.load(path, setup=False, no_output=True, default_config=True)
    )
    system = andes.load(path, setup=True, no_output=True, default_config=True)
    network = script.dump_network(system)
    for i, idx in enumerate(network["bus_idx"]):
        system.Bus.v.v[i] = stored["bus_voltage"][str(idx)]
        system.Bus.a.v[i] = math.radians(stored["bus_angle"][str(idx)])
    mismatch = _unaccounted_power(network, system, eps=0.0) * network["baseMVA"]
    return mismatch, network, system


def test_the_stored_checks_that_ship_say_what_the_script_says_of_their_basis(
    script: ModuleType,
) -> None:
    """A reference file holds the text and the tolerance of the basis the script writes it with,
    so the script cannot change (the count of buses at a limit, say) while the file keeps the
    old words, which the catalog and the docs page then copy."""
    mapping = {
        "pf.bus_voltage_pu": "voltage",
        "pf.bus_angle_deg": "angle",
        "pf.slack_p_mw": "slack_p",
    }
    seen = 0
    for path in sorted(references_dir().glob("*.json")):
        shipped = load_reference(path.stem)
        assert shipped is not None
        for check in shipped.checks:
            if check.kind != "stored-solution":
                continue
            enforced = check.pflow is not None
            assert check.generated_by == script.STORED_BY + (script.LIMITS_FLAG if enforced else "")
            bases = script.STORED_BASES_ENFORCED if enforced else script.STORED_BASES
            basis = bases.get(shipped.id, script.RAW_BASIS)
            assert basis.origin in check.reference, f"{path.name}: {check.name}"
            assert check.tolerance.abs == getattr(basis, mapping[check.quantity]), (
                f"{path.name}: {check.name}"
            )
            seen += 1
    assert seen >= 20


def test_the_stored_state_of_activsg_2000_is_a_solution_of_the_file_s_equations(
    script: ModuleType,
) -> None:
    """The entry says no bus is left more than 0.06 MW unaccounted for, and that 153 of the 392
    buses that have a generator hold it at a reactive limit (it is PowerWorld's solution with
    the limits on, which is why a power flow without them is 0.035 pu from it)."""
    mismatch, network, _ = _stored_mismatch(script, "case_ACTIVSg2000.m")
    kinds = np.array(network["bus"])[:, 1]
    assert np.max(np.abs(mismatch[kinds == 1].real)) < 0.06
    assert np.max(np.abs(mismatch[kinds == 2].real)) < 0.06
    # The reactive power each bus gives at the stored state (what the network takes plus what the
    # dump's generation leaves over), against the limits of its generators.
    gens = np.array(network["gen"])
    held = 0
    buses_with_generator = 0
    for i in range(len(kinds)):
        rows = gens[(gens[:, 0] == i + 1) & (gens[:, 7] > 0)]
        if not len(rows):
            continue
        buses_with_generator += 1
        given = mismatch[i].imag + rows[:, 2].sum()
        if min(abs(given - rows[:, 3].sum()), abs(given - rows[:, 4].sum())) < 1e-3:
            held += 1
    assert (held, buses_with_generator) == (153, 392)


def test_the_stored_state_of_the_pegase_files_is_a_solution_only_in_part(script: ModuleType) -> None:
    """The 89-bus file's state satisfies the equations except around three buses, whose angles the
    check leaves out; the 1354-bus file's does not, at 21 buses, so no check rests on it."""
    mismatch, network, _ = _stored_mismatch(script, "case89pegase.m")
    kinds = np.array(network["bus"])[:, 1]
    active = np.abs(mismatch.real)
    active[kinds == 3] = 0.0
    assert int(np.sum(active > 0.1)) == 8
    worst = int(np.argmax(active))
    assert network["bus_idx"][worst] == 7637 and 2900 < active[worst] < 3100
    mismatch, network, _ = _stored_mismatch(script, "case1354pegase.m")
    kinds = np.array(network["bus"])[:, 1]
    active = np.abs(mismatch.real)
    active[kinds == 3] = 0.0
    assert int(np.sum(active > 0.1)) == 21 and active.max() > 1000
