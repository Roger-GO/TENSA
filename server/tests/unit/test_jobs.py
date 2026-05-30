"""Unit 1 tests — `_JobRegistry` lifecycle, retention, coalescing, and
concurrency.

These tests run the registry in isolation (no SessionManager, no FastAPI,
no worker). The registry's contract is the focus: every public method
behaves correctly across happy paths, edge cases, and concurrent access.
"""

from __future__ import annotations

import threading

import pytest

from andes_app.core.jobs import (
    MAX_FAILED_DISTINCT,
    MAX_SUCCESSFUL,
    MAX_TOTAL,
    JobRecord,
    _JobRegistry,
)


@pytest.fixture
def registry() -> _JobRegistry:
    return _JobRegistry()


def _problem(category: str = "TestError", detail: str = "boom") -> dict[str, object]:
    return {"category": category, "detail": detail, "status": 422}


# ---- happy paths ------------------------------------------------------------


def test_register_creates_pending_job_with_unique_id(registry: _JobRegistry) -> None:
    a = registry.register_job(kind="pflow", can_cancel=False)
    b = registry.register_job(kind="pflow", can_cancel=False)

    assert a != b
    record = registry.get_job(a)
    assert record is not None
    assert record.id == a
    assert record.kind == "pflow"
    assert record.status == "pending"
    assert record.can_cancel is False
    assert record.progress is None
    assert record.ended_at is None
    assert record.result_ref is None
    assert record.problem is None
    assert record.repeated_count == 0


def test_register_records_request_summary(registry: _JobRegistry) -> None:
    summary = {"tf": 10.0, "integrator": "trapezoidal"}
    job_id = registry.register_job(
        kind="tds-batch", can_cancel=True, request_summary=summary
    )

    record = registry.get_job(job_id)
    assert record is not None
    assert record.request_summary == summary


def test_lifecycle_running_then_done(registry: _JobRegistry) -> None:
    job_id = registry.register_job(kind="eig", can_cancel=False)
    registry.mark_running(job_id)
    running = registry.get_job(job_id)
    assert running is not None
    assert running.status == "running"

    registry.mark_done(job_id, result_ref="run-123")
    done = registry.get_job(job_id)
    assert done is not None
    assert done.status == "done"
    assert done.result_ref == "run-123"
    assert done.ended_at is not None


def test_lifecycle_running_then_failed(registry: _JobRegistry) -> None:
    job_id = registry.register_job(kind="se", can_cancel=False)
    registry.mark_running(job_id)
    registry.mark_failed(job_id, problem=_problem("SeNonConvergentError"))

    record = registry.get_job(job_id)
    assert record is not None
    assert record.status == "failed"
    assert record.problem is not None
    assert record.problem["category"] == "SeNonConvergentError"
    assert record.ended_at is not None


def test_mark_cancelled(registry: _JobRegistry) -> None:
    job_id = registry.register_job(kind="tds-stream", can_cancel=True)
    registry.mark_running(job_id)
    registry.mark_cancelled(job_id)

    record = registry.get_job(job_id)
    assert record is not None
    assert record.status == "cancelled"
    assert record.ended_at is not None


def test_update_progress_clamps_to_unit_interval(registry: _JobRegistry) -> None:
    job_id = registry.register_job(kind="cpf", can_cancel=False)
    registry.mark_running(job_id)

    registry.update_progress(job_id, 0.5)
    assert registry.get_job(job_id).progress == 0.5  # type: ignore[union-attr]

    registry.update_progress(job_id, -0.3)
    assert registry.get_job(job_id).progress == 0.0  # type: ignore[union-attr]

    registry.update_progress(job_id, 2.5)
    assert registry.get_job(job_id).progress == 1.0  # type: ignore[union-attr]


# ---- idempotency ------------------------------------------------------------


def test_mark_running_idempotent_for_already_running(
    registry: _JobRegistry,
) -> None:
    job_id = registry.register_job(kind="pflow", can_cancel=False)
    registry.mark_running(job_id)
    first = registry.get_job(job_id)
    assert first is not None
    first_updated = first.updated_at

    registry.mark_running(job_id)
    second = registry.get_job(job_id)
    assert second is not None
    assert second.status == "running"
    # The second mark_running call is a no-op; updated_at should not change.
    assert second.updated_at == first_updated


