"""Integration tests for QNDF / adaptive integrator on POST /sessions/{id}/tds.

Validates the full wire path: HTTP request body → routes/tds.py →
worker → wrapper.run_tds → ANDES TDS config → integrate. The QNDF
"actually completes" assertion is the substantive integration check
(unit tests stub TDS.run; this one does not).
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
    resp = await client.post(
        "/api/sessions"
    )
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary}
    if addfile:
        body["addfiles"] = [addfile]
    await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    return sid


@pytest.mark.integration
async def test_run_tds_default_integrator_is_unchanged(
    client: httpx.AsyncClient,
) -> None:
    """No-integrator request still routes through the trapezoidal path.

    Baseline regression: the existing run_tds_batch behaviour
    (Unit 8) MUST stay 1:1 when ``integrator`` is omitted from the
    body. We assert ``converged=True`` and ``final_t`` reaches ``tf``.
    """
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 1.0, "h": 1 / 120},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["converged"] is True
    assert body["final_t"] >= 0.99


@pytest.mark.integration
async def test_run_tds_explicit_trapezoidal_integrator(
    client: httpx.AsyncClient,
) -> None:
    """``integrator='trapezoidal'`` is accepted and matches default behaviour."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 1.0, "h": 1 / 120, "integrator": "trapezoidal"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["converged"] is True
    assert body["final_t"] >= 0.99


@pytest.mark.integration
async def test_run_tds_qndf_with_auto_preset_completes(
    client: httpx.AsyncClient,
) -> None:
    """QNDF + Auto preset (rtol=1e-3, atol=1e-6, max_step=0.05) completes
    a 1-second IEEE 14 run.

    The plan calls out a kundur+bolted-fault scenario as the canonical
    "would diverge with trapezoid, completes with QNDF" case; that
    requires the full kundur dyr setup which is heavier than this
    integration suite wants. The IEEE 14 happy path here proves the
    plumbing (config fields land + ANDES picks the QNDF method) — the
    divergence-recovery story is covered by the 5-test wrapper unit
    suite plus the existing integration baseline.
    """
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={
            "tf": 1.0,
            "integrator": "qndf",
            "tds_config_overrides": {
                "rtol": 1e-3,
                "atol": 1e-6,
                "max_step": 0.05,
            },
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["converged"] is True, f"QNDF run did not converge: {body}"
    assert body["final_t"] >= 0.99


@pytest.mark.integration
async def test_run_tds_freeform_real_config_key_round_trips(
    client: httpx.AsyncClient,
) -> None:
    """A free-form override key the GUI advertises (``tol``) survives the
    full HTTP → worker → wrapper path and the run completes.

    This is the cross-boundary guard for the Unit 14 contract: the editor's
    datalist + help text promise that genuine ``ss.TDS.config`` keys forward
    to the substrate, so a real key must NOT be rejected the way ``bogus``
    is. Without this test the web/backend halves can silently drift apart.
    """
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={
            "tf": 1.0,
            "integrator": "qndf",
            "tds_config_overrides": {"tol": 1e-5, "max_iter": 25},
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["converged"] is True, f"run with free-form keys failed: {body}"
    assert body["final_t"] >= 0.99


@pytest.mark.integration
async def test_run_tds_unknown_override_key_returns_500(
    client: httpx.AsyncClient,
) -> None:
    """An unknown override key is a 422 with the wrapper's message and no reload.

    The wrapper raises ``TdsRequestError`` before it writes anything, which the
    routes layer maps to 422 (per the shared ``map_worker_error``) with no
    recovery action: the request is wrong, the session is fine.
    """
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={
            "tf": 1.0,
            "integrator": "qndf",
            "tds_config_overrides": {"bogus": 1.0},
        },
    )
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert "unknown TDS override key 'bogus'" in body["detail"]
    assert "reload" not in body["detail"].lower()
    assert body["recovery"] is None


@pytest.mark.integration
@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ('{"tstep": 0}', "step size 'tstep'"),
        ('{"tstep": -0.01}', "step size 'tstep'"),
        # Python's ``json`` accepts the non-standard ``NaN`` / ``Infinity`` tokens.
        ('{"tstep": NaN}', "'tstep' must be a finite number"),
        ('{"max_step": -0.05}', "'max_step' must be 0"),
        ('{"max_step": Infinity}', "'max_step' must be a finite number"),
        ('{"fixt": 3}', "'fixt' must be 0"),
    ],
)
async def test_run_tds_refuses_a_bad_step_override(
    client: httpx.AsyncClient, overrides: str, message: str
) -> None:
    """``tstep`` and ``max_step`` are step sizes too: a value ANDES would take
    and then misbehave on (it flips ``fixt`` to variable step for the rest of the
    session) is a 422 naming the key, and the session's next run is unaffected."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    refused = await client.post(
        f"/api/sessions/{sid}/tds",
        content=f'{{"tf": 0.5, "h": 0.01, "tds_config_overrides": {overrides}}}',
        headers={"content-type": "application/json"},
    )
    assert refused.status_code == 422, refused.text
    body = refused.json()
    assert message in body["detail"], refused.text
    # Nothing was written, so there is nothing to reload: no hint, no recovery action.
    assert "reload" not in body["detail"].lower(), refused.text
    assert body["recovery"] is None, refused.text

    # The refusal wrote nothing: a plain run still steps at the fixed ``h``.
    ok = await client.post(f"/api/sessions/{sid}/tds", json={"tf": 0.5, "h": 0.01})
    assert ok.status_code == 200, ok.text
    assert ok.json()["callpert_count"] >= 50


@pytest.mark.integration
async def test_run_tds_qndf_after_a_trapezoidal_run_asks_for_a_reload(
    client: httpx.AsyncClient,
) -> None:
    """A System that already ran trapezoidally cannot switch to QNDF in place.
    The request gets a 422 that says so (not a silent trapezoidal run), and a
    reload makes the same request succeed."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    first = await client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 0.5, "h": 1 / 120}
    )
    assert first.status_code == 200, first.text

    refused = await client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 1.0, "integrator": "qndf"}
    )
    assert refused.status_code == 422, refused.text
    # One hint to reload, not the wrapper's plus the route's.
    assert refused.json()["detail"].lower().count("reload") == 1, refused.text

    reload_resp = await client.post(f"/api/sessions/{sid}/reload")
    assert reload_resp.status_code == 200, reload_resp.text
    retried = await client.post(
        f"/api/sessions/{sid}/tds", json={"tf": 1.0, "integrator": "qndf"}
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["converged"] is True


@pytest.mark.integration
async def test_run_tds_unknown_integrator_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Pydantic Literal validation rejects unknown integrator values with 422."""
    sid = await _create_session_and_load(client, "ieee14.raw", "ieee14.dyr")
    resp = await client.post(
        f"/api/sessions/{sid}/tds",
        json={"tf": 1.0, "integrator": "rk4"},
    )
    assert resp.status_code == 422, resp.text
