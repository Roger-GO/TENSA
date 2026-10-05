"""``POST /comtrade``: the route over ``tensa.core.comtrade``.

The record itself is checked in ``test_comtrade.py``. These cover what the route
adds: the wire shape, the archive it answers with, and what it refuses.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa import __version__
from tensa.api.app import make_app
from tensa.api.routes import comtrade as comtrade_route
from tensa.api.schemas import MAX_COMTRADE_VALUES
from tests._comtrade import read_comtrade_zip
from tests._repo import WEB_DIR

pytestmark = pytest.mark.unit


async def _post(tmp_path: Path, body: dict[str, Any]) -> httpx.Response:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        return await client.post("/api/comtrade", json=body)


def _run(seconds: float = 2.0) -> dict[str, Any]:
    """A request as the web UI builds one from a streamed run."""
    t = [i / 30 for i in range(int(seconds * 30) + 1)]
    return {
        "t": t,
        "channels": [
            {"name": "Bus_3_v", "unit": "pu", "values": [1.0 - 0.2 * math.exp(-x) for x in t]},
            {"name": "Bus_3_a", "unit": "rad", "values": [-0.2 + 0.05 * math.sin(x) for x in t]},
        ],
    }


async def test_the_answer_is_an_archive_of_the_record(tmp_path: Path) -> None:
    body = {
        **_run(),
        "name": "ieee14_1a2b3c4d",
        "station": "ieee14",
        "device": "TDS #3 - fault bus 7",
        "frequency_hz": 50,
        "start_time": "2026-10-05T14:03:22.500",
        "trigger_t": 1.0,
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"] == 'attachment; filename="ieee14_1a2b3c4d.zip"'
    name, record = read_comtrade_zip(response.content)
    assert name == "ieee14_1a2b3c4d"
    assert (record.station, record.device, record.rev_year) == (
        "ieee14",
        "TDS #3 - fault bus 7",
        "1999",
    )
    assert record.frequency == 50.0
    assert (record.nrates, record.rates) == (1, [(30.0, 61)])
    assert record.first.isoformat() == "2026-10-05T14:03:22.500000"
    assert record.trigger.isoformat() == "2026-10-05T14:03:23.500000"
    assert [(c.name, c.unit) for c in record.channels] == [("Bus_3_v", "pu"), ("Bus_3_a", "rad")]
    for channel, sent in zip(record.channels, body["channels"], strict=True):
        assert channel.values.tolist() == pytest.approx(sent["values"], abs=channel.a)


async def test_the_traces_of_a_batch_run_go_in_as_they_come_out(tmp_path: Path) -> None:
    """``{"name", "values"}`` with ``null`` for a diverged step, and nothing else
    said: the defaults name the files and the device."""
    traces = {
        "t": [0.0, 0.02, 0.04, 0.04, 0.06],
        "variables": [
            {"name": "omega GENROU 1", "values": [1.0, 1.0, 1.0, 1.001, None]},
            {"name": "vf GENROU 2", "values": [2.1, 2.1, 2.1, 2.4, 2.5]},
        ],
        "truncated": False,
    }

    response = await _post(tmp_path, {"t": traces["t"], "channels": traces["variables"]})

    assert response.status_code == 200, response.text
    assert response.headers["content-disposition"] == 'attachment; filename="tensa.zip"'
    name, record = read_comtrade_zip(response.content)
    assert name == "tensa"
    assert (record.station, record.device) == ("", f"TENSA {__version__}")
    assert record.frequency == 60.0
    # The repeated time of an event: no rate, the time stamps say when.
    assert (record.nrates, record.rates) == (0, [(0.0, 5)])
    assert record.stamps.tolist() == [0, 20000, 40000, 40000, 60000]
    omega, vf = record.channels
    assert (omega.name, omega.unit) == ("omega GENROU 1", "NONE")
    assert omega.stored[-1] == 99999
    assert vf.values.tolist() == pytest.approx([2.1, 2.1, 2.1, 2.4, 2.5], abs=1e-5)
    assert record.trigger == record.first


@pytest.mark.parametrize(
    "change",
    [
        {"channels": []},
        {"t": []},
        {"t": [0.0, 1.0, "later"]},
        {"channels": [{"name": "", "values": [1.0]}]},
        {"channels": [{"name": "x", "values": [1.0], "phase": "A"}]},
        {"channels": [{"name": "x", "values": ["high"]}]},
        {"frequency_hz": 0},
        {"start_time": "yesterday"},
        {"trigger_t": "soon"},
        {"decimate": 2},
    ],
)
async def test_a_malformed_request_is_a_422(tmp_path: Path, change: dict[str, Any]) -> None:
    assert (await _post(tmp_path, {**_run(), **change})).status_code == 422


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"t": [0.0, 1.0]}, "'Bus_3_v' has 61 values for 2 samples"),
        ({"t": [float(60 - i) for i in range(61)]}, "t must not decrease"),
        ({"trigger_t": 30.0}, "outside the record"),
    ],
)
async def test_signals_that_make_no_record_are_a_422_that_says_why(
    tmp_path: Path, change: dict[str, Any], reason: str
) -> None:
    response = await _post(tmp_path, {**_run(), **change})

    assert response.status_code == 422
    assert reason in response.json()["detail"]


@pytest.mark.parametrize(
    "name",
    [
        "",
        "../etc",
        "a/b",
        "a\\b",
        "con",
        "run.",
        ".hidden",
        "x" * 65,
        "x" * 100_000,
        "two words",
        'q"uote',
    ],
)
async def test_a_name_that_is_not_a_plain_file_name_is_refused(tmp_path: Path, name: str) -> None:
    """The name becomes two file names in the archive and one in a header."""
    response = await _post(tmp_path, {**_run(), "name": name})

    assert response.status_code == 422
    assert "the name" in response.json()["detail"]
    # A long name is not sent back whole.
    assert len(response.json()["detail"]) < 400


async def test_more_values_than_an_export_takes_is_a_413_that_does_not_echo_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(comtrade_route, "MAX_COMTRADE_VALUES", 100)
    body = _run()  # 2 channels of 61 samples

    response = await _post(tmp_path, body)

    assert response.status_code == 413
    detail = response.json()["detail"]
    assert "holds 122 values" in detail and "at most 100" in detail
    assert len(response.text) < 1000


async def test_the_limit_counts_the_values_sent_not_the_times(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A channel far longer than ``t`` is refused for its size before it is read."""
    monkeypatch.setattr(comtrade_route, "MAX_COMTRADE_VALUES", 100)
    body = {"t": [0.0], "channels": [{"name": "x", "values": [0.0] * 101}]}

    assert (await _post(tmp_path, body)).status_code == 413


