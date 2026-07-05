"""Integration tests for the report endpoint (Unit 4 of the v2.0 plan).

Drives the FastAPI app end-to-end against ANDES's bundled IEEE 14
case. Exercises ``GET /api/sessions/{id}/report?routine=pflow|tds``
including the pre-condition gates (no PF run / no TDS run) and the
forward-compat 422 for ``routine=eig`` (which lands in Unit 6).

Markers: ``integration`` — these tests load real case files and
spawn the worker subprocess, so each takes ~1-3 s.
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


# ---- happy path: PFlow report --------------------------------------------


@pytest.mark.integration
async def test_report_pflow_returns_plain_text_and_structured_tables(
    client: httpx.AsyncClient,
) -> None:
    """Plan happy path: load IEEE 14, run PF, GET ``/report?routine=pflow``
    → 200 with non-empty plain_text and at least 2 structured tables
    (Bus voltages, Line flows)."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True

    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "pflow"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["routine"] == "pflow"
    assert isinstance(body["plain_text"], str)
    assert len(body["plain_text"]) > 0
    assert "BUS DATA" in body["plain_text"]
    tables = body["structured"]["tables"]
    assert len(tables) >= 2
    titles = [t["title"] for t in tables]
    assert "BUS DATA" in titles
    assert "LINE DATA" in titles


@pytest.mark.integration
async def test_report_pflow_bus_table_row_count_matches_case(
    client: httpx.AsyncClient,
) -> None:
    """Plan integration scenario: report content matches a manually-run
    ``andes run -p`` of the same case — checks the bus-voltage table row
    count + headers. IEEE 14 has, predictably, 14 buses."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "pflow"},
    )
    body = resp.json()
    by_title = {t["title"]: t for t in body["structured"]["tables"]}
    bus = by_title["BUS DATA"]
    # Three columns: name, magnitude, angle. Header text varies by
    # config (degree vs rad) — check the count instead of literal.
    assert len(bus["headers"]) == 3
    assert "Bus Name" in bus["headers"]
    # IEEE 14 has 14 buses → 14 rows.
    assert len(bus["rows"]) == 14


# ---- happy path: TDS report ----------------------------------------------


@pytest.mark.integration
async def test_report_tds_after_successful_run_returns_summary(
    client: httpx.AsyncClient,
) -> None:
    """Happy path: TDS summary report after a successful TDS run on
    IEEE 14 + dyr."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    # Short horizon to keep the test fast — 0.1 s is enough to populate
    # ``ss.dae.t > 0`` and trigger the TDS init path.
    tds = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 0.1},
    )
    assert tds.status_code == 200, tds.text
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "tds"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["routine"] == "tds"
    assert "Time Domain Simulation Summary" in body["plain_text"]
    # The wrapper augments the captured log with config + final-time
    # lines so the user has something paste-worthy.
    assert "Final simulation time" in body["plain_text"]
    titles = [t["title"] for t in body["structured"]["tables"]]
    assert "TDS Summary" in titles


# ---- edge cases: pre-condition failures ----------------------------------


@pytest.mark.integration
async def test_report_pflow_without_run_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Edge case from the plan: case loaded but no PF run yet → 409
    with the actionable "Run PFlow first" message."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "pflow"},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert "PFlow" in (body.get("detail") or "")


@pytest.mark.integration
async def test_report_tds_without_run_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Edge case from the plan: case loaded + PF run, but no TDS run →
    409. Mirrors the PFlow no-run path so the UI's empty state has a
    single error category to branch on."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "tds"},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert "TDS" in (body.get("detail") or "")


@pytest.mark.integration
async def test_report_no_case_loaded_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Edge case: session exists but no case has been loaded → 409."""
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "pflow"},
    )
    assert resp.status_code == 409, resp.text


# ---- edge cases: routine enum gate ---------------------------------------


@pytest.mark.integration
async def test_report_eig_without_run_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Unit 6 widened the report enum to include ``eig``. The 422 stub
    is gone; instead the route gates on ``EIG.run()`` having populated
    ``EIG.mu`` and 409s when it hasn't (mirrors the PFlow / TDS
    pre-condition pattern). The detail copy points at the recovery
    action ("run EIG first") so the UI's empty state can render it
    verbatim."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "eig"},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert "EIG" in (body.get("detail") or "")


@pytest.mark.integration
async def test_report_unknown_routine_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Edge case: a routine outside the schema enum → 422 from
    FastAPI's request-validation layer."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "snapshot"},
    )
    assert resp.status_code == 422, resp.text


# ---- edge cases: session lifecycle ---------------------------------------


@pytest.mark.integration
async def test_report_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get(
        "/api/sessions/does-not-exist/report",
        params={"routine": "pflow"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_report_pflow_does_not_pollute_workspace(
    client: httpx.AsyncClient,
    tmp_path: Path,
) -> None:
    """The wrapper points ``ss.files.txt`` at a tempfile inside a
    ``TemporaryDirectory`` and restores ``no_output`` post-call. As a
    smoke test, run the report and check that no ``*_out.txt`` showed
    up in the session's workspace — otherwise we'd be silently
    spamming files alongside the user's case."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        json={},
    )
    resp = await client.get(
        f"/api/sessions/{sid}/report",
        params={"routine": "pflow"},
    )
    assert resp.status_code == 200, resp.text
    # Workspace contains ONLY the original two case files we copied
    # in plus any session-private addfiles ANDES may have made — but
    # NOT a stray "*_out.txt" report file. The fixture's workspace is
    # tmp_path/"ws"; the route's tempfile lives elsewhere.
    workspace = tmp_path / "ws"
    out_files = list(workspace.glob("*_out.txt"))
    assert out_files == [], f"unexpected report files in workspace: {out_files}"
