"""``Wrapper.save_case`` with ``format="m"``: the atomic write, the checks of
the written file, the notes on what it leaves out, and the refusal to save
over the open case while disturbances are pending, as for the other formats.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

import andes
import pytest
from andes.io.matpower import m2mpc

from tensa.core import matpower_writer
from tensa.core.disturbance import FaultSpec
from tensa.core.errors import CaseSaveError, ElementValidationError
from tensa.core.wrapper import Wrapper


def _loaded(tmp_path: Path, case: str = "ieee14/ieee14_full.xlsx") -> Wrapper:
    source = Path(andes.get_case(case))
    copy = tmp_path / source.name
    shutil.copyfile(source, copy)
    w = Wrapper()
    w.load_case(copy)
    return w


def _hidden(tmp_path: Path) -> list[str]:
    return [p.name for p in tmp_path.iterdir() if p.name.startswith(".")]


@pytest.mark.unit
def test_save_as_m_writes_a_matpower_case(tmp_path: Path) -> None:
    w = _loaded(tmp_path)
    target = tmp_path / "out.m"
    assert w.save_case("m", str(target)) == target

    text = target.read_text(encoding="utf-8")
    first = next(line.strip() for line in text.splitlines() if line.strip())
    assert first.startswith("function")
    for section in ("mpc.baseMVA", "mpc.bus =", "mpc.gen =", "mpc.branch ="):
        assert section in text
    assert len(m2mpc(str(target))["bus"]) == 14
    assert _hidden(tmp_path) == []


@pytest.mark.unit
def test_save_as_m_logs_what_the_file_leaves_out(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    w = _loaded(tmp_path)
    with caplog.at_level(logging.WARNING, logger="tensa.notice"):
        w.save_case("m", str(tmp_path / "out.m"))
    notices = [r.getMessage() for r in caplog.records if r.name == "tensa.notice"]
    assert len(notices) == 1
    assert notices[0].startswith("out.m: ")
    assert "GENROU (5)" in notices[0]


@pytest.mark.unit
@pytest.mark.parametrize(
    ("content", "reason"),
    [("", "empty file"), ("mpc.baseMVA = 100;\n", "'function'")],
    ids=["empty", "no-function-line"],
)
def test_a_bad_m_file_is_refused_and_leaves_the_target_as_it_was(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    content: str,
    reason: str,
) -> None:
    w = _loaded(tmp_path)
    target = tmp_path / "out.m"
    w.save_case("m", str(target))
    good = target.read_bytes()

    def bad_writer(system: Any, path: str) -> list[str]:
        Path(path).write_text(content, encoding="utf-8")
        return ["never said"]

    monkeypatch.setattr(matpower_writer, "write_matpower", bad_writer)
    with (
        caplog.at_level(logging.WARNING, logger="tensa.notice"),
        pytest.raises(CaseSaveError, match=reason),
    ):
        w.save_case("m", str(target))
    assert target.read_bytes() == good
    assert _hidden(tmp_path) == []
    assert "never said" not in caplog.text

    fresh = tmp_path / "fresh.m"
    with pytest.raises(CaseSaveError):
        w.save_case("m", str(fresh))
    assert not fresh.exists()


@pytest.mark.unit
def test_a_writer_error_becomes_a_case_save_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = _loaded(tmp_path)

    def broken(system: Any, path: str) -> list[str]:
        raise KeyError("no such bus")

    monkeypatch.setattr(matpower_writer, "write_matpower", broken)
    with pytest.raises(CaseSaveError):
        w.save_case("m", str(tmp_path / "out.m"))
    assert not (tmp_path / "out.m").exists()
    assert _hidden(tmp_path) == []


@pytest.mark.unit
def test_save_as_m_over_the_open_case_is_refused_while_disturbances_are_pending(
    tmp_path: Path,
) -> None:
    w = _loaded(tmp_path)
    case_m = tmp_path / "ieee14.m"
    w.save_case("m", str(case_m))

    w2 = Wrapper()
    w2.load_case(case_m)
    before = case_m.read_bytes()
    w2.add_disturbance(FaultSpec(bus_idx=4, tf=1.0, tc=1.1, xf=0.0001, rf=0.0))
    with pytest.raises(CaseSaveError, match="disturbances"):
        w2.save_case("m", str(case_m))
    assert case_m.read_bytes() == before

    # Under another name it is written: the fault is left out, and said so.
    w2.save_case("m", str(tmp_path / "elsewhere.m"))
    assert (tmp_path / "elsewhere.m").exists()


@pytest.mark.unit
def test_save_as_m_over_the_open_case_makes_it_the_new_base(tmp_path: Path) -> None:
    w = _loaded(tmp_path)
    case_m = tmp_path / "ieee14.m"
    w.save_case("m", str(case_m))
    w2 = Wrapper()
    w2.load_case(case_m)
    w2.add_element("PQ", {"bus": 4, "p0": 0.1, "q0": 0.0, "Vn": 138.0})
    assert w2._edit_log  # noqa: SLF001

    w2.save_case("m", str(case_m))
    assert w2._edit_log == []  # noqa: SLF001
    assert w2._redo_log == []  # noqa: SLF001
    row = next(r for r in m2mpc(str(case_m))["bus"] if int(r[0]) == 4)
    assert row[2] == pytest.approx(47.8 + 10.0)


@pytest.mark.unit
def test_an_unknown_format_is_still_refused(tmp_path: Path) -> None:
    w = _loaded(tmp_path)
    with pytest.raises(ElementValidationError, match="xlsx, json, raw, m"):
        w.save_case("matpower", str(tmp_path / "x.m"))  # type: ignore[arg-type]
    assert not (tmp_path / "x.m").exists()
