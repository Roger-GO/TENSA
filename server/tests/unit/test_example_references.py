"""The reference files of the example cases: ``examples/references/<id>.json``.

``tensa.core.example_references`` holds their schema and ``scripts/verify_example_cases.py``
compares a run of TENSA with them. These tests hold the files that ship to the schema and to
the catalog (a reference of a case the catalog does not have, a map that misses a bus, a
default case with nothing to check it against), and hold the schema to what it promises.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

import pytest

from tensa.core import example_catalog
from tensa.core.example_catalog import load_catalog
from tensa.core.example_references import (
    ExampleReference,
    ReferenceFileError,
    RingDownCompare,
    Tolerance,
    load_reference,
    parse_reference,
    references_dir,
)
from tests._repo import SCRIPTS_DIR, load_module

pytestmark = pytest.mark.unit


def _document(**changes: Any) -> dict[str, Any]:
    check = {
        "name": "Slack power",
        "quantity": "pf.slack_p_mw",
        "kind": "published",
        "reference": "a book",
        "expected": 71.64,
        "tolerance": {"abs": 0.05},
    }
    return {"version": 1, "id": "demo", "checks": [check], **changes}


def _shipped() -> list[tuple[str, ExampleReference]]:
    files = sorted(references_dir().glob("*.json"))
    assert files, "no reference files ship with the package"
    return [(f.stem, parse_reference(f.read_text(encoding="utf-8"))) for f in files]


# ---- the files that ship ------------------------------------------------------------------


def test_every_shipped_reference_validates_and_names_its_own_case() -> None:
    catalog = load_catalog()
    for stem, reference in _shipped():
        assert reference.id == stem
        example = catalog.get(stem)
        assert example is not None, f"{stem}.json belongs to no catalog entry"
        assert example.has_file, f"{stem} is a link-only entry, so it has nothing to check"


def test_a_per_bus_value_is_given_for_every_bus_of_the_case() -> None:
    catalog = load_catalog()
    seen = 0
    for stem, reference in _shipped():
        example = catalog.get(stem)
        assert example is not None and example.size is not None
        for check in reference.checks:
            if isinstance(check.expected, dict):
                seen += 1
                if check.kind == "published":
                    # A source may print the values of some of the buses only.
                    assert 0 < len(check.expected) <= example.size.buses, check.name
                elif (stem, check.kind, check.quantity) == (
                    "pegase89",
                    "stored-solution",
                    "pf.bus_angle_deg",
                ):
                    # RTE's state is a solution except at the angles of three buses, which the
                    # check leaves out, and the entry says so.
                    assert len(check.expected) == example.size.buses - 3, check.name
                else:
                    assert len(check.expected) == example.size.buses, check.name
    assert seen


def test_every_default_case_has_a_power_flow_reference_from_an_independent_solver() -> None:
    for example in load_catalog().defaults():
        reference = load_reference(example.id)
        assert reference is not None, f"{example.id} is seeded and has no reference file"
        solved = {
            c.quantity
            for c in reference.checks
            if c.kind == "independent-solver" and c.analysis == "pf"
        }
        assert {"pf.bus_voltage_pu", "pf.bus_angle_deg"} <= solved, example.id


def test_a_case_that_can_be_simulated_says_how_it_is_disturbed_and_what_to_take_out() -> None:
    for example in load_catalog().defaults():
        reference = load_reference(example.id)
        assert reference is not None
        if "tds" in example.analyses:
            assert reference.disturbance is not None, example.id
            # One of its own events, or one the reference adds.
            assert reference.disturbance.specs or reference.remove_events, example.id


def test_the_baselines_are_labelled_so_and_the_independent_values_are_not() -> None:
    for stem, reference in _shipped():
        for check in reference.checks:
            if check.kind == "regression-baseline":
                assert "own earlier output" in check.reference, (stem, check.name)
            if check.generated_by is not None:
                # The kinds a script can write: what a solver computed, what the case file
                # itself stores, or what a report of another program printed (the script reads
                # those, it does not compute them).
                assert check.kind in ("independent-solver", "stored-solution", "published"), (
                    stem,
                    check.name,
                )
                command = check.generated_by.removesuffix(" --enforce-q-limits")
                assert (check.kind == "stored-solution") == command.endswith(" stored"), (
                    stem,
                    check.name,
                )
                assert (check.kind == "published") == command.endswith(" report"), (
                    stem,
                    check.name,
                )
                # A check of a power flow with the reactive limits enforced says so, and is
                # written under a name of its own, so that it stands beside the other and not over it.
                assert (check.pflow is not None) == check.generated_by.endswith(
                    " --enforce-q-limits"
                ), (stem, check.name)


def test_a_reference_that_is_not_there_is_none_and_one_of_another_case_is_refused(
    tmp_path: Path,
) -> None:
    assert load_reference("nothing-by-this-name") is None
    (tmp_path / "demo.json").write_text(json.dumps(_document(id="other")), encoding="utf-8")
    with pytest.raises(ReferenceFileError, match="reference of 'other'"):
        load_reference("demo", tmp_path)
    (tmp_path / "demo.json").write_text(json.dumps(_document()), encoding="utf-8")
    assert load_reference("demo", tmp_path) is not None


# ---- the schema ---------------------------------------------------------------------------


def test_a_minimal_reference_is_accepted_and_the_ring_down_has_defaults() -> None:
    reference = parse_reference(json.dumps(_document()))
    assert reference.checks[0].analysis == "pf"
    assert reference.ring_down.tolerance_hz == 0.05
    assert reference.ring_down.modes == 3
    assert reference.disturbance is None and reference.remove_events == []


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"quantity": "pf.bus_voltage_pu"}, "needs a map"),
        ({"expected": {"1": 1.0}}, "is one number, not a map"),
        ({"quantity": "eig.mode_frequency_hz"}, "needs window_hz"),
        ({"quantity": "eig.mode_frequency_hz", "window_hz": [2.0, 1.0]}, "low < high"),
        ({"window_hz": [0.1, 1.0]}, "belongs to an eigenvalue quantity"),
        ({"tolerance": {}}, "needs abs, rel or both"),
        ({"quantity": "pf.nothing"}, "quantity"),
        ({"kind": "guess"}, "kind"),
    ],
)
def test_a_check_that_does_not_hold_together_is_refused(
    change: dict[str, Any], message: str
) -> None:
    document = _document()
    document["checks"][0].update(change)
    with pytest.raises(ReferenceFileError, match=message):
        parse_reference(json.dumps(document))


def test_check_names_are_unique_and_a_time_domain_check_needs_a_disturbance() -> None:
    document = _document()
    document["checks"].append(dict(document["checks"][0]))
    with pytest.raises(ReferenceFileError, match="unique"):
        parse_reference(json.dumps(document))
    tds = _document()
    tds["checks"][0].update({"quantity": "tds.min_voltage_pu", "expected": 0.8})
    with pytest.raises(ReferenceFileError, match="needs a disturbance plan"):
        parse_reference(json.dumps(tds))
    tds["disturbance"] = {"description": "a trip"}
    assert parse_reference(json.dumps(tds)).disturbance is not None


def test_a_disturbance_is_checked_the_way_the_disturbances_route_checks_it() -> None:
    bad = _document(
        disturbance={"description": "a fault", "specs": [{"kind": "fault", "bus_idx": 1}]}
    )
    with pytest.raises(ReferenceFileError, match="tf"):
        parse_reference(json.dumps(bad))
    good = _document(
        disturbance={
            "description": "a fault",
            "specs": [{"kind": "fault", "bus_idx": 1, "tf": 1.0, "tc": 1.1}],
        },
        remove_events=[{"model": "Toggle", "idx": 1}],
    )
    reference = parse_reference(json.dumps(good))
    assert reference.disturbance is not None and reference.disturbance.specs[0].kind == "fault"
    assert reference.remove_events[0].idx == 1


def test_a_run_may_ask_for_a_step_and_it_must_be_one() -> None:
    plan = {"description": "a fault", "specs": [], "h": 0.0125}
    reference = parse_reference(json.dumps(_document(disturbance=plan)))
    assert reference.disturbance is not None and reference.disturbance.h == 0.0125
    default = parse_reference(json.dumps(_document(disturbance={"description": "a fault"})))
    assert default.disturbance is not None and default.disturbance.h is None
    for bad in (0, -0.01):
        with pytest.raises(ReferenceFileError, match="h"):
            parse_reference(json.dumps(_document(disturbance={**plan, "h": bad})))


def test_the_wscc_9_disturbance_is_the_fault_of_the_books_example() -> None:
    """A fault at bus 7 for 5 cycles at 60 Hz, cleared by opening line 5-7, run with a step
    small enough for the trapezoidal rule to agree with a continuous solution."""
    reference = load_reference("wscc9")
    assert reference is not None and reference.disturbance is not None
    fault, trip = reference.disturbance.specs
    assert (fault.kind, fault.bus_idx) == ("fault", 7)
    assert fault.tc - fault.tf == pytest.approx(5 / 60)
    # Line_2 is the line between buses 5 and 7 (the third line of the file).
    assert (trip.kind, trip.model, trip.dev_idx) == ("toggle", "Line", "Line_2")
    assert trip.t == pytest.approx(fault.tc)
    assert reference.disturbance.h is not None and reference.disturbance.h <= 1 / 100
    # Nothing in the file acts by itself, so nothing is taken out for the other runs.
    assert reference.remove_events == []


def test_the_ieee_39_disturbance_is_a_fault_and_the_switched_off_trip_is_taken_out() -> None:
    """The file's Toggler_1 is switched off (it would trip a generator at 12 s), so the case
    is shown with a fault that the reference adds, and the undisturbed runs name the trip."""
    reference = load_reference("ieee39")
    assert reference is not None and reference.disturbance is not None
    (fault,) = reference.disturbance.specs
    assert (fault.kind, fault.bus_idx) == ("fault", 16)
    assert fault.tc - fault.tf == pytest.approx(0.1)
    assert [(e.model, e.idx) for e in reference.remove_events] == [("Toggle", "Toggler_1")]
    assert reference.disturbance.settles_within_deg is not None


def test_the_npcc_disturbance_is_the_line_trip_of_the_file_and_both_events_are_taken_out() -> None:
    """Line_2 trips at 1.0 s and recloses at 1.1 s by two Toggle events of the file, so the
    reference adds nothing and names both for the runs that must not have them."""
    reference = load_reference("npcc")
    assert reference is not None and reference.disturbance is not None
    assert reference.disturbance.specs == []
    assert sorted(e.idx for e in reference.remove_events) == [1, 2]
    assert {e.model for e in reference.remove_events} == {"Toggle"}


def test_the_wecc_disturbance_is_the_line_trip_of_the_second_scenario_of_andes_docs() -> None:
    """Line_2 (bus 4 to bus 16) trips at 1.0 s and recloses at 1.1 s, as in ANDES's comparison."""
    reference = load_reference("wecc")
    assert reference is not None and reference.disturbance is not None
    trip, reclose = reference.disturbance.specs
    assert (trip.kind, trip.model, trip.dev_idx, trip.t) == ("toggle", "Line", "Line_2", 1.0)
    assert (reclose.kind, reclose.dev_idx, reclose.t) == ("toggle", "Line_2", 1.1)
    assert reference.remove_events == []


