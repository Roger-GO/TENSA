"""Unit coverage for the inline ``tds-batch`` job lifecycle (v3.1 Unit 5c).

The batch ``run_tds`` route re-implements the job lifecycle inline (register →
mark_running → mark_done/mark_failed) instead of delegating to ``_run_as_job``,
so it can alias ``job_id`` onto the pre-minted ``run_id``. That re-opened the
"stuck ``running``" trap ``_run_as_job``'s ``except Exception`` arm was written
to close: ``mgr.invoke`` can raise ``SweepInProgressError`` / ``SessionBusyError``
/ ``asyncio.TimeoutError`` — none of which are ``WorkerError`` /
``SessionExpiredError`` — and the worker stays alive so the liveness sweeper
(dead-worker only) never rescues the record.

These tests drive the route coroutine directly (no HTTP layer) with a real
``SessionManager`` + ``_Session`` registry and a patched ``invoke`` that raises
each escaping exception type, asserting the ``tds-batch`` record reconciles to
``failed`` rather than being left ``running`` forever.

Run via ``asyncio.run`` so they need no pytest-asyncio.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from tensa.api.routes.tds import run_tds
from tensa.api.schemas import TdsRunRequest
from tensa.core.errors import SessionBusyError
from tensa.core.session import SessionManager, SweepInProgressError, _Session


class _FakeCtrl:
    def send(self, msg: dict[str, Any]) -> None:  # pragma: no cover - unused
        pass


def _make_manager_with_session(session_id: str = "s1") -> SessionManager:
    mgr = SessionManager()
    sess = _Session(
        session_id=session_id,
        process=None,
        ctrl=_FakeCtrl(),
        data=_FakeCtrl(),
        abort_event=None,
    )
    mgr._sessions[session_id] = sess
    return mgr


class _FakeRequest:
    """Minimal stand-in exposing ``app.state.session_manager`` for the route."""

    def __init__(self, mgr: SessionManager) -> None:
        self.app = type(
            "_App", (), {"state": type("_State", (), {"session_manager": mgr})()}
        )()


def _run_tds_call(mgr: SessionManager, session_id: str = "s1") -> None:
    body = TdsRunRequest(tf=1.0, h=None)
    asyncio.run(run_tds(session_id, body, _FakeRequest(mgr)))


def _only_record(mgr: SessionManager, session_id: str = "s1") -> Any:
    records = mgr.session_job_registry(session_id).list_jobs()
    assert len(records) == 1, records
    return records[0]


@pytest.mark.parametrize(
    "exc",
    [
        SweepInProgressError("sweep-x", iter_done=1, iter_total=3),
        SessionBusyError(),
        TimeoutError(),
        RuntimeError("unexpected boom"),
    ],
    ids=["sweep-in-progress", "session-busy", "timeout", "unexpected"],
)
def test_tds_batch_record_reconciles_to_failed_on_escaping_exception(
    exc: Exception,
) -> None:
    """The tds-batch record must NOT be left ``running`` when ``invoke`` raises
    an exception the inline lifecycle does not explicitly handle. Every such
    exit must transition the record to ``failed`` before the exception
    propagates (the route still raises so the app-level handlers render the
    correct HTTP status)."""
    mgr = _make_manager_with_session()

    async def _raise(*_args: Any, **_kwargs: Any) -> Any:
        raise exc

    mgr.invoke = _raise  # type: ignore[method-assign]

    with pytest.raises(type(exc)):
        _run_tds_call(mgr)

    record = _only_record(mgr)
    assert record.kind == "tds-batch"
    assert record.status == "failed", (
        f"tds-batch left {record.status!r} after {type(exc).__name__}"
    )
    assert record.problem is not None
