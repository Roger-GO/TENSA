"""``GET /api/health``: the server's own state, for a script or a supervisor to poll.

The route reads the session registry and the code cache's stamp, and never talks to
a worker, so these tests need no ANDES and spawn nothing. A real session being
counted is in ``tests/integration/test_health_api.py``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

import tensa
from tensa.api.app import make_app
from tensa.api.routes import health
from tensa.core.session import SessionManager

pytestmark = pytest.mark.unit


@pytest.fixture
def manager() -> SessionManager:
    """A manager that has started nothing: it holds no session and no process."""
    return SessionManager(max_sessions=3)


@pytest.fixture
def client(
    tmp_path: Path, manager: SessionManager, monkeypatch: pytest.MonkeyPatch
) -> TestClient:
    # Stand-ins for what the route reads from the machine: ANDES's version, and its
    # generated code.
    monkeypatch.setattr(health, "andes_version", lambda: "9.9.9")
    monkeypatch.setattr(health, "cache_state", lambda version: "ready")
    monkeypatch.setattr(health, "background_warm_running", lambda: False)
    app = make_app(workspace=tmp_path, bind_port=8000, max_sessions=3, static_override=tmp_path)
    app.state.session_manager = manager
    return TestClient(app, base_url="http://127.0.0.1:8000")


def test_health_reports_the_versions_the_sessions_and_the_cache(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "version": tensa.__version__,
        "andes_version": "9.9.9",
        "sessions": {"active": 0, "max": 3},
        "cache": {"state": "ready", "warm": True, "generating": False},
    }


def test_health_counts_the_open_sessions(
    client: TestClient, manager: SessionManager, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(manager, "list_sessions", lambda: ["a", "b"])
    assert client.get("/api/health").json()["sessions"] == {"active": 2, "max": 3}


def test_the_cap_is_the_one_the_app_was_built_with(tmp_path: Path, manager: SessionManager) -> None:
    app = make_app(workspace=tmp_path, bind_port=8000, max_sessions=7, static_override=tmp_path)
    app.state.session_manager = manager
    health_body = TestClient(app, base_url="http://127.0.0.1:8000").get("/api/health").json()
    assert health_body["sessions"]["max"] == 7


def test_a_cap_of_zero_does_not_break_the_check(tmp_path: Path) -> None:
    """``--max-sessions`` takes any integer, and a monitor must still get an answer."""
    app = make_app(workspace=tmp_path, bind_port=8000, max_sessions=0, static_override=tmp_path)
    app.state.session_manager = SessionManager(max_sessions=0)
    response = TestClient(app, base_url="http://127.0.0.1:8000").get("/api/health")
    assert response.status_code == 200
    assert response.json()["sessions"] == {"active": 0, "max": 0}


@pytest.mark.parametrize(
    ("state", "warm"), [("ready", True), ("unchecked", False), ("missing", False)]
)
@pytest.mark.parametrize("generating", [True, False])
def test_only_a_checked_cache_is_warm(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    state: str,
    warm: bool,
    generating: bool,
) -> None:
    monkeypatch.setattr(health, "cache_state", lambda version: state)
    monkeypatch.setattr(health, "background_warm_running", lambda: generating)
    assert client.get("/api/health").json()["cache"] == {
        "state": state,
        "warm": warm,
        "generating": generating,
    }


def test_the_cache_is_checked_against_the_installed_andes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    asked: list[str] = []

    def _state(version: str) -> str:
        asked.append(version)
        return "ready"

    monkeypatch.setattr(health, "cache_state", _state)
    client.get("/api/health")
    assert asked == ["9.9.9"]


def test_a_machine_with_no_home_directory_is_a_server_with_no_cache(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``Path.home()`` raises when no home can be found; a health check must not."""

    def _no_home(version: str) -> str:
        raise RuntimeError("Could not determine home directory.")

    monkeypatch.setattr(health, "cache_state", _no_home)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["cache"]["state"] == "missing"


def test_an_app_without_a_session_manager_is_not_healthy(tmp_path: Path) -> None:
    app = make_app(workspace=tmp_path, bind_port=8000, static_override=tmp_path)
    response = TestClient(app, base_url="http://127.0.0.1:8000").get("/api/health")
    assert response.status_code == 500


def test_health_is_in_the_api_description(tmp_path: Path) -> None:
    schema: dict[str, Any] = make_app(workspace=tmp_path, static_override=tmp_path).openapi()
    operation = schema["paths"]["/api/health"]["get"]
    assert operation["operationId"] == "getHealth"
    # The response model is the route module's own, not one of ``api/schemas/``.
    assert "HealthResponse" in schema["components"]["schemas"]
    assert health.HealthResponse.__module__ == "tensa.api.routes.health"
    # Every field says what it is, the two that hold a model of their own included:
    # the acceptance suite asks that of every model, and these live outside the
    # package the other models are in.
    for model in ("HealthResponse", "HealthSessions", "HealthCache"):
        for name, field in schema["components"]["schemas"][model]["properties"].items():
            assert str(field.get("description", "")).strip(), f"{model}.{name}"
