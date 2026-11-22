"""The pure comparison functions of ``tensa.engines.compare``.

Every expected number is worked out by hand beside its assertion, never by
calling the code under test twice.
"""

from __future__ import annotations

import math

import pytest

from tensa.engines.compare import (
    DEFAULT_TOLERANCES,
    CompareError,
    ComparisonInput,
    clean_series,
    compare_documents,
    compare_rows,
    compare_series,
    match_eigenvalues,
    wrap_angle,
)
from tensa.engines.results_doc import (
    EngineBlock,
    PflowBusRow,
    PflowTable,
    ResultsDocument,
    ResultsTables,
    Series,
)

pytestmark = pytest.mark.unit


def test_clean_series_drops_nonfinite_and_keeps_steps() -> None:
    t, y = clean_series([0.0, 1.0, 1.0, 2.0, 3.0], [0.0, 1.0, 9.0, None, 4.0])

    assert list(t) == [0.0, 1.0, 1.0, 3.0]
    assert list(y) == [0.0, 1.0, 9.0, 4.0]


def test_clean_series_rejects_unequal_lengths() -> None:
    with pytest.raises(CompareError, match="same length"):
        clean_series([0.0, 1.0, 2.0], [0.0, 1.0])


def test_clean_series_rejects_decreasing_times() -> None:
    with pytest.raises(CompareError, match="t must not decrease"):
        clean_series([0.0, 2.0, 1.0], [0.0, 1.0, 2.0])


def test_wrap_angle_into_minus_pi_pi() -> None:
    assert wrap_angle(0.1 - 2.0 * math.pi) == pytest.approx(0.1)
    assert wrap_angle(math.pi) == pytest.approx(-math.pi)
    assert wrap_angle(-math.pi) == pytest.approx(-math.pi)


def test_compare_series_time_weighted_rms() -> None:
    # Reference y = 0 at t = 0, 1, 2; comparison y = 1 at t = 0 and t = 0.1,
    # then y = 0 from t = 1 on. The dense pair of samples near 0 must not
    # weigh more than its time: d is 1 on [0, 0.5] by interpolation (the
    # comparison line falls from 1 at 0.1 to 0 at 1, crossing 0.5 at 0.55),
    # so the integral of d^2 is worked out exactly below.
    # comparison on the union grid [0, 0.1, 1, 2]: [1, 1, 0, 0]
    # d = [1, 1, 0, 0]; trapezoids: [0, 0.1]: 0.1 * (1+1)/2 = 0.1;
    # [0.1, 1]: 0.9 * (1+0)/2 = 0.45; [1, 2]: 0. Integral = 0.55, span = 2.
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0, 2.0],
        [0.0, 0.0, 0.0],
        [0.0, 0.1, 1.0, 2.0],
        [1.0, 1.0, 0.0, 0.0],
        tolerance=2.0,
    )

    assert diff.rms_diff == pytest.approx(math.sqrt(0.55 / 2.0))
    assert diff.max_diff == pytest.approx(1.0)
    assert diff.max_diff_t == pytest.approx(0.0)
    assert diff.t_start == 0.0
    assert diff.t_end == 2.0
    assert diff.samples == 4
    assert diff.within_tolerance is True


def test_compare_series_linear_interpolation_between_grids() -> None:
    # reference y = x on [0, 1, 2]; comparison y = x + 0.1 on [0, 0.5, 1, 1.5, 2].
    # d is 0.1 everywhere; integral of d^2 over [0, 2] is 0.02, span 2.
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0, 2.0],
        [0.0, 1.0, 2.0],
        [0.0, 0.5, 1.0, 1.5, 2.0],
        [0.1, 0.6, 1.1, 1.6, 2.1],
        tolerance=0.05,
    )

    assert diff.max_diff == pytest.approx(0.1)
    assert diff.rms_diff == pytest.approx(0.1)
    assert diff.samples == 5
    assert diff.within_tolerance is False
    assert diff.tolerance == 0.05


