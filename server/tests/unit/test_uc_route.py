"""Route tests of ``POST /sessions/{id}/uc`` with a stubbed manager."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.session import SessionExpiredError, WorkerError
from tensa.engines.sienna.dispatch import NO_COST_DATA_MESSAGE

pytestmark = pytest.mark.unit


def _payload() -> dict[str, Any]:
    """The recorded worker payload of the hand-worked optimum: A (gen-1) on
    in hours 2 and 3, one start-up of 500 $; energy 5100 $, total 5600 $. The
    route test's series is the unit test's (0.5, 0.7, 1.0, 0.6); the payload
    is what the bridge answered, and the route only re-keys it."""
    return {
        "status": "completed",
        "network_model": "copper_plate",
        "horizon_h": 4,
        "resolution_min": 60,
        "periods": [
            "2026-01-01T01:00:00",
            "2026-01-01T02:00:00",
            "2026-01-01T03:00:00",
            "2026-01-01T04:00:00",
        ],
        "base_mva": 100.0,
        "objective": 5600.0,
        "objective_check": 5600.0,
        "cost": {"energy": 5100.0, "startup": 500.0, "fixed": 0.0, "total": 5600.0},
        "total_load_mw": [40.0, 120.0, 150.0, 40.0],
        "generators": {
            "gen-1": {
                "bus": 1,
                "id": "1",
                "on": [False, True, True, False],
                "p_mw": [0.0, 120.0, 150.0, 0.0],
                "energy": 2700.0,
                "startup": 500.0,
                "fixed": 0.0,
            },
            "gen-2": {
                "bus": 2,
                "id": "1",
                "on": [True, False, False, True],
                "p_mw": [40.0, 0.0, 0.0, 40.0],
                "energy": 2400.0,
                "startup": 0.0,
                "fixed": 0.0,
            },
        },
        "slacks": [],
        "parameters": ["ActivePowerTimeSeriesParameter__PowerLoad"],
        "expressions": ["ProductionCostExpression__ThermalStandard"],
        "keys": {"generator": {"gen-1": "gen:1-1", "gen-2": "gen:2-1"}},
        "notes": [],
    }


class _StubManager:
    """Stands in for ``SessionManager.invoke`` with a recorded answer or error."""

    def __init__(self, answer: Any = None, error: Exception | None = None) -> None:
        self.answer = answer
        self.error = error
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    async def invoke(self, session_id: str, op: str, args: dict[str, Any]) -> Any:
        self.calls.append((session_id, op, args))
        if self.error is not None:
            raise self.error
        return self.answer


def _client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, manager: _StubManager) -> TestClient:
    monkeypatch.setattr("tensa.api.routes.uc.SessionManager", _StubManager)
    app = make_app(
        workspace=tmp_path,
        static_override=tmp_path,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver"}),
    )
    app.state.session_manager = manager
    return TestClient(app, raise_server_exceptions=False)


def _body() -> dict[str, Any]:
    return {
        "network_model": "copper_plate",
        "horizon_h": 4,
        "resolution_min": 60,
        "series": [0.5, 0.7, 1.0, 0.6],
    }


def test_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/uc", json=_body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["engine"] == "sienna"
    assert set(body["generators"]) == {"gen:1-1", "gen:2-1"}
    assert body["generators"]["gen:1-1"]["idx"] == "gen-1"
    assert body["generators"]["gen:1-1"]["id"] == "1"
    assert body["generators"]["gen:1-1"]["on"] == [False, True, True, False]
    # The hand-worked optimum: energy 10*270 + 30*80 = 5100 $, one start-up
    # of 500 $, fixed 0 $, total 5600 $.
    assert body["cost"] == {
        "energy": 5100.0,
        "startup": 500.0,
        "fixed": 0.0,
        "total": 5600.0,
    }
    assert manager.calls == [
        (
            "s1",
            "run_uc",
            {
                "network_model": "copper_plate",
                "horizon_h": 4,
                "resolution_min": 60,
                "series": [0.5, 0.7, 1.0, 0.6],
                "overrides": {},
            },
        )
    ]


def test_no_case_is_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = WorkerError("NoCaseLoadedError", "no case has been loaded")
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/uc", json=_body())
    assert response.status_code == 409


def test_request_error_is_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = WorkerError("UcRequestError", "resolution_min must be 15, 30 or 60, got 45")
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/uc", json=_body())
    assert response.status_code == 422
    assert response.json()["detail"] == "resolution_min must be 15, 30 or 60, got 45"


def test_no_cost_data_is_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The verbatim-message contract the route and the Julia module share: a
    SiennaError whose detail is exactly NO_COST_DATA_MESSAGE is a 422 with
    that detail, pinning the Python and Julia copies of the string together."""
    error = WorkerError("SiennaError", NO_COST_DATA_MESSAGE)
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/uc", json=_body())
    assert response.status_code == 422
    assert response.json()["detail"] == NO_COST_DATA_MESSAGE


def test_other_sienna_error_is_502(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = WorkerError("SiennaError", "unit commitment did not solve: kHighs")
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/uc", json=_body())
    assert response.status_code == 502
    assert "did not solve" in response.json()["detail"]


def test_extra_field_is_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/uc", json={**_body(), "solver": "HiGHS"})
    assert response.status_code == 422
    assert manager.calls == []


def test_overrides_none_fields_dropped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    body = {
        **_body(),
        "overrides": {"gen:1-1": {"startup_cost": 100.0, "min_up_h": None}},
    }
    response = client.post("/api/sessions/s1/uc", json=body)
    assert response.status_code == 200, response.text
    assert manager.calls[0][2]["overrides"] == {"gen:1-1": {"startup_cost": 100.0}}


def test_unknown_session_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=SessionExpiredError("session s1 is not open")),
    )
    response = client.post("/api/sessions/s1/uc", json=_body())
    assert response.status_code == 404
