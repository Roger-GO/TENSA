"""``scripts/verify_example_cases.py``: what it measures, how it compares and how it runs a case.

The measuring functions are held to signals whose answer is known (a ring-down made of two
damped oscillations, a trace with one drifting state). The run of a case is held to the order of
its calls and to what it reports, through a fake of the HTTP API that answers like a small
two-machine system, so no server is started here: ``tests/acceptance/test_example_cases.py``
runs the script against a real one. The tests skip when run away from a checkout.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import re
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest

from tensa.core.example_catalog import Example, parse_catalog
from tensa.core.example_references import ExampleReference, parse_reference
from tests._repo import SCRIPTS_DIR

pytestmark = pytest.mark.unit


@pytest.fixture(scope="module")
def harness() -> Iterator[ModuleType]:
    # Not ``load_module``: a dataclass of a module that is not in ``sys.modules`` cannot read
    # its own annotations, and this script has dataclasses.
    path = SCRIPTS_DIR / "verify_example_cases.py"
    if not path.is_file():
        pytest.skip("scripts/verify_example_cases.py is not next to the tests")
    name = "verify_example_cases_under_test"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop(name, None)


# ---- measuring ----------------------------------------------------------------------------


def _oscillation(t: np.ndarray, f: float, zeta: float, start: float, amplitude: float = 1.0) -> Any:
    omega = 2 * math.pi * f / math.sqrt(1 - zeta**2)
    sigma = zeta * omega
    after = np.clip(t - start, 0, None)
    return np.where(t >= start, amplitude * np.exp(-sigma * after) * np.sin(omega * after), 0.0)


def test_the_ring_down_poles_of_two_damped_oscillations_are_found(harness: ModuleType) -> None:
    t = np.arange(0, 20, 1 / 30)
    strong = _oscillation(t, 0.65, 0.03, 0.5)
    weak = _oscillation(t, 1.13, 0.09, 0.5, amplitude=0.3)
    # Three machines see them in different proportions, plus a slow drift that is no mode.
    signals = [strong + weak, -strong + 2 * weak, 0.5 * strong - weak + 1e-4 * t]
    poles = harness.ring_down_poles(t, signals, 0.5, (0.1, 3.0), 3)
    assert poles[0].frequency_hz == pytest.approx(0.65, abs=0.005)
    assert poles[0].damping == pytest.approx(0.03, abs=0.005)
    assert poles[0].relative_energy == 1.0
    second = next(p for p in poles if abs(p.frequency_hz - 1.13) < 0.05)
    assert second.damping == pytest.approx(0.09, abs=0.01)
    assert len(poles) <= 3


def test_a_pole_outside_the_band_or_too_weak_is_left_out(harness: ModuleType) -> None:
    t = np.arange(0, 20, 1 / 30)
    signal = _oscillation(t, 0.65, 0.03, 0.5) + _oscillation(t, 2.0, 0.05, 0.5, amplitude=0.001)
    in_band = harness.ring_down_poles(t, [signal], 0.5, (0.1, 1.5), 5)
    assert [round(p.frequency_hz, 2) for p in in_band] == [0.65]
    # The 2 Hz oscillation holds 1e-5 of the energy: under the 1% floor even in a wide band.
    wide = harness.ring_down_poles(t, [signal], 0.5, (0.1, 3.0), 5)
    assert [round(p.frequency_hz, 2) for p in wide] == [0.65]


def test_a_run_too_short_or_without_oscillation_has_no_poles(harness: ModuleType) -> None:
    t = np.arange(0, 0.5, 1 / 30)
    assert harness.ring_down_poles(t, [np.sin(t)], 0.0, (0.1, 3.0), 3) == []
    flat_t = np.arange(0, 20, 1 / 30)
    assert harness.ring_down_poles(flat_t, [np.zeros_like(flat_t)], 0.5, (0.1, 3.0), 3) == []


def test_a_pole_damped_more_than_the_cap_is_left_out_and_the_rest_keep_their_rank(
    harness: ModuleType,
) -> None:
    t = np.arange(0, 20, 1 / 30)
    light = _oscillation(t, 0.65, 0.03, 0.5)
    heavy = _oscillation(t, 0.9, 0.4, 0.5, amplitude=10.0)
    signal = light + heavy
    everything = harness.ring_down_poles(t, [signal], 0.5, (0.1, 3.0), 3)
    # With no cap the stronger, heavily damped oscillation comes first.
    assert everything[0].damping == pytest.approx(0.4, abs=0.05)
    capped = harness.ring_down_poles(t, [signal], 0.5, (0.1, 3.0), 3, max_damping=0.2)
    assert [round(p.frequency_hz, 2) for p in capped] == [0.65]
    # Strength is relative to the strongest pole that was kept.
    assert capped[0].relative_energy == 1.0
    assert harness.ring_down_poles(t, [heavy], 0.5, (0.1, 3.0), 3, max_damping=0.2) == []


def test_the_swing_peaks_are_the_largest_change_from_the_start_early_and_late(
    harness: ModuleType,
) -> None:
    t = np.arange(0, 20, 1 / 30)
    decaying = _oscillation(t, 0.65, 0.05, 0.5, amplitude=1e-3)
    growing = _oscillation(t, 0.65, -0.05, 0.5, amplitude=1e-3)
    early, late = harness.swing_peaks(t, [decaying], 0.5, 2.0)
    assert 5e-4 < early <= 1e-3 and late < early / 10
    early, late = harness.swing_peaks(t, [growing], 0.5, 2.0)
    assert late > 2 * early
    # The signal with the larger swing decides, and an offset from the start is the change.
    early, late = harness.swing_peaks(t, [decaying, 5 + 2 * decaying], 0.5, 2.0)
    assert early == pytest.approx(2e-3, rel=0.2)


def test_poles_are_matched_to_the_nearest_eigenvalue_in_both_frequency_and_damping(
    harness: ModuleType,
) -> None:
    modes = [(0.65, 0.034), (0.66, 0.5), (1.14, 0.089)]
    poles = [
        harness.Pole(0.651, 0.035, 1.0),
        harness.Pole(1.20, 0.09, 0.1),
        harness.Pole(0.65, 0.20, 0.1),
    ]
    first, second, third = harness.match_poles(poles, modes, 0.05, 0.05)
    assert first["matched"] and first["eigenvalue_hz"] == 0.65
    assert not second["matched"] and second["gap_hz"] == pytest.approx(0.06)
    # Right frequency, wrong damping (0.2 against 0.034 and 0.5): not a match.
    assert not third["matched"] and third["gap_damping"] > 0.05
    (empty,) = harness.match_poles(poles[:1], [], 0.05, 0.05)
    assert not empty["matched"] and empty["gap_hz"] == math.inf


def test_the_least_damped_oscillatory_mode_of_a_window(harness: ModuleType) -> None:
    eig = {
        "frequencies_hz": [0.0, 0.65, 0.65, 1.1, 1.1, 5.0],
        "damping_ratios": [1.0, 0.034, 0.034, 0.09, 0.09, 0.01],
    }
    modes = harness.oscillatory_modes(eig)
    assert (0.0, 1.0) not in modes and len(modes) == 5
    assert harness.least_damped_mode(modes, (0.3, 0.9)) == (0.65, 0.034)
    assert harness.least_damped_mode(modes, (0.3, 6.0)) == (5.0, 0.01)
    assert harness.least_damped_mode(modes, (2.0, 3.0)) is None


def _traces(**series: list[float | None]) -> dict[str, Any]:
    n = len(next(iter(series.values())))
    return {
        "t": [i / 30 for i in range(n)],
        "variables": [{"name": k.replace("_", " "), "values": v} for k, v in series.items()],
    }


def test_the_largest_change_names_the_variable_that_moved_and_skips_missing_values(
    harness: ModuleType,
) -> None:
    traces = _traces(
        omega_GENROU_1=[1.0, 1.0, 1.0, 1.0],
        delta_GENROU_1=[0.5, 0.5, 0.5001, 0.5003],
        v_Bus_1=[1.0, None, 0.9999, 1.0],
    )
    change, name = harness.largest_change(harness.trace_arrays(traces)[1])
    assert name == "delta GENROU 1" and change == pytest.approx(3e-4)
    assert harness.largest_change({}) == (0.0, None)


def test_the_disturbance_metrics_are_the_angle_spread_the_lowest_voltage_and_the_lowest_speed(
    harness: ModuleType,
) -> None:
    traces = _traces(
        delta_G_1=[0.0, 0.5, 1.0, 0.4],
        delta_G_2=[0.0, 0.0, -0.5, 0.0],
        omega_G_1=[1.0, 0.999, 0.997, 1.0],
        omega_G_2=[1.0, 1.0, 1.001, 1.0],
        v_Bus_1=[1.0, 0.5, 0.2, 0.9],
        v_Bus_2=[1.0, 0.99, 0.8, 0.95],
    )
    metrics = harness.disturbance_metrics(
        traces,
        ["delta G 1", "delta G 2"],
        ["omega G 1", "omega G 2"],
        ["v Bus 1", "v Bus 2"],
        60.0,
    )
    assert metrics["initial_angle_spread_deg"] == 0.0
    assert metrics["max_angle_spread_deg"] == pytest.approx(math.degrees(1.5))
    assert metrics["final_angle_spread_deg"] == pytest.approx(math.degrees(0.4))
    assert metrics["min_voltage_pu"] == 0.2
    assert metrics["frequency_nadir_hz"] == pytest.approx(60 * 0.997)
    assert harness.disturbance_metrics(traces, [], [], [], 60.0) == {}


# ---- comparing with a reference file ------------------------------------------------------


def _check(**changes: Any) -> Any:
    document = {
        "version": 1,
        "id": "demo",
        "disturbance": {"description": "a trip"},
        "checks": [
            {
                "name": "n",
                "quantity": "pf.slack_p_mw",
                "kind": "published",
                "reference": "a book",
                "expected": 71.64,
                "tolerance": {"abs": 0.05},
                **changes,
            }
        ],
    }
    return parse_reference(json.dumps(document)).checks[0]


def _measured(harness: ModuleType, **parts: Any) -> Any:
    return harness.Measured(**parts)


def test_a_value_inside_its_tolerance_passes_and_the_edge_is_inside(harness: ModuleType) -> None:
    check = _check()
    summary = {"summary": {"slack_p": 71.69}}
    result = harness.evaluate_reference_check(check, _measured(harness, pf=summary))
    assert result.passed and result.kind == "published" and result.reference == "a book"
    assert "difference 0.05 MW" in result.result
    over = harness.evaluate_reference_check(
        check, _measured(harness, pf={"summary": {"slack_p": 71.70}})
    )
    assert not over.passed and over.measured == 71.70 and over.expected == 71.64


def test_a_number_the_run_did_not_give_fails_with_the_reason(harness: ModuleType) -> None:
    result = harness.evaluate_reference_check(_check(), _measured(harness))
    assert not result.passed and "did not give" in result.result
    mode = _check(
        quantity="eig.mode_frequency_hz",
        window_hz=[0.3, 0.9],
        expected=0.65,
        tolerance={"abs": 0.01},
    )
    result = harness.evaluate_reference_check(mode, _measured(harness, modes=[(1.1, 0.09)]))
    assert not result.passed and "no oscillatory eigenvalue between 0.3 and 0.9 Hz" in result.result
    found = harness.evaluate_reference_check(mode, _measured(harness, modes=[(0.655, 0.03)]))
    assert found.passed and found.measured == 0.655


def test_a_per_bus_value_is_compared_in_degrees_and_the_worst_bus_is_named(
    harness: ModuleType,
) -> None:
    check = _check(
        quantity="pf.bus_angle_deg", expected={"1": 0.0, "2": -5.0}, tolerance={"abs": 0.01}
    )
    pf = {"bus_angles": {"1": 0.0, "2": math.radians(-5.004)}}
    result = harness.evaluate_reference_check(check, _measured(harness, pf=pf))
    assert result.passed and "(bus 2)" in result.result and "over 2 buses" in result.result
    pf["bus_angles"]["2"] = math.radians(-5.02)
    result = harness.evaluate_reference_check(check, _measured(harness, pf=pf))
    assert not result.passed and "1 outside the tolerance" in result.result
    del pf["bus_angles"]["2"]
    result = harness.evaluate_reference_check(check, _measured(harness, pf=pf))
    assert not result.passed and "1 buses are not in the result: 2" in result.result


def test_a_regression_baseline_says_it_verifies_nothing(harness: ModuleType) -> None:
    check = _check(quantity="tds.min_voltage_pu", kind="regression-baseline", expected=0.87)
    result = harness.evaluate_reference_check(
        check, _measured(harness, tds={"min_voltage_pu": 0.87})
    )
    assert result.passed and result.kind == "regression-baseline"
    assert "not a verification" in result.reference


# ---- the report ---------------------------------------------------------------------------


def _result(harness: ModuleType, *flags: tuple[str, bool]) -> Any:
    result = harness.CaseResult(
        id="demo", title="Demo | case", file="demo.xlsx", analyses=["pf"], reference_file=None
    )
    for kind, passed in flags:
        result.add(harness.Check("a | b", "pf", kind, "ref", "tol", "res", passed))
    return result


def test_the_report_counts_what_is_a_reference_a_baseline_and_a_sanity_check(
    harness: ModuleType,
) -> None:
    good = _result(
        harness, ("sanity", True), ("independent-solver", True), ("regression-baseline", True)
    )
    bad = _result(harness, ("ring-down", False))
    bad.error = "boom"
    report = harness.build_report(
        [good, bad], {"version": "1", "andes_version": "2"}, "u", True, 1.0
    )
    assert report["counts"] == {
        "cases": 2,
        "cases_failed": 1,
        "checks": 4,
        "checks_failed": 1,
        "against_a_reference": 2,
        "regression_baselines": 1,
        "sanity": 1,
    }
    assert report["passed"] is False
    assert [c["passed"] for c in report["cases"]] == [True, False]
    page = harness.render_markdown(report)
    assert "There are failed checks" in page and "boom" in page
    # A pipe in a name does not break the table, and no long dash is written.
    assert "a \\| b" in page and "Demo \\| case" in page
    assert "—" not in page and "–" not in page
    assert json.loads(json.dumps(report))["cases"][1]["error"] == "boom"


def test_a_case_with_an_error_does_not_pass_even_when_every_check_did(harness: ModuleType) -> None:
    result = _result(harness, ("sanity", True))
    assert result.passed
    result.error = "the server went away"
    assert not result.passed


def test_baselines_are_recorded_and_nothing_else_is_touched(
    harness: ModuleType, tmp_path: Path
) -> None:
    def check(name: str, kind: str, expected: float) -> dict[str, Any]:
        return {
            "name": name,
            "quantity": "tds.min_voltage_pu",
            "kind": kind,
            "reference": "r",
            "expected": expected,
            "tolerance": {"abs": 0.01},
        }

    document = {
        "version": 1,
        "id": "demo",
        "disturbance": {"description": "x"},
        "checks": [
            check("baseline", "regression-baseline", 0.0),
            check("published", "published", 0.5),
        ],
    }
    path = tmp_path / "demo.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    result = harness.CaseResult("demo", "Demo", "demo.xlsx", ["pf", "tds"])
    measurements = {"demo": harness.Measured(tds={"min_voltage_pu": 0.8731234567})}
    assert harness.record_baselines([result], measurements, tmp_path) == ["demo.json"]
    after = json.loads(path.read_text(encoding="utf-8"))
    assert after["checks"][0]["expected"] == 0.87312346
    assert after["checks"][1]["expected"] == 0.5
    # Nothing measured, nothing written; a case with no file is skipped.
    assert harness.record_baselines([result], {"demo": harness.Measured()}, tmp_path) == []
    other = harness.CaseResult("absent", "Absent", None, [])
    assert harness.record_baselines([other], {"absent": harness.Measured()}, tmp_path) == []


def test_the_cases_are_chosen_by_id_by_default_flag_or_all_with_a_file(
    harness: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert [e.id for e in harness.select_examples([], True)] == [
        e.id for e in harness.load_catalog().defaults()
    ]
    assert all(e.has_file for e in harness.select_examples([], False))
    assert [e.id for e in harness.select_examples(["wscc9"], False)] == ["wscc9"]
    with pytest.raises(ValueError, match="no example case 'nope'"):
        harness.select_examples(["nope"], False)
    link = {
        "id": "library",
        "title": "A library",
        "summary": "Links only.",
        "category": "steady-state",
        "provenance": {"kind": "external"},
        "licence": {"name": "terms"},
        "links": [{"title": "Home", "url": "https://example.org/"}],
    }
    monkeypatch.setattr(
        harness,
        "load_catalog",
        lambda: parse_catalog(json.dumps({"version": 1, "examples": [link]})),
    )
    with pytest.raises(ValueError, match="only links"):
        harness.select_examples(["library"], False)


# ---- the HTTP client ----------------------------------------------------------------------


@pytest.mark.integration  # it listens on a loopback socket
def test_an_error_status_becomes_an_api_error_with_the_servers_detail(harness: ModuleType) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = json.dumps({"detail": "already there; send overwrite=true"}).encode()
            self.send_response(409)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            body = json.dumps({"seen": self.path}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        api = harness.Api(f"http://127.0.0.1:{server.server_address[1]}/")
        with pytest.raises(harness.ApiError) as raised:
            api.post("/examples/x/add", overwrite=True)
        assert raised.value.status == 409 and "send overwrite=true" in raised.value.detail
        # Booleans go out as the words the API reads, and the base gets the /api prefix.
        assert api.get("/health", full=True) == {"seen": "/api/health?full=true"}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


# ---- running a case against a fake of the API ---------------------------------------------


class FakeApi:
    """The API of a small system: two machines, three buses, two loads and one event of its file.

    ``log`` is every call in order. A time-domain run answers with traces that are flat when no
    event stands and the load has not been stepped, swing at the mode the eigenvalue analysis
    reports once the load is stepped, and lose voltage and move a rotor when the event stands,
    so the flows that the script has to keep apart give answers that tell them apart. The
    variable listing is the route's: the buses first, 100 to a page when no ``limit`` is asked
    for, 1000 at most, with the ``total`` it holds.
    """

    MODE = (0.65, 0.034)

    def __init__(self, harness: ModuleType) -> None:
        self.harness = harness
        self.log: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.specs: list[dict[str, Any]] = []
        self.file_has_event = True
        self.machines = True
        self.tds_requests: list[list[str]] = []
        self.tds_steps: list[float | None] = []
        self.drift = 0.0
        self.grow = 0.0  # growth rate (per second) of the swing after the load step
        self.pf_converged = True
        self.limits_converge = True  # whether a power flow with the reactive limits converges
        self.pflow_bodies: list[Any] = []
        self.tds_converged = True
        self.fail_add: int | None = None
        self.bus_padding = 0  # buses in the listing beyond the three, ahead of the machines
        self.overstates = 0  # how many more variables the listing claims than it holds
        self.listing_calls: list[dict[str, int]] = []
        self.open_sessions: list[str] = []
        self.damping_shift: dict[str, float] = {}  # added to the mode's damping, by session
        self.eig_empty = False  # the eigenvalue analysis answers with no eigenvalue at all
        self.reload_world()

    def reload_world(self) -> None:
        self.specs = []
        self.events = (
            [
                {
                    "source": "case",
                    "kind": "toggle",
                    "t": 2.0,
                    "name": "Toggler_1",
                    "model": "Line",
                    "dev_idx": "L1",
                }
            ]
            if self.file_has_event
            else []
        )

    def topology(self) -> dict[str, Any]:
        return {
            "state": "pre-setup",
            "buses": [{"idx": i} for i in (1, 2, 3)],
            "loads": [
                {"idx": "PQ_1", "kind": "PQ", "params": {"p0": 0.4}},
                {"idx": "PQ_2", "kind": "PQ", "params": {"p0": 1.5}},
            ],
            "events": list(self.events),
            "freq_hz": 60.0,
        }

    # The three calls of the real client, over ``call``.
    def get(self, path: str, **query: Any) -> Any:
        return self.call("GET", path, None, **query)

    def post(self, path: str, body: Any = None, **query: Any) -> Any:
        return self.call("POST", path, {} if body is None else body, **query)

    def delete(self, path: str) -> Any:
        return self.call("DELETE", path)

    def call(self, method: str, path: str, body: Any = None, **query: Any) -> Any:
        self.log.append(f"{method} {path}")
        if method == "DELETE" and re.fullmatch(r"/sessions/s\d+", path):
            if path.rsplit("/", 1)[1] in self.open_sessions:
                self.open_sessions.remove(path.rsplit("/", 1)[1])
            return None
        if path.startswith("/examples/") and path.endswith("/add"):
            if self.fail_add:
                raise self.harness.ApiError(method, path, self.fail_add, "no space left")
            return {
                "primary": "demo.xlsx",
                "files": [{"name": "demo.xlsx", "size_bytes": 1, "replaced": True}],
                "warnings": [],
            }
        if path == "/sessions":
            # One session is s1, and a second opened beside it is s2.
            sid = f"s{len(self.open_sessions) + 1}"
            self.open_sessions.append(sid)
            return {"session_id": sid}
        if path.endswith(("/case", "/reload")):
            self.reload_world()
            return self.topology()
        if path.endswith("/topology"):
            return self.topology()
        if "/elements/Toggle/" in path:
            self.events = []
            return None
        if path.endswith("/disturbances"):
            self.specs = list(body["disturbances"])
            return {"accepted": []}
        if path.endswith("/pflow"):
            self.pflow_bodies.append(body)
            # With the reactive limits enforced the solution is a little different.
            limited = bool((body or {}).get("enforce_q_limits"))
            return {
                "converged": self.limits_converge if limited else self.pf_converged,
                "iterations": 3,
                "mismatch": 1e-9,
                "bus_voltages": {"1": 1.04, "2": 1.021 if limited else 1.02, "3": 1.0},
                "bus_angles": {"1": 0.0, "2": math.radians(-3.0), "3": math.radians(-5.0)},
                "summary": {"loss_p": 2.5, "slack_p": 80.5 if limited else 80.0},
            }
        if path.endswith("/dae-variables"):
            limit, offset = int(query.get("limit", 100)), int(query.get("offset", 0))
            if not 1 <= limit <= 1000 or offset < 0:
                raise self.harness.ApiError(method, path, 422, "limit or offset out of range")
            self.listing_calls.append({"limit": limit, "offset": offset})
            items = self.variables()
            return {"total": len(items) + self.overstates, "items": items[offset : offset + limit]}
        if path.endswith("/eig") and self.eig_empty:
            return {"eigenvalues": [], "frequencies_hz": [], "damping_ratios": [], "mode_count": 0}
        if path.endswith("/eig"):
            f, z = self.MODE
            return {
                "eigenvalues": [{"real": -z * 4.0, "imag": 4.0}, {"real": -z * 4.0, "imag": -4.0}],
                "frequencies_hz": [f, f, 0.0],
                "damping_ratios": [z, z, 1.0],
                "mode_count": 3,
            }
        if path.endswith("/tds"):
            return self.tds(body, path.split("/")[2])
        raise AssertionError(f"the fake has no answer for {method} {path}")

    def variables(self) -> list[dict[str, Any]]:
        """The listing in the order of the real one: the buses, then the machines' states."""
        items = [
            {"name": f"{var} Bus {i}", "kind": "y", "model": "Bus", "var": var, "idx": i}
            for i in range(1, 4 + self.bus_padding)
            for var in ("v", "a")
        ]
        items += [
            {"name": f"{var} GENROU {i}", "kind": "x", "model": "GENROU", "var": var, "idx": i}
            for i in (1, 2)
            for var in ("delta", "omega")
            if self.machines
        ]
        return items

    def tds(self, body: dict[str, Any], sid: str = "s1") -> dict[str, Any]:
        self.tds_requests.append(list(body["dae_vars"]))
        self.tds_steps.append(body.get("h"))
        tf = float(body["tf"])
        t = np.arange(0, tf + 1e-9, 1 / 30)
        stepped = any(s.get("src") == "Req" for s in self.specs)
        f, z = self.MODE
        z += self.damping_shift.get(sid, 0.0)
        swing = _oscillation(t, f, z - self.grow / (2 * math.pi * f), 0.5, amplitude=1e-3)
        swing = swing if stepped else np.zeros_like(t)
        tripped = np.where(t >= 2.0, 1.0, 0.0) if self.events else np.zeros_like(t)
        values: list[dict[str, Any]] = []
        for name in body["dae_vars"]:
            idx = name.split()[-1]
            if name.startswith("omega"):
                series = 1.0 + (1.0 if idx == "1" else -1.0) * swing
            elif name.startswith("delta"):
                series = 0.5 * float(idx) + (0.3 * tripped if idx == "1" else 0.0 * t)
            else:
                series = 1.0 - 0.1 * tripped + self.drift * t / max(tf, 1.0)
            values.append({"name": name, "values": [float(x) for x in series]})
        return {
            "run_id": "r",
            "converged": self.tds_converged,
            "final_t": float(t[-1]),
            "callpert_count": len(t),
            "traces": {"t": [float(x) for x in t], "variables": values},
        }


