"""Route tests of ``GET /sessions/{id}/network-matrix`` with a stubbed manager."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.errors import NoCaseLoadedError
from tensa.core.session import SessionExpiredError, WorkerError
from tensa.engines import engine_capabilities, engines_with_op
from tensa.engines.sienna.state import (
    NetworkMatrixKindError,
    NetworkMatrixTooLargeError,
)


def _ptdf_payload() -> dict[str, Any]:
    return {
        "kind": "ptdf",
        "n_rows": 3,
        "n_cols": 3,
        "n_entries": 9,
        "complex": False,
        "base_mva": 100.0,
        "rows": [
            {"from": 1, "to": 2, "keys": ["branch:1-2-1"]},
            {"from": 2, "to": 3, "keys": ["branch:2-3-1"]},
            {"from": 1, "to": 3, "keys": ["branch:1-3-1"]},
        ],
        "cols": [
            {"bus": 1, "key": "bus:1"},
            {"bus": 2, "key": "bus:2"},
            {"bus": 3, "key": "bus:3"},
        ],
        "ref_buses": ["bus:1"],
        "distributed_slack": False,
        "values": [
            [0.0, -2.0 / 3.0, -1.0 / 3.0],
            [0.0, 1.0 / 3.0, -1.0 / 3.0],
            [0.0, -1.0 / 3.0, -2.0 / 3.0],
        ],
    }


def _ybus_payload() -> dict[str, Any]:
    return {
        "kind": "ybus",
        "n_rows": 3,
        "n_cols": 3,
        "n_entries": 3,
        "complex": True,
        "base_mva": 100.0,
        "rows": [
            {"bus": 1, "key": "bus:1"},
            {"bus": 2, "key": "bus:2"},
            {"bus": 3, "key": "bus:3"},
        ],
        "cols": [
            {"bus": 1, "key": "bus:1"},
            {"bus": 2, "key": "bus:2"},
            {"bus": 3, "key": "bus:3"},
        ],
        "distributed_slack": False,
        "entries": [
            {"row": 0, "col": 0, "re": 2.0, "im": -20.0},
            {"row": 1, "col": 1, "re": 3.0, "im": -30.0},
            {"row": 2, "col": 2, "re": 2.0, "im": -20.0},
        ],
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
    monkeypatch.setattr("tensa.api.routes.network_matrix.SessionManager", _StubManager)
    # TestClient's default Host is "testserver", which the Host/Origin check
    # refuses; allow it, as the other route tests do.
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


def test_ptdf_route_200(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, _StubManager(answer=_ptdf_payload()))
    response = client.get("/api/sessions/s1/network-matrix?kind=ptdf")
    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "ptdf"
    assert body["rows"][0] == {"from": 1, "to": 2, "keys": ["branch:1-2-1"]}
    assert body["cols"] == [
        {"bus": 1, "key": "bus:1"},
        {"bus": 2, "key": "bus:2"},
        {"bus": 3, "key": "bus:3"},
    ]
    assert body["ref_buses"] == ["bus:1"]
    assert body["values"][2][1] == pytest.approx(-1.0 / 3.0, abs=1e-12)
    assert "entries" not in body


def test_default_kind_is_ptdf(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manager = _StubManager(answer=_ptdf_payload())
    client = _client(tmp_path, monkeypatch, manager)
    response = client.get("/api/sessions/s1/network-matrix")
    assert response.status_code == 200
    assert manager.calls == [("s1", "network_matrix", {"kind": "ptdf"})]


def test_andes_session_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    error = WorkerError(
        "EngineUnsupportedError",
        "'network_matrix' is not available with the andes engine; "
        "engines that have it: sienna",
    )
    client = _client(tmp_path, monkeypatch, _StubManager(error=error))
    response = client.get("/api/sessions/s1/network-matrix?kind=ptdf")
    assert response.status_code == 409
    assert "sienna" in response.json()["detail"]


def test_no_case_409(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=_worker_error(NoCaseLoadedError("no case has been loaded"))),
    )
    response = client.get("/api/sessions/s1/network-matrix?kind=ptdf")
    assert response.status_code == 409


def test_unknown_kind_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=_worker_error(NetworkMatrixKindError("modf"))),
    )
    response = client.get("/api/sessions/s1/network-matrix?kind=modf")
    assert response.status_code == 422
    assert "unknown network matrix kind: 'modf'" in response.json()["detail"]


def test_too_large_422(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(
            error=_worker_error(NetworkMatrixTooLargeError("ptdf", 300000, 250000))
        ),
    )
    response = client.get("/api/sessions/s1/network-matrix?kind=ptdf")
    assert response.status_code == 422
    assert "300000" in response.json()["detail"]


def test_session_expired_404(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(
        tmp_path,
        monkeypatch,
        _StubManager(error=SessionExpiredError("session s1 is not open")),
    )
    response = client.get("/api/sessions/s1/network-matrix?kind=ptdf")
    assert response.status_code == 404


def test_ybus_route_entries_shape(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch, _StubManager(answer=_ybus_payload()))
    response = client.get("/api/sessions/s1/network-matrix?kind=ybus")
    assert response.status_code == 200
    body = response.json()
    assert body["complex"] is True
    assert set(body["entries"][0]) == {"row", "col", "re", "im"}
    assert "values" not in body
    assert "ref_buses" not in body


def test_ops_table() -> None:
    assert engines_with_op("network_matrix") == ["sienna"]
    caps = engine_capabilities("sienna")
    if caps["available"]:
        assert "network_matrix" in caps["ops"]
        assert "matrices" in caps["routines"]
