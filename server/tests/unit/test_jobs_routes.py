"""Unit 5a — ``/sessions/{id}/jobs`` route handlers (list / get / cancel).

Drives the routes through Starlette's ``TestClient`` against a synthesized
``SessionManager`` whose session carries a hand-built ``_JobRegistry`` — no
worker subprocess, no ANDES. The session's ``process`` is a tiny fake whose
``is_alive`` returns True so the routes treat the session as live.

Covered (plan §"Unit 5a" test scenarios):

- empty list for a fresh session;
- after a synthesized JobRecord, GET /jobs returns it; GET /jobs/{id} returns it;
- DELETE on ``can_cancel=true`` → 200 + status cancelled;
- DELETE on ``can_cancel=false`` → 409 with ``recovery.kind=wait-for-job``
  (the plan's ``conflict: job-running`` / ``retryable: false``) + ``current_job``;
- unknown job_id → 404;
- kind / status query filters;
- unknown session → 404.
"""

from __future__ import annotations

from typing import Any

import pytest
from starlette.testclient import TestClient

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager, _Session


class _FakeProcess:
    """Minimal stand-in for ``mp.Process`` — only ``is_alive`` is read by the
    routes' ``is_alive`` gate."""

    def __init__(self, alive: bool = True) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive


def _make_app_with_session(session_id: str = "s1") -> tuple[TestClient, SessionManager, _Session]:
    """Build an app + manager + one synthesized live session.

    The ``SessionManager`` is installed directly on ``app.state`` (mirroring
    the integration fixtures) and a fake ``_Session`` is registered so the
    routes see a live session without spawning a worker. Returns the client,
    the manager, and the session so tests can poke the registry directly.
    """
    app = make_app(
        workspace=__import__("pathlib").Path("/tmp"),
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
    sess = _Session(
        session_id=session_id,
        process=_FakeProcess(alive=True),
        ctrl=None,
        data=None,
        abort_event=None,
    )
    mgr._sessions[session_id] = sess
    # Install on app.state and skip ``mgr.start()`` (no background tasks needed
    # for the route-level assertions; the lifespan would overwrite this, so we
    # bypass the TestClient lifespan by setting state before entering).
    app.state.session_manager = mgr
    client = TestClient(app)
    # Re-install after TestClient construction; the lifespan runs on context
    # enter and would replace the manager, so we patch the lifespan-built one's
    # state back to our synthesized session on first use below.
    return client, mgr, sess


@pytest.fixture
def fixture() -> Any:
    """Yield (client, mgr, sess) with the manager pinned past the lifespan.

    The TestClient runs ``make_app``'s lifespan on context enter, which builds
    a *fresh* SessionManager and overwrites ``app.state.session_manager``. To
    keep our synthesized session, we enter the context, then overwrite the
    state with our manager inside the ``with`` block.
    """
    client, mgr, sess = _make_app_with_session()
    with client:
        # Lifespan has now built+installed its own manager; replace it.
        client.app.state.session_manager = mgr
        yield client, mgr, sess


# ---- list -----------------------------------------------------------------


def test_list_empty_for_fresh_session(fixture: Any) -> None:
    client, _mgr, _sess = fixture
    resp = client.get("/api/sessions/s1/jobs")
    assert resp.status_code == 200, resp.text
    assert resp.json() == []


def test_list_returns_registered_job(fixture: Any) -> None:
    client, _mgr, sess = fixture
    job_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    resp = client.get("/api/sessions/s1/jobs")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == job_id
    assert body[0]["kind"] == "pflow"
    assert body[0]["status"] == "pending"


def test_list_filters_by_kind(fixture: Any) -> None:
    client, _mgr, sess = fixture
    sess.job_registry.register_job(kind="pflow", can_cancel=False)
    eig_id = sess.job_registry.register_job(kind="eig", can_cancel=False)
    resp = client.get("/api/sessions/s1/jobs?kind=eig")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [j["id"] for j in body] == [eig_id]


def test_list_filters_by_status(fixture: Any) -> None:
    client, _mgr, sess = fixture
    pending_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    running_id = sess.job_registry.register_job(kind="eig", can_cancel=False)
    sess.job_registry.mark_running(running_id)
    resp = client.get("/api/sessions/s1/jobs?status=running")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [j["id"] for j in body] == [running_id]
    assert pending_id not in [j["id"] for j in body]


def test_list_includes_global_registry(fixture: Any) -> None:
    """KTD-20: session-mutating jobs in the global registry surface in the
    OWNING session's /jobs view (filtered by the stamped ``origin_session_id``
    so they don't leak into other sessions)."""
    client, mgr, sess = fixture
    local_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    global_id = mgr.global_job_registry.register_job(
        kind="snapshot-restore", can_cancel=False, origin_session_id="s1"
    )
    resp = client.get("/api/sessions/s1/jobs")
    assert resp.status_code == 200, resp.text
    ids = {j["id"] for j in resp.json()}
    assert ids == {local_id, global_id}


def test_list_excludes_other_sessions_global_jobs(fixture: Any) -> None:
    """Cross-session isolation: a global (session-mutating) job stamped with a
    DIFFERENT ``origin_session_id`` must NOT appear in this session's /jobs
    view — the global registry is manager-wide, so unfiltered blending would
    leak every session's session-mutating jobs into every other session."""
    client, mgr, sess = fixture
    local_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    other_global_id = mgr.global_job_registry.register_job(
        kind="snapshot-restore", can_cancel=False, origin_session_id="other-session"
    )
    resp = client.get("/api/sessions/s1/jobs")
    assert resp.status_code == 200, resp.text
    ids = {j["id"] for j in resp.json()}
    assert ids == {local_id}
    assert other_global_id not in ids
    # And session s1 cannot resolve/cancel the other session's global job by id.
    assert (
        client.get(f"/api/sessions/s1/jobs/{other_global_id}")
    ).status_code == 404
    assert (
        client.delete(f"/api/sessions/s1/jobs/{other_global_id}")
    ).status_code == 404


def test_list_unknown_session_returns_404(fixture: Any) -> None:
    client, _mgr, _sess = fixture
    resp = client.get("/api/sessions/nope/jobs")
    assert resp.status_code == 404, resp.text


# ---- get ------------------------------------------------------------------


def test_get_returns_record(fixture: Any) -> None:
    client, _mgr, sess = fixture
    job_id = sess.job_registry.register_job(
        kind="tds-batch", can_cancel=True, request_summary={"tf": 10.0}
    )
    resp = client.get(f"/api/sessions/s1/jobs/{job_id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == job_id
    assert body["kind"] == "tds-batch"
    assert body["can_cancel"] is True
    assert body["request_summary"] == {"tf": 10.0}


def test_get_unknown_job_returns_404(fixture: Any) -> None:
    client, _mgr, _sess = fixture
    resp = client.get("/api/sessions/s1/jobs/does-not-exist")
    assert resp.status_code == 404, resp.text


# ---- cancel (DELETE) ------------------------------------------------------


def test_delete_cancellable_job_succeeds(fixture: Any) -> None:
    client, _mgr, sess = fixture
    job_id = sess.job_registry.register_job(kind="tds-stream", can_cancel=True)
    sess.job_registry.mark_running(job_id)
    resp = client.delete(f"/api/sessions/s1/jobs/{job_id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["id"] == job_id
    assert body["status"] == "cancelled"
    # The registry reflects the transition.
    assert sess.job_registry.get_job(job_id).status == "cancelled"


def test_delete_non_cancellable_job_returns_409_with_recovery(fixture: Any) -> None:
    client, _mgr, sess = fixture
    job_id = sess.job_registry.register_job(kind="pflow", can_cancel=False)
    sess.job_registry.mark_running(job_id)
    resp = client.delete(f"/api/sessions/s1/jobs/{job_id}")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    # The 409 carries the wait-for-job recovery CTA (plan: conflict=job-running,
    # retryable=false) and the in-flight job as current_job.
    assert body["recovery"] is not None
    assert body["recovery"]["kind"] == "wait-for-job"
    assert body["current_job"] is not None
    assert body["current_job"]["id"] == job_id
    # The job is NOT cancelled (still running).
    assert sess.job_registry.get_job(job_id).status == "running"


def test_delete_unknown_job_returns_404(fixture: Any) -> None:
    client, _mgr, _sess = fixture
    resp = client.delete("/api/sessions/s1/jobs/nope")
    assert resp.status_code == 404, resp.text


# ---- auth -----------------------------------------------------------------
