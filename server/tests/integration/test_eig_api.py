"""Integration tests for the EIG endpoints (Unit 6 of the v2.0 plan).

Drives the FastAPI app end-to-end against ANDES's bundled IEEE 14
case (with and without the dyr addfile). Exercises:

- Happy path with the dyr addfile present (62 reduced eigenvalues
  expected per Unit 1a spike).
- Empty-modes path with the stock IEEE 14 (no dynamic states).
- 409 pre-condition: no PF run yet (substrate gates independently per
  Unit 1a spike, since ANDES's own ``EIG._pre_check`` only warns).
- Per-mode participation slice (200 happy + 404 mode-out-of-range +
  409 EIG-not-run).
- ``.mat`` state-matrix download (200 binary body + 409 EIG-not-run).
- EIG report variant via the existing reports endpoint (Unit 4
  endpoint widened by Unit 6).

Markers: ``integration`` — these tests load real case files and spawn
the worker subprocess. EIG runs add ~1 s on top of PF.
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager

VALID_TOKEN = "e" * 64


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


async def _create_session_and_load(
    client: httpx.AsyncClient,
    primary: str = "ieee14.raw",
    addfile: str | None = None,
) -> str:
    resp = await client.post("/api/sessions", headers={"X-Andes-Token": VALID_TOKEN})
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    if addfile:
        body["addfiles"] = [addfile]
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json=body,
    )
    return sid


# ---- happy path: full IEEE 14 + dyr → 62 eigenvalues -----------------------


@pytest.mark.integration
async def test_eig_happy_path_returns_eigenvalues_and_damping(
    client: httpx.AsyncClient,
) -> None:
    """Per Unit 1a spike: ``ieee14_full`` (with .dyr) → 62 reduced
    eigenvalues. We verify mode_count > 0, length-aligned damping +
    frequency arrays, and that the response carries
    ``tds_initialized=True`` (the documented EIG side-effect).
    """
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True

    resp = await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tds_initialized"] is True
    assert body["mode_count"] > 0
    assert body["mode_count"] == body["state_count"]
    assert len(body["eigenvalues"]) == body["mode_count"]
    assert len(body["damping_ratios"]) == body["mode_count"]
    assert len(body["frequencies_hz"]) == body["mode_count"]
    assert len(body["state_names"]) == body["mode_count"]
    # Each eigenvalue is a complex {real, imag} pair.
    for z in body["eigenvalues"]:
        assert "real" in z
        assert "imag" in z


# ---- edge: stock IEEE 14 (no .dyr) → empty modes ---------------------------


@pytest.mark.integration
async def test_eig_empty_modes_on_stock_ieee14_no_dyr(
    client: httpx.AsyncClient,
) -> None:
    """Per Unit 1a spike: stock IEEE 14 (no dynamic models) → ``dae.n=0``,
    ``EIG.mu`` length 0. The endpoint should return 200 with
    ``mode_count=0`` cleanly (UI shows the empty-state explanation)."""
    sid = await _create_session_and_load(client, "ieee14.raw")
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text

    resp = await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode_count"] == 0
    assert body["eigenvalues"] == []
    assert body["damping_ratios"] == []
    assert body["frequencies_hz"] == []
    # ``state_names`` may be empty here too; verify the field is present.
    assert body["state_names"] == []


# ---- edge: no PF run yet → 409 (substrate-side gate) -----------------------


@pytest.mark.integration
async def test_eig_without_pflow_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Per Unit 1a spike: ``EIG._pre_check`` only logs a warning when
    PF hasn't converged before falling through to a crash. The
    substrate gates ``ss.PFlow.converged is True`` independently and
    raises ``EigPrerequisiteError`` → 409 with an actionable message
    pointing at the PF run."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")

    resp = await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    detail = body.get("detail") or ""
    assert "PFlow" in detail


# ---- per-mode participation -----------------------------------------------


@pytest.mark.integration
async def test_eig_participation_returns_per_state_row(
    client: httpx.AsyncClient,
) -> None:
    """Plan happy path: after a successful EIG.run, GET
    ``/eig/modes/0/participation`` returns a length-aligned per-state
    participation row."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    eig_resp = await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert eig_resp.status_code == 200
    mode_count = eig_resp.json()["mode_count"]
    assert mode_count > 0

    resp = await client.get(
        f"/api/sessions/{sid}/eig/modes/0/participation",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode_idx"] == 0
    assert len(body["participation"]) == mode_count
    for row in body["participation"]:
        assert "state_name" in row
        assert "factor" in row
        assert isinstance(row["factor"], (int, float))


@pytest.mark.integration
async def test_eig_participation_out_of_range_mode_idx_returns_404(
    client: httpx.AsyncClient,
) -> None:
    """Edge case: ``mode_idx`` larger than the available mode count → 404."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    eig_resp = await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    mode_count = eig_resp.json()["mode_count"]
    out_of_range = mode_count + 1000

    resp = await client.get(
        f"/api/sessions/{sid}/eig/modes/{out_of_range}/participation",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_eig_participation_without_eig_run_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Edge case: EIG hasn't been run on this session → 409."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    resp = await client.get(
        f"/api/sessions/{sid}/eig/modes/0/participation",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text


# ---- state-matrix .mat download -------------------------------------------


@pytest.mark.integration
async def test_eig_state_matrix_returns_mat_blob(
    client: httpx.AsyncClient,
) -> None:
    """Happy path: after a successful EIG.run, GET
    ``/eig/state-matrix.mat`` returns a non-empty
    ``application/octet-stream`` body that scipy.io.loadmat can parse."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )

    resp = await client.get(
        f"/api/sessions/{sid}/eig/state-matrix.mat",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/octet-stream"
    body = resp.content
    assert len(body) > 0
    # Verify the body is a real .mat file (scipy.io.loadmat can parse it).
    from io import BytesIO

    from scipy.io import loadmat

    parsed = loadmat(BytesIO(body))
    assert "As" in parsed
    assert "mu" in parsed


@pytest.mark.integration
async def test_eig_state_matrix_without_eig_run_returns_409(
    client: httpx.AsyncClient,
) -> None:
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    resp = await client.get(
        f"/api/sessions/{sid}/eig/state-matrix.mat",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert resp.status_code == 409, resp.text


# ---- EIG report variant (Unit 4 endpoint widened by Unit 6) ---------------


@pytest.mark.integration
async def test_report_eig_after_run_returns_plain_text(
    client: httpx.AsyncClient,
) -> None:
    """Unit 6 widened the report endpoint to fully accept ``routine=eig``.
    After a successful EIG.run, GET ``/report?routine=eig`` returns a
    non-empty ``plain_text`` body (the verbatim ``EIG.report()``
    output)."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )

    resp = await client.get(
        f"/api/sessions/{sid}/report",
        headers={"X-Andes-Token": VALID_TOKEN},
        params={"routine": "eig"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["routine"] == "eig"
    assert isinstance(body["plain_text"], str)
    assert len(body["plain_text"]) > 0


# ---- session lifecycle ----------------------------------------------------


@pytest.mark.integration
async def test_eig_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions/does-not-exist/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 404, resp.text