def test_compare_series_swing_of_reference() -> None:
    diff = compare_series(
        "rotor_speed",
        "gen:1-1",
        "pu",
        [0.0, 1.0, 2.0],
        [1.0, -1.0, 0.5],
        [0.0, 1.0, 2.0],
        [1.0, -1.0, 0.5],
        tolerance=1e-3,
    )

    assert diff.swing_ref == pytest.approx(2.0)  # 1.0 - (-1.0)
    assert diff.max_diff == 0.0
    assert diff.rms_diff == 0.0
    assert diff.within_tolerance is True


def test_compare_series_truncates_to_overlap_and_reports_bounds() -> None:
    # The reference spikes to 100 at t = 9.5, outside the comparison's range;
    # the overlap is [2, 8] and the spike must not count.
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 2.0, 8.0, 9.5, 10.0],
        [1.0, 1.0, 1.0, 100.0, 1.0],
        [2.0, 5.0, 8.0],
        [1.0, 1.0, 1.0],
        tolerance=1.0,
    )

    assert diff.t_start == 2.0
    assert diff.t_end == 8.0
    assert diff.max_diff == pytest.approx(0.0)


def test_compare_series_no_overlap_is_an_error() -> None:
    with pytest.raises(CompareError, match="do not overlap"):
        compare_series(
            "voltage",
            "bus:1",
            "pu",
            [0.0, 1.0],
            [0.0, 1.0],
            [2.0, 3.0],
            [0.0, 1.0],
            tolerance=1.0,
        )


def test_compare_series_single_common_instant() -> None:
    # Overlap of zero length at t = 2: the RMS is the absolute difference there.
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 2.0],
        [0.0, 1.0],
        [2.0, 3.0],
        [1.5, 2.0],
        tolerance=1.0,
    )

    assert diff.t_start == 2.0
    assert diff.t_end == 2.0
    assert diff.max_diff == pytest.approx(0.5)  # 1.5 - 1.0
    assert diff.rms_diff == pytest.approx(0.5)


def test_compare_series_step_uses_both_sides_for_the_maximum() -> None:
    # A step at t = 1 in the comparison: left value 0, right value 2. The
    # reference is 0 throughout. The difference at the step is 0 on the left
    # and 2 on the right; the larger counts.
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0, 2.0],
        [0.0, 0.0, 0.0],
        [0.0, 1.0, 1.0, 2.0],
        [0.0, 0.0, 2.0, 2.0],
        tolerance=1.0,
    )

    assert diff.max_diff == pytest.approx(2.0)
    # From the step on, d is 2: integral over [1, 2] of 4 dt is 4; before it 0.
    # span 2, rms = sqrt(4 / 2) = sqrt(2).
    assert diff.rms_diff == pytest.approx(math.sqrt(2.0))


def test_compare_series_gap_splits_and_reduces_the_span() -> None:
    # The comparison has a gap over (1, 3): nothing is compared there, and the
    # span is reduced accordingly. d is 1 on [0, 1] and 0 on [3, 4].
    # integral = 1 * 1 + 0 = 1; span = 1 + 1 = 2; rms = sqrt(0.5).
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0, 2.0, 3.0, 4.0],
        [0.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 2.0, 3.0, 4.0],
        [1.0, 1.0, None, 0.0, 0.0],
        tolerance=2.0,
    )

    assert diff.rms_diff == pytest.approx(math.sqrt(0.5))
    assert diff.max_diff == pytest.approx(1.0)


def test_compare_series_angles_are_wrapped() -> None:
    # 0.1 rad against 2*pi + 0.05 rad: the wrapped difference is -0.05 rad.
    diff = compare_series(
        "rotor_angle",
        "gen:1-1",
        "rad",
        [0.0, 1.0],
        [0.1, 0.1],
        [0.0, 1.0],
        [2.0 * math.pi + 0.05, 2.0 * math.pi + 0.05],
        tolerance=0.1,
    )

    assert diff.max_diff == pytest.approx(0.05)
    assert diff.rms_diff == pytest.approx(0.05)
    assert diff.within_tolerance is True


