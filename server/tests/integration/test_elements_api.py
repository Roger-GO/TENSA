"""Integration tests for the topology-mutation endpoints (Unit 2).

Covers POST /elements (add), PUT /elements/{model}/{idx} (edit), and
POST /blank (create blank). Uses a real SessionManager + worker
subprocess and the bundled ANDES IEEE 14 case for the load-and-edit
paths.

Unit 1 of v0.1.y adds DELETE /elements/{model}/{idx} coverage at the
bottom of this file.
"""

from __future__ import annotations

import shutil
import time
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
    # Dynamic machines expose the mandatory ``gen`` link (a gen_idx picker) so
    # they can actually be built from scratch — ANDES rejects them otherwise.
    for dyn in ("GENROU", "GENCLS"):
        params = {p["name"]: p for p in body["models"][dyn]}
        assert params["gen"]["required"] is True, f"{dyn}.gen must be required"
        assert params["gen"]["kind"] == "gen_idx", f"{dyn}.gen must be a gen_idx picker"


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
    line_idxs = [str(line["idx"]) for line in topo["lines"]]
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


# ---- DELETE /elements/{model}/{idx} (Unit 1, v0.1.y) ----------------------


def _bundled_ieee39_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee39"


@pytest.fixture
async def client_ieee39(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Like ``client`` but workspaces the IEEE 39 .raw alongside IEEE 14.

    Used by the latency-budget perf test that runs delete on both cases.
    """
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    src14 = _bundled_ieee14_dir()
    for name in ("ieee14.raw", "ieee14.dyr"):
        shutil.copy2(src14 / name, workspace / name)
    src39 = _bundled_ieee39_dir()
    shutil.copy2(src39 / "ieee39.raw", workspace / "ieee39.raw")

    app = make_app(
        expected_token=VALID_TOKEN,
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
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


async def _add_bus(
    client: httpx.AsyncClient, sid: str, idx: str, name: str | None = None
) -> httpx.Response:
    return await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "Bus",
            "params": {
                "idx": idx,
                "name": name or f"BUS{idx}",
                "Vn": 100.0,
            },
        },
    )


@pytest.mark.integration
async def test_delete_blank_session_removes_middle_bus(
    client: httpx.AsyncClient,
) -> None:
    """Happy path: blank session + add 3 buses + delete Bus 2 ->
    topology has Bus 1 and Bus 3 only."""
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    for bus_idx in ("1", "2", "3"):
        resp = await _add_bus(client, sid, bus_idx)
        assert resp.status_code == 201, resp.text
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/2",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    topo = resp.json()
    assert sorted(str(b["idx"]) for b in topo["buses"]) == ["1", "3"]


@pytest.mark.integration
async def test_delete_added_bus_on_loaded_ieee14(
    client: httpx.AsyncClient,
) -> None:
    """Happy path: loaded IEEE 14 + add a 15th bus + delete it ->
    topology back to 14 buses."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await _add_bus(client, sid, "100", name="EXTRA")
    assert resp.status_code == 201, resp.text
    topo_resp = await client.get(
        f"/api/sessions/{sid}/topology",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert len(topo_resp.json()["buses"]) == 15
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/100",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    topo = resp.json()
    assert len(topo["buses"]) == 14
    assert "100" not in [str(b["idx"]) for b in topo["buses"]]


@pytest.mark.integration
async def test_delete_bus_with_line_dependent_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Delete a Bus that has a Line attached -> 422 + dependents = [Line].
    After deleting the Line, Bus deletion succeeds."""
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    for bus_idx in ("1", "2"):
        assert (await _add_bus(client, sid, bus_idx)).status_code == 201
    line_resp = await client.post(
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
    assert line_resp.status_code == 201, line_resp.text
    # Delete bus 1 -> 422 with the Line dependent.
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/1",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["total"] == 1
    assert len(body["dependents"]) == 1
    assert body["dependents"][0]["kind"] == "Line"
    assert str(body["dependents"][0]["idx"]) == "L12"
    # Drop the Line first; Bus 1 deletion should now succeed.
    line_del = await client.delete(
        f"/api/sessions/{sid}/elements/Line/L12",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert line_del.status_code == 200, line_del.text
    bus_del = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/1",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert bus_del.status_code == 200, bus_del.text


@pytest.mark.integration
async def test_delete_bus_with_multiple_dependents_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Delete a Bus with Line + Generator + Load attached -> 422
    + dependents list contains all three."""
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    for bus_idx in ("1", "2"):
        assert (await _add_bus(client, sid, bus_idx)).status_code == 201
    # Line (refs bus 1 + bus 2 via bus1/bus2)
    await client.post(
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
    # PV generator on bus 1
    await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "PV",
            "params": {
                "idx": "G1",
                "name": "G1",
                "bus": "1",
                "Sn": 100.0,
                "Vn": 100.0,
                "p0": 0.5,
                "v0": 1.0,
            },
        },
    )
    # PQ load on bus 1
    await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "PQ",
            "params": {
                "idx": "PQ1",
                "name": "PQ1",
                "bus": "1",
                "Vn": 100.0,
                "p0": 0.2,
                "q0": 0.05,
            },
        },
    )
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/1",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["total"] == 3
    kinds = sorted(d["kind"] for d in body["dependents"])
    assert kinds == ["Line", "PQ", "PV"]


