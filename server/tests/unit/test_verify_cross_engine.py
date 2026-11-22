"""The cross-engine checks of ``scripts/verify_example_cases.py``.

The pure parts (engine list parsing, the power flow comparison by key, the reading of a
``POST /compare`` answer, the refusal check, the report section) are held to recorded JSON
whose answer is worked out by hand in the tests, so no server and no Julia is started here.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tensa.core.example_references import CrossEnginePlan
from tests._repo import SCRIPTS_DIR

pytestmark = pytest.mark.unit


@pytest.fixture(scope="module")
def harness() -> Iterator[ModuleType]:
    path = SCRIPTS_DIR / "verify_example_cases.py"
    if not path.is_file():
        pytest.skip("scripts/verify_example_cases.py is not next to the tests")
    name = "verify_example_cases_cross_engine_under_test"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        sys.modules.pop(name, None)


def _pflow(voltages: dict[str, float], angles: dict[str, float], **changes: Any) -> dict[str, Any]:
    """A power flow result as the API answers it: per-idx values and a keys lookup."""
    result = {
        "converged": True,
        "bus_voltages": voltages,
        "bus_angles": angles,
        "keys": {"Bus": {idx: f"bus:{idx}" for idx in voltages}},
        "summary": {"loss_p": 92.8, "slack_p": 726.8},
    }
    result.update(changes)
    return result


# ---- the --engines list -------------------------------------------------------------------


def test_parse_engines_default(harness: ModuleType) -> None:
    assert harness.parse_engines("andes") == ["andes"]
    assert harness.parse_engines("andes,sienna") == ["andes", "sienna"]
    assert harness.parse_engines(" andes , sienna ") == ["andes", "sienna"]


def test_parse_engines_rejects_unknown(harness: ModuleType) -> None:
    with pytest.raises(ValueError, match="unknown engine 'pandapower'"):
        harness.parse_engines("andes,pandapower")


def test_parse_engines_must_start_with_andes(harness: ModuleType) -> None:
    with pytest.raises(ValueError, match="must start with andes"):
        harness.parse_engines("sienna")
    with pytest.raises(ValueError, match="must start with andes"):
        harness.parse_engines("sienna,andes")


def test_main_rejects_a_bad_engines_list(harness: ModuleType, capsys: Any) -> None:
    assert harness.main(["--engines", "sienna"]) == 2
    assert "must start with andes" in capsys.readouterr().err
    assert harness.main(["--engines", "andes,pandapower"]) == 2
    assert "unknown engine" in capsys.readouterr().err


# ---- the power flow comparison -------------------------------------------------------------


def test_compare_power_flow_within_tolerance(harness: ModuleType) -> None:
    andes = _pflow({"1": 1.0, "2": 0.98}, {"1": 0.0, "2": -0.1})
    sienna = _pflow({"1": 1.0, "2": 0.98 + 1e-6}, {"1": 0.0, "2": -0.1})
    plan = CrossEnginePlan.model_validate({})
    magnitudes, angles, powers = harness.compare_power_flow(andes, sienna, plan)
    # 1e-6 pu at bus 2, inside 2e-5; the angles and the scalars are identical.
    assert magnitudes["passed"] and magnitudes["worst"] == pytest.approx(1e-6)
    assert magnitudes["key"] == "bus:2" and magnitudes["n"] == 2
    assert angles["passed"] and angles["worst"] == 0.0
    assert powers["passed"] and powers["worst"] == 0.0 and powers["n"] == 2
    # 3e-5 pu is outside 2e-5, whatever the dynamics are allowed.
    sienna["bus_voltages"]["2"] = 0.98 + 3e-5
    magnitudes, _, _ = harness.compare_power_flow(andes, sienna, plan)
    assert not magnitudes["passed"] and magnitudes["worst"] == pytest.approx(3e-5)


def test_compare_power_flow_angle_wrap(harness: ModuleType) -> None:
    # 179.9999 deg against -179.9999 deg: 2e-4 deg apart, not 360 (decision 35).
    near = math.radians(179.9999)
    far = math.radians(-179.9999)
    andes = _pflow({"1": 1.0}, {"1": near})
    sienna = _pflow({"1": 1.0}, {"1": far})
    plan = CrossEnginePlan.model_validate({})
    _, angles, _ = harness.compare_power_flow(andes, sienna, plan)
    # By hand: 2*pi - 2*179.9999*pi/180 = 2e-4 deg in radians, about 3.49e-6 rad.
    assert angles["worst"] == pytest.approx(math.radians(2e-4), rel=1e-3)
    assert angles["passed"]  # 3.49e-6 rad is inside 2e-5 rad
    # An implementation that does not wrap sees 359.9998 deg, about 6.28 rad.
    assert abs(near - far) == pytest.approx(math.radians(359.9998), rel=1e-6)
    assert harness.wrap_angle_diff(near - far) == pytest.approx(-math.radians(2e-4), rel=1e-3)


def test_compare_power_flow_unmatched_key_fails(harness: ModuleType) -> None:
    andes = _pflow({"1": 1.0, "9": 0.97}, {"1": 0.0, "9": 0.2})
    sienna = _pflow({"1": 1.0}, {"1": 0.0})
    plan = CrossEnginePlan.model_validate({})
    magnitudes, angles, _ = harness.compare_power_flow(andes, sienna, plan)
    assert not magnitudes["passed"] and magnitudes["unmatched"] == ["bus:9"]
    assert not angles["passed"] and angles["unmatched"] == ["bus:9"]


def test_compare_power_flow_uses_keys_not_idx(harness: ModuleType) -> None:
    # The same two buses under different idx values in the two engines: the comparison by key
    # passes, one by idx would compare bus 1 of ANDES with bus 7 of Sienna and fail.
    andes = _pflow({"1": 1.0, "2": 0.98}, {"1": 0.0, "2": -0.1})
    sienna = _pflow({"7": 1.0, "8": 0.98}, {"7": 0.0, "8": -0.1})
    sienna["keys"] = {"Bus": {"7": "bus:1", "8": "bus:2"}}
    plan = CrossEnginePlan.model_validate({})
    magnitudes, angles, _ = harness.compare_power_flow(andes, sienna, plan)
    assert magnitudes["passed"] and magnitudes["n"] == 2 and not magnitudes["unmatched"]
    assert angles["passed"] and angles["n"] == 2
    by_idx = abs(1.0 - 0.98)  # what comparing idx 1 with idx 7 would give
    assert by_idx == pytest.approx(0.02) and by_idx > plan.pf_voltage_pu


# ---- the POST /compare answer ---------------------------------------------------------------


def _compare_answer(rows: list[dict[str, Any]], **changes: Any) -> dict[str, Any]:
    answer = {
        "series": rows,
        "unmatched_series_reference": [],
        "unmatched_series_comparison": [],
    }
    answer.update(changes)
    return answer


def _row(quantity: str, key: str, rms: float, worst: float, t: float) -> dict[str, Any]:
    return {
        "quantity": quantity,
        "key": key,
        "rms_diff": rms,
        "max_diff": worst,
        "max_diff_t": t,
        "swing_ref": 0.1,
    }


def test_evaluate_compare_rows_within_tolerances(harness: ModuleType) -> None:
    answer = _compare_answer(
        [
            _row("rotor_speed", "gen:1-1", 1e-5, 1e-4, 2.0),
            _row("voltage", "bus:7", 2e-5, 3e-4, 1.0),
        ]
    )
    outcome = harness.evaluate_compare_rows(answer, 2e-4, 2e-3)
    assert outcome["passed"] and outcome["n"] == 2 and not outcome["unmatched"]
    assert outcome["worst_rms"] == pytest.approx(2e-5)
    assert outcome["worst_rms_row"]["quantity"] == "voltage"
    assert outcome["worst_max"] == pytest.approx(3e-4)
    assert outcome["worst_max_row"]["key"] == "bus:7"


def test_evaluate_compare_rows_one_row_outside_fails_and_is_named(harness: ModuleType) -> None:
    answer = _compare_answer(
        [
            _row("rotor_speed", "gen:1-1", 1e-5, 1e-4, 2.0),
            _row("rotor_speed", "gen:2-1", 5e-4, 1e-4, 3.5),
        ]
    )
    outcome = harness.evaluate_compare_rows(answer, 2e-4, 2e-3)
    # gen:2-1 has an RMS of 5e-4, over the 2e-4 bound; its largest single difference is inside.
    assert not outcome["passed"]
    assert outcome["worst_rms_row"]["quantity"] == "rotor_speed"
    assert outcome["worst_rms_row"]["key"] == "gen:2-1"
    assert outcome["worst_max_row"]["max_diff_t"] == 2.0


def test_evaluate_compare_rows_unmatched_series_fail(harness: ModuleType) -> None:
    answer = _compare_answer(
        [_row("voltage", "bus:7", 1e-6, 1e-5, 1.0)],
        unmatched_series_reference=["voltage|bus:9"],
    )
    outcome = harness.evaluate_compare_rows(answer, 2e-4, 2e-3)
    assert not outcome["passed"] and outcome["unmatched"] == ["voltage|bus:9"]
    # No rows at all is no comparison, not a pass.
    assert not harness.evaluate_compare_rows(_compare_answer([]), 2e-4, 2e-3)["passed"]


# ---- the refusal check ---------------------------------------------------------------------


def test_refusal_expected_and_received(harness: ModuleType) -> None:
    plan = CrossEnginePlan.model_validate({"sienna": "refused"})
    check = harness.refusal_check(plan, "no dynamic model for gen:8-1", None)
    assert check.passed and check.kind == "cross-engine"
    assert "no dynamic model for gen:8-1" in check.result


def test_refusal_expected_but_case_ran(harness: ModuleType) -> None:
    plan = CrossEnginePlan.model_validate({"sienna": "refused"})
    check = harness.refusal_check(plan, None, None)
    assert not check.passed
    assert "update the reference to sienna = pass" in check.result


def test_refusal_unexpected(harness: ModuleType) -> None:
    plan = CrossEnginePlan.model_validate({"sienna": "pass"})
    check = harness.refusal_check(plan, "engine_unsupported: run_tds", None)
    assert not check.passed
    assert "expected a run, got a refusal" in check.result


def test_refusal_stage_mismatch(harness: ModuleType) -> None:
    plan = CrossEnginePlan.model_validate({"sienna": "refused", "refusal_stage": "build"})
    check = harness.refusal_check(plan, "case is not_ready: gen:8-1", "not_ready")
    assert not check.passed
    assert "expected stage build, got not_ready" in check.result
    matching = harness.refusal_check(plan, "build failed", "build")
    assert matching.passed and "stage build" in matching.result


def test_the_stage_is_read_out_of_a_refusal_message(harness: ModuleType) -> None:
    assert harness.refusal_stage_of("run_tds refused (not_ready): gen:8-1") == "not_ready"
    assert harness.refusal_stage_of("the disturbances route refused this") == "disturbances"
    assert harness.refusal_stage_of("something else went wrong") is None


# ---- the report -----------------------------------------------------------------------------


def _result(harness: ModuleType, example_id: str, *kinds: str, reference: bool = True) -> Any:
    result = harness.CaseResult(
        id=example_id,
        title=example_id,
        file="case.xlsx",
        analyses=["pf"],
        reference_file=f"references/{example_id}.json" if reference else None,
    )
    for kind in kinds:
        result.add(harness.Check("c", "pf", kind, "ref", "tol", "res", True))
    return result


def test_report_cross_engine_section(harness: ModuleType) -> None:
    compared = _result(harness, "kundur", "sanity", "cross-engine")
    skipped = _result(harness, "ieee30", "sanity")
    plain = _result(harness, "none", "sanity", reference=False)
    report = harness.build_report(
        [compared, skipped, plain],
        {"version": "1", "andes_version": "2"},
        "u",
        True,
        1.0,
        engines=["andes", "sienna"],
        sienna_available=False,
        sienna_reason="Julia not found",
    )
    cross = report["cross_engine"]
    assert cross["sienna_available"] is False
    assert cross["unavailable_reason"] == "Julia not found"
    assert cross["cases"] == {
        "kundur": "compared",
        "ieee30": "skipped",
        "none": "no cross-engine block",
    }
    page = harness.render_markdown(report)
    assert "## Cross-engine (ANDES against Sienna)" in page
    assert "Sienna available: no (Julia not found)" in page
    assert "1 cases compared, 1 skipped" in page
    assert "verify the Sienna engine against ANDES" in page


def test_no_cross_engine_section_without_sienna(harness: ModuleType) -> None:
    report = harness.build_report(
        [_result(harness, "kundur", "sanity")],
        {"version": "1", "andes_version": "2"},
        "u",
        True,
        1.0,
    )
    assert "cross_engine" not in report
    assert "Cross-engine" not in harness.render_markdown(report)


# ---- record_baselines leaves cross-engine checks alone ---------------------------------------


def test_record_baselines_ignores_cross_engine(harness: ModuleType, tmp_path: Path) -> None:
    cross = {
        "name": "Sienna network losses and slack power against ANDES",
        "quantity": "pf.loss_mw",
        "kind": "cross-engine",
        "reference": "the Sienna run held to the ANDES run",
        "expected": 92.8,
        "tolerance": {"abs": 0.001},
    }
    baseline = {
        "name": "Lowest voltage",
        "quantity": "tds.min_voltage_pu",
        "kind": "regression-baseline",
        "reference": "TENSA's own earlier output",
        "expected": 0.0,
        "tolerance": {"abs": 0.01},
    }
    document = {
        "version": 1,
        "id": "demo",
        "disturbance": {"description": "x"},
        "checks": [cross, baseline],
    }
    path = tmp_path / "demo.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    result = harness.CaseResult("demo", "Demo", "demo.xlsx", ["pf", "tds"])
    measured = harness.Measured(
        pf={"summary": {"loss_p": 93.1}}, tds={"min_voltage_pu": 0.8731234567}
    )
    assert harness.record_baselines([result], {"demo": measured}, tmp_path) == ["demo.json"]
    after = json.loads(path.read_text(encoding="utf-8"))
    # The baseline moved to what was measured; the cross-engine check is byte-identical.
    assert after["checks"][0] == cross
    assert after["checks"][1]["expected"] == 0.87312346


# ---- a differ plan widens only the dynamics ---------------------------------------------------


def test_known_difference_widens_only_dynamic(harness: ModuleType) -> None:
    # The plan's power flow tolerances are the same for a differ case; only the series bounds
    # of that case's plan are set wider, and the check's tolerance text names the difference.
    plan = CrossEnginePlan.model_validate(
        {
            "sienna": "differ:tgov1-torque",
            "known_difference": "tgov1-torque",
            "series_rms_pu": 5e-3,
            "series_max_pu": 5e-2,
        }
    )
    assert plan.pf_voltage_pu == 2e-5 and plan.pf_angle_rad == 2e-5
    andes = _pflow({"1": 1.0}, {"1": 0.0})
    sienna = _pflow({"1": 1.0 + 3e-5}, {"1": 0.0})
    magnitudes, _, _ = harness.compare_power_flow(andes, sienna, plan)
    assert not magnitudes["passed"]  # 3e-5 pu fails the power flow, differ or not
    # A dynamic gap inside the widened bound passes the series evaluation.
    answer = _compare_answer([_row("rotor_speed", "gen:1-1", 4e-3, 4e-2, 2.0)])
    outcome = harness.evaluate_compare_rows(answer, plan.series_rms_pu, plan.series_max_pu)
    assert outcome["passed"]
    # ... and fails the unwidened one.
    tight = CrossEnginePlan.model_validate({})
    assert not harness.evaluate_compare_rows(
        answer, tight.series_rms_pu, tight.series_max_pu
    )["passed"]


def test_known_difference_summary_reads_the_register_when_present(
    harness: ModuleType, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    register = tmp_path / "known_differences.json"
    register.write_text(
        json.dumps(
            [
                {
                    "id": "tgov1-torque",
                    "summary": "Sienna hands the machine a torque of P_m / omega.",
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(harness, "KNOWN_DIFFERENCES", register)
    assert "P_m / omega" in harness.known_difference_summary("tgov1-torque")
    with pytest.raises(harness.ReferenceFileError, match="not in"):
        harness.known_difference_summary("no-such-entry")
    monkeypatch.setattr(harness, "KNOWN_DIFFERENCES", tmp_path / "absent.json")
    with pytest.raises(harness.ReferenceFileError, match="not present"):
        harness.known_difference_summary("tgov1-torque")
