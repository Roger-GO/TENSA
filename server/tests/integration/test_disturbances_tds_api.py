"""Integration tests for the disturbance + TDS batch endpoints.

Drives the FastAPI app over an httpx ASGITransport, with a real
SessionManager and worker subprocesses + IEEE 14 case files copied into the
test workspace. Verifies the disturbance lifecycle (pre-setup add, 409 after
PF, /reload to recover, re-add) and a basic TDS batch run.
"""

from __future__ import annotations

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
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
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
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _create_session_and_load(
    client: httpx.AsyncClient, primary: str = "ieee14.raw", addfile: str | None = None
) -> str:
    """Helper: create a session, load IEEE 14, return the session id."""
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    if addfile:
        body["addfiles"] = [addfile]
    await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    return sid


@pytest.mark.integration
async def test_list_disturbances_without_case_returns_200_empty(
    client: httpx.AsyncClient,
) -> None:
    """Listing is a read: with no case loaded the truthful answer is an empty
    list (200), not a 409 — browsers log non-2xx fetches as console errors."""
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    sid = str(resp.json()["session_id"])
    resp = await client.get(f"/api/sessions/{sid}/disturbances")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"disturbances": []}


@pytest.mark.integration
async def test_add_fault_pre_setup_returns_idx(client: httpx.AsyncClient) -> None:
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0}
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["accepted"]) == 1
    assert body["accepted"][0]["kind"] == "fault"
    assert body["accepted"][0]["idx"] is not None


@pytest.mark.integration
async def test_add_multiple_disturbances_in_one_request(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1},
                {"kind": "fault", "bus_idx": 5, "tf": 2.0, "tc": 2.1},
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    accepted = resp.json()["accepted"]
    assert len(accepted) == 2


@pytest.mark.integration
async def test_add_disturbance_post_setup_returns_409(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client, "ieee14.raw")
    # PF triggers setup
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}
            ]
        },
    )
    assert resp.status_code == 409, resp.text
    assert "/reload" in resp.text


@pytest.mark.integration
async def test_add_then_reload_then_re_add_works(
    client: httpx.AsyncClient,
) -> None:
    """The reload escape hatch: after PF commits setup, /reload returns to
    pre-setup so disturbances can be added again."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    # 409 before reload
    bad = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}]},
    )
    assert bad.status_code == 409
    # Reload
    rl = await client.post(
        f"/api/sessions/{sid}/reload",
    )
    assert rl.status_code == 200
    # Now add succeeds
    ok = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}]},
    )
    assert ok.status_code == 200, ok.text


@pytest.mark.integration
async def test_run_tds_batch(client: httpx.AsyncClient) -> None:
    """End-to-end: load IEEE 14 + .dyr → run a 1-second TDS → assert
    callpert fired and final_t reached tf."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 1.0, "h": 1 / 120},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["final_t"] >= 0.99
    assert body["callpert_count"] >= 10


@pytest.mark.integration
async def test_run_tds_before_load_returns_409(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 1.0},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_add_disturbance_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions/does-not-exist/disturbances",
        json={"disturbances": [{"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}]},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_add_disturbance_empty_list_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """An empty disturbances list violates ``min_length=1``."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": []},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_add_disturbance_unknown_kind_returns_422(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={"disturbances": [{"kind": "bogus", "bus_idx": 4}]},
    )
    assert resp.status_code == 422, resp.text
