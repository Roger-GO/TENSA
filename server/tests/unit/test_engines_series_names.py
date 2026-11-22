"""Unit tests for ``tensa.engines.series_names``: neutral series names and the
ANDES column mapping (unit 5a). Builds ``KeyBook`` instances directly; no
engine."""

from __future__ import annotations

import subprocess
import sys

import pytest

from tensa.engines.keys import KeyBook, KeyEntry
from tensa.engines.series_names import (
    QUANTITIES,
    QUANTITY_BY_NAME,
    build_name,
    build_state_name,
    neutral_name_andes,
    neutral_names_andes,
    parse_name,
    parse_state_name,
)


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("bus:7", "bus", "Bus", 7, "file"))
    book.assign(KeyEntry("branch:7-8-1", "line", "Line", "7-8", "file"))
    book.assign(KeyEntry("load:7-1", "load", "PQ", 1, "file"))
    book.assign(KeyEntry("gen:1-1", "generator", "PV", 1, "file"))
    book.assign(KeyEntry("gen:1-1/machine", "dynamic", "GENROU", 1, "engine"))
    return book


@pytest.mark.unit
def test_catalogue_matches_spec() -> None:
    assert len(QUANTITIES) == 12
    assert QUANTITY_BY_NAME["rotor_angle_rel"].unit == "rad"
    assert QUANTITY_BY_NAME["rotor_angle_rel"].of == "generating unit"
    assert QUANTITY_BY_NAME["p_from"].convention == "into the branch at its `from` end"
    assert QUANTITY_BY_NAME["eigenvalue"].unit == "1/s"
    assert QUANTITY_BY_NAME["state"].convention == (
        "the engine's raw state, for one-engine use only"
    )


@pytest.mark.unit
def test_build_name() -> None:
    assert build_name("rotor_speed", "gen:1-1") == "rotor_speed|gen:1-1"
    assert build_name("voltage", "bus:7") == "voltage|bus:7"


@pytest.mark.unit
def test_build_name_unknown_quantity() -> None:
    with pytest.raises(ValueError, match="unknown quantity 'frequency'"):
        build_name("frequency", "bus:7")


@pytest.mark.unit
def test_build_name_eigenvalue_refused() -> None:
    # Eigenvalues are in the catalogue but are not a streamed series.
    with pytest.raises(ValueError, match="unknown quantity 'eigenvalue'"):
        build_name("eigenvalue", "bus:7")


@pytest.mark.unit
def test_build_name_state_refused() -> None:
    with pytest.raises(ValueError, match="build_state_name"):
        build_name("state", "gen:1-1")


@pytest.mark.unit
def test_build_name_bad_key() -> None:
    with pytest.raises(ValueError, match="not a key"):
        build_name("voltage", "Bus 7")


@pytest.mark.unit
def test_parse_name_round_trip() -> None:
    for quantity in (
        "voltage",
        "angle",
        "angle_rel",
        "rotor_speed",
        "rotor_angle",
        "rotor_angle_rel",
        "p",
        "q",
        "p_from",
        "q_from",
    ):
        assert parse_name(build_name(quantity, "bus:7")) == (quantity, "bus:7")


@pytest.mark.unit
def test_state_name_round_trip() -> None:
    name = build_state_name("gen:1-1/machine", "omega")
    assert name == "state|gen:1-1/machine#omega"
    assert parse_name(name) == ("state", "gen:1-1/machine#omega")
    assert parse_state_name(name) == ("gen:1-1/machine", "omega")


@pytest.mark.unit
def test_a_state_name_may_hold_a_hash_and_splits_at_the_first() -> None:
    # A key holds no "#", so the first one after the "|" ends the key and the
    # rest, "#" and all, is the state name.
    name = build_state_name("gen:1-1/machine", "x#y")
    assert parse_state_name(name) == ("gen:1-1/machine", "x#y")


@pytest.mark.unit
def test_a_machine_column_takes_the_machine_entry_not_a_controller_with_its_idx() -> None:
    # An exciter of unit gen:2-1 has idx 5, the same text as the machine of unit
    # gen:1-1, and comes first in the book. The Gen column names a machine, so it
    # is the machine's unit that answers.
    book = KeyBook()
    book.assign(KeyEntry("gen:2-1/exciter", "dynamic", "EXST1", 5, "engine"))
    book.assign(KeyEntry("gen:1-1/machine", "dynamic", "GENROU", 5, "engine"))
    assert neutral_name_andes("Gen_5_omega", book) == "rotor_speed|gen:1-1"


@pytest.mark.unit
def test_parse_state_name_errors() -> None:
    with pytest.raises(ValueError, match="not a neutral state series name"):
        parse_state_name("voltage|bus:7")
    with pytest.raises(ValueError, match="not a neutral state series name"):
        parse_state_name("state|gen:1-1/machine")
    with pytest.raises(ValueError, match="not a neutral series name"):
        parse_state_name("state|Bus 7#omega")


