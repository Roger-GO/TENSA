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
