"""Integration tests for v3.1 Unit 5b — routine routes mirrored as jobs.

Every routine route now wraps its ``mgr.invoke`` call in ``_run_as_job`` and
surfaces the new ``job_id`` on its response. These tests assert the three
contract additions per the plan (Unit 5b test scenarios):

  (a) the POST response carries a non-null ``job_id``;
  (b) ``GET /sessions/{id}/jobs/{job_id}`` returns the matching ``JobRecord``
      (right ``kind``, ``status == "done"``);
  (c) a provoked error transitions the registry record to ``failed`` (and the
      4xx is unchanged otherwise).

Session-mutating routines (snapshot restore, case reload, bundle import) record
into the manager-wide GLOBAL registry (KTD-20) so the record survives the
session it mutated INTO being replaced; we assert the record is visible via
``GET /sessions/{id}/jobs`` and that the global registry actually holds it.

These tests stand up the real FastAPI app over a workspace seeded with the
IEEE 14 fixtures, driving everything end-to-end through a worker subprocess.
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
async def client(tmp_path: Path) -> AsyncIterator[tuple[httpx.AsyncClient, SessionManager]]:
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


async def _new_session(ac: httpx.AsyncClient) -> str:
    resp = await ac.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


async def _load_case(
    ac: httpx.AsyncClient, sid: str, addfile: str | None = "ieee14.dyr"
) -> None:
    body: dict[str, object] = {"primary_path": "ieee14.raw"}
    if addfile is not None:
        body["addfiles"] = [addfile]
    resp = await ac.post(f"/api/sessions/{sid}/case", json=body)
    assert resp.status_code in (200, 201), resp.text


async def _run_pflow(ac: httpx.AsyncClient, sid: str) -> None:
    resp = await ac.post(f"/api/sessions/{sid}/pflow", json={})
    assert resp.status_code == 200, resp.text


async def _get_job(ac: httpx.AsyncClient, sid: str, job_id: str) -> dict[str, object]:
    resp = await ac.get(f"/api/sessions/{sid}/jobs/{job_id}")
    assert resp.status_code == 200, resp.text
    return dict(resp.json())


# ---- routines: pflow / eig / cpf / se -------------------------------------


@pytest.mark.integration
async def test_pflow_response_carries_job_id_and_record_is_done(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile=None)

    resp = await ac.post(f"/api/sessions/{sid}/pflow", json={})
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["id"] == job_id
    assert record["kind"] == "pflow"
    assert record["status"] == "done"


@pytest.mark.integration
async def test_pflow_error_transitions_record_to_failed(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """No case loaded → 409; the registry must hold a failed pflow record."""
    ac, _mgr = client
    sid = await _new_session(ac)

    resp = await ac.post(f"/api/sessions/{sid}/pflow", json={})
    assert resp.status_code == 409, resp.text

    jobs = (await ac.get(f"/api/sessions/{sid}/jobs")).json()
    pflow_jobs = [j for j in jobs if j["kind"] == "pflow"]
    assert pflow_jobs, "expected a pflow job record after the failed run"
    assert all(j["status"] == "failed" for j in pflow_jobs)


@pytest.mark.integration
async def test_eig_response_carries_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile="ieee14.dyr")
    await _run_pflow(ac, sid)

    resp = await ac.post(f"/api/sessions/{sid}/eig", json={})
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "eig"
    assert record["status"] == "done"


@pytest.mark.integration
async def test_cpf_response_carries_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile="ieee14.dyr")
    await _run_pflow(ac, sid)

    resp = await ac.post(
        f"/api/sessions/{sid}/cpf",
        json={"direction": "load", "max_iter": 5},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "cpf"
    assert record["status"] == "done"


@pytest.mark.integration
async def test_se_measurements_and_run_carry_distinct_job_ids(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile="ieee14.dyr")
    await _run_pflow(ac, sid)

    gen = await ac.post(
        f"/api/sessions/{sid}/se/measurements/generate", json={}
    )
    assert gen.status_code == 200, gen.text
    gen_job = gen.json()["job_id"]
    assert (await _get_job(ac, sid, gen_job))["kind"] == "se-measurements"

    run = await ac.post(f"/api/sessions/{sid}/se", json={})
    assert run.status_code == 200, run.text
    run_job = run.json()["job_id"]
    assert run_job != gen_job
    run_record = await _get_job(ac, sid, run_job)
    assert run_record["kind"] == "se"
    assert run_record["status"] == "done"


# ---- edits: elements / disturbances ---------------------------------------


@pytest.mark.integration
async def test_add_element_carries_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile=None)

    resp = await ac.post(
        f"/api/sessions/{sid}/elements",
        json={"model": "Bus", "params": {"Vn": 110.0}},
    )
    assert resp.status_code == 201, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "element-add"
    assert record["status"] == "done"


@pytest.mark.integration
async def test_add_element_error_transitions_record_to_failed(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile=None)

    # Unknown model → 422; the record must transition to failed.
    resp = await ac.post(
        f"/api/sessions/{sid}/elements",
        json={"model": "NoSuchModel", "params": {}},
    )
    assert resp.status_code == 422, resp.text

    jobs = (await ac.get(f"/api/sessions/{sid}/jobs")).json()
    add_jobs = [j for j in jobs if j["kind"] == "element-add"]
    assert add_jobs
    assert all(j["status"] == "failed" for j in add_jobs)


@pytest.mark.integration
async def test_add_disturbances_batch_is_one_job(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile="ieee14.dyr")

    resp = await ac.post(
        f"/api/sessions/{sid}/disturbances",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 4, "tf": 1.0, "tc": 1.1}
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "disturbance-commit"
    assert record["status"] == "done"


# ---- addfile: pmu / profiles ----------------------------------------------


@pytest.mark.integration
async def test_add_pmu_carries_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile="ieee14.dyr")

    resp = await ac.post(
        f"/api/sessions/{sid}/pmu", json={"bus_idx": "1"}
    )
    assert resp.status_code == 201, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "pmu-add"
    assert record["status"] == "done"


@pytest.mark.integration
async def test_delete_pmu_surfaces_job_id_header(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """The 204 has no JSON body; the mirrored job id rides ``X-Job-Id``."""
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile="ieee14.dyr")

    added = await ac.post(
        f"/api/sessions/{sid}/pmu", json={"bus_idx": "1"}
    )
    pmu_idx = added.json()["idx"]

    resp = await ac.delete(f"/api/sessions/{sid}/pmu/{pmu_idx}")
    assert resp.status_code == 204, resp.text
    job_id = resp.headers.get("X-Job-Id")
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "pmu-delete"
    assert record["status"] == "done"


# ---- state ops: case-load / save_snapshot ---------------------------------


@pytest.mark.integration
async def test_case_load_carries_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)

    resp = await ac.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw"},
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "case-load"
    assert record["status"] == "done"


@pytest.mark.integration
async def test_save_snapshot_carries_job_id(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, _mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile=None)
    await _run_pflow(ac, sid)

    resp = await ac.post(
        f"/api/sessions/{sid}/snapshot", json={"name": "snap-j"}
    )
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "snapshot-save"
    assert record["status"] == "done"


# ---- session-mutating → GLOBAL registry (KTD-20) --------------------------


@pytest.mark.integration
async def test_snapshot_restore_records_in_global_registry(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    """Restore is session-mutating: its JobRecord lives in the manager-wide
    GLOBAL registry, yet still surfaces via the session's ``GET /jobs`` and
    ``GET /jobs/{id}``."""
    ac, mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile=None)
    await _run_pflow(ac, sid)

    save = await ac.post(
        f"/api/sessions/{sid}/snapshot", json={"name": "restore-me"}
    )
    assert save.status_code == 200, save.text

    restore = await ac.post(
        f"/api/sessions/{sid}/snapshot/restore",
        json={"name": "restore-me"},
    )
    assert restore.status_code == 200, restore.text
    job_id = restore.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    # The record is held by the GLOBAL registry, NOT the per-session one.
    assert mgr.global_job_registry.get_job(job_id) is not None
    assert mgr.session_job_registry(sid).get_job(job_id) is None

    # It still surfaces through the session-scoped read surface (KTD-20).
    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "snapshot-restore"
    assert record["status"] == "done"


@pytest.mark.integration
async def test_case_reload_records_in_global_registry(
    client: tuple[httpx.AsyncClient, SessionManager],
) -> None:
    ac, mgr = client
    sid = await _new_session(ac)
    await _load_case(ac, sid, addfile=None)
    await _run_pflow(ac, sid)

    resp = await ac.post(f"/api/sessions/{sid}/reload")
    assert resp.status_code == 200, resp.text
    job_id = resp.json()["job_id"]
    assert isinstance(job_id, str) and job_id

    assert mgr.global_job_registry.get_job(job_id) is not None
    record = await _get_job(ac, sid, job_id)
    assert record["kind"] == "case-reload"
    assert record["status"] == "done"