@pytest.mark.unit
def test_parse_name_errors() -> None:
    with pytest.raises(ValueError, match="not a neutral series name: 'Bus_7_v'"):
        parse_name("Bus_7_v")
    with pytest.raises(ValueError, match="unknown quantity 'frequency'"):
        parse_name("frequency|bus:7")
    with pytest.raises(ValueError, match="not a neutral series name"):
        parse_name("voltage|Bus 7")
    with pytest.raises(ValueError, match="not a neutral series name"):
        parse_name("|bus:7")


@pytest.mark.unit
def test_build_state_name_empty_state() -> None:
    with pytest.raises(ValueError, match="empty state name"):
        build_state_name("gen:1-1", "  ")


@pytest.mark.unit
def test_build_state_name_bad_key() -> None:
    with pytest.raises(ValueError, match="not a key"):
        build_state_name("Bus 7", "omega")


@pytest.mark.unit
def test_neutral_name_andes_all_patterns() -> None:
    book = _book()
    assert neutral_name_andes("Bus_7_v", book) == "voltage|bus:7"
    assert neutral_name_andes("Bus_7_a", book) == "angle|bus:7"
    assert neutral_name_andes("Gen_1_delta", book) == "rotor_angle|gen:1-1"
    assert neutral_name_andes("Gen_1_omega", book) == "rotor_speed|gen:1-1"
    assert neutral_name_andes("Gen_1_Pe", book) == "p|gen:1-1"
    assert neutral_name_andes("Gen_1_Qe", book) == "q|gen:1-1"
    assert neutral_name_andes("Line_7-8_p", book) == "p_from|branch:7-8-1"
    assert neutral_name_andes("Line_7-8_q", book) == "q_from|branch:7-8-1"
    assert neutral_name_andes("Load_1_p", book) == "p|load:7-1"
    assert neutral_name_andes("Load_1_q", book) == "q|load:7-1"


@pytest.mark.unit
def test_neutral_name_andes_string_idx() -> None:
    book = KeyBook()
    book.assign(KeyEntry("bus:1", "bus", "Bus", "BUS7", "ordinal"))
    # The idx is matched as str(idx), so a text idx in the column name works.
    assert neutral_name_andes("Bus_BUS7_v", book) == "voltage|bus:1"


@pytest.mark.unit
def test_neutral_name_andes_machine_kind_suffix() -> None:
    book = KeyBook()
    book.assign(KeyEntry("gen:1-1", "generator", "PV", 1, "file"))
    book.assign(KeyEntry("gen:1-1/machine:GENROU", "dynamic", "GENROU", 1, "engine"))
    assert neutral_name_andes("Gen_1_omega", book) == "rotor_speed|gen:1-1"


@pytest.mark.unit
def test_neutral_name_andes_unknown_column() -> None:
    book = _book()
    # A dae_vars entry, named as ANDES names the variable: not mapped.
    assert neutral_name_andes("omega GENROU 1", book) is None
    assert neutral_name_andes("Bus_7_x", book) is None
    assert neutral_name_andes("random", book) is None


@pytest.mark.unit
def test_neutral_name_andes_missing_key() -> None:
    assert neutral_name_andes("Bus_99_v", _book()) is None


@pytest.mark.unit
def test_neutral_name_andes_gen_without_machine_entry() -> None:
    book = KeyBook()
    book.assign(KeyEntry("gen:1-1", "generator", "PV", 1, "file"))
    # A static generator has no rotor series: the book holds no /machine
    # entry for it, so the column maps to nothing.
    assert neutral_name_andes("Gen_1_omega", book) is None


@pytest.mark.unit
def test_neutral_names_andes_list() -> None:
    book = _book()
    assert neutral_names_andes(["Bus_7_v", "omega GENROU 1"], book) == [
        "voltage|bus:7",
        None,
    ]


@pytest.mark.unit
def test_no_engine_imports() -> None:
    # Load the two modules from their files, under names that keep the
    # package __init__ of tensa.engines (which pulls the engine registry and
    # with it tensa.core) out of the run: what is checked is that the modules
    # themselves import no engine. series_names imports tensa.engines.keys,
    # which is pure Python and is loaded the same way first.
    code = (
        "import importlib.util, sys\n"
        "from pathlib import Path\n"
        "root = Path.cwd() / 'src' / 'tensa' / 'engines'\n"
        "def load(name, path):\n"
        "    spec = importlib.util.spec_from_file_location(name, path)\n"
        "    module = importlib.util.module_from_spec(spec)\n"
        "    sys.modules[name] = module\n"
        "    spec.loader.exec_module(module)\n"
        "load('tensa.engines.keys', root / 'keys.py')\n"
        "load('frames_under_test', root / 'frames.py')\n"
        "load('series_names_under_test', root / 'series_names.py')\n"
        "assert 'andes' not in sys.modules, 'andes imported'\n"
        "assert not any(m == 'tensa.core' or m.startswith('tensa.core.') "
        "for m in sys.modules), 'tensa.core imported'\n"
        "print('clean')\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == "clean"
