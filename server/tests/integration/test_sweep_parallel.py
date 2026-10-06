"""A long sensitivity sweep runs on sub-workers, against real worker processes.

The session manager spreads a sweep of four or more values over up to
``sweep_workers`` extra worker processes, and leaves the session's own worker (and
its System) alone. These tests drive ``SessionManager`` directly, with IEEE 14, and
check what has to stay true when the work moves:

- the iterations record exactly what a sequential sweep records, in order, and the
  session's System is as it was;
- a sweep that is aborted, cancelled, or loses a worker ends cleanly: the
  sub-workers are gone and the session still answers, an abort included;
- a sweep that cannot or need not be shared (too short, a setting of one, a
  snapshot the worker cannot read) runs on the session's worker as before.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import shutil
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import pytest

from tensa.core.disturbance import FaultSpec
from tensa.core.session import SessionManager, _SweepBuffer
from tensa.core.session import sweeps as sweeps_module
from tensa.core.wrapper import Wrapper

pytestmark = pytest.mark.integration

FAULT_TC = "disturbance.fault.tc"
# The first two ride out the fault, the last two lose synchronism: rows that differ,
# so a sub-worker that ignored the swept value would not match the reference.
DISCRIMINATING_VALUES = [1.02, 1.08, 1.11, 1.14]
DISCRIMINATING_SIM = {"tf": 1.6, "h": 0.02}
# Cheap iterations (about 0.6 s each) for the tests that interrupt a sweep.
QUICK_VALUES = [1.02 + 0.002 * i for i in range(12)]
QUICK_SIM = {"tf": 0.5, "h": 0.01}


def _ieee14() -> tuple[Path, Path]:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    return cases / "ieee14.raw", cases / "ieee14.dyr"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    for source in _ieee14():
        shutil.copy2(source, ws / source.name)
    return ws


@pytest.fixture
async def manager(workspace: Path) -> AsyncIterator[SessionManager]:
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0, workspace=str(workspace), sweep_workers=3)
    await mgr.start()
    try:
        yield mgr
    finally:
        await mgr.shutdown()


FAULT = {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0}


async def _seed(mgr: SessionManager, workspace: Path, snapshot: str = "base") -> str:
    """A session on IEEE 14 with one fault, a solved power flow and a saved snapshot."""
    sid = await mgr.create_session()
    await mgr.invoke(
        sid,
        "load_case",
        {"path": str(workspace / "ieee14.raw"), "addfiles": [str(workspace / "ieee14.dyr")]},
    )
    await mgr.invoke(sid, "add_disturbance", {"spec": FAULT})
    await mgr.invoke(sid, "run_pflow", {})
    await mgr.invoke(sid, "save_snapshot", {"name": snapshot})
    return sid


def _sweep_args(
    values: list[float], sim: dict[str, float], snapshot: str = "base"
) -> dict[str, Any]:
    return {
        "snapshot_name": snapshot,
        "parameter_kind": FAULT_TC,
        "parameter_target": 0,
        "values": values,
        "tf": sim["tf"],
        "h": sim["h"],
    }


def _sub_workers() -> list[multiprocessing.process.BaseProcess]:
    return [p for p in multiprocessing.active_children() if p.name.startswith("andes-sweep-")]


async def _until(condition: Callable[[], bool], what: str, timeout: float = 90.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not condition():
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail(f"timed out waiting for {what}")
        await asyncio.sleep(0.02)


async def _finished(mgr: SessionManager, sweep_id: str) -> _SweepBuffer:
    buf = mgr.get_sweep_buffer(sweep_id)
    assert buf is not None
    await _until(lambda: buf.state in {"completed", "error", "aborted"}, "the sweep to finish")
    return buf


def _comparable(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row[k] for k in ("iteration", "parameter_value", "converged", "callpert_count", "error")}


def _rows_match(got: list[dict[str, Any]], expected: list[dict[str, Any]]) -> None:
    assert [_comparable(r) for r in got] == [_comparable(r) for r in expected]
    assert [r["final_t"] for r in got] == pytest.approx([r["final_t"] for r in expected])


def _fail_if_a_pool_is_built(monkeypatch: pytest.MonkeyPatch) -> None:
    def _no_pool(**_kwargs: Any) -> None:
        raise AssertionError("this sweep must run on the session's worker")

    monkeypatch.setattr(sweeps_module, "SweepWorkerPool", _no_pool)


# ---- the same results, the session left alone ---------------------------------


async def test_a_parallel_sweep_records_what_a_sequential_one_does_and_spares_the_session(
    manager: SessionManager, workspace: Path
) -> None:
    sid = await _seed(manager, workspace)
    # The reference: the same sweep, run in this process one value after another.
    raw, dyr = workspace / "ieee14.raw", workspace / "ieee14.dyr"
    reference = Wrapper(workspace=workspace)
    reference.load_case(raw, addfiles=[dyr])
    expected = reference.run_sweep(
        snapshot_name="base",
        parameter_kind=FAULT_TC,
        parameter_target=0,
        values=DISCRIMINATING_VALUES,
        tf=DISCRIMINATING_SIM["tf"],
        h=DISCRIMINATING_SIM["h"],
    )["iterations"]
    assert len({r["converged"] for r in expected}) == 2, "the reference must differ across values"

    sweep_id = await manager.start_sweep(sid, _sweep_args(DISCRIMINATING_VALUES, DISCRIMINATING_SIM))
    buf = await _finished(manager, sweep_id)

    assert buf.state == "completed", buf.error
    assert buf.truncated is False
    # Four values on a setting of three: two workers, two values each.
    _rows_match(buf.iterations, expected)
    # Progress was released in index order, whatever order the workers finished in.
    assert [r["iteration"] for r in buf.iterations] == [0, 1, 2, 3]
    assert buf.completed_iterations == 4
    # The sweep's own workers are gone by the time it reports it is over.
    assert _sub_workers() == []
    # The session's System was not reloaded: its disturbance log still holds the
    # fault as it was added, where a sequential sweep leaves the last override.
    log = await manager.invoke(sid, "list_disturbances", {})
    assert [spec["tc"] for spec in log] == [1.1]
    record = manager._sessions[sid].job_registry.get_job(sweep_id)
    assert record is not None and record.status == "done"
    assert not manager._sessions[sid].abort_event.is_set()


async def test_a_sweep_too_short_to_share_runs_on_the_session_worker(
    manager: SessionManager, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sid = await _seed(manager, workspace)
    _fail_if_a_pool_is_built(monkeypatch)
    values = [1.02, 1.05, 1.08]

    sweep_id = await manager.start_sweep(sid, _sweep_args(values, QUICK_SIM))
    buf = await _finished(manager, sweep_id)

    assert buf.state == "completed", buf.error
    assert [r["parameter_value"] for r in buf.iterations] == values
    assert all(r["error"] is None for r in buf.iterations)
    # The session's own worker ran it: it ends on the last value's reload.
    log = await manager.invoke(sid, "list_disturbances", {})
    assert [spec["tc"] for spec in log] == [1.08]


async def test_a_setting_of_one_keeps_every_sweep_on_the_session_worker(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mgr = SessionManager(max_sessions=1, workspace=str(workspace), sweep_workers=1)
    await mgr.start()
    try:
        sid = await _seed(mgr, workspace)
        _fail_if_a_pool_is_built(monkeypatch)

        sweep_id = await mgr.start_sweep(sid, _sweep_args([1.02, 1.03, 1.04, 1.05], QUICK_SIM))
        buf = await _finished(mgr, sweep_id)

        assert buf.state == "completed", buf.error
        assert len(buf.iterations) == 4
    finally:
        await mgr.shutdown()


async def test_a_snapshot_the_session_worker_cannot_read_runs_on_the_session_worker(
    manager: SessionManager, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The plan is refused, so no sub-workers are started for a sweep that could do
    nothing, and every iteration reports the error as it always has."""
    sid = await _seed(manager, workspace)
    _fail_if_a_pool_is_built(monkeypatch)

    sweep_id = await manager.start_sweep(
        sid, _sweep_args(QUICK_VALUES[:6], QUICK_SIM, snapshot="no-such-snapshot")
    )
    buf = await _finished(manager, sweep_id)

    assert buf.state == "completed"
    assert len(buf.iterations) == 6
    assert all(r["error"].startswith("SnapshotNotFoundError: ") for r in buf.iterations)