def test_a_case_whose_stored_state_is_a_solution_has_it_as_a_reference_and_ieee_39_has_none() -> (
    None
):
    """NPCC and WECC hold the state PSS/E solved, to the digits their RAW file keeps; IEEE 39
    holds a state 0.2 pu from its solution, which would make a failing check."""
    for case in ("npcc", "wecc"):
        reference = load_reference(case)
        assert reference is not None
        stored = [c for c in reference.checks if c.kind == "stored-solution"]
        assert {c.quantity for c in stored} == {
            "pf.bus_voltage_pu",
            "pf.bus_angle_deg",
            "pf.slack_p_mw",
        }, case
        assert all(c.generated_by == "scripts/crosscheck_pf.py stored" for c in stored)
    ieee39 = load_reference("ieee39")
    assert ieee39 is not None
    assert not [c for c in ieee39.checks if c.kind == "stored-solution"]


def test_a_pole_cap_and_a_settle_bound_are_optional_and_must_be_positive() -> None:
    default = parse_reference(json.dumps(_document(disturbance={"description": "a fault"})))
    assert default.ring_down.max_damping_ratio is None
    assert default.disturbance is not None and default.disturbance.settles_within_deg is None
    good = _document(
        disturbance={"description": "a fault", "settles_within_deg": 1.5},
        ring_down={"max_damping_ratio": 0.2},
    )
    parsed = parse_reference(json.dumps(good))
    assert parsed.ring_down.max_damping_ratio == 0.2
    assert parsed.disturbance is not None and parsed.disturbance.settles_within_deg == 1.5
    for bad in (
        _document(ring_down={"max_damping_ratio": 0}),
        _document(disturbance={"description": "a fault", "settles_within_deg": -1}),
    ):
        with pytest.raises(ReferenceFileError):
            parse_reference(json.dumps(bad))


