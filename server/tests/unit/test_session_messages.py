"""The server keeps what a worker's replies carry of ANDES's log, and serves it.

Driven with a fake worker (a pipe that hands back canned replies) and Starlette's
``TestClient``, so no worker subprocess and no ANDES: the replies are what
``tests/unit/test_messages.py`` shows the worker building, and
``tests/integration/test_messages_api.py`` checks the two against a real worker.
"""

from __future__ import annotations

import asyncio
import pathlib
import threading
from collections.abc import Iterator
from typing import Any

import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError, _Session

pytestmark = pytest.mark.unit


def _entry(text: str, level: str = "info", source: str = "run_pflow") -> dict[str, Any]:
    return {
        "time": 1700000000.5,
        "level": level,
        "logger": "andes.routines.pflow",
        "source": source,
        "text": text,
        "repeat": 1,
    }


class _Ctrl:
    def send(self, message: dict[str, Any]) -> None:
        pass


class _Data:
    """The worker's data pipe: ``recv`` hands out the canned replies in order."""

    def __init__(self, replies: list[dict[str, Any]]) -> None:
        self._replies = list(replies)

    def recv(self) -> dict[str, Any]:
        return self._replies.pop(0)


class _Process:
    def is_alive(self) -> bool:
        return True


def _manager_with(replies: list[dict[str, Any]]) -> tuple[SessionManager, _Session]:
    mgr = SessionManager()
    sess = _Session(
        session_id="s1",
        process=_Process(),  # type: ignore[arg-type]
        ctrl=_Ctrl(),
        data=_Data(replies),
        abort_event=None,
    )
    mgr._sessions["s1"] = sess
    return mgr, sess


def _texts(sess: _Session) -> list[str]:
    return [m.text for m in sess.messages.page().messages]


# ---- what invoke keeps --------------------------------------------------------


def test_a_reply_s_messages_are_kept_and_the_payload_is_unchanged() -> None:
    reply = {
        "type": "result",
        "seq": 1,
        "payload": {"converged": True},
        "log": [_entry("Converged in 5 iterations"), _entry("slow", "warning")],
    }
    mgr, sess = _manager_with([reply])

    payload = asyncio.run(mgr.invoke("s1", "run_pflow", {}))

    assert payload == {"converged": True}
    assert _texts(sess) == ["Converged in 5 iterations", "slow"]
    assert [m.level for m in sess.messages.page().messages] == ["info", "warning"]


def test_the_messages_of_a_command_that_failed_are_kept_too() -> None:
    reply = {
        "type": "error",
        "seq": 1,
        "category": "internal-error",
        "detail": "boom",
        "log": [_entry("Power flow failed after 25 iterations", "error")],
    }
    mgr, sess = _manager_with([reply])

    with pytest.raises(WorkerError):
        asyncio.run(mgr.invoke("s1", "run_pflow", {}))

    assert _texts(sess) == ["Power flow failed after 25 iterations"]


def test_a_reply_with_no_log_adds_nothing() -> None:
    mgr, sess = _manager_with([{"type": "result", "seq": 1, "payload": 1}])
    asyncio.run(mgr.invoke("s1", "topology", {}))
    page = sess.messages.page()
    assert (page.messages, page.last_seq, page.dropped) == ([], 0, 0)


def test_what_the_worker_dropped_is_counted_even_when_nothing_else_came() -> None:
    mgr, sess = _manager_with(
        [{"type": "result", "seq": 1, "payload": None, "log_dropped": 7}]
    )
    asyncio.run(mgr.invoke("s1", "run_tds", {}))
    assert sess.messages.page().dropped == 7


def test_messages_of_successive_commands_follow_one_another() -> None:
    mgr, sess = _manager_with(
        [
            {"type": "result", "seq": 1, "payload": None, "log": [_entry("one")]},
            {"type": "result", "seq": 2, "payload": None, "log": [_entry("two"), _entry("three")]},
        ]
    )

    async def _run() -> None:
        await mgr.invoke("s1", "load_case", {})
        await mgr.invoke("s1", "run_pflow", {})

    asyncio.run(_run())

    assert [(m.seq, m.text) for m in sess.messages.page().messages] == [
        (1, "one"),
        (2, "two"),
        (3, "three"),
    ]


# ---- what a streamed run keeps ------------------------------------------------


def test_a_streamed_run_s_messages_arrive_with_its_frames_not_only_at_the_end() -> None:
    mgr, sess = _manager_with(
        [
            {"type": "stream_start", "seq": 1, "metadata": {}},
            {
                "type": "stream_frame",
                "seq": 1,
                "payload": b"frame-1",
                "log": [_entry("<Toggle 1>: status changed at t=2.0 sec.", source="run_tds")],
            },
            {"type": "stream_frame", "seq": 1, "payload": b"frame-2"},
            {
                "type": "result",
                "seq": 1,
                "payload": {"converged": True},
                "log": [_entry("Simulation to t=5.00 sec completed.", source="run_tds")],
            },
        ]
    )
    seen_at_frame: list[list[str]] = []
    frames: list[bytes] = []

    async def _on_frame(payload: bytes) -> None:
        frames.append(payload)
        seen_at_frame.append(_texts(sess))

    result = asyncio.run(mgr.invoke_streaming("s1", "run_tds", {}, on_frame=_on_frame))

    assert result == {"converged": True}
    assert frames == [b"frame-1", b"frame-2"]
    # The event is in the log by the time the frame that carried it is handled,
    # and the run's closing message follows it.
    assert seen_at_frame[0] == ["<Toggle 1>: status changed at t=2.0 sec."]
    assert _texts(sess) == [
        "<Toggle 1>: status changed at t=2.0 sec.",
        "Simulation to t=5.00 sec completed.",
    ]


