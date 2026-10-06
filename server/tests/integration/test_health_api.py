"""``GET /api/health`` against real sessions and a real code cache directory.

The unit tests stand in for the registry and the cache. Here a session's worker is
spawned and closed, and the cache is a directory laid out as ANDES leaves it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core import codegen_cache
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    app = make_app(workspace=workspace, bind_port=8000, max_sessions=2, static_override=tmp_path)
    # httpx's ASGITransport does not run the lifespan, so build what it would.
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000"
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def test_health_follows_sessions_as_they_open_and_close(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/health")).json()["sessions"] == {"active": 0, "max": 2}

    first = (await client.post("/api/sessions")).json()["session_id"]
    second = (await client.post("/api/sessions")).json()["session_id"]
    assert (await client.get("/api/health")).json()["sessions"] == {"active": 2, "max": 2}

    assert (await client.delete(f"/api/sessions/{first}")).status_code == 204
    assert (await client.get("/api/health")).json()["sessions"] == {"active": 1, "max": 2}
    assert (await client.delete(f"/api/sessions/{second}")).status_code == 204
    assert (await client.get("/api/health")).json()["sessions"]["active"] == 0


async def test_health_reads_the_real_cache_stamp(
    client: httpx.AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cache directory ANDES filled and ``tensa warm-cache`` stamped is warm; one
    with only the first is not."""
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    directory = codegen_cache.pycode_dir()
    directory.mkdir(parents=True)

    cache = (await client.get("/api/health")).json()["cache"]
    assert (cache["state"], cache["warm"]) == ("missing", False)

    (directory / "__init__.py").write_text("# generated\n", encoding="utf-8")
    cache = (await client.get("/api/health")).json()["cache"]
    assert (cache["state"], cache["warm"]) == ("unchecked", False)

    version = (await client.get("/api/health")).json()["andes_version"]
    codegen_cache.mark_cache_checked(version, directory)
    cache = (await client.get("/api/health")).json()["cache"]
    assert (cache["state"], cache["warm"], cache["generating"]) == ("ready", True, False)

    # A child that is generating shows through the marker it keeps fresh.
    codegen_cache.running_marker(directory).write_text("token", encoding="utf-8")
    assert (await client.get("/api/health")).json()["cache"]["generating"] is True
