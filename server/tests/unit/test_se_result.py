"""Unit tests for the SE result dataclasses (Unit 13)."""

from __future__ import annotations

import dataclasses

import pytest

from andes_app.core.se_result import MeasurementsGenerated, SeResult


def test_measurements_generated_construction_holds_count() -> None:
    """The simple ``{count}`` payload is what the route returns from
    the generate endpoint."""
    payload = MeasurementsGenerated(count=42)
    assert payload.count == 42


def test_measurements_generated_dataclass_is_frozen() -> None:
    """Frozen so the wire payload cannot mutate after construction
    (matches CpfResult / EigResult convention)."""
    payload = MeasurementsGenerated(count=42)
    with pytest.raises(dataclasses.FrozenInstanceError):
        payload.count = 99  # type: ignore[misc]


def test_se_result_construction_holds_field_values() -> None:
    """Empty-result shape (zero residuals; would only happen on a
    pathological 0-bus case)."""
    result = SeResult(
        converged=True,
        iterations=2,
        mismatch=0.0,
        residuals=[],
        measurement_count=0,
        flagged_indices=[],
    )
    assert result.converged is True
    assert result.iterations == 2
    assert result.mismatch == 0.0
    assert result.residuals == []
    assert result.measurement_count == 0
    assert result.flagged_indices == []


def test_se_result_with_realistic_payload() -> None:
    """Realistic IEEE 14 payload shape: 43 measurements (14 V + 28 P/Q
    + 1 angle reference); a couple of flagged indices."""
    residuals = [0.001 * i for i in range(43)]
    result = SeResult(
        converged=True,
        iterations=3,
        mismatch=12.3456,
        residuals=residuals,
        measurement_count=43,
        flagged_indices=[5, 17],
    )
    assert result.iterations == 3
    assert result.mismatch == pytest.approx(12.3456)
    assert len(result.residuals) == 43
    assert result.measurement_count == 43
    assert result.flagged_indices == [5, 17]


def test_se_result_dataclass_is_frozen() -> None:
    """Frozen — wire payload cannot mutate post-construction."""
    result = SeResult(
        converged=True,
        iterations=1,
        mismatch=0.0,
        residuals=[],
        measurement_count=0,
        flagged_indices=[],
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.iterations = 5  # type: ignore[misc]


def test_se_result_flagged_indices_index_into_residuals() -> None:
    """Flagged indices must be valid indices into the residuals array.
    The dataclass doesn't enforce this (no runtime validators) but the
    test pins the convention so consumers can rely on it."""
    residuals = [0.01, 0.02, 0.5, 0.03, 0.04]
    flagged = [2]  # the 0.5 residual exceeds 3-sigma at sigma=0.01
    result = SeResult(
        converged=True,
        iterations=2,
        mismatch=0.0001,
        residuals=residuals,
        measurement_count=5,
        flagged_indices=flagged,
    )
    for idx in result.flagged_indices:
        assert 0 <= idx < len(result.residuals), idx


def test_se_result_iterations_can_be_zero() -> None:
    """A successful run with ``iterations=0`` is theoretically possible
    if the initial guess is already at the solution. The dataclass
    accepts it; surfaces the value for the UI's iteration counter."""
    result = SeResult(
        converged=True,
        iterations=0,
        mismatch=0.0,
        residuals=[0.0],
        measurement_count=1,
        flagged_indices=[],
    )
    assert result.iterations == 0
    assert result.converged is True


def test_se_result_residual_count_matches_measurement_count() -> None:
    """Tests document the contract: ``len(residuals) ==
    measurement_count``. The wrapper enforces this on real payloads;
    consumers (UI histogram) rely on it."""
    n = 14
    result = SeResult(
        converged=True,
        iterations=2,
        mismatch=1.0,
        residuals=[0.0] * n,
        measurement_count=n,
        flagged_indices=[],
    )
    assert len(result.residuals) == result.measurement_count
