"""The web UI's copy of the layout schema keeps up with the server's.

The UI validates and writes layouts with a schema of its own
(``web/src/components/sld/sidecar.ts``), since it must read a curated layout and
build a document before any request is made. The two constants a write depends
on are checked here against ``tensa.core.layout``.
"""

from __future__ import annotations

import re

import pytest

from tensa.core.layout import LAYOUT_SCHEMA_VERSION, MAX_BEND_POINTS
from tests._repo import WEB_DIR

pytestmark = pytest.mark.unit


def test_the_web_ui_writes_the_version_and_keeps_the_cap_the_server_has() -> None:
    """The UI validates and writes layouts with its own copy of the schema
    (``sidecar.ts``). A copy that fell behind would write a version the server
    upgrades on every read, or a route the server refuses to store."""
    source = WEB_DIR / "src" / "components" / "sld" / "sidecar.ts"
    if not source.is_file():
        pytest.skip("web/src/components/sld/sidecar.ts is not next to the tests")
    text = source.read_text(encoding="utf-8")
    version = re.search(r"export const SIDECAR_SCHEMA_VERSION = '(\d+)';", text)
    assert version is not None, "sidecar.ts no longer declares SIDECAR_SCHEMA_VERSION"
    assert version.group(1) == LAYOUT_SCHEMA_VERSION
    cap = re.search(r"export const MAX_BEND_POINTS = (\d+);", text)
    assert cap is not None, "sidecar.ts no longer declares MAX_BEND_POINTS"
    assert int(cap.group(1)) == MAX_BEND_POINTS