def test_mark_done_does_not_overwrite_terminal(registry: _JobRegistry) -> None:
    job_id = registry.register_job(kind="pflow", can_cancel=False)
    registry.mark_failed(job_id, problem=_problem("PFlowDivergence"))
    registry.mark_done(job_id)

    record = registry.get_job(job_id)
    assert record is not None
    assert record.status == "failed"


def test_update_progress_noop_on_terminal(registry: _JobRegistry) -> None:
    job_id = registry.register_job(kind="eig", can_cancel=False)
    registry.mark_done(job_id)
    registry.update_progress(job_id, 0.5)

    record = registry.get_job(job_id)
    assert record is not None
    assert record.progress is None


def test_mutations_on_unknown_job_are_silent_noops(
    registry: _JobRegistry,
) -> None:
    registry.mark_running("not-a-real-id")
    registry.mark_done("not-a-real-id")
    registry.mark_failed("not-a-real-id", problem=_problem())
    registry.mark_cancelled("not-a-real-id")
    registry.update_progress("not-a-real-id", 0.5)

    assert registry.get_job("not-a-real-id") is None
    assert registry.list_jobs() == []


# ---- defensive copies -------------------------------------------------------


def test_get_returns_defensive_copy(registry: _JobRegistry) -> None:
    job_id = registry.register_job(
        kind="pflow", can_cancel=False, request_summary={"k": "v"}
    )
    record = registry.get_job(job_id)
    assert record is not None
    record.request_summary["k"] = "MUTATED"

    fresh = registry.get_job(job_id)
    assert fresh is not None
    assert fresh.request_summary == {"k": "v"}


def test_list_returns_defensive_copies(registry: _JobRegistry) -> None:
    job_id = registry.register_job(kind="pflow", can_cancel=False)
    [record] = registry.list_jobs()
    record.status = "done"  # mutate the copy
    fresh = registry.get_job(job_id)
    assert fresh is not None
    assert fresh.status == "pending"


# ---- list filters -----------------------------------------------------------


def test_list_filter_by_kind(registry: _JobRegistry) -> None:
    pf = registry.register_job(kind="pflow", can_cancel=False)
    registry.register_job(kind="eig", can_cancel=False)

    pflow_jobs = registry.list_jobs(kind="pflow")
    assert len(pflow_jobs) == 1
    assert pflow_jobs[0].id == pf


def test_list_filter_by_status(registry: _JobRegistry) -> None:
    a = registry.register_job(kind="pflow", can_cancel=False)
    b = registry.register_job(kind="pflow", can_cancel=False)
    registry.mark_done(a)

    done_jobs = registry.list_jobs(status="done")
    assert len(done_jobs) == 1
    assert done_jobs[0].id == a

    pending_jobs = registry.list_jobs(status="pending")
    assert len(pending_jobs) == 1
    assert pending_jobs[0].id == b


def test_list_returns_insertion_order(registry: _JobRegistry) -> None:
    ids = [registry.register_job(kind="pflow", can_cancel=False) for _ in range(5)]
    listed = [r.id for r in registry.list_jobs()]
    assert listed == ids


# ---- sticky-first failure coalescing (KTD-19 + adversarial F3) --------------


def test_duplicate_failure_signatures_coalesce_to_first_occurrence(
    registry: _JobRegistry,
) -> None:
    problem = _problem("PFlowDivergence", "max_iter reached")
    first = registry.register_job(kind="pflow", can_cancel=False)
    registry.mark_failed(first, problem=problem)

    first_record = registry.get_job(first)
    assert first_record is not None
    first_started_at = first_record.started_at

    # 20 cascade-failure clones of the same problem.
    for _ in range(20):
        cascade_id = registry.register_job(kind="pflow", can_cancel=False)
        registry.mark_failed(cascade_id, problem=problem)
        # The cascade record should be gone (collapsed into ``first``).
        assert registry.get_job(cascade_id) is None

    surviving = registry.list_jobs(status="failed")
    assert len(surviving) == 1
    assert surviving[0].id == first
    assert surviving[0].started_at == first_started_at
    assert surviving[0].repeated_count == 20


