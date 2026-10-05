"""Unit tests for the system MVA base the topology snapshot reports.

``TopologySnapshot.base_mva`` is what a client turns a per-unit power on the
system base into megawatts with, and what a battery's rating is compared to, so
it must be the case's own value or nothing at all: a missing or unusable
``ss.config.mva`` reports ``None`` rather than a guess.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tensa.core.wrapper import _system_base_mva


def _system(**config: Any) -> Any:
    return SimpleNamespace(config=SimpleNamespace(**config))


@pytest.mark.unit
@pytest.mark.parametrize(
    ("configured", "expected"),
    [(100, 100.0), (1000.0, 1000.0), ("250", 250.0), (0.5, 0.5)],
)
def test_reports_the_configured_base(configured: Any, expected: float) -> None:
    assert _system_base_mva(_system(mva=configured)) == expected


@pytest.mark.unit
@pytest.mark.parametrize(
    "configured",
    [None, "", "hundred", 0, -100.0, float("nan"), float("inf"), [100]],
)
def test_reports_none_for_an_unusable_base(configured: Any) -> None:
    assert _system_base_mva(_system(mva=configured)) is None


@pytest.mark.unit
def test_reports_none_when_the_configuration_has_no_base() -> None:
    assert _system_base_mva(_system()) is None