def test_an_unknown_field_is_refused() -> None:
    with pytest.raises(ReferenceFileError, match="extra"):
        parse_reference(json.dumps(_document(surprise=1)))


def test_tolerance_is_absolute_plus_relative() -> None:
    tolerance = Tolerance(abs=0.01, rel=0.1)
    assert tolerance.bound(10.0) == pytest.approx(1.01)
    assert tolerance.allows(10.0, 11.0)
    assert not tolerance.allows(10.0, 11.02)
    assert tolerance.allows(-10.0, -9.0)
    assert Tolerance(abs=0.5).text() == "0.5"
    assert Tolerance(abs=0.5, rel=0.01).text() == "0.5 + 0.01 of the value"


def test_the_ieee_14_fault_case_has_its_fault_in_the_file_and_takes_it_out_for_the_quiet_runs() -> (
    None
):
    """Fault_1 of the file is the disturbance, so the reference adds nothing; the undisturbed
    runs name it, or the fault would act in them."""
    reference = load_reference("ieee14_fault")
    assert reference is not None and reference.disturbance is not None
    assert reference.disturbance.specs == []
    assert [(e.model, e.idx) for e in reference.remove_events] == [("Fault", 1)]
    # The network is the IEEE 14-bus case's, so its power flow reference is the same one.
    mine = {c.quantity: c.expected for c in reference.checks if c.kind == "independent-solver"}
    other = load_reference("ieee14")
    assert other is not None
    theirs = {c.quantity: c.expected for c in other.checks if c.kind == "independent-solver"}
    assert mine == theirs


def test_the_ieee_14_fault_run_is_the_ieee_14_run_with_the_same_fault_added_by_the_api() -> None:
    """The baselines of the two cases are one set of numbers: the fault in the file is the
    fault at bus 9 from 1.0 s to 1.1 s the IEEE 14-bus reference adds."""
    reference, other = load_reference("ieee14_fault"), load_reference("ieee14")
    assert reference is not None and other is not None and other.disturbance is not None
    (fault,) = other.disturbance.specs
    assert (fault.kind, fault.bus_idx, fault.tf, fault.tc) == ("fault", 9, 1.0, 1.1)
    baselines = {
        c.quantity + str(c.window_hz): c.expected
        for c in reference.checks
        if c.kind == "regression-baseline"
    }
    assert baselines == {
        c.quantity + str(c.window_hz): c.expected
        for c in other.checks
        if c.kind == "regression-baseline"
    }
    assert baselines


def test_the_kundur_stabiliser_case_is_held_to_the_kundur_case_in_the_time_domain() -> None:
    reference = load_reference("kundur_pss")
    assert reference is not None and reference.ring_down.compare is not None
    compare = reference.ring_down.compare
    assert compare.case == "kundur"
    # The window holds the inter-area mode (0.65 Hz) and none of the local modes (1.1 Hz).
    assert compare.window_hz[0] < 0.647 < compare.window_hz[1] < 1.1
    # The stabiliser is not claimed to add damping: the change allowed is about zero.
    assert compare.change[0] < 0 < compare.change[1] <= 0.01
    other = load_reference("kundur")
    assert other is not None
    assert [(e.model, e.idx) for e in reference.remove_events] == [
        (e.model, e.idx) for e in other.remove_events
    ]
    # The file's own pole pair of the stabiliser's second filter is checked against its roots.
    poles = [c for c in reference.checks if "second filter" in c.name]
    assert {c.quantity: c.expected for c in poles} == {
        "eig.mode_frequency_hz": pytest.approx(0.137832, abs=1e-6),
        "eig.mode_damping_ratio": 0.5,
    }
    assert all(c.kind == "independent-solver" for c in poles)


def test_the_pjm_5_bus_case_is_checked_against_the_classical_model_and_has_no_baseline() -> None:
    reference = load_reference("pjm5bus")
    assert reference is not None and reference.disturbance is not None
    assert reference.disturbance.specs == []
    assert [(e.model, e.idx) for e in reference.remove_events] == [("Toggle", 0)]
    kinds = {c.kind for c in reference.checks}
    assert kinds == {"independent-solver"}
    dynamics = [c for c in reference.checks if c.generated_by == "scripts/crosscheck_classical.py"]
    assert len(dynamics) == 10  # three modes (frequency and damping) and four disturbance numbers
    # Said where the reader meets it: these hold the governors' output constant.
    assert all("TG2 governors held at their initial output" in c.reference for c in dynamics)


def test_a_ring_down_comparison_names_a_case_a_window_and_the_change_it_allows() -> None:
    plan = {"compare": {"case": "kundur", "window_hz": [0.3, 0.9], "change": [-0.005, 0.005]}}
    parsed = parse_reference(json.dumps(_document(ring_down=plan)))
    assert parsed.ring_down.compare == RingDownCompare(
        case="kundur", window_hz=(0.3, 0.9), change=(-0.005, 0.005)
    )
    assert parse_reference(json.dumps(_document())).ring_down.compare is None
    for bad in (
        {"case": "kundur", "window_hz": [0.9, 0.3], "change": [0, 0.1]},
        {"case": "kundur", "window_hz": [0.3, 0.9], "change": [0.1, -0.1]},
        {"case": "Not An Id", "window_hz": [0.3, 0.9], "change": [0, 0.1]},
        {"case": "kundur", "window_hz": [0.3, 0.9]},
    ):
        with pytest.raises(ReferenceFileError):
            parse_reference(json.dumps(_document(ring_down={"compare": bad})))


def test_a_ring_down_comparison_names_a_case_the_catalog_has() -> None:
    catalog = load_catalog()
    for stem, reference in _shipped():
        compare = reference.ring_down.compare
        if compare is not None:
            other = catalog.get(compare.case)
            assert other is not None and other.has_file, stem
            assert compare.case != stem


def test_the_renewable_cases_have_the_network_of_ieee_14_and_take_the_file_s_two_line_events_out() -> (
    None
):
    """The solar and the wind turbine file hold the IEEE 14-bus network of the catalog, so the
    power flow reference is the one of IEEE 14 (the converter models do not enter the power
    flow), and Line_1 is switched out at 1.0 s and in at 1.1 s by two Toggle events that the
    runs which must stay quiet take out, by their idx."""
    base = load_reference("ieee14")
    assert base is not None
    theirs = {c.quantity: c.expected for c in base.checks if c.kind == "independent-solver"}
    for case in ("ieee14_solar", "ieee14_wt3"):
        reference = load_reference(case)
        assert reference is not None and reference.disturbance is not None, case
        mine = {c.quantity: c.expected for c in reference.checks if c.kind == "independent-solver"}
        assert mine == theirs, case
        assert reference.disturbance.specs == []
        assert [(e.model, e.idx) for e in reference.remove_events] == [
            ("Toggle", "Toggler_1"),
            ("Toggle", "Toggler_2"),
        ]
        # The network is the same again after the reclose: the machines end where they began.
        assert reference.disturbance.settles_within_deg == 1.0