# ---- the routes ---------------------------------------------------------------


@pytest.fixture
def client() -> Iterator[tuple[TestClient, _Session]]:
    app = make_app(
        workspace=pathlib.Path("/tmp"),
        bind_host="127.0.0.1",
        bind_port=8000,
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset({"http://testserver", "http://localhost"}),
    )
    mgr, sess = _manager_with([])
    with TestClient(app) as test_client:
        # The lifespan built a manager of its own; use the one with the fake session.
        test_client.app.state.session_manager = mgr  # type: ignore[attr-defined]
        yield test_client, sess


def test_the_route_lists_what_the_session_holds(client: tuple[TestClient, _Session]) -> None:
    http, sess = client
    sess.messages.extend(
        [_entry("fine"), _entry("hmm", "warning", "load_case"), _entry("bad", "error")]
    )

    body = http.get("/api/sessions/s1/messages").json()

    assert [(m["seq"], m["level"], m["source"], m["text"]) for m in body["messages"]] == [
        (1, "info", "run_pflow", "fine"),
        (2, "warning", "load_case", "hmm"),
        (3, "error", "run_pflow", "bad"),
    ]
    first = body["messages"][0]
    assert set(first) == {"seq", "time", "level", "logger", "source", "text", "repeat"}
    assert first["time"] == 1700000000.5
    assert first["logger"] == "andes.routines.pflow"
    assert (body["first_seq"], body["last_seq"], body["next_after"], body["dropped"]) == (
        1,
        3,
        3,
        0,
    )


def test_the_route_reads_on_from_a_number_and_filters_by_level(
    client: tuple[TestClient, _Session],
) -> None:
    http, sess = client
    sess.messages.extend([_entry("a"), _entry("b", "warning"), _entry("c"), _entry("d", "error")])

    after = http.get("/api/sessions/s1/messages", params={"after": 2}).json()
    assert [m["text"] for m in after["messages"]] == ["c", "d"]

    warnings = http.get("/api/sessions/s1/messages", params={"level": "warning"}).json()
    assert [m["text"] for m in warnings["messages"]] == ["b", "d"]

    errors = http.get("/api/sessions/s1/messages", params={"level": "error"}).json()
    assert [m["text"] for m in errors["messages"]] == ["d"]

    page = http.get("/api/sessions/s1/messages", params={"limit": 1}).json()
    assert [m["text"] for m in page["messages"]] == ["a"]
    assert page["next_after"] == 1 and page["last_seq"] == 4


def test_the_route_refuses_a_bad_query(client: tuple[TestClient, _Session]) -> None:
    http, _sess = client
    assert http.get("/api/sessions/s1/messages", params={"level": "loud"}).status_code == 422
    assert http.get("/api/sessions/s1/messages", params={"after": -1}).status_code == 422
    assert http.get("/api/sessions/s1/messages", params={"limit": 0}).status_code == 422
    assert http.get("/api/sessions/s1/messages", params={"limit": 2001}).status_code == 422


def test_deleting_empties_the_log_and_numbering_goes_on(
    client: tuple[TestClient, _Session],
) -> None:
    http, sess = client
    sess.messages.extend([_entry("a"), _entry("b")])

    assert http.delete("/api/sessions/s1/messages").status_code == 204
    cleared = http.get("/api/sessions/s1/messages").json()
    assert cleared["messages"] == []
    assert (cleared["first_seq"], cleared["last_seq"], cleared["dropped"]) == (3, 2, 0)

    sess.messages.extend([_entry("c")])
    later = http.get("/api/sessions/s1/messages", params={"after": 2}).json()
    assert [(m["seq"], m["text"]) for m in later["messages"]] == [(3, "c")]


def test_a_read_does_not_wait_for_the_command_that_is_running(
    client: tuple[TestClient, _Session],
) -> None:
    """A streamed run holds the session for as long as it goes. A command sent
    meanwhile is refused (409), but the log, which lives in the server, answers."""
    http, sess = client
    sess.messages.extend([_entry("logged before the run started")])
    holding = threading.Event()
    release = threading.Event()

    def _run_in_progress() -> None:
        with sess.lock:
            holding.set()
            release.wait(timeout=30)

    runner = threading.Thread(target=_run_in_progress)
    runner.start()
    try:
        assert holding.wait(timeout=10)
        assert http.get("/api/sessions/s1/operating-point").status_code == 409
        read = http.get("/api/sessions/s1/messages")
        assert read.status_code == 200
        assert [m["text"] for m in read.json()["messages"]] == ["logged before the run started"]
        assert http.delete("/api/sessions/s1/messages").status_code == 204
    finally:
        release.set()
        runner.join(timeout=10)


def test_an_unknown_session_is_a_404_for_both_verbs(client: tuple[TestClient, _Session]) -> None:
    http, _sess = client
    assert http.get("/api/sessions/nope/messages").status_code == 404
    assert http.delete("/api/sessions/nope/messages").status_code == 404


def test_session_messages_of_an_unknown_session_raises() -> None:
    with pytest.raises(SessionExpiredError):
        SessionManager().session_messages("nope")
