"""Integration tests for the PMU placement endpoints (Unit 14).

Drives the FastAPI app end-to-end against ANDES's bundled IEEE 14
case. Exercises:

- Happy path: load IEEE 14, place 3 PMUs, list returns all 3, run TDS,
  export CSV → header carries 3 ``<idx>_am`` + 3 ``<idx>_vm`` columns,
  body has one row per integration step at full TDS rate.
- Edge: PMU on non-existent bus → 422.
- Edge: PMU placement post-setup → 409 with reload hint.
- Edge: delete PMU pre-setup → 204; delete non-existent PMU → 404.
- Edge: delete PMU post-setup → 409.
- Reload-and-replay parity: PMU survives a /reload (because add_pmu
  records into ``_replay_buffer`` exactly like ``add_element``).
- Validation: missing ``bus_idx`` → 422 (Pydantic).

Markers: ``integration`` — these tests load real case files and spawn
the worker subprocess. PMU placement adds ~0.1 s on top of PF; CSV
export is sub-second on IEEE 14.
"""

from __future__ import annotations

import shutil
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
    for name in ("ieee14.raw",):
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
    client: httpx.AsyncClient, primary: str = "ieee14.raw"
) -> str:
    resp = await client.post(
        "/api/sessions"
    )
    sid = str(resp.json()["session_id"])
    await client.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": primary},
    )
    return sid


# ---- happy path ----------------------------------------------------------


@pytest.mark.integration
async def test_pmu_happy_path_place_list_run_export_csv(
    client: httpx.AsyncClient,
) -> None:
    """Place 3 PMUs on IEEE 14, run TDS, export CSV → 3-bus voltage +
    angle samples per step, header order matches placement order.
    """
    sid = await _create_session_and_load(client)

    # Place three PMUs
    placed_idxes: list[str] = []
    for bus in ("1", "5", "9"):
        resp = await client.post(
            f"/api/sessions/{sid}/pmu",
            json={"bus_idx": bus},
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["kind"] == "PMU"
        assert body["params"]["bus"] in (int(bus), bus)
        # Default Ta/Tv are 0.05 s when omitted.
        assert body["params"]["Ta"] == 0.05
        assert body["params"]["Tv"] == 0.05
        placed_idxes.append(str(body["idx"]))

    assert placed_idxes == ["PMU_1", "PMU_2", "PMU_3"]

    # List
    list_resp = await client.get(
        f"/api/sessions/{sid}/pmu"
    )
    assert list_resp.status_code == 200, list_resp.text
    pmus = list_resp.json()["pmus"]
    assert [str(p["idx"]) for p in pmus] == placed_idxes

    # Run a short TDS so the substrate has data to export.
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert pf.status_code == 200, pf.text

    tds = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.5},
    )
    assert tds.status_code == 200, tds.text

    # Export CSV
    csv_resp = await client.get(
        f"/api/sessions/{sid}/pmu/run-abc123/export.csv",
    )
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert "andes-pmu-" in csv_resp.headers.get("content-disposition", "")

    body_text = csv_resp.text
    lines = body_text.strip().split("\n")
    # Header: t + 2 cols per PMU (am + vm) for 3 PMUs = 7 columns.
    header = lines[0].split(",")
    assert header[0] == "t"
    assert len(header) == 1 + 2 * 3
    # Header carries each PMU idx with _am and _vm suffixes in placement order.
    for i, pmu_idx in enumerate(placed_idxes):
        assert header[1 + 2 * i] == f"{pmu_idx}_am"
        assert header[2 + 2 * i] == f"{pmu_idx}_vm"

    # Body: at least 2 data rows (TDS must have produced multiple
    # integration steps for tf=0.5).
    assert len(lines) >= 3
    # First column of the first data row should be 0 (TDS starts at t=0).
    first_data = lines[1].split(",")
    assert float(first_data[0]) == pytest.approx(0.0)
    # vm column for PMU_1 (index 2 in the row) should be near 1.0 — bus 1
    # is the slack bus on IEEE 14 with v=1.06 typically.
    pmu1_vm_col = 2  # 0=t, 1=PMU_1_am, 2=PMU_1_vm
    assert 0.9 < float(first_data[pmu1_vm_col]) < 1.2


