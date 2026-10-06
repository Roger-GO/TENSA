"""``_run_as_job`` — the terminal envelope of a failure the registry coalesced away.

When a job fails with the signature of an earlier failed job, ``mark_failed``
deletes the new record and bumps the earlier one. ``_run_as_job`` then sends the
client a terminal envelope for the deleted id, built from a copy it took
beforehand, so the activity pill that saw the job run does not spin forever. That
envelope must carry a stamp from the registry's strictly increasing clock: the
activity panel orders jobs by it, and the raw monotonic clock ticks about every
16 ms on Windows.
"""

from __future__ import annotations

import asyncio
import types
from typing import Any

import pytest

from tensa.api._run_as_job import _run_as_job
from tensa.core import jobs
from tensa.core.jobs import JobRecord, _JobRegistry


class _FakeManager:
    """The three members ``_run_as_job`` reads from a ``SessionManager``."""

    def __init__(self) -> None:
        self.registry = _JobRegistry()
        self.global_job_registry = self.registry
        self.events: list[JobRecord] = []

    def session_job_registry(self, session_id: str) -> _JobRegistry:
        return self.registry

    def broadcast_job_event(self, session_id: str, record: JobRecord) -> None:
        self.events.append(record)


async def _fail(mgr: Any, detail: str) -> str:
    """Run a job that raises ``detail``; return its id."""
    with pytest.raises(RuntimeError, match=detail):
        async with _run_as_job(mgr, "s1", "pflow") as job_id:
            raise RuntimeError(detail)
    return job_id


def test_a_coalesced_failure_gets_a_terminal_envelope_stamped_after_the_survivor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A clock that never moves, as on a coarse Windows tick, and far ahead of the
    # real one so a stamp read from ``time.monotonic()`` directly would be older
    # than every stamp the registry hands out.
    monkeypatch.setattr(jobs, "time", types.SimpleNamespace(monotonic=lambda: 1.0e12))
    monkeypatch.setattr(jobs, "_last_stamp", 0.0)

    async def _run() -> tuple[_FakeManager, str, str]:
        mgr = _FakeManager()
        first = await _fail(mgr, "same problem")
        mgr.events.clear()
        second = await _fail(mgr, "same problem")
        return mgr, first, second

    mgr, first, second = asyncio.run(_run())

    # The second failure collapsed into the first: its record is gone.
    assert mgr.registry.get_job(second) is None
    survivor = mgr.registry.get_job(first)
    assert survivor is not None and survivor.repeated_count == 1

    # pending, running, the synthesized terminal envelope for ``second``, the survivor.
    assert [(e.id, e.status) for e in mgr.events] == [
        (second, "pending"),
        (second, "running"),
        (second, "failed"),
        (first, "failed"),
    ]
    running, terminal, survivor_event = mgr.events[1], mgr.events[2], mgr.events[3]
    assert terminal.ended_at == terminal.updated_at
    assert terminal.updated_at > survivor_event.updated_at
    assert terminal.updated_at > running.updated_at


def test_the_stamps_of_a_failed_job_stay_ordered_when_it_is_not_coalesced() -> None:
    async def _run() -> list[Any]:
        mgr = _FakeManager()
        await _fail(mgr, "only once")
        return list(mgr.events)

    events = asyncio.run(_run())

    assert [e.status for e in events] == ["pending", "running", "failed"]
    assert events[0].updated_at < events[1].updated_at < events[2].updated_at


# --- a refusal for a busy session names the job that holds it -----------------


def test_a_busy_refusal_does_not_name_the_job_it_refuses() -> None:
    """A route's job is running before it asks for the session, so it is the
    newest job in flight when the session is found held, and the gate named it:
    "busy with an in-flight clone-edit operation (job <its own id>)"."""
    from tensa.api._run_as_job import busy_with_another
    from tensa.core.errors import SessionBusyError

    mgr: Any = _FakeManager()
    holder = mgr.registry.register_job(kind="pflow", can_cancel=False)
    mgr.registry.mark_running(holder)
    own = mgr.registry.register_job(kind="clone-edit", can_cancel=False)
    mgr.registry.mark_running(own)
    gate_said = SessionBusyError(current_job=mgr.registry.get_job(own))
    assert f"clone-edit operation (job {own})" in str(gate_said)

    corrected = busy_with_another(gate_said, mgr, "s1", own)

    assert isinstance(corrected, SessionBusyError)
    assert corrected.current_job is not None
    assert corrected.current_job.id == holder
    assert str(corrected) == f"session is busy with an in-flight pflow operation (job {holder})"


def test_a_busy_refusal_names_no_job_when_what_holds_the_session_is_not_one() -> None:
    """A read (the diff of a clone edit, a listing) holds the session without a job."""
    from tensa.api._run_as_job import busy_with_another
    from tensa.core.errors import SessionBusyError

    mgr: Any = _FakeManager()
    own = mgr.registry.register_job(kind="clone-edit", can_cancel=False)
    mgr.registry.mark_running(own)

    corrected = busy_with_another(
        SessionBusyError(current_job=mgr.registry.get_job(own)), mgr, "s1", own
    )

    assert isinstance(corrected, SessionBusyError)
    assert corrected.current_job is None
    assert str(corrected) == "session is busy with an in-flight operation"


def test_a_refusal_that_names_another_job_and_any_other_error_are_left_alone() -> None:
    from tensa.api._run_as_job import busy_with_another
    from tensa.core.errors import SessionBusyError

    mgr: Any = _FakeManager()
    holder = mgr.registry.register_job(kind="pflow", can_cancel=False)
    mgr.registry.mark_running(holder)
    named = SessionBusyError(current_job=mgr.registry.get_job(holder))
    unnamed = SessionBusyError()
    other = RuntimeError("boom")

    assert busy_with_another(named, mgr, "s1", "own") is named
    assert busy_with_another(unnamed, mgr, "s1", "own") is unnamed
    assert busy_with_another(other, mgr, "s1", "own") is other


def test_a_job_refused_for_a_busy_session_fails_with_the_holder_s_name() -> None:
    """Through ``_run_as_job``: what is raised, and what the failed job records."""
    from tensa.core.errors import SessionBusyError

    async def _run() -> None:
        mgr: Any = _FakeManager()
        holder = mgr.registry.register_job(kind="pflow", can_cancel=False)
        mgr.registry.mark_running(holder)

        with pytest.raises(SessionBusyError) as refused:
            async with _run_as_job(mgr, "s1", "clone-edit") as job_id:
                # What ``SessionManager.invoke`` raises: the newest job in flight.
                raise SessionBusyError(current_job=mgr.registry.get_job(job_id))

        assert refused.value.current_job is not None
        assert refused.value.current_job.id == holder
        failed = mgr.registry.get_job(job_id)
        assert failed is not None and failed.status == "failed"
        assert failed.problem is not None
        assert failed.problem["detail"] == (
            f"session is busy with an in-flight pflow operation (job {holder})"
        )
        # The holder is untouched.
        still = mgr.registry.get_job(holder)
        assert still is not None and still.status == "running"

    asyncio.run(_run())
