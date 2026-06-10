"""Integration tests for the alterable-params endpoint on the Unit 8
dynamic-model whitelist additions.

The acceptance suite (``tests/acceptance/test_topology_alterable_params.py``)
covers the static-model surface (Bus, PQ, GENROU). This file extends that
coverage to the seven dynamic models added in Unit 8 (IEEEX1, ESDC2A, IEEEG1,
TGOV1, IEEEST, SEXS, REGCA1) and exercises the wrapper's whitelist gate on
``add_element`` so unknown dynamic-model names produce a 422 with the
allowed-keys list rather than crashing the worker.

Each test loads a real ANDES case that contains the model in question:

- ``ieee14.raw + ieee14.dyr``: IEEEG1 (n=2), TGOV1 (n=3), IEEEST (n=1).
- ``ieee39_full.xlsx``: IEEEX1 (n=10).
- ``kundur_esdc2a.xlsx``: ESDC2A (n=4).
- ``kundur_sexs.xlsx``: SEXS (n=4).
- ``ieee14_reecb1.json``: REGCA1 (n=1).
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager


def _bundled_cases_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases"


async def _make_client(tmp_path: Path, files: list[Path]) -> httpx.AsyncClient:
    """Spin up the in-process ASGI app with ``files`` copied into a fresh
    workspace. Caller owns the ``aclose`` (we close the SessionManager via
    the wrapping fixture).
    """
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    for src in files:
        shutil.copy2(src, workspace / src.name)

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
    client = httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000")
    # Stash the manager so the calling fixture can shut it down.
    client._mgr = mgr  # type: ignore[attr-defined]
    return client


async def _create_session_and_load(
    client: httpx.AsyncClient,
    primary_path: str,
    addfiles: list[str] | None = None,
) -> str:
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary_path}
    if addfiles:
        body["addfiles"] = addfiles
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    assert resp.status_code == 200, resp.text
    return sid


# --- ieee14.raw + ieee14.dyr ----------------------------------------------


@pytest.fixture
async def ieee14_dyn_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "ieee14" / "ieee14.raw", cases / "ieee14" / "ieee14.dyr"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


@pytest.mark.integration
async def test_alterable_params_ieeeg1(ieee14_dyn_client: httpx.AsyncClient) -> None:
    """IEEEG1 (governor) on ieee14 dynamic exposes K (gain), T1-T7 (time
    constants), PMAX/PMIN, K1-K8 (boiler-pass shaft fractions). Topology
    refs (syn, syn2) and string identifiers (idx, name) are excluded by the
    NumParam-only filter."""
    sid = await _create_session_and_load(
        ieee14_dyn_client, "ieee14.raw", ["ieee14.dyr"]
    )
    resp = await ieee14_dyn_client.get(
        f"/api/sessions/{sid}/topology/models/IEEEG1/alterable_params",
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["model"] == "IEEEG1"
    params = body["params"]

    # Must include the canonical IEEEG1 NumParams (per ANDES ieeeg1.py:19-104).
    for required in ("K", "T1", "T2", "T3", "PMAX", "PMIN", "K1", "K8", "T7"):
        assert required in params, f"expected {required!r} in IEEEG1 params: {params}"

    # Topology refs / strings excluded.
    for excluded in ("idx", "name", "syn", "syn2"):
        assert excluded not in params, (
            f"IEEEG1 alterable_params should exclude {excluded!r}: {params}"
        )


@pytest.mark.integration
async def test_alterable_params_tgov1(ieee14_dyn_client: httpx.AsyncClient) -> None:
    """TGOV1 (single-lag governor) exposes R (droop), VMAX/VMIN (valve
    limits), T1-T3, Dt (turbine damping)."""
    sid = await _create_session_and_load(
        ieee14_dyn_client, "ieee14.raw", ["ieee14.dyr"]
    )
    resp = await ieee14_dyn_client.get(
        f"/api/sessions/{sid}/topology/models/TGOV1/alterable_params",
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in ("R", "VMAX", "VMIN", "T1", "T2", "T3", "Dt"):
        assert required in params, f"expected {required!r} in TGOV1 params: {params}"
    assert "syn" not in params


@pytest.mark.integration
async def test_alterable_params_ieeest(ieee14_dyn_client: httpx.AsyncClient) -> None:
    """IEEEST (PSS) exposes A1-A6 (filter), T1-T6 (lead-lag + washout), KS
    (gain), LSMAX/LSMIN (output limits), VCU/VCL (enabling voltages),
    MODE (input-signal selector). The avr / busr / busf IdxParam refs are
    excluded by the NumParam filter."""
    sid = await _create_session_and_load(
        ieee14_dyn_client, "ieee14.raw", ["ieee14.dyr"]
    )
    resp = await ieee14_dyn_client.get(
        f"/api/sessions/{sid}/topology/models/IEEEST/alterable_params",
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in (
        "A1", "A2", "A3", "A4", "A5", "A6",
        "T1", "T2", "T3", "T4", "T5", "T6",
        "KS", "LSMAX", "LSMIN", "VCU", "VCL", "MODE",
    ):
        assert required in params, f"expected {required!r} in IEEEST params: {params}"
    for excluded in ("avr", "busr", "busf"):
        assert excluded not in params, (
            f"IEEEST alterable_params should exclude IdxParam {excluded!r}: {params}"
        )


# --- ieee39_full.xlsx ------------------------------------------------------


@pytest.fixture
async def ieee39_full_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "ieee39" / "ieee39_full.xlsx"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


@pytest.mark.integration
async def test_alterable_params_ieeex1(ieee39_full_client: httpx.AsyncClient) -> None:
    """IEEEX1 (DC type-1 exciter) on IEEE 39 exposes the EXDC2 NumParam set:
    TR, TA, TC, TB, TE, TF1, KF1, KA, KE, VRMAX, VRMIN, E1/SE1, E2/SE2."""
    sid = await _create_session_and_load(ieee39_full_client, "ieee39_full.xlsx")
    resp = await ieee39_full_client.get(
        f"/api/sessions/{sid}/topology/models/IEEEX1/alterable_params",
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in (
        "TR", "TA", "TC", "TB", "TE", "TF1", "KF1",
        "KA", "KE", "VRMAX", "VRMIN",
        "E1", "SE1", "E2", "SE2",
    ):
        assert required in params, f"expected {required!r} in IEEEX1 params: {params}"
    assert "syn" not in params


# --- kundur_esdc2a.xlsx ----------------------------------------------------


@pytest.fixture
async def kundur_esdc2a_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "kundur" / "kundur_esdc2a.xlsx"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


@pytest.mark.integration
async def test_alterable_params_esdc2a(kundur_esdc2a_client: httpx.AsyncClient) -> None:
    """ESDC2A (PSS/E ESDC2A exciter) on kundur exposes TR, KA, TA, TB, TC,
    VRMAX, VRMIN, KE, TE, KF, TF1, Switch (mode flag), E1/SE1, E2/SE2."""
    sid = await _create_session_and_load(kundur_esdc2a_client, "kundur_esdc2a.xlsx")
    resp = await kundur_esdc2a_client.get(
        f"/api/sessions/{sid}/topology/models/ESDC2A/alterable_params",
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in (
        "TR", "KA", "TA", "TB", "TC", "VRMAX", "VRMIN",
        "KE", "TE", "KF", "TF1", "Switch",
        "E1", "SE1", "E2", "SE2",
    ):
        assert required in params, f"expected {required!r} in ESDC2A params: {params}"


# --- kundur_sexs.xlsx ------------------------------------------------------


@pytest.fixture
async def kundur_sexs_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "kundur" / "kundur_sexs.xlsx"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


@pytest.mark.integration
async def test_alterable_params_sexs(kundur_sexs_client: httpx.AsyncClient) -> None:
    """SEXS (Simplified Excitation System) exposes TATB (TA/TB ratio), TB,
    K (gain), TE, EMIN, EMAX (output limits)."""
    sid = await _create_session_and_load(kundur_sexs_client, "kundur_sexs.xlsx")
    resp = await kundur_sexs_client.get(
        f"/api/sessions/{sid}/topology/models/SEXS/alterable_params",
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in ("TATB", "TB", "K", "TE", "EMIN", "EMAX"):
        assert required in params, f"expected {required!r} in SEXS params: {params}"
    assert "syn" not in params


# --- ieee14_reecb1.json (REGCA1 carrier) -----------------------------------


@pytest.fixture
async def ieee14_reecb1_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "ieee14" / "ieee14_reecb1.json"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


@pytest.mark.integration
async def test_alterable_params_regca1(
    ieee14_reecb1_client: httpx.AsyncClient,
) -> None:
    """REGCA1 (grid-following converter, type-A renewable) exposes the
    converter time const Tg, the LVPL ramp + breakpoints (Rrpwr, Brkpt,
    Zerox), saturation switches (Lvplsw, Lvpl1), high/low voltage points
    (Volim, Lvpnt0/1), reactive-current rate limits (Iqrmax/min), and the
    per-unit ratio gammap/gammaq linking it to its StaticGen."""
    sid = await _create_session_and_load(ieee14_reecb1_client, "ieee14_reecb1.json")
    resp = await ieee14_reecb1_client.get(
        f"/api/sessions/{sid}/topology/models/REGCA1/alterable_params",
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["params"]
    for required in (
        "Sn", "Tg", "Rrpwr", "Brkpt", "Zerox", "Lvplsw", "Lvpl1",
        "Volim", "Lvpnt1", "Lvpnt0", "Iolim", "Tfltr", "Khv",
        "Iqrmax", "Iqrmin", "Accel", "gammap", "gammaq",
    ):
        assert required in params, f"expected {required!r} in REGCA1 params: {params}"
    # bus / gen IdxParams excluded.
    for excluded in ("bus", "gen"):
        assert excluded not in params, (
            f"REGCA1 alterable_params should exclude IdxParam {excluded!r}: {params}"
        )


# --- whitelist gate on add_element / edit_element --------------------------


@pytest.mark.integration
async def test_add_element_unknown_dynamic_model_returns_422_with_known_models(
    ieee14_dyn_client: httpx.AsyncClient,
) -> None:
    """Whitelist-before-getattr: a request to add a dynamic model the
    substrate hasn't whitelisted (e.g., REGCA2 — variant ANDES exposes but
    we haven't curated yet) must be rejected with 422 BEFORE reaching
    ``ss.add``. The 422 body's detail must enumerate the supported models
    so the UI can render an actionable error.

    Also asserts the Unit 8 additions (IEEEX1, ESDC2A, IEEEG1, TGOV1,
    IEEEST, SEXS, REGCA1) are present in that supported-models list."""
    sid = await _create_session_and_load(
        ieee14_dyn_client, "ieee14.raw", ["ieee14.dyr"]
    )
    resp = await ieee14_dyn_client.post(
        f"/api/sessions/{sid}/elements",
        json={"model": "REGCA2", "params": {"idx": "X1", "name": "X1"}},
    )
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    # The detail string is the wrapper's "unknown model … supported models:
    # [...]" message; assert the curated additions appear.
    for model_name in (
        "IEEEX1", "ESDC2A", "IEEEG1", "TGOV1", "IEEEST", "SEXS", "REGCA1",
    ):
        assert model_name in detail, (
            f"expected {model_name!r} in supported-models list; got: {detail}"
        )
