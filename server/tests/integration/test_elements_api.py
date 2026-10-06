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
import sys
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

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
    for name in ("ieee14.raw", "ieee14.dyr"):
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


async def _create_session(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


async def _load_ieee14(client: httpx.AsyncClient, sid: str) -> None:
    resp = await client.post(
        f"/api/sessions/{sid}/case",
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


# ---- POST /blank -----------------------------------------------------------


@pytest.mark.integration
async def test_create_blank_on_fresh_session(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    resp = await client.post(
        f"/api/sessions/{sid}/blank",
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
    )
    assert resp.status_code == 409, resp.text


# ---- POST /elements (add) -------------------------------------------------


@pytest.mark.integration
async def test_add_bus_to_blank_session(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    for bus_idx in ("1", "2"):
        await client.post(
            f"/api/sessions/{sid}/elements",
            json={
                "model": "Bus",
                "params": {"idx": bus_idx, "name": f"BUS{bus_idx}", "Vn": 100.0},
            },
        )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    for bus_idx in ("1", "2"):
        await client.post(
            f"/api/sessions/{sid}/elements",
            json={
                "model": "Bus",
                "params": {"idx": bus_idx, "name": f"BUS{bus_idx}", "Vn": 100.0},
            },
        )
    await client.post(
        f"/api/sessions/{sid}/elements",
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
    )).json()
    transformer_idxs = [str(t["idx"]) for t in topo["transformers"]]
    line_idxs = [str(line["idx"]) for line in topo["lines"]]
    assert "T12" in transformer_idxs
    assert "T12" not in line_idxs


@pytest.mark.integration
async def test_add_element_takes_a_reference_sent_as_text_on_an_integer_idx_case(
    client: httpx.AsyncClient,
) -> None:
    """A RAW case holds its bus idx as integers, and a JSON client (the web
    form among them) sends ``"5"``. ANDES took the text at ``add()`` and failed
    inside ``setup()`` with "device not exist with idx=5", so nothing could be
    added to a loaded case and then solved."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        json={
            "model": "PQ",
            "params": {
                "idx": "PQ_new", "name": "PQ_new", "bus": "5",
                "Vn": 69.0, "p0": 0.05, "q0": 0.01,
            },
        },
    )
    assert resp.status_code == 201, resp.text
    # The reference is held the way the case holds the bus: as the integer 5.
    assert resp.json()["element"]["params"]["bus"] == 5

    pf = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True
    assert pf.json()["load_consumption"]["PQ_new"]["p"] == pytest.approx(5.0)


@pytest.mark.integration
async def test_edit_element_takes_a_reference_sent_as_text_on_an_integer_idx_case(
    client: httpx.AsyncClient,
) -> None:
    """Moving a device to another bus writes the bus's own integer idx, not
    the text the client sent, so the case still sets up."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
    load_idx = str(topo["loads"][0]["idx"])
    resp = await client.put(
        f"/api/sessions/{sid}/elements/PQ/{load_idx}",
        json={"params": {"bus": "5"}},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["params"]["bus"] == 5

    pf = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True


@pytest.mark.integration
async def test_add_element_post_pf_returns_409(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    # PF commits setup
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    huge_name = "X" * (65 * 1024)
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        json={"model": "Bus", "params": {"idx": "1", "name": huge_name, "Vn": 100.0}},
    )
    assert resp.status_code == 413, resp.text


# ---- PUT /elements/{model}/{idx} (edit) -----------------------------------


@pytest.mark.integration
async def test_edit_element_updates_param(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    # Edit BUS1's Vn from default to 110
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/1",
        json={"params": {"Vn": 110.0}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "Bus"
    assert body["params"]["Vn"] == 110.0


@pytest.mark.integration
async def test_edit_line_u_outage_solves_with_zero_flow(
    client: httpx.AsyncClient,
) -> None:
    """Line connection status ``u`` is editable, and an outaged line
    solves to zero flow — the contract the bundled contingency-screening
    study (examples/contingency_screening) depends on."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
    line_idx = str(topo["lines"][0]["idx"])
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Line/{line_idx}",
        json={"params": {"u": 0}},
    )
    assert resp.status_code == 200, resp.text
    pf = (await client.post(f"/api/sessions/{sid}/pflow", json={})).json()
    assert pf["converged"] is True
    flow = pf["line_flows"][line_idx]
    assert abs(flow["p"]) < 1e-9 and abs(flow["q"]) < 1e-9


@pytest.mark.integration
async def test_edit_element_unknown_idx_returns_404(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/999",
        json={"params": {"Vn": 110.0}},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_edit_element_post_pf_returns_409(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/1",
        json={"params": {"Vn": 110.0}},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_edit_element_idx_field_rejected(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Bus/1",
        json={"params": {"idx": "renamed"}},
    )
    assert resp.status_code == 422, resp.text


async def _load_ieee14_with_machines(client: httpx.AsyncClient, sid: str) -> dict[str, object]:
    """Load the case with its .dyr file and return the first GENROU entry."""
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert resp.status_code == 200, resp.text
    topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
    machines = [g for g in topo["generators"] if g["kind"] == "GENROU"]
    assert machines, "the .dyr file should bring GENROU machines"
    entry: dict[str, object] = machines[0]
    return entry


@pytest.mark.integration
async def test_edit_genrou_takes_the_inertia_as_h(client: httpx.AsyncClient) -> None:
    """The route takes the ``H`` the schema lists and holds it as ``M`` (= 2H);
    both together are refused, whether or not they agree."""
    sid = await _create_session(client)
    machine = await _load_ieee14_with_machines(client, sid)
    url = f"/api/sessions/{sid}/elements/GENROU/{machine['idx']}"
    resp = await client.put(url, json={"params": {"H": 6.5}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["params"]["M"] == 13.0

    resp = await client.put(url, json={"params": {"H": 6.5, "M": 13.0}})
    assert resp.status_code == 422, resp.text
    assert "not both" in resp.json()["detail"]

    resp = await client.put(url, json={"params": {"H": -1}})
    assert resp.status_code == 422, resp.text
    assert "'H' must be a number above zero" in resp.json()["detail"]


@pytest.mark.integration
async def test_edit_genrou_reactance_out_of_order_returns_422_naming_the_chain(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    machine = await _load_ieee14_with_machines(client, sid)
    params = machine["params"]
    assert isinstance(params, dict)
    url = f"/api/sessions/{sid}/elements/GENROU/{machine['idx']}"
    # xd at the held transient reactance breaks xd > xd1.
    resp = await client.put(url, json={"params": {"xd": params["xd1"]}})
    assert resp.status_code == 422, resp.text
    assert "xd > xd1 > xd2 > xl" in resp.json()["detail"]
    # Nothing was written: the machine still holds the reactance it had.
    topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
    held = next(g for g in topo["generators"] if g["idx"] == machine["idx"])
    assert held["params"]["xd"] == params["xd"]


@pytest.mark.integration
async def test_edit_numeric_param_that_is_no_number_returns_422(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
    line = topo["lines"][0]
    resp = await client.put(
        f"/api/sessions/{sid}/elements/Line/{line['idx']}",
        json={"params": {"r": "abc"}},
    )
    assert resp.status_code == 422, resp.text
    assert "'r' must be a number" in resp.json()["detail"]


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
        json={"filename": "round-trip.raw", "format": "raw"},
    )
    assert resp.status_code == 201, resp.text

    # Locate the workspace dir from the test fixture; the file landed there.
    # The fixture exposes the workspace path indirectly — we know it's the
    # test-managed workspace dir, accessible via a fresh GET on the lister.
    list_resp = await client.get(
        "/api/workspace/files",
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
@pytest.mark.parametrize(
    ("filename", "fmt"),
    [
        ("CON.xlsx", "xlsx"),
        ("nul.raw", "raw"),
        ("copy:of.xlsx", "xlsx"),  # drive prefix / NTFS stream on Windows
    ],
)
async def test_save_rejects_names_windows_would_misread(
    client: httpx.AsyncClient,
    tmp_path: Path,
    filename: str,
    fmt: str,
) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.post(
        f"/api/sessions/{sid}/save",
        json={"filename": filename, "format": fmt},
    )
    assert resp.status_code == 422, resp.text
    assert "unsafe file name" in resp.json()["detail"]
    assert sorted(p.name for p in (tmp_path / "ws").iterdir()) == ["ieee14.dyr", "ieee14.raw"]


@pytest.mark.integration
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
@pytest.mark.parametrize("overwrite", [False, True])
async def test_save_refuses_dangling_symlink_to_outside_the_workspace(
    client: httpx.AsyncClient,
    tmp_path: Path,
    overwrite: bool,
) -> None:
    """The link's destination does not exist, so ``exists()`` is False and only an
    ``lstat``-based check sees it; ANDES would write through it, outside the workspace."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "ws" / "out.xlsx").symlink_to(outside / "planted.xlsx")
    resp = await client.post(
        f"/api/sessions/{sid}/save",
        json={"filename": "out.xlsx", "format": "xlsx", "overwrite": overwrite},
    )
    assert resp.status_code == 422, resp.text
    assert "symlink" in resp.json()["detail"]
    assert list(outside.iterdir()) == []


@pytest.mark.integration
async def test_blank_session_reload_replays_adds(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session(client)
    await client.post(
        f"/api/sessions/{sid}/blank",
    )
    for bus_idx in ("1", "2", "3"):
        await client.post(
            f"/api/sessions/{sid}/elements",
            json={
                "model": "Bus",
                "params": {"idx": bus_idx, "name": f"BUS{bus_idx}", "Vn": 100.0},
            },
        )
    # Reload the blank session — replay buffer should re-create all 3 buses.
    resp = await client.post(
        f"/api/sessions/{sid}/reload",
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
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0)
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


async def _add_bus(
    client: httpx.AsyncClient, sid: str, idx: str, name: str | None = None
) -> httpx.Response:
    return await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    for bus_idx in ("1", "2", "3"):
        resp = await _add_bus(client, sid, bus_idx)
        assert resp.status_code == 201, resp.text
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/2",
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
    )
    assert len(topo_resp.json()["buses"]) == 15
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/100",
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
    )
    for bus_idx in ("1", "2"):
        assert (await _add_bus(client, sid, bus_idx)).status_code == 201
    line_resp = await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    assert line_del.status_code == 200, line_del.text
    bus_del = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/1",
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
    )
    for bus_idx in ("1", "2"):
        assert (await _add_bus(client, sid, bus_idx)).status_code == 201
    # Line (refs bus 1 + bus 2 via bus1/bus2)
    await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    assert (await _add_bus(client, sid, "1")).status_code == 201
    await client.post(
        f"/api/sessions/{sid}/elements",
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
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["generators"] == []


@pytest.mark.integration
async def test_delete_an_element_the_case_file_brought(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """A line of the loaded case is deleted like one added since: it is gone
    from the topology and from the power flow, and the file is not written."""
    case = tmp_path / "ws" / "ieee14.raw"
    before = case.read_bytes()
    sid = await _create_session(client)
    await _load_ieee14(client, sid)

    resp = await client.delete(f"/api/sessions/{sid}/elements/Line/Line_3")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "Line_3" not in {line["idx"] for line in body["lines"] + body["transformers"]}
    assert len(body["lines"]) + len(body["transformers"]) == 19
    assert [(d["kind"], d["idx"]) for d in body["deleted"]] == [("Line", "Line_3")]
    assert body["disturbances"] == []
    assert body["undo"] == {
        "op": "delete", "model": "Line", "idx": "Line_3", "params": [], "also": 0,
    }
    assert case.read_bytes() == before

    pflow = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert pflow.status_code == 200, pflow.text
    assert pflow.json()["converged"] is True
    assert "Line_3" not in pflow.json()["line_flows"]


@pytest.mark.integration
async def test_delete_a_case_bus_is_refused_until_cascade_takes_what_is_on_it(
    client: httpx.AsyncClient,
) -> None:
    """Bus 3 of IEEE 14 carries a generator, a load and two lines. Alone it
    cannot go; with ``cascade`` they all go, as one edit an undo brings back."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    full = (await client.get(f"/api/sessions/{sid}/topology")).json()

    blocked = await client.delete(f"/api/sessions/{sid}/elements/Bus/3")

    assert blocked.status_code == 422, blocked.text
    body = blocked.json()
    on_the_bus = {(d["kind"], str(d["idx"])) for d in body["dependents"]}
    assert on_the_bus == {("PV", "3"), ("PQ", "PQ_2"), ("Line", "Line_3"), ("Line", "Line_6")}
    assert body["total"] == 4
    assert body["disturbances"] == [] and body["disturbances_total"] == 0
    assert "cascade=true" in body["detail"]
    # Refused means untouched.
    assert (await client.get(f"/api/sessions/{sid}/topology")).json() == full

    done = await client.delete(f"/api/sessions/{sid}/elements/Bus/3", params={"cascade": "true"})

    assert done.status_code == 200, done.text
    after = done.json()
    assert {(d["kind"], str(d["idx"])) for d in after["deleted"]} == on_the_bus | {("Bus", "3")}
    assert after["deleted"][-1]["kind"] == "Bus"
    assert len(after["buses"]) == 13
    assert after["undo"]["op"] == "delete" and after["undo"]["also"] == 4
    assert (await client.post(f"/api/sessions/{sid}/pflow", json={})).json()["converged"] is True

    await client.post(f"/api/sessions/{sid}/reload")
    await client.delete(f"/api/sessions/{sid}/elements/Bus/3", params={"cascade": "true"})
    undone = await client.post(f"/api/sessions/{sid}/undo-last-edit")
    assert undone.status_code == 200, undone.text
    restored = undone.json()
    assert restored["redo"]["op"] == "delete" and restored["undo"] is None
    for key in ("buses", "lines", "transformers", "generators", "loads", "shunts"):
        assert restored[key] == full[key], key


@pytest.mark.integration
async def test_undo_and_redo_take_back_and_put_back_any_kind_of_edit(
    client: httpx.AsyncClient,
) -> None:
    """One history for an add, a change and a delete: each undo takes back the
    newest, whatever it was, and leaves the ones before it."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)

    async def bus_100() -> dict[str, Any] | None:
        topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
        found = [b for b in topo["buses"] if str(b["idx"]) == "100"]
        return found[0] if found else None

    assert (await _add_bus(client, sid, "100", name="EXTRA")).status_code == 201
    edited = await client.put(
        f"/api/sessions/{sid}/elements/Bus/100", json={"params": {"Vn": 230.0}}
    )
    assert edited.status_code == 200, edited.text
    deleted = await client.delete(f"/api/sessions/{sid}/elements/Bus/100")
    assert deleted.status_code == 200, deleted.text
    assert await bus_100() is None

    async def undo() -> dict[str, Any]:
        resp = await client.post(f"/api/sessions/{sid}/undo-last-edit")
        assert resp.status_code == 200, resp.text
        return dict(resp.json())

    async def redo() -> dict[str, Any]:
        resp = await client.post(f"/api/sessions/{sid}/redo-edit")
        assert resp.status_code == 200, resp.text
        return dict(resp.json())

    # The delete comes back with the value the edit gave it.
    topo = await undo()
    assert topo["undo"] == {"op": "edit", "model": "Bus", "idx": "100", "params": ["Vn"], "also": 0}
    assert topo["redo"] == {"op": "delete", "model": "Bus", "idx": "100", "params": [], "also": 0}
    bus = await bus_100()
    assert bus is not None and bus["params"]["Vn"] == 230.0
    # The edit goes, the bus stays.
    topo = await undo()
    assert topo["undo"] == {"op": "add", "model": "Bus", "idx": "100", "params": [], "also": 0}
    bus = await bus_100()
    assert bus is not None and bus["params"]["Vn"] == 100.0
    # The add goes.
    topo = await undo()
    assert topo["undo"] is None and await bus_100() is None
    nothing = await client.post(f"/api/sessions/{sid}/undo-last-edit")
    assert nothing.status_code == 422 and "no edits to undo" in nothing.text

    await redo()
    await redo()
    bus = await bus_100()
    assert bus is not None and bus["params"]["Vn"] == 230.0
    topo = await redo()
    assert topo["redo"] is None and await bus_100() is None
    nothing = await client.post(f"/api/sessions/{sid}/redo-edit")
    assert nothing.status_code == 422 and "no edits to redo" in nothing.text

    # A new edit after an undo leaves nothing to redo.
    await undo()
    assert (await _add_bus(client, sid, "101")).status_code == 201
    topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert topo["redo"] is None and topo["undo"]["idx"] == "101"


@pytest.mark.integration
async def test_undo_and_redo_after_pf_return_409(client: httpx.AsyncClient) -> None:
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    await _add_bus(client, sid, "100", name="EXTRA")
    await _add_bus(client, sid, "101", name="EXTRA2")
    assert (await client.post(f"/api/sessions/{sid}/undo-last-edit")).status_code == 200
    await client.post(f"/api/sessions/{sid}/pflow", json={})

    for route in ("undo-last-edit", "redo-edit"):
        resp = await client.post(f"/api/sessions/{sid}/{route}")
        assert resp.status_code == 409, resp.text
        assert "/reload" in resp.text


@pytest.mark.integration
async def test_delete_warns_about_the_disturbances_that_act_on_the_element(
    client: httpx.AsyncClient,
) -> None:
    """A committed fault on bus 14 and a trip of its line stand in the way of
    deleting that line or that bus; a fault elsewhere does not, and stays
    committed when the others go."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    specs = [
        {"kind": "fault", "bus_idx": 14, "tf": 1.0, "tc": 1.1},
        {"kind": "toggle", "model": "Line", "dev_idx": "Line_13", "t": 2.0},
        {"kind": "fault", "bus_idx": 5, "tf": 3.0, "tc": 3.1},
    ]
    committed = await client.post(
        f"/api/sessions/{sid}/disturbances", json={"disturbances": specs}
    )
    assert committed.status_code == 200, committed.text

    # An element nothing acts on goes, and every disturbance stays.
    free = await client.delete(f"/api/sessions/{sid}/elements/Line/Line_3")
    assert free.status_code == 200, free.text
    listed = (await client.get(f"/api/sessions/{sid}/disturbances")).json()["disturbances"]
    assert [d["kind"] for d in listed] == ["fault", "toggle", "fault"]

    blocked = await client.delete(f"/api/sessions/{sid}/elements/Line/Line_13")
    assert blocked.status_code == 422, blocked.text
    body = blocked.json()
    assert body["dependents"] == [] and body["total"] == 0
    assert body["disturbances"] == [
        {"source": "committed", "kind": "toggle", "model": "Line", "dev_idx": "Line_13",
         "t": 2.0, "name": None}
    ]
    assert "1 disturbance(s)" in body["detail"]

    done = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/14", params={"cascade": "true"}
    )
    assert done.status_code == 200, done.text
    assert {(d["kind"], d["dev_idx"]) for d in done.json()["disturbances"]} == {
        ("fault", 14), ("toggle", "Line_13"),
    }
    listed = (await client.get(f"/api/sessions/{sid}/disturbances")).json()["disturbances"]
    assert [(d["kind"], d["bus_idx"]) for d in listed] == [("fault", 5)]

    # Taking the delete back brings the two disturbances back where they were.
    assert (await client.post(f"/api/sessions/{sid}/undo-last-edit")).status_code == 200
    listed = (await client.get(f"/api/sessions/{sid}/disturbances")).json()["disturbances"]
    assert [d["kind"] for d in listed] == ["fault", "toggle", "fault"]
    assert listed[0]["bus_idx"] == 14 and listed[2]["bus_idx"] == 5

    # Putting the delete back takes those two again and no more: a fault
    # committed on the bus since stands in the way, and is what the 422 lists.
    late = {"kind": "fault", "bus_idx": 14, "tf": 4.0, "tc": 4.1}
    committed = await client.post(
        f"/api/sessions/{sid}/disturbances", json={"disturbances": [late]}
    )
    assert committed.status_code == 200, committed.text
    refused = await client.post(f"/api/sessions/{sid}/redo-edit")
    assert refused.status_code == 422, refused.text
    body = refused.json()
    assert body["dependents"] == [] and body["total"] == 0
    assert [(d["source"], d["kind"], d["dev_idx"], d["t"]) for d in body["disturbances"]] == [
        ("committed", "fault", 14, 4.0)
    ]
    assert body["disturbances_total"] == 1
    listed = (await client.get(f"/api/sessions/{sid}/disturbances")).json()["disturbances"]
    assert len(listed) == 4
    topo = (await client.get(f"/api/sessions/{sid}/topology")).json()
    assert topo["redo"]["op"] == "delete" and topo["redo"]["idx"] == 14


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
        json={},
    )
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/Bus/100",
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
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_delete_unknown_model_returns_422(client: httpx.AsyncClient) -> None:
    """Whitelist check: unknown model name -> 422 BEFORE cascade detection."""
    sid = await _create_session(client)
    await _load_ieee14(client, sid)
    resp = await client.delete(
        f"/api/sessions/{sid}/elements/NoSuchModel/1",
    )
    assert resp.status_code == 422, resp.text
    assert "unknown model" in resp.text.lower()


@pytest.mark.integration
async def test_delete_atomicity_replay_failure_preserves_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Atomicity: a synthetic replay-failure injection leaves ss + the edit
    log unchanged.

    Drives the wrapper directly (no Pipe) because the failure injection
    needs to control the rebuild path. A delete builds the new System before
    it touches the session, so a rebuild that raises must leave the session
    holding the System and the log it had.
    """
    pytest.importorskip("andes")
    from tensa.core.errors import ElementValidationError
    from tensa.core.wrapper import Wrapper

    w = Wrapper()
    w.create_blank()
    # Build up 3 valid buses in the edit log.
    w.add_element("Bus", {"idx": "1", "name": "B1", "Vn": 100.0})
    w.add_element("Bus", {"idx": "2", "name": "B2", "Vn": 100.0})
    w.add_element("Bus", {"idx": "3", "name": "B3", "Vn": 100.0})

    pre_ss = w._ss
    pre_log = list(w._edit_log)

    def _boom(self: Wrapper, ops: object) -> None:
        raise ElementValidationError("synthetic replay failure")

    monkeypatch.setattr(Wrapper, "_build_system", _boom)

    with pytest.raises(ElementValidationError):
        w.delete_element("Bus", "2")

    # The session is as it was: ss and log are unchanged.
    assert w._ss is pre_ss
    assert w._edit_log == pre_log


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
            json={"primary_path": primary},
        )
        assert load.status_code == 200, load.text
        add = await _add_bus(client_ieee39, sid, "9999", name="PERFEXTRA")
        assert add.status_code == 201, add.text
        t0 = time.perf_counter()
        resp = await client_ieee39.delete(
            f"/api/sessions/{sid}/elements/Bus/9999",
        )
        elapsed = time.perf_counter() - t0
        assert resp.status_code == 200, resp.text
        assert elapsed < 1.0, (
            f"delete on {case_name} took {elapsed:.3f}s; budget is 1.0s"
        )


@pytest.mark.integration
async def test_every_reference_the_builder_takes_is_one_a_delete_follows() -> None:
    """A param the add form offers as a reference to a bus, a static generator
    or a machine is one ``edit_log.referrers`` follows, so no element the
    builder can add is left naming one that a delete removed."""
    pytest.importorskip("andes")
    import andes

    from tensa.core.edit_log import reference_params
    from tensa.core.wrapper import _PARAMS_BY_MODEL

    followed = reference_params(andes.System(no_output=True, default_config=True))
    expected = {"bus_idx": {"ACNode", "Bus"}, "gen_idx": {"StaticGen"}, "syn_idx": {"SynGen"}}
    undeclared: set[tuple[str, str]] = set()
    for model_name, metas in _PARAMS_BY_MODEL.items():
        for meta in metas:
            if meta.kind not in expected:
                continue
            if (model_name, meta.name) not in followed:
                undeclared.add((model_name, meta.name))
                continue
            assert followed[(model_name, meta.name)] in expected[meta.kind], (
                f"{model_name}.{meta.name} is a {meta.kind} in the schema but "
                f"a delete takes it to point into {followed[(model_name, meta.name)]!r}"
            )
    # ANDES's ZIP has no ``bus`` of its own: it names a static load (``pq``, which
    # a delete does follow) and copies that load's bus. Nothing else may be here.
    assert undeclared == {("ZIP", "bus")}
    assert followed[("ZIP", "pq")] == "StaticLoad"
