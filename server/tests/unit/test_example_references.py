"""The reference files of the example cases: ``examples/references/<id>.json``.

``tensa.core.example_references`` holds their schema and ``scripts/verify_example_cases.py``
compares a run of TENSA with them. These tests hold the files that ship to the schema and to
the catalog (a reference of a case the catalog does not have, a map that misses a bus, a
default case with nothing to check it against), and hold the schema to what it promises.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tensa.core.example_catalog import load_catalog
from tensa.core.example_references import (
    ExampleReference,
    ReferenceFileError,
    Tolerance,
    load_reference,
    parse_reference,
    references_dir,
)

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
                assert check.kind == "independent-solver", (stem, check.name)


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
