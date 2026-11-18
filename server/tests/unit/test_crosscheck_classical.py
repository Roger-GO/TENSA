"""``scripts/crosscheck_classical.py``: the swing equations, solved with nothing of TENSA in them.

The script is the independent reference for a case whose machines are classical. It is held
here to systems whose answer is a formula: two machines joined by a reactance oscillate at
``sqrt(w_s K (1 / M1 + 1 / M2))``, and with a bolted fault at the terminal of one of them no
power leaves either, so the angle between them opens as ``w_s P (1 / M1 + 1 / M2) t^2 / 2``.
The pandapower half (the power flow that gives the model its operating point) is tested with
``crosscheck_pf.py``; the tests here hand the model the voltages directly. They skip when run
away from a checkout.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest

from tests._repo import SCRIPTS_DIR, load_module

pytestmark = pytest.mark.unit

OMEGA_S = 2 * math.pi * 60.0


@pytest.fixture(scope="module")
def script() -> ModuleType:
    return load_module("crosscheck_classical_under_test", SCRIPTS_DIR / "crosscheck_classical.py")


def _network(
    x_line: float = 0.2,
    h: tuple[float, float] = (4.0, 6.0),
    xd1: tuple[float, float] = (0.3, 0.25),
    **machines: Any,
) -> dict[str, Any]:
    """Two buses joined by a reactance, a machine on each (the dump's layout)."""
    return {
        "baseMVA": 100.0,
        "f_hz": 60.0,
        "bus_idx": [1, 2],
        "bus": [
            [1, 3, 0, 0, 0, 0, 1, 1, 0, 230, 1, 1.1, 0.9],
            [2, 2, 0, 0, 0, 0, 1, 1, 0, 230, 1, 1.1, 0.9],
        ],
        "branch": [[1, 2, 0.0, x_line, 0.0, 0, 0, 0, 0, 0, 1, -360, 360]],
        "branch_idx": ["L1"],
        "machines": {
            "classical": [
                {"idx": k + 1, "bus": k + 1, "H": h[k], "D": 0.0, "ra": 0.0, "xd1": xd1[k]}
                for k in range(2)
            ],
            "other_models": [],
            "events": [],
            **machines,
        },
    }


VOLTAGES = np.array([1.02 * np.exp(0.2j), 0.98 + 0j])


def _fault(bus: Any, tf: float, tc: float, xf: float = 1e-9) -> dict[str, Any]:
    return {"kind": "fault", "bus_idx": bus, "tf": tf, "tc": tc, "xf": xf, "rf": 0.0}


def test_two_machines_oscillate_at_the_frequency_of_their_synchronising_power(
    script: ModuleType,
) -> None:
    model = script.ClassicalModel(_network(), VOLTAGES)
    e = np.abs(model.e0)
    delta12 = np.angle(model.e0[0]) - np.angle(model.e0[1])
    x_total = 0.3 + 0.2 + 0.25
    k = e[0] * e[1] * math.cos(delta12) / x_total
    expected = math.sqrt(OMEGA_S * k * (1 / 8.0 + 1 / 12.0)) / (2 * math.pi)
    (mode,) = model.modes()  # the other two eigenvalues are the zeros of the rigid rotation
    assert mode["frequency_hz"] == pytest.approx(expected, rel=1e-9)
    assert abs(mode["damping"]) < 1e-12


def test_damping_gives_the_mode_the_ratio_of_the_swing_equation(script: ModuleType) -> None:
    """With D / M the same on both machines (here 0.5 per second) the angle between them obeys
    ``x'' + 0.5 x' + w_n^2 x = 0``, whose ratio is ``0.5 / (2 w_n)``, exactly."""
    network = _network()
    for machine, mass in zip(network["machines"]["classical"], (8.0, 12.0), strict=True):
        machine["D"] = 0.5 * mass
    (mode,) = script.ClassicalModel(network, VOLTAGES).modes()
    undamped = script.ClassicalModel(_network(), VOLTAGES).modes()[0]
    omega_n = 2 * math.pi * undamped["frequency_hz"]
    assert mode["damping"] == pytest.approx(0.5 / (2 * omega_n), rel=1e-9)
    assert mode["frequency_hz"] < undamped["frequency_hz"]


def test_the_initial_state_is_an_equilibrium_of_the_model(script: ModuleType) -> None:
    model = script.ClassicalModel(_network(), VOLTAGES)
    e = model.e0
    y_red = model.reduced()
    pe = (e * np.conj(y_red @ e)).real
    assert pe == pytest.approx(model.pm, abs=1e-12)
    # What the machines deliver at the terminals is what the network takes: the line's losses
    # are zero (a reactance), so the two powers cancel.
    assert model.pm.sum() == pytest.approx(0.0, abs=1e-12)
    # With no event the run stays where it started, as TENSA's undisturbed run must.
    run = model.simulate([], tf=1.0, step=0.05)
    assert run["max_angle_spread_deg"] == pytest.approx(run["final_angle_spread_deg"], abs=1e-9)
    assert run["frequency_nadir_hz"] == pytest.approx(60.0, abs=1e-9)
    lowest = min(np.abs(VOLTAGES))
    assert run["min_voltage_pu"] == pytest.approx(lowest, abs=1e-9)


def test_a_bolted_fault_at_a_machine_lets_the_angle_open_as_a_formula_says(
    script: ModuleType,
) -> None:
    model = script.ClassicalModel(_network(), VOLTAGES)
    before = np.degrees(np.angle(model.e0[0]) - np.angle(model.e0[1]))
    power = float(model.pm[0])
    assert power > 0
    # Fault at bus 1 from 0.1 s, and the run ends 0.05 s later with it still on: neither machine
    # delivers power (each sees a reactance to ground), so only the mechanical power acts.
    run = model.simulate([_fault(1, 0.1, 0.15)], tf=0.15, step=0.01)
    opened = np.degrees(OMEGA_S * 0.5 * power * (1 / 8.0 + 1 / 12.0) * 0.05**2)
    assert run["final_angle_spread_deg"] - before == pytest.approx(opened, rel=1e-5)
    assert run["max_angle_spread_deg"] == pytest.approx(run["final_angle_spread_deg"], abs=1e-9)
    # The faulted bus is at the fault's voltage, and the machine that gained speed is the faster.
    assert run["min_voltage_pu"] < 1e-6
    assert run["frequency_nadir_hz"] < 60.0


def test_a_line_that_trips_changes_the_network_for_the_rest_of_the_run(script: ModuleType) -> None:
    model = script.ClassicalModel(_network(), VOLTAGES)
    trip = {"kind": "toggle", "model": "Line", "dev_idx": "L1", "t": 0.2}
    # With the only line open the machines are apart: no power moves, and the angle between
    # them runs away at the speed the unbalanced mechanical powers give.
    run = model.simulate([trip], tf=1.0, step=0.01)
    assert run["final_angle_spread_deg"] > 100.0
    assert run["frequency_nadir_hz"] < 60.0
    # Opened and closed again, it is back where it was.
    again = model.simulate([trip, {**trip, "t": 0.2}], tf=1.0, step=0.01)
    assert again["max_angle_spread_deg"] == pytest.approx(again["final_angle_spread_deg"], abs=1e-6)


def test_a_case_with_other_machines_or_none_is_refused(script: ModuleType) -> None:
    with pytest.raises(script.CrosscheckError, match="GENROU"):
        script.ClassicalModel(_network(other_models=["GENROU", "TGOV1"]), VOLTAGES)
    with pytest.raises(script.CrosscheckError, match="no machine of the classical model"):
        script.ClassicalModel(_network(classical=[]), VOLTAGES)
    same = _network()
    same["machines"]["classical"][1]["bus"] = 1
    with pytest.raises(script.CrosscheckError, match="two machines on one bus"):
        script.ClassicalModel(same, VOLTAGES)


def test_a_disturbance_the_model_does_not_know_is_refused_by_name(script: ModuleType) -> None:
    model = script.ClassicalModel(_network(), VOLTAGES)
    for specs, message in (
        ([_fault(9, 0.1, 0.2)], "bus '9'"),
        ([{"kind": "toggle", "model": "Line", "dev_idx": "L9", "t": 1.0}], "'L9'"),
        ([{"kind": "toggle", "model": "GENCLS", "dev_idx": 1, "t": 1.0}], "only a Line"),
        ([{"kind": "alter", "model": "PQ", "dev_idx": 1, "src": "Ppf", "t": 1.0}], "'alter'"),
    ):
        with pytest.raises(script.CrosscheckError, match=message):
            model.simulate(specs, tf=0.5, step=0.05)


def test_the_checks_written_have_windows_that_keep_the_modes_apart_and_no_negative_zero(
    script: ModuleType,
) -> None:
    result = {
        "modes": [
            {"frequency_hz": 1.0, "damping": 0.0},
            {"frequency_hz": 1.1, "damping": -1e-18},
        ],
        "disturbance": {
            "max_angle_spread_deg": 80.0,
            "final_angle_spread_deg": 70.0,
            "min_voltage_pu": 0.001,
            "frequency_nadir_hz": 59.9,
        },
        "numpy": "2",
        "scipy": "1",
    }
    checks = script.reference_checks(result, "a case", 1 / 120)
    modes = [c for c in checks if c["quantity"].startswith("eig.")]
    assert [c["window_hz"] for c in modes] == [
        [0.95, 1.05],
        [0.95, 1.05],
        [1.05, 1.15],
        [1.05, 1.15],
    ]
    damping = [c["expected"] for c in modes if c["quantity"] == "eig.mode_damping_ratio"]
    assert [str(d) for d in damping] == ["0.0", "0.0"]
    assert all(c["kind"] == "independent-solver" for c in checks)
    assert all(c["generated_by"] == script.GENERATED_BY for c in checks)
    quantities = {c["quantity"] for c in checks if c["quantity"].startswith("tds.")}
    assert quantities == {
        "tds.max_angle_spread_deg",
        "tds.final_angle_spread_deg",
        "tds.min_voltage_pu",
        "tds.frequency_nadir_hz",
    }


def test_the_disturbance_is_read_from_the_reference_of_the_case(
    script: ModuleType, tmp_path: Path
) -> None:
    path = tmp_path / "demo.json"
    plan = {"description": "d", "specs": [_fault(1, 1.0, 1.1)], "tf": 5.0, "h": 0.01}
    path.write_text(json.dumps({"version": 1, "id": "demo", "disturbance": plan}), encoding="utf-8")
    specs, tf, step = script.load_plan(path)
    assert (specs, tf, step) == (plan["specs"], 5.0, 0.01)
    # No step given is ANDES's default; no disturbance is an error that says so.
    plan.pop("h")
    path.write_text(json.dumps({"version": 1, "id": "demo", "disturbance": plan}), encoding="utf-8")
    assert script.load_plan(path)[2] == pytest.approx(1 / 30)
    path.write_text(json.dumps({"version": 1, "id": "demo"}), encoding="utf-8")
    with pytest.raises(script.CrosscheckError, match="no disturbance"):
        script.load_plan(path)


def test_a_tg2_governor_is_refused_unless_it_is_said_to_do_nothing(script: ModuleType) -> None:
    """ANDES 2.0.0 holds a TG2's input at zero with its dead band off, so the machine keeps the
    power it started with; the check takes that on only when asked, and only for a TG2."""
    network = _network(other_models=["TG2"])
    with pytest.raises(script.CrosscheckError, match="TG2"):
        script.ClassicalModel(network, VOLTAGES)
    with pytest.raises(script.CrosscheckError, match="TG2"):
        script.ClassicalModel(network, VOLTAGES, governors="refuse")
    held = script.ClassicalModel(network, VOLTAGES, governors="inert")
    plain = script.ClassicalModel(_network(), VOLTAGES)
    assert held.modes() == plain.modes()
    # Another model beside it is still not the classical one, and the message names that one.
    with pytest.raises(script.CrosscheckError) as caught:
        script.ClassicalModel(_network(other_models=["TG2", "EXDC2"]), VOLTAGES, "inert")
    assert "EXDC2" in str(caught.value) and "TG2" not in str(caught.value)
    # Another governor is not covered by what is known of TG2.
    with pytest.raises(script.CrosscheckError, match="TGOV1"):
        script.ClassicalModel(_network(other_models=["TGOV1"]), VOLTAGES, governors="inert")


def test_the_events_of_the_case_file_are_part_of_the_disturbance(script: ModuleType) -> None:
    trip = {"kind": "toggle", "model": "Line", "dev_idx": "L1", "t": 0.2}
    network = _network(file_events=[trip])
    assert script.disturbance_events(network, []) == [trip]
    fault = _fault(1, 0.5, 0.6)
    # The file's events and the reference's act together, the file's first, as in a run of the harness.
    assert script.disturbance_events(network, [fault]) == [trip, fault]
    assert script.disturbance_events(_network(), [fault]) == [fault]
    with pytest.raises(script.CrosscheckError, match="neither the reference nor the case's file"):
        script.disturbance_events(_network(), [])


def test_a_trip_in_the_file_gives_the_run_a_trip_in_the_reference_gives(script: ModuleType) -> None:
    trip = {"kind": "toggle", "model": "Line", "dev_idx": "L1", "t": 0.2}
    model = script.ClassicalModel(_network(file_events=[trip]), VOLTAGES)
    from_file = model.simulate(
        script.disturbance_events(_network(file_events=[trip]), []), 1.0, 0.01
    )
    from_reference = model.simulate(script.disturbance_events(_network(), [trip]), 1.0, 0.01)
    assert from_file == from_reference
    quiet = model.simulate([{**trip, "t": 5.0}], tf=1.0, step=0.01)  # a trip after the run ends
    assert from_file["max_angle_spread_deg"] != pytest.approx(
        quiet["max_angle_spread_deg"], abs=1e-6
    )


def test_a_reference_with_no_specs_is_a_plan_whose_events_are_in_the_file(
    script: ModuleType, tmp_path: Path
) -> None:
    path = tmp_path / "demo.json"
    plan = {"description": "a trip in the file", "specs": [], "tf": 10.0}
    path.write_text(json.dumps({"version": 1, "id": "demo", "disturbance": plan}), encoding="utf-8")
    assert script.load_plan(path) == ([], 10.0, pytest.approx(1 / 30))
