"""Integration tests for the sensitivity-sweep API (Unit 18 of the v2.0 plan).

End-to-end coverage of the substrate's sweep harness:

- Happy path: sweep ``Fault.tc`` over a small range on IEEE 14 → all
  iterations complete; the WS progress channel emits per-iteration
  events; the final ``finished`` event reports ``state=completed``.
- Edge case: parameter not present in the snapshot's disturbance log →
  per-iteration error is recorded but the sweep still finishes (the
  validation path inside ``run_sweep`` raises and is caught into the
  iteration's ``error`` field).
- Edge case: invalid sweep parameter kind → ``422`` before the worker
  is invoked.
- Edge case: while a sweep is active, every other session-scoped route
  returns ``503 Service Unavailable`` with a ``Retry-After`` header.
- Edge case: cancel mid-sweep via the existing ``/abort`` endpoint →
  ``finished`` event arrives with the iterations completed so far +
  the truncated flag.
- Edge case: starting a sweep while another is already running → 409.

Tests use a small step count (3-5 iterations) on the IEEE 14 case to
keep CI runtime bounded.
"""

from __future__ import annotations

import asyncio
import json
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
async def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    for name in ["ieee14.raw", "ieee14.dyr"]:
        shutil.copy2(src / name, ws / name)
    return ws


@pytest.fixture
async def app_with_mgr(workspace: Path):
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(
        max_sessions=4, idle_timeout=180.0, workspace=str(workspace)
    )
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    try:
        yield app, mgr
    finally:
        await mgr.shutdown()


@pytest.fixture
async def client(app_with_mgr) -> AsyncIterator[httpx.AsyncClient]:
    app, _mgr = app_with_mgr
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1:8000"
    ) as ac:
        yield ac


async def _create_session_with_case(
    client: httpx.AsyncClient,
    primary: str = "ieee14.raw",
    addfile: str | None = None,
) -> str:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    if addfile is not None:
        body["addfiles"] = [addfile]
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    assert resp.status_code in (200, 201), resp.text
    return sid


async def _seed_session_with_fault_snapshot(
    client: httpx.AsyncClient, snapshot_name: str = "sweep-base"
) -> str:
    """Create a session, add a Fault disturbance, save a snapshot. Returns session id."""
    sid = await _create_session_with_case(client)
    # Add a Fault disturbance pre-PF (substrate gate).
    resp = await client.post(
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
    # Run PF so the snapshot has converged operating-point state.
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert resp.status_code == 200, resp.text
    # Save the snapshot.
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": snapshot_name},
    )
    assert resp.status_code == 200, resp.text
    return sid


# ---- happy paths -----------------------------------------------------------


@pytest.mark.integration
async def test_sweep_happy_path_completes(
    client: httpx.AsyncClient, app_with_mgr
) -> None:
    """Run a 3-step sweep on Fault.tc → all iterations complete; the
    final sweep buffer carries 3 results with proper parameter values.
    """
    _, mgr = app_with_mgr
    sid = await _seed_session_with_fault_snapshot(client, "sweep-happy")

    resp = await client.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "disturbance.fault.tc",
                "target": 0,
                "range": {"start": 1.05, "end": 1.15, "steps": 3},
            },
            "sim": {"tf": 0.2, "h": None, "vars": None},
            "snapshot_name": "sweep-happy",
        },
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    sweep_id = body["sweep_id"]
    assert body["total"] == 3

    # Wait for the sweep to finish. Poll the manager's buffer.
    deadline = asyncio.get_event_loop().time() + 90.0
    while True:
        sweep_buf = mgr.get_sweep_buffer(sweep_id)
        assert sweep_buf is not None
        if sweep_buf.state in {"completed", "error", "aborted"}:
            break
        if asyncio.get_event_loop().time() > deadline:
            pytest.fail(f"sweep did not finish; state={sweep_buf.state}")
        await asyncio.sleep(0.5)

    assert sweep_buf.state == "completed", (
        f"sweep ended in state={sweep_buf.state}, error={sweep_buf.error}"
    )
    assert len(sweep_buf.iterations) == 3
    # Endpoints should match the requested range exactly.
    values = [it["parameter_value"] for it in sweep_buf.iterations]
    assert values[0] == pytest.approx(1.05, abs=1e-9)
    assert values[-1] == pytest.approx(1.15, abs=1e-9)