@pytest.fixture
def fake(harness: ModuleType) -> FakeApi:
    return FakeApi(harness)


def _example(**changes: Any) -> Example:
    entry: dict[str, Any] = {
        "id": "demo",
        "title": "Demo",
        "summary": "A small system.",
        "category": "dynamic",
        "size": {"buses": 3, "generators": 2},
        "analyses": ["pf", "tds", "eig"],
        "provenance": {"kind": "andes", "path": "demo/demo.xlsx", "sha256": "0" * 64},
        "licence": {"name": "GPL-3.0-or-later"},
        **changes,
    }
    catalog = parse_catalog(json.dumps({"version": 1, "examples": [entry]}))
    return catalog.examples[0]


def _reference(**changes: Any) -> ExampleReference:
    document: dict[str, Any] = {
        "version": 1,
        "id": "demo",
        "remove_events": [{"model": "Toggle", "idx": 1}],
        "disturbance": {"description": "Line L1 trips at 2 s"},
        "checks": [
            {
                "name": "Bus voltage magnitudes",
                "quantity": "pf.bus_voltage_pu",
                "kind": "independent-solver",
                "reference": "a solver",
                "expected": {"1": 1.04, "2": 1.02, "3": 1.0},
                "tolerance": {"abs": 1e-4},
            },
            {
                "name": "Lowest voltage",
                "quantity": "tds.min_voltage_pu",
                "kind": "regression-baseline",
                "reference": "TENSA's own earlier output",
                "expected": 0.9,
                "tolerance": {"abs": 1e-3},
            },
            {
                "name": "Inter-area mode",
                "quantity": "eig.mode_frequency_hz",
                "kind": "published",
                "reference": "a paper",
                "expected": 0.65,
                "tolerance": {"abs": 0.01},
                "window_hz": [0.3, 0.9],
            },
        ],
        **changes,
    }
    return parse_reference(json.dumps(document))