@pytest.mark.integration
async def test_delete_generator_has_no_dependents(
    client: httpx.AsyncClient,
) -> None:
    """Delete a generator -> no dependents check needed; succeeds."""
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert (await _add_bus(client, sid, "1")).status_code == 201
    await client.post(
        f"/api/sessions/{sid}/elements",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "model": "PV",
            "params": {
                "idx": "G1",
                "name": "G1",
                "bus": "1",
                "Sn": 100.0,
                "Vn": 100.0,
                "p0": 0.5,
                "v0": 1.0,
            },
        },
    )
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/PV/G1",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["generators"] == []


@pytest.mark.integration
async def test_delete_case_file_originated_returns_422_with_reload_message(
    client: httpx.AsyncClient,
) -> None:
    """Delete an idx not in the replay buffer (case-file-originated) ->
    422 with the verbatim 'reload to revert' message."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    # Bus 1 is in the loaded case but never added via the replay buffer.
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/1",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 422, resp.text
    expected = (
        "This element came from the loaded case file. "
        "Use the Reload button in the workflow toolbar to "
        "reset to the original case."
    )
    assert expected in resp.text


@pytest.mark.integration
async def test_delete_after_pf_returns_409(client: httpx.AsyncClient) -> None:
    """Delete on a committed session -> 409 with the standard /reload directive."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    # Add a bus first so we have something user-added to delete.
    await _add_bus(client, sid, "100", name="EXTRA")
    # Commit setup via PF
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/100",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text
    assert "/reload" in resp.text


@pytest.mark.integration
async def test_delete_unknown_idx_returns_404(client: httpx.AsyncClient) -> None:
    """Delete with a non-existent idx -> 404."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/999",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_delete_unknown_model_returns_422(client: httpx.AsyncClient) -> None:
    """Whitelist check: unknown model name -> 422 BEFORE cascade detection."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/NoSuchModel/1",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 422, resp.text
    assert "unknown model" in resp.text.lower() or "supported models" in resp.text


@pytest.mark.integration
async def test_delete_requires_auth(client: httpx.AsyncClient) -> None:
    """DELETE without X-Andes-Token -> 401."""
    sid = await _create_session(client)
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/1",
    )
    assert resp.status_code == 401, resp.text


