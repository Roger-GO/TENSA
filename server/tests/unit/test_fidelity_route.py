"""Unit tests for the fidelity route and the capabilities' models map.

A real app over an ASGI transport with a real ``SessionManager`` whose
``invoke`` is monkeypatched to answer a canned payload or raise the error the
worker would send; no worker is spawned. The session records the route reads
are seeded into the manager's registry.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio

from tensa.api.app import make_app
from tensa.core.session import SessionExpiredError, SessionManager, WorkerError
from tensa.engines.ops import engines_with_op


@pytest_asyncio.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    app = make_app(workspace=workspace, bind_host="127.0.0.1", bind_port=8000)
    manager = SessionManager(max_sessions=2, idle_timeout=180.0, workspace=str(workspace))
    await manager.start()
    app.state.session_manager = manager
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac
    finally:
        # The seeded records are stand-ins with no worker behind them; drop
        # them before the manager shuts down, which would close them as real
        # sessions.
        manager._sessions.clear()
        await manager.shutdown()


def _seed_session(client: httpx.AsyncClient, session_id: str, engine: str) -> None:
    """Put a session record of ``engine`` into the app's manager, with no
    worker behind it (the tests monkeypatch ``invoke`` before it is called).

    The route reads only ``.engine`` off the record once ``invoke`` has
    answered, so a stand-in with that attribute is enough; the manager's own
    record type is built only by the real spawn path. The fixture clears the
    seeded records before shutdown, which would close them as real sessions.
    """
    app = client._transport.app  # type: ignore[union-attr]
    manager: SessionManager = app.state.session_manager

    class _Record:
        def __init__(self, sid: str, engine_name: str) -> None:
            self.session_id = sid
            self.engine = engine_name

    manager._sessions[session_id] = _Record(session_id, engine)  # type: ignore[assignment]


def _stub_invoke(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    payload: Any = None,
    error: Exception | None = None,
) -> list[tuple[str, str, dict[str, Any]]]:
    """Monkeypatch the manager's ``invoke``; answer the calls it records."""
    app = client._transport.app  # type: ignore[union-attr]
    manager: SessionManager = app.state.session_manager
    calls: list[tuple[str, str, dict[str, Any]]] = []

    async def invoke(session_id: str, op: str, args: dict[str, Any]) -> Any:
        calls.append((session_id, op, args))
        if error is not None:
            raise error
        return payload

    monkeypatch.setattr(manager, "invoke", invoke)
    return calls


async def test_fidelity_route_returns_the_worker_payload(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = [
        {
            "key": "gen:1-1/governor",
            "model": "TGOV1",
            "state": "known-difference:tgov1-torque",
            "detail": "Sienna hands the machine a torque of P_m / omega.",
        }
    ]
    _seed_session(client, "s1", "andes")
    calls = _stub_invoke(client, monkeypatch, payload=payload)
    resp = await client.get("/api/sessions/s1/fidelity")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["session_id"] == "s1"
    assert body["engine"] == "andes"
    assert body["entries"][0]["key"] == "gen:1-1/governor"
    assert body["entries"][0]["handling"] is None
    assert calls == [("s1", "fidelity", {})]


async def test_fidelity_route_unknown_session_is_404(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_invoke(client, monkeypatch, error=SessionExpiredError("no session s9"))
    resp = await client.get("/api/sessions/s9/fidelity")
    assert resp.status_code == 404, resp.text


async def test_fidelity_route_no_case_is_409(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_session(client, "s1", "andes")
    _stub_invoke(
        client, monkeypatch, error=WorkerError("no-case-loaded", "no case has been loaded")
    )
    resp = await client.get("/api/sessions/s1/fidelity")
    assert resp.status_code == 409, resp.text
    assert "no case has been loaded" in resp.json()["detail"]


async def test_capabilities_carry_models(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The capability blocks carry the ``models`` map of spec section 7: every
    common model exact for ANDES, and TGOV1 the known difference for Sienna.
    Read from the data layer (``EngineCapabilities`` has no ``models`` field
    yet, so the HTTP answer drops it until the schema unit adds one)."""
    from tensa.engines import all_engine_capabilities
    from tensa.engines.sienna import environment

    monkeypatch.setattr(environment, "sienna_unavailable_reason", lambda: None)
    blocks = {block["name"]: block for block in all_engine_capabilities()}
    andes_models = blocks["andes"]["models"]
    assert len(andes_models) == 14
    assert set(andes_models.values()) == {"exact"}
    sienna_models = blocks["sienna"]["models"]
    assert len(sienna_models) == 14
    assert sienna_models["TGOV1"] == "known-difference:tgov1-torque"
    # GENROU agreed in its audit (model_audits.json).
    assert sienna_models["GENROU"] == "exact"
    # The route still answers 200 with both engines listed.
    resp = await client.get("/api/engines")
    assert resp.status_code == 200, resp.text
    assert [e["name"] for e in resp.json()["engines"]] == ["andes", "sienna"]


def test_ops_table_lists_fidelity_for_both_engines() -> None:
    assert engines_with_op("fidelity") == ["andes", "sienna"]
