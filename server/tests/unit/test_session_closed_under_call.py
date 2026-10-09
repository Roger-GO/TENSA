"""A request that a close overtakes is answered as one to a session that is gone.

``close_session`` does not wait for the request a session has in flight: it marks
the session closed and sends the worker ``shutdown`` at once. A request that found
the session open a moment before can then reach the worker after the ``shutdown``,
and what it reads back is the worker's answer to that (``seq`` -1, no payload), not
to its own op. ``invoke`` handed that on as a result of ``None``, and
``GET /sessions/{id}/topology`` failed on it with a 500 and a traceback in the
server's log. A page that is reloaded while its case loads does exactly this: it
gives its session back as it goes, with its last requests still on their way.

Driven via ``asyncio.run`` so they need no pytest-asyncio, like
``tests/unit/test_session_worker_died.py``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi import HTTPException

from tensa.api.routes.cases import get_topology
from tensa.core.session import SessionExpiredError, SessionManager, _Session

pytestmark = pytest.mark.unit

# What the worker sends for ``shutdown`` before it goes (``_serve_commands``).
SHUTDOWN_REPLY: dict[str, Any] = {"type": "result", "seq": -1, "payload": None}


class _Ctrl:
    """The control end of a session that is closed just before the request is sent:
    the caller has checked ``closed`` by then, and ``_close_session`` sets it before
    it sends ``shutdown``."""

    def __init__(self) -> None:
        self.session: _Session | None = None
        self.sent: list[dict[str, Any]] = []

    def send(self, message: dict[str, Any]) -> None:
        assert self.session is not None
        self.session.closed = True
        self.sent.append(message)

    def close(self) -> None:
        return None


class _Data:
    """The data end, with the replies the worker left on it."""

    def __init__(self, *replies: dict[str, Any]) -> None:
        self._replies = list(replies)

    def recv(self) -> dict[str, Any]:
        return self._replies.pop(0)

    def close(self) -> None:
        return None


class _FakeRequest:
    """Minimal stand-in exposing ``app.state.session_manager`` for the route."""

    def __init__(self, mgr: SessionManager) -> None:
        self.app = type("_App", (), {"state": type("_State", (), {"session_manager": mgr})()})()


def _manager(*replies: dict[str, Any]) -> tuple[SessionManager, _Ctrl]:
    """A manager with one session, ``s1``, that is closed under its next request and
    whose worker left ``replies`` to read."""
    mgr = SessionManager()
    ctrl = _Ctrl()
    sess = _Session(
        session_id="s1", process=None, ctrl=ctrl, data=_Data(*replies), abort_event=None
    )
    ctrl.session = sess
    mgr._sessions["s1"] = sess  # noqa: SLF001
    return mgr, ctrl


def test_invoke_takes_the_answer_to_a_shutdown_for_a_session_that_is_gone() -> None:
    mgr, ctrl = _manager(SHUTDOWN_REPLY)

    with pytest.raises(SessionExpiredError, match="is not active"):
        asyncio.run(mgr.invoke("s1", "topology"))

    assert [message["op"] for message in ctrl.sent] == ["topology"]


def test_invoke_hands_on_its_own_reply_from_a_session_closed_meanwhile() -> None:
    # The request reached the worker before the ``shutdown`` did: the reply is the
    # request's own, and the caller gets it.
    mgr, _ = _manager({"type": "result", "seq": 1, "payload": {"state": "loaded"}})

    assert asyncio.run(mgr.invoke("s1", "topology")) == {"state": "loaded"}


def test_invoke_streaming_takes_the_answer_to_a_shutdown_for_a_session_that_is_gone() -> None:
    mgr, _ = _manager(SHUTDOWN_REPLY)

    with pytest.raises(SessionExpiredError, match="is not active"):
        asyncio.run(mgr.invoke_streaming("s1", "run_tds", {"tf": 1.0}))


def test_invoke_streaming_hands_on_its_own_result_from_a_session_closed_meanwhile() -> None:
    mgr, _ = _manager({"type": "result", "seq": 1, "payload": {"converged": True}})

    assert asyncio.run(mgr.invoke_streaming("s1", "run_tds", {"tf": 1.0})) == {"converged": True}


def test_the_topology_route_answers_404_when_the_session_is_closed_under_it() -> None:
    mgr, _ = _manager(SHUTDOWN_REPLY)

    with pytest.raises(HTTPException) as refused:
        asyncio.run(get_topology("s1", _FakeRequest(mgr)))  # type: ignore[arg-type]

    assert refused.value.status_code == 404
