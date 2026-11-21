"""Integration tests of ``assign_andes_keys`` on the real ANDES cases
(unit P3-B2a, refined by P3-B2b). Cases are located as
``test_engines_identity_andes.py`` does.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tensa.core.examples import _andes_cases_dir
from tensa.engines.andes.keys import assign_andes_keys
from tensa.engines.identity import CaseIdentity, read_identity
from tensa.engines.keys import is_key


def _andes_case(relative: str) -> Path:
    cases_dir = _andes_cases_dir()
    if cases_dir is None:
        pytest.skip("ANDES cases folder not found")
    path = Path(cases_dir) / relative
    if not path.is_file():
        pytest.skip(f"ANDES case file missing: {relative}")
    return path


PSSE_CASES = (
    ("kundur/kundur.raw", "kundur/kundur_full.dyr"),
    ("ieee14/ieee14.raw", "ieee14/ieee14.dyr"),
    ("ieee39/ieee39.raw", None),
    ("npcc/npcc.raw", "npcc/npcc_full.dyr"),
    ("wecc/wecc.raw", "wecc/wecc_full.dyr"),
)


def _load(relative: str, addfile: str | None) -> tuple[Any, CaseIdentity]:
    andes = pytest.importorskip("andes")
    path = _andes_case(relative)
    addfile_path = str(_andes_case(addfile)) if addfile is not None else None
    ss = andes.load(
        str(path), addfile=addfile_path, setup=False, no_output=True, default_config=True
    )
    return ss, read_identity(path)


@pytest.mark.integration
@pytest.mark.parametrize("relative,addfile", PSSE_CASES)
def test_psse_case_keys(relative: str, addfile: str | None) -> None:
    ss, identity = _load(relative, addfile)
    book = assign_andes_keys(ss, identity)

    keys = [entry.key for entry in book.entries()]
    assert len(keys) == len(set(keys))
    assert all(is_key(key) for key in keys)
    assert book.problems == []

    # Every bus, line, generator and load of the system has a key.
    for idx in ss.Bus.idx.v:
        assert book.has("Bus", idx)
    for idx in ss.Line.idx.v:
        assert book.has("Line", idx)
    for model_name in ("PV", "Slack"):
        model = getattr(ss, model_name, None)
        if model is not None:
            for idx in model.idx.v:
                assert book.has(model_name, idx)
    for idx in ss.PQ.idx.v:
        assert book.has("PQ", idx)

    entries = book.entries()
    line_entries = [entry for entry in entries if entry.model == "Line"]
    assert all(entry.source == "file" for entry in line_entries)
    load_entries = [entry for entry in entries if entry.model == "PQ"]
    assert all(entry.source == "file" for entry in load_entries)

    branch_keys = [
        entry.key for entry in entries if entry.key.startswith("branch:")
    ]
    assert len(branch_keys) == ss.Line.n


@pytest.mark.integration
def test_matpower_case118_lines_matched_by_bus_pair() -> None:
    # ANDES keeps the MATPOWER branch rows in file order with transformers in
    # between, while the identity lists the plain branches first; matching by
    # bus pair still gives every line its file circuit.
    ss, identity = _load("matpower/case118.m", None)
    book = assign_andes_keys(ss, identity)

    line_entries = [entry for entry in book.entries() if entry.model == "Line"]
    assert len(line_entries) == ss.Line.n
    assert all(entry.source == "file" for entry in line_entries)
    assert book.problems == []
    branch_keys = [
        entry.key for entry in book.entries() if entry.key.startswith("branch:")
    ]
    assert len(branch_keys) == ss.Line.n


@pytest.mark.integration
def test_wscc9_three_winding_transformer() -> None:
    # ANDES turns the file's three-winding transformer into a star bus the
    # file does not number and three lines to it: one bus and three lines get
    # engine keys, and the nine branches of the file keep theirs.
    ss, identity = _load("wscc9/wscc9_3wxfr.raw", None)
    book = assign_andes_keys(ss, identity)

    line_entries = [entry for entry in book.entries() if entry.model == "Line"]
    file_lines = [entry for entry in line_entries if entry.source == "file"]
    assert len(file_lines) == 9

    engine_bus_entries = [
        entry
        for entry in book.entries()
        if entry.model == "Bus" and entry.key.startswith("engine:andes:")
    ]
    assert len(engine_bus_entries) == 1
    engine_line_entries = [
        entry
        for entry in line_entries
        if entry.key.startswith("engine:andes:")
    ]
    assert len(engine_line_entries) == 3
    assert all(entry.bucket == "other" for entry in engine_bus_entries)
    assert all(entry.bucket == "other" for entry in engine_line_entries)

    assert len(book.problems) == 1
    assert "three-winding" in book.problems[0]

    keys = [entry.key for entry in book.entries()]
    assert len(keys) == len(set(keys))


@pytest.mark.integration
def test_ieee14_esd1_same_model_devices_on_one_unit() -> None:
    # Six ESD1 devices name one static generator; the extra ones take "-2",
    # "-3", ... on the model-qualified key, and no key carries a "~" suffix.
    andes = pytest.importorskip("andes")
    path = _andes_case("ieee14/ieee14_esd1.xlsx")
    ss = andes.load(str(path), setup=False, no_output=True, default_config=True)
    book = assign_andes_keys(ss, None)

    keys = [entry.key for entry in book.entries()]
    assert len(keys) == len(set(keys))
    assert all("~" not in key for key in keys)
    assert book.problems == []


@pytest.mark.integration
def test_kundur_unit_keys_and_parallel_circuits() -> None:
    ss, identity = _load("kundur/kundur.raw", "kundur/kundur_full.dyr")
    book = assign_andes_keys(ss, identity)

    for key in ("gen:1-1/machine", "gen:1-1/exciter", "gen:1-1/governor"):
        assert book.entry_of(key) is not None

    # The two parallel lines between buses 7 and 8 keep the file's circuits
    # "1" and "2" (kundur.raw has three, 7-8 '1', '2' and '3').
    circuits = {
        entry.key
        for entry in book.entries()
        if entry.key.startswith("branch:7-8-") and entry.bucket == "line"
    }
    assert {"branch:7-8-1", "branch:7-8-2"} <= circuits


@pytest.mark.integration
def test_xlsx_case_without_identity() -> None:
    andes = pytest.importorskip("andes")
    path = _andes_case("kundur/kundur_full.xlsx")
    ss = andes.load(str(path), setup=False, no_output=True, default_config=True)
    book = assign_andes_keys(ss, None)

    keys = [entry.key for entry in book.entries()]
    assert len(keys) == len(set(keys))
    assert all(is_key(key) for key in keys)

    for idx in ss.Bus.idx.v:
        assert book.has("Bus", idx)
    for idx in ss.Line.idx.v:
        assert book.has("Line", idx)
    for idx in ss.PQ.idx.v:
        assert book.has("PQ", idx)
    branch_keys = [
        entry.key for entry in book.entries() if entry.key.startswith("branch:")
    ]
    assert len(branch_keys) == ss.Line.n
