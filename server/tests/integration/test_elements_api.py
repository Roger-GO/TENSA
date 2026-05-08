"""Integration tests for the topology-mutation endpoints (Unit 2).

Covers POST /elements (add), PUT /elements/{model}/{idx} (edit), and
POST /blank (create blank). Uses a real SessionManager + worker
subprocess and the bundled ANDES IEEE 14 case for the load-and-edit
paths.
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
    for name in ("ieee14.raw", "ieee14.dyr"):
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
            transport=transport,
            base_url="http://127.0.0.1:8000",
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _create_session(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions", headers={"X-Andes-Token": VALID_TOKEN})
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


async def _load_ieee14(client: httpx.AsyncClient, sid: str) -> None:
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw"},
    )
    assert resp.status_code == 200, resp.text


# ---- topology shape extension ---------------------------------------------


@pytest.mark.integration
async def test_topology_includes_shunts_bucket(client: httpx.AsyncClient) -> None:
    """IEEE 14 has a shunt capacitor on bus 9 — substrate should expose it."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "shunts" in body
    assert isinstance(body["shunts"], list)
    assert len(body["shunts"]) >= 1


@pytest.mark.integration
async def test_topology_splits_lines_and_transformers(
    client: httpx.AsyncClient,
) -> None:
    """IEEE 14 has both pure lines and transformers (off-nominal tap)."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    body = resp.json()
    assert len(body["lines"]) > 0
    assert len(body["transformers"]) > 0
    # Every transformer entry has tap != 1.0 OR phi != 0.0
    for trafo in body["transformers"]:
        tap = trafo["params"].get("tap", 1.0)
        phi = trafo["params"].get("phi", 0.0)
        assert abs(tap - 1.0) > 1e-9 or abs(phi) > 1e-9, trafo
    # Every line entry has tap == 1.0 AND phi == 0.0 (within tolerance)
    for line in body["lines"]:
        tap = line["params"].get("tap", 1.0)
        phi = line["params"].get("phi", 0.0)
        assert abs(tap - 1.0) <= 1e-9 and abs(phi) <= 1e-9, line


# ---- topology schema endpoint ---------------------------------------------


@pytest.mark.integration
async def test_get_topology_schema(client: httpx.AsyncClient) -> None:
    resp = await client.get(
        "/api/topology/schema",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "models" in body
    # Every supported model is present.
    for model in ("Bus", "Line", "PV", "Slack", "GENROU", "GENCLS", "PQ", "ZIP", "Shunt"):
        assert model in body["models"]
    # Bus has Vn as a required number with kV unit.
    bus_params = {p["name"]: p for p in body["models"]["Bus"]}
    assert bus_params["Vn"]["required"] is True
    assert bus_params["Vn"]["kind"] == "number"
    assert bus_params["Vn"]["unit"] == "kV"


@pytest.mark.integration
async def test_topology_schema_requires_auth(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/topology/schema")
    assert resp.status_code == 401, resp.text


# ---- POST /blank -----------------------------------------------------------


@pytest.mark.integration
async def test_create_blank_on_fresh_session(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["topology"]["state"] == "pre-setup"
    assert body["topology"]["buses"] == []
    assert body["topology"]["lines"] == []
    assert body["topology"]["shunts"] == []


@pytest.mark.integration
async def test_create_blank_when_case_loaded_returns_409(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_blank_requires_auth(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    resp = await client.post(f"/api/sessions/{sid}/blank")
    assert resp.status_code == 401, resp.text


# ---- POST /elements (add) -------------------------------------------------


@pytest.mark.integration
async def test_add_bus_to_blank_session(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "Bus",
            "params": {"idx": "1", "name": "BUS1", "Vn": 100.0},
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["element"]["kind"] == "Bus"
    assert body["element"]["name"] == "BUS1"


@pytest.mark.integration
async def test_add_line_after_buses_exist(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    for bus_idx in ("1", "2"):
        await client.post(
            f"/api/sessions/{sid}/elements",
            headers={"X-Andes-Token": VALID_TOKEN},
            json={
                "model": "Bus",
                "params": {"idx": bus_idx, "name": f"BUS{bus_idx}", "Vn": 100.0},
            },
        )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "Line",
            "params": {
                "idx": "L12",
                "name": "L12",
                "bus1": "1",
                "bus2": "2",
                "r": 0.01,
                "x": 0.05,
            },
        },
    )
    assert resp.status_code == 201, resp.text


@pytest.mark.integration
async def test_add_transformer_via_line_with_tap(
    client: httpx.AsyncClient,
) -> None:
    """Adding a Line with non-default tap routes into the transformers
    bucket on the next topology read."""
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    for bus_idx in ("1", "2"):
        await client.post(
            f"/api/sessions/{sid}/elements",
            headers={"X-Andes-Token": VALID_TOKEN},
            json={
                "model": "Bus",
                "params": {"idx": bus_idx, "name": f"BUS{bus_idx}", "Vn": 100.0},
            },
        )
    await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "Line",
            "params": {
                "idx": "T12",
                "name": "T12",
                "bus1": "1",
                "bus2": "2",
                "r": 0.01,
                "x": 0.05,
                "tap": 1.05,
            },
        },
    )
    topo = (await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )).json()
    transformer_idxs = [str(t["idx"]) for t in topo["transformers"]]
    line_idxs = [str(l["idx"]) for l in topo["lines"]]
    assert "T12" in transformer_idxs
    assert "T12" not in line_idxs


@pytest.mark.integration
async def test_add_element_post_pf_returns_409(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    # PF commits setup
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "Bus",
            "params": {"idx": "99", "name": "BUS99", "Vn": 100.0},
        },
    )
    assert resp.status_code == 409, resp.text
    assert "/reload" in resp.text


@pytest.mark.integration
async def test_add_element_unknown_model_returns_422(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"model": "NoSuchModel", "params": {}},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_add_element_unknown_param_keys_returns_422(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "Bus",
            "params": {"idx": "1", "name": "BUS1", "Vn": 100.0, "made_up": 7},
        },
    )
    assert resp.status_code == 422, resp.text
    assert "made_up" in resp.text
    assert "allowed keys" in resp.text


@pytest.mark.integration
async def test_add_element_oversize_body_returns_413(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    huge_name = "X" * (65 * 1024)
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"model": "Bus", "params": {"idx": "1", "name": huge_name, "Vn": 100.0}},
    )
    assert resp.status_code == 413, resp.text


@pytest.mark.integration
async def test_add_element_requires_auth(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        json={"model": "Bus", "params": {"idx": "1", "name": "B", "Vn": 100.0}},
    )
    assert resp.status_code == 401, resp.text


# ---- PUT /elements/{model}/{idx} (edit) -----------------------------------


@pytest.mark.integration
async def test_edit_element_updates_param(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    # Edit BUS1's Vn from default to 110
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/1",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"params": {"Vn": 110.0}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "Bus"
    assert body["params"]["Vn"] == 110.0


@pytest.mark.integration
async def test_edit_element_unknown_idx_returns_404(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/999",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"params": {"Vn": 110.0}},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_edit_element_post_pf_returns_409(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/1",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"params": {"Vn": 110.0}},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_edit_element_idx_field_rejected(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/1",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"params": {"idx": "renamed"}},
    )
    assert resp.status_code == 422, resp.text


# ---- replay buffer + blank-session reload ---------------------------------


@pytest.mark.integration
async def test_save_raw_format_round_trips_through_andes_reader(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    """The substrate's PSS/E v33 writer should produce a file that
    ANDES's own reader can parse back without errors. Verifies the
    block structure + column layout match v33's expectations."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.post(
        f"/api/sessions/{sid}/save",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"filename": "round-trip.raw", "format": "raw"},
    )
    assert resp.status_code == 201, resp.text

    # Locate the workspace dir from the test fixture; the file landed there.
    # The fixture exposes the workspace path indirectly — we know it's the
    # test-managed workspace dir, accessible via a fresh GET on the lister.
    list_resp = await client.get(
        "/api/workspace/files",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    files = list_resp.json()["files"]
    assert any(f["name"] == "round-trip.raw" for f in files), files

    # Read the file off disk and round-trip through ANDES.
    import andes
    from pathlib import Path as _Path  # avoid shadowing

    # The fixture's workspace is in tmp_path/ws (see the `client` fixture).
    workspace = tmp_path / "ws"
    raw_path = workspace / "round-trip.raw"
    assert raw_path.exists(), f"file not on disk: {raw_path}"
    ss = andes.load(str(raw_path), setup=False, no_output=True, default_config=True)
    assert ss is not None, "ANDES failed to parse the substrate-emitted raw file"
    # Spot-check: the round-tripped System should have the same bus count.
    assert ss.Bus.n == 14
    assert ss.Line.n >= 16  # IEEE 14 has 16 branches + transformers
    # PV + Slack + GENROU + GENCLS combined should match the source.
    assert ss.PV.n + ss.Slack.n + ss.GENROU.n + ss.GENCLS.n >= 5


@pytest.mark.integration
async def test_blank_session_reload_replays_adds(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    for bus_idx in ("1", "2", "3"):
        await client.post(
            f"/api/sessions/{sid}/elements",
            headers={"X-Andes-Token": VALID_TOKEN},
            json={
                "model": "Bus",
                "params": {"idx": bus_idx, "name": f"BUS{bus_idx}", "Vn": 100.0},
            },
        )
    # Reload the blank session — replay buffer should re-create all 3 buses.
    resp = await client.post(
        f"/api/sessions/{sid}/reload",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    topo = resp.json()
    assert len(topo["buses"]) == 3
    bus_idxs = sorted(str(b["idx"]) for b in topo["buses"])
    assert bus_idxs == ["1", "2", "3"]