def test_compare_series_tolerance_boundary() -> None:
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0],
        [0.0, 0.0],
        [0.0, 1.0],
        [0.5, 0.5],
        tolerance=0.5,
    )
    assert diff.within_tolerance is True

    over = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0],
        [0.0, 0.0],
        [0.0, 1.0],
        [math.nextafter(0.5, 1.0), math.nextafter(0.5, 1.0)],
        tolerance=0.5,
    )
    assert over.within_tolerance is False


def test_compare_series_too_few_samples_names_the_key() -> None:
    with pytest.raises(CompareError, match="bus:9"):
        compare_series(
            "voltage",
            "bus:9",
            "pu",
            [0.0],
            [1.0],
            [0.0, 1.0],
            [1.0, 1.0],
            tolerance=1.0,
        )


def test_compare_series_without_tolerance_has_no_verdict() -> None:
    diff = compare_series(
        "some_quantity",
        "bus:1",
        "pu",
        [0.0, 1.0],
        [0.0, 0.0],
        [0.0, 1.0],
        [1.0, 1.0],
        tolerance=None,
    )

    assert diff.within_tolerance is None
    assert diff.tolerance is None


def test_compare_rows_lists_unmatched_keys() -> None:
    rows, unmatched = compare_rows(
        "voltage",
        "pu",
        {"bus:1": 1.0, "bus:2": 1.0, "bus:3": 1.0},
        {"bus:2": 1.01, "bus:3": 1.0, "bus:4": 1.0},
        tolerance=0.1,
    )

    assert [row.key for row in rows] == ["bus:2", "bus:3"]
    assert rows[0].diff == pytest.approx(0.01)
    assert rows[0].within_tolerance is True
    assert unmatched.missing_in_comparison == ["bus:1"]
    assert unmatched.missing_in_reference == ["bus:4"]


def test_a_gap_is_left_out_of_the_rms_and_its_span() -> None:
    # The reference has a gap between t = 1 and t = 3. The comparison differs by
    # 1 on [0, 1] and by 3 on [3, 6]. Left out, the gap leaves
    # (1*1 + 9*3) / (1 + 3) = 7, so rms = sqrt(7). Counted, [1, 3] would add
    # 0.5 * (1 + 9) * 2 = 10 over 2 s, giving sqrt(38 / 6) instead.
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0, 2.0, 3.0, 6.0],
        [0.0, 0.0, None, 0.0, 0.0],
        [0.0, 1.0, 3.0, 6.0],
        [1.0, 1.0, 3.0, 3.0],
        tolerance=None,
    )

    assert diff.rms_diff == pytest.approx(math.sqrt(7.0))
    assert diff.max_diff == pytest.approx(3.0)


def test_the_swing_is_the_reference_series_own() -> None:
    diff = compare_series(
        "voltage",
        "bus:1",
        "pu",
        [0.0, 1.0, 2.0],
        [1.0, 0.9, 1.05],
        [0.0, 1.0, 2.0],
        [1.0, 1.0, 1.0],
        tolerance=None,
    )

    assert diff.swing_ref == pytest.approx(0.15)


def test_the_verdict_is_on_the_largest_difference_not_the_rms() -> None:
    # One spike of 0.5 at t = 5 on a 10 s run: the largest difference is 0.5,
    # over a tolerance of 0.2, while the rms is sqrt(2 * 0.5 * 0.25 * 1 / 10),
    # about 0.158, under it. The row is outside its tolerance.
    t = [float(k) for k in range(11)]
    spike = [0.0] * 11
    spike[5] = 0.5
    diff = compare_series(
        "voltage", "bus:1", "pu", t, [0.0] * 11, t, spike, tolerance=0.2
    )

    assert diff.max_diff == pytest.approx(0.5)
    assert diff.max_diff_t == pytest.approx(5.0)
    assert diff.rms_diff == pytest.approx(math.sqrt(0.025))
    assert diff.within_tolerance is False


