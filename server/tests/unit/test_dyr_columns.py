"""The .dyr columns ANDES reads in an order other than PSS/E's are put back.

ANDES 2.0.0 names the columns of an ``ESAC1A`` and an ``ESST1A`` record in an
order of its own (``tensa.core.dyr_columns``), so a case read from a PSS/E file
ran those exciters with other gains and time constants than the file's. The
load puts the file's values back and says so; a clone edit of a ``.dyr`` writes
the column PSS/E reads the parameter from.

The records below are the ESAC1A of PowerSimulationsDynamics's ESAC1A benchmark
and the ESST1A the model audit (``tests/integration/test_model_audits.py``)
writes, each on a machine of Kundur.
"""

from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path
from typing import Any

import pytest

from tensa.core.clone_writers import DyrLocator
from tensa.core.clone_writers.dyr_writer import apply_edit
from tensa.core.dyr_columns import PSSE_COLUMNS, andes_columns, read_dyr_records
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration  # reads cases into a real ANDES System

_ESAC1A = (
    "1 'ESAC1A' 1 0.01 0.1 0.0 200.0 0.05 7.0 -7.0 1.333 0.02 0.8\n"
    "   0.0 0.0 1.0 0.0 0.0 0.0 0.0 10.0 -10.0 /\n"
)
_ESST1A = (
    "2 'ESST1A' 1  1 1 0.01 5.0 -5.0 14.142135623731 20.0 "
    "14.142135623731 20.0 200.0 0.1 6.3 2.1 6.0 0.0 0.5 0.01 0.01 0.01 2.8 /\n"
)
# The values each record holds, by the ANDES parameter PSS/E's column sets.
_FILE_VALUES = {
    "ESAC1A": {
        "TR": 0.01, "TB": 0.1, "TC": 0.0, "KA": 200.0, "TA": 0.05, "VAMAX": 7.0,
        "VAMIN": -7.0, "TE": 1.333, "KF": 0.02, "TF": 0.8, "KC": 0.0, "KD": 0.0,
        "KE": 1.0, "E1": 0.0, "SE1": 0.0, "E2": 0.0, "SE2": 0.0, "VRMAX": 10.0,
        "VRMIN": -10.0,
    },
    "ESST1A": {
        "UELc": 1.0, "VOSc": 1.0, "TR": 0.01, "VIMAX": 5.0, "VIMIN": -5.0,
        "TC": 14.142135623731, "TB": 20.0, "TC1": 14.142135623731, "TB1": 20.0,
        "KA": 200.0, "TA": 0.1, "VAMAX": 6.3, "VAMIN": 2.1, "VRMAX": 6.0,
        "VRMIN": 0.0, "KC": 0.5, "KF": 0.01, "TF": 0.01, "KLR": 0.01, "ILR": 2.8,
    },
}


def _cases() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


def _genrou_records(text: str) -> str:
    records = [r.strip() for r in text.split("/") if r.strip()]
    kept = [r for r in records if re.split(r"[\s,]+", r)[1].strip("'") == "GENROU"]
    return "".join(f"{r} /\n" for r in kept)


@pytest.fixture
def case(tmp_path: Path) -> tuple[Path, Path]:
    """Kundur's network, its four GENROU machines, and the two exciters."""
    cases = _cases()
    workspace = tmp_path / "ws"
    workspace.mkdir()
    raw = workspace / "kundur.raw"
    shutil.copyfile(cases / "kundur" / "kundur.raw", raw)
    dyr = workspace / "kundur_exciters.dyr"
    genrou = _genrou_records((cases / "kundur" / "kundur_full.dyr").read_text())
    dyr.write_text(genrou + _ESAC1A + _ESST1A, encoding="utf-8")
    return raw, dyr


def _held(ss: Any, model: str) -> dict[str, float]:
    model_obj = getattr(ss, model)
    assert model_obj.n == 1
    return {name: float(getattr(model_obj, name).v[0]) for name in _FILE_VALUES[model]}


