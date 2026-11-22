"""Integration tests for the Sienna warm-up, against a real Julia.

Runs only in the ``sienna`` CI job, where Julia and the Sienna project are set
up. A session created and left idle is warmed by its worker: the first reply
carries the progress message, and a power flow right after session creation
(which waits for the warm-up, the worker being single-threaded) succeeds.
"""

from __future__ import annotations

import asyncio
import shutil
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager
from tensa.engines.sienna.environment import sienna_unavailable_reason

pytestmark = [pytest.mark.integration, pytest.mark.sienna]

_REASON = sienna_unavailable_reason()
if _REASON is not None:
    pytest.skip(f"Sienna is not available: {_REASON}", allow_module_level=True)


def _kundur() -> Path:
    andes = pytest.importorskip("andes")
    return Path(andes.__file__).parent / "cases" / "kundur" / "kundur.raw"


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    shutil.copyfile(_kundur(), workspace / "kundur.raw")
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    try:
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1:8000", timeout=300.0
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _messages(client: httpx.AsyncClient, session: str) -> list[str]:
    resp = await client.get(f"/api/sessions/{session}/messages")
    assert resp.status_code == 200, resp.text
    return [m["text"] for m in resp.json()["messages"]]


async def test_first_reply_after_warmup_carries_the_message(
    client: httpx.AsyncClient,
) -> None:
    created = await client.post("/api/sessions", json={"engine": "sienna"})
    assert created.status_code == 201, created.text
    session = created.json()["session_id"]

    # A worker warms up only while no command waits for it, so the first op is
    # sent once the worker has had time to start and begin warming (it starts in
    # a few seconds); the op then waits for the warm-up to end.
    await asyncio.sleep(15)
    started = time.monotonic()
    loaded = await client.post(
        f"/api/sessions/{session}/case", json={"primary_path": "kundur.raw"}
    )
    assert loaded.status_code == 200, loaded.text

    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        texts = await _messages(client, session)
        if any("The Sienna engine was started and warmed up in" in t for t in texts):
            break
        await asyncio.sleep(1)
    else:
        raise AssertionError("no warm-up message in the session's messages")

    # A power flow after a warm session is fast (phase-4: later runs under 1 s).
    before = time.monotonic()
    pflow = await client.post(f"/api/sessions/{session}/pflow", json={})
    assert pflow.status_code == 200, pflow.text
    assert pflow.json()["converged"] is True
    assert time.monotonic() - before < 20
    assert time.monotonic() - started < 300

