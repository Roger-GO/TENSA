"""The web UI's copy of the layout schema keeps up with the server's.

The UI validates and writes layouts with a schema of its own
(``web/src/components/sld/sidecar.ts``), since it must read a curated layout and
build a document before any request is made. Two things hold the copies
together. The constants a write depends on are checked here against
``tensa.core.layout``. And one fixture, ``web/tests/fixtures/layout-v2.json``, is
read by the tests of both sides: a version 2 document with something in every
section, and what of it goes beside a copy whose idx values will change. Here the
server's schema and :func:`for_renumbered_copy` are held to it; the web tests
(``web/tests/unit/components/sld/sidecar.test.ts``) hold ``parseSidecar`` and
``layoutForRenumberedCopy`` to the same file.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest

from tensa.core.layout import (
    LAYOUT_SCHEMA_VERSION,
    MAX_BEND_POINTS,
    MAX_FIGURE_SETTINGS,
    MAX_FIGURE_TEXT,
    for_renumbered_copy,
    parse_layout,
)
from tests._repo import WEB_DIR

pytestmark = pytest.mark.unit


def _web_constant(text: str, name: str) -> str:
    declared = re.search(rf"export const {name} = '?(\d+)'?;", text)
    assert declared is not None, f"sidecar.ts no longer declares {name}"
    return declared.group(1)


def test_the_web_ui_writes_the_version_and_keeps_the_caps_the_server_has() -> None:
    """The UI validates and writes layouts with its own copy of the schema
    (``sidecar.ts``). A copy that fell behind would write a version the server
    upgrades on every read, or a route or a figure the server refuses to store."""
    source = WEB_DIR / "src" / "components" / "sld" / "sidecar.ts"
    if not source.is_file():
        pytest.skip("web/src/components/sld/sidecar.ts is not next to the tests")
    text = source.read_text(encoding="utf-8")
    assert _web_constant(text, "SIDECAR_SCHEMA_VERSION") == LAYOUT_SCHEMA_VERSION
    assert int(_web_constant(text, "MAX_BEND_POINTS")) == MAX_BEND_POINTS
    assert int(_web_constant(text, "MAX_FIGURE_SETTINGS")) == MAX_FIGURE_SETTINGS
    assert int(_web_constant(text, "MAX_FIGURE_TEXT")) == MAX_FIGURE_TEXT


def _shared_fixture() -> dict[str, Any]:
    path = WEB_DIR / "tests" / "fixtures" / "layout-v2.json"
    if not path.is_file():
        pytest.skip("web/tests/fixtures/layout-v2.json is not next to the tests")
    fixture: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return fixture


def test_the_document_both_sides_test_against_is_one_the_server_stores_as_it_is() -> None:
    """Every section, with every field written out: validated and dumped, it
    comes back unchanged, so the web tests read what the server would answer."""
    document = _shared_fixture()["document"]
    layout = parse_layout(document)
    assert layout.schema_version == LAYOUT_SCHEMA_VERSION
    assert layout.model_dump() == document
    # Something in each section, or the fixture would check less than it says.
    for section in type(layout).model_fields:
        assert document[section], f"the shared fixture has nothing under {section!r}"


def test_the_renumbered_copy_is_the_one_both_sides_are_held_to() -> None:
    """A ``.raw`` copy gets its layout from whoever wrote last: the server on
    the save, the UI right after it. Both must cut the same things out."""
    fixture = _shared_fixture()
    copy = for_renumbered_copy(parse_layout(fixture["document"]))
    assert copy.model_dump() == fixture["renumbered_copy"]
    # The cut drops something from every idx-keyed section, and keeps something.
    kept, whole = fixture["renumbered_copy"], fixture["document"]
    for section in ("non_bus_coordinates", "branches", "label_offsets", "connections"):
        assert kept[section] and kept[section] != whole[section]
    for section in ("controller_coordinates", "units"):
        assert whole[section] and kept[section] == {}
    for section in ("coordinates", "busbars", "figure"):
        assert kept[section] == whole[section]
