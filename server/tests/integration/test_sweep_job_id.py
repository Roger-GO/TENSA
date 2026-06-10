"""Integration tests for v3.1 Unit 5c — sweep ``job_id`` reconciliation.

The wire shape GAINS a ``job_id`` field; the legacy ``sweep_id`` is preserved
and the two are IDENTICAL (additive aliasing, nothing removed):

  (a) ``POST /sessions/{id}/sweep`` returns BOTH ``sweep_id`` and ``job_id``,
      identical;
  (b) ``GET /sessions/{id}/jobs/{job_id}`` resolves a ``sweep`` record while the
      sweep is in flight (and through to its terminal ``done`` state).

These stand up the real FastAPI app over a workspace seeded with the IEEE 14
fixtures, driving everything end-to-end through a worker subprocess. A small
3-step sweep on ``Fault.tc`` keeps runtime bounded; the test drains it so the
fixture teardown doesn't hang.
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager


def _bundled_ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def client(
    tmp_path: Path,
) -> AsyncIterator[tuple[httpx.AsyncClient, SessionManager]]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    for name in ["ieee14.raw", "ieee14.dyr"]:
        shutil.copy2(src / name, workspace / name)

    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(
        max_sessions=2, idle_timeout=180.0, workspace=str(workspace)
    )
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac, mgr
    finally:
        await mgr.shutdown()


async def _seed_session_with_fault_snapshot(
    ac: httpx.AsyncClient, snapshot_name: str
) -> str:
    """Create a session, add a Fault disturbance, run PF, save a snapshot."""
    resp = await ac.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    sid = str(resp.json()["session_id"])
    resp = await ac.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw"},
    )
    assert resp.status_code in (200, 201), resp.text
    resp = await ac.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {
                    "kind": "fault",
                    "bus_idx": 5,
                    "tf": 1.0,
                    "tc": 1.1,
                    "xf": 0.0001,
                    "rf": 0.0,
                }
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    resp = await ac.post(
        f"/api/sessions/{sid}/pflow", json={}
    )
    assert resp.status_code == 200, resp.text
    resp = await ac.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": snapshot_name},
    )
    assert resp.status_code == 200, resp.text
    return sid


async def _drain_sweep(mgr: SessionManager, sweep_id: str) -> None:
    deadline = asyncio.get_event_loop().time() + 90.0
    while True:
        buf = mgr.get_sweep_buffer(sweep_id)
        assert buf is not None
        if buf.state in {"completed", "error", "aborted"}:
            return
        if asyncio.get_event_loop().time() > deadline:
            pytest.fail(f"sweep did not finish; state={buf.state}")
        await asyncio.sleep(0.5)


@pytest.mark.integration
async def test_sweep_returns_sweep_id_and_identical_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """POST /sweep returns BOTH sweep_id and job_id; they are identical, and
    GET /jobs/{job_id} resolves a ``sweep`` record."""
    ac, mgr = client
    sid = await _seed_session_with_fault_snapshot(ac, "sweep-jobid")

    resp = await ac.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "disturbance.fault.tc",
                "target": 0,
                "range": {"start": 1.05, "end": 1.15, "steps": 3},
            },
            "sim": {"tf": 0.2, "h": None, "vars": None},
            "snapshot_name": "sweep-jobid",
        },
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()

    sweep_id = body["sweep_id"]
    job_id = body["job_id"]
    assert isinstance(sweep_id, str) and sweep_id
    assert isinstance(job_id, str) and job_id
    # The HARD invariant: job_id is the SAME value as sweep_id (additive alias).
    assert job_id == sweep_id

    # The sweep is a first-class job in the registry; the record resolves while
    # the sweep is still in flight (the gate is set + the record registered
    # synchronously in ``start_sweep``).
    rec = await ac.get(f"/api/sessions/{sid}/jobs/{job_id}")
    assert rec.status_code == 200, rec.text
    record = rec.json()
    assert record["id"] == job_id
    assert record["kind"] == "sweep"
    # ``start_sweep`` calls ``mark_running`` synchronously before returning, so
    # ``pending`` is never observable here — the record is ``running`` (the
    # common case while the gate is held) or already ``done`` if the small
    # sweep raced to completion. ``pending`` in the prior set was dead weight.
    assert record["status"] in ("running", "done")
    assert record["can_cancel"] is True

    # Drain so teardown is fast, then confirm the record reconciled to ``done``.
    await _drain_sweep(mgr, sweep_id)
    rec2 = await ac.get(f"/api/sessions/{sid}/jobs/{job_id}")
    assert rec2.status_code == 200, rec2.text
    assert rec2.json()["status"] == "done"


@pytest.mark.integration
async def test_delete_cancel_of_live_sweep_aborts_the_task(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """DELETE /jobs/{id} for a LIVE sweep must actually cancel the backing
    sweep task (whose ``CancelledError`` arm finishes the sweep ``aborted``),
    not merely flip the record to ``cancelled``.

    Regression for the Phase-2 finding that ``cancel_session_job`` only called
    ``mark_cancelled`` and never cancelled ``self._sweep_tasks[sweep_id]`` — so
    the sweep kept iterating to completion on the worker.
    """
    ac, mgr = client
    sid = await _seed_session_with_fault_snapshot(ac, "sweep-cancel")

    resp = await ac.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "disturbance.fault.tc",
                "target": 0,
                "range": {"start": 1.05, "end": 1.25, "steps": 8},
            },
            "sim": {"tf": 0.5, "h": None, "vars": None},
            "snapshot_name": "sweep-cancel",
        },
    )
    assert resp.status_code == 202, resp.text
    sweep_id = resp.json()["sweep_id"]

    task = mgr._sweep_tasks.get(sweep_id)
    assert task is not None and not task.done()

    resp = await ac.delete(f"/api/sessions/{sid}/jobs/{sweep_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"

    # The REAL abort fired: the backing sweep task was cancelled (not left to
    # run to completion). Awaiting the cancelled task surfaces ``CancelledError``;
    # ``_drive_sweep``'s arm finishes the sweep ``aborted`` and reconciles the
    # registry record. The buffer therefore never reaches ``completed``.
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()
    buf = mgr.get_sweep_buffer(sweep_id)
    assert buf is not None
    assert buf.state != "completed"
    # The registry record is terminal ``cancelled`` (the user's intent), not a
    # spinner that would otherwise hang.
    rec = await ac.get(f"/api/sessions/{sid}/jobs/{sweep_id}")
    assert rec.status_code == 200, rec.text
    assert rec.json()["status"] == "cancelled"
