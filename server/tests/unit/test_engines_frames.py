"""Unit tests for ``tensa.engines.frames``: relative reference frames for
angles (unit 5a). Pure numpy; no engine."""

from __future__ import annotations

import numpy as np
import pytest

from tensa.engines.frames import (
    WRAP_PERIOD,
    angle_rel,
    rotor_angle_rel,
    unwrap_angle,
    wrap_angle,
)


@pytest.mark.unit
def test_wrap_angle_interval() -> None:
    source = np.array(
        [0.0, np.pi, -np.pi, 7.0, -7.0, 2.0 * np.pi], dtype=np.float64
    )
    original = source.copy()
    result = wrap_angle(source)
    # By hand: pi maps to -pi (half-open interval), -pi stays -pi,
    # 7 - 2*pi = 0.7168146928204138, -7 + 2*pi = -0.7168146928204138,
    # 2*pi maps to 0.
    expected = np.array(
        [0.0, -np.pi, -np.pi, 7.0 - 2.0 * np.pi, -7.0 + 2.0 * np.pi, 0.0]
    )
    np.testing.assert_allclose(result, expected, rtol=0.0, atol=1e-12)
    np.testing.assert_array_equal(source, original)


@pytest.mark.unit
def test_wrap_angle_nan_and_inf() -> None:
    result = wrap_angle(np.array([np.nan, np.inf, 1.0]))
    assert np.isnan(result[0])
    assert np.isnan(result[1])
    assert result[2] == 1.0


@pytest.mark.unit
def test_wrap_angle_zero_dimensional() -> None:
    result = wrap_angle(np.asarray(7.0))
    assert result.shape == ()
    # 7 - 2*pi = 0.7168146928204138.
    assert float(result) == pytest.approx(7.0 - 2.0 * np.pi, abs=1e-12)


@pytest.mark.unit
def test_wrap_period_is_two_pi() -> None:
    two_pi = 2.0 * np.pi
    assert two_pi == WRAP_PERIOD


@pytest.mark.unit
def test_angle_rel_basic() -> None:
    angles = np.array([[0.5, 1.0, -0.5], [0.6, 1.1, -0.4]])
    result = angle_rel(angles, 0)
    np.testing.assert_array_equal(result[:, 0], np.zeros(2))
    assert result[0, 1] == pytest.approx(0.5, abs=1e-15)
    assert result[1, 2] == pytest.approx(-1.0, abs=1e-15)


@pytest.mark.unit
def test_angle_rel_not_wrapped() -> None:
    # A bus at +3.10 rad against a reference at -3.10 rad reads 6.2, the plain
    # difference; a wrong implementation that wraps into [-pi, pi) would
    # answer 6.2 - 2*pi = -0.08318530717958623.
    result = angle_rel(np.array([[-3.10, 3.10]]), 0)
    assert result[0, 0] == 0.0
    assert result[0, 1] == pytest.approx(6.2, abs=1e-15)


@pytest.mark.unit
def test_angle_rel_reference_per_row() -> None:
    # The reference is taken at the same instant as each value, not as one
    # fixed value: row 1's reference is 3.0, so 4.0 - 3.0 = 1.0.
    result = angle_rel(np.array([[1.0, 2.0], [3.0, 4.0]]), 0)
    assert result[1, 1] == pytest.approx(1.0, abs=1e-15)


@pytest.mark.unit
def test_angle_rel_bad_reference_index() -> None:
    with pytest.raises(IndexError):
        angle_rel(np.zeros((2, 3)), 5)


@pytest.mark.unit
def test_angle_rel_not_2d() -> None:
    with pytest.raises(ValueError, match=r"2-D.*\(3,\)"):
        angle_rel(np.zeros(3), 0)


@pytest.mark.unit
def test_angle_rel_empty() -> None:
    result = angle_rel(np.empty((0, 3)), 1)
    assert result.shape == (0, 3)


@pytest.mark.unit
def test_angle_rel_nan_propagation() -> None:
    angles = np.array([[np.nan, 1.0, 2.0], [0.5, np.nan, 2.0]])
    result = angle_rel(angles, 0)
    # NaN in the reference column propagates to the whole row.
    assert np.isnan(result[0]).all()
    # NaN in another column propagates to that column only.
    assert result[1, 0] == 0.0
    assert np.isnan(result[1, 1])
    assert result[1, 2] == pytest.approx(1.5, abs=1e-15)


@pytest.mark.unit
def test_rotor_angle_rel_weighted_mean() -> None:
    # Mean by hand: (3*0 + 1*1) / (3 + 1) = 0.25.
    result = rotor_angle_rel(
        np.array([[0.0, 1.0]]),
        np.array([3.0, 1.0]),
        np.array([[True, True]]),
    )
    np.testing.assert_allclose(result, [[-0.25, 0.75]], rtol=0.0, atol=1e-15)


