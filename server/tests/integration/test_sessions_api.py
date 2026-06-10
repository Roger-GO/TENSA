"""Integration tests for the FastAPI sessions endpoints + middleware.

Drives the FastAPI app via ``httpx.AsyncClient`` over an ASGI transport (no
real network sockets). Spawns real worker subprocesses through the
``SessionManager`` lifespan hook, so each test that creates a session pays
the ANDES-import cost on session creation.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh FastAPI app instance.

    httpx's ``ASGITransport`` does not run FastAPI lifespan events — we
    manage SessionManager lifecycle explicitly here so tests don't depend on
    a separate ``asgi-lifespan`` install.
    """
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,  # for Host check; the actual transport is in-process
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    # Stand up the SessionManager + state ourselves (mimicking the lifespan).
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
async def test_create_session_returns_201(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["state"] == "live"
    # session_id is a hex uuid
    assert len(body["session_id"]) == 32
    int(body["session_id"], 16)


@pytest.mark.integration
async def test_create_session_rejects_client_supplied_session_id(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/sessions",
        headers={"Content-Type": "application/json"},
        json={"session_id": "attacker-controlled"},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_max_sessions_cap_returns_429(client: httpx.AsyncClient) -> None:
    # Cap is 2 (set in fixture)
    resp1 = await client.post("/api/sessions")
    resp2 = await client.post("/api/sessions")
    resp3 = await client.post("/api/sessions")
    assert resp1.status_code == 201
    assert resp2.status_code == 201
    assert resp3.status_code == 429
    assert "Retry-After" in resp3.headers
    # Closing one frees the slot
    sid_to_close = resp1.json()["session_id"]
    del_resp = await client.delete(
        f"/api/sessions/{sid_to_close}"
    )
    assert del_resp.status_code == 204
    resp4 = await client.post("/api/sessions")
    assert resp4.status_code == 201


@pytest.mark.integration
async def test_list_sessions_returns_active(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions")
    sid = resp.json()["session_id"]
    list_resp = await client.get("/api/sessions")
    assert list_resp.status_code == 200
    body = list_resp.json()
    ids = {s["session_id"] for s in body["sessions"]}
    assert sid in ids


@pytest.mark.integration
async def test_get_unknown_session_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.get(
        "/api/sessions/does-not-exist"
    )
    assert resp.status_code == 404


@pytest.mark.integration
async def test_delete_session_is_idempotent(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/sessions")
    sid = resp.json()["session_id"]
    first = await client.delete(
        f"/api/sessions/{sid}"
    )
    second = await client.delete(
        f"/api/sessions/{sid}"
    )
    assert first.status_code == 204
    assert second.status_code == 204


@pytest.mark.integration
async def test_bad_host_header_returns_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/sessions",
        headers={"Host": "evil.example.com"},
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.integration
async def test_bad_origin_header_returns_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/sessions",
        headers={
                "Origin": "http://evil.example.com",
        },
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.integration
async def test_openapi_spec_has_operation_ids_and_descriptions(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get("/openapi.json")
    assert resp.status_code == 200
    spec = resp.json()
    paths = spec["paths"]
    # Every defined operation should have an operationId and a summary
    for path, methods in paths.items():
        for method, op in methods.items():
            if method.startswith("x-") or method == "parameters":
                continue
            assert "operationId" in op, f"missing operationId on {method} {path}"
            assert "summary" in op, f"missing summary on {method} {path}"
            # Every Pydantic field on every request/response model should have a description
            # (R25 acceptance asserts this; here we just spot-check the spec is non-trivial).
    # Spot-check the components — ProblemDetails should be present
    assert "ProblemDetails" in spec.get("components", {}).get("schemas", {})
