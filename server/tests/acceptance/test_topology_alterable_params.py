"""Acceptance tests for ``GET /sessions/{id}/topology/models/{model}/alterable_params``
(Unit 1b of v0.2).

The endpoint feeds the AlterSpec disturbance form's parameter dropdown.
The substrate's introspection rule mirrors ANDES's own ``alter()``
contract: a parameter is alterable iff it is a ``NumParam`` and not an
``ExtParam``. This excludes topology refs (``IdxParam``: ``bus``,
``bus1``, ``area``, ``zone``, ``coi``, etc.) and string identifiers
(``DataParam``: ``idx``, ``name``).

Tests run against the in-process ASGI app with a real ``SessionManager``
+ worker subprocess + IEEE 14 case files (the same pattern as the
existing disturbance/PF/TDS API integration suite).
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager

VALID_TOKEN = "d" * 64


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
            transport=transport, base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _create_session_and_load(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions", headers={"X-Andes-Token": VALID_TOKEN})
    sid = str(resp.json()["session_id"])
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    return sid


async def _create_session_only(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions", headers={"X-Andes-Token": VALID_TOKEN})
    return str(resp.json()["session_id"])


@pytest.mark.acceptance
async def test_alterable_params_bus_includes_voltage_limits(
    client: httpx.AsyncClient,
) -> None:
    """``Bus`` exposes Vn (rated voltage), vmax / vmin (operational limits),
    v0 / a0 (initial conditions), and u (in-service flag) as alterable.
    Topology refs (area, zone, owner) and string fields (idx, name) are
    excluded."""
    sid = await _create_session_and_load(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/Bus/alterable_params",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["model"] == "Bus"
    params = body["params"]
    assert isinstance(params, list)

    # Must include the canonical numeric Bus params.
    for required in ("Vn", "vmax", "vmin"):
        assert required in params, f"expected {required!r} in {params}"

    # Must NOT include topology refs / string identifiers.
    for excluded in ("idx", "name", "area", "zone", "owner", "xcoord", "ycoord"):
        assert excluded not in params, (
            f"alterable_params should exclude {excluded!r}; got {params}"
        )


@pytest.mark.acceptance
async def test_alterable_params_pq_includes_p0_q0_vn(
    client: httpx.AsyncClient,
) -> None:
    """``PQ`` (constant-power load) exposes p0, q0, Vn as alterable. The
    bus reference is excluded (it's an ``IdxParam``)."""
    sid = await _create_session_and_load(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/PQ/alterable_params",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in ("p0", "q0", "Vn"):
        assert required in params, f"expected {required!r} in {params}"
    assert "bus" not in params, f"bus is an IdxParam; should not appear in {params}"


@pytest.mark.acceptance
async def test_alterable_params_genrou_includes_inertia_damping(
    client: httpx.AsyncClient,
) -> None:
    """``GENROU`` (round-rotor synchronous machine) exposes inertia (M) and
    damping (D) — the two parameters researchers most commonly tweak in a
    TDS sensitivity sweep."""
    sid = await _create_session_and_load(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/GENROU/alterable_params",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in ("M", "D", "Sn", "Vn"):
        assert required in params, f"expected {required!r} in {params}"
    # Topology refs excluded.
    for excluded in ("bus", "gen", "coi", "coi2"):
        assert excluded not in params, (
            f"alterable_params should exclude IdxParam {excluded!r}; got {params}"
        )


@pytest.mark.acceptance
async def test_alterable_params_unknown_model_returns_404(
    client: httpx.AsyncClient,
) -> None:
    """An unknown model name → 404 with the wrapper's diagnostic in the
    detail field."""
    sid = await _create_session_and_load(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/NotAModel/alterable_params",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 404, resp.text
    assert "NotAModel" in resp.json()["detail"]


@pytest.mark.acceptance
async def test_alterable_params_pre_load_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Calling alterable_params before any case has been loaded → 409
    (matches the existing route patterns; the UI is directed to load a
    case first)."""
    sid = await _create_session_only(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/Bus/alterable_params",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.acceptance
async def test_alterable_params_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    """An unknown session_id → 404."""
    resp = await client.get(
        "/api/sessions/no-such-session/topology/models/Bus/alterable_params",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.acceptance
async def test_alterable_params_missing_token_returns_401(
    client: httpx.AsyncClient,
) -> None:
    """Auth gate — missing X-Andes-Token → 401 before any worker dispatch."""
    sid = await _create_session_and_load(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/Bus/alterable_params"
    )
    assert resp.status_code == 401, resp.text


@pytest.mark.acceptance
async def test_alterable_params_wrong_token_returns_401(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client)
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/Bus/alterable_params",
        headers={"X-Andes-Token": "wrong"},
    )
    assert resp.status_code == 401, resp.text


@pytest.mark.acceptance
async def test_alterable_params_post_setup_still_works(
    client: httpx.AsyncClient,
) -> None:
    """Introspection survives setup() — once PF has run and the System is
    committed, ``model.params`` is still populated. The UI may need this
    after the user reaches the run-results state."""
    sid = await _create_session_and_load(client)
    # Run PF to commit setup
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text
    resp = await client.get(
        f"/api/sessions/{sid}/topology/models/Bus/alterable_params",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    assert "Vn" in params