def test_the_limit_is_what_the_schema_says(tmp_path: Path) -> None:
    assert comtrade_route.MAX_COMTRADE_VALUES == MAX_COMTRADE_VALUES == 5_000_000
    schemas = make_app(workspace=tmp_path, static_override=tmp_path).openapi()["components"][
        "schemas"
    ]
    assert "5000000 values" in schemas["ComtradeExportRequest"]["properties"]["channels"][
        "description"
    ]


def test_the_web_ui_refuses_at_the_limit_the_route_has() -> None:
    """The export menu checks the size of a run before it sends it, against its
    own copy of the limit. A copy that fell behind would send what is refused, or
    refuse what would be taken."""
    source = WEB_DIR / "src" / "lib" / "comtrade.ts"
    if not source.is_file():
        pytest.skip("web/src/lib/comtrade.ts is not next to the tests")
    held = re.search(
        r"export const MAX_COMTRADE_VALUES = ([\d_]+);", source.read_text(encoding="utf-8")
    )
    assert held is not None, "web/src/lib/comtrade.ts no longer declares MAX_COMTRADE_VALUES"
    assert int(held.group(1).replace("_", "")) == MAX_COMTRADE_VALUES


def test_the_route_is_tagged_for_the_gui_parity_ledger(tmp_path: Path) -> None:
    operation = make_app(workspace=tmp_path, static_override=tmp_path).openapi()["paths"][
        "/api/comtrade"
    ]["post"]

    assert operation["x-tensa-gui-location"] == "analysis-panel"
    assert operation["operationId"] == "exportComtrade"
    assert "application/zip" in operation["responses"]["200"]["content"]