@pytest.mark.integration
async def test_delete_atomicity_replay_failure_preserves_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Atomicity: a synthetic replay-failure injection leaves ss + replay
    buffer unchanged.

    Drives the wrapper directly (no Pipe) because the failure injection
    needs to control the rebuild path. The wrapper's snapshot/rollback
    logic is the unit under test.

    Injection strategy: monkey-patch the wrapper's blank-replay method to
    raise mid-rebuild. The pre-delete ss + replay_buffer are captured
    before the call; after the failure the wrapper must have restored
    both to the pre-call snapshots.
    """
    pytest.importorskip("andes")
    from andes_app.core import wrapper as wrapper_mod
    from andes_app.core.errors import ElementValidationError
    from andes_app.core.wrapper import Wrapper

    w = Wrapper()
    w.create_blank()
    # Build up 3 valid buses in the replay buffer.
    w.add_element("Bus", {"idx": "1", "name": "B1", "Vn": 100.0})
    w.add_element("Bus", {"idx": "2", "name": "B2", "Vn": 100.0})
    w.add_element("Bus", {"idx": "3", "name": "B3", "Vn": 100.0})

    pre_ss = w._ss
    pre_buffer = list(w._replay_buffer)

    # Patch the rebuild path so it raises mid-replay. ``delete_element`` is
    # blank-session here, so the failure surfaces inside ``_reload_blank_locked``.
    def _boom(self: Wrapper) -> None:
        raise wrapper_mod.ElementValidationError("synthetic replay failure")

    monkeypatch.setattr(Wrapper, "_reload_blank_locked", _boom)

    with pytest.raises(ElementValidationError):
        w.delete_element("Bus", "2")

    # Snapshot must be restored: ss and buffer are unchanged.
    assert w._ss is pre_ss
    assert w._replay_buffer == pre_buffer


@pytest.mark.integration
async def test_delete_perf_under_one_second_ieee14_and_ieee39(
    client_ieee39: httpx.AsyncClient,
) -> None:
    """Latency budget: delete completes in <1s on IEEE 14 + IEEE 39.

    Each case loads the substrate's bundled .raw (~14 / ~39 buses), adds
    one extra Bus, deletes it, and asserts the wallclock delta is
    under the 1.0s budget per the v0.1.y latency contract.
    """
    for case_name, primary in (("ieee14", "ieee14.raw"), ("ieee39", "ieee39.raw")):
        sid = await _create_session(client_ieee39)
        load = await client_ieee39.post(
            f"/api/sessions/{sid}/case",
            headers={"X-Andes-Token": VALID_TOKEN},
            json={"primary_path": primary},
        )
        assert load.status_code == 200, load.text
        add = await _add_bus(client_ieee39, sid, "9999", name="PERFEXTRA")
        assert add.status_code == 201, add.text
        t0 = time.perf_counter()
        resp = await client_ieee39.delete(
            f"/api/sessions/{sid}/elements/Bus/9999",
            headers={"X-Andes-Token": VALID_TOKEN},
        )
        elapsed = time.perf_counter() - t0
        assert resp.status_code == 200, resp.text
        assert elapsed < 1.0, (
            f"delete on {case_name} took {elapsed:.3f}s; budget is 1.0s"
        )


@pytest.mark.integration
async def test_find_dependents_covers_every_whitelisted_model() -> None:
    """Coverage assertion: every model in ``_PARAMS_BY_MODEL`` is exercised
    by ``_find_dependents`` (either as the target — Bus — or via its
    reference attributes pointing at a Bus).

    The test loops over the whitelist dict and verifies the cascade
    walker's reference-attrs table covers every non-Bus model. The Bus
    entry has no outgoing references and is the ``model`` parameter
    rather than an entry in ``_REFERENCE_ATTRS``.
    """
    pytest.importorskip("andes")
    from andes_app.core.wrapper import _PARAMS_BY_MODEL, _REFERENCE_ATTRS

    expected_models = set(_PARAMS_BY_MODEL.keys()) - {"Bus"}
    covered_models = set(_REFERENCE_ATTRS.keys())
    assert expected_models == covered_models, (
        f"models in _PARAMS_BY_MODEL but not in _REFERENCE_ATTRS: "
        f"{expected_models - covered_models}; "
        f"models in _REFERENCE_ATTRS but not in _PARAMS_BY_MODEL: "
        f"{covered_models - expected_models}"
    )
    # Each entry's reference attribute(s) must be in the model's
    # parameter whitelist (otherwise the walker would read non-existent
    # attributes off the ANDES System).
    for model_name, attrs in _REFERENCE_ATTRS.items():
        allowed = {p.name for p in _PARAMS_BY_MODEL[model_name]}
        for attr in attrs:
            assert attr in allowed, (
                f"{model_name}.{attr} is in _REFERENCE_ATTRS but not in "
                f"_PARAMS_BY_MODEL[{model_name!r}]"
            )
