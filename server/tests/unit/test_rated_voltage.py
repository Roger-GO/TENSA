"""Unit tests for telling which buses a case gives a rated voltage for.

``Vn`` reaches a client as a bus's voltage base only when the case set it, and
ANDES fills in 110 kV when it did not, so ``buses_without_rated_voltage`` names
the buses with the fill-in. These tests drive it with stand-ins for the System;
``tests/integration/test_rated_voltage.py`` loads real cases of each format.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pandas as pd
import pytest

from tensa.core.rated_voltage import (
    _not_given,
    buses_without_rated_voltage,
    still_without_rated_voltage,
)

pytestmark = pytest.mark.unit

_CASE = Path("case.xlsx")


def _system(idx: list[Any], input_format: str | None, **extra: Any) -> Any:
    bus = SimpleNamespace(idx=SimpleNamespace(v=idx), **extra.pop("bus", {}))
    return SimpleNamespace(
        Bus=bus, files=SimpleNamespace(input_format=input_format), **extra
    )


@pytest.mark.parametrize("value", [None, float("nan"), 0, 0.0, "0", "0.0"])
def test_a_missing_blank_or_zero_vn_is_not_given(value: Any) -> None:
    assert _not_given(value) is True


@pytest.mark.parametrize("value", [110, 13.8, "230", -1.0, "kV"])
def test_any_other_vn_is_given(value: Any) -> None:
    assert _not_given(value) is False


def test_a_system_without_buses_has_none_without_a_rating() -> None:
    ss = _system([], "xlsx")
    assert buses_without_rated_voltage(ss, _CASE) == frozenset()
    assert buses_without_rated_voltage(SimpleNamespace(), _CASE) == frozenset()


def test_reads_the_rows_of_an_xlsx_bus_sheet() -> None:
    frame = pd.DataFrame({"idx": [1, 2, 3, 4], "Vn": [230.0, None, 0, 13.8]})
    ss = _system([1, 2, 3, 4], "xlsx", df_in={"Bus": frame})
    assert buses_without_rated_voltage(ss, _CASE) == frozenset({2, 3})


def test_an_xlsx_bus_sheet_without_a_vn_column_gives_no_bus_a_rating() -> None:
    ss = _system([1, 2], "xlsx", df_in={"Bus": pd.DataFrame({"idx": [1, 2]})})
    assert buses_without_rated_voltage(ss, _CASE) == frozenset({1, 2})


def test_reads_the_corrections_andes_noted_for_a_raw_file() -> None:
    bus = {"_param_corrections": {("Vn", "non_zero"): [2], ("v0", "non_zero"): [1]}}
    ss = _system([1, 2, 3], "psse", bus=bus)
    assert buses_without_rated_voltage(ss, _CASE) == frozenset({2})


def test_a_raw_file_with_no_corrections_has_no_bus_without_a_rating() -> None:
    ss = _system([1, 2], "psse", bus={"_param_corrections": {}})
    assert buses_without_rated_voltage(ss, _CASE) == frozenset()


@pytest.mark.parametrize(
    "ss",
    [
        pytest.param(_system([1, 2], "cdf"), id="a format it cannot read back"),
        pytest.param(_system([1, 2], None), id="no format recorded"),
        pytest.param(_system([1, 2], "xlsx"), id="xlsx rows gone from the System"),
        pytest.param(
            _system([1, 2], "xlsx", df_in={"Bus": pd.DataFrame({"Vn": [230.0]})}),
            id="rows that are not the System's buses",
        ),
    ],
)
def test_names_every_bus_when_the_answer_cannot_be_worked_out(ss: Any) -> None:
    # No bus is then taken as having a base: the client keeps the voltages per unit.
    assert buses_without_rated_voltage(ss, _CASE) == frozenset({1, 2})


def test_a_json_file_that_no_longer_parses_names_every_bus(tmp_path: Path) -> None:
    case = tmp_path / "case.json"
    case.write_text("{not json", encoding="utf-8")
    ss = _system([1, 2], "json")
    assert buses_without_rated_voltage(ss, case) == frozenset({1, 2})


def _vn(values: list[float]) -> dict[str, Any]:
    return {"Vn": SimpleNamespace(default=110, v=values)}


def test_a_bus_edited_since_the_load_is_no_longer_without_a_rating() -> None:
    ss = _system([1, 2, 3], "xlsx", bus=_vn([110, 230.0, 110]))
    assert still_without_rated_voltage(ss, frozenset({1, 2, 3})) == [1, 3]


def test_a_bus_the_case_rated_is_never_listed() -> None:
    ss = _system([1, 2, 3], "xlsx", bus=_vn([110, 110, 110]))
    assert still_without_rated_voltage(ss, frozenset({2})) == [2]


def test_nothing_recorded_lists_nothing() -> None:
    ss = _system([1, 2], "xlsx", bus=_vn([110, 110]))
    assert still_without_rated_voltage(ss, frozenset()) == []
    assert still_without_rated_voltage(SimpleNamespace(), frozenset({1})) == []