def _run(harness: ModuleType, fake: FakeApi, reference: Any = ..., **kwargs: Any) -> Any:
    reference = _reference() if reference is ... else reference
    return harness.verify_case(fake, _example(), reference, replace_file=True, **kwargs)


def test_a_case_that_behaves_passes_every_check(harness: ModuleType, fake: FakeApi) -> None:
    result, measured = _run(harness, fake)
    failed = [(c.name, c.result) for c in result.checks if not c.passed]
    assert result.passed, failed
    names = [c.name for c in result.checks]
    assert names[:3] == [
        "Case adds from the catalog",
        "Opens with the size the catalog states",
        "Power flow converges",
    ]
    kinds = {c.kind for c in result.checks}
    assert {
        "sanity",
        "ring-down",
        "independent-solver",
        "regression-baseline",
        "published",
    } <= kinds
    assert result.file == "demo.xlsx" and result.reference_file == "references/demo.json"
    assert measured.pf is not None and measured.tds is not None and measured.modes


def test_the_undisturbed_runs_have_the_events_taken_out_and_the_disturbance_run_keeps_them(
    harness: ModuleType, fake: FakeApi
) -> None:
    _run(harness, fake)
    tokens = {"/reload": "R", "/elements/Toggle/1": "D", "/tds": "T", "/eig": "E"}
    seen = [
        next(t for ending, t in tokens.items() if call.endswith(ending))
        for call in fake.log
        if call.endswith(tuple(tokens))
    ]
    # Undisturbed run, eigenvalues and ring-down: reload, take the event out, run. The case's
    # own disturbance: reload and run, with the event in.
    assert "".join(seen) == "RDTRDERDTRT"
    assert fake.log.count("POST /sessions/s1/pflow") == 5  # the open and one for each run
    assert fake.log[-1] == "DELETE /sessions/s1"


