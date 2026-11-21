"""Unit tests for ``tensa.core.matpower_writer.write_matpower``.

Each test writes a System as a MATPOWER v2 ``.m`` file and reads it back
through ANDES's own parser (``m2mpc``) and loader, and the power flow of the
file read back is held to the power flow of the System it was written from.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import andes
import numpy as np
import pytest
from andes.io.matpower import m2mpc

from tensa.core.matpower_writer import write_matpower


@pytest.fixture(autouse=True)
def _quiet_andes() -> Any:
    logging.getLogger("andes").setLevel(logging.ERROR)
    yield


def _stock(case: str) -> andes.system.System:
    return andes.load(
        andes.get_case(case), setup=False, no_output=True, default_config=True
    )


def _read_back(path: Path) -> andes.system.System:
    return andes.load(str(path), no_output=True, default_config=True)


def _solved(ss: andes.system.System) -> tuple[np.ndarray, np.ndarray]:
    """Bus voltage magnitudes and angles after a power flow, in uid order."""
    if not ss.is_setup:
        ss.setup()
    ss.PFlow.run()
    assert ss.PFlow.converged
    return np.array(ss.Bus.v.v, dtype=float), np.array(ss.Bus.a.v, dtype=float)


def _two_bus(a: Any = 1, b: Any = 2, line_sn: float = 100.0) -> andes.system.System:
    """A slack, a load and a line between two buses with the idx given."""
    ss = andes.System(no_output=True, default_config=True)
    ss.add("Bus", idx=a, name="Alpha", Vn=110.0)
    ss.add("Bus", idx=b, name="Beta", Vn=110.0)
    ss.add("Slack", idx="G1", bus=a, Vn=110.0, v0=1.02, p0=0.5)
    ss.add("PQ", idx="L1", bus=b, Vn=110.0, p0=0.5, q0=0.1)
    ss.add(
        "Line",
        idx="Ln1",
        bus1=a,
        bus2=b,
        Vn1=110.0,
        Vn2=110.0,
        Sn=line_sn,
        r=0.01,
        x=0.1,
        b=0.02,
    )
    return ss


@pytest.mark.unit
def test_written_file_parses_with_m2mpc_and_matches_the_system(tmp_path: Path) -> None:
    ss = _stock("kundur/kundur_full.xlsx")
    target = tmp_path / "kundur-out.m"
    write_matpower(ss, target)

    text = target.read_text(encoding="utf-8")
    first = next(line.strip() for line in text.splitlines() if line.strip())
    assert first == "function mpc = kundur_out"

    mpc = m2mpc(str(target))
    assert mpc["baseMVA"] == pytest.approx(ss.config.mva)
    assert len(mpc["bus"]) == ss.Bus.n
    assert len(mpc["gen"]) == ss.PV.n + ss.Slack.n
    assert len(mpc["branch"]) == ss.Line.n
    assert list(mpc["bus"][:, 0].astype(int)) == list(ss.Bus.idx.v)
    assert list(mpc["bus_name"]) == [str(name) for name in ss.Bus.name.v]

    # Slack rows come first in the gen section.
    slack_buses = {int(row[0]) for row in mpc["bus"] if int(row[1]) == 3}
    assert {int(bus) for bus in ss.Slack.bus.v} == slack_buses
    assert int(mpc["gen"][0][0]) in slack_buses

    # A PQ load's MW appears in bus column 3 (index 2) scaled by baseMVA.
    for bus, p0, q0 in zip(ss.PQ.bus.v, ss.PQ.p0.v, ss.PQ.q0.v, strict=True):
        row = next(row for row in mpc["bus"] if int(row[0]) == int(bus))
        assert row[2] == pytest.approx(p0 * ss.config.mva)
        assert row[3] == pytest.approx(q0 * ss.config.mva)


@pytest.mark.unit
@pytest.mark.parametrize(
    "case",
    ["kundur/kundur_full.xlsx", "ieee14/ieee14_full.xlsx", "ieee39/ieee39_full.xlsx"],
)
@pytest.mark.parametrize("set_up", [False, True], ids=["pre-setup", "set-up"])
def test_the_file_read_back_has_the_same_network_and_power_flow(
    tmp_path: Path, case: str, set_up: bool
) -> None:
    """The case read back from the file has the same buses, branches,
    generators and loads, and its power flow lands on the same voltages."""
    ss = _stock(case)
    if set_up:
        ss.setup()
    target = tmp_path / "roundtrip.m"
    write_matpower(ss, target)
    back = _read_back(target)

    assert list(back.Bus.idx.v) == list(ss.Bus.idx.v)
    assert back.Line.n == ss.Line.n
    assert back.PV.n == ss.PV.n
    assert back.Slack.n == ss.Slack.n
    assert back.PQ.n == ss.PQ.n
    assert sum(back.PQ.p0.v) == pytest.approx(sum(ss.PQ.p0.v))
    assert sum(back.PQ.q0.v) == pytest.approx(sum(ss.PQ.q0.v))
    total_gen = sum(ss.PV.p0.v) + sum(ss.Slack.p0.v)
    assert sum(back.PV.p0.v) + sum(back.Slack.p0.v) == pytest.approx(total_gen)

    v0, a0 = _solved(ss)
    v1, a1 = _solved(back)
    np.testing.assert_allclose(v1, v0, atol=1e-6)
    np.testing.assert_allclose(a1, a0, atol=1e-6)


@pytest.mark.unit
def test_writing_leaves_the_system_as_it_was(tmp_path: Path) -> None:
    """The writer reads the System and changes nothing: a pre-setup System
    still takes an element afterwards and sets up as before."""
    ss = _stock("ieee14/ieee14_full.xlsx")
    before = {
        (model, name): list(param.v)
        for model in ("Bus", "PQ", "Line", "PV", "Slack")
        for name, param in getattr(ss, model).params.items()
    }
    kinds = {key: type(getattr(getattr(ss, key[0]), key[1]).v) for key in before}

    write_matpower(ss, tmp_path / "x.m")

    for (model, name), values in before.items():
        param = getattr(getattr(ss, model), name)
        assert type(param.v) is kinds[(model, name)], (model, name)
        assert list(param.v) == values, (model, name)
    ss.add("PQ", idx="extra", bus=4, Vn=ss.Bus.Vn.v[3], p0=0.1, q0=0.0)
    assert ss.setup()
    assert ss.PQ.n == 12


@pytest.mark.unit
def test_values_are_written_on_the_system_base_before_setup(tmp_path: Path) -> None:
    """Before setup ANDES holds an impedance on the device's own base; the
    file holds it on the system base, as ``System.calc_pu_coeff`` would."""
    ss = _two_bus(line_sn=200.0)
    ss.add("Shunt", idx="Sh1", bus=2, Vn=110.0, Sn=50.0, b=0.3)
    target = tmp_path / "bases.m"
    write_matpower(ss, target)

    mpc = m2mpc(str(target))
    branch = mpc["branch"][0]
    assert branch[2] == pytest.approx(0.01 * 100.0 / 200.0)
    assert branch[3] == pytest.approx(0.1 * 100.0 / 200.0)
    assert branch[4] == pytest.approx(0.02 * 200.0 / 100.0)
    # Bs is in MVAr at 1 pu: 0.3 pu on 50 MVA.
    assert mpc["bus"][1][5] == pytest.approx(0.3 * 50.0)

    v0, a0 = _solved(ss)
    v1, a1 = _solved(_read_back(target))
    np.testing.assert_allclose(v1, v0, atol=1e-8)
    np.testing.assert_allclose(a1, a0, atol=1e-8)


@pytest.mark.unit
@pytest.mark.parametrize(
    ("a", "b"), [("alpha", "beta"), (7, "beta"), (0, 3)], ids=["text", "mixed", "zero"]
)
def test_bus_idxes_that_are_no_bus_numbers_are_numbered_afresh(
    tmp_path: Path, a: Any, b: Any
) -> None:
    """A bus idx that is not a positive integer cannot be a MATPOWER bus
    number: the buses are numbered ``uid + 1``, every reference follows, the
    names are kept, and the power flow of the file read back matches."""
    ss = _two_bus(a=a, b=b)
    target = tmp_path / "strings.m"
    notes = write_matpower(ss, target)

    mpc = m2mpc(str(target))
    assert [int(row[0]) for row in mpc["bus"]] == [1, 2]
    assert [int(row[1]) for row in mpc["bus"]] == [3, 1]
    assert int(mpc["gen"][0][0]) == 1
    assert [int(v) for v in mpc["branch"][0][:2]] == [1, 2]
    assert mpc["bus"][1][2] == pytest.approx(50.0)
    assert list(mpc["bus_name"]) == ["Alpha", "Beta"]
    assert any("numbered 1 to n" in note for note in notes)

    back = _read_back(target)
    assert list(back.Bus.name.v) == ["Alpha", "Beta"]
    v0, a0 = _solved(ss)
    v1, a1 = _solved(back)
    np.testing.assert_allclose(v1, v0, atol=1e-8)
    np.testing.assert_allclose(a1, a0, atol=1e-8)


@pytest.mark.unit
def test_integer_bus_idxes_are_kept_and_nothing_is_said_of_them(tmp_path: Path) -> None:
    ss = _two_bus(a=10, b=20)
    notes = write_matpower(ss, tmp_path / "ints.m")
    mpc = m2mpc(str(tmp_path / "ints.m"))
    assert [int(row[0]) for row in mpc["bus"]] == [10, 20]
    assert notes == []


@pytest.mark.unit
def test_the_loads_and_shunts_of_a_bus_are_added_up_and_those_out_of_service_left_out(
    tmp_path: Path,
) -> None:
    """A MATPOWER bus has one load and one shunt. ``system2mpc`` writes the
    last device of a bus only and ignores ``u``; the writer adds up the
    devices in service and leaves the others out."""
    ss = _two_bus()
    ss.add("PQ", idx="L2", bus=2, Vn=110.0, p0=0.2, q0=0.05)
    ss.add("PQ", idx="L3", bus=2, Vn=110.0, p0=9.0, q0=9.0, u=0)
    ss.add("Shunt", idx="S1", bus=2, Vn=110.0, b=0.1)
    ss.add("Shunt", idx="S2", bus=2, Vn=110.0, b=0.05)
    target = tmp_path / "merged.m"
    notes = write_matpower(ss, target)

    row = m2mpc(str(target))["bus"][1]
    assert row[2] == pytest.approx(70.0)
    assert row[3] == pytest.approx(15.0)
    assert row[5] == pytest.approx(15.0)
    assert any("added up" in note and "2" in note for note in notes)
    assert any("1 load or shunt" in note for note in notes)

    v0, a0 = _solved(ss)
    v1, a1 = _solved(_read_back(target))
    np.testing.assert_allclose(v1, v0, atol=1e-8)
    np.testing.assert_allclose(a1, a0, atol=1e-8)


@pytest.mark.unit
def test_a_bus_out_of_service_is_written_isolated(tmp_path: Path) -> None:
    ss = _two_bus()
    ss.add("Bus", idx=3, name="Off", Vn=110.0, u=0)
    target = tmp_path / "off.m"
    write_matpower(ss, target)
    assert [int(row[1]) for row in m2mpc(str(target))["bus"]] == [3, 1, 4]


@pytest.mark.unit
def test_bus_names_keep_their_count_through_characters_the_reader_cannot_carry(
    tmp_path: Path,
) -> None:
    """ANDES's reader splits a name line on ``;`` and ``=`` and ends the
    section at ``]``; such a name would shift every name after it, and a
    count that differs from the buses drops the names altogether."""
    ss = _two_bus()
    ss.Bus.name.v[0] = "A;B=C]'D"
    target = tmp_path / "names.m"
    write_matpower(ss, target)
    back = _read_back(target)
    assert list(back.Bus.name.v) == ["A_B_C__D", "Beta"]


@pytest.mark.unit
def test_the_notes_name_what_the_file_leaves_out(tmp_path: Path) -> None:
    ss = _stock("kundur/kundur_full.xlsx")
    notes = write_matpower(ss, tmp_path / "k.m")
    assert len(notes) == 1
    assert "GENROU (4)" in notes[0]
    assert "EXDC2 (4)" in notes[0]
    assert "xlsx or json" in notes[0]


@pytest.mark.unit
@pytest.mark.parametrize(
    ("stem", "name"),
    [("9bus", "case_9bus"), ("my case-1", "my_case_1"), ("ok_name", "ok_name")],
)
def test_the_function_name_is_a_matlab_identifier(tmp_path: Path, stem: str, name: str) -> None:
    target = tmp_path / f"{stem}.m"
    write_matpower(_two_bus(), target)
    assert target.read_text(encoding="utf-8").splitlines()[0] == f"function mpc = {name}"
