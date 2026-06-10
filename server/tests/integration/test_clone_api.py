"""Integration: clone-on-write HTTP routes (Unit 21).

Exercises the route surface end-to-end through the in-process ASGI app:

- the full init → edit → undo → redo → save-as → reset flow over HTTP;
- whitelist rejection (422) for a non-controller model/param;
- 409 when the session lock is held (a job running);
- reset deletes the clone scratch dir.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager

pytestmark = pytest.mark.integration



def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


async def _make_client(tmp_path: Path, files: list[Path]) -> httpx.AsyncClient:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for src in files:
        shutil.copy2(src, workspace / src.name)
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
    client = httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000")
    client._mgr = mgr  # type: ignore[attr-defined]
    client._workspace = workspace  # type: ignore[attr-defined]
    return client


@pytest.fixture
async def kundur_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "kundur" / "kundur_full.xlsx"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


async def _new_session_with_kundur(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions")
    assert resp.status_code in (200, 201), resp.text
    sid = str(resp.json()["session_id"])
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "kundur_full.xlsx"},
    )
    assert resp.status_code == 200, resp.text
    return sid


async def test_full_clone_flow_over_http(kundur_client: httpx.AsyncClient) -> None:
    sid = await _new_session_with_kundur(kundur_client)

    # init
    resp = await kundur_client.post(f"/api/sessions/{sid}/case/clone")
    assert resp.status_code == 200, resp.text
    assert resp.json()["already_initialized"] is False

    # edit TGOV1.T1 -> 0.6
    resp = await kundur_client.put(
        f"/api/sessions/{sid}/case/clone/params/TGOV1/1/T1",
        json={"value": 0.6},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["new_value"] == pytest.approx(0.6)
    assert body["undo_depth"] == 1
    assert body["job_id"]

    # undo
    resp = await kundur_client.post(
        f"/api/sessions/{sid}/case/clone/undo"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["undo_depth"] == 0
    assert resp.json()["redo_depth"] == 1

    # redo
    resp = await kundur_client.post(
        f"/api/sessions/{sid}/case/clone/redo"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["redo_depth"] == 0

    # save-as
    resp = await kundur_client.post(
        f"/api/sessions/{sid}/case/clone/save-as",
        json={"name": "kundur_tuned"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "kundur_tuned"
    workspace: Path = kundur_client._workspace  # type: ignore[attr-defined]
    assert (workspace / "kundur_tuned.xlsx").exists()

    # reset deletes the clone dir
    resp = await kundur_client.post(
        f"/api/sessions/{sid}/case/clone/reset"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["reset"] is True
    clone_dir = workspace / ".sessions" / sid / "clone"
    assert not clone_dir.exists()


async def test_whitelist_rejects_non_controller_model(
    kundur_client: httpx.AsyncClient,
) -> None:
    sid = await _new_session_with_kundur(kundur_client)
    # Bus is not a dynamic controller — 422 before any clone work.
    resp = await kundur_client.put(
        f"/api/sessions/{sid}/case/clone/params/Bus/1/Vn",
        json={"value": 1.0},
    )
    assert resp.status_code == 422, resp.text


async def test_whitelist_rejects_unknown_param(
    kundur_client: httpx.AsyncClient,
) -> None:
    sid = await _new_session_with_kundur(kundur_client)
    resp = await kundur_client.put(
        f"/api/sessions/{sid}/case/clone/params/TGOV1/1/NotAParam",
        json={"value": 1.0},
    )
    assert resp.status_code == 422, resp.text


async def test_path_traversal_segment_rejected(
    kundur_client: httpx.AsyncClient,
) -> None:
    sid = await _new_session_with_kundur(kundur_client)
    # A traversal-looking param never matches a whitelisted param. The encoded
    # ``..%2F..`` decodes to extra path segments that no route matches (405) or
    # is rejected by the whitelist (422); either way it never reaches the
    # writer / the filesystem.
    resp = await kundur_client.put(
        f"/api/sessions/{sid}/case/clone/params/TGOV1/1/..%2F..%2Fetc",
        json={"value": 1.0},
    )
    assert resp.status_code in (404, 405, 422), resp.text


async def test_edit_returns_409_when_session_busy(
    kundur_client: httpx.AsyncClient,
) -> None:
    sid = await _new_session_with_kundur(kundur_client)
    mgr: SessionManager = kundur_client._mgr  # type: ignore[attr-defined]
    # Hold the per-session lock to simulate an in-flight job (e.g. TDS).
    sess = mgr._sessions[sid]  # type: ignore[attr-defined]
    acquired = sess.lock.acquire(blocking=False)
    assert acquired
    try:
        resp = await kundur_client.put(
            f"/api/sessions/{sid}/case/clone/params/TGOV1/1/T1",
            json={"value": 0.6},
        )
        assert resp.status_code == 409, resp.text
        body = resp.json()
        recovery = body.get("recovery")
        assert recovery is not None
        assert recovery["kind"] == "wait-for-job"
    finally:
        sess.lock.release()
