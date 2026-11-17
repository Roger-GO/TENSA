"""Which branches of a case the topology lists as transformers.

ANDES keeps a 2-winding transformer in its ``Line`` model, so the substrate tells it from a
line. A transformer at its nominal ratio has neither a tap nor a phase shift: the step-up units
of the WSCC 9-bus and Kundur cases are only told apart by ANDES's ``trans`` flag or by the two
rated voltages they join, and a diagram that took them for lines drew no transformer symbol.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from tensa.core.example_catalog import bundled_cases_dir
from tensa.core.wrapper import TopologyEntry, Wrapper
from tensa.core.wrapper.topology import _marked_as_transformers
from tensa.core.wrapper.topology import _split_lines_transformers as split

pytestmark = pytest.mark.unit


def _param(values: list[Any]) -> Any:
    return SimpleNamespace(v=values)


def _system(**columns: list[Any]) -> Any:
    return SimpleNamespace(Line=SimpleNamespace(**{k: _param(v) for k, v in columns.items()}))


def _line(idx: str, **params: float) -> TopologyEntry:
    return TopologyEntry(idx=idx, name=idx, kind="Line", params=dict(params))


def test_a_tap_a_phase_shift_or_a_mark_makes_a_branch_a_transformer() -> None:
    entries = [
        _line("plain", tap=1.0, phi=0.0),
        _line("tapped", tap=1.05, phi=0.0),
        _line("shifter", tap=1.0, phi=0.1),
        _line("marked", tap=1.0, phi=0.0),
        _line("unreadable"),
    ]
    lines, transformers = split(entries, frozenset({"marked"}))
    assert [e.idx for e in lines] == ["plain", "unreadable"]
    assert [e.idx for e in transformers] == ["tapped", "shifter", "marked"]


def test_nothing_is_marked_unless_the_caller_says_so() -> None:
    lines, transformers = split([_line("a", tap=1.0, phi=0.0)])
    assert [e.idx for e in lines] == ["a"] and transformers == []


def test_the_trans_flag_marks_a_branch_whatever_its_voltages() -> None:
    system = _system(
        idx=["a", "b", "c"], trans=[1.0, 0.0, 1], Vn1=[230.0, 230.0, 110.0], Vn2=[230.0] * 3
    )
    assert _marked_as_transformers(system) == {"a", "c"}


def test_two_rated_voltages_that_differ_mark_a_branch_with_no_flag() -> None:
    system = _system(
        idx=[0, 1, 2], trans=[0.0] * 3, Vn1=[16.5, 230.0, 230.0], Vn2=[230.0, 230.0, 345.0]
    )
    assert _marked_as_transformers(system) == {0, 2}


def test_a_voltage_that_a_case_rounds_differently_at_the_two_ends_is_one_level() -> None:
    system = _system(idx=["a", "b"], trans=[0.0, 0.0], Vn1=[230.0, 20.7], Vn2=[230.01, 20.9])
    assert _marked_as_transformers(system) == {"b"}


@pytest.mark.parametrize(
    "columns",
    [
        {"idx": ["a"]},
        {"idx": ["a"], "trans": [None], "Vn1": [float("nan")], "Vn2": [230.0]},
        {"idx": ["a"], "trans": ["x"], "Vn1": [0.0], "Vn2": [230.0]},
        {"idx": ["a"], "trans": [], "Vn1": [], "Vn2": []},
    ],
)
def test_a_branch_whose_marks_cannot_be_read_stays_a_line(columns: dict[str, list[Any]]) -> None:
    assert _marked_as_transformers(_system(**columns)) == frozenset()


def test_a_system_with_no_line_model_marks_nothing() -> None:
    assert _marked_as_transformers(SimpleNamespace()) == frozenset()


def _idx_by_bucket(path: Any) -> tuple[set[str], set[str]]:
    wrapper = Wrapper()
    topology = wrapper.load_case(path)
    return (
        {str(e.idx) for e in topology.lines},
        {str(e.idx) for e in topology.transformers},
    )


def test_the_step_up_units_of_the_bundled_wscc9_are_transformers() -> None:
    pytest.importorskip("andes")
    lines, transformers = _idx_by_bucket(bundled_cases_dir() / "wscc9.xlsx")
    assert transformers == {"Line_6", "Line_7", "Line_8"}
    assert lines == {f"Line_{n}" for n in range(6)}


def test_the_step_up_units_of_kundur_are_transformers_and_ieee14_keeps_its_four() -> None:
    andes = pytest.importorskip("andes")
    for case, expected in (
        ("kundur/kundur_full.xlsx", {f"Line_{n}" for n in range(11, 15)}),
        ("ieee14/ieee14_full.xlsx", {f"Line_{n}" for n in range(17, 21)}),
    ):
        path = andes.get_case(case)
        lines, transformers = _idx_by_bucket(path)
        assert transformers == expected, case
        assert not lines & expected, case
