"""End-to-end HTTP integration tests for case-load + topology + PF endpoints.

These tests stand up a FastAPI app pointed at a real workspace with the
IEEE 14 case files copied in, drive it via httpx ASGITransport, and assert
on full request/response round-trips through the SessionManager and into a
real worker subprocess running ANDES.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager

VALID_TOKEN = "b" * 64


def _bundled_ieee14_dir() -> Path:
    """Return ANDES's bundled IEEE 14 case directory (read-only source for
    fixtures)."""
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


def _copy_ieee14_files(src: Path, dst: Path, names: list[str]) -> None:
    """Copy a subset of IEEE 14 fixtures into the test workspace."""
    for name in names:
        shutil.copy2(src / name, dst / name)


@pytest.fixture
async def app_workspace(tmp_path: Path) -> AsyncIterator[tuple[httpx.AsyncClient, Path]]:
    """Spin up a FastAPI app over an isolated workspace seeded with the IEEE
    14 .raw + .dyr fixtures. Yields the httpx client and the workspace path
    so individual tests can assert on file presence / placement."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    _copy_ieee14_files(src, workspace, ["ieee14.raw", "ieee14.dyr"])

    app = make_app(
        expected_token=VALID_TOKEN,
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    await mgr.start()
    app.state.session_manager = mgr
    app.state.expected_token = VALID_TOKEN
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as client:
            yield client, workspace
    finally:
        await mgr.shutdown()


async def _create_session(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions", headers={"X-Andes-Token": VALID_TOKEN})
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


@pytest.mark.integration
async def test_load_case_returns_topology(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)

    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "pre-setup"
    assert len(body["buses"]) == 14


@pytest.mark.integration
async def test_load_case_with_addfile(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.integration
async def test_load_case_traversal_returns_400(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "../../etc/passwd"},
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.integration
async def test_load_case_absolute_path_returns_400(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "/etc/passwd"},
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.integration
async def test_load_case_missing_file_returns_400(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "no-such-case.xlsx"},
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.integration
async def test_load_case_unknown_session_returns_404(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    resp = await client.post(
        "/api/sessions/does-not-exist/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_topology_before_load_returns_409(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_run_pflow_after_load_returns_converged(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["converged"] is True
    assert body["iterations"] <= 10
    assert isinstance(body["bus_voltages"], dict)
    # 14 buses → 14 voltage entries
    assert len(body["bus_voltages"]) == 14
    # v3.1 Unit 5b: the routine is mirrored as a job; the response carries the
    # job_id and GET /jobs/{id} returns the matching done record.
    job_id = body["job_id"]
    assert isinstance(job_id, str) and job_id
    job = await client.get(
        f"/api/sessions/{sid}/jobs/{job_id}",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert job.status_code == 200, job.text
    assert job.json()["kind"] == "pflow"
    assert job.json()["status"] == "done"

    # Topology after PF reflects the committed state
    topo_resp = await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert topo_resp.json()["state"] == "committed"


@pytest.mark.integration
async def test_pflow_returns_line_flows(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """``PflowResult.line_flows`` is populated on a converged IEEE 14 PF."""
    client, _ws = app_workspace
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    line_flows = body["line_flows"]
    assert isinstance(line_flows, dict)
    # IEEE 14 has 20 branches; we expect a non-zero count and shape on each.
    assert len(line_flows) > 0
    for line_idx, flow in line_flows.items():
        assert isinstance(line_idx, str)
        assert "p" in flow
        assert "q" in flow
        assert "from_idx" in flow
        assert "to_idx" in flow
        assert isinstance(flow["p"], (int, float))
        assert isinstance(flow["q"], (int, float))
    # At least one branch carries non-trivial real power (MW), confirming
    # the values aren't all zero.
    assert any(abs(flow["p"]) > 1.0 for flow in line_flows.values())


@pytest.mark.integration
async def test_topology_includes_params(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """``TopologyEntry.params`` is populated for buses + generators."""
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["buses"], "expected non-empty buses"
    bus0 = body["buses"][0]
    assert "params" in bus0
    # IEEE 14 buses always have Vn, vmax, vmin
    assert "Vn" in bus0["params"]
    assert "vmax" in bus0["params"]
    assert "vmin" in bus0["params"]
    assert isinstance(bus0["params"]["Vn"], (int, float))

    # Generators are PV/Slack pre-setup (GENROU/GENCLS show up after addfile
    # has been parsed; they're in ``generators``).
    assert body["generators"], "expected at least one generator"
    gen0 = body["generators"][0]
    assert "params" in gen0
    # Sn / Vn / bus are always present on PV/Slack/GENROU/GENCLS
    assert "Sn" in gen0["params"] or "bus" in gen0["params"]


@pytest.mark.integration
async def test_topology_line_params_include_r_x(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    topo_resp = await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert topo_resp.status_code == 200
    body = topo_resp.json()
    assert body["lines"], "expected non-empty lines"
    line0 = body["lines"][0]
    assert "r" in line0["params"]
    assert "x" in line0["params"]


@pytest.mark.integration
async def test_run_pflow_before_load_returns_409(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_reload_returns_to_pre_setup(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    # State is committed
    topo = await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert topo.json()["state"] == "committed"

    # Reload returns to pre-setup
    reload_resp = await client.post(
        f"/api/sessions/{sid}/reload",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert reload_resp.status_code == 200
    assert reload_resp.json()["state"] == "pre-setup"


@pytest.mark.integration
async def test_operating_point_after_pflow_matches_pflow(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """GET /operating-point returns the solved bus V/θ without re-running.
    After a PF it must agree with the PF result (reads the same arrays)."""
    client, _ws = app_workspace
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text

    op = await client.get(
        f"/api/sessions/{sid}/operating-point",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert op.status_code == 200, op.text
    body = op.json()
    assert body["converged"] is True
    assert len(body["bus_voltages"]) == 14
    assert body["bus_voltages"] == pf.json()["bus_voltages"]
    assert body["bus_angles"] == pf.json()["bus_angles"]


@pytest.mark.integration
async def test_operating_point_before_load_returns_409(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """No case loaded → the read-only operating-point endpoint 409s, same as
    other routines that require a loaded system."""
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.get(
        f"/api/sessions/{sid}/operating-point",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text
