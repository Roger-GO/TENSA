"""Integration tests for the Unit 8.1 ``controllers`` topology bucket.

Unit 8 added seven dynamic models (IEEEX1, ESDC2A, SEXS, IEEEG1, TGOV1,
IEEEST, REGCA1) to the substrate's whitelist, but the topology snapshot
schema had no bucket for them — so the disturbance editor's device picker
returned an empty list. Unit 8.1 adds a ``controllers`` field to
``TopologySummary`` populated from those seven model classes when the
loaded case carries instances.

Cases exercised:

- ``ieee14.raw + ieee14.dyr``: IEEEG1 (n=2), TGOV1 (n=3), IEEEST (n=1).
- ``kundur_full.xlsx``: IEEEG1 (n=4) + EXDC2 / SEXS depending on default
  setup. Used to exercise multiple controllers in one case.
- ``kundur_esdc2a.xlsx``: ESDC2A (n=4).
- ``ieee14_reecb1.json``: REGCA1 (n=1).
- Stock ``ieee14.raw`` alone: empty controllers bucket (no dynamics
  addfile).
"""

from __future__ import annotations

import shutil
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager


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
    client._mgr = mgr  # type: ignore[attr-defined]
    return client


async def _create_session_and_load(
    client: httpx.AsyncClient,
    primary_path: str,
    addfiles: list[str] | None = None,
) -> dict[str, object]:
    """Create a session, load the case, and return the load-case response
    body (already a TopologySummary). Asserts 200 on both calls.
    """
    resp = await client.post("/api/sessions")
    assert resp.status_code in (200, 201), resp.text
    sid = str(resp.json()["session_id"])
    body: dict[str, object] = {"primary_path": primary_path}
    if addfiles:
        body["addfiles"] = addfiles
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    payload["__sid"] = sid
    return payload


# --- ieee14.raw + ieee14.dyr (IEEEG1, TGOV1, IEEEST) ----------------------


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
async def test_controllers_bucket_populates_for_ieee14_dyn(
    ieee14_dyn_client: httpx.AsyncClient,
) -> None:
    """Loading IEEE 14 with the .dyr addfile must surface IEEEG1, TGOV1,
    and IEEEST instances in ``topology.controllers`` — keyed by the same
    ``model + idx + name`` shape as every other topology bucket.
    """
    payload = await _create_session_and_load(
        ieee14_dyn_client, "ieee14.raw", ["ieee14.dyr"]
    )
    controllers = payload["controllers"]
    assert isinstance(controllers, list)
    kinds = {c["kind"] for c in controllers}
    # IEEE 14 .dyr ships IEEEG1, TGOV1, IEEEST per the alterable-params
    # tests' n=2/3/1 expectations.
    assert "IEEEG1" in kinds, f"expected IEEEG1 in controllers; got {kinds}"
    assert "TGOV1" in kinds, f"expected TGOV1 in controllers; got {kinds}"
    assert "IEEEST" in kinds, f"expected IEEEST in controllers; got {kinds}"

    # Each entry must carry the canonical TopologyEntry shape.
    for entry in controllers:
        assert "idx" in entry
        assert "name" in entry
        assert "kind" in entry


# --- kundur_full.xlsx (IEEEG1 + others) -----------------------------------


@pytest.fixture
async def kundur_full_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "kundur" / "kundur_full.xlsx"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


@pytest.mark.integration
async def test_controllers_bucket_populates_for_kundur_full(
    kundur_full_client: httpx.AsyncClient,
) -> None:
    """``kundur_full.xlsx`` ships at least one Unit-8 dynamic controller
    (TGOV1 in the bundled ANDES 2.0.0 build). The assertion is
    intentionally narrow — we only require that *some* whitelisted
    controller appears, so the test stays robust if ANDES revs which
    governor or exciter is used in the canonical kundur full case.
    """
    payload = await _create_session_and_load(kundur_full_client, "kundur_full.xlsx")
    controllers = payload["controllers"]
    assert isinstance(controllers, list)
    assert len(controllers) > 0, "expected non-empty controllers bucket on kundur_full"
    whitelisted = {
        "IEEEX1",
        "ESDC2A",
        "SEXS",
        "IEEEG1",
        "TGOV1",
        "IEEEST",
        "REGCA1",
    }
    kinds = {c["kind"] for c in controllers}
    assert kinds & whitelisted, (
        f"expected at least one Unit-8 whitelisted controller in {kinds}"
    )


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
async def test_controllers_bucket_populates_for_kundur_esdc2a(
    kundur_esdc2a_client: httpx.AsyncClient,
) -> None:
    """``kundur_esdc2a.xlsx`` ships four ESDC2A exciter instances."""
    payload = await _create_session_and_load(
        kundur_esdc2a_client, "kundur_esdc2a.xlsx"
    )
    controllers = payload["controllers"]
    assert isinstance(controllers, list)
    esdc2a = [c for c in controllers if c["kind"] == "ESDC2A"]
    assert len(esdc2a) == 4, f"expected 4 ESDC2A entries; got {esdc2a}"


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
async def test_controllers_bucket_populates_for_ieee14_reecb1(
    ieee14_reecb1_client: httpx.AsyncClient,
) -> None:
    """``ieee14_reecb1.json`` includes a single REGCA1 renewable
    converter. The controllers bucket must surface it.
    """
    payload = await _create_session_and_load(
        ieee14_reecb1_client, "ieee14_reecb1.json"
    )
    controllers = payload["controllers"]
    assert isinstance(controllers, list)
    regca1 = [c for c in controllers if c["kind"] == "REGCA1"]
    assert len(regca1) >= 1, f"expected at least 1 REGCA1 entry; got {regca1}"


# --- Stock IEEE 14 .raw alone (no dynamics) -------------------------------


@pytest.fixture
async def ieee14_static_client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    cases = _bundled_cases_dir()
    files = [cases / "ieee14" / "ieee14.raw"]
    client = await _make_client(tmp_path, files)
    try:
        yield client
    finally:
        await client.aclose()
        await client._mgr.shutdown()  # type: ignore[attr-defined]


@pytest.mark.integration
async def test_controllers_bucket_empty_for_static_only_case(
    ieee14_static_client: httpx.AsyncClient,
) -> None:
    """Edge: a case loaded without any dynamics addfile has no dynamic
    controller instances. The ``controllers`` bucket must be present and
    empty (not absent), so the UI can render its "No X in topology"
    empty state without optional-chaining gymnastics.
    """
    payload = await _create_session_and_load(ieee14_static_client, "ieee14.raw")
    assert payload["controllers"] == []