def test_the_renewable_cases_allow_the_second_ring_down_pole_the_gap_it_has_and_no_more() -> None:
    """The second-strongest ring-down pole of both cases (0.993 Hz, damping 0.206) is 0.058 in
    damping from the nearest eigenvalue, which the 0.05 of the other cases would fail. The
    entries say so, and 0.06 is the least that lets the check pass: a looser tolerance would
    let a worse mismatch by."""
    for case in ("ieee14_solar", "ieee14_wt3"):
        reference = load_reference(case)
        assert reference is not None
        assert reference.ring_down.tolerance_damping == 0.06, case
        assert reference.ring_down.tolerance_hz == 0.05
        entry = load_catalog().get(case)
        assert entry is not None and entry.verification is not None
        text = " ".join(entry.caveats) + entry.verification.summary
        assert "0.058" in text and "0.06" in text, case


def test_the_renewable_dynamics_are_regression_baselines_and_say_so_in_the_entries() -> None:
    """No independent computation exists for converter and wind turbine models here, so the
    numbers of the disturbance run and of the modes are TENSA's own earlier output, and the
    entries' summaries say that nothing independent exists for them."""
    for case in ("ieee14_solar", "ieee14_wt3"):
        reference = load_reference(case)
        assert reference is not None
        tds_or_eig = [c for c in reference.checks if c.analysis in ("tds", "eig")]
        assert tds_or_eig and {c.kind for c in tds_or_eig} == {"regression-baseline"}, case
        entry = load_catalog().get(case)
        assert entry is not None and entry.verification is not None
        assert "regression baselines" in entry.verification.summary
        assert "No published or independent result exists" in entry.verification.summary


# The buses where the University of Washington archive's stored state of the IEEE 118-bus data
# is more than 2e-3 pu from the solution of the same data, with how far.
STORED_118_OFF = {"30": 0.0173, "92": 0.003, "103": 0.009}


def test_the_ieee_118_stored_state_is_not_a_solution_and_its_tolerance_is_what_it_allows() -> None:
    """The file's voltages and angles are the archive's, to the archive's digits, and are not a
    solution: pandapower's solution of the same data (the independent-solver checks of the same
    file) differs from them by up to 0.0173 pu at bus 30 and 0.303 degrees at bus 1, and the
    stored slack power by 2.5 MW. The entry quotes these, and the stored checks' tolerances are
    those numbers rounded up, not a looser figure."""
    reference = load_reference("ieee118")
    assert reference is not None
    by_kind = {
        (c.kind, c.quantity): c for c in reference.checks if c.quantity.startswith("pf.")
    }
    stored_v = by_kind[("stored-solution", "pf.bus_voltage_pu")]
    solved_v = by_kind[("independent-solver", "pf.bus_voltage_pu")]
    stored_a = by_kind[("stored-solution", "pf.bus_angle_deg")]
    solved_a = by_kind[("independent-solver", "pf.bus_angle_deg")]
    stored_p = by_kind[("stored-solution", "pf.slack_p_mw")]
    solved_p = by_kind[("independent-solver", "pf.slack_p_mw")]
    for check in (stored_v, solved_v, stored_a, solved_a):
        assert isinstance(check.expected, dict) and len(check.expected) == 118
    assert isinstance(stored_v.expected, dict) and isinstance(solved_v.expected, dict)
    assert isinstance(stored_a.expected, dict) and isinstance(solved_a.expected, dict)
    assert isinstance(stored_p.expected, float) and isinstance(solved_p.expected, float)

    dv = {k: abs(stored_v.expected[k] - solved_v.expected[k]) for k in stored_v.expected}
    da = {k: abs(stored_a.expected[k] - solved_a.expected[k]) for k in stored_a.expected}
    worst_v = max(dv, key=lambda k: dv[k])
    worst_a = max(da, key=lambda k: da[k])
    assert (worst_v, worst_a) == ("30", "1")
    assert dv[worst_v] == pytest.approx(0.0173, abs=5e-5)
    assert da[worst_a] == pytest.approx(0.303, abs=5e-4)
    assert stored_v.expected["30"] == pytest.approx(0.968) and solved_v.expected["30"] == (
        pytest.approx(0.985, abs=5e-4)
    )
    assert abs(stored_p.expected - solved_p.expected) == pytest.approx(2.54, abs=0.01)
    assert stored_p.expected == pytest.approx(516.4)
    # 114 of the 118 voltages are within 2e-3 pu (the archive keeps three decimals); the four
    # that are not are the ones the entry's numbers come from.
    off = {k: v for k, v in dv.items() if v > 2e-3}
    assert len(off) == 4 and {"30", "92", "103"} <= set(off)
    for bus, gap in STORED_118_OFF.items():
        assert dv[bus] == pytest.approx(gap, abs=6e-4), bus
    # The tolerances are the largest gaps rounded up (0.0173 to 0.02, 0.303 to 0.35, 2.54 to 3),
    # so no stored value is held to less than the stored state itself keeps.
    gap_p = abs(stored_p.expected - solved_p.expected)
    assert stored_v.tolerance.abs == 0.02 and dv[worst_v] < 0.02 < 2 * dv[worst_v]
    assert stored_a.tolerance.abs == 0.35 and da[worst_a] < 0.35 < 2 * da[worst_a]
    assert stored_p.tolerance.abs == 3.0 and gap_p < 3.0 < 2 * gap_p
    # And the solver's checks keep the tight tolerance the other cases have.
    assert solved_v.tolerance.abs == 1e-4 and solved_a.tolerance.abs == 0.01
    entry = load_catalog().get("ieee118")
    assert entry is not None
    assert "0.0173 pu (bus 30" in " ".join(entry.caveats) and "114 of the 118" in " ".join(entry.caveats)


def test_the_ieee_118_case_is_a_steady_state_power_flow_case_with_no_dynamics_to_check() -> None:
    reference = load_reference("ieee118")
    assert reference is not None
    assert reference.disturbance is None and reference.remove_events == []
    assert {c.analysis for c in reference.checks} == {"pf"}
    assert "regression-baseline" not in {c.kind for c in reference.checks}
    entry = load_catalog().get("ieee118")
    assert entry is not None
    assert entry.category == "steady-state" and entry.analyses == ["pf"]
    assert entry.size is not None and (entry.size.buses, entry.size.generators) == (118, 54)


