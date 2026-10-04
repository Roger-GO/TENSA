"""Unit tests for the system frequency the topology snapshot reports.

``TopologySnapshot.freq_hz`` is what a client converts a per-unit rotor speed
to Hz with, so it must be the case's own value or nothing at all: a missing or
unusable ``ss.config.freq`` reports ``None`` rather than a guess.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tensa.core.wrapper import _system_frequency_hz


def _system(**config: Any) -> Any:
    return SimpleNamespace(config=SimpleNamespace(**config))


@pytest.mark.unit
@pytest.mark.parametrize(
    ("configured", "expected"),
    [(60, 60.0), (50.0, 50.0), ("50", 50.0), (59.94, 59.94)],
)
def test_reports_the_configured_frequency(configured: Any, expected: float) -> None:
    assert _system_frequency_hz(_system(freq=configured)) == expected


@pytest.mark.unit
@pytest.mark.parametrize(
    "configured",
    [None, "", "fifty", 0, -50.0, float("nan"), float("inf"), [50]],
)
def test_reports_none_for_an_unusable_frequency(configured: Any) -> None:
    assert _system_frequency_hz(_system(freq=configured)) is None


@pytest.mark.unit
def test_reports_none_when_the_configuration_has_no_frequency() -> None:
    assert _system_frequency_hz(_system()) is None