def test_match_eigenvalues_conjugate_pairs_counted_once() -> None:
    pairs, unmatched_ref, unmatched_new = match_eigenvalues(
        [-0.5 + 2j, -0.5 - 2j, -3.0 + 0j],
        [-0.5 + 2j, -0.5 - 2j, -3.0 + 0j],
        max_distance=0.05,
    )

    assert len(pairs) == 2  # one oscillatory mode and one real eigenvalue
    assert unmatched_ref == []
    assert unmatched_new == []


def test_match_eigenvalues_optimal_not_greedy() -> None:
    # ref order [4.1j, 4j]: a greedy pass in input order pairs (4.1, 4.05) at
    # 0.05 and then (4, 4.15) at 0.15, total 0.20. The optimum is the uncrossed
    # one: (4.1, 4.15) and (4, 4.05), total 0.10.
    pairs, _, _ = match_eigenvalues(
        [4.1j, 4j],
        [4.05j, 4.15j],
        max_distance=1.0,
    )

    by_ref = {pair.index_ref: pair for pair in pairs}
    assert by_ref[0].index_new == 1  # 4.1j with 4.15j
    assert by_ref[1].index_new == 0  # 4j with 4.05j
    assert sum(pair.distance for pair in pairs) == pytest.approx(0.10)


def test_match_eigenvalues_recovers_a_shuffled_spectrum_of_a_large_case_quickly() -> None:
    """A spectrum the size of a large case (some 800 modes, as Nordic 44 has)
    listed in another order by the other engine, each value nudged by 1e-6: every
    mode is paired with its own, and the matching takes well under a second."""
    import random
    import time

    rng = random.Random(7)
    ref: list[complex] = []
    for k in range(400):
        real, imag = -0.05 - 0.01 * k, 0.3 + 0.02 * k
        ref += [complex(real, imag), complex(real, -imag)]
    order = list(range(len(ref)))
    rng.shuffle(order)
    new = [ref[i] + 1e-6 for i in order]

    started = time.monotonic()
    pairs, unmatched_ref, unmatched_new = match_eigenvalues(ref, new, max_distance=0.05)
    elapsed = time.monotonic() - started

    assert unmatched_ref == []
    assert unmatched_new == []
    assert len(pairs) == 400  # one per conjugate pair
    for pair in pairs:
        assert order[pair.index_new] == pair.index_ref
    assert elapsed < 2.0


def test_match_eigenvalues_distance_cap_leaves_both_sides_unmatched() -> None:
    pairs, unmatched_ref, unmatched_new = match_eigenvalues(
        [4.0j], [4.2j], max_distance=0.05
    )

    assert pairs == []
    assert unmatched_ref == [0]
    assert unmatched_new == [0]


def test_match_eigenvalues_zero_eigenvalues_matched_among_themselves() -> None:
    pairs, unmatched_ref, unmatched_new = match_eigenvalues(
        [0.0 + 0.0j, -1.0 + 5.0j],
        [-1.0 + 5.0j, 0.0 + 0.0j],
        max_distance=0.05,
    )

    zero_pair = next(pair for pair in pairs if pair.eigenvalue_ref == 0.0 + 0.0j)
    assert zero_pair.index_ref == 0
    assert zero_pair.index_new == 1
    assert zero_pair.damping_ratio_ref == 1.0
    assert unmatched_ref == []
    assert unmatched_new == []


def test_match_eigenvalues_frequency_damping_and_tolerance() -> None:
    z = -0.5 + 4.0j
    pairs, _, _ = match_eigenvalues([z], [z], max_distance=0.05)
    (pair,) = pairs

    assert pair.frequency_hz_ref == pytest.approx(4.0 / (2.0 * math.pi), rel=1e-12)
    assert pair.damping_ratio_ref == pytest.approx(0.5 / math.hypot(0.5, 4.0), rel=1e-12)
    assert pair.within_tolerance is True

    # A damping difference above the tolerance flips the verdict.
    other = -0.6 + 4.0j  # damping 0.6/hypot(0.6, 4) = 0.1485 vs 0.1240; diff 0.0245
    pairs2, _, _ = match_eigenvalues(
        [z], [other], max_distance=1.0, damping_tolerance=0.01
    )
    assert pairs2[0].within_tolerance is False


