"""The web tests' copy of the topology schema matches the server's.

The data grids decide which cells can be edited from ``GET /topology/schema``
(the numeric parameters of each model). The web tests read a checked-in copy of
that response, ``web/tests/unit/helpers/topologySchema.json``, so a server change
to a parameter's kind or name would leave them green while the real table went
read-only. This test fails on any difference.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from tensa.api.routes.elements import topology_schema
from tests._repo import WEB_DIR

pytestmark = pytest.mark.unit

FIXTURE = WEB_DIR / "tests" / "unit" / "helpers" / "topologySchema.json"

REGENERATE = (
    "Write the response again: from server/, dump "
    "asyncio.run(tensa.api.routes.elements.topology_schema()).model_dump() as JSON "
    "to web/tests/unit/helpers/topologySchema.json, then run "
    "`pnpm exec prettier --write tests/unit/helpers/topologySchema.json` in web/."
)


def test_web_fixture_is_the_schema_the_server_serves() -> None:
    if not FIXTURE.is_file():
        pytest.skip("web/tests/unit/helpers/topologySchema.json is not next to the tests")
    served = asyncio.run(topology_schema()).model_dump()
    held = json.loads(FIXTURE.read_text(encoding="utf-8"))

    assert sorted(held["models"]) == sorted(served["models"]), (
        f"The models differ from the server's. {REGENERATE}"
    )
    for model, params in served["models"].items():
        assert held["models"][model] == params, (
            f"The parameters of {model} differ from the server's. {REGENERATE}"
        )