def test_records_are_split_as_andes_splits_them() -> None:
    text = "1 'GENCLS' 1, 3.0 0.0 / a comment\n" + _ESAC1A + "\n\n" + _ESST1A
    records = read_dyr_records(text)
    assert [r.model for r in records] == ["GENCLS", "ESAC1A", "ESST1A"]
    assert records[0].bus == 1 and records[0].machine_id == 1
    assert records[0].values == (3.0, 0.0)
    # A record over two lines is one record.
    assert len(records[1].values) == 19
    assert records[1].values[3] == 200.0
    assert len(records[2].values) == 20


@pytest.mark.parametrize("model", sorted(PSSE_COLUMNS))
def test_andes_reads_the_same_parameters_in_another_order(model: str) -> None:
    """The table names the parameters the installed ANDES sets from the
    record, each once. When this fails because the orders are equal, ANDES
    reads PSS/E's order and the model leaves the table."""
    andes_order = andes_columns(model)
    assert andes_order is not None
    assert sorted(andes_order) == sorted(PSSE_COLUMNS[model])
    assert andes_order != PSSE_COLUMNS[model]


def test_load_case_puts_the_file_values_back(
    case: tuple[Path, Path], tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    raw, dyr = case
    wrapper = Wrapper(workspace=raw.parent, session_id="sess-dyr")
    with caplog.at_level(logging.WARNING, logger="tensa.notice"):
        wrapper.load_case(raw, addfiles=[dyr])
    ss = wrapper._ss
    for model, values in _FILE_VALUES.items():
        assert _held(ss, model) == pytest.approx(values), model
    notices = [r.getMessage() for r in caplog.records if r.name == "tensa.notice"]
    assert any(n.startswith("ESAC1A on the machine at bus 1, id 1") and "KA 200" in n for n in notices)
    assert any(n.startswith("ESST1A on the machine at bus 2, id 1") and "TC 14.1421" in n for n in notices)


def test_a_system_built_again_holds_the_file_values(case: tuple[Path, Path]) -> None:
    """Undo, redo and delete build the System from the file again."""
    raw, dyr = case
    wrapper = Wrapper(workspace=raw.parent, session_id="sess-dyr")
    wrapper.load_case(raw, addfiles=[dyr])
    ss = wrapper._build_system([])
    for model, values in _FILE_VALUES.items():
        assert _held(ss, model) == pytest.approx(values), model


def test_the_values_are_the_ones_a_setup_runs_with(case: tuple[Path, Path]) -> None:
    raw, dyr = case
    wrapper = Wrapper(workspace=raw.parent, session_id="sess-dyr")
    wrapper.load_case(raw, addfiles=[dyr])
    ss = wrapper._ss
    ss.setup()
    assert float(ss.ESAC1A.KA.v[0]) == 200.0
    assert float(ss.ESAC1A.KE.v[0]) == 1.0
    assert float(ss.ESST1A.TC.v[0]) == pytest.approx(14.142135623731)
    assert float(ss.ESST1A.ILR.v[0]) == 2.8


def test_a_clone_edit_writes_the_column_pss_e_reads(tmp_path: Path) -> None:
    """The clone index places ESST1A's parameters by PSS/E's columns, so an
    edit of ``KA`` lands where the load reads ``KA`` from."""
    path = tmp_path / "exciter.dyr"
    path.write_text(_ESST1A, encoding="utf-8")
    apply_edit(path, "ESST1A", "ESST1A_1", "KA", 150.0, locator=DyrLocator(bus=2, id="1"))
    (record,) = read_dyr_records(path.read_text(encoding="utf-8"))
    by_name = dict(zip(PSSE_COLUMNS["ESST1A"], record.values, strict=True))
    assert by_name["KA"] == 150.0
    assert {k: v for k, v in by_name.items() if k != "KA"} == pytest.approx(
        {k: v for k, v in _FILE_VALUES["ESST1A"].items() if k != "KA"}
    )
