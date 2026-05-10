"""Unit tests for the EIG result dataclasses (Unit 6)."""

from __future__ import annotations

import dataclasses
import math

import pytest

from andes_app.core.eig_result import ComplexNumber, EigResult


def test_complex_number_from_complex_round_trips() -> None:
    z = complex(1.5, -2.25)
    cn = ComplexNumber.from_complex(z)
    assert cn.real == pytest.approx(1.5)
    assert cn.imag == pytest.approx(-2.25)


def test_complex_number_from_complex_purely_real() -> None:
    cn = ComplexNumber.from_complex(complex(7.0))
    assert cn.real == pytest.approx(7.0)
    assert cn.imag == pytest.approx(0.0)


def test_complex_number_from_complex_purely_imaginary() -> None:
    cn = ComplexNumber.from_complex(complex(0.0, 3.0))
    assert cn.real == pytest.approx(0.0)
    assert cn.imag == pytest.approx(3.0)


def test_eig_result_construction_holds_field_values() -> None:
    """Empty-result shape (stock IEEE 14 case scenario)."""
    result = EigResult(
        eigenvalues=[],
        damping_ratios=[],
        frequencies_hz=[],
        mode_count=0,
        state_count=0,
        state_names=[],
        tds_initialized=True,
    )
    assert result.mode_count == 0
    assert result.state_count == 0
    assert result.eigenvalues == []
    assert result.tds_initialized is True


def test_eig_result_with_nonempty_modes() -> None:
    eigs = [
        ComplexNumber(real=-0.1, imag=2.0),
        ComplexNumber(real=-0.05, imag=-2.0),
    ]
    result = EigResult(
        eigenvalues=eigs,
        damping_ratios=[0.05, 0.025],
        frequencies_hz=[0.318, 0.318],
        mode_count=2,
        state_count=2,
        state_names=["delta_1", "omega_1"],
        tds_initialized=True,
    )
    assert result.mode_count == 2
    assert len(result.eigenvalues) == 2
    assert result.state_names == ["delta_1", "omega_1"]


def test_eig_result_dataclass_is_frozen() -> None:
    """The dataclass is frozen so the wire payload cannot be mutated
    after construction (mirrors PflowResult / ReportPayload pattern)."""
    result = EigResult(
        eigenvalues=[],
        damping_ratios=[],
        frequencies_hz=[],
        mode_count=0,
        state_count=0,
        state_names=[],
        tds_initialized=False,
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.mode_count = 5  # type: ignore[misc]


def test_complex_number_field_finite_values() -> None:
    cn = ComplexNumber.from_complex(complex(0.0, 0.0))
    assert math.isfinite(cn.real)
    assert math.isfinite(cn.imag)