def test_distinct_failure_signatures_stay_separate(
    registry: _JobRegistry,
) -> None:
    a = registry.register_job(kind="pflow", can_cancel=False)
    registry.mark_failed(a, problem=_problem("PFlowDivergence", "max_iter"))

    b = registry.register_job(kind="pflow", can_cancel=False)
    registry.mark_failed(b, problem=_problem("PFlowDivergence", "matrix singular"))

    failed = registry.list_jobs(status="failed")
    assert len(failed) == 2


def test_mark_failed_returns_surviving_id_on_coalesce(
    registry: _JobRegistry,
) -> None:
    """``mark_failed`` returns the SURVIVING record's id so callers broadcast
    the right id when a fresh failure coalesces into a prior one (otherwise the
    terminal WS envelope is dropped and the activity panel spins forever)."""
    problem = _problem("PFlowDivergence", "max_iter reached")
    first = registry.register_job(kind="pflow", can_cancel=False)
    survivor_first = registry.mark_failed(first, problem=problem)
    # No prior signature → the just-passed id is the survivor.
    assert survivor_first == first

    second = registry.register_job(kind="pflow", can_cancel=False)
    survivor_second = registry.mark_failed(second, problem=problem)
    # Coalesced into ``first`` → that prior id is the survivor, and the
    # just-passed (deleted) id resolves to None.
    assert survivor_second == first
    assert registry.get_job(second) is None
    survivor_record = registry.get_job(survivor_second)
    assert survivor_record is not None
    assert survivor_record.repeated_count == 1


def test_mark_failed_does_not_overwrite_terminal(registry: _JobRegistry) -> None:
    """Symmetric with ``test_mark_done_does_not_overwrite_terminal``: a late
    driver error must NOT flip a ``cancelled`` / ``done`` record to ``failed``
    (the cancel path does not abort the work synchronously, so a post-cancel
    error can race the cancel transition)."""
    # done → mark_failed is a no-op.
    done_id = registry.register_job(kind="pflow", can_cancel=False)
    registry.mark_done(done_id)
    survivor = registry.mark_failed(done_id, problem=_problem("PFlowDivergence"))
    assert survivor == done_id
    rec = registry.get_job(done_id)
    assert rec is not None and rec.status == "done"

    # cancelled → mark_failed is a no-op.
    cancelled_id = registry.register_job(kind="sweep", can_cancel=True)
    registry.mark_running(cancelled_id)
    registry.mark_cancelled(cancelled_id)
    registry.mark_failed(cancelled_id, problem=_problem("SweepError"))
    rec2 = registry.get_job(cancelled_id)
    assert rec2 is not None and rec2.status == "cancelled"


# ---- retention --------------------------------------------------------------


def test_successful_jobs_evict_at_max_successful(registry: _JobRegistry) -> None:
    ids: list[str] = []
    for _ in range(MAX_SUCCESSFUL + 5):
        job_id = registry.register_job(kind="pflow", can_cancel=False)
        registry.mark_done(job_id)
        ids.append(job_id)

    surviving = {r.id for r in registry.list_jobs(status="done")}
    assert len(surviving) == MAX_SUCCESSFUL
    # The 5 oldest dropped, the newest 50 survive.
    assert set(ids[5:]) == surviving


def test_in_flight_jobs_never_evict(registry: _JobRegistry) -> None:
    # Register enough successful jobs to trip the overall cap.
    in_flight = [
        registry.register_job(kind="pflow", can_cancel=False) for _ in range(10)
    ]
    # The 10 above stay ``pending`` — they MUST survive.
    for _ in range(MAX_TOTAL + 5):
        job_id = registry.register_job(kind="pflow", can_cancel=False)
        registry.mark_done(job_id)

    pending = {r.id for r in registry.list_jobs(status="pending")}
    assert set(in_flight) <= pending


