"""``POST /response-metrics``: the route over ``response_metrics``.

The metrics themselves are checked in ``test_response_metrics.py``. These cover
what the route adds: the wire shape, a bad series answered without failing the
rest, and the limits on a request.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.api.schemas import MAX_METRIC_SAMPLES, MAX_METRIC_SERIES

pytestmark = pytest.mark.unit


async def _post(tmp_path: Path, body: dict[str, Any]) -> httpx.Response:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        return await client.post("/api/response-metrics", json=body)


def _swing(zeta: float = 0.05, f_hz: float = 0.8, seconds: float = 30.0) -> dict[str, Any]:
    t = [i / 30 for i in range(int(seconds * 30) + 1)]
    wd = 2 * math.pi * f_hz
    sigma = zeta * wd / math.sqrt(1 - zeta**2)
    y = [1.0 + 0.01 * math.exp(-sigma * x) * math.sin(wd * x) for x in t]
    return {"name": "omega GENROU 1", "t": t, "y": y}


async def test_a_series_comes_back_described(tmp_path: Path) -> None:
    response = await _post(tmp_path, {"series": [_swing()]})

    assert response.status_code == 200, response.text
    (result,) = response.json()["results"]
    assert result["name"] == "omega GENROU 1"
    assert result["error"] is None
    assert result["initial"] == pytest.approx(1.0)
    assert result["nadir"]["value"] < 1.0 < result["peak"]["value"]
    assert result["damping"]["ratio"] == pytest.approx(0.05, rel=0.05)
    assert result["damping"]["frequency_hz"] == pytest.approx(0.8, rel=0.03)
    # The steepest 0.5 s stretch is the first fall through 1.0: about -0.03 per second.
    assert result["rocof"]["value"] == pytest.approx(-0.033, abs=0.004)
    assert result["samples"] == len(_swing()["t"])
    assert result["t_start"] == 0.0


async def test_the_window_and_settings_are_applied(tmp_path: Path) -> None:
    series = _swing()
    whole = (await _post(tmp_path, {"series": [series]})).json()["results"][0]
    narrow = (
        await _post(
            tmp_path,
            {"series": [series], "t_start": 5.0, "t_end": 10.0, "rocof_window": 0.1},
        )
    ).json()["results"][0]

    assert (narrow["t_start"], narrow["t_end"]) == (5.0, 10.0)
    assert narrow["samples"] < whole["samples"]
    assert abs(narrow["rocof"]["value"]) != abs(whole["rocof"]["value"])


async def test_a_series_that_cannot_be_described_says_why_and_the_rest_are_answered(
    tmp_path: Path,
) -> None:
    short = {"name": "short", "t": [0.0, 1.0], "y": [1.0, 2.0]}

    response = await _post(tmp_path, {"series": [short, _swing()]})

    assert response.status_code == 200, response.text
    first, second = response.json()["results"]
    assert first["name"] == "short"
    assert "at least 3" in first["error"]
    assert first["initial"] is None and first["damping"] is None
    assert second["error"] is None and second["damping"] is not None


async def test_missing_values_are_sent_as_null(tmp_path: Path) -> None:
    body = {"series": [{"name": "v", "t": [0, 1, 2, 3, 4], "y": [1.0, None, 3.0, None, 5.0]}]}

    result = (await _post(tmp_path, body)).json()["results"][0]

    assert result["samples"] == 3
    assert result["peak"]["value"] == 5.0


@pytest.mark.parametrize(
    "body",
    [
        {"series": []},
        {"series": [{"name": "", "t": [0, 1, 2], "y": [0, 1, 2]}]},
        {"series": [{"name": "x", "t": [0, 1, 2], "y": [0, 1, 2], "unit": "pu"}]},
        {"series": [_swing()], "settling_band": 0},
        {"series": [_swing()], "settling_band": 1},
        {"series": [_swing()], "rocof_window": 0},
        {"series": [_swing()], "t_start": "soon"},
        {"series": [_swing()], "pu": True},
        {"series": [{"name": "x", "t": [0, 1, "later"], "y": [0, 1, 2]}]},
    ],
)
async def test_a_malformed_request_is_a_422(tmp_path: Path, body: dict[str, Any]) -> None:
    assert (await _post(tmp_path, body)).status_code == 422


async def test_unequal_lengths_are_reported_on_the_series_and_not_failed(tmp_path: Path) -> None:
    body = {"series": [{"name": "x", "t": [0, 1, 2], "y": [0, 1]}]}

    response = await _post(tmp_path, body)

    assert response.status_code == 200
    assert "same length" in response.json()["results"][0]["error"]


async def test_too_many_series_are_refused(tmp_path: Path) -> None:
    series = [{"name": f"s{i}", "t": [0, 1, 2], "y": [0, 1, 2]} for i in range(MAX_METRIC_SERIES + 1)]

    assert (await _post(tmp_path, {"series": series})).status_code == 422


async def test_a_series_longer_than_the_limit_is_refused(tmp_path: Path) -> None:
    n = MAX_METRIC_SAMPLES + 1
    body = {"series": [{"name": "long", "t": [0.0] * n, "y": [0.0] * n}]}

    assert (await _post(tmp_path, body)).status_code == 422


def test_the_route_is_tagged_for_the_gui_parity_ledger(tmp_path: Path) -> None:
    operation = make_app(workspace=tmp_path, static_override=tmp_path).openapi()["paths"][
        "/api/response-metrics"
    ]["post"]

    assert operation["x-tensa-gui-location"] == "analysis-panel"
    assert operation["operationId"] == "computeResponseMetrics"