@pytest.mark.parametrize(
    ("example_id", "buses", "generators", "kinds"),
    [
        ("ieee30", 30, 6, {"independent-solver"}),
        ("ieee57", 57, 7, {"independent-solver"}),
        ("ieee300", 300, 69, {"independent-solver", "stored-solution"}),
    ],
)
def test_the_ieee_30_57_and_300_cases_are_power_flow_cases_checked_against_a_solver_that_reads_the_file(
    example_id: str, buses: int, generators: int, kinds: set[str]
) -> None:
    """Steady-state cases have a power flow and nothing in the time domain, so nothing is a
    regression baseline, and the solver's solution is that of pandapower reading the ``.m``
    file itself, which ANDES's reader does not touch."""
    reference = load_reference(example_id)
    assert reference is not None
    assert reference.disturbance is None and reference.remove_events == []
    assert {c.analysis for c in reference.checks} == {"pf"}
    assert {c.kind for c in reference.checks} == kinds
    solver = [c for c in reference.checks if c.kind == "independent-solver"]
    assert [c.quantity for c in solver] == [
        "pf.bus_voltage_pu",
        "pf.bus_angle_deg",
        "pf.loss_mw",
        "pf.slack_p_mw",
    ]
    for check in solver:
        assert "read by matpowercaseframes" in check.reference, example_id
        if isinstance(check.expected, dict):
            assert len(check.expected) == buses
        # The tolerances every case's solver checks have, not a looser one for these.
        assert check.tolerance.abs in (1e-4, 0.01), (example_id, check.name)
    entry = load_catalog().get(example_id)
    assert entry is not None and entry.size is not None
    assert (entry.size.buses, entry.size.generators) == (buses, generators)
    # The entry lists what the reference file holds, check by check.
    assert entry.verification is not None
    assert [c.name for c in entry.verification.checks] == [c.name for c in reference.checks]


def test_the_ieee_300_stored_state_is_not_a_solution_and_its_tolerance_is_what_it_allows() -> None:
    """The file's voltages and angles are the archive's, saved with data that has a phase
    shifter the file lacks. The solution of an independent solver (the solver's checks hold it)
    differs from them by up to 0.0085 pu at bus 193 and 9.76 degrees at bus 2040, with 18 buses
    more than 1e-3 pu off and a median angle gap of 0.026 degrees. The entry quotes these, the
    tolerances of the stored checks are those numbers rounded up, and the file stores no power
    for its slack, so there is no check of it."""
    reference = load_reference("ieee300")
    assert reference is not None
    by_kind = {(c.kind, c.quantity): c for c in reference.checks}
    stored_v = by_kind[("stored-solution", "pf.bus_voltage_pu")]
    solved_v = by_kind[("independent-solver", "pf.bus_voltage_pu")]
    stored_a = by_kind[("stored-solution", "pf.bus_angle_deg")]
    solved_a = by_kind[("independent-solver", "pf.bus_angle_deg")]
    assert ("stored-solution", "pf.slack_p_mw") not in by_kind
    assert isinstance(stored_v.expected, dict) and isinstance(solved_v.expected, dict)
    assert isinstance(stored_a.expected, dict) and isinstance(solved_a.expected, dict)
    assert set(stored_v.expected) == set(solved_v.expected) and len(stored_v.expected) == 300

    dv = {k: abs(stored_v.expected[k] - solved_v.expected[k]) for k in stored_v.expected}
    da = {k: abs(stored_a.expected[k] - solved_a.expected[k]) for k in stored_a.expected}
    worst_v = max(dv, key=lambda k: dv[k])
    worst_a = max(da, key=lambda k: da[k])
    assert (worst_v, worst_a) == ("193", "2040")
    assert dv[worst_v] == pytest.approx(0.0085, abs=5e-5)
    assert da[worst_a] == pytest.approx(9.76, abs=5e-3)
    assert statistics.median(da.values()) == pytest.approx(0.026, abs=5e-4)
    assert sum(1 for gap in dv.values() if gap > 1e-3) == 18
    # The gap is one corridor's: with the phase shifter of 196-2040 put back the stored state is a
    # solution (the integration test repeats that), and the angle moves at bus 2040, which the
    # shifter feeds, and hardly at bus 196, which it leaves.
    assert da["2040"] > 9 and da["196"] < 1.5
    # The tolerances are the largest gaps rounded up, and the solver's checks keep the tight ones.
    assert stored_v.tolerance.abs == 0.01 and dv[worst_v] < 0.01 < 2 * dv[worst_v]
    assert stored_a.tolerance.abs == 10.0 and da[worst_a] < 10.0 < 2 * da[worst_a]
    assert solved_v.tolerance.abs == 1e-4 and solved_a.tolerance.abs == 0.01
    entry = load_catalog().get("ieee300")
    assert entry is not None
    text = " ".join(entry.caveats)
    assert "0.0085 pu (bus 193)" in text and "9.76 degrees (bus 2040)" in text
    assert "18 of the 300 voltages" in text and "median angle gap 0.026 degrees" in text
    assert "no output for the slack (0 MW)" in text


def test_a_check_may_say_how_its_power_flow_is_run_and_only_a_power_flow_check_may() -> None:
    document = _document()
    document["checks"][0]["pflow"] = {"enforce_q_limits": True}
    check = parse_reference(json.dumps(document)).checks[0]
    assert check.pflow is not None and check.pflow.enforce_q_limits is True
    # No settings is the power flow at TENSA's defaults, and a setting that is not one is refused.
    assert parse_reference(json.dumps(_document())).checks[0].pflow is None
    document["checks"][0]["pflow"] = {"enforce_q_limits": True, "tolerance": 1e-3}
    with pytest.raises(ReferenceFileError, match="tolerance"):
        parse_reference(json.dumps(document))
    document["checks"][0]["pflow"] = {}
    with pytest.raises(ReferenceFileError, match="enforce_q_limits"):
        parse_reference(json.dumps(document))
    # A time-domain check has no power flow of its own to set.
    tds = _document(disturbance={"description": "a trip"})
    tds["checks"][0].update(
        {"quantity": "tds.min_voltage_pu", "expected": 0.8, "pflow": {"enforce_q_limits": True}}
    )
    with pytest.raises(ReferenceFileError, match="pflow belongs to a power flow quantity only"):
        parse_reference(json.dumps(tds))