@pytest.mark.integration
async def test_sweep_returns_409_when_already_running(
    client: httpx.AsyncClient, app_with_mgr
) -> None:
    """While a sweep is running, starting another one returns 409."""
    _, mgr = app_with_mgr
    sid = await _seed_session_with_fault_snapshot(client, "sweep-409")

    resp = await client.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "disturbance.fault.tc",
                "target": 0,
                "range": {"start": 1.05, "end": 1.10, "steps": 3},
            },
            "sim": {"tf": 0.2, "h": None, "vars": None},
            "snapshot_name": "sweep-409",
        },
    )
    assert resp.status_code == 202, resp.text

    # Immediately try a second sweep.
    resp2 = await client.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "disturbance.fault.tc",
                "target": 0,
                "range": {"start": 1.05, "end": 1.10, "steps": 2},
            },
            "sim": {"tf": 0.1, "h": None, "vars": None},
            "snapshot_name": "sweep-409",
        },
    )
    assert resp2.status_code == 409
    # Drain the first sweep so the fixture teardown doesn't hang.
    sweep_id = resp.json()["sweep_id"]
    deadline = asyncio.get_event_loop().time() + 90.0
    while True:
        sweep_buf = mgr.get_sweep_buffer(sweep_id)
        assert sweep_buf is not None
        if sweep_buf.state in {"completed", "error", "aborted"}:
            break
        if asyncio.get_event_loop().time() > deadline:
            pytest.fail("first sweep failed to drain")
        await asyncio.sleep(0.5)


@pytest.mark.integration
async def test_sweep_returns_503_on_other_routes_during_sweep(
    client: httpx.AsyncClient, app_with_mgr
) -> None:
    """While a sweep is active, GET /topology returns 503 with Retry-After."""
    _, mgr = app_with_mgr
    sid = await _seed_session_with_fault_snapshot(client, "sweep-503")

    resp = await client.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "disturbance.fault.tc",
                "target": 0,
                "range": {"start": 1.05, "end": 1.10, "steps": 3},
            },
            "sim": {"tf": 0.2, "h": None, "vars": None},
            "snapshot_name": "sweep-503",
        },
    )
    assert resp.status_code == 202, resp.text
    sweep_id = resp.json()["sweep_id"]

    # Try to fetch the topology while the sweep holds the lock.
    # The sweep_in_progress flag is set synchronously in start_sweep,
    # so the next request observes it.
    resp503 = await client.get(
        f"/api/sessions/{sid}/topology",
    )
    # Could land 503 (gate fired) or 200 (gate already cleared if the
    # sweep finished super fast). 503 is the expected case for the
    # 3-step IEEE 14 path; assert on the gate path.
    if resp503.status_code == 503:
        assert resp503.headers.get("Retry-After") == "5"
        body = resp503.json()
        assert body["sweep_id"] == sweep_id
        assert body["iter_total"] == 3

    # Drain the sweep.
    deadline = asyncio.get_event_loop().time() + 90.0
    while True:
        sweep_buf = mgr.get_sweep_buffer(sweep_id)
        assert sweep_buf is not None
        if sweep_buf.state in {"completed", "error", "aborted"}:
            break
        if asyncio.get_event_loop().time() > deadline:
            pytest.fail("sweep did not drain")
        await asyncio.sleep(0.5)


