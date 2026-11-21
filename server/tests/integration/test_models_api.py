"""Integration tests for ``GET /api/sessions/{id}/models`` and
``GET /api/sessions/{id}/models/{model}/doc``.

Same fixtures and client as ``tests/integration/test_ybus_api.py``: a real
FastAPI app over an ASGI transport, with real worker subprocesses. The last test
runs a server in a process of its own and holds that answering both routes does
not import ANDES there.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.examples import seed_example_cases
from tensa.core.session import SessionManager


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh FastAPI app instance."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    seed_example_cases(workspace)
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
            timeout=120.0,
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


async def _session(client: httpx.AsyncClient) -> str:
    created = await client.post("/api/sessions")
    assert created.status_code == 201, created.text
    return str(created.json()["session_id"])


@pytest.mark.integration
async def test_the_list_and_the_documentation_need_no_case(
    client: httpx.AsyncClient,
) -> None:
    sid = await _session(client)
    resp = await client.get(f"/api/sessions/{sid}/models")
    assert resp.status_code == 200, resp.text
    groups = resp.json()["groups"]
    names = [name for models in groups.values() for name in models]
    assert len(names) == len(set(names)) > 90
    assert "Bus" in groups["ACNode"]
    for name in ("Bus", "GENROU", "TGOV1"):
        assert name in names
        doc = await client.get(f"/api/sessions/{sid}/models/{name}/doc")
        assert doc.status_code == 200, doc.text
        assert doc.json()["model"] == name
        assert doc.json()["doc"].startswith(f"Model <{name}> in Group <")

    bus = (await client.get(f"/api/sessions/{sid}/models/Bus/doc")).json()["doc"]
    # A parameter of the model and both of its variables: real documentation.
    assert " Vn " in bus
    assert "voltage magnitude" in bus
    assert "voltage angle" in bus


@pytest.mark.integration
@pytest.mark.parametrize(
    "name", ["NoSuchModel", "PFlow", "dae", "config", "__class__", "bus", "ACNode"]
)
async def test_a_name_that_is_no_model_is_404_problem_details(
    client: httpx.AsyncClient, name: str
) -> None:
    sid = await _session(client)
    resp = await client.get(f"/api/sessions/{sid}/models/{name}/doc")
    assert resp.status_code == 404, resp.text
    body = resp.json()
    assert body["status"] == 404
    assert body["title"]
    assert body["detail"] == f"unknown ANDES model {name!r}"


@pytest.mark.integration
async def test_an_unknown_session_is_404(client: httpx.AsyncClient) -> None:
    for path in ("models", "models/Bus/doc"):
        resp = await client.get(f"/api/sessions/no-such-session/{path}")
        assert resp.status_code == 404, resp.text


@pytest.mark.integration
async def test_the_session_case_is_left_as_it_was(client: httpx.AsyncClient) -> None:
    sid = await _session(client)
    loaded = await client.post(
        f"/api/sessions/{sid}/case", json={"primary_path": "ieee14_full.xlsx"}
    )
    assert loaded.status_code == 200, loaded.text
    before = (await client.get(f"/api/sessions/{sid}/messages")).json()["last_seq"]

    assert (await client.get(f"/api/sessions/{sid}/models")).status_code == 200
    assert (await client.get(f"/api/sessions/{sid}/models/GENROU/doc")).status_code == 200

    # Nothing of the throwaway System reaches the session's messages...
    after = (await client.get(f"/api/sessions/{sid}/messages")).json()["last_seq"]
    assert after == before
    # ...and the case is still open to disturbances: it was not set up.
    fault = {"kind": "fault", "bus_idx": 9, "tf": 1.0, "tc": 1.1, "xf": 0.05, "rf": 0}
    added = await client.post(f"/api/sessions/{sid}/disturbances", json={"disturbances": [fault]})
    assert added.status_code == 200, added.text


@pytest.mark.integration
async def test_the_routes_are_tagged_for_the_dialog_that_reads_them(
    client: httpx.AsyncClient,
) -> None:
    """The web UI's Model documentation dialog reads both routes, so the parity
    ledger names it and neither route carries a deferral any more."""
    spec = (await client.get("/openapi.json")).json()
    for path in (
        "/api/sessions/{session_id}/models",
        "/api/sessions/{session_id}/models/{model}/doc",
    ):
        operation = spec["paths"][path]["get"]
        assert operation["x-tensa-gui-location"] == "model-doc-dialog"
        assert "x-tensa-parity-deferred" not in operation


_SERVER_PROCESS = textwrap.dedent(
    """
    import sys, tempfile, pathlib
    from fastapi.testclient import TestClient
    from tensa.api.app import make_app

    ws = pathlib.Path(tempfile.mkdtemp())
    app = make_app(workspace=ws, bind_host="127.0.0.1", bind_port=8000,
                   max_sessions=1, idle_timeout_seconds=120.0)
    with TestClient(app, base_url="http://127.0.0.1:8000") as c:
        sid = c.post("/api/sessions").json()["session_id"]
        listed = c.get(f"/api/sessions/{sid}/models")
        doc = c.get(f"/api/sessions/{sid}/models/Bus/doc")
        assert listed.status_code == 200, listed.text
        assert doc.status_code == 200, doc.text
        c.delete(f"/api/sessions/{sid}")
    print("andes" in sys.modules)
    """
)


@pytest.mark.integration
def test_the_server_process_does_not_import_andes() -> None:
    # ANDES belongs to the workers: the routes reach it through one, and the
    # process that serves them never imports it.
    done = subprocess.run(
        [sys.executable, "-c", _SERVER_PROCESS],
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip().splitlines()[-1] == "False", done.stdout
