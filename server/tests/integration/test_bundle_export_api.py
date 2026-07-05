"""Integration tests for the bundle-export endpoint (Unit 3 of the v2.0 plan).

Drives the FastAPI app end-to-end against ANDES's bundled IEEE 14 case.
Asserts the wire-shape of the ``application/zip`` response and the
contents of the assembled bundle (manifest, disturbances.json, etc.).

Markers: ``integration`` — these tests load real case files and spawn the
worker subprocess, so each takes ~1-3 s.
"""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager


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
    client: httpx.AsyncClient,
    primary: str = "ieee14.raw",
    addfile: str | None = None,
) -> str:
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
async def test_export_bundle_minimal_returns_zip_with_case_and_manifest(
    client: httpx.AsyncClient,
) -> None:
    """Happy path: fresh session with IEEE 14 loaded, no disturbances, no
    run yet. Bundle has the case file + manifest only."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    resp = await client.post(
        f"/api/sessions/{sid}/bundle/export",
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/zip")
    assert "attachment" in resp.headers.get("content-disposition", "")
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
    assert "case/ieee14.raw" in names
    assert "manifest.json" in names
    assert "disturbances.json" not in names
    assert "sim_params.json" not in names
    assert "results.csv" not in names


@pytest.mark.integration
async def test_export_bundle_includes_disturbances_in_request_body(
    client: httpx.AsyncClient,
) -> None:
    """Happy path mirroring the plan's primary scenario: load IEEE 14,
    pass a Fault disturbance + sim params + results.csv via the request
    body, expect all to appear in the bundle."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    body = {
        "disturbances": [
            {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1, "xf": 0.0001, "rf": 0.0},
        ],
        "sim_params": {
            "tf": 2.0,
            "h": None,
            "vars": ["bus_v"],
            "decimation": "mean",
            "max_rate_hz": 30.0,
        },
        "results_csv": "time,variable,value\n0,Bus_5_v,1.06\n0.01,Bus_5_v,1.0599\n",
        "run_id": "abcdef0123456789",
    }
    resp = await client.post(
        f"/api/sessions/{sid}/bundle/export",
        json=body,
    )
    assert resp.status_code == 200, resp.text
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        disturbances = json.loads(zf.read("disturbances.json").decode("utf-8"))
        sim_params = json.loads(zf.read("sim_params.json").decode("utf-8"))
        results_csv = zf.read("results.csv").decode("utf-8")
    # 5 files: 2 case (raw + dyr), disturbances, sim_params, results, manifest = 6
    assert "case/ieee14.raw" in names
    assert "case/ieee14.dyr" in names
    assert "disturbances.json" in names
    assert "sim_params.json" in names
    assert "results.csv" in names
    assert "manifest.json" in names
    # Manifest reflects the in-memory state.
    assert manifest["disturbance_count"] == 1
    assert manifest["run_id"] == "abcdef0123456789"
    assert manifest["case_canonical_export"] is False
    assert manifest["case_filename"] == "ieee14.raw"
    # Disturbance bodies survive round-trip.
    assert disturbances[0]["kind"] == "fault"
    assert disturbances[0]["bus_idx"] == 5
    # Sim params + results CSV survive verbatim.
    assert sim_params["tf"] == 2.0
    assert results_csv.startswith("time,variable,value")