# ---- happy path: list returns empty when no PMUs placed -------------------


@pytest.mark.integration
async def test_pmu_list_empty_when_no_pmus_placed(
    client: httpx.AsyncClient,
) -> None:
    """Freshly-loaded IEEE 14 has zero PMUs. The list endpoint returns
    an empty array (NOT a 404 / 409)."""
    sid = await _create_session_and_load(client)
    resp = await client.get(
        f"/api/sessions/{sid}/pmu"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"pmus": []}


# ---- edge: PMU on non-existent bus → 422 ----------------------------------


@pytest.mark.integration
async def test_pmu_add_on_nonexistent_bus_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """ANDES would silently swallow an unknown bus reference at add()
    time and surface a confusing error later; the substrate gates ahead
    of the call so the user gets an actionable 422.
    """
    sid = await _create_session_and_load(client)
    resp = await client.post(
        f"/api/sessions/{sid}/pmu",
        json={"bus_idx": "999"},
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json().get("detail") or ""
    assert "Bus" in detail or "bus" in detail.lower()


# ---- edge: PMU placement post-setup → 409 with reload hint ----------------


@pytest.mark.integration
async def test_pmu_add_post_setup_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """ANDES rejects all post-setup ``ss.add()`` calls. The substrate
    surfaces this as 409 with a "reload to recover" hint.
    """
    sid = await _create_session_and_load(client)
    # Force setup to commit by running PF.
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert pf.status_code == 200, pf.text

    resp = await client.post(
        f"/api/sessions/{sid}/pmu",
        json={"bus_idx": "1"},
    )
    assert resp.status_code == 409, resp.text
    detail = resp.json().get("detail") or ""
    assert "reload" in detail.lower()


# ---- edge: delete PMU pre-setup → 204 -------------------------------------


@pytest.mark.integration
async def test_pmu_delete_pre_setup_returns_204(
    client: httpx.AsyncClient,
) -> None:
    """Pre-setup DELETE goes through the same reload-and-replay path
    as ``delete_element``."""
    sid = await _create_session_and_load(client)
    add = await client.post(
        f"/api/sessions/{sid}/pmu",
        json={"bus_idx": "1"},
    )
    assert add.status_code == 201, add.text
    pmu_idx = str(add.json()["idx"])

    delete = await client.delete(
        f"/api/sessions/{sid}/pmu/{pmu_idx}",
    )
    assert delete.status_code == 204, delete.text

    # List confirms the PMU is gone.
    list_resp = await client.get(
        f"/api/sessions/{sid}/pmu"
    )
    assert list_resp.json() == {"pmus": []}


@pytest.mark.integration
async def test_pmu_delete_unknown_idx_returns_404(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client)
    delete = await client.delete(
        f"/api/sessions/{sid}/pmu/PMU_999",
    )
    assert delete.status_code == 404, delete.text


# ---- edge: delete PMU post-setup → 409 ------------------------------------


@pytest.mark.integration
async def test_pmu_delete_post_setup_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Post-setup delete needs a /reload first because the underlying
    reload-and-replay path can't run while the System is committed."""
    sid = await _create_session_and_load(client)
    add = await client.post(
        f"/api/sessions/{sid}/pmu",
        json={"bus_idx": "1"},
    )
    pmu_idx = str(add.json()["idx"])

    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert pf.status_code == 200

    delete = await client.delete(
        f"/api/sessions/{sid}/pmu/{pmu_idx}",
    )
    assert delete.status_code == 409, delete.text
    detail = delete.json().get("detail") or ""
    assert "reload" in detail.lower()


# ---- reload-and-replay parity (Unit 6.5) ---------------------------------


@pytest.mark.integration
async def test_pmu_survives_blank_session_reload_and_replay(
    client: httpx.AsyncClient,
) -> None:
    """PMUs added pre-setup on a *blank* session are recorded into
    ``_replay_buffer``; a /reload re-creates the empty System and
    replays every recorded add, so the PMU reappears with the same idx.

    For *loaded* sessions, reload re-parses the case file and wipes the
    buffer — same contract as ``add_element`` and the disturbance log
    (the user must explicitly re-POST after reload). The blank-session
    path is the one Unit 6.5's "reload-and-replay carries them"
    invariant covers.
    """
    # Create blank session
    sess_resp = await client.post(
        "/api/sessions"
    )
    sid = str(sess_resp.json()["session_id"])
    blank_resp = await client.post(
        f"/api/sessions/{sid}/blank",
        json={},
    )
    assert blank_resp.status_code == 201, blank_resp.text

    # Add a Bus so the PMU has somewhere to attach.
    add_bus = await client.post(
        f"/api/sessions/{sid}/elements",
        json={
            "model": "Bus",
            "params": {"idx": "1", "name": "B1", "Vn": 110.0},
        },
    )
    assert add_bus.status_code == 201, add_bus.text

    add_pmu = await client.post(
        f"/api/sessions/{sid}/pmu",
        json={"bus_idx": "1", "Ta": 0.07, "Tv": 0.08},
    )
    assert add_pmu.status_code == 201, add_pmu.text
    pre_reload_idx = str(add_pmu.json()["idx"])

    reload = await client.post(
        f"/api/sessions/{sid}/reload",
        json={},
    )
    assert reload.status_code == 200, reload.text

    # Both Bus and PMU should still be there after the reload (the blank-
    # session reload-and-replay path re-applies every recorded add).
    list_resp = await client.get(
        f"/api/sessions/{sid}/pmu"
    )
    assert list_resp.status_code == 200
    pmus = list_resp.json()["pmus"]
    assert len(pmus) == 1
    assert str(pmus[0]["idx"]) == pre_reload_idx
    # Filter constants survived the round-trip.
    assert pmus[0]["params"]["Ta"] == 0.07
    assert pmus[0]["params"]["Tv"] == 0.08


# ---- request validation ---------------------------------------------------


@pytest.mark.integration
async def test_pmu_add_missing_bus_idx_rejected_at_pydantic(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client)
    resp = await client.post(
        f"/api/sessions/{sid}/pmu",
        json={},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_pmu_add_negative_filter_rejected(
    client: httpx.AsyncClient,
) -> None:
    """``Ta`` / ``Tv`` are gt=0.0 — a non-positive value is rejected at
    Pydantic before the worker is touched."""
    sid = await _create_session_and_load(client)
    resp = await client.post(
        f"/api/sessions/{sid}/pmu",
        json={"bus_idx": "1", "Ta": -1.0},
    )
    assert resp.status_code == 422, resp.text


# ---- session lifecycle ----------------------------------------------------


@pytest.mark.integration
async def test_pmu_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    """Unknown session id → 404 on every PMU route."""
    bogus = "00000000-0000-0000-0000-000000000000"
    resp = await client.get(
        f"/api/sessions/{bogus}/pmu",
    )
    assert resp.status_code == 404, resp.text


# ---- export CSV: empty body when no PMUs placed --------------------------


@pytest.mark.integration
async def test_pmu_export_csv_no_pmus_returns_header_only(
    client: httpx.AsyncClient,
) -> None:
    """A session with no PMUs but a converged TDS still serves a CSV —
    the body is just the ``t`` header plus one row per integration step
    (no PMU columns)."""
    sid = await _create_session_and_load(client)
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert pf.status_code == 200
    tds = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.2},
    )
    assert tds.status_code == 200
    csv_resp = await client.get(
        f"/api/sessions/{sid}/pmu/run-empty/export.csv",
    )
    assert csv_resp.status_code == 200
    lines = csv_resp.text.strip().split("\n")
    assert lines[0] == "t"
    # At least one data row from the TDS run.
    assert len(lines) >= 2


# ---- export CSV: 409 when no setup committed -----------------------------


@pytest.mark.integration
async def test_pmu_export_csv_pre_setup_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """No setup yet → 409 with an actionable hint that TDS hasn't run."""
    sid = await _create_session_and_load(client)
    csv_resp = await client.get(
        f"/api/sessions/{sid}/pmu/run-x/export.csv",
    )
    assert csv_resp.status_code == 409, csv_resp.text
    detail = csv_resp.json().get("detail") or ""
    assert "TDS" in detail or "setup" in detail.lower()