@pytest.mark.unit
def test_rotor_angle_rel_weights_are_h_times_mva_base() -> None:
    # Two machines with the same H on different MVA bases do not weigh the
    # same: the caller passes H * mbase_mva, so machine 1 (H=5, base=900)
    # outweighs machine 0 (H=5, base=100) nine to one.
    # Mean by hand: (500*0.0 + 4500*1.0) / 5000 = 0.9.
    result = rotor_angle_rel(
        np.array([[0.0, 1.0]]),
        np.array([5.0 * 100.0, 5.0 * 900.0]),
        np.array([[True, True]]),
    )
    np.testing.assert_allclose(result, [[-0.9, 0.1]], rtol=0.0, atol=1e-15)


@pytest.mark.unit
def test_rotor_angle_rel_trip_removes_weight() -> None:
    angles = np.array([[0.0, 0.0, 0.5], [0.0, 0.0, 0.5]])
    weights = np.array([1.0, 1.0, 100.0])
    in_service = np.array([[True, True, True], [True, True, False]])
    result = rotor_angle_rel(angles, weights, in_service)
    # Row 0 mean by hand: 100*0.5 / 102 = 0.49019607843137253.
    mean0 = 100.0 * 0.5 / 102.0
    np.testing.assert_allclose(
        result[0], [0.0 - mean0, 0.0 - mean0, 0.5 - mean0], rtol=0.0, atol=1e-15
    )
    # Row 1: machine 2 tripped, so the mean is over machines 0 and 1 alone and
    # is 0.0. A wrong implementation that keeps the tripped machine's weight
    # fails this row. The tripped machine's own value keeps being computed:
    # 0.5 - 0.0 = 0.5.
    np.testing.assert_allclose(result[1], [0.0, 0.0, 0.5], rtol=0.0, atol=1e-15)


@pytest.mark.unit
def test_rotor_angle_rel_not_wrapped() -> None:
    # Machine 0 alone sets the mean (machine 1 weighs nothing): mean = 3.12.
    # Machine 1's raw difference is -3.13 - 3.12 = -6.25; a wrong
    # implementation that wraps would answer -6.25 + 2*pi = 0.033185307179586.
    result = rotor_angle_rel(
        np.array([[3.12, -3.13]]),
        np.array([1.0, 0.0]),
        np.array([[True, True]]),
    )
    assert result[0, 0] == pytest.approx(0.0, abs=1e-15)
    assert result[0, 1] == pytest.approx(-6.25, abs=1e-12)


@pytest.mark.unit
def test_rotor_angle_rel_none_in_service() -> None:
    with np.errstate(all="raise"):
        result = rotor_angle_rel(
            np.array([[0.3, -0.2]]),
            np.array([1.0, 1.0]),
            np.array([[False, False]]),
        )
    assert np.isnan(result).all()


@pytest.mark.unit
def test_rotor_angle_rel_zero_weight_row() -> None:
    # Every in-service machine weighs zero: the mean is a 0/0 and the row is
    # NaN, quietly.
    with np.errstate(all="raise"):
        result = rotor_angle_rel(
            np.array([[0.3, -0.2]]),
            np.array([0.0, 0.0]),
            np.array([[True, True]]),
        )
    assert np.isnan(result).all()


@pytest.mark.unit
def test_rotor_angle_rel_out_of_service_machine_still_valued() -> None:
    # Machine 1 is out of service: the mean is machine 0's angle, 0.4, and
    # machine 1's result is its own angle minus that mean, not NaN.
    result = rotor_angle_rel(
        np.array([[0.4, 1.3]]),
        np.array([2.0, 5.0]),
        np.array([[True, False]]),
    )
    assert result[0, 0] == pytest.approx(0.0, abs=1e-15)
    assert result[0, 1] == pytest.approx(0.9, abs=1e-15)


@pytest.mark.unit
def test_rotor_angle_rel_not_2d() -> None:
    with pytest.raises(ValueError, match=r"2-D.*\(2,\)"):
        rotor_angle_rel(
            np.zeros(2), np.zeros(2), np.ones((1, 2), dtype=np.bool_)
        )


@pytest.mark.unit
def test_rotor_angle_rel_shape_errors() -> None:
    angles = np.zeros((2, 3))
    in_service = np.ones((2, 3), dtype=np.bool_)
    with pytest.raises(ValueError, match=r"weights.*\(2,\).*3 machines"):
        rotor_angle_rel(angles, np.zeros(2), in_service)
    with pytest.raises(ValueError, match=r"in_service.*\(2, 2\).*\(2, 3\)"):
        rotor_angle_rel(angles, np.zeros(3), np.ones((2, 2), dtype=np.bool_))
    with pytest.raises(ValueError, match=r"in_service must be a bool array; got dtype int64"):
        rotor_angle_rel(angles, np.zeros(3), np.ones((2, 3), dtype=np.int64))


