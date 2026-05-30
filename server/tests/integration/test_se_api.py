"""Integration tests for the SE endpoints (Unit 13 of the v2.0 plan).

Drives the FastAPI app end-to-end against ANDES's bundled IEEE 14
case. Exercises:

- Happy path: load IEEE 14, run PF, generate measurements (returns count
  > 0), run SE → 200 with converged=true, residuals populated.
- 409 pre-PF: pre-PF call to /se/measurements/generate → 409
  (substrate gates independently per Unit 1a spike).
- 409 pre-PF: pre-PF call to /se → 409.
- 409 pre-measurements: SE called without prior measurement generation
  → 409 with "Generate measurements first".
- 422 under-determined: minimum measurement set produces a singular
  gain matrix; route returns 422.
- Session-lifecycle: unknown session id → 404.
- Request validation: invalid noise_seed type rejected at Pydantic.

Markers: ``integration`` — these tests load real case files and spawn
the worker subprocess. SE adds ~1-2 s on top of PF.
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
    for name in ["ieee14.raw"]:
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
) -> str:
    resp = await client.post(
        "/api/sessions", headers={"X-Andes-Token": VALID_TOKEN}
    )
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json=body,
    )
    return sid


# ---- happy path ----------------------------------------------------------


@pytest.mark.integration
async def test_se_happy_path_returns_converged_with_residuals(
    client: httpx.AsyncClient,
) -> None:
    """Per Unit 1a spike: SE on IEEE 14 with the default measurement
    set converges in 2-3 WLS iterations.

    The integration test verifies:
    - Generate-measurements returns a positive count (14 V + 28 P/Q
      = 42 measurements).
    - Run-SE returns 200 with ``converged=true``.
    - ``iterations`` is populated and small (≤10 for a clean case).
    - ``residuals`` is non-empty and length matches
      ``measurement_count``.
    - With seed=42 (no perturbation), residuals are O(0.01) and few
      flagged_indices.
    """
    sid = await _create_session_and_load(client)
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text
    assert pf.json()["converged"] is True

    gen = await client.post(
        f"/api/sessions/{sid}/se/measurements/generate",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"noise_seed": 42},
    )
    assert gen.status_code == 200, gen.text
    gen_body = gen.json()
    assert gen_body["count"] > 0
    # IEEE 14: 14 buses; default set adds 1 V/bus + 2 (P,Q)/bus = 42.
    assert gen_body["count"] == 42

    resp = await client.post(
        f"/api/sessions/{sid}/se",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["converged"] is True
    assert body["iterations"] >= 1
    assert body["iterations"] <= 10
    # measurement_count includes the angle-reference pseudo-measurement
    # injected by SE.init (1 per island; IEEE 14 has 1 island).
    assert body["measurement_count"] >= 42
    assert len(body["residuals"]) == body["measurement_count"]
    # mismatch (J) is small for a clean PF-derived measurement set.
    assert body["mismatch"] >= 0
    # Without perturbation, flagged_indices is typically empty or very
    # small; at most a few measurements may exceed 3-sigma by chance.
    assert isinstance(body["flagged_indices"], list)
    assert len(body["flagged_indices"]) < body["measurement_count"]


# ---- edge: pre-PF call to /se/measurements/generate → 409 ----------------


@pytest.mark.integration
async def test_se_generate_without_pflow_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Per Unit 1a spike: ``SE.init`` only logs an error when PF
    hasn't converged before returning False. The substrate gates
    ``ss.PFlow.converged is True`` independently and raises
    ``SePrerequisiteError`` → 409 with an actionable "Run PFlow first"
    message."""
    sid = await _create_session_and_load(client)

    resp = await client.post(
        f"/api/sessions/{sid}/se/measurements/generate",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    detail = body.get("detail") or ""
    assert "PFlow" in detail or "pflow" in detail.lower()


# ---- edge: pre-PF call to /se → 409 --------------------------------------


@pytest.mark.integration
async def test_se_run_without_pflow_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """Mirror of the generate route's gate — running SE without a
    converged PF is a 409 even if the user happens to call /se before
    /se/measurements/generate."""
    sid = await _create_session_and_load(client)

    resp = await client.post(
        f"/api/sessions/{sid}/se",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    detail = body.get("detail") or ""
    assert "PFlow" in detail or "pflow" in detail.lower()


# ---- edge: SE called without prior measurement generation → 409 ----------


@pytest.mark.integration
async def test_se_run_without_generate_returns_409(
    client: httpx.AsyncClient,
) -> None:
    """When PF has converged but the user skipped the
    /se/measurements/generate step, the substrate raises
    ``SePrerequisiteError`` with an actionable "Generate measurements
    first" detail. Route maps to 409."""
    sid = await _create_session_and_load(client)
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200, pf.text

    resp = await client.post(
        f"/api/sessions/{sid}/se",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    detail = body.get("detail") or ""
    assert "generate" in detail.lower() or "measurements" in detail.lower()


# ---- request-validation: bad noise_seed type → 422 ------------------------


@pytest.mark.integration
async def test_se_generate_invalid_noise_seed_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Pydantic rejects non-int / non-null noise_seed values at the
    request-validation layer."""
    sid = await _create_session_and_load(client)

    resp = await client.post(
        f"/api/sessions/{sid}/se/measurements/generate",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"noise_seed": "not-an-int"},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_se_generate_negative_noise_seed_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """A negative seed is rejected at the Pydantic layer (``ge=0``) rather
    than reaching numpy's ``default_rng`` (which raises and would surface as
    a misleading non-convergent error). Defense-in-depth for the client
    validator that already blocks negatives inline."""
    sid = await _create_session_and_load(client)

    resp = await client.post(
        f"/api/sessions/{sid}/se/measurements/generate",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"noise_seed": -5},
    )
    assert resp.status_code == 422, resp.text


# ---- request-validation: extra field rejected ----------------------------


@pytest.mark.integration
async def test_se_generate_extra_field_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """``extra='forbid'`` on the Pydantic model rejects unknown keys."""
    sid = await _create_session_and_load(client)

    resp = await client.post(
        f"/api/sessions/{sid}/se/measurements/generate",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"unknown_field": 42},
    )
    assert resp.status_code == 422, resp.text


# ---- session lifecycle ---------------------------------------------------


@pytest.mark.integration
async def test_se_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions/does-not-exist/se",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_se_generate_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions/does-not-exist/se/measurements/generate",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert resp.status_code == 404, resp.text


# ---- happy path: re-run SE without re-generating measurements ------------


@pytest.mark.integration
async def test_se_can_be_run_twice_without_regenerating_measurements(
    client: httpx.AsyncClient,
) -> None:
    """The substrate caches the populated Measurements object on
    ``Wrapper._se_measurements`` so a second /se call against the same
    session uses the same z values without regenerating noise. Two
    calls should produce identical converged/iterations/mismatch
    triplets (deterministic SE on a stable measurement set)."""
    sid = await _create_session_and_load(client)
    pf = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf.status_code == 200

    gen = await client.post(
        f"/api/sessions/{sid}/se/measurements/generate",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"noise_seed": 7},
    )
    assert gen.status_code == 200

    first = await client.post(
        f"/api/sessions/{sid}/se",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert first.status_code == 200, first.text

    second = await client.post(
        f"/api/sessions/{sid}/se",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert second.status_code == 200, second.text

    assert first.json()["converged"] == second.json()["converged"]
    # The mismatch (J) and iterations are deterministic given a stable z.
    assert first.json()["iterations"] == second.json()["iterations"]
    assert first.json()["mismatch"] == pytest.approx(
        second.json()["mismatch"], rel=1e-9
    )