def test_the_step_a_reference_asks_for_goes_to_the_disturbance_run_and_to_no_other(
    harness: ModuleType, fake: FakeApi
) -> None:
    reference = _reference(disturbance={"description": "Line L1 trips at 2 s", "h": 0.005})
    result, _ = _run(harness, fake, reference)
    # The undisturbed run and the ring-down use TENSA's default step; the disturbance, the last
    # run, the one the reference gives.
    assert fake.tds_steps == [None, None, 0.005]
    run = next(c for c in result.checks if c.name == "Disturbance run completes")
    assert "at a step of 0.005 s" in run.reference
    # With none given, no run is asked for a step.
    _run(harness, fake)
    assert fake.tds_steps[3:] == [None, None, None]


def test_a_disturbance_that_must_end_where_it_began_is_held_to_its_initial_spread(
    harness: ModuleType, fake: FakeApi
) -> None:
    # The event of the fake moves one rotor by 0.3 rad, so the spread goes from 28.6 to 11.5
    # degrees: a run that is stable by the absolute bound and has not come back.
    name = "Disturbance run ends where it began"
    none, _ = _run(harness, fake)
    assert name not in [c.name for c in none.checks]
    strict = _reference(disturbance={"description": "a trip", "settles_within_deg": 5.0})
    result, _ = _run(harness, fake, strict)
    check = next(c for c in result.checks if c.name == name)
    assert not check.passed and not result.passed
    assert "initial spread 28.65 deg, final 11.46 deg" in check.result
    stable = next(c for c in result.checks if c.name == "Disturbance run stays stable")
    assert stable.passed
    loose = _reference(disturbance={"description": "a trip", "settles_within_deg": 20.0})
    result, _ = _run(harness, fake, loose)
    assert next(c for c in result.checks if c.name == name).passed


