"""Integration tests for the snapshot API (Unit 7 of the v2.0 plan).

End-to-end coverage that drives the FastAPI app over an httpx
``ASGITransport`` against ANDES's bundled IEEE 14 case. Exercises the
full save → list → restore → delete lifecycle plus the corner cases the
plan calls out:

- Snapshot saved post-PF and restored cleanly via the dill fast path.
- Restore re-applies the disturbance log from the sidecar JSON, even
  when intervening disturbances were added after the save.
- Multiple snapshots per case coexist; list returns them all; delete
  removes one without affecting the others.
- Snapshot survives session restart (workspace-side files; new session
  on the same workspace can list + restore).
- Name collision returns 409; ``force=true`` overwrites.
- Snapshot of an unknown name returns 404 on restore + delete.

Markers: ``integration`` — these tests load real case files and spawn
the worker subprocess (~2-5 s each).
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
async def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    for name in ["ieee14.raw", "ieee14.dyr"]:
        shutil.copy2(src / name, ws / name)
    return ws


@pytest.fixture
async def client(workspace: Path) -> AsyncIterator[httpx.AsyncClient]:
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
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _create_session_with_case(
    client: httpx.AsyncClient,
    primary: str = "ieee14.raw",
    addfile: str | None = "ieee14.dyr",
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


# ---- happy paths -----------------------------------------------------------


@pytest.mark.integration
async def test_snapshot_save_then_restore_via_dill_fast_path(
    client: httpx.AsyncClient,
) -> None:
    """Plan's primary scenario (truncated): save snapshot pre-disturbance,
    restore via dill optimisation, confirm same operating point.

    This is the dill-fast-path acceptance: ``used_dill=true``, no
    ``fallback_reason``, restored System has converged PF state.

    Note: ANDES 2.0 ``load_ss`` has a known issue with cases that include
    a ``.dyr`` addfile (``set_var_arrays`` raises IndexError on the
    dynamic-state view arrays). The substrate's restore flow falls back
    to the slow path automatically; this test verifies the dill path on
    the static-only case (no ``.dyr``) where ANDES's ``load_ss`` round-
    trips cleanly.
    """
    # Static-only IEEE 14 — addfile=None — for the dill round-trip path.
    sid = await _create_session_with_case(client, addfile=None)

    # Run PF so the snapshot has something interesting to capture.
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["converged"] is True

    # Save the snapshot.
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "scenario-A"},
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["name"] == "scenario-A"
    assert payload["dill_bytes"] > 0
    assert payload["metadata_bytes"] > 0
    meta = payload["metadata"]
    assert meta["andes_version"]  # non-empty string
    assert meta["case_filename"] == "ieee14.raw"
    assert meta["has_pflow"] is True

    # Restore using the default dill optimisation.
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot/restore",
        json={"name": "scenario-A"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["used_dill"] is True
    assert body["fallback_reason"] is None
    # v3.1 Unit 5b: restore is session-mutating, so its JobRecord lives in the
    # GLOBAL registry (KTD-20) yet still surfaces via the session's /jobs/{id}.
    restore_job = body["job_id"]
    assert isinstance(restore_job, str) and restore_job
    job = await client.get(
        f"/api/sessions/{sid}/jobs/{restore_job}",
    )
    assert job.status_code == 200, job.text
    assert job.json()["kind"] == "snapshot-restore"
    assert job.json()["status"] == "done"


@pytest.mark.integration
async def test_snapshot_restore_via_slow_path_when_dill_disabled(
    client: httpx.AsyncClient,
) -> None:
    """Plan's edge case: restore with ``use_dill_optimization=false``
    forces the always-works replay+PF path. ``used_dill`` is False;
    the System still ends up at a converged PF state."""
    sid = await _create_session_with_case(client)
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert resp.status_code == 200, resp.text

    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "slow-test"},
    )
    assert resp.status_code == 200

    resp = await client.post(
        f"/api/sessions/{sid}/snapshot/restore",
        json={"name": "slow-test", "use_dill_optimization": False},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["used_dill"] is False

    # Re-run PF after restore; converged result confirms the slow path
    # left the System in a clean operating-point state.
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["converged"] is True


@pytest.mark.integration
async def test_snapshot_restore_replays_disturbance_log(
    client: httpx.AsyncClient,
) -> None:
    """Plan's primary scenario: save, add an extra disturbance, restore →
    only the original disturbance survives because the snapshot's
    sidecar JSON is the source of truth for the disturbance log.
    """
    sid = await _create_session_with_case(client)

    # Add a Fault disturbance pre-PF.
    resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0},
            ]
        },
    )
    assert resp.status_code == 200, resp.text

    # Run PF so the snapshot covers the converged operating point.
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert resp.status_code == 200, resp.text

    # Save with one disturbance recorded.
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "one-fault"},
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()
    assert len(saved["metadata"]["disturbance_log"]) == 1

    # The disturbance list is post-setup at this point — we cannot add
    # another disturbance directly. Instead, reload, add a different
    # disturbance, then restore the snapshot. The substrate's _disturbance_log
    # for the active session must reflect ONLY what was in the snapshot.
    resp = await client.post(
        f"/api/sessions/{sid}/reload",
    )
    assert resp.status_code == 200, resp.text

    # Add a SECOND, different disturbance against the freshly-reloaded
    # System.
    resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 7, "tf": 2.0, "tc": 2.1, "xf": 0.0001, "rf": 0.0},
            ]
        },
    )
    assert resp.status_code == 200, resp.text

    # Now restore the snapshot. The sidecar JSON's disturbance_log
    # (one Fault on bus 5) wins; the second one (bus 7) is wiped.
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot/restore",
        json={"name": "one-fault"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["disturbances_replayed"] == 1

    # Confirm the disturbance log is the snapshot's, not the post-add one.
    resp = await client.get(
        f"/api/sessions/{sid}/disturbances",
    )
    assert resp.status_code == 200, resp.text
    listed = resp.json()["disturbances"]
    assert len(listed) == 1
    assert listed[0]["bus_idx"] == 5


# ---- listing ---------------------------------------------------------------


@pytest.mark.integration
async def test_list_snapshots_returns_empty_for_fresh_session(
    client: httpx.AsyncClient,
) -> None:
    """No snapshots → 200 with an empty list (NOT 404)."""
    sid = await _create_session_with_case(client)
    resp = await client.get(
        f"/api/sessions/{sid}/snapshots",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"snapshots": []}


@pytest.mark.integration
async def test_list_snapshots_without_case_returns_200_empty(
    client: httpx.AsyncClient,
) -> None:
    """Listing is a read: with no case loaded the truthful answer is an
    empty list (200, ``{"snapshots": []}``), not a 409 — browsers log
    non-2xx fetches as console errors. The mutating snapshot endpoints
    (save/restore/delete) keep their 409s."""
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    sid = str(resp.json()["session_id"])
    resp = await client.get(f"/api/sessions/{sid}/snapshots")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"snapshots": []}


@pytest.mark.integration
async def test_list_snapshots_returns_all_saved_for_case(
    client: httpx.AsyncClient,
) -> None:
    """Plan's "5 different snapshots saved at different operating points"
    scenario, scaled down to 3 to keep the test fast."""
    sid = await _create_session_with_case(client)
    # Pre-PF snapshots are valid (only the disturbance log is meaningful).
    for n in ("snap-a", "snap-b", "snap-c"):
        resp = await client.post(
            f"/api/sessions/{sid}/snapshot",
            json={"name": n},
        )
        assert resp.status_code == 200, resp.text

    resp = await client.get(
        f"/api/sessions/{sid}/snapshots",
    )
    assert resp.status_code == 200
    snapshots = resp.json()["snapshots"]
    names = sorted(s["name"] for s in snapshots)
    assert names == ["snap-a", "snap-b", "snap-c"]


# ---- delete ----------------------------------------------------------------


@pytest.mark.integration
async def test_delete_snapshot_removes_from_listing(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_with_case(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "doomed"},
    )
    assert resp.status_code == 200

    resp = await client.delete(
        f"/api/sessions/{sid}/snapshot/doomed",
    )
    assert resp.status_code == 204, resp.text

    resp = await client.get(
        f"/api/sessions/{sid}/snapshots",
    )
    assert resp.status_code == 200
    assert resp.json()["snapshots"] == []


@pytest.mark.integration
async def test_delete_unknown_snapshot_returns_404(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_with_case(client)
    resp = await client.delete(
        f"/api/sessions/{sid}/snapshot/nonexistent",
    )
    assert resp.status_code == 404, resp.text


# ---- collision policy ------------------------------------------------------


@pytest.mark.integration
async def test_snapshot_save_collision_returns_409_by_default(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_with_case(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "scenario-A"},
    )
    assert resp.status_code == 200

    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "scenario-A"},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_snapshot_save_collision_with_force_overwrites(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_with_case(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "scenario-A"},
    )
    assert resp.status_code == 200

    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "scenario-A", "force": True},
    )
    assert resp.status_code == 200, resp.text


# ---- error paths -----------------------------------------------------------


@pytest.mark.integration
async def test_snapshot_save_invalid_name_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Names with traversal vectors / unsafe chars are rejected."""
    sid = await _create_session_with_case(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "../escape"},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_snapshot_restore_unknown_name_returns_404(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_with_case(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot/restore",
        json={"name": "ghost"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_snapshot_save_without_case_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Snapshot save needs a loaded System (the dill blob captures the
    System; the JSON metadata captures its log). With no case loaded
    the wrapper rejects with NoCaseLoadedError → 409."""
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "scenario-A"},
    )
    assert resp.status_code == 409, resp.text


# ---- session-restart durability --------------------------------------------


@pytest.mark.integration
async def test_snapshot_survives_session_restart(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    """Plan's "Integration: snapshot list survives session restart" scenario.

    Save a snapshot in session A; close A; open session B against the same
    workspace; B's listing surfaces A's snapshot because the files live
    on disk under ``<workspace>/snapshots/<case>/``.
    """
    sid_a = await _create_session_with_case(client)
    resp = await client.post(
        f"/api/sessions/{sid_a}/snapshot",
        json={"name": "persisted"},
    )
    assert resp.status_code == 200, resp.text

    # Close session A; the manager reaps the worker subprocess.
    await client.delete(
        f"/api/sessions/{sid_a}",
    )

    # Open session B against the same workspace + case.
    sid_b = await _create_session_with_case(client)
    resp = await client.get(
        f"/api/sessions/{sid_b}/snapshots",
    )
    assert resp.status_code == 200, resp.text
    names = [s["name"] for s in resp.json()["snapshots"]]
    assert "persisted" in names

    # Restore from session B works against the snapshot saved in A.
    resp = await client.post(
        f"/api/sessions/{sid_b}/snapshot/restore",
        json={"name": "persisted"},
    )
    assert resp.status_code == 200, resp.text


# ---- Part A: dead-worker -> structured 503 (reload-case) --------------------


@pytest.fixture
async def client_and_manager(
    workspace: Path,
) -> AsyncIterator[tuple[httpx.AsyncClient, SessionManager]]:
    """Like ``client`` but also yields the live ``SessionManager`` so a test can
    reach in and kill a worker subprocess to exercise the dead-worker path."""
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
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as ac:
            yield ac, mgr
    finally:
        await mgr.shutdown()


@pytest.mark.integration
async def test_dead_worker_route_returns_structured_503(
    client_and_manager: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """End-to-end Part A: kill the worker, then the next API call returns a
    structured 503 ``ProblemDetails`` with a ``reload-case`` recovery descriptor
    — not a bare 500 — and subsequent calls keep failing cleanly (the session is
    dead, not a zombie spewing 500s)."""
    client, mgr = client_and_manager
    sid = await _create_session_with_case(client, addfile=None)

    # Hard-kill the worker subprocess out from under the live session.
    sess = mgr._sessions[sid]
    sess.process.kill()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, sess.process.join, 5.0)

    # The next route that invokes the worker surfaces the structured 503.
    resp = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert resp.status_code == 503, resp.text
    body = resp.json()
    assert body["status"] == 503
    assert "worker stopped unexpectedly" in (body.get("detail") or "")
    assert body["recovery"] is not None
    assert body["recovery"]["kind"] == "reload-case"

    # Follow-up call: the session was dropped, so it 404s as gone (not 500).
    # ``run_pflow`` is wrapped in ``_run_as_job``; an unknown session surfaces
    # as the routes' SessionExpired mapping. Either way it is NOT a 500.
    resp2 = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert resp2.status_code != 500, resp2.text