def test_failures_evict_oldest_distinct_at_cap(registry: _JobRegistry) -> None:
    # Generate MAX_FAILED_DISTINCT + 3 unique signatures; the 3 oldest evict.
    ids: list[str] = []
    for n in range(MAX_FAILED_DISTINCT + 3):
        job_id = registry.register_job(kind="pflow", can_cancel=False)
        registry.mark_failed(
            job_id, problem=_problem("PFlowDivergence", f"distinct-{n}")
        )
        ids.append(job_id)

    failed = {r.id for r in registry.list_jobs(status="failed")}
    assert len(failed) == MAX_FAILED_DISTINCT
    # The 3 oldest dropped.
    assert set(ids[:3]).isdisjoint(failed)


def test_overall_cap_evicts_oldest_terminal(registry: _JobRegistry) -> None:
    # Mix done + cancelled + pending up to MAX_TOTAL + 5.
    pending_ids = [
        registry.register_job(kind="pflow", can_cancel=False) for _ in range(20)
    ]
    cancelled_ids: list[str] = []
    for _ in range(30):
        job_id = registry.register_job(kind="tds-stream", can_cancel=True)
        registry.mark_running(job_id)
        registry.mark_cancelled(job_id)
        cancelled_ids.append(job_id)
    done_ids: list[str] = []
    for _ in range(MAX_TOTAL):
        job_id = registry.register_job(kind="pflow", can_cancel=False)
        registry.mark_done(job_id)
        done_ids.append(job_id)

    all_pending = {r.id for r in registry.list_jobs(status="pending")}
    # All 20 pending must survive.
    assert set(pending_ids) <= all_pending
    # Combined count is at most MAX_TOTAL.
    assert len(registry.list_jobs()) <= MAX_TOTAL


# ---- concurrency ------------------------------------------------------------


def test_concurrent_register_and_list_does_not_drop_records(
    registry: _JobRegistry,
) -> None:
    registered: list[str] = []
    register_lock = threading.Lock()
    barrier = threading.Barrier(8)

    def register_many() -> None:
        barrier.wait()
        for _ in range(50):
            job_id = registry.register_job(kind="pflow", can_cancel=False)
            with register_lock:
                registered.append(job_id)

    threads = [threading.Thread(target=register_many) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    listed = {r.id for r in registry.list_jobs()}
    # 8 threads × 50 jobs = 400 registrations; the registry caps at
    # MAX_TOTAL = 100. After eviction the in-flight (pending) records
    # must all survive — eviction never touches non-terminal records.
    # So the count of listed jobs equals the registry's surviving set,
    # AND every registered id is either in the listed set OR has been
    # marked terminal (none were, here).
    assert len(listed) == len(registered)
    assert listed == set(registered)


def test_concurrent_failed_marks_coalesce_to_count(registry: _JobRegistry) -> None:
    problem = _problem("PFlowDivergence", "concurrent-cascade")
    ids = [
        registry.register_job(kind="pflow", can_cancel=False) for _ in range(50)
    ]
    barrier = threading.Barrier(50)

    def fail_one(job_id: str) -> None:
        barrier.wait()
        registry.mark_failed(job_id, problem=problem)

    threads = [threading.Thread(target=fail_one, args=(jid,)) for jid in ids]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    failed = registry.list_jobs(status="failed")
    assert len(failed) == 1
    # 50 mark_failed calls; first becomes the canonical record;
    # the other 49 each increment repeated_count by 1.
    assert failed[0].repeated_count == 49


# ---- type validation --------------------------------------------------------


def test_jobrecord_is_a_dataclass_with_expected_fields() -> None:
    """Defends against accidental schema drift on the JobRecord shape —
    every consumer (substrate, schemas.py, web codegen) treats these
    names as load-bearing."""
    record = JobRecord(
        id="x",
        kind="pflow",
        status="pending",
        started_at=0.0,
        updated_at=0.0,
        can_cancel=False,
    )
    # Required fields with defaults.
    assert record.request_summary == {}
    assert record.progress is None
    assert record.ended_at is None
    assert record.result_ref is None
    assert record.problem is None
    assert record.repeated_count == 0
