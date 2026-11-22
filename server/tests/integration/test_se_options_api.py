"""Integration tests for the SE run options over the REST API.

Same flow as the existing SE integration tests: load the bundled IEEE 14
case, run the power flow, generate the measurement set, then POST /se
with the new per-run options.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager

CASE_FILE = "ieee14_full.xlsx"
BUS_COUNT = 14


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    from tensa.core.examples import seed_example_cases

    seed_example_cases(workspace)
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
            timeout=60.0,
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _ready_session(client: httpx.AsyncClient) -> str:
    """A session with the case loaded, PF converged, measurements generated."""
    session_id = (await client.post("/api/sessions")).json()["session_id"]
    resp = await client.post(
        f"/api/sessions/{session_id}/case", json={"primary_path": CASE_FILE}
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"/api/sessions/{session_id}/pflow", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["converged"] is True
    resp = await client.post(
        f"/api/sessions/{session_id}/se/measurements/generate", json={}
    )
    assert resp.status_code == 200, resp.text
    return session_id


async def _run_se(client: httpx.AsyncClient, session_id: str, body: dict[str, Any]) -> httpx.Response:
    return await client.post(f"/api/sessions/{session_id}/se", json=body)


@pytest.mark.integration
async def test_baseline_run_reports_defaults_and_chi_squared(
    client: httpx.AsyncClient,
) -> None:
    session_id = await _ready_session(client)
    resp = await _run_se(client, session_id, {})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["algorithm"] == "wls"
    assert data["settings"]["tol"] == pytest.approx(1e-4)
    assert data["settings"]["max_iter"] == 100
    assert data["settings"]["noise_seed"] is None
    chi = data["chi_squared"]
    assert isinstance(chi["passed"], bool)
    assert chi["confidence"] == pytest.approx(0.95)
    assert chi["dof"] == data["measurement_count"] - 2 * BUS_COUNT


@pytest.mark.integration
async def test_lav_run_has_no_chi_squared_and_different_residuals(
    client: httpx.AsyncClient,
) -> None:
    session_id = await _ready_session(client)
    wls = (await _run_se(client, session_id, {})).json()
    resp = await _run_se(client, session_id, {"algorithm": "lav"})
    assert resp.status_code == 200, resp.text
    lav = resp.json()
    assert lav["algorithm"] == "lav"
    assert lav["chi_squared"] is None
    # The option had an effect: the LAV estimate is not the WLS estimate.
    assert lav["residuals"] != wls["residuals"]


@pytest.mark.integration
async def test_a_seed_makes_the_run_reproducible(client: httpx.AsyncClient) -> None:
    session_id = await _ready_session(client)
    cached = (await _run_se(client, session_id, {})).json()
    first = (await _run_se(client, session_id, {"noise_seed": 7})).json()
    second = (await _run_se(client, session_id, {"noise_seed": 7})).json()
    assert first["residuals"] == second["residuals"]
    assert first["settings"]["noise_seed"] == 7
    third = (await _run_se(client, session_id, {"noise_seed": 8})).json()
    assert third["residuals"] != first["residuals"]
    # The seed was for those runs only: the cached set is the generate
    # step's draw again.
    after = (await _run_se(client, session_id, {})).json()
    assert after["residuals"] == cached["residuals"]
    assert after["settings"]["noise_seed"] is None


@pytest.mark.integration
async def test_tol_and_max_iter_apply_for_one_run_only(
    client: httpx.AsyncClient,
) -> None:
    session_id = await _ready_session(client)
    # One iteration never converges on noisy measurements: the first
    # correction from the power-flow state is the size of the noise (1e-3
    # and more), far above the 1e-4 tolerance. ANDES reports it, it does not
    # raise, and the answer is the non-convergence 422.
    resp = await _run_se(client, session_id, {"max_iter": 1})
    assert resp.status_code == 422, resp.text
    assert "WLS did not converge after 1 iterations" in resp.json()["detail"]
    resp = await _run_se(client, session_id, {"tol": 1e-8, "max_iter": 100})
    assert resp.status_code == 200, resp.text
    assert resp.json()["settings"]["tol"] == pytest.approx(1e-8)
    assert resp.json()["settings"]["max_iter"] == 100
    # The override was put back: a plain run reports the defaults again.
    resp = await _run_se(client, session_id, {})
    assert resp.status_code == 200, resp.text
    assert resp.json()["settings"]["tol"] == pytest.approx(1e-4)
    assert resp.json()["settings"]["max_iter"] == 100


@pytest.mark.integration
@pytest.mark.parametrize(
    "body",
    [
        {"algorithm": "bogus"},
        {"tol": 0},
        {"max_iter": 0},
        {"noise_seed": -1},
        {"unknown_field": 1},
    ],
)
async def test_invalid_options_are_422(client: httpx.AsyncClient, body: dict[str, Any]) -> None:
    session_id = await _ready_session(client)
    resp = await _run_se(client, session_id, body)
    assert resp.status_code == 422, resp.text