def test_a_ring_down_that_grows_fails_and_one_that_dies_out_passes(
    harness: ModuleType, fake: FakeApi
) -> None:
    name = "The small disturbance does not grow"
    result, _ = _run(harness, fake)
    assert next(c for c in result.checks if c.name == name).passed
    fake.grow = 0.3  # a mode at +0.3 per second: 0.5 s to 20 s is a factor of 300
    result, _ = _run(harness, fake)
    check = next(c for c in result.checks if c.name == name)
    assert not check.passed and not result.passed
    assert check.kind == "sanity" and "the last swing at most 2 times the first" in check.tolerance


def test_a_cap_on_the_pole_damping_is_applied_and_said(harness: ModuleType, fake: FakeApi) -> None:
    name = "Ring-down of a small disturbance has the frequency and damping of eigenvalues"
    capped = _reference(ring_down={"max_damping_ratio": 0.01})
    result, _ = _run(harness, fake, capped)
    check = next(c for c in result.checks if c.name == name)
    # The fake's oscillation is damped 0.034, which the cap leaves out.
    assert not check.passed and "no oscillation between" in check.result
    assert "poles damped over 0.01 are not compared" in check.reference
    roomy = _reference(ring_down={"max_damping_ratio": 0.2})
    result, _ = _run(harness, fake, roomy)
    assert next(c for c in result.checks if c.name == name).passed


def test_an_event_id_with_odd_characters_goes_into_the_path_quoted(
    harness: ModuleType, fake: FakeApi
) -> None:
    reference = _reference(remove_events=[{"model": "Toggle", "idx": "Toggler 1/a"}])
    _run(harness, fake, reference)
    assert "DELETE /sessions/s1/elements/Toggle/Toggler%201%2Fa" in fake.log