@pytest.mark.unit
def test_inputs_not_modified() -> None:
    bus_angles = np.array([[0.5, 1.0, -0.5], [0.6, 1.1, -0.4]])
    bus_angles_copy = bus_angles.copy()
    angle_rel(bus_angles, 1)
    np.testing.assert_array_equal(bus_angles, bus_angles_copy)

    angles = np.array([[0.0, 1.0], [0.2, 0.8]])
    weights = np.array([3.0, 1.0])
    in_service = np.array([[True, True], [True, False]])
    angles_copy = angles.copy()
    weights_copy = weights.copy()
    in_service_copy = in_service.copy()
    rotor_angle_rel(angles, weights, in_service)
    np.testing.assert_array_equal(angles, angles_copy)
    np.testing.assert_array_equal(weights, weights_copy)
    np.testing.assert_array_equal(in_service, in_service_copy)

    wrapped_input = np.array([1.0, 7.0])
    wrapped_input_copy = wrapped_input.copy()
    wrap_angle(wrapped_input)
    np.testing.assert_array_equal(wrapped_input, wrapped_input_copy)


@pytest.mark.unit
def test_rotor_angle_rel_nan_angle_out_of_service() -> None:
    # Machine 2 is out of service and has no angle (NaN): the mean is that
    # of machines 0 and 1 alone, (2 * 0.1 + 2 * 0.3) / 4 = 0.2, and only
    # machine 2's own column is NaN.
    with np.errstate(all="raise"):
        result = rotor_angle_rel(
            np.array([[0.1, 0.3, np.nan]]),
            np.array([2.0, 2.0, 5.0]),
            np.array([[True, True, False]]),
        )
    assert result[0, 0] == pytest.approx(-0.1, abs=1e-15)
    assert result[0, 1] == pytest.approx(0.1, abs=1e-15)
    assert np.isnan(result[0, 2])


@pytest.mark.unit
def test_rotor_angle_rel_nan_angle_of_zero_weight() -> None:
    # A machine in service that weighs nothing leaves the mean alone, NaN or not.
    result = rotor_angle_rel(
        np.array([[0.4, np.nan]]),
        np.array([2.0, 0.0]),
        np.array([[True, True]]),
    )
    assert result[0, 0] == pytest.approx(0.0, abs=1e-15)
    assert np.isnan(result[0, 1])


@pytest.mark.unit
def test_rotor_angle_rel_nan_angle_in_service_poisons_the_row() -> None:
    result = rotor_angle_rel(
        np.array([[0.4, np.nan]]),
        np.array([2.0, 1.0]),
        np.array([[True, True]]),
    )
    assert np.isnan(result).all()


@pytest.mark.unit
def test_unwrap_angle_across_pi() -> None:
    # A bus whose angle passes pi, reported wrapped into (-pi, pi] as
    # atan(Vi, Vr) gives it, against a reference that stays just below pi:
    # the relative angle of the wrapped series jumps by 2 pi; of the
    # unwrapped one it moves smoothly.
    true_bus = np.array([3.10, 3.13, 3.16, 3.19, 3.22])
    reference = np.full(5, 3.12)
    wrapped = np.column_stack([np.arctan2(np.sin(true_bus), np.cos(true_bus)), reference])
    jumpy = angle_rel(wrapped, 1)[:, 0]
    assert np.max(np.abs(np.diff(jumpy))) > 6.0
    smooth = angle_rel(unwrap_angle(wrapped), 1)[:, 0]
    np.testing.assert_allclose(smooth, true_bus - reference, atol=1e-12)


@pytest.mark.unit
def test_unwrap_angle_keeps_gaps() -> None:
    # A NaN is a gap: it stays, and the values after it are unwrapped against
    # the last finite one before it, not turned into NaN.
    series = np.array([3.1, np.nan, 3.2 - 2 * np.pi, 3.25 - 2 * np.pi])
    out = unwrap_angle(series)
    assert np.isnan(out[1])
    np.testing.assert_allclose(out[[0, 2, 3]], [3.1, 3.2, 3.25], atol=1e-12)
    np.testing.assert_array_equal(np.isnan(series), np.isnan(out))  # input kept
    assert series[2] < 0


@pytest.mark.unit
def test_unwrap_angle_leaves_a_continuous_series() -> None:
    series = np.array([[0.0, -0.5], [0.4, -0.7], [0.9, -1.1]])
    np.testing.assert_array_equal(unwrap_angle(series), series)
    with pytest.raises(ValueError, match="1-D or 2-D"):
        unwrap_angle(np.zeros((2, 2, 2)))
