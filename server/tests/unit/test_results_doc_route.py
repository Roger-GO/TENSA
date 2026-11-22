"""``POST /results/convert``: the route over the results document builders.

No session, no worker, no Julia. The builders themselves are checked in
``test_engines_results_doc.py``; these cover the wire shape and the 422s.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app

pytestmark = pytest.mark.unit


async def _post(tmp_path: Path, body: dict[str, Any]) -> httpx.Response:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as client:
        return await client.post("/api/results/convert", json=body)


def _pflow_body() -> dict[str, Any]:
    return {
        "kind": "pflow",
        "engine": "andes",
        "result": {
            "converged": True,
            "iterations": 4,
            "mismatch": 1e-8,
            "bus_voltages": {"1": 1.03},
            "bus_angles": {"1": 0.0},
            "line_flows": {},
            "generator_outputs": {},
            "load_consumption": {},
            "keys": {"bus": {"1": "bus:1"}},
        },
    }


async def test_convert_pflow(tmp_path: Path) -> None:
    response = await _post(tmp_path, _pflow_body())

    assert response.status_code == 200, response.text
    answer = response.json()
    doc = answer["document"]
    assert doc["tensa_results"] == 1
    assert doc["status"] == "completed"
    assert doc["engine"] == {"name": "andes", "versions": {}}
    assert doc["study"] is None
    assert doc["tables"]["pflow"]["converged"] is True
    (bus,) = doc["tables"]["pflow"]["buses"]
    assert bus == {"key": "bus:1", "v_pu": 1.03, "angle_rad": 0.0}
    assert answer["skipped"] == []
    assert answer["notes"] == []


async def test_convert_pflow_not_converged_422(tmp_path: Path) -> None:
    body = _pflow_body()
    body["result"]["converged"] = False

    response = await _post(tmp_path, body)

    assert response.status_code == 422
    assert (
        response.json()["detail"]
        == "power flow did not converge; a non-converged run has no results document"
    )


async def test_convert_pflow_malformed_result_422(tmp_path: Path) -> None:
    body = _pflow_body()
    del body["result"]["converged"]

    assert (await _post(tmp_path, body)).status_code == 422


async def test_convert_tds_andes(tmp_path: Path) -> None:
    body = {
        "kind": "tds",
        "engine": "andes",
        "result": {
            "t": [0.0, 0.1],
            "variables": [{"name": "Bus_7_v", "values": [1.0, 0.9]}],
            "truncated": False,
        },
        "keys": [{"key": "bus:7", "bucket": "bus", "model": "Bus", "idx": 7, "source": "file"}],
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    answer = response.json()
    (series,) = answer["document"]["series"]
    assert series["quantity"] == "voltage"
    assert series["of"] == "bus:7"
    assert series["unit"] == "pu"
    assert series["t"] == [0.0, 0.1]
    assert series["y"] == [1.0, 0.9]
    assert answer["skipped"] == []


async def test_convert_tds_sienna_ignores_keys(tmp_path: Path) -> None:
    body = {
        "kind": "tds",
        "engine": "sienna",
        "result": {
            "t": [0.0],
            "variables": [{"name": "voltage|bus:7", "values": [1.0]}],
            "truncated": False,
        },
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    (series,) = response.json()["document"]["series"]
    assert series["quantity"] == "voltage"
    assert series["of"] == "bus:7"


async def test_convert_tds_dae_vars_are_skipped(tmp_path: Path) -> None:
    body = {
        "kind": "tds",
        "engine": "andes",
        "result": {
            "t": [0.0],
            "variables": [{"name": "omega GENROU 1", "values": [1.0]}],
            "truncated": False,
        },
        "keys": [{"key": "gen:1-1", "bucket": "generator", "model": "PV", "idx": 1, "source": "file"}],
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["document"]["series"] == []
    (skipped,) = answer["skipped"]
    assert skipped["name"] == "omega GENROU 1"
    assert skipped["reason"] == "raw engine state; not part of the neutral document yet"


async def test_convert_tds_truncated_is_a_note(tmp_path: Path) -> None:
    body = {
        "kind": "tds",
        "engine": "andes",
        "result": {
            "t": [0.0],
            "variables": [{"name": "Bus_7_v", "values": [1.0]}],
            "truncated": True,
        },
        "keys": [{"key": "bus:7", "bucket": "bus", "model": "Bus", "idx": 7, "source": "file"}],
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["document"]["status"] == "completed"
    assert len(answer["document"]["series"]) == 1
    assert len(answer["notes"]) == 1
    assert "truncated" in answer["notes"][0]


async def test_convert_eig(tmp_path: Path) -> None:
    body = {
        "kind": "eig",
        "engine": "andes",
        "result": {
            "eigenvalues": [{"real": -0.5, "imag": 6.0}, {"real": 0.0, "imag": 0.0}],
            "damping_ratios": [0.083, 1.0],
            "frequencies_hz": [0.955, 0.0],
            "mode_count": 2,
            "state_count": 2,
            "state_names": ["omega GENROU 1", "delta GENROU 1"],
            "tds_initialized": True,
        },
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    modes = response.json()["document"]["tables"]["eig"]["eigenvalues"]
    assert len(modes) == 2
    assert modes[0] == {"re": -0.5, "im": 6.0, "frequency_hz": 0.955, "damping_ratio": 0.083}
    assert modes[1]["damping_ratio"] == 1.0
    assert modes[1]["re"] == 0.0


async def test_convert_unknown_kind_422(tmp_path: Path) -> None:
    body = _pflow_body()
    body["kind"] = "cpf"

    assert (await _post(tmp_path, body)).status_code == 422


async def test_convert_extra_field_422(tmp_path: Path) -> None:
    body = _pflow_body()
    body["unexpected"] = 1

    assert (await _post(tmp_path, body)).status_code == 422


async def test_convert_sienna_bad_name_422(tmp_path: Path) -> None:
    body = {
        "kind": "tds",
        "engine": "sienna",
        "result": {
            "t": [0.0],
            "variables": [{"name": "rotor_speed", "values": [1.0]}],
            "truncated": False,
        },
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 422
    assert "is not neutral" in response.json()["detail"]


def test_the_route_is_tagged_for_the_gui_parity_ledger(tmp_path: Path) -> None:
    operation = make_app(workspace=tmp_path, static_override=tmp_path).openapi()["paths"][
        "/api/results/convert"
    ]["post"]

    assert operation["x-tensa-gui-location"] == "none"
    assert "x-tensa-parity-deferred" in operation
    assert operation["operationId"] == "convertResult"

async def test_convert_tds_andes_machine_columns_map_through_the_machine_entry(
    tmp_path: Path,
) -> None:
    """The rotor speed and angle and the electrical power of a machine are the
    series a comparison is about: they map through the machine's own entry of
    the session's keys, under its unit's key."""
    body = {
        "kind": "tds",
        "engine": "andes",
        "result": {
            "t": [0.0, 0.1],
            "variables": [
                {"name": "Gen_1_omega", "values": [1.0, 1.001]},
                {"name": "Gen_1_delta", "values": [0.5, 0.52]},
                {"name": "Gen_1_Pe", "values": [700.0, 690.0]},
            ],
            "truncated": False,
        },
        "keys": [
            {"key": "gen:1-1", "bucket": "generator", "model": "PV", "idx": 1, "source": "file"},
            {"key": "gen:1-1/machine", "bucket": "dynamic", "model": "GENROU", "idx": 1, "source": "file"},
        ],
    }

    response = await _post(tmp_path, body)

    assert response.status_code == 200, response.text
    answer = response.json()
    assert answer["skipped"] == []
    got = {(s["quantity"], s["of"], s["unit"]) for s in answer["document"]["series"]}
    assert got == {
        ("rotor_speed", "gen:1-1", "pu"),
        ("rotor_angle", "gen:1-1", "rad"),
        ("p", "gen:1-1", "MW"),
    }