def _caveats(example_id: str) -> list[str]:
    entry = load_catalog().get(example_id)
    assert entry is not None
    return entry.caveats


def _by_kind(example_id: str) -> dict[tuple[str, str, bool], Any]:
    """The checks of a reference by kind, quantity and whether they ask the reactive limits."""
    reference = load_reference(example_id)
    assert reference is not None
    return {(c.kind, c.quantity, c.pflow is not None): c for c in reference.checks}


def test_the_rts_24_case_is_a_power_flow_case_checked_against_a_solver_that_reads_the_file() -> None:
    reference = load_reference("rts24")
    assert reference is not None
    assert reference.disturbance is None and reference.remove_events == []
    # The file starts flat and no published solution was found, so the solver is all there is.
    assert {(c.kind, c.analysis) for c in reference.checks} == {("independent-solver", "pf")}
    assert [c.quantity for c in reference.checks] == [
        "pf.bus_voltage_pu",
        "pf.bus_angle_deg",
        "pf.loss_mw",
        "pf.slack_p_mw",
    ]
    for check in reference.checks:
        assert "pglib_opf_case24_ieee_rts.m, read by matpowercaseframes" in check.reference
        if isinstance(check.expected, dict):
            assert len(check.expected) == 24
    by = _by_kind("rts24")
    # The numbers the entry quotes: 44.5 MW of losses, and the slack at 1073.0 MW (482 MW over the 591 MW its three units allow).
    assert by[("independent-solver", "pf.loss_mw", False)].expected == pytest.approx(44.527, abs=5e-4)
    slack = by[("independent-solver", "pf.slack_p_mw", False)].expected
    assert slack == pytest.approx(1073.03, abs=5e-3) and slack - 591.0 == pytest.approx(482.0, abs=0.05)
    entry = load_catalog().get("rts24")
    assert entry is not None and entry.verification is not None
    assert [c.name for c in entry.verification.checks] == [c.name for c in reference.checks]
    text = " ".join(entry.caveats)
    assert "1073.0 MW, 482 MW over" in text and "44.5 MW of losses" in text


def test_the_rts_gmlc_power_flow_is_held_to_the_solution_pss_e_printed_and_to_a_solver() -> None:
    """The solver reads the RAW file with a reader of the script's own. The published solution is
    PSS/E's, printed to four decimals of a voltage and two of an angle, for a copy of the file;
    held to it with the reactive limits enforced (the way it was solved) it is held to its rounding,
    and at the defaults to twice that."""
    reference = load_reference("rts_gmlc")
    assert reference is not None
    assert reference.disturbance is None and reference.remove_events == []
    assert {c.analysis for c in reference.checks} == {"pf"}
    assert {c.kind for c in reference.checks} == {"independent-solver", "published"}
    by = _by_kind("rts_gmlc")
    for check in (c for c in reference.checks if c.kind == "independent-solver"):
        assert "read by the PSS/E reader of scripts/crosscheck_pf.py" in check.reference
        assert check.pflow is None and check.tolerance.abs in (1e-4, 0.01)
    default_v = by[("published", "pf.bus_voltage_pu", False)]
    limited_v = by[("published", "pf.bus_voltage_pu", True)]
    default_a = by[("published", "pf.bus_angle_deg", False)]
    limited_a = by[("published", "pf.bus_angle_deg", True)]
    solver_v = by[("independent-solver", "pf.bus_voltage_pu", False)]
    solver_a = by[("independent-solver", "pf.bus_angle_deg", False)]
    for check in (default_v, limited_v, default_a, limited_a, solver_v, solver_a):
        assert isinstance(check.expected, dict) and len(check.expected) == 73
    # Both are the one report's numbers.
    assert limited_v.expected == default_v.expected and limited_a.expected == default_a.expected
    assert (default_v.tolerance.abs, limited_v.tolerance.abs) == (2e-4, 1e-4)
    assert (default_a.tolerance.abs, limited_a.tolerance.abs) == (0.02, 0.01)
    assert limited_v.pflow is not None and limited_v.pflow.enforce_q_limits
    for kind_checks in (
        (default_v, limited_v, default_a, limited_a),
        (
            by[("published", "pf.slack_p_mw", False)],
            by[("published", "pf.slack_p_mw", True)],
        ),
    ):
        for check in kind_checks:
            assert "RTSOP_PSSE_Hooman.txt" in check.reference and "TENSA did not compute it" in check.reference
    assert by[("published", "pf.slack_p_mw", False)].expected == 220.0
    # The solver's solution, which holds no reactive limits, is the gap the entry quotes from the
    # report: 1.0e-4 pu at bus 315 and 0.0054 degrees at bus 312, inside the tolerances of the
    # defaults and not inside those that go with the limits.
    assert isinstance(solver_v.expected, dict) and isinstance(default_v.expected, dict)
    assert isinstance(solver_a.expected, dict) and isinstance(default_a.expected, dict)
    gap_v = {k: abs(solver_v.expected[k] - default_v.expected[k]) for k in default_v.expected}
    gap_a = {k: abs(solver_a.expected[k] - default_a.expected[k]) for k in default_a.expected}
    assert max(gap_v, key=lambda k: gap_v[k]) == "315" and max(gap_v.values()) == pytest.approx(1.0e-4, abs=1e-6)
    assert max(gap_a, key=lambda k: gap_a[k]) == "312" and max(gap_a.values()) == pytest.approx(0.0054, abs=5e-5)
    assert max(gap_v.values()) <= default_v.tolerance.bound(1.0) < 2 * max(gap_v.values()) + 1e-12
    entry = load_catalog().get("rts_gmlc")
    assert entry is not None and entry.verification is not None
    assert [c.name for c in entry.verification.checks] == [c.name for c in reference.checks]
    assert "to 1.0e-4 pu and the angles to 0.0054 degrees" in entry.verification.summary


