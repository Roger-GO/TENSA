"""``KeyBook.retain``: dropping the entries whose handle is gone."""

from __future__ import annotations

from tensa.engines.keys import KeyBook, KeyEntry


def _book() -> KeyBook:
    book = KeyBook()
    book.assign(KeyEntry("bus:1", "bus", "Bus", 1, "file"))
    book.assign(KeyEntry("bus:2", "bus", "Bus", 2, "file"))
    book.assign(KeyEntry("branch:1-2-1", "line", "Line", "Line_1", "file"))
    return book


def test_retain_drops_entries_not_named() -> None:
    book = _book()
    book.retain({("Bus", "1"), ("Line", "Line_1")})
    assert [entry.key for entry in book.entries()] == ["bus:1", "branch:1-2-1"]


def test_retain_keeps_order_and_lookup() -> None:
    book = _book()
    book.retain({("Line", "Line_1"), ("Bus", "2")})
    assert [entry.key for entry in book.entries()] == ["bus:2", "branch:1-2-1"]
    assert book.key_of("Bus", 2) == "bus:2"
    assert book.key_of("Bus", 1) is None
    assert book.entry_of("bus:2") is not None
    assert book.entry_of("bus:1") is None


def test_retain_compares_idx_as_str() -> None:
    book = _book()
    book.retain({("Bus", "1"), ("Bus", "2")})
    assert [entry.key for entry in book.entries()] == ["bus:1", "bus:2"]


def test_assign_after_retain_keys_the_handle_again() -> None:
    book = _book()
    book.retain({("Bus", "1")})
    assert book.key_of("Bus", 2) is None
    stored = book.assign(KeyEntry("bus:2", "bus", "Bus", 2, "file"))
    assert stored.key == "bus:2"
    assert book.key_of("Bus", 2) == "bus:2"
    # The handle that stayed keeps its first key, and the order is kept.
    assert [entry.key for entry in book.entries()] == ["bus:1", "bus:2"]
