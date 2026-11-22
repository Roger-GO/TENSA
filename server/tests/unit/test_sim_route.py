"""Route tests of ``POST /sessions/{id}/sim`` with a stubbed manager."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.errors import NoCaseLoadedError, SiennaError
from tensa.core.session import SessionExpiredError, WorkerError
from tensa.engines.sienna.dispatch import NO_COST_DATA_MESSAGE
from tensa.engines.sienna.sim import SimRequestError

pytestmark = pytest.mark.unit


def _payload() -> dict[str, Any]:
    """A recorded worker payload: the stages keyed by the PowerSystems name,
    the keys lookup covering the two generators."""
    return {
        "status": "completed",
        "network_model": "copper_plate",
        "base_mva": 100.0,
        "interval_minutes": 60,
        "stages": [
            {
                "name": "DA",
                "kind": "uc",
                "resolution_minutes": 60,
                "steps": 24,
                "horizon_hours": 24,
                "objective": 29600.0,
                "commitment": {
                    "gen-1": {"bus": 1, "id": "1", "values": [0.0, 1.0, 1.0] + [0.0] * 21},
                    "gen-2": {"bus": 2, "id": "1", "values": [1.0] * 24},
                },
                "dispatch": {
                    "gen-1": {"bus": 1, "id": "1", "values": [0.0, 120.0, 150.0] + [0.0] * 21},
                    "gen-2": {"bus": 2, "id": "1", "values": [40.0, 0.0, 0.0] + [40.0] * 21},
                },
            },
            {
                "name": "RT",
                "kind": "dispatch",
                "resolution_minutes": 15,
                "steps": 96,
                "horizon_hours": 1,
                "objective": 29100.0,
                "commitment": {},
                "dispatch": {
                    "gen-1": {"bus": 1, "id": "1", "values": [0.0] * 96},
                    "gen-2": {"bus": 2, "id": "1", "values": [40.0] * 96},
                },
            },
        ],
        "slacks": [],
        "store_dir": "sim-20260101-000000",
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
    monkeypatch.setattr("tensa.api.routes.sim.SessionManager", _StubManager)
    app = make_app(
        workspace=tmp_path,
        static_override=tmp_path,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver"}),
    )
    app.state.session_manager = manager
    return TestClient(app, raise_server_exceptions=False)


def _worker_error(exc: Exception) -> WorkerError:
    return WorkerError(type(exc).__name__, str(exc))


def _body() -> dict[str, Any]:
    return {"load_profile": [0.5] * 96, "network_model": "copper_plate"}


def test_sim_200_keyed_by_neutral_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["engine"] == "sienna"
    assert body["interval_minutes"] == 60
    assert manager.calls == [("s1", "run_sim", _body())]
    da, rt = body["stages"]
    # The response model keys the generators by their neutral key, with the
    # idx inside each entry and the id from the key.
    assert set(da["commitment"]) == {"gen:1-1", "gen:2-1"}
    assert da["commitment"]["gen:1-1"]["idx"] == "gen-1"
    assert da["commitment"]["gen:1-1"]["id"] == "1"
    assert da["commitment"]["gen:1-1"]["values"][:4] == [0.0, 1.0, 1.0, 0.0]
    assert da["dispatch"]["gen:2-1"]["values"][:4] == [40.0, 0.0, 0.0, 40.0]
    assert rt["commitment"] == {}
    assert rt["dispatch"]["gen:1-1"]["values"] == [0.0] * 96
    assert da["objective"] == 29600.0
    assert rt["objective"] == 29100.0
    # The store folder is the session's own and is not part of the answer.
    assert "store_dir" not in body


def test_sim_an_unkeyed_generator_keeps_its_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _payload()
    payload["stages"][1]["dispatch"]["gen-9"] = {
        "bus": 9, "id": "9", "values": [1.0] * 96,
    }
    client = _client(tmp_path, monkeypatch, _StubManager(answer=payload))
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 200, response.text
    dispatch = response.json()["stages"][1]["dispatch"]
    assert dispatch["gen-9"] == {"bus": 9, "id": "9", "idx": "gen-9", "values": [1.0] * 96}


def test_sim_rejects_a_short_profile_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/sim", json={"load_profile": [1.0] * 95})
    assert response.status_code == 422
    assert manager.calls == []


def test_sim_rejects_an_extra_field_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/sim", json={**_body(), "stages": 2})
    assert response.status_code == 422
    assert manager.calls == []


def test_sim_rejects_a_bad_network_model_422(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/sim", json={"load_profile": [1.0] * 96, "network_model": "ac"})
    assert response.status_code == 422
    assert manager.calls == []


def test_no_cost_data_maps_to_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The verbatim-message contract the route and the Julia module share: a
    SiennaError whose detail is exactly NO_COST_DATA_MESSAGE is a 422 with
    that detail. The two copies are pinned together by this test, which sends
    this exact text through the worker."""
    error = _worker_error(SiennaError(NO_COST_DATA_MESSAGE))
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 422
    assert response.json()["detail"] == NO_COST_DATA_MESSAGE


def test_andes_session_is_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = WorkerError(
        "EngineUnsupportedError",
        "'run_sim' is not available with the andes engine; "
        "engines that have it: sienna",
    )
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 409
    assert "sienna" in response.json()["detail"]


def test_sim_request_error_is_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = _worker_error(
        SimRequestError("load_profile is all zero; the day has no load to serve")
    )
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 422
    assert response.json()["detail"] == "load_profile is all zero; the day has no load to serve"


def test_unknown_session_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=SessionExpiredError("session s1 is not open")),
    )
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 404


def test_no_case_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=_worker_error(NoCaseLoadedError("no case has been loaded"))),
    )
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 409


def test_a_solve_failure_is_502(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = _worker_error(SiennaError("the simulation did not solve: NUMERICAL_ERROR"))
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/sim", json=_body())
    assert response.status_code == 502
    assert response.json()["detail"] == "the simulation did not solve: NUMERICAL_ERROR"
