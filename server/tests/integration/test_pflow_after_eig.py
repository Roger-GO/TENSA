"""Regression test for Phase 1 Playwright smoke Issue 1 — PF after EIG.

Background: ``ss.EIG.run()`` triggers ``TDS.init()`` + ``TDS.itm_step()``
via ``EIG._pre_check`` (Unit 1a spike), advancing ``dae.t`` to 0 and
extending the dae arrays for the full TDS state set.

Prior behavior (the bug): a follow-up ``POST /pflow`` would either
- complete with NaN-poisoned ``Bus.v.v`` and crash the JSON encoder, or
- raise inside one of the extraction helpers (``_extract_line_flows``,
  ``_extract_generator_outputs``, ``_extract_load_consumption``).

Either way the route surfaced 500 with no actionable detail. This test
asserts the wrapper now refuses cleanly with 422 + a "reload" hint.

Note on Option A vs B: ``ss.reset(force=True)`` is **not** a viable
recovery path. Empirically (kundur_full and IEEE 14 + dyr) it raises
``NotImplementedError: Does not know how to shrink arrays`` inside
``DAE.alloc_or_extend_names`` because the post-EIG dae includes TDS
state extensions that ANDES cannot collapse. Hence Option B (typed
422 directing the user at /reload).
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


async def _create_session_with_dyr(client: httpx.AsyncClient) -> str:
    resp = await client.post("/api/sessions", headers={"X-Andes-Token": VALID_TOKEN})
    sid = str(resp.json()["session_id"])
    await client.post(
        f"/api/sessions/{sid}/case",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    return sid


@pytest.mark.integration
async def test_pflow_after_eig_returns_422_with_actionable_detail(
    client: httpx.AsyncClient,
) -> None:
    """The smoke-test scenario verbatim: load case, run PF, run EIG,
    run PF again. The second PF must return 422 (not 500) with a
    detail string mentioning ``reload`` so ``RunButton.tsx`` can
    render a Reload-and-retry affordance."""
    sid = await _create_session_with_dyr(client)

    pf1 = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf1.status_code == 200, pf1.text
    assert pf1.json()["converged"] is True

    eig = await client.post(
        f"/api/sessions/{sid}/eig",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert eig.status_code == 200, eig.text
    assert eig.json()["tds_initialized"] is True

    pf2 = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf2.status_code == 422, pf2.text
    body = pf2.json()
    detail = body.get("detail") or ""
    # The detail must point at /reload so RunButton.tsx's
    # ``recoverViaReload = /reload/i.test(detail)`` heuristic fires.
    assert "reload" in detail.lower(), detail
    # And it should call out that EIG was the cause so the user
    # understands why PF failed.
    assert "EIG" in detail, detail


@pytest.mark.integration
async def test_pflow_after_eig_then_reload_recovers(
    client: httpx.AsyncClient,
) -> None:
    """After the user follows the actionable hint (POST /reload), the
    next PF must succeed cleanly. This proves the recovery loop the
    error message advertises actually works."""
    sid = await _create_session_with_dyr(client)

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

    # Follow the recovery hint. The /reload endpoint takes no body.
    reload_resp = await client.post(
        f"/api/sessions/{sid}/reload",
        headers={"X-Andes-Token": VALID_TOKEN},
    )
    assert reload_resp.status_code == 200, reload_resp.text

    pf_recover = await client.post(
        f"/api/sessions/{sid}/pflow",
        headers={"X-Andes-Token": VALID_TOKEN},
        json={},
    )
    assert pf_recover.status_code == 200, pf_recover.text
    assert pf_recover.json()["converged"] is True
