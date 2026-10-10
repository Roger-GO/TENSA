"""Unit 5a — per-session multiplexed ``/jobs/events`` WebSocket.

Opens the WS, drives synthetic job transitions, and asserts each transition
arrives as a ``{job_id, kind, status, progress?, problem?}`` envelope. Also
covers multiple concurrent subscribers all receiving the same broadcast with
no loss.

Transitions are driven through the HTTP ``DELETE /jobs/{id}`` cancel route so
the broadcast fires on the same anyio portal event loop the WS handler runs on
(``broadcast_job_event`` is a synchronous ``put_nowait``; cross-loop pushes are
not safe, so we let the in-app request path do it). The synthesized session's
worker is a fake whose ``is_alive`` returns True so the WS liveness gates
pass without spawning a subprocess.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import anyio
import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocket

from tensa.api.app import make_app
from tensa.api.routes.jobs import ws_job_events
from tensa.core.session import SessionManager, _Session


class _FakeProcess:
    def is_alive(self) -> bool:
        return True


def _manager_with_session() -> tuple[SessionManager, _Session]:
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
    sess = _Session(
        session_id="s1",
        process=_FakeProcess(),
        ctrl=None,
        data=None,
        abort_event=None,
    )
    mgr._sessions["s1"] = sess
    return mgr, sess


def _make_client() -> tuple[TestClient, SessionManager, _Session]:
    app = make_app(
        workspace=__import__("pathlib").Path("/tmp"),
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    mgr, sess = _manager_with_session()
    client = TestClient(app)
    return client, mgr, sess


def _handler_scope(mgr: SessionManager) -> dict[str, Any]:
    """The ASGI scope of a socket on the feed, for a test that calls the handler
    itself."""
    return {
        "type": "websocket",
        "path": "/api/ws/s1/jobs/events",
        "headers": [],
        "app": SimpleNamespace(state=SimpleNamespace(session_manager=mgr)),
    }


async def _until_subscribed(sess: _Session) -> None:
    """Wait for the handler to be past its snapshot, on the live feed."""
    for _ in range(200):
        if sess.job_event_subscribers:
            break
        await asyncio.sleep(0.01)
    assert len(sess.job_event_subscribers) == 1, "the handler never subscribed"


@pytest.mark.integration
def test_ws_streams_two_transitions() -> None:
    client, mgr, sess = _make_client()
    with client:
        # Pin our synthesized session past the lifespan-built manager.
        client.app.state.session_manager = mgr
        # Two cancellable jobs to drive two transitions.
        job_a = sess.job_registry.register_job(kind="tds-stream", can_cancel=True)
        sess.job_registry.mark_running(job_a)
        job_b = sess.job_registry.register_job(kind="sweep", can_cancel=True)
        sess.job_registry.mark_running(job_b)

        with client.websocket_connect("/api/ws/s1/jobs/events") as ws:
            assert json.loads(ws.receive_text())["type"] == "ready"
            snapshot = json.loads(ws.receive_text())
            assert snapshot["type"] == "snapshot"
            snap_ids = {j["job_id"] for j in snapshot["jobs"]}
            assert {job_a, job_b} <= snap_ids

            # Transition #1: cancel job_a via HTTP (broadcast on the portal loop).
            resp = client.delete(f"/api/sessions/s1/jobs/{job_a}")
            assert resp.status_code == 200, resp.text
            ev1 = json.loads(ws.receive_text())
            assert ev1["type"] == "job"
            assert ev1["job_id"] == job_a
            assert ev1["status"] == "cancelled"

            # Transition #2: cancel job_b.
            resp = client.delete(f"/api/sessions/s1/jobs/{job_b}")
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
        job_id = sess.job_registry.register_job(kind="tds-stream", can_cancel=True)
        sess.job_registry.mark_running(job_id)

        with client.websocket_connect("/api/ws/s1/jobs/events") as ws:
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
        job_id = sess.job_registry.register_job(kind="tds-stream", can_cancel=True)
        sess.job_registry.mark_running(job_id)

        with client.websocket_connect("/api/ws/s1/jobs/events") as ws1, \
                client.websocket_connect("/api/ws/s1/jobs/events") as ws2:
            for ws in (ws1, ws2):
                assert json.loads(ws.receive_text())["type"] == "ready"
                assert json.loads(ws.receive_text())["type"] == "snapshot"

            resp = client.delete(f"/api/sessions/s1/jobs/{job_id}")
            assert resp.status_code == 200, resp.text

            ev1 = json.loads(ws1.receive_text())
            ev2 = json.loads(ws2.receive_text())
            for ev in (ev1, ev2):
                assert ev["type"] == "job"
                assert ev["job_id"] == job_id
                assert ev["status"] == "cancelled"


@pytest.mark.integration
@pytest.mark.parametrize("close_code", [1001, 1012], ids=["client-left", "server-stopping"])
def test_ws_handler_ends_when_the_socket_closes(close_code: int) -> None:
    """The feed waits on a queue that only a job or the end of the session wakes.

    The handler used to wait there and nowhere else, so it outlived its socket:
    uvicorn, which waits for every handler before it shuts the app down, could not
    stop while a page was open (1012 is the close it sends each socket when asked
    to), and the handler of a tab that was closed stayed until its session was
    reaped. The handler is driven here without the test client, which cancels the
    handler itself when its socket is closed.
    """
    mgr, sess = _manager_with_session()
    sent: list[dict[str, Any]] = []

    async def scenario() -> None:
        incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        incoming.put_nowait({"type": "websocket.connect"})

        async def send(message: Any) -> None:
            sent.append(dict(message))

        handler = asyncio.create_task(
            ws_job_events(WebSocket(_handler_scope(mgr), incoming.get, send), "s1")
        )
        await _until_subscribed(sess)

        incoming.put_nowait({"type": "websocket.disconnect", "code": close_code})
        await asyncio.wait_for(handler, timeout=5)

    asyncio.run(scenario())

    # Its queue is off the session, and it sent nothing after the snapshot.
    assert sess.job_event_subscribers == []
    texts = [json.loads(m["text"]) for m in sent if m["type"] == "websocket.send"]
    assert [t["type"] for t in texts] == ["ready", "snapshot"]


@pytest.mark.integration
@pytest.mark.parametrize("ending", ["client-left", "session-closed"])
def test_ws_handler_cancelled_while_it_ends_gives_the_cancellation_back(ending: str) -> None:
    """A handler that is ending can be cancelled at any step of it, and the
    cancellation must come out as the one that was sent.

    Starlette's test client runs a handler inside a cancel scope and cancels the
    scope whenever a socket is left, wherever the handler is by then. The scope
    takes back a cancellation it knows for its own, by the message the error
    carries. The handler put its two tasks away with ``asyncio.gather``, which
    answers a cancellation with one it takes from the last task it was given,
    without that message. So for the turns of the event loop in which one task had
    ended and the other was cancelled and not yet gone, the scope's cancellation
    came out as a stranger's and failed a test that had done nothing but leave. On
    one core the client's cancel lands there nearly every time.

    The handler is cancelled here one turn of the loop later on each pass, from
    before it has seen its ending to after it has returned, so every step is tried.
    """

    async def cancelled_after(turns: int) -> bool:
        mgr, sess = _manager_with_session()
        incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        incoming.put_nowait({"type": "websocket.connect"})

        async def send(message: Any) -> None:
            return None

        scopes: list[anyio.CancelScope] = []

        async def as_the_test_client_runs_it() -> None:
            with anyio.CancelScope() as scope:
                scopes.append(scope)
                await ws_job_events(WebSocket(_handler_scope(mgr), incoming.get, send), "s1")

        handler = asyncio.create_task(as_the_test_client_runs_it())
        await _until_subscribed(sess)

        if ending == "client-left":
            incoming.put_nowait({"type": "websocket.disconnect", "code": 1001})
        else:
            # What the manager puts on every feed of a session it closes.
            sess.job_event_subscribers[0].put_nowait({"__closed__": True})
        for _ in range(turns):
            await asyncio.sleep(0)
        had_returned = handler.done()
        scopes[0].cancel()

        await asyncio.wait({handler}, timeout=5)
        assert handler.done(), f"cancelled {turns} turns into its ending, the handler hung"
        assert not handler.cancelled(), (
            f"cancelled {turns} turns into its ending, the handler raised a "
            "cancellation its scope did not know"
        )
        assert handler.exception() is None
        # Nothing of it is left: the tasks it cancelled end on the next turn.
        for _ in range(3):
            await asyncio.sleep(0)
        assert sess.job_event_subscribers == []
        assert asyncio.all_tasks() == {asyncio.current_task()}
        return had_returned

    for turns in range(50):
        if asyncio.run(cancelled_after(turns)):
            break
    else:
        pytest.fail("the handler had not returned 50 turns of the loop after its ending")
    # The last cancellation found the handler gone, and the first one did not.
    assert turns > 0
