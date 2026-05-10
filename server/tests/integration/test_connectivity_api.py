"""Integration tests for the connectivity / island-detection endpoint
(Unit 17 of the v2.0 plan).

Drives the FastAPI app end-to-end against ANDES's bundled IEEE 14
case. Exercises:

- Happy path: stock IEEE 14 → ``island_count == 1`` (fully
  interconnected; ``Bus.island_sets`` carries one connected component).
- Edge: line trip via ``ToggleSpec`` → run TDS → ``island_count == 2``
  (Line_20 is the only edge to bus 8 on IEEE 14, so toggling it
  isolates bus 8 as a singleton island).
- 409 when no case has been loaded.

Per the plan's Unit 17 auto-fix: post-run only. There is no per-frame
streaming integration to test — the route is a synchronous call that
reads ``ss.connectivity()``'s side-effects on ``ss.Bus`` and returns
the snapshot.

Markers: ``integration`` — these tests load real case files, spawn the
worker subprocess, and (for the trip case) run a 1.5s TDS sim.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager

VALID_TOKEN = "f" * 64


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


async def _create_session_and_load(
    client: httpx.AsyncClient,
    primary: str = "ieee14.raw",
    addfile: str | None = None,
) -> str:
    sid = await _create_session(client)
    body: dict[str, object] = {"primary_path": primary}
    if addfile:
        body["addfiles"] = [addfile]
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json=body,
    )
    assert resp.status_code == 200, resp.text
    return sid


# ---- happy path: stock IEEE 14 → 1 island ---------------------------------


@pytest.mark.integration
async def test_connectivity_stock_ieee14_returns_one_island(
    client: httpx.AsyncClient,
) -> None:
    """Stock IEEE 14 with no disturbance applied → one big interconnected
    island. Per the plan: "no disturbance applied → island_count = 1".
    """
    sid = await _create_session_and_load(client, "ieee14.raw")
    # Run PFlow first to commit setup (the connectivity route auto-calls
    # setup, but PF first matches the realistic UI flow).
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text

    resp = await client.get(
        f"/api/sessions/{sid}/connectivity",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["island_count"] == 1
    assert len(body["islands"]) == 1
    assert len(body["islands"][0]) == 14, (
        f"expected all 14 buses in the single island; got {body['islands'][0]!r}"
    )
    # All bus idxes are stringified (case-file format may carry int or str;
    # the wire payload normalises to str).
    for idx in body["islands"][0]:
        assert isinstance(idx, str)
    assert body["islanded_bus_idxes"] == []


@pytest.mark.integration
async def test_connectivity_happy_path_works_without_explicit_pflow(
    client: httpx.AsyncClient,
) -> None:
    """The connectivity route auto-calls ``ss.setup()`` (matching the
    pflow / eig pattern), so it works on a freshly-loaded case even
    without a prior PF run.
    """
    sid = await _create_session_and_load(client, "ieee14.raw")
    resp = await client.get(
        f"/api/sessions/{sid}/connectivity",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["island_count"] == 1


# ---- edge case: line trip → 2 islands -------------------------------------


@pytest.mark.integration
async def test_connectivity_after_line_trip_returns_two_islands(
    client: httpx.AsyncClient,
) -> None:
    """Apply a Toggle on Line_20 (the only edge incident to bus 8 in
    IEEE 14), run TDS to fire the toggle at t=1.0s, then call
    /connectivity. Expected: ``island_count == 2`` with bus 8 as the
    isolated singleton.

    Per the plan: "case with line trip applied → island_count=2 after
    running TDS".
    """
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")

    # Add the trip toggle BEFORE setup (ANDES rejects post-setup adds).
    add_resp = await client.post(
        f"/api/sessions/{sid}/disturbances",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={
            "disturbances": [
                {"kind": "toggle", "model": "Line", "dev_idx": "Line_20", "t": 1.0}
            ]
        },
    )
    assert add_resp.status_code == 200, add_resp.text

    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text

    # Run TDS just past the toggle time so the trip actually fires.
    tds = await client.post(
        f"/api/sessions/{sid}/tds",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"tf": 1.5},
    )
    assert tds.status_code == 200, tds.text

    resp = await client.get(
        f"/api/sessions/{sid}/connectivity",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["island_count"] == 2, (
        f"expected 2 islands after Line_20 trip; body={body!r}"
    )
    assert len(body["islanded_bus_idxes"]) == 1
    assert body["islanded_bus_idxes"][0] == "8", (
        f"expected bus 8 to be the islanded one; got {body['islanded_bus_idxes']!r}"
    )
    # The unified ``islands`` list carries the singleton + the big island,
    # in that order (singletons-first per ``_post_process_islands``).
    sizes = sorted(len(island) for island in body["islands"])
    assert sizes == [1, 13], f"expected [1, 13] island sizes; got {sizes!r}"


# ---- 409 / 404 paths -------------------------------------------------------


@pytest.mark.integration
async def test_connectivity_no_case_loaded_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Calling /connectivity on a session with no case loaded surfaces
    the wrapper's ``NoCaseLoadedError`` as 409 (matching the rest of
    the topology / pflow / eig route family).
    """
    sid = await _create_session(client)
    resp = await client.get(
        f"/api/sessions/{sid}/connectivity",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text


@pytest.mark.integration
async def test_connectivity_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    """A session id the manager has never minted → 404 (matches the
    standard SessionExpiredError mapping)."""
    resp = await client.get(
        "/api/sessions/never-existed/connectivity",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_connectivity_missing_token_returns_401(
    client: httpx.AsyncClient,
) -> None:
    """No X-Andes-Token header → 401 (auth dependency runs before the
    route body)."""
    resp = await client.get("/api/sessions/anything/connectivity")
    assert resp.status_code == 401, resp.text
