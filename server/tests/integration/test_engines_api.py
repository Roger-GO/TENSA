"""Integration tests for ``GET /api/engines`` and the ``engine`` of a session.

Same fixtures and client as ``tests/integration/test_sessions_api.py``: a real
FastAPI app over an ASGI transport, with real worker subprocesses for the sessions
a test creates.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh FastAPI app instance."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,  # for Host check; the actual transport is in-process
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


@pytest.mark.integration
async def test_list_engines(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/engines")
    assert resp.status_code == 200, resp.text
    engines = resp.json()["engines"]
    assert [e["name"] for e in engines] == ["andes", "sienna"]
    andes, sienna = engines
    assert andes["available"] is True
    assert andes["unavailable_reason"] is None
    assert andes["versions"]["andes"]
    assert sienna["available"] is False
    assert sienna["unavailable_reason"]


@pytest.mark.integration
async def test_create_session_without_body_is_andes(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    assert resp.json()["engine"] == "andes"


@pytest.mark.integration
async def test_create_session_with_andes_body(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions", json={"engine": "andes"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["engine"] == "andes"


@pytest.mark.integration
async def test_create_session_with_sienna_is_409(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions", json={"engine": "sienna"})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["status"] == 409
    assert body["detail"] == (
        "the sienna engine is not available: "
        "the Sienna engine is not part of this build yet"
    )


@pytest.mark.integration
async def test_create_session_with_unknown_engine_is_422(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions", json={"engine": "nope"})
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_get_session_reports_engine(client: httpx.AsyncClient) -> None:
    created = await client.post("/api/sessions")
    sid = created.json()["session_id"]
    resp = await client.get(f"/api/sessions/{sid}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["engine"] == "andes"
    listed = (await client.get("/api/sessions")).json()["sessions"]
    assert {s["engine"] for s in listed} == {"andes"}
