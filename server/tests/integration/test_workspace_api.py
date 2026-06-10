"""Integration tests for the workspace lister + layout sidecar endpoints."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager


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


def _layout_body(coordinates: dict[str, dict[str, float]] | None = None) -> dict[str, object]:
    if coordinates is None:
        coordinates = {"1": {"x": 0.0, "y": 0.0}, "2": {"x": 100.0, "y": 50.0}}
    return {
        "schema_version": "1.0",
        "andes_version": "2.0.0",
        "coordinates": coordinates,
        "last_modified": "2026-05-07T12:00:00+00:00",
    }


# ---- list endpoint ----------------------------------------------------------


@pytest.mark.integration
async def test_list_files_happy_path(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    (ws / "ieee14.raw").write_text("dummy")
    (ws / "ieee14.dyr").write_text("dummy")
    (ws / "case.xlsx").write_text("dummy")
    resp = await client.get(
        "/api/workspace/files",
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    names = [f["name"] for f in body["files"]]
    # Alphabetical
    assert names == ["case.xlsx", "ieee14.dyr", "ieee14.raw"]
    # Format detection
    formats = {f["name"]: f["format"] for f in body["files"]}
    assert formats["ieee14.raw"] == "raw"
    assert formats["case.xlsx"] == "xlsx"
    assert formats["ieee14.dyr"] == "dyr"
    # Has size + modified_iso
    for f in body["files"]:
        assert f["size_bytes"] >= 0
        assert "T" in f["modified_iso"]


@pytest.mark.integration
async def test_list_files_excludes_hidden_and_unknown_extensions(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    (ws / ".secret.raw").write_text("hidden")
    (ws / "doc.txt").write_text("not-a-case")
    (ws / "valid.raw").write_text("ok")
    resp = await client.get(
        "/api/workspace/files",
    )
    assert resp.status_code == 200, resp.text
    names = [f["name"] for f in resp.json()["files"]]
    assert names == ["valid.raw"]


# ---- layout GET -------------------------------------------------------------


@pytest.mark.integration
async def test_get_layout_returns_200_null_when_absent(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """A missing sidecar is the normal first-run state — 200 with a JSON
    ``null`` body, NOT a 404 (which browsers log as a console error)."""
    client, _ws = client_workspace
    resp = await client.get(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() is None


@pytest.mark.integration
async def test_get_layout_rejects_traversal(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = client_workspace
    resp = await client.get(
        "/api/workspace/layout",
        params={"case_path": "../etc/passwd"},
    )
    assert resp.status_code == 400, resp.text


# ---- layout PUT -------------------------------------------------------------


@pytest.mark.integration
async def test_put_then_get_roundtrip(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    body = _layout_body()
    put = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        json=body,
    )
    assert put.status_code == 204, put.text
    # Sidecar exists at the right path
    sidecar = ws / "ieee14.raw.layout.json"
    assert sidecar.exists()
    # Mode 0600 (POSIX only)
    import sys
    if sys.platform != "win32":
        import stat

        assert stat.S_IMODE(sidecar.stat().st_mode) == 0o600

    get = await client.get(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
    )
    assert get.status_code == 200, get.text
    parsed = get.json()
    assert parsed["schema_version"] == "1.0"
    assert parsed["coordinates"]["1"] == {"x": 0.0, "y": 0.0}


@pytest.mark.integration
async def test_put_layout_too_large_returns_413(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = client_workspace
    # Build a 300 KB payload via a giant coordinates dict.
    big_coords = {
        str(i): {"x": float(i), "y": float(i + 1)} for i in range(20000)
    }
    body = _layout_body(coordinates=big_coords)
    serialized = json.dumps(body)
    assert len(serialized) > 256 * 1024
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        content=serialized,
    )
    assert resp.status_code == 413, resp.text


@pytest.mark.integration
async def test_put_layout_invalid_json_returns_422(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = client_workspace
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        content="{not valid json}",
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_put_layout_extra_fields_rejected(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = client_workspace
    body = _layout_body()
    body["evil_field"] = "smuggled"
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        json=body,
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_put_layout_nan_coordinate_rejected(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = client_workspace
    # JSON spec doesn't allow NaN, so use a string and let pydantic try to
    # coerce — should fail validation. Use Infinity-as-string also.
    # Use raw text including NaN literal that python's json.loads accepts but
    # the BusCoord finite-validator should reject. (We don't use _layout_body()
    # here because pydantic rejects NaN at the model boundary; we need the raw
    # JSON to reach the route.)
    raw = (
        '{"schema_version":"1.0","andes_version":"2.0.0",'
        '"coordinates":{"1":{"x":0.0,"y":1e400}},'
        '"last_modified":"2026-05-07T12:00:00+00:00"}'
    )
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_put_layout_rejects_traversal(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = client_workspace
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "../escape.raw"},
        headers={"Content-Type": "application/json"},
        json=_layout_body(),
    )
    assert resp.status_code == 400, resp.text


# ---- non_bus_coordinates (Unit 4, v0.1.y) ----------------------------------


@pytest.mark.integration
async def test_put_then_get_layout_with_non_bus_coordinates(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """Round-trip: PUT a sidecar with the dual-key non_bus_coordinates
    shape and GET it back. Both layers (model class + UI category)
    survive intact so kind-edits between sessions can fall back to the
    UI-category key."""
    client, _ws = client_workspace
    body = _layout_body()
    body["non_bus_coordinates"] = {
        "PV": {"1": {"x": 100.0, "y": 200.0}},
        "generator": {"1": {"x": 100.0, "y": 200.0}},
        "PQ": {"3": {"x": 50.0, "y": 60.0}},
        "load": {"3": {"x": 50.0, "y": 60.0}},
    }
    put = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        json=body,
    )
    assert put.status_code == 204, put.text
    get = await client.get(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
    )
    assert get.status_code == 200, get.text
    parsed = get.json()
    assert parsed["non_bus_coordinates"] == {
        "PV": {"1": {"x": 100.0, "y": 200.0}},
        "generator": {"1": {"x": 100.0, "y": 200.0}},
        "PQ": {"3": {"x": 50.0, "y": 60.0}},
        "load": {"3": {"x": 50.0, "y": 60.0}},
    }


@pytest.mark.integration
async def test_put_layout_without_non_bus_coordinates_reads_as_empty(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """Backward-compat: an old sidecar with only ``coordinates`` reads
    back with ``non_bus_coordinates`` defaulting to an empty dict."""
    client, _ws = client_workspace
    body = _layout_body()
    assert "non_bus_coordinates" not in body
    put = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        json=body,
    )
    assert put.status_code == 204, put.text
    get = await client.get(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
    )
    assert get.status_code == 200, get.text
    parsed = get.json()
    assert parsed["non_bus_coordinates"] == {}


@pytest.mark.integration
async def test_put_layout_non_bus_coordinates_nan_rejected(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """NaN/Inf in a non_bus_coordinates entry must be rejected by the
    same finite-coord validator that already covers ``coordinates``."""
    client, _ws = client_workspace
    raw = (
        '{"schema_version":"1.0","andes_version":"2.0.0",'
        '"coordinates":{},'
        '"non_bus_coordinates":{"PV":{"1":{"x":0.0,"y":1e400}}},'
        '"last_modified":"2026-05-07T12:00:00+00:00"}'
    )
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        content=raw,
    )
    assert resp.status_code == 422, resp.text
