"""Unit tests for ``tensa.engines.keys``: the key builders and ``KeyBook``
(unit P3-B2a)."""

from __future__ import annotations

import pytest

from tensa.engines.keys import (
    KeyBook,
    KeyEntry,
    bus_key,
    device_key,
    engine_key,
    generator_key,
    is_key,
    line_key,
    load_key,
    shunt_key,
    transformer_key,
    unit_model_key,
)


@pytest.mark.unit
def test_builders() -> None:
    assert bus_key(7) == "bus:7"
    assert line_key(7, 8, "1") == "line:7-8-1"
    assert transformer_key(1, 5, "1") == "xfmr:1-5-1"
    assert generator_key(1, "1") == "gen:1-1"
    assert load_key(7, "1") == "load:7-1"
    assert shunt_key(7, "1") == "shunt:7-1"
    assert device_key("Motor", 5, "1") == "motor:5-1"
    assert unit_model_key("gen:1-1", "exciter") == "gen:1-1/exciter"
    assert unit_model_key("gen:1-1", "renewable", "REGCA1") == "gen:1-1/renewable:REGCA1"
    assert engine_key("andes", "PMU", 3) == "engine:andes:PMU:3"


@pytest.mark.unit
def test_ids_are_cleaned() -> None:
    # Spaces inside an id become "_" and "/" becomes "_"; surrounding spaces
    # are stripped; an empty id becomes "1".
    assert generator_key(1, " G 2 ") == "gen:1-G_2"
    assert line_key(7, 8, "1/2") == "line:7-8-1_2"
    assert load_key(7, "  ") == "load:7-1"
    assert shunt_key(7, "") == "shunt:7-1"


@pytest.mark.unit
def test_is_key() -> None:
    assert is_key("bus:7")
    assert is_key("gen:1-1/exciter")
    assert is_key("engine:andes:PMU:3")
    assert not is_key("Bus:7")
    assert not is_key("bus")
    assert not is_key("bus:")
    assert not is_key("7")
    assert not is_key("")


@pytest.mark.unit
def test_keybook_handle_int_and_str_are_the_same() -> None:
    book = KeyBook()
    book.assign(KeyEntry("bus:5", "bus", "Bus", 5, "engine"))
    assert book.has("Bus", "5")
    assert book.key_of("Bus", "5") == "bus:5"
    assert book.key_of("Bus", 5) == "bus:5"
    # Assigning the same handle as a string returns the stored entry unchanged.
    again = book.assign(KeyEntry("bus:105", "bus", "Bus", "5", "engine"))
    assert again.key == "bus:5"
    assert len(book.entries()) == 1


@pytest.mark.unit
def test_keybook_key_never_changes() -> None:
    book = KeyBook()
    first = book.assign(KeyEntry("gen:1-1", "generator", "PV", 1, "engine"))
    second = book.assign(KeyEntry("gen:1-2", "generator", "PV", 1, "engine"))
    assert first is second
    assert second.key == "gen:1-1"
    assert book.entry_of("gen:1-1") is first
    assert book.entry_of("gen:1-2") is None


@pytest.mark.unit
def test_keybook_duplicate_key_string_gets_suffix_and_problem() -> None:
    book = KeyBook()
    book.assign(KeyEntry("load:7-1", "load", "PQ", 1, "file"))
    second = book.assign(KeyEntry("load:7-1", "load", "PQ", 2, "file"))
    assert second.key == "load:7-1~2"
    third = book.assign(KeyEntry("load:7-1", "load", "PQ", 3, "file"))
    assert third.key == "load:7-1~3"
    assert len(book.problems) == 2
    assert "load:7-1" in book.problems[0]
    assert "PQ 1" in book.problems[0]
    assert "PQ 2" in book.problems[0]
    assert [entry.key for entry in book.entries()] == [
        "load:7-1",
        "load:7-1~2",
        "load:7-1~3",
    ]
