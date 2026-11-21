"""A client that checks in keeps its session from being reaped as idle.

The reaper closes a session whose ``last_active`` is older than the idle timeout, and
only a request to the worker used to move it. A browser tab with nothing going on
sends none, so a user who stepped away for three minutes came back to a session
without the case they had built in it. ``SessionManager.touch`` is the check-in, and
``GET /sessions/{id}`` calls it, so a tab that polls that route keeps its session.

Driven against a synthesized session (no worker, no ANDES), the way the jobs route
tests are.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.api.routes.sessions import workspace_id
from tensa.core.session import SessionManager, _Session
from tensa.core.session import registry as registry_module

LONG_AGO = 1000.0


class _FakeProcess:
    """A worker that answers ``is_alive`` and is already gone when closed."""

    def __init__(self, alive: bool = True) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive

    def join(self, timeout: float | None = None) -> None:
        self._alive = False


class _Pipe:
    def send(self, message: dict[str, Any]) -> None:
        return None

    def close(self) -> None:
        return None


def _manager_with_idle_session(session_id: str = "s1") -> tuple[SessionManager, _Session]:
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
    sess = _Session(
        session_id=session_id,
        process=_FakeProcess(),
        ctrl=_Pipe(),
        data=_Pipe(),
        abort_event=None,
    )
    sess.last_active = time.monotonic() - LONG_AGO
    mgr._sessions[session_id] = sess
    return mgr, sess


async def _let_the_reaper_run(mgr: SessionManager, ticks: int = 3) -> None:
    """Run the idle reaper for a few ticks (the module's tick is patched short)."""
    task = asyncio.create_task(mgr._reap_loop())
    await asyncio.sleep(registry_module.IDLE_REAP_TICK * ticks)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@pytest.fixture(autouse=True)
def _short_reap_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(registry_module, "IDLE_REAP_TICK", 0.02)


def test_touch_stamps_a_live_session() -> None:
    mgr, sess = _manager_with_idle_session()
    before = sess.last_active

    assert mgr.touch("s1") is True

    assert sess.last_active > before
    assert time.monotonic() - sess.last_active < 5.0


def test_touch_reports_a_session_that_is_gone() -> None:
    mgr, sess = _manager_with_idle_session()
    assert mgr.touch("never-existed") is False

    sess.closed = True
    assert mgr.touch("s1") is False


def test_the_reaper_closes_a_session_nobody_checked_in_on() -> None:
    mgr, _ = _manager_with_idle_session()

    asyncio.run(_let_the_reaper_run(mgr))

    assert mgr._sessions == {}


def test_a_session_that_checked_in_is_not_reaped() -> None:
    mgr, sess = _manager_with_idle_session()
    mgr.touch("s1")

    asyncio.run(_let_the_reaper_run(mgr))

    assert mgr._sessions == {"s1": sess}
    assert not sess.closed


class _SlowWorker:
    """A data pipe whose reply comes when the test lets it: a worker busy with a
    long first op (a Sienna worker starting Julia takes a minute or two)."""

    def __init__(self) -> None:
        self.reply = threading.Event()

    def send(self, message: dict[str, Any]) -> None:
        return None

    def recv(self) -> dict[str, Any]:
        self.reply.wait(10.0)
        return {"type": "result", "seq": 1, "payload": "done"}

    def close(self) -> None:
        return None


def test_a_session_waiting_for_its_worker_is_not_reaped() -> None:
    """A request in flight is not idleness: the reaper leaves the session alone
    however long ago the request was sent, and the reply stamps it."""
    mgr, sess = _manager_with_idle_session()
    slow = _SlowWorker()
    sess.data = slow

    async def scenario() -> Any:
        request = asyncio.create_task(mgr.invoke("s1", "load_case", {}))
        # The request is on its way; make it look sent long ago.
        for _ in range(100):
            if sess.requests_in_flight:
                break
            await asyncio.sleep(0.01)
        assert sess.requests_in_flight == 1
        # Past the request's own stamp of `last_active`: it waits in `recv` now.
        await asyncio.sleep(0.2)
        sess.last_active = time.monotonic() - LONG_AGO
        await _let_the_reaper_run(mgr)
        assert mgr._sessions == {"s1": sess}
        assert not sess.closed
        slow.reply.set()
        return await request

    assert asyncio.run(scenario()) == "done"
    assert sess.requests_in_flight == 0
    assert time.monotonic() - sess.last_active < 5.0


def test_get_session_counts_as_activity(tmp_path: Path) -> None:
    mgr, sess = _manager_with_idle_session()
    app = make_app(
        workspace=tmp_path,
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver"}),
    )
    with TestClient(app) as client:
        # The lifespan built its own manager; put ours (with the idle session) in.
        client.app.state.session_manager = mgr
        before = sess.last_active

        resp = client.get("/api/sessions/s1")

        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "session_id": "s1",
            "state": "live",
            "workspace_id": workspace_id(client.app.state.workspace),
            "engine": "andes",
        }
        assert sess.last_active > before
        assert time.monotonic() - sess.last_active < 5.0

        # A session the manager does not hold still answers 404, which is how the
        # web client learns its session was reaped.
        assert client.get("/api/sessions/unknown").status_code == 404


def test_a_workspace_is_named_by_a_digest_that_holds_no_path(tmp_path: Path) -> None:
    """The name a session gives its workspace: one per folder, and not the folder."""
    first, second = tmp_path / "cases", tmp_path / "other cases"

    name = workspace_id(first)

    assert name == workspace_id(first)
    assert name != workspace_id(second)
    assert len(name) == 16
    int(name, 16)
    assert "cases" not in name
    assert str(tmp_path) not in name