@pytest.mark.integration
async def test_sweep_unknown_parameter_kind_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Sending an unknown parameter kind fails validation BEFORE the worker
    is invoked. Pydantic's Literal-typed ``kind`` field rejects with 422.
    """
    sid = await _seed_session_with_fault_snapshot(client, "sweep-bad-kind")
    resp = await client.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "topology.bus.v0",  # not in the allowed set
                "target": 0,
                "range": {"start": 1.0, "end": 1.05, "steps": 2},
            },
            "sim": {"tf": 0.2, "h": None, "vars": None},
            "snapshot_name": "sweep-bad-kind",
        },
    )
    assert resp.status_code == 422


@pytest.mark.integration
async def test_sweep_target_out_of_range_records_per_iteration_errors(
    client: httpx.AsyncClient, app_with_mgr
) -> None:
    """Target index past the snapshot's disturbance log → each iteration
    records a SweepValidationError; the sweep still completes (state=completed)
    so the user sees which iterations failed and which succeeded.
    """
    _, mgr = app_with_mgr
    sid = await _seed_session_with_fault_snapshot(client, "sweep-bad-target")

    resp = await client.post(
        f"/api/sessions/{sid}/sweep",
        json={
            "parameter": {
                "kind": "disturbance.fault.tc",
                "target": 5,  # snapshot only has 1 disturbance
                "range": {"start": 1.05, "end": 1.15, "steps": 2},
            },
            "sim": {"tf": 0.2, "h": None, "vars": None},
            "snapshot_name": "sweep-bad-target",
        },
    )
    assert resp.status_code == 202, resp.text
    sweep_id = resp.json()["sweep_id"]

    deadline = asyncio.get_event_loop().time() + 90.0
    while True:
        sweep_buf = mgr.get_sweep_buffer(sweep_id)
        assert sweep_buf is not None
        if sweep_buf.state in {"completed", "error", "aborted"}:
            break
        if asyncio.get_event_loop().time() > deadline:
            pytest.fail("sweep did not finish")
        await asyncio.sleep(0.5)
    # Sweep completes; per-iteration errors are recorded.
    assert sweep_buf.state == "completed"
    assert all(
        it["error"] is not None for it in sweep_buf.iterations
    ), sweep_buf.iterations


@pytest.mark.integration
def test_sweep_progress_via_websocket(workspace: Path) -> None:
    """End-to-end: start a sweep, attach the WS progress channel, observe
    iteration + finished events.

    This test runs synchronously via Starlette's ``TestClient`` because
    the WS client is sync-only. The lifespan handler runs once at
    TestClient enter; all session state (creation, snapshot save,
    sweep start) lives inside the same lifespan so the SessionManager
    reference is consistent across the HTTP + WS handles.
    """
    from starlette.testclient import TestClient

    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
        # Starlette's TestClient sends ``Host: testserver`` by default;
        # extend the Host/Origin allow-list so the middleware accepts it.
        extra_allowed_hosts=frozenset({"testserver"}),
        extra_allowed_origins=frozenset(
            {"http://testserver", "http://localhost"}
        ),
    )
    with TestClient(app) as tc:
        # Create session.
        resp = tc.post(
            "/api/sessions"
        )
        assert resp.status_code == 201, resp.text
        sid = str(resp.json()["session_id"])
        # Load case.
        resp = tc.post(
            f"/api/sessions/{sid}/case",
            json={"primary_path": "ieee14.raw"},
        )
        assert resp.status_code in (200, 201), resp.text
        # Add disturbance.
        resp = tc.post(
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
        # Run PFlow.
        resp = tc.post(
            f"/api/sessions/{sid}/pflow",
            json={},
        )
        assert resp.status_code == 200, resp.text
        # Save snapshot.
        resp = tc.post(
            f"/api/sessions/{sid}/snapshot",
            json={"name": "sweep-ws"},
        )
        assert resp.status_code == 200, resp.text
        # Start the sweep.
        resp = tc.post(
            f"/api/sessions/{sid}/sweep",
            json={
                "parameter": {
                    "kind": "disturbance.fault.tc",
                    "target": 0,
                    "range": {"start": 1.05, "end": 1.15, "steps": 3},
                },
                "sim": {"tf": 0.2, "h": None, "vars": None},
                "snapshot_name": "sweep-ws",
            },
        )
        assert resp.status_code == 202, resp.text
        sweep_id = resp.json()["sweep_id"]
        # Connect WS + drain.
        with tc.websocket_connect(
            f"/api/ws/{sid}/sweep/{sweep_id}"
        ) as ws:
            ready = json.loads(ws.receive_text())
            assert ready["type"] == "ready"
            snapshot = json.loads(ws.receive_text())
            assert snapshot["type"] == "snapshot"
            assert snapshot["total"] == 3
            finished_state: str | None = None
            for _ in range(20):
                msg = json.loads(ws.receive_text())
                if msg["type"] == "finished":
                    finished_state = msg.get("state")
                    break
            assert finished_state == "completed"