def test_more_variables_than_the_api_records_are_cut_and_said_so(
    harness: ModuleType, fake: FakeApi, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two machines, so four variables: the limit of six leaves room for two bus voltages.
    monkeypatch.setattr(harness, "MAX_DAE_VARS", 6)
    result, _ = _run(harness, fake)
    assert any("first 2 buses only" in n for n in result.notes)
    assert any("first 6 states and bus values only" in n for n in result.notes)
    assert result.passed, [(c.name, c.result) for c in result.checks if not c.passed]
    sizes = [len(c) for c in fake.tds_requests]
    assert max(sizes) <= 6


def test_machines_beyond_the_first_hundred_variables_are_still_found(
    harness: ModuleType, fake: FakeApi
) -> None:
    # 60 buses are 120 variables, so the machines are items 121 to 124 of the listing and the
    # route's page of 100 has none of them.
    fake.bus_padding = 57
    result, measured = _run(harness, fake)
    assert result.passed, [(c.name, c.result) for c in result.checks if not c.passed]
    ring = next(c for c in result.checks if c.name.startswith("Ring-down"))
    assert ring.passed and "no synchronous machine" not in ring.result
    assert measured.tds is not None and "max_angle_spread_deg" in measured.tds
    # The undisturbed run records the machines' states along with the buses.
    assert {"delta GENROU 1", "omega GENROU 2", "v Bus 60"} <= set(fake.tds_requests[0])
    assert all(call["limit"] == 1000 for call in fake.listing_calls)


def test_a_listing_of_more_than_one_page_is_read_to_its_end(
    harness: ModuleType, fake: FakeApi, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(harness, "LISTING_PAGE", 7)
    result, _ = _run(harness, fake)
    # Ten variables: a page of seven and one of three.
    assert fake.listing_calls == [{"limit": 7, "offset": 0}, {"limit": 7, "offset": 7}]
    assert result.passed, [(c.name, c.result) for c in result.checks if not c.passed]
    assert "omega GENROU 2" in fake.tds_requests[0]


def test_a_listing_that_ends_before_its_total_is_not_asked_for_forever(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.overstates = 50
    result, _ = _run(harness, fake)
    assert fake.listing_calls == [
        {"limit": 1000, "offset": 0},
        {"limit": 1000, "offset": 10},
    ]
    assert result.passed, [(c.name, c.result) for c in result.checks if not c.passed]


def test_a_case_with_no_synchronous_machine_has_no_ring_down_to_check(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.machines = False
    result, _ = _run(harness, fake)
    bad = next(c for c in result.checks if c.name.startswith("Ring-down"))
    assert not bad.passed and "no synchronous machine" in bad.result


def test_an_event_the_reference_does_not_name_is_reported_and_fails_the_case(
    harness: ModuleType, fake: FakeApi
) -> None:
    result, _ = _run(harness, fake, _reference(remove_events=[]))
    bad = next(c for c in result.checks if c.name.startswith("The events of the file"))
    assert not bad.passed and "Toggler_1" in bad.result and "remove_events" in bad.result
    assert not result.passed


def test_a_state_that_drifts_in_the_undisturbed_run_fails_the_flat_check(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.drift = 5e-4
    result, _ = _run(harness, fake)
    flat = next(c for c in result.checks if c.name.startswith("Undisturbed run stays"))
    assert not flat.passed and "largest change" in flat.result and "Bus" in flat.result


def test_a_run_that_stops_short_fails_the_completion_checks(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.tds_converged = False
    result, _ = _run(harness, fake)
    failed = {c.name for c in result.checks if not c.passed}
    assert "Undisturbed 10 s run completes" in failed and "Disturbance run completes" in failed


def test_a_power_flow_that_does_not_converge_skips_the_dynamic_runs(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.pf_converged = False
    result, _ = _run(harness, fake)
    assert not result.passed
    assert not any(c.endswith("/tds") or c.endswith("/eig") for c in fake.log)
    assert any("did not converge" in n for n in result.notes)


def test_a_reference_value_the_run_misses_fails_that_check_alone(
    harness: ModuleType, fake: FakeApi
) -> None:
    document = _reference().model_dump(mode="json")
    document["checks"][2]["expected"] = 0.8
    result, _ = _run(harness, fake, ExampleReference.model_validate(document))
    failed = [c.name for c in result.checks if not c.passed]
    assert failed == ["Inter-area mode"]


def test_a_case_with_no_disturbance_to_run_is_reported_as_such(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.file_has_event = False
    reference = _reference(remove_events=[], disturbance={"description": "nothing"})
    result, _ = _run(harness, fake, reference)
    bad = next(c for c in result.checks if c.name == "The case has a disturbance to run")
    assert not bad.passed and not result.passed


def test_a_case_without_a_reference_is_run_and_says_what_is_missing(
    harness: ModuleType, fake: FakeApi
) -> None:
    result, _ = _run(harness, fake, None)
    assert result.reference_file is None
    assert any("No reference file" in n for n in result.notes)
    # Its own event is on the case file and is not named, so the undisturbed run says so.
    assert not result.passed


def test_an_error_from_the_server_is_the_cases_error_and_the_session_is_still_closed(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.fail_add = 500
    result, _ = _run(harness, fake)
    assert not result.passed and "500" in (result.error or "")

    other = FakeApi(harness)
    original = other.call

    def boom(method: str, path: str, body: Any = None, **query: Any) -> Any:
        if path.endswith("/pflow"):
            raise harness.ApiError(method, path, 409, "case not loaded")
        return original(method, path, body, **query)

    other.call = boom  # type: ignore[method-assign]
    result, _ = _run(harness, other)
    assert "409" in (result.error or "") and not result.passed
    assert other.log[-1] == "DELETE /sessions/s1"


def test_a_file_the_workspace_already_holds_is_used_and_said_so(
    harness: ModuleType, fake: FakeApi
) -> None:
    original = fake.call

    def held(method: str, path: str, body: Any = None, **query: Any) -> Any:
        if path.endswith("/add"):
            raise harness.ApiError(method, path, 409, "exists")
        return original(method, path, body, **query)

    fake.call = held  # type: ignore[method-assign]
    result, _ = harness.verify_case(fake, _example(), _reference(), replace_file=False)
    assert result.file == "demo.xlsx"
    assert any("already held" in n for n in result.notes)


def _limited_check(**changes: Any) -> dict[str, Any]:
    """A check of the voltages the power flow gives with the reactive limits enforced."""
    return {
        "name": "Bus voltage magnitudes, reactive limits enforced",
        "quantity": "pf.bus_voltage_pu",
        "kind": "published",
        "reference": "a report solved with the limits",
        "expected": {"1": 1.04, "2": 1.021, "3": 1.0},
        "tolerance": {"abs": 1e-4},
        "pflow": {"enforce_q_limits": True},
        **changes,
    }


def _static_reference(*checks: dict[str, Any]) -> ExampleReference:
    return parse_reference(json.dumps({"version": 1, "id": "demo", "checks": list(checks)}))


def _static_example() -> Example:
    return _example(category="steady-state", analyses=["pf"])


def test_a_check_with_power_flow_settings_reads_a_run_made_with_them(
    harness: ModuleType, fake: FakeApi
) -> None:
    """The first check reads the power flow at the defaults and the second one made with the
    reactive limits enforced, whose voltage at bus 2 is 1.021 and not 1.02: each passes only
    against its own run, and the second run has a session of its own, which is closed."""
    reference = _static_reference(
        {
            **_limited_check(),
            "name": "At the defaults",
            "pflow": None,
            "expected": {"1": 1.04, "2": 1.02, "3": 1.0},
        },
        _limited_check(),
        _limited_check(
            name="Slack power, reactive limits enforced", quantity="pf.slack_p_mw", expected=80.5
        ),
    )
    result, measured = harness.verify_case(fake, _static_example(), reference, replace_file=True)
    failed = [(c.name, c.result) for c in result.checks if not c.passed]
    assert result.passed, failed
    assert fake.pflow_bodies == [{}, {"enforce_q_limits": True}]
    # Two checks name the same settings and ask for one run, in a session that is not the first.
    assert fake.log.count("POST /sessions/s2/pflow") == 1 and "DELETE /sessions/s2" in fake.log
    assert len(measured.pf_runs) == 1
    sanity = [c.name for c in result.checks if c.kind == "sanity"]
    assert "Power flow converges with reactive limits enforced" in sanity
    # The report says what each was held to.
    limited = next(
        c for c in result.checks if c.name == "Bus voltage magnitudes, reactive limits enforced"
    )
    assert "largest difference 0 pu" in limited.result


def test_a_check_with_settings_fails_when_it_is_only_true_of_the_defaults(
    harness: ModuleType, fake: FakeApi
) -> None:
    reference = _static_reference(
        _limited_check(expected={"1": 1.04, "2": 1.02, "3": 1.0}),
    )
    result, _ = harness.verify_case(fake, _static_example(), reference, replace_file=True)
    check = next(c for c in result.checks if c.name.startswith("Bus voltage magnitudes"))
    assert not check.passed and "1 outside the tolerance" in check.result


def test_a_power_flow_with_settings_that_does_not_converge_fails_its_checks_and_says_so(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.limits_converge = False
    result, _ = harness.verify_case(
        fake, _static_example(), _static_reference(_limited_check()), replace_file=True
    )
    sanity = next(
        c for c in result.checks if c.name == "Power flow converges with reactive limits enforced"
    )
    assert not sanity.passed and "converged False" in sanity.result
    assert not result.passed


def test_no_power_flow_is_run_again_for_a_reference_that_gives_no_settings(
    harness: ModuleType, fake: FakeApi
) -> None:
    result, measured = _run(harness, fake)
    assert result.passed and measured.pf_runs == {}
    assert all(body in ({}, None) for body in fake.pflow_bodies)


def test_the_settings_of_a_power_flow_are_a_key_and_words(harness: ModuleType) -> None:
    plain = _static_reference(_limited_check(pflow=None)).checks[0]
    limited = _static_reference(_limited_check()).checks[0]
    assert (
        harness.pflow_key(plain) is None
        and harness.pflow_key(limited) == '{"enforce_q_limits": true}'
    )
    assert harness.pflow_words(limited) == "reactive limits enforced"
    assert harness.pflow_words(plain) == "its defaults"
    # Settings that say what the defaults say are the defaults: no second run of one power flow.
    explicit = _static_reference(_limited_check(pflow={"enforce_q_limits": False})).checks[0]
    assert harness.pflow_key(explicit) is None
    assert harness.pflow_words(explicit) == "its defaults"
    measured = harness.Measured(pf={"a": 1}, pf_runs={'{"enforce_q_limits": true}': {"b": 2}})
    assert measured.pf_for(plain) == {"a": 1} and measured.pf_for(limited) == {"b": 2}
    assert harness.Measured().pf_for(limited) is None


# ---- the checks of a case in the catalog ---------------------------------------------------


def test_a_case_lists_in_the_catalog_the_checks_that_name_a_reference(
    harness: ModuleType, fake: FakeApi
) -> None:
    from tensa.core.example_catalog import VerificationCheck

    result, _ = _run(harness, fake)
    checks = harness.catalog_checks(result)
    # The sanity checks need no reference and the catalog has no kind for them.
    assert len(checks) == len([c for c in result.checks if c.kind != "sanity"])
    assert {c["kind"] for c in checks} == {
        "ring-down",
        "independent-solver",
        "regression-baseline",
        "published",
    }
    for check in checks:
        assert set(check) == {"name", "kind", "reference", "tolerance", "result", "passed"}
        VerificationCheck.model_validate(check)
    baseline = next(c for c in checks if c["kind"] == "regression-baseline")
    assert "not a verification" in baseline["reference"]


def _catalog_file(tmp_path: Path, **verification: Any) -> Path:
    entry = _example().model_dump(mode="json", exclude_none=True)
    other = {**entry, "id": "other", "provenance": {**entry["provenance"], "path": "o/o.xlsx"}}
    if verification:
        entry["verification"] = verification
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"version": 1, "examples": [entry, other]}), encoding="utf-8")
    return path


def test_writing_the_catalog_puts_the_checks_in_the_entry_and_keeps_its_summary(
    harness: ModuleType, fake: FakeApi, tmp_path: Path
) -> None:
    path = _catalog_file(tmp_path, summary="What the checks add up to.", checks=[])
    result, _ = _run(harness, fake)
    assert harness.update_catalog([result], path) == ["demo"]
    written = json.loads(path.read_text(encoding="utf-8"))
    demo, other = written["examples"]
    assert demo["verification"]["summary"] == "What the checks add up to."
    assert [c["name"] for c in demo["verification"]["checks"]] == [
        c["name"] for c in harness.catalog_checks(result)
    ]
    assert "verification" not in other  # a case that was not run is not touched
    parse_catalog(path.read_text(encoding="utf-8"))  # and it is still a catalog


def test_the_catalog_is_not_written_for_a_case_without_a_summary_or_that_did_not_pass(
    harness: ModuleType, fake: FakeApi, tmp_path: Path
) -> None:
    result, _ = _run(harness, fake)
    without = _catalog_file(tmp_path)
    before = without.read_text(encoding="utf-8")
    with pytest.raises(ValueError, match="no verification summary"):
        harness.update_catalog([result], without)
    assert without.read_text(encoding="utf-8") == before



def test_the_catalog_takes_the_cases_that_passed_and_leaves_one_that_did_not(
    harness: ModuleType, fake: FakeApi, tmp_path: Path
) -> None:
    """``--write-catalog`` writes the checks of the cases that passed, as its help says: one
    case that failed leaves its own entry as it is and does not stop the others."""
    failing = FakeApi(harness)
    failing.tds_converged = False
    bad, _ = _run(harness, failing)
    good, _ = _run(harness, fake)
    assert not bad.passed and good.passed
    entry = _example().model_dump(mode="json", exclude_none=True)
    entry["verification"] = {"summary": "x", "checks": []}
    other = {**entry, "id": "other", "provenance": {**entry["provenance"], "path": "o/o.xlsx"}}
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"version": 1, "examples": [entry, other]}), encoding="utf-8")
    bad.id = "other"
    assert harness.update_catalog([bad, good], path) == ["demo"]
    demo, untouched = json.loads(path.read_text(encoding="utf-8"))["examples"]
    assert demo["verification"]["checks"] and untouched["verification"]["checks"] == []


# ---- a mode's damping held to the case it is a variant of ---------------------------------

COMPARE = {"case": "kundur", "window_hz": [0.3, 0.9], "change": [-0.005, 0.005]}
COMPARE_NAME = "Damping of the mode between 0.3 and 0.9 Hz against kundur"


def _compare_check(result: Any) -> Any:
    return next(c for c in result.checks if c.name == COMPARE_NAME)


def test_a_mode_held_to_another_case_passes_when_the_two_runs_have_the_same_damping(
    harness: ModuleType, fake: FakeApi
) -> None:
    result, _ = _run(harness, fake, _reference(ring_down={"compare": COMPARE}))
    check = _compare_check(result)
    assert check.passed and check.kind == "ring-down" and result.passed
    assert check.measured == pytest.approx(0, abs=1e-4)
    assert check.tolerance == "between -0.005 and +0.005 in damping ratio"
    # The other case is added from the catalog and run in a session of its own beside the first,
    # which closes before this one, and no other check was disturbed by it.
    assert "POST /examples/kundur/add" in fake.log
    # Against a server of the user's this writes a file into their workspace, and the report says so.
    assert any("kundur was added to the workspace as demo.xlsx" in n for n in result.notes)
    assert fake.log.count("POST /sessions") == 2
    assert fake.log.index("DELETE /sessions/s2") < fake.log.index("DELETE /sessions/s1")
    assert not any(c.name == COMPARE_NAME for c in _run(harness, fake)[0].checks)


def test_a_mode_that_the_other_case_damps_more_fails_a_comparison_that_allows_no_difference(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.damping_shift = {"s2": 0.05}  # the other case's ring-down is damped 0.084, not 0.034
    result, _ = _run(harness, fake, _reference(ring_down={"compare": COMPARE}))
    check = _compare_check(result)
    assert not check.passed and not result.passed
    assert check.measured == pytest.approx(-0.05, abs=0.005)
    # Allowed to be lower by that much, the same two runs pass.
    wide = {**COMPARE, "change": [-0.06, 0.0]}
    result, _ = _run(harness, fake, _reference(ring_down={"compare": wide}))
    assert _compare_check(result).passed


def test_a_comparison_that_asks_for_a_gain_in_damping_fails_when_there_is_none(
    harness: ModuleType, fake: FakeApi
) -> None:
    better = {**COMPARE, "change": [0.01, 0.2]}
    result, _ = _run(harness, fake, _reference(ring_down={"compare": better}))
    check = _compare_check(result)
    assert not check.passed and check.measured == pytest.approx(0, abs=1e-4)
    fake.damping_shift = {"s2": -0.02}  # the other case is damped less: this one gained 0.02
    result, _ = _run(harness, fake, _reference(ring_down={"compare": better}))
    assert _compare_check(result).passed


def test_a_comparison_names_a_case_the_catalog_has_with_a_reference_or_fails_in_words(
    harness: ModuleType, fake: FakeApi, monkeypatch: pytest.MonkeyPatch
) -> None:
    missing = {**COMPARE, "case": "no_such_case"}
    result, _ = _run(harness, fake, _reference(ring_down={"compare": missing}))
    check = next(c for c in result.checks if c.name.endswith("against no_such_case"))
    assert not check.passed and "no such case with a file" in check.result
    assert "POST /sessions" in fake.log and fake.log.count("POST /sessions") == 1
    # A case with no reference would run with the events of its file acting.
    monkeypatch.setattr(harness, "load_reference", lambda example_id, *a, **k: None)
    result, _ = _run(
        harness,
        fake,
        _reference(ring_down={"compare": COMPARE}),
    )
    check = _compare_check(result)
    assert not check.passed and "has no reference file" in check.result


def test_the_other_cases_run_has_its_own_events_taken_out(
    harness: ModuleType, fake: FakeApi
) -> None:
    _run(harness, fake, _reference(ring_down={"compare": COMPARE}))
    # The reference of the kundur case names Toggle 1; the fake lists it as an event of the file.
    deleted = [call for call in fake.log if call == "DELETE /sessions/s2/elements/Toggle/1"]
    assert len(deleted) == 1


def test_a_mode_with_no_oscillation_in_the_window_of_either_run_fails_and_says_which(
    harness: ModuleType, fake: FakeApi
) -> None:
    far = {**COMPARE, "window_hz": [1.5, 2.5]}  # the fake's mode is at 0.65 Hz
    result, _ = _run(harness, fake, _reference(ring_down={"compare": far}))
    check = next(c for c in result.checks if c.name.endswith("against kundur"))
    assert not check.passed and "no oscillation between 1.5 and 2.5 Hz" in check.result


# ---- what the script does when something about the server or the run goes wrong -------------


def test_a_session_whose_case_will_not_open_is_not_left_on_the_server(
    harness: ModuleType, fake: FakeApi
) -> None:
    """The script's server holds two sessions: one that was made and never closed, because the
    case it was made for would not open, would make every later case fail as 'full'."""
    original = fake.call

    def refuse(method: str, path: str, body: Any = None, **query: Any) -> Any:
        if method == "POST" and path.endswith("/case"):
            fake.log.append(f"{method} {path}")
            raise harness.ApiError(method, path, 400, "the file cannot be loaded")
        return original(method, path, body, **query)

    fake.call = refuse  # type: ignore[method-assign]
    with pytest.raises(harness.ApiError):
        harness.Session(fake, "demo.xlsx", [])
    assert fake.open_sessions == []
    assert fake.log[-1] == "DELETE /sessions/s1"
    # In a case's run the failure is the case's error, and no session is left either.
    result, _ = _run(harness, fake)
    assert "400" in (result.error or "") and fake.open_sessions == []


def test_an_eigenvalue_analysis_with_no_eigenvalue_fails_its_check_and_not_the_script(
    harness: ModuleType, fake: FakeApi
) -> None:
    fake.eig_empty = True
    result, _ = _run(harness, fake)
    assert result.error is None
    check = next(c for c in result.checks if c.name == "Eigenvalue analysis returns the modes")
    assert not check.passed and "no eigenvalue was returned" in check.result


def test_two_poles_that_go_to_one_eigenvalue_are_one_mode_verified_and_the_check_says_so(
    harness: ModuleType,
) -> None:
    modes = [(1.295, 0.050), (0.6, 0.02)]
    poles = [
        harness.Pole(1.284, 0.045, 1.0),
        harness.Pole(1.283, 0.044, 0.5),
        harness.Pole(0.601, 0.021, 0.2),
    ]
    matches = harness.match_poles(poles, modes, 0.05, 0.05)
    assert all(m["matched"] for m in matches)
    assert harness.distinct_eigenvalues(matches) == 2
    # A pole that matched nothing is not a mode verified, and an empty list of modes has none.
    assert harness.distinct_eigenvalues(harness.match_poles(poles[:1], [(9.0, 0.5)], 0.05, 0.05)) == 0
    assert harness.distinct_eigenvalues(harness.match_poles(poles, [], 0.05, 0.05)) == 0


def test_a_ring_down_check_names_how_many_modes_its_poles_came_to(
    harness: ModuleType, fake: FakeApi
) -> None:
    result, _ = _run(harness, fake)
    check = next(c for c in result.checks if c.kind == "ring-down")
    # The fake's one mode is matched by its one pole: nothing to add.
    assert "distinct eigenvalue" not in check.result


def test_a_rounding_to_zero_has_no_sign(harness: ModuleType) -> None:
    assert harness.fixed(-0.0004, 3) == "0.000"
    assert harness.fixed(-0.0, 3) == "0.000"
    assert harness.fixed(-0.0006, 3) == "-0.001"
    assert harness.fixed(1.5, 3) == "1.500"


def test_the_server_the_script_starts_writes_utf8_and_finds_tensa_where_the_script_did(
    harness: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "path", [str(harness.SERVER_SRC), *sys.path])
    monkeypatch.setenv("PYTHONPATH", "/somewhere/else")
    env = harness.server_environment()
    assert env["PYTHONUTF8"] == "1" and env["PYTHONIOENCODING"] == "utf-8"
    assert env["PYTHONPATH"].split(os.pathsep) == [str(harness.SERVER_SRC), "/somewhere/else"]
    # A TENSA that is installed needs no help, and a path of the user's is kept as it is.
    monkeypatch.setattr(sys, "path", [p for p in sys.path if p != str(harness.SERVER_SRC)])
    assert harness.server_environment()["PYTHONPATH"] == "/somewhere/else"
