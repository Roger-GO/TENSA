"""Route tests of ``POST /sessions/{id}/dispatch`` with a stubbed manager."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.errors import NoCaseLoadedError, SiennaError
from tensa.core.session import SessionExpiredError, WorkerError
from tensa.engines.sienna.dispatch import NO_COST_DATA_MESSAGE, DispatchRequestError

pytestmark = pytest.mark.unit


def _payload() -> dict[str, Any]:
    return {
        "status": "completed",
        "network_model": "copper_plate",
        "objective_per_h": 1500.0,
        "objective_check_per_h": 1500.0,
        "base_mva": 100.0,
        "total_load_mw": 150.0,
        "total_dispatch_mw": 150.0,
        "generators": {
            "generator-1-1": {"p_mw": 150.0, "bus": 1, "id": "1"},
            "generator-2-1": {"p_mw": 0.0, "bus": 2, "id": "1"},
        },
        "duals": [],
        "slacks": [],
        "parameters": ["ActivePowerTimeSeriesParameter__PowerLoad"],
        "expressions": [
            "ProductionCostExpression__ThermalStandard",
            "ActivePowerBalance__System",
        ],
        "keys": {"generator": {"generator-1-1": "gen:1-1", "generator-2-1": "gen:2-1"}},
        "notes": [],
    }


def _ac_payload() -> dict[str, Any]:
    """A recorded AC worker payload: buses and branches keyed by idx, the
    keys lookup covering the three kinds, and the total losses."""
    payload = _payload()
    payload["network_model"] = "ac"
    payload["generators"] = {
        "gen-1": {"p_mw": 102.289, "bus": 1, "id": "1", "q_mvar": 41.445},
    }
    payload["buses"] = {
        "bus-1": {"v_pu": 1.0, "bus": 1, "angle_rad": 0.0},
        "bus-2": {"v_pu": 0.9759, "bus": 2, "angle_rad": -0.1},
    }
    payload["branches"] = {
        "branch-1-2-1": {
            "from_bus": 1,
            "to_bus": 2,
            "ckt": "1",
            "p_from_mw": 102.289,
            "q_from_mvar": 41.445,
            "p_to_mw": -100.0,
            "q_to_mvar": -30.0,
            "losses_mw": 2.289,
            "losses_mvar": 11.445,
        },
    }
    payload["total_losses_mw"] = 2.289
    payload["keys"] = {
        "generator": {"gen-1": "gen:1-1"},
        "bus": {"bus-1": "bus:1", "bus-2": "bus:2"},
        "branch": {"branch-1-2-1": "branch:1-2-1"},
    }
    return payload


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
    monkeypatch.setattr("tensa.api.routes.dispatch.SessionManager", _StubManager)
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


def test_dispatch_200_keyed_by_neutral_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "copper_plate"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["engine"] == "sienna"
    assert body["objective_per_h"] == 1500.0
    assert body["objective_check_per_h"] == 1500.0
    # The response model keys the generators by their neutral key, with the
    # idx inside each entry.
    assert set(body["generators"]) == {"gen:1-1", "gen:2-1"}
    assert body["generators"]["gen:1-1"] == {
        "p_mw": 150.0,
        "bus": 1,
        "id": "1",
        "idx": "generator-1-1",
        "q_mvar": None,
    }
    assert manager.calls == [
        ("s1", "run_dispatch", {"network_model": "copper_plate", "duals": False})
    ]


def test_dispatch_id_is_the_keys_and_an_unkeyed_generator_keeps_its_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A MATPOWER generator is named after its row (gen-3), and the id the
    engine reads off the name is the row; the answer's id is the key's."""
    payload = _payload()
    payload["generators"] = {
        "gen-3": {"p_mw": 150.0, "bus": 2, "id": "3"},
        "gen-9": {"p_mw": 0.0, "bus": 4, "id": "9"},
    }
    payload["keys"] = {"generator": {"gen-3": "gen:2-1"}}
    client = _client(tmp_path, monkeypatch, _StubManager(answer=payload))
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "dc"})
    assert response.status_code == 200, response.text
    generators = response.json()["generators"]
    assert generators["gen:2-1"] == {
        "p_mw": 150.0, "bus": 2, "id": "1", "idx": "gen-3", "q_mvar": None,
    }
    assert generators["gen-9"] == {
        "p_mw": 0.0, "bus": 4, "id": "9", "idx": "gen-9", "q_mvar": None,
    }


