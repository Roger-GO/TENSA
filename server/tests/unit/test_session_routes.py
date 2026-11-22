"""What the session routes answer, driven against synthesized sessions (no worker,
no ANDES), the way ``test_session_idle.py`` drives ``GET /sessions/{id}``.

Each session reports the engine it was created for, ``GET /sessions`` lists them in
the order they were created, and an app whose session manager is not in place yet
says so with a 500 on every route instead of failing on the missing manager.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.session import SessionManager, _Session


class _FakeProcess:
    def is_alive(self) -> bool:
        return True

    def join(self, timeout: float | None = None) -> None:
        return None


class _Pipe:
    def send(self, message: dict[str, Any]) -> None:
        return None

    def close(self) -> None:
        return None


def _app(tmp_path: Path) -> Any:
    return make_app(
        workspace=tmp_path,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver"}),
    )


def _manager_with(sessions: list[tuple[str, str]]) -> SessionManager:
    mgr = SessionManager(max_sessions=8, idle_timeout=180.0)
    for session_id, engine in sessions:
        mgr._sessions[session_id] = _Session(
            session_id=session_id,
            process=_FakeProcess(),  # type: ignore[arg-type]
            ctrl=_Pipe(),
            data=_Pipe(),
            abort_event=None,
            engine=engine,
        )
    return mgr


def test_each_session_reports_its_own_engine(tmp_path: Path) -> None:
    mgr = _manager_with([("s-andes", "andes"), ("s-sienna", "sienna")])
    with TestClient(_app(tmp_path)) as client:
        client.app.state.session_manager = mgr  # type: ignore[attr-defined]

        assert client.get("/api/sessions/s-sienna").json()["engine"] == "sienna"
        assert client.get("/api/sessions/s-andes").json()["engine"] == "andes"
        listed = client.get("/api/sessions").json()["sessions"]
        assert {s["session_id"]: s["engine"] for s in listed} == {
            "s-andes": "andes",
            "s-sienna": "sienna",
        }


def test_sessions_are_listed_in_the_order_they_were_created(tmp_path: Path) -> None:
    created = ["s-b", "s-a", "s-c"]
    mgr = _manager_with([(sid, "andes") for sid in created])
    with TestClient(_app(tmp_path)) as client:
        client.app.state.session_manager = mgr  # type: ignore[attr-defined]

        listed = client.get("/api/sessions").json()["sessions"]
        assert [s["session_id"] for s in listed] == created


def test_without_a_session_manager_every_session_route_answers_500(tmp_path: Path) -> None:
    # No ``with``: the lifespan, which puts the manager in place, does not run.
    client = TestClient(_app(tmp_path))
    for method, path in (
        ("POST", "/api/sessions"),
        ("GET", "/api/sessions"),
        ("GET", "/api/sessions/s1"),
        ("DELETE", "/api/sessions/s1"),
    ):
        resp = client.request(method, path)
        assert resp.status_code == 500, (method, path, resp.text)
        assert resp.json()["detail"] == "session manager is not configured"
