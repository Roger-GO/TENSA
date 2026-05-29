"""Unit 5a — per-session multiplexed ``/jobs/events`` WebSocket.

Opens the WS, drives synthetic job transitions, and asserts each transition
arrives as a ``{job_id, kind, status, progress?, problem?}`` envelope. Also
covers multiple concurrent subscribers all receiving the same broadcast with
no loss.

Transitions are driven through the HTTP ``DELETE /jobs/{id}`` cancel route so
the broadcast fires on the same anyio portal event loop the WS handler runs on
(``broadcast_job_event`` is a synchronous ``put_nowait``; cross-loop pushes are
not safe, so we let the in-app request path do it). The synthesized session's
worker is a fake whose ``is_alive`` returns True so the WS auth + liveness gates
pass without spawning a subprocess.
"""

from __future__ import annotations

import json

import pytest
from starlette.testclient import TestClient

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager, _Session

VALID_TOKEN = "b" * 64


class _FakeProcess:
    def is_alive(self) -> bool:
        return True


def _make_client() -> tuple[TestClient, SessionManager, _Session]:
    app = make_app(
        expected_token=VALID_TOKEN,
        workspace=__import__("pathlib").Path("/tmp"),
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
    sess = _Session(
        session_id="s1",
        process=_FakeProcess(),
        ctrl=None,
        data=None,
        abort_event=None,
    )
    mgr._sessions["s1"] = sess
    client = TestClient(app)
    return client, mgr, sess


def _headers() -> dict[str, str]:
    return {"X-Andes-Token": VALID_TOKEN}


@pytest.mark.integration
def test_ws_streams_two_transitions() -> None:
    client, mgr, sess = _make_client()
    with client:
        # Pin our synthesized session past the lifespan-built manager.
        client.app.state.session_manager = mgr
        client.app.state.require_auth = True

        # Two cancellable jobs to drive two transitions.
        job_a = sess.job_registry.register_job(kind="tds-stream", can_cancel=True)
        sess.job_registry.mark_running(job_a)
        job_b = sess.job_registry.register_job(kind="sweep", can_cancel=True)
        sess.job_registry.mark_running(job_b)

        with client.websocket_connect("/api/ws/s1/jobs/events") as ws:
            ws.send_text(json.dumps({"type": "auth", "token": VALID_TOKEN}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            snapshot = json.loads(ws.receive_text())
            assert snapshot["type"] == "snapshot"
            snap_ids = {j["job_id"] for j in snapshot["jobs"]}
            assert {job_a, job_b} <= snap_ids

            # Transition #1: cancel job_a via HTTP (broadcast on the portal loop).
            resp = client.delete(f"/api/sessions/s1/jobs/{job_a}", headers=_headers())
            assert resp.status_code == 200, resp.text
            ev1 = json.loads(ws.receive_text())
            assert ev1["type"] == "job"
            assert ev1["job_id"] == job_a
            assert ev1["status"] == "cancelled"

            # Transition #2: cancel job_b.
            resp = client.delete(f"/api/sessions/s1/jobs/{job_b}", headers=_headers())
            assert resp.status_code == 200, resp.text
            ev2 = json.loads(ws.receive_text())
            assert ev2["type"] == "job"
            assert ev2["job_id"] == job_b
            assert ev2["status"] == "cancelled"


@pytest.mark.integration
def test_ws_failed_transition_carries_problem() -> None:
    """A failed transition includes the ``problem`` envelope key.

    The failed transition + broadcast is driven on the portal event loop (via
    ``client.portal.call``) so it runs on the same loop as the WS subscriber's
    queue — mirroring how ``_run_as_job`` broadcasts a ``mark_failed`` from a
    request handler.
    """
    client, mgr, sess = _make_client()
    with client:
        client.app.state.session_manager = mgr
        client.app.state.require_auth = True

        job_id = sess.job_registry.register_job(kind="tds-stream", can_cancel=True)
        sess.job_registry.mark_running(job_id)

        with client.websocket_connect("/api/ws/s1/jobs/events") as ws:
            ws.send_text(json.dumps({"type": "auth", "token": VALID_TOKEN}))
            assert json.loads(ws.receive_text())["type"] == "ready"
            assert json.loads(ws.receive_text())["type"] == "snapshot"

            problem = {
                "type": "about:blank",
                "title": "Internal Server Error",
                "status": 500,
                "category": "WorkerInternalError",
                "detail": "boom",
                "recovery": None,
            }

            def _fail_and_broadcast() -> None:
                sess.job_registry.mark_failed(job_id, problem=problem)
                record = sess.job_registry.get_job(job_id)
                assert record is not None
                mgr.broadcast_job_event("s1", record)

            client.portal.call(_fail_and_broadcast)

            ev = json.loads(ws.receive_text())
            assert ev["type"] == "job"
            assert ev["job_id"] == job_id
            assert ev["status"] == "failed"
            assert ev["problem"]["category"] == "WorkerInternalError"


@pytest.mark.integration
def test_multiple_subscribers_receive_same_broadcast() -> None:
    """Two concurrent WS subscribers both see the same transition — no loss."""
    client, mgr, sess = _make_client()
    with client:
        client.app.state.session_manager = mgr
        client.app.state.require_auth = True

        job_id = sess.job_registry.register_job(kind="tds-stream", can_cancel=True)
        sess.job_registry.mark_running(job_id)

        with client.websocket_connect("/api/ws/s1/jobs/events") as ws1, \
                client.websocket_connect("/api/ws/s1/jobs/events") as ws2:
            for ws in (ws1, ws2):
                ws.send_text(json.dumps({"type": "auth", "token": VALID_TOKEN}))
                assert json.loads(ws.receive_text())["type"] == "ready"
                assert json.loads(ws.receive_text())["type"] == "snapshot"

            resp = client.delete(f"/api/sessions/s1/jobs/{job_id}", headers=_headers())
            assert resp.status_code == 200, resp.text

            ev1 = json.loads(ws1.receive_text())
            ev2 = json.loads(ws2.receive_text())
            for ev in (ev1, ev2):
                assert ev["type"] == "job"
                assert ev["job_id"] == job_id
                assert ev["status"] == "cancelled"
