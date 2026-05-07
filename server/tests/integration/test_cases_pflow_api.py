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
    resp = await client.post("/sessions", headers={"X-Andes-Token": VALID_TOKEN})
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


@pytest.mark.integration
async def test_load_case_returns_topology(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)

    resp = await client.post(
        f"/sessions/{sid}/case",
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
        f"/sessions/{sid}/case",
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
        f"/sessions/{sid}/case",
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
        f"/sessions/{sid}/case",
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
        f"/sessions/{sid}/case",
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
        "/sessions/does-not-exist/case",
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
        f"/sessions/{sid}/topology",
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
        f"/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    resp = await client.post(
        f"/sessions/{sid}/pflow",
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

    # Topology after PF reflects the committed state
    topo_resp = await client.get(
        f"/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert topo_resp.json()["state"] == "committed"


@pytest.mark.integration
async def test_run_pflow_before_load_returns_409(
    app_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = app_workspace
    sid = await _create_session(client)
    resp = await client.post(
        f"/sessions/{sid}/pflow",
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
        f"/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    await client.post(
        f"/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    # State is committed
    topo = await client.get(
        f"/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert topo.json()["state"] == "committed"

    # Reload returns to pre-setup
    reload_resp = await client.post(
        f"/sessions/{sid}/reload",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert reload_resp.status_code == 200
    assert reload_resp.json()["state"] == "pre-setup"
