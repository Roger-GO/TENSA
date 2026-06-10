"""Unit tests for the CPF result dataclass (Unit 12)."""

from __future__ import annotations

import dataclasses

import pytest

from andes_app.core.cpf_result import CpfResult


def test_cpf_result_construction_holds_field_values() -> None:
    """Empty-result shape (truncated path with no nose found)."""
    result = CpfResult(
        lambdas=[],
        voltages_per_bus={},
        bus_idxes=[],
        nose_idx=-1,
        max_lam=0.0,
        truncated=True,
        done_msg="Reached max steps",
        mode="pv",
    )
    assert result.lambdas == []
    assert result.nose_idx == -1
    assert result.truncated is True
    assert result.mode == "pv"
    assert result.done_msg == "Reached max steps"


def test_cpf_result_with_pv_curve_payload() -> None:
    result = CpfResult(
        lambdas=[0.0, 0.5, 1.0, 1.5, 2.0, 1.8],
        voltages_per_bus={
            "1": [1.06, 1.04, 1.02, 1.0, 0.95, 0.90],
            "2": [1.045, 1.03, 1.01, 0.99, 0.94, 0.89],
        },
        bus_idxes=["1", "2"],
        nose_idx=4,
        max_lam=2.0,
        truncated=False,
        done_msg="Nose point at lambda=2.000000",
        mode="pv",
    )
    assert result.nose_idx == 4
    assert result.max_lam == pytest.approx(2.0)
    assert result.bus_idxes == ["1", "2"]
    assert len(result.voltages_per_bus["1"]) == len(result.lambdas)
    assert result.truncated is False


def test_cpf_result_with_qv_curve_payload() -> None:
    """QV-curve mode carries a single bus key + the same wire shape."""
    result = CpfResult(
        lambdas=[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 4.8],
        voltages_per_bus={"5": [1.0, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70]},
        bus_idxes=["5"],
        nose_idx=5,
        max_lam=5.0,
        truncated=False,
        done_msg="Nose point at q=5.000000",
        mode="qv",
    )
    assert result.mode == "qv"
    assert list(result.voltages_per_bus.keys()) == ["5"]
    assert result.bus_idxes == ["5"]
    assert result.nose_idx == 5


def test_cpf_result_dataclass_is_frozen() -> None:
    """The dataclass is frozen so the wire payload cannot be mutated
    after construction (mirrors EigResult / PflowResult pattern)."""
    result = CpfResult(
        lambdas=[],
        voltages_per_bus={},
        bus_idxes=[],
        nose_idx=-1,
        max_lam=0.0,
        truncated=True,
        done_msg="",
        mode="pv",
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        result.nose_idx = 5  # type: ignore[misc]


def test_cpf_result_truncated_flag_with_negative_nose() -> None:
    """Truncated runs always carry nose_idx=-1; the dataclass doesn't
    enforce the invariant but tests pin the convention so consumers can
    rely on it."""
    result = CpfResult(
        lambdas=[0.0, 0.1, 0.2],
        voltages_per_bus={"1": [1.0, 0.99, 0.98]},
        bus_idxes=["1"],
        nose_idx=-1,
        max_lam=0.2,
        truncated=True,
        done_msg="Reached max steps (3)",
        mode="pv",
    )
    assert result.truncated is True
    assert result.nose_idx == -1
    # max_lam is the ANDES echo, not derived from lambdas[argmax].
    assert result.max_lam == pytest.approx(0.2)


def test_cpf_result_voltages_per_bus_is_index_aligned_with_lambdas() -> None:
    """Defensive: each per-bus voltage list should have the same length
    as ``lambdas``. Tests document the contract; the build helper
    enforces it on real payloads."""
    n = 5
    lambdas = [0.0, 0.5, 1.0, 1.5, 2.0]
    voltages_per_bus = {f"bus_{i}": [1.0 - 0.05 * j for j in range(n)] for i in range(3)}
    result = CpfResult(
        lambdas=lambdas,
        voltages_per_bus=voltages_per_bus,
        bus_idxes=[f"bus_{i}" for i in range(3)],
        nose_idx=4,
        max_lam=2.0,
        truncated=False,
        done_msg="Nose point at lambda=2.0",
        mode="pv",
    )
    for bus_key, v in result.voltages_per_bus.items():
        assert len(v) == len(result.lambdas), bus_key


# ---- NaN sanitisation in the builder (unconverged CPF) ----------------------


def test_build_cpf_result_truncates_nan_tail() -> None:
    """An unconverged CPF ("Reached max steps") leaves NaN tails in lam/V.

    Those crashed JSON serialisation with HTTP 500. The builder must keep
    the finite prefix (a useful partial curve) and emit only finite floats.
    """
    import math
    from types import SimpleNamespace

    import numpy as np

    from andes_app.core.wrapper import _build_cpf_result

    nan = float("nan")
    ss = SimpleNamespace(
        CPF=SimpleNamespace(
            lam=[0.0, 0.5, 1.0, nan, nan],
            V=np.array(
                [
                    [1.0, 0.98, 0.95, nan, nan],
                    [1.0, 0.97, 0.93, nan, nan],
                ]
            ),
            done_msg="CPF failed. Reached max steps (500)",
            events=[],
            max_lam=nan,
        ),
        Bus=SimpleNamespace(idx=SimpleNamespace(v=[1, 2])),
    )

    result = _build_cpf_result(ss, mode="pv", ok=False)  # type: ignore[arg-type]

    assert result.lambdas == [0.0, 0.5, 1.0]
    assert result.truncated is True
    assert math.isfinite(result.max_lam)
    assert result.max_lam == 1.0
    for row in result.voltages_per_bus.values():
        assert len(row) == 3
        assert all(math.isfinite(x) for x in row)