def test_the_rts_gmlc_stored_state_is_not_a_solution_and_no_check_rests_on_it() -> None:
    """The bus voltages and angles the RAW file stores are 0.081 pu and 18.1 degrees from a solution,
    both at bus 307, while the slack's 220 MW is the solution's. The entry says so, and the reference
    has no stored-solution check for it."""
    reference = load_reference("rts_gmlc")
    assert reference is not None and "stored-solution" not in {c.kind for c in reference.checks}
    script = load_module("crosscheck_pf_for_references", SCRIPTS_DIR / "crosscheck_pf.py")
    raw = script._ppc_from_raw_file(  # noqa: SLF001
        example_catalog.bundled_cases_dir() / "RTS-GMLC.RAW"
    )
    stored = {str(int(row[0])): (row[7], row[8]) for row in raw["bus"]}
    by = _by_kind("rts_gmlc")
    solved_v, solved_a = by[("independent-solver", "pf.bus_voltage_pu", False)], by[("independent-solver", "pf.bus_angle_deg", False)]
    assert isinstance(solved_v.expected, dict) and isinstance(solved_a.expected, dict)
    dv = {k: abs(stored[k][0] - solved_v.expected[k]) for k in stored}
    da = {k: abs(stored[k][1] - solved_a.expected[k]) for k in stored}
    assert (max(dv, key=lambda k: dv[k]), max(da, key=lambda k: da[k])) == ("307", "307")
    assert max(dv.values()) == pytest.approx(0.0812, abs=5e-5)
    assert max(da.values()) == pytest.approx(18.11, abs=5e-3)
    slack = by[("independent-solver", "pf.slack_p_mw", False)].expected
    assert slack == pytest.approx(220.0, abs=0.01)
    text = " ".join(_caveats("rts_gmlc"))
    assert "0.081 pu and 18.1 degrees (both at bus 307)" in text and "220 MW" in text


def test_the_activsg_200_stored_state_is_a_solution_with_the_reactive_limits_enforced() -> None:
    """PowerWorld stored a state solved with the generators' reactive limits held. TENSA's power flow
    without them (its default) is up to 0.0038 pu, 0.031 degrees and 0.027 MW from it, at the bus of a
    generator that is outside a limit; with them it is the 1e-5 pu the entry quotes. The checks of
    the first are held to what those gaps need, and the others to a tolerance a tenth of that."""
    reference = load_reference("activsg200")
    assert reference is not None
    assert {c.kind for c in reference.checks} == {"independent-solver", "stored-solution"}
    by = _by_kind("activsg200")
    default_v, limited_v = by[("stored-solution", "pf.bus_voltage_pu", False)], by[("stored-solution", "pf.bus_voltage_pu", True)]
    default_a, limited_a = by[("stored-solution", "pf.bus_angle_deg", False)], by[("stored-solution", "pf.bus_angle_deg", True)]
    default_p, limited_p = by[("stored-solution", "pf.slack_p_mw", False)], by[("stored-solution", "pf.slack_p_mw", True)]
    assert (default_v.tolerance.abs, limited_v.tolerance.abs) == (0.005, 1e-4)
    assert (default_a.tolerance.abs, limited_a.tolerance.abs) == (0.05, 0.005)
    assert (default_p.tolerance.abs, limited_p.tolerance.abs) == (0.05, 0.05)
    # One stored state, held to two tolerances.
    assert limited_v.expected == default_v.expected and limited_a.expected == default_a.expected
    assert limited_p.expected == default_p.expected == pytest.approx(384.37)
    solved_v = by[("independent-solver", "pf.bus_voltage_pu", False)].expected
    solved_a = by[("independent-solver", "pf.bus_angle_deg", False)].expected
    solved_p = by[("independent-solver", "pf.slack_p_mw", False)].expected
    assert isinstance(solved_v, dict) and isinstance(solved_a, dict)
    assert isinstance(default_v.expected, dict) and isinstance(default_a.expected, dict)
    assert len(default_v.expected) == 200
    dv = {k: abs(default_v.expected[k] - solved_v[k]) for k in solved_v}
    da = {k: abs(default_a.expected[k] - solved_a[k]) for k in solved_a}
    worst = max(dv, key=lambda k: dv[k])
    assert worst == max(da, key=lambda k: da[k]) == "114"
    assert dv[worst] == pytest.approx(0.0038, abs=5e-5) and da[worst] == pytest.approx(0.031, abs=5e-4)
    assert abs(solved_p - 384.37) == pytest.approx(0.027, abs=5e-4)
    # The default tolerances are the gaps rounded up (not the ones of the limited run).
    assert dv[worst] < default_v.tolerance.bound(1.0) < 2 * dv[worst]
    assert da[worst] < default_a.tolerance.bound(1.0) < 2 * da[worst]
    text = " ".join(_caveats("activsg200"))
    assert "(bus 114, stored 1.0362 against the 1.04 set-point) and 0.031 degrees" in text
    assert "0.027 MW" in text and "buses 67, 94, 114 and 167" in text


def _matpower_block(text: str, field: str) -> list[list[float]]:
    """The numbers of one block of a MATPOWER case file; ``Inf`` is read as infinity."""
    import re

    block = re.search(rf"mpc\.{field} = \[(.*?)\];", text, re.S)
    assert block is not None, field
    rows = []
    for line in block.group(1).splitlines():
        line = line.split("%")[0].strip().rstrip(";")
        if line:
            rows.append([float(v.replace("Inf", "inf")) for v in line.split()])
    return rows


def _stored_bus_state(name: str) -> dict[str, tuple[float, float]]:
    """The voltage (pu) and angle (degrees) a MATPOWER file stores for each bus, by its number."""
    text = (example_catalog.bundled_cases_dir() / name).read_text(encoding="utf-8")
    return {str(int(row[0])): (row[7], row[8]) for row in _matpower_block(text, "bus")}



def test_the_pegase_references_are_the_solution_of_the_network_as_andes_reads_it() -> None:
    """The files give three and six branches a phase shift and a ratio of 0, which ANDES's reader
    drops, so the solver's checks say they leave them out and by how much the solution with them
    differs (the entries quote the same numbers)."""
    for example_id, branches, volts, degrees in (
        ("pegase89", 3, "0 pu", "0.43 degrees"),
        ("pegase1354", 6, "6e-05 pu", "0.087 degrees"),
    ):
        reference = load_reference(example_id)
        assert reference is not None
        solver = [c for c in reference.checks if c.kind == "independent-solver"]
        assert len(solver) == 4
        for check in solver:
            assert f"phase shift of {branches} branches that have a ratio of 0 left out" in check.reference
            assert f"by at most {volts} in a bus voltage and {degrees} in a bus angle" in check.reference
            assert "read by matpowercaseframes" in check.reference
    # A file with no such branch says nothing of the kind.
    plain = load_reference("activsg2000")
    assert plain is not None
    assert not any("phase shift" in c.reference for c in plain.checks)


