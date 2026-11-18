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
    assert set(script.STORED_BASES) == {"ieee118", "ieee300"}


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
