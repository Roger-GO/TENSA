"""Integration tests for ``GET /examples`` and ``POST /examples/{id}/add``.

The routes list the example catalog and copy a case into the workspace. The tests drive the real
app through httpx's ASGI transport against a temporary workspace. The ones that add a case from
the installed ANDES and load it into a session need ANDES; the others change what the routes find
(a different catalog, an ANDES that holds other files) to reach the errors.
"""

from __future__ import annotations

import hashlib
import json
import stat
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.api.schemas import AddedExample, ExampleList
from tensa.core import examples
from tensa.core.example_catalog import load_catalog, parse_catalog
from tensa.core.examples import SOURCES_FILE
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration


@pytest.fixture
async def client_workspace(
    tmp_path: Path,
) -> AsyncIterator[tuple[httpx.AsyncClient, Path]]:
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
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
            yield ac, workspace
    finally:
        await mgr.shutdown()


def _names(ws: Path) -> list[str]:
    return sorted(p.name for p in ws.iterdir())


def _needs_andes() -> None:
    if examples._andes_cases_dir() is None:  # noqa: SLF001
        pytest.skip("ANDES is not installed")


# ---- listing ----------------------------------------------------------------------------


async def test_the_list_is_the_catalog_with_what_is_true_of_this_workspace(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    resp = await client.get("/api/examples")
    assert resp.status_code == 200, resp.text
    listed = ExampleList.model_validate(resp.json()).examples
    assert [e.id for e in listed] == [e.id for e in load_catalog().examples]
    assert [e.default for e in listed] == [e.default for e in load_catalog().examples]
    assert not any(e.in_workspace for e in listed)
    _needs_andes()
    assert all(e.available for e in listed if e.has_file)
    # Everything the catalog says about a case travels with it.
    first = resp.json()["examples"][0]
    for key in ("title", "summary", "provenance", "citations", "licence", "caveats", "size"):
        assert key in first
    assert first["provenance"]["sha256"] and first["citations"][0]["bibtex"].startswith("@")

    (ws / "wscc9.xlsx").write_bytes(b"whatever is there counts as the case's file")
    flags = {e["id"]: e["in_workspace"] for e in (await client.get("/api/examples")).json()["examples"]}
    assert flags["wscc9"] is True
    assert flags["ieee14"] is False


async def test_what_the_mcp_listing_reads_of_each_entry_is_in_the_answer(
    client_workspace: tuple[httpx.AsyncClient, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``list_examples`` shortens each entry to the keys it names; they are all there."""
    pytest.importorskip("mcp.server.fastmcp")
    from tensa import mcp_server

    client, _ = client_workspace
    body = (await client.get("/api/examples")).json()
    monkeypatch.setattr(mcp_server, "_api", lambda method, path, payload=None: body)
    brief = mcp_server.list_examples()
    assert [e["id"] for e in brief] == [e["id"] for e in body["examples"]]
    assert {"title", "size", "analyses", "in_workspace", "source", "licence"} <= set(brief[0])
    assert mcp_server.list_examples("kundur")["id"] == "kundur"
    with pytest.raises(RuntimeError, match="the cases are"):
        mcp_server.list_examples("nope")


# ---- adding -----------------------------------------------------------------------------


async def test_an_added_case_is_in_the_workspace_and_loads_into_a_session(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    _needs_andes()
    client, ws = client_workspace
    resp = await client.post("/api/examples/wscc9/add")
    assert resp.status_code == 201, resp.text
    added = AddedExample.model_validate(resp.json())
    assert added.id == "wscc9"
    assert added.primary == "wscc9.xlsx"
    assert [(f.name, f.replaced) for f in added.files] == [("wscc9.xlsx", False)]
    assert added.sources_file == SOURCES_FILE
    assert _names(ws) == [SOURCES_FILE, "wscc9.xlsx"]
    assert added.files[0].size_bytes == (ws / "wscc9.xlsx").stat().st_size
    if sys.platform != "win32":
        assert stat.S_IMODE((ws / "wscc9.xlsx").stat().st_mode) == 0o600

    # The lister shows the case and not the file that records its source.
    listed = (await client.get("/api/workspace/files")).json()["files"]
    assert [f["name"] for f in listed] == ["wscc9.xlsx"]
    state = {e["id"]: e["in_workspace"] for e in (await client.get("/api/examples")).json()["examples"]}
    assert state["wscc9"] is True

    sid = (await client.post("/api/sessions")).json()["session_id"]
    loaded = await client.post(f"/api/sessions/{sid}/case", json={"primary_path": added.primary})
    assert loaded.status_code == 200, loaded.text
    assert len(loaded.json()["buses"]) == 9
    solved = await client.post(f"/api/sessions/{sid}/pflow", json={})
    assert solved.status_code == 200, solved.text
    assert solved.json()["converged"] is True


async def test_a_dynamic_example_added_from_andes_loads_with_its_machines(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    _needs_andes()
    client, ws = client_workspace
    resp = await client.post("/api/examples/kundur/add")
    assert resp.status_code == 201, resp.text
    sid = (await client.post("/api/sessions")).json()["session_id"]
    loaded = await client.post(f"/api/sessions/{sid}/case", json={"primary_path": "kundur_full.xlsx"})
    assert loaded.status_code == 200, loaded.text
    assert len(loaded.json()["buses"]) == 10
    # The dynamic models of the four machines came with the file, so a time-domain run is possible.
    assert "GENROU" in {g["kind"] for g in loaded.json()["generators"]}
    assert "(`kundur`)" in (ws / SOURCES_FILE).read_text(encoding="utf-8")


async def test_a_file_that_is_there_is_not_replaced_unless_overwrite_is_set(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    _needs_andes()
    client, ws = client_workspace
    (ws / "wscc9.xlsx").write_bytes(b"my own case")
    taken = await client.post("/api/examples/wscc9/add")
    assert taken.status_code == 409, taken.text
    assert "wscc9.xlsx" in taken.json()["detail"]
    assert "overwrite=true" in taken.json()["detail"]
    assert (ws / "wscc9.xlsx").read_bytes() == b"my own case"
    assert _names(ws) == ["wscc9.xlsx"]

    replaced = await client.post("/api/examples/wscc9/add", params={"overwrite": "true"})
    assert replaced.status_code == 201, replaced.text
    assert [f["replaced"] for f in replaced.json()["files"]] == [True]
    assert (ws / "wscc9.xlsx").read_bytes() != b"my own case"


async def test_a_directory_in_the_way_is_a_conflict_whatever_overwrite_says(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    _needs_andes()
    client, ws = client_workspace
    (ws / "wscc9.xlsx").mkdir()
    for overwrite in ("false", "true"):
        resp = await client.post("/api/examples/wscc9/add", params={"overwrite": overwrite})
        assert resp.status_code == 409, resp.text
        # Asking to replace a directory would not help, so the answer does not suggest it.
        assert "overwrite=true" not in resp.json()["detail"]
    assert (ws / "wscc9.xlsx").is_dir()


@pytest.mark.parametrize("example_id", ["nope", "x" * 3000, "wscc9.xlsx", "WSCC9", "wscc9%3Bls", "a%20b"])
async def test_an_id_the_catalog_does_not_have_is_a_404_and_writes_nothing(
    client_workspace: tuple[httpx.AsyncClient, Path], example_id: str
) -> None:
    client, ws = client_workspace
    resp = await client.post(f"/api/examples/{example_id}/add")
    assert resp.status_code == 404, resp.text
    assert len(resp.text) < 2000
    assert _names(ws) == []


async def test_an_id_that_climbs_out_of_the_route_reaches_no_file(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    resp = await client.post("/api/examples/..%2F..%2Fetc/add")
    assert resp.status_code in (404, 405), resp.text
    assert _names(ws) == []


async def test_a_case_the_installed_andes_does_not_hold_is_a_404(
    client_workspace: tuple[httpx.AsyncClient, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, ws = client_workspace
    empty = tmp_path / "andes_without_cases"
    empty.mkdir()
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: empty)
    resp = await client.post("/api/examples/wscc9/add")
    assert resp.status_code == 404, resp.text
    assert "wscc9/wscc9.xlsx" in resp.json()["detail"]
    listed = (await client.get("/api/examples")).json()["examples"]
    assert not any(e["available"] for e in listed)
    assert _names(ws) == []


async def test_an_andes_file_that_differs_from_the_recorded_one_is_added_with_a_warning(
    client_workspace: tuple[httpx.AsyncClient, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, ws = client_workspace
    cases = tmp_path / "andes_cases"
    (cases / "wscc9").mkdir(parents=True)
    (cases / "wscc9" / "wscc9.xlsx").write_bytes(b"another release")
    monkeypatch.setattr(examples, "_andes_cases_dir", lambda: cases)
    resp = await client.post("/api/examples/wscc9/add")
    assert resp.status_code == 201, resp.text
    (warning,) = resp.json()["warnings"]
    assert hashlib.sha256(b"another release").hexdigest() in warning
    assert (ws / "wscc9.xlsx").read_bytes() == b"another release"


async def test_a_link_only_entry_has_no_file_to_add(
    client_workspace: tuple[httpx.AsyncClient, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ws = client_workspace
    external = {
        "id": "texas",
        "title": "A dataset to download",
        "summary": "Held elsewhere.",
        "category": "dynamic",
        "provenance": {"kind": "external"},
        "licence": {"name": "As stated by the source"},
        "links": [{"title": "Source page", "url": "https://example.org/data"}],
    }
    catalog = parse_catalog(json.dumps({"version": 1, "examples": [external]}))
    monkeypatch.setattr(examples, "load_catalog", lambda: catalog)

    resp = await client.post("/api/examples/texas/add")
    assert resp.status_code == 400, resp.text
    assert "links" in resp.json()["detail"]
    assert _names(ws) == []
    (entry,) = (await client.get("/api/examples")).json()["examples"]
    assert entry["links"][0]["url"] == "https://example.org/data"
    assert (entry["in_workspace"], entry["available"]) == (False, False)


async def test_a_workspace_the_server_cannot_write_is_a_server_error_not_a_crash(
    client_workspace: tuple[httpx.AsyncClient, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    _needs_andes()
    client, ws = client_workspace

    def refuse(parent: Path, data: bytes, *, prefix: str) -> Path:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(examples, "write_private_temp", refuse)
    resp = await client.post("/api/examples/wscc9/add")
    assert resp.status_code == 500, resp.text
    assert "No space left" in resp.json()["detail"]
    assert _names(ws) == []


# ---- the schema --------------------------------------------------------------------------


async def test_the_routes_are_described_with_their_errors(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ = client_workspace
    spec: dict[str, Any] = (await client.get("/openapi.json")).json()
    listing = spec["paths"]["/api/examples"]["get"]
    add = spec["paths"]["/api/examples/{example_id}/add"]["post"]
    assert (listing["operationId"], add["operationId"]) == ("listExamples", "addExample")
    assert set(add["responses"]) >= {"201", "400", "404", "409", "500"}
    for code in ("400", "404", "409", "500"):
        assert add["responses"][code]["content"]["application/json"]["schema"]["$ref"].endswith(
            "/ProblemDetails"
        )
    assert {p["name"] for p in add["parameters"]} == {"example_id", "overwrite"}