def test_the_pegase_89_stored_state_is_held_to_the_buses_that_are_a_solution() -> None:
    """RTE's state is a solution at 86 of the 89 buses, to 1.6e-6 pu and 0.002 degrees; at three leaf
    buses that carry a negative load its angle is 8.9 to 25 degrees off, so the check of the angles
    leaves them out, and the voltage check, which agrees there, does not."""
    reference = load_reference("pegase89")
    assert reference is not None
    by = _by_kind("pegase89")
    stored_v = by[("stored-solution", "pf.bus_voltage_pu", False)]
    stored_a = by[("stored-solution", "pf.bus_angle_deg", False)]
    stored_p = by[("stored-solution", "pf.slack_p_mw", False)]
    solved_v = by[("independent-solver", "pf.bus_voltage_pu", False)].expected
    solved_a = by[("independent-solver", "pf.bus_angle_deg", False)].expected
    assert isinstance(stored_v.expected, dict) and isinstance(stored_a.expected, dict)
    assert isinstance(solved_v, dict) and isinstance(solved_a, dict)
    assert len(stored_v.expected) == 89 and len(stored_a.expected) == 86
    assert set(solved_a) - set(stored_a.expected) == {"8581", "7526", "2154"}
    dv = max(abs(stored_v.expected[k] - solved_v[k]) for k in solved_v)
    da = max(abs(stored_a.expected[k] - solved_a[k]) for k in stored_a.expected)
    assert dv == pytest.approx(1.6e-6, abs=5e-8) and da == pytest.approx(0.002, abs=5e-4)
    assert stored_v.tolerance.abs == 1e-5 and stored_a.tolerance.abs == 0.01
    assert stored_p.expected == pytest.approx(1249.4)
    solved_p = by[("independent-solver", "pf.slack_p_mw", False)].expected
    assert abs(float(stored_p.expected) - float(solved_p)) == pytest.approx(0.3, abs=0.01)  # type: ignore[arg-type]
    # The three leaves: the stored angle is far off the solution's, and the voltage is not.
    stored = _stored_bus_state("case89pegase.m")
    gaps = {k: abs(stored[k][1] - solved_a[k]) for k in ("8581", "7526", "2154")}
    assert gaps["8581"] == pytest.approx(24.535, abs=5e-3)
    assert gaps["7526"] == pytest.approx(10.231, abs=5e-3)
    assert gaps["2154"] == pytest.approx(8.776, abs=5e-3)
    # With the three phase shifts applied, as MATPOWER defines the network, each gap is the shift larger.
    assert gaps["8581"] + 0.428 == pytest.approx(24.96, abs=5e-3)
    assert all(abs(stored[k][0] - solved_v[k]) < 2e-6 for k in gaps)
    text = " ".join(_caveats("pegase89"))
    assert "24.5, 10.2 and 8.8 degrees" in text and "24.96, 10.41 and 8.93" in text


def test_the_pegase_1354_stored_state_is_not_a_solution_and_no_check_rests_on_it() -> None:
    reference = load_reference("pegase1354")
    assert reference is not None and "stored-solution" not in {c.kind for c in reference.checks}
    by = _by_kind("pegase1354")
    solved_v = by[("independent-solver", "pf.bus_voltage_pu", False)].expected
    solved_a = by[("independent-solver", "pf.bus_angle_deg", False)].expected
    assert isinstance(solved_v, dict) and isinstance(solved_a, dict) and len(solved_v) == 1354
    stored = _stored_bus_state("case1354pegase.m")
    dv = {k: abs(stored[k][0] - solved_v[k]) for k in stored}
    da = {k: abs(stored[k][1] - solved_a[k]) for k in stored}
    assert sum(1 for gap in dv.values() if gap > 1e-4) == 117
    assert sum(1 for gap in da.values() if gap > 0.1) == 561
    assert max(dv.values()) == pytest.approx(0.004, abs=5e-4)
    assert max(da.values()) == pytest.approx(5.5, abs=0.05)
    text = (example_catalog.bundled_cases_dir() / "case1354pegase.m").read_text(encoding="utf-8")
    gens = _matpower_block(text, "gen")
    slack_stored = next(row[1] for row in gens if row[0] == 4231.0)
    slack_solved = by[("independent-solver", "pf.slack_p_mw", False)].expected
    assert slack_stored == pytest.approx(2641.24)
    assert float(slack_stored) - float(slack_solved) == pytest.approx(30.0, abs=0.5)  # type: ignore[arg-type]
    text = " ".join(_caveats("pegase1354"))
    assert "117 stored voltages are more than 1e-4 pu" in text and "21 buses" in text
    assert "561 stored angles are more than 0.1 degrees" in text


def test_the_activsg_2000_stored_state_is_held_to_the_gaps_it_has_and_the_entry_says_so() -> None:
    """PowerWorld's state is a solution, with 153 of the 392 generator buses at a limit, and no power
    flow of TENSA lands on it: the checks are the gaps rounded up, and weak by construction."""
    reference = load_reference("activsg2000")
    assert reference is not None
    assert {c.kind for c in reference.checks} == {"independent-solver", "stored-solution"}
    by = _by_kind("activsg2000")
    solved_v = by[("independent-solver", "pf.bus_voltage_pu", False)].expected
    solved_a = by[("independent-solver", "pf.bus_angle_deg", False)].expected
    assert isinstance(solved_v, dict) and isinstance(solved_a, dict) and len(solved_v) == 2000
    for limited, (volts, degrees, megawatts) in ((False, (0.04, 0.7, 17.0)), (True, (0.035, 1.0, 4.0))):
        v = by[("stored-solution", "pf.bus_voltage_pu", limited)]
        a = by[("stored-solution", "pf.bus_angle_deg", limited)]
        p = by[("stored-solution", "pf.slack_p_mw", limited)]
        assert (v.tolerance.abs, a.tolerance.abs, p.tolerance.abs) == (volts, degrees, megawatts)
        assert p.expected == pytest.approx(1236.1)
        assert (v.pflow is not None) is limited
    stored_v = by[("stored-solution", "pf.bus_voltage_pu", False)].expected
    stored_a = by[("stored-solution", "pf.bus_angle_deg", False)].expected
    assert isinstance(stored_v, dict) and isinstance(stored_a, dict)
    dv = {k: abs(stored_v[k] - solved_v[k]) for k in solved_v}
    da = {k: abs(stored_a[k] - solved_a[k]) for k in solved_a}
    # The solver's solution (no limits) against the stored state: the gaps the tolerances are made of.
    assert max(dv, key=lambda k: dv[k]) == "4195" and max(dv.values()) == pytest.approx(0.0352, abs=5e-4)
    assert max(da, key=lambda k: da[k]) == "3137" and max(da.values()) == pytest.approx(0.639, abs=5e-3)
    assert max(dv.values()) < 0.04 < 1.2 * max(dv.values())
    text = " ".join(_caveats("activsg2000"))
    assert "153 of the 392 generator buses" in text and "so they catch only a gross" in text
    assert "no power flow of TENSA lands on the stored state" in text