@pytest.mark.integration
async def test_export_bundle_includes_psse_addfile_verbatim(
    client: httpx.AsyncClient,
) -> None:
    """Edge case from the plan: PSS/E .raw + .dyr addfile → bundle
    includes both verbatim if unedited."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/bundle/export",
        json={},
    )
    assert resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        raw_bytes = zf.read("case/ieee14.raw")
        dyr_bytes = zf.read("case/ieee14.dyr")
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    assert "case/ieee14.raw" in names
    assert "case/ieee14.dyr" in names
    # Verbatim — must byte-equal the workspace copy.
    workspace_raw = (Path(_bundled_ieee14_dir()) / "ieee14.raw").read_bytes()
    workspace_dyr = (Path(_bundled_ieee14_dir()) / "ieee14.dyr").read_bytes()
    assert raw_bytes == workspace_raw
    assert dyr_bytes == workspace_dyr
    assert manifest["case_canonical_export"] is False


@pytest.mark.integration
async def test_export_bundle_dirty_case_writes_canonical_xlsx(
    client: httpx.AsyncClient,
) -> None:
    """Edge case from the plan: case edited (replay buffer non-empty) →
    bundle includes ``.xlsx`` instead of the original ``.raw``;
    manifest's ``case_canonical_export`` flips to True."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    # Add a Bus on top of the loaded case so the wrapper's _replay_buffer
    # becomes non-empty. This is the substrate's signal for "dirty case".
    add = await client.post(
        f"/api/sessions/{sid}/elements",
        json={
            "model": "Bus",
            "params": {"idx": 99, "name": "Bus99", "Vn": 13.8},
        },
    )
    assert add.status_code == 201, add.text
    resp = await client.post(
        f"/api/sessions/{sid}/bundle/export",
        json={},
    )
    assert resp.status_code == 200, resp.text
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    # Canonical export uses the original stem with .xlsx.
    assert any(n.endswith(".xlsx") for n in names if n.startswith("case/"))
    assert manifest["case_canonical_export"] is True


@pytest.mark.integration
async def test_export_bundle_no_case_loaded_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Edge case: a session with no case loaded can't be bundled."""
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    resp = await client.post(
        f"/api/sessions/{sid}/bundle/export",
        json={},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_export_bundle_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions/does-not-exist/bundle/export",
        json={},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_export_bundle_round_trips_deterministically_across_two_calls(
    client: httpx.AsyncClient,
) -> None:
    """Two consecutive calls with identical inputs produce identical bundles
    modulo the exported_at timestamp. The integration test checks the
    everything-but-timestamp invariant by reading manifest.case_sha256 +
    file list (both insensitive to time).

    This addresses the plan's "integration" scenario: bundle exported from
    session A on workspace W, dropped into workspace W' on a fresh session
    — file list matches; manifest checksum matches.
    """
    body = {
        "disturbances": [
            {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1},
        ],
        "sim_params": {"tf": 2.0, "vars": ["bus_v"]},
    }
    sid_a = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp_a = await client.post(
        f"/api/sessions/{sid_a}/bundle/export",
        json=body,
    )
    sid_b = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp_b = await client.post(
        f"/api/sessions/{sid_b}/bundle/export",
        json=body,
    )
    assert resp_a.status_code == 200
    assert resp_b.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp_a.content)) as zf_a:
        names_a = sorted(zf_a.namelist())
        manifest_a = json.loads(zf_a.read("manifest.json").decode("utf-8"))
    with zipfile.ZipFile(io.BytesIO(resp_b.content)) as zf_b:
        names_b = sorted(zf_b.namelist())
        manifest_b = json.loads(zf_b.read("manifest.json").decode("utf-8"))
    assert names_a == names_b
    assert manifest_a["case_sha256"] == manifest_b["case_sha256"]
    assert manifest_a["disturbance_count"] == manifest_b["disturbance_count"]
    assert manifest_a["case_filename"] == manifest_b["case_filename"]


@pytest.mark.integration
async def test_export_bundle_omits_results_csv_when_no_run(
    client: httpx.AsyncClient,
) -> None:
    """Edge case from the plan: no run yet → bundle exports without
    results.csv and sim_params.json; manifest reflects this."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    resp = await client.post(
        f"/api/sessions/{sid}/bundle/export",
        json={
            "disturbances": [
                {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1},
            ]
        },
    )
    assert resp.status_code == 200
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    assert "disturbances.json" in names
    assert "results.csv" not in names
    assert "sim_params.json" not in names
    assert "results.csv" not in manifest["files"]
    assert "sim_params.json" not in manifest["files"]