def _doc(
    series: list[Series],
    pflow: PflowTable | None = None,
) -> ComparisonInput:
    document = ResultsDocument(
        tensa_results=1,
        engine=EngineBlock(name="andes", versions={"andes": "2.0.0"}),
        study=None,
        status="completed",
        series=series,
        tables=ResultsTables(pflow=pflow),
    )
    return ComparisonInput.from_document(document)


def _pflow(v: float) -> PflowTable:
    return PflowTable(
        converged=True,
        buses=[PflowBusRow(key="bus:1", v_pu=v, angle_rad=0.0)],
        branches=[],
        generators=[],
        loads=[],
    )


def test_compare_documents_power_flow_first_and_operating_point_flag() -> None:
    reference = _doc(
        [Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0])],
        pflow=_pflow(1.0),
    )
    comparison = _doc(
        [Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0])],
        pflow=_pflow(1.5),  # 0.5 pu off: outside the 1e-4 default
    )

    result = compare_documents(reference, comparison, tolerances={})

    assert result.power_flow is not None
    assert result.power_flow.rows[0].quantity == "voltage"
    assert result.power_flow.rows[0].diff == pytest.approx(0.5)
    assert result.operating_point_differs is True
    assert len(result.series) == 1


def test_compare_documents_same_operating_point_is_not_flagged() -> None:
    result = compare_documents(_doc([], pflow=_pflow(1.0)), _doc([], pflow=_pflow(1.0)), tolerances={})

    assert result.operating_point_differs is False


def test_compare_documents_unit_mismatch_raises() -> None:
    reference = _doc([Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0])])
    comparison = _doc([Series(quantity="voltage", of="bus:1", unit="kV", t=[0.0, 1.0], y=[1.0, 1.0])])

    with pytest.raises(CompareError, match="bus:1.*pu.*kV"):
        compare_documents(reference, comparison, tolerances={})


def test_compare_documents_unmatched_series_are_listed() -> None:
    reference = _doc([Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0])])
    comparison = _doc(
        [
            Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0]),
            Series(quantity="voltage", of="bus:2", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0]),
        ]
    )

    result = compare_documents(reference, comparison, tolerances={})

    assert result.unmatched_series_comparison == ["voltage|bus:2"]
    assert result.unmatched_series_reference == []
    assert len(result.series) == 1


def test_compare_documents_state_series_are_never_compared() -> None:
    reference = _doc(
        [Series(quantity="state", of="gen:1-1/machine#delta", unit="rad", t=[0.0, 1.0], y=[1.0, 1.0])]
    )
    comparison = _doc(
        [Series(quantity="state", of="gen:1-1/machine#delta", unit="rad", t=[0.0, 1.0], y=[2.0, 2.0])]
    )

    result = compare_documents(reference, comparison, tolerances={})

    assert result.series == []
    assert len(result.not_comparable) == 1
    assert "never compared" in result.not_comparable[0].reason


def test_compare_documents_a_bad_series_does_not_fail_the_rest() -> None:
    reference = _doc(
        [
            Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 2.0, 1.0], y=[1.0, 1.0, 1.0]),
            Series(quantity="voltage", of="bus:2", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0]),
        ]
    )
    comparison = _doc(
        [
            Series(quantity="voltage", of="bus:1", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0]),
            Series(quantity="voltage", of="bus:2", unit="pu", t=[0.0, 1.0], y=[1.0, 1.0]),
        ]
    )

    result = compare_documents(reference, comparison, tolerances={})

    assert len(result.series) == 1
    assert result.series[0].key == "bus:2"
    assert len(result.errors) == 1
    assert "t must not decrease" in result.errors[0]


def test_default_tolerances_cover_the_catalogue() -> None:
    for quantity in (
        "voltage",
        "angle",
        "angle_rel",
        "rotor_speed",
        "rotor_angle",
        "rotor_angle_rel",
        "p",
        "q",
        "p_from",
        "q_from",
    ):
        assert quantity in DEFAULT_TOLERANCES
    assert "state" not in DEFAULT_TOLERANCES
