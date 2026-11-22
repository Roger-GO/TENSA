"""``POST /compare``: the route over ``tensa.engines.compare``.

The comparison itself is checked in ``test_engines_compare.py``. These cover
what the route adds: the wire shape, the validation of both documents, the
limits on a request, and the error envelopes.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.api.routes.compare import MAX_COMPARE_BYTES
from tensa.api.schemas import MAX_COMPARE_SERIES

pytestmark = pytest.mark.unit


async def _post(tmp_path: Path, body: dict[str, Any]) -> httpx.Response:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        return await client.post("/api/compare", json=body)


def _doc(
    series: list[dict[str, Any]],
    tables: dict[str, Any] | None = None,
    engine: str = "andes",
) -> dict[str, Any]:
    return {
        "tensa_results": 1,
        "engine": {"name": engine, "versions": {"andes": "2.0.0"}},
        "study": None,
        "status": "completed",
        "series": series,
        "tables": {} if tables is None else tables,
    }


def _series(key: str, y: list[float], quantity: str = "voltage", unit: str = "pu") -> dict[str, Any]:
    return {
        "quantity": quantity,
        "of": key,
        "unit": unit,
        "t": [float(i) for i in range(len(y))],
        "y": y,
    }


async def test_two_documents_come_back_compared(tmp_path: Path) -> None:
    # reference y = x on [0, 1, 2]; comparison y = x + 0.1: d is 0.1 everywhere,
    # so max and RMS are both 0.1 and the swing of the reference is 2.0.
    body = {
        "reference": _doc([_series("bus:1", [0.0, 1.0, 2.0])]),
        "comparison": _doc([_series("bus:1", [0.1, 1.1, 2.1])], engine="sienna"),
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    out = response.json()
    assert out["engine_reference"] == {"name": "andes", "versions": {"andes": "2.0.0"}}
    assert out["engine_comparison"]["name"] == "sienna"
    assert out["operating_point_differs"] is False
    assert out["power_flow"] is None
    (row,) = out["series"]
    assert row["max_diff"] == pytest.approx(0.1)
    assert row["rms_diff"] == pytest.approx(0.1)
    assert row["swing_ref"] == pytest.approx(2.0)
    assert row["within_tolerance"] is False  # 0.1 > 1e-4, the voltage default
    assert row["tolerance"] == pytest.approx(1e-4)
    assert out["unmatched_series_reference"] == []
    assert out["unmatched_series_comparison"] == []
    assert out["errors"] == []


async def test_power_flow_is_compared_first_and_flags_the_operating_point(tmp_path: Path) -> None:
    tables_ref = {
        "pflow": {
            "converged": True,
            "buses": [{"key": "bus:1", "v_pu": 1.0, "angle_rad": 0.0}],
            "branches": [],
            "generators": [],
            "loads": [],
        }
    }
    tables_new = {
        "pflow": {
            "converged": True,
            "buses": [{"key": "bus:1", "v_pu": 1.5, "angle_rad": 0.0}],
            "branches": [],
            "generators": [],
            "loads": [],
        }
    }
    body = {
        "reference": _doc([_series("bus:1", [1.0, 1.0])], tables_ref),
        "comparison": _doc([_series("bus:1", [1.0, 1.0])], tables_new),
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    out = response.json()
    keys = list(out.keys())
    assert keys.index("power_flow") < keys.index("series") < keys.index("eigenvalues")
    assert out["operating_point_differs"] is True
    assert out["power_flow"]["converged_reference"] is True
    (row,) = [r for r in out["power_flow"]["rows"] if r["quantity"] == "voltage"]
    assert row["diff"] == pytest.approx(0.5)
    assert row["within_tolerance"] is False


async def test_a_document_whose_time_runs_backwards_is_refused_naming_its_side(
    tmp_path: Path,
) -> None:
    """Both documents are validated before anything is compared: one that is
    not a sound document is a 422 that says which side and what, and nothing
    of it is compared."""
    bad = _series("bus:1", [1.0, 1.0, 1.0])
    bad["t"] = [0.0, 2.0, 1.0]
    body = {
        "reference": _doc([bad, _series("bus:2", [1.0, 1.0])]),
        "comparison": _doc([_series("bus:1", [1.0, 1.0]), _series("bus:2", [1.0, 1.0])]),
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == "reference: series 0: t is not non-decreasing at index 2"


async def test_a_unit_other_than_the_catalogues_is_refused_naming_its_side(
    tmp_path: Path,
) -> None:
    body = {
        "reference": _doc([_series("bus:1", [1.0, 1.0])]),
        "comparison": _doc([_series("bus:1", [1.0, 1.0], unit="kV")]),
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "comparison: series 0: quantity 'voltage' is in 'pu', not 'kV'"
    )


async def test_an_unknown_field_is_a_422(tmp_path: Path) -> None:
    body = {
        "reference": _doc([]),
        "comparison": _doc([]),
        "archive_ids": [1, 2],
    }

    assert (await _post(tmp_path, body)).status_code == 422


async def test_a_document_with_an_unknown_field_is_a_422(tmp_path: Path) -> None:
    doc = _doc([])
    doc["engine"]["extra"] = True
    assert (await _post(tmp_path, {"reference": doc, "comparison": _doc([])})).status_code == 422


async def test_too_many_series_are_refused(tmp_path: Path) -> None:
    series = [_series(f"bus:{i}", [1.0, 1.0]) for i in range(MAX_COMPARE_SERIES + 1)]

    assert (await _post(tmp_path, {"reference": _doc(series), "comparison": _doc([])})).status_code == 422


async def test_the_sample_total_is_enforced_across_both_documents(tmp_path: Path) -> None:
    # Six series of 200_000 samples per document: each is within the per-series
    # cap, and 2 * 6 * 200_000 = 2_400_000 is over the total of 2_000_000.
    big = [
        {"quantity": "voltage", "of": f"bus:{i}", "unit": "pu", "t": [0.0] * 200_000, "y": [0.0] * 200_000}
        for i in range(6)
    ]
    body = {"reference": _doc(big), "comparison": _doc(big)}

    response = await _post(tmp_path, body)

    assert response.status_code == 422
    assert "2000000" in response.json()["detail"]


async def test_a_body_over_the_cap_is_a_413(tmp_path: Path) -> None:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        response = await client.post(
            "/api/compare",
            content=b" " * (MAX_COMPARE_BYTES + 1),
            headers={"Content-Type": "application/json"},
        )

    assert response.status_code == 413
    assert response.json()["detail"] == (
        f"the body of a compare request is larger than {MAX_COMPARE_BYTES // (1024 * 1024)} MiB"
    )


async def test_eigenvalues_end_to_end(tmp_path: Path) -> None:
    # One matched pair (the oscillatory mode) and one unmatched mode per side.
    eig_ref = {
        "eig": {
            "eigenvalues": [
                {"re": -0.5, "im": 4.0, "frequency_hz": 4.0 / (2.0 * math.pi), "damping_ratio": 0.124},
                {"re": -0.5, "im": -4.0, "frequency_hz": -4.0 / (2.0 * math.pi), "damping_ratio": 0.124},
                {"re": -9.0, "im": 0.0, "frequency_hz": 0.0, "damping_ratio": 1.0},
            ]
        }
    }
    eig_new = {
        "eig": {
            "eigenvalues": [
                {"re": -0.5, "im": 4.01, "frequency_hz": 4.01 / (2.0 * math.pi), "damping_ratio": 0.123},
                {"re": -0.5, "im": -4.01, "frequency_hz": -4.01 / (2.0 * math.pi), "damping_ratio": 0.123},
                {"re": -8.0, "im": 0.0, "frequency_hz": 0.0, "damping_ratio": 1.0},
            ]
        }
    }
    body = {"reference": _doc([], eig_ref), "comparison": _doc([], eig_new)}

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    out = response.json()
    assert len(out["eigenvalues"]) == 1
    pair = out["eigenvalues"][0]
    assert pair["index_ref"] == 0
    assert pair["index_new"] == 0
    assert pair["frequency_hz_ref"] == pytest.approx(4.0 / (2.0 * math.pi))
    assert pair["frequency_hz_new"] == pytest.approx(4.01 / (2.0 * math.pi))
    assert pair["damping_ratio_ref"] == pytest.approx(0.124)
    assert pair["damping_ratio_new"] == pytest.approx(0.123)
    # A conjugate pair counts once, so only the far-apart real mode is listed.
    assert out["unmatched_eigenvalues_reference"] == [2]
    assert out["unmatched_eigenvalues_comparison"] == [2]


async def test_a_document_with_a_problem_is_a_422_naming_the_side(tmp_path: Path) -> None:
    # The reference's series 0 has t and y of different lengths; the comparison
    # is sound. Nothing is compared.
    bad = _series("bus:1", [1.0, 1.0])
    bad["t"] = [0.0, 1.0, 2.0]
    body = {"reference": _doc([bad]), "comparison": _doc([_series("bus:1", [1.0, 1.0])])}

    response = await _post(tmp_path, body)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "reference: series 0: t has 3 values, y has 2" in detail
    assert "comparison:" not in detail


async def test_a_problem_on_the_comparison_side_is_named(tmp_path: Path) -> None:
    bad = _series("bus:1", [1.0, 1.0], unit="kV")
    body = {"reference": _doc([_series("bus:1", [1.0, 1.0])]), "comparison": _doc([bad])}

    response = await _post(tmp_path, body)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "comparison: series 0: quantity 'voltage' is in 'pu', not 'kV'" in detail
    assert "reference:" not in detail


async def test_a_document_compared_with_itself_has_zero_differences(tmp_path: Path) -> None:
    tables = {
        "pflow": {
            "converged": True,
            "buses": [{"key": "bus:1", "v_pu": 1.03, "angle_rad": 0.2}],
            "branches": [
                {
                    "key": "branch:1-2-1",
                    "p_from_mw": 50.0,
                    "q_from_mvar": 5.0,
                    "p_to_mw": -49.0,
                    "q_to_mvar": -4.0,
                }
            ],
            "generators": [{"key": "gen:1-1", "p_mw": 100.0, "q_mvar": 20.0}],
            "loads": [{"key": "load:2-1", "p_mw": 60.0, "q_mvar": 10.0}],
        },
        "eig": {
            "eigenvalues": [
                {"re": -0.5, "im": 4.0, "frequency_hz": 4.0 / (2.0 * math.pi), "damping_ratio": 0.124},
                {"re": -0.5, "im": -4.0, "frequency_hz": -4.0 / (2.0 * math.pi), "damping_ratio": 0.124},
            ]
        },
    }
    doc = _doc(
        [
            _series("bus:1", [1.0, 0.9, 1.0, 0.95]),
            _series("gen:1-1", [1.0, 1.001, 0.999], quantity="rotor_speed"),
        ],
        tables,
    )
    body = {"reference": doc, "comparison": doc}

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    out = response.json()
    assert out["operating_point_differs"] is False
    for row in out["power_flow"]["rows"]:
        assert row["diff"] == 0.0
        assert row["within_tolerance"] is True
    for row in out["series"]:
        assert row["max_diff"] == 0.0
        assert row["rms_diff"] == 0.0
        assert row["within_tolerance"] is True
    for pair in out["eigenvalues"]:
        assert pair["distance"] == 0.0
        assert pair["within_tolerance"] is True
    assert out["errors"] == []


async def test_a_power_flow_difference_outside_tolerance_sets_the_flag(tmp_path: Path) -> None:
    tables_ref = {
        "pflow": {
            "converged": True,
            "buses": [{"key": "bus:1", "v_pu": 1.0, "angle_rad": 0.0}],
            "branches": [],
            "generators": [],
            "loads": [],
        }
    }
    tables_new = {
        "pflow": {
            "converged": True,
            "buses": [{"key": "bus:1", "v_pu": 1.001, "angle_rad": 0.0}],
            "branches": [],
            "generators": [],
            "loads": [],
        }
    }
    body = {"reference": _doc([], tables_ref), "comparison": _doc([], tables_new)}

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    out = response.json()
    # 0.001 pu is outside the 1e-4 voltage default.
    assert out["operating_point_differs"] is True
    (row,) = [r for r in out["power_flow"]["rows"] if r["quantity"] == "voltage"]
    assert row["diff"] == pytest.approx(0.001)
    assert row["within_tolerance"] is False


def test_the_route_is_tagged_for_the_gui_parity_ledger(tmp_path: Path) -> None:
    operation = make_app(workspace=tmp_path, static_override=tmp_path).openapi()["paths"][
        "/api/compare"
    ]["post"]

    assert operation["x-tensa-gui-location"] == "none"
    assert "x-tensa-parity-deferred" in operation
    assert operation["operationId"] == "compareResults"