def test_dispatch_duals_flag_passed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post(
        "/api/sessions/s1/dispatch", json={"network_model": "dc", "duals": True}
    )
    assert response.status_code == 200
    assert manager.calls == [("s1", "run_dispatch", {"network_model": "dc", "duals": True})]


def test_ac_accepted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _StubManager(answer=_ac_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "ac"})
    assert response.status_code == 200, response.text
    assert manager.calls == [("s1", "run_dispatch", {"network_model": "ac", "duals": False})]


def test_ac_answer_rekeyed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, _StubManager(answer=_ac_payload()))
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "ac"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body["buses"]) == {"bus:1", "bus:2"}
    assert body["buses"]["bus:2"]["idx"] == "bus-2"
    assert body["buses"]["bus:2"]["v_pu"] == 0.9759
    assert set(body["branches"]) == {"branch:1-2-1"}
    branch = body["branches"]["branch:1-2-1"]
    assert branch["idx"] == "branch-1-2-1"
    assert branch["ckt"] == "1"
    assert branch["losses_mw"] == 2.289
    assert body["generators"]["gen:1-1"]["q_mvar"] == 41.445
    assert body["total_losses_mw"] == 2.289


def test_andes_session_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = WorkerError(
        "EngineUnsupportedError",
        "'run_dispatch' is not available with the andes engine; "
        "engines that have it: sienna",
    )
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "copper_plate"})
    assert response.status_code == 409
    assert "sienna" in response.json()["detail"]


def test_no_cost_data_422_verbatim(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = WorkerError("SiennaError", NO_COST_DATA_MESSAGE)
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "copper_plate"})
    assert response.status_code == 422
    assert response.json()["detail"] == NO_COST_DATA_MESSAGE


def test_no_cost_data_message_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The verbatim-message contract the route and the Julia module share: a
    SiennaError whose detail is exactly NO_COST_DATA_MESSAGE is a 422 with
    that detail."""
    error = _worker_error(SiennaError(NO_COST_DATA_MESSAGE))
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "ac"})
    assert response.status_code == 422
    assert response.json()["detail"] == NO_COST_DATA_MESSAGE


def test_ac_solve_failure_502(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = _worker_error(SiennaError("economic dispatch did not solve: NUMERICAL_ERROR"))
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "ac"})
    assert response.status_code == 502
    assert response.json()["detail"] == "economic dispatch did not solve: NUMERICAL_ERROR"


def test_another_sienna_error_uses_the_shared_mapping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    error = WorkerError("SiennaError", "economic dispatch did not solve: kHighsModelStatusError")
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "copper_plate"})
    assert response.status_code in (500, 502)
    assert "did not solve" in response.json()["detail"]


def test_unknown_network_model_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "sdp"})
    assert response.status_code == 422
    assert manager.calls == []


def test_an_extra_field_is_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _StubManager(answer=_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.post(
        "/api/sessions/s1/dispatch", json={"network_model": "dc", "solver": "xpress"}
    )
    assert response.status_code == 422
    assert manager.calls == []


def test_unknown_session_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=SessionExpiredError("session s1 is not open")),
    )
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "dc"})
    assert response.status_code == 404


def test_no_case_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=_worker_error(NoCaseLoadedError("no case has been loaded"))),
    )
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "dc"})
    assert response.status_code == 409


def test_dispatch_request_error_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(
            error=_worker_error(
                DispatchRequestError(
                    "network_model must be copper_plate, dc, ptdf or ac, got 'sdp'"
                )
            )
        ),
    )
    response = client.post("/api/sessions/s1/dispatch", json={"network_model": "dc"})
    assert response.status_code == 422
    assert "network_model must be" in response.json()["detail"]