async def test_cancelling_a_sequential_sweep_still_cancels_its_task(
    workspace: Path,
) -> None:
    """``tests/integration/test_sweep_job_id.py`` cancels a sweep long enough to
    share, which now runs on sub-workers. This keeps the same check on the sweep that
    runs on the session's own worker."""
    mgr = SessionManager(max_sessions=1, workspace=str(workspace), sweep_workers=1)
    await mgr.start()
    try:
        sid = await _seed(mgr, workspace)
        sweep_id = await mgr.start_sweep(sid, _sweep_args(QUICK_VALUES[:8], QUICK_SIM))
        buf = mgr.get_sweep_buffer(sweep_id)
        assert buf is not None
        task = mgr._sweep_tasks[sweep_id]
        await _until(lambda: buf.completed_iterations >= 1, "the first iteration")

        mgr.cancel_session_job(sid, sweep_id)

        with pytest.raises(asyncio.CancelledError):
            await task
        assert buf.state == "aborted"
        record = mgr._sessions[sid].job_registry.get_job(sweep_id)
        assert record is not None and record.status == "cancelled"
        assert _sub_workers() == []
    finally:
        await mgr.shutdown()


async def test_a_pool_that_cannot_start_falls_back_to_the_session_worker(
    manager: SessionManager, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sid = await _seed(manager, workspace)
    real_pool = sweeps_module.SweepWorkerPool

    class _NoStart(real_pool):  # type: ignore[valid-type, misc]
        async def start(self) -> None:
            raise OSError("cannot fork")

    monkeypatch.setattr(sweeps_module, "SweepWorkerPool", _NoStart)

    sweep_id = await manager.start_sweep(sid, _sweep_args(QUICK_VALUES[:4], QUICK_SIM))
    buf = await _finished(manager, sweep_id)

    assert buf.state == "completed", buf.error
    assert len(buf.iterations) == 4
    assert all(r["error"] is None for r in buf.iterations)
    assert _sub_workers() == []


async def test_workers_that_die_before_taking_the_case_fall_back_to_the_session_worker(
    manager: SessionManager, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The processes start but are gone before the sweep reaches them (a crash at
    import, a kill by the OS), so no iteration ever runs on them. That is not a
    sweep that lost its workers: the session's own worker runs it."""
    sid = await _seed(manager, workspace)
    real_pool = sweeps_module.SweepWorkerPool

    class _DiesOnStart(real_pool):  # type: ignore[valid-type, misc]
        async def start(self) -> None:
            await super().start()
            for worker in self._workers:
                worker.process.kill()
                worker.process.join()

    monkeypatch.setattr(sweeps_module, "SweepWorkerPool", _DiesOnStart)

    sweep_id = await manager.start_sweep(sid, _sweep_args(QUICK_VALUES[:4], QUICK_SIM))
    buf = await _finished(manager, sweep_id)

    assert buf.state == "completed", buf.error
    assert buf.truncated is False
    assert [r["parameter_value"] for r in buf.iterations] == QUICK_VALUES[:4]
    assert all(r["error"] is None for r in buf.iterations)
    assert _sub_workers() == []
    # The session's own worker ran it: it ends on the last value's reload.
    log = await manager.invoke(sid, "list_disturbances", {})
    assert [spec["tc"] for spec in log] == [QUICK_VALUES[3]]
    assert not manager._sessions[sid].abort_event.is_set()


async def test_a_blank_session_sweeps_in_parallel_from_its_recorded_additions(
    manager: SessionManager, workspace: Path
) -> None:
    """A session built from scratch has no case file, so each sub-worker rebuilds it
    from the recorded additions."""
    elements: list[tuple[str, dict[str, Any]]] = [
        ("Bus", {"idx": "1", "name": "B1", "Vn": 110}),
        ("Bus", {"idx": "2", "name": "B2", "Vn": 110}),
        ("Slack", {"idx": "1", "name": "S1", "bus": "1", "Sn": 100, "Vn": 110, "v0": 1.0}),
        ("PQ", {"idx": "1", "name": "L1", "bus": "2", "Vn": 110, "p0": 0.5, "q0": 0.2}),
        ("Line", {"idx": "L1", "name": "Ln", "bus1": "1", "bus2": "2", "r": 0.01, "x": 0.06}),
        (
            "GENCLS",
            {"idx": "1", "name": "G1", "bus": "1", "gen": "1", "Sn": 100, "Vn": 110, "M": 6},
        ),
    ]
    fault = FaultSpec(bus_idx="2", tf=0.2, tc=0.3, xf=0.01, rf=0.0)
    # The reference is built the same way in this process; its sequential sweep reads
    # the snapshot the session saves below.
    reference = Wrapper(workspace=workspace)
    reference.create_blank()
    sid = await manager.create_session()
    await manager.invoke(sid, "create_blank", {})
    for model, params in elements:
        reference.add_element(model, dict(params))
        await manager.invoke(sid, "add_element", {"model": model, "params": dict(params)})
    await manager.invoke(sid, "add_disturbance", {"spec": fault.model_dump()})
    await manager.invoke(sid, "run_pflow", {})
    await manager.invoke(sid, "save_snapshot", {"name": "blank"})
    values = [0.25, 0.3, 0.35, 0.4]
    sim = {"tf": 1.0, "h": 0.01}
    # The reference holds the fault too. Each iteration's reload has to drop what
    # is committed, or the fault would be on the System once more per value.
    reference.add_disturbance(fault)
    expected = reference.run_sweep(
        snapshot_name="blank",
        parameter_kind="disturbance.fault.tc",
        parameter_target=0,
        values=values,
        tf=sim["tf"],
        h=sim["h"],
    )["iterations"]
    assert reference.list_disturbances() == [fault.model_copy(update={"tc": values[-1]})]
    assert reference._ss is not None and reference._ss.Fault.n == 1

    sweep_id = await manager.start_sweep(
        sid,
        {**_sweep_args(values, sim, snapshot="blank"), "parameter_kind": "disturbance.fault.tc"},
    )
    buf = await _finished(manager, sweep_id)

    assert buf.state == "completed", buf.error
    assert all(r["error"] is None for r in buf.iterations), buf.iterations
    _rows_match(buf.iterations, expected)


# ---- ending a parallel sweep ---------------------------------------------------


async def test_aborting_a_parallel_sweep_stops_its_workers_and_leaves_the_session_usable(
    manager: SessionManager, workspace: Path
) -> None:
    sid = await _seed(manager, workspace)
    sweep_id = await manager.start_sweep(sid, _sweep_args(QUICK_VALUES, QUICK_SIM))
    buf = manager.get_sweep_buffer(sweep_id)
    assert buf is not None
    await _until(lambda: buf.completed_iterations >= 1, "the first iteration")

    await manager.signal_abort(sid)
    await _finished(manager, sweep_id)

    # Cancelling the work is not a failure: the sweep ends with what it had.
    assert buf.state == "completed", buf.error
    assert buf.truncated is True
    done = len(buf.iterations)
    assert 1 <= done < len(QUICK_VALUES)
    assert [r["iteration"] for r in buf.iterations] == list(range(done))
    assert _sub_workers() == []
    sess = manager._sessions[sid]
    assert not sess.abort_event.is_set()
    # The session answers, and the next abort does not hang on a dead waiter.
    assert await manager.invoke(sid, "list_disturbances", {})
    await asyncio.wait_for(manager.signal_abort(sid), 10.0)


@pytest.mark.parametrize("when", ["workers-start", "first-row"])
async def test_cancelling_a_parallel_sweep_terminates_its_workers(
    manager: SessionManager, workspace: Path, when: str
) -> None:
    sid = await _seed(manager, workspace)
    sweep_id = await manager.start_sweep(sid, _sweep_args(QUICK_VALUES, QUICK_SIM))
    buf = manager.get_sweep_buffer(sweep_id)
    assert buf is not None
    task = manager._sweep_tasks[sweep_id]
    if when == "workers-start":
        await _until(lambda: bool(_sub_workers()), "the sub-workers to start")
    else:
        await _until(lambda: buf.completed_iterations >= 1, "the first iteration")

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert buf.state == "aborted"
    assert _sub_workers() == [], "the sweep's workers outlived it"
    sess = manager._sessions[sid]
    assert sess.sweep_in_progress is None
    # Workers were killed mid-iteration: the session's abort must still work, and the
    # session itself was never involved, so it still serves requests.
    assert await manager.invoke(sid, "list_disturbances", {})
    await asyncio.wait_for(manager.signal_abort(sid), 10.0)


async def test_shutting_the_manager_down_during_a_parallel_sweep_leaves_no_workers(
    workspace: Path,
) -> None:
    mgr = SessionManager(max_sessions=1, workspace=str(workspace), sweep_workers=3)
    await mgr.start()
    sid = await _seed(mgr, workspace)
    sweep_id = await mgr.start_sweep(sid, _sweep_args(QUICK_VALUES, QUICK_SIM))
    await _until(lambda: bool(_sub_workers()), "the sub-workers to start")

    await asyncio.wait_for(mgr.shutdown(), 60.0)

    assert _sub_workers() == []
    assert sweep_id not in mgr._sweep_tasks


async def test_a_killed_sub_worker_fails_only_the_iteration_it_was_running(
    manager: SessionManager, workspace: Path
) -> None:
    sid = await _seed(manager, workspace)
    sweep_id = await manager.start_sweep(sid, _sweep_args(QUICK_VALUES, QUICK_SIM))
    buf = manager.get_sweep_buffer(sweep_id)
    assert buf is not None
    await _until(lambda: buf.completed_iterations >= 1, "the first iteration")
    victims = _sub_workers()
    assert victims
    victims[0].kill()

    await _finished(manager, sweep_id)

    # The sweep carries on with the other workers and still reports every iteration.
    assert buf.state == "completed", buf.error
    assert buf.truncated is False
    assert [r["iteration"] for r in buf.iterations] == list(range(len(QUICK_VALUES)))
    failed = [r for r in buf.iterations if r["error"] is not None]
    # The victim lost the iteration it was inside (or none, if it was between two).
    assert len(failed) <= 1
    for row in failed:
        assert row["error"].startswith("SweepWorkerDiedError: ")
        assert row["converged"] is False
    assert _sub_workers() == []
    assert await manager.invoke(sid, "list_disturbances", {})
