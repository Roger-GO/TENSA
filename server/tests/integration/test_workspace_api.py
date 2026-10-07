"""Integration tests for the workspace lister + layout sidecar endpoints."""

from __future__ import annotations

import json
import os
import sys
import types
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.api.routes import workspace as workspace_routes
from tensa.core.session import SessionManager
from tensa.security import names as security_names


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
    # The body was a version 1 document; it is stored and answered as version 2.
    assert parsed["schema_version"] == "2"
    assert parsed["coordinates"]["1"] == {"x": 0.0, "y": 0.0}


@pytest.mark.integration
async def test_put_layout_succeeds_where_os_has_no_fchmod(
    client_workspace: tuple[httpx.AsyncClient, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``os.fchmod`` does not exist on Windows before Python 3.13. The missing
    attribute raised AttributeError (not the OSError the code suppressed), so
    saving a layout answered 500 there."""
    monkeypatch.delattr(os, "fchmod", raising=False)
    client, ws = client_workspace
    put = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        json=_layout_body(),
    )
    assert put.status_code == 204, put.text
    sidecar = ws / "ieee14.raw.layout.json"
    assert json.loads(sidecar.read_text(encoding="utf-8"))["schema_version"] == "2"
    if sys.platform != "win32":
        # The post-close chmod still applies the mode without fchmod.
        assert sidecar.stat().st_mode & 0o777 == 0o600
    assert [p.name for p in ws.iterdir()] == ["ieee14.raw.layout.json"]  # no temp file left


@pytest.mark.integration
@pytest.mark.parametrize("case_path", ["CON", "nul.raw", "ieee14.raw:stream", "a?b.raw"])
async def test_put_layout_rejects_names_windows_would_misread(
    client_workspace: tuple[httpx.AsyncClient, Path],
    case_path: str,
) -> None:
    client, ws = client_workspace
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": case_path},
        headers={"Content-Type": "application/json"},
        json=_layout_body(),
    )
    assert resp.status_code == 400, resp.text
    assert list(ws.iterdir()) == []


@pytest.mark.integration
async def test_layout_below_a_regular_file_is_a_client_error(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """``case_path=ieee14.raw/x.raw`` names a path under a file. It answered
    500 (NotADirectoryError from the temp file) on Linux and Windows while
    macOS answered 400."""
    client, ws = client_workspace
    (ws / "ieee14.raw").write_text("dummy")
    put = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw/x.raw"},
        headers={"Content-Type": "application/json"},
        json=_layout_body(),
    )
    assert put.status_code == 400, put.text
    got = await client.get("/api/workspace/layout", params={"case_path": "ieee14.raw/x.raw"})
    assert got.status_code == 400, got.text
    assert [p.name for p in ws.iterdir()] == ["ieee14.raw"]


@pytest.mark.integration
@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot hold these as plain files")
def test_existing_case_file_exemption_follows_the_shared_platform_rule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sidecar exemption and snapshot restore ask the same question
    (``legacy_names_possible``), so on Windows both switch the exemption off."""
    (tmp_path / "case_12:30.raw").write_text("dummy")
    assert workspace_routes._is_existing_case_file(tmp_path, "case_12:30.raw")  # noqa: SLF001
    assert not workspace_routes._is_existing_case_file(tmp_path, "missing.raw")  # noqa: SLF001
    monkeypatch.setattr(security_names, "sys", types.SimpleNamespace(platform="win32"))
    assert not workspace_routes._is_existing_case_file(tmp_path, "case_12:30.raw")  # noqa: SLF001


@pytest.mark.integration
@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot hold these as plain files")
@pytest.mark.parametrize("name", ["case_12:30.raw", "what?.raw", "con.raw"])
async def test_put_layout_keeps_working_for_an_existing_case_with_an_unportable_name(
    client_workspace: tuple[httpx.AsyncClient, Path],
    name: str,
) -> None:
    """These names are legal on Linux and macOS, so such a case file still lists
    and loads; its layout sidecar must not start answering 400. The name check is
    for names the client picks, not for ones already in the workspace."""
    client, ws = client_workspace
    (ws / name).write_text("dummy")
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": name},
        headers={"Content-Type": "application/json"},
        json=_layout_body(),
    )
    assert resp.status_code == 204, resp.text
    assert (ws / f"{name}.layout.json").is_file()
    got = await client.get("/api/workspace/layout", params={"case_path": name})
    assert got.status_code == 200, got.text
    assert got.json()["schema_version"] == "2"


@pytest.mark.integration
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
async def test_put_layout_for_existing_unportable_case_still_refuses_symlinked_sidecar(
    client_workspace: tuple[httpx.AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """Skipping the name check for an existing case keeps every other write check."""
    client, ws = client_workspace
    (ws / "case:1.raw").write_text("dummy")
    (ws / "case:1.raw.layout.json").symlink_to(tmp_path / "planted.json")  # dangling
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "case:1.raw"},
        headers={"Content-Type": "application/json"},
        json=_layout_body(),
    )
    assert resp.status_code == 400, resp.text
    assert not (tmp_path / "planted.json").exists()


@pytest.mark.integration
async def test_put_layout_too_large_returns_413(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, _ws = client_workspace
    # Build a payload over the 2 MiB cap via a giant coordinates dict.
    big_coords = {
        str(i): {"x": float(i), "y": float(i + 1)} for i in range(80000)
    }
    body = _layout_body(coordinates=big_coords)
    serialized = json.dumps(body)
    assert len(serialized) > 2 * 1024 * 1024
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


@pytest.fixture
def unsearchable_ancestor(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> Iterator[str]:
    """A ``case_path`` whose parent sits under a directory the server cannot
    search, so ``Path.exists`` raises EACCES instead of answering False."""
    if sys.platform == "win32" or os.geteuid() == 0:
        pytest.skip("needs POSIX permission bits and a non-root user")
    _client, ws = client_workspace
    locked = ws / "locked"
    (locked / "inner").mkdir(parents=True)
    locked.chmod(0o000)
    try:
        yield "locked/inner/ieee14.raw"
    finally:
        locked.chmod(0o700)


@pytest.mark.integration
async def test_get_layout_unreadable_path_returns_400_not_500(
    client_workspace: tuple[httpx.AsyncClient, Path],
    unsearchable_ancestor: str,
) -> None:
    client, _ws = client_workspace
    resp = await client.get(
        "/api/workspace/layout",
        params={"case_path": unsearchable_ancestor},
    )
    assert resp.status_code == 400, resp.text


@pytest.mark.integration
async def test_put_layout_unreadable_path_returns_400_not_500(
    client_workspace: tuple[httpx.AsyncClient, Path],
    unsearchable_ancestor: str,
) -> None:
    client, _ws = client_workspace
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": unsearchable_ancestor},
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
    # The body gave each position without the bus its device hangs off, as a
    # version 1 client does; it reads back as not recorded.
    assert parsed["non_bus_coordinates"] == {
        "PV": {"1": {"x": 100.0, "y": 200.0, "bus": None}},
        "generator": {"1": {"x": 100.0, "y": 200.0, "bus": None}},
        "PQ": {"3": {"x": 50.0, "y": 60.0, "bus": None}},
        "load": {"3": {"x": 50.0, "y": 60.0, "bus": None}},
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


# ---- schema version 2 -------------------------------------------------------


def _layout_v2_body() -> dict[str, object]:
    """A version 2 document with something in every section."""
    return {
        "schema_version": "2",
        "andes_version": "2.0.0",
        "coordinates": {"1": {"x": 0.0, "y": 0.0}, "2": {"x": 100.0, "y": 50.0}},
        "non_bus_coordinates": {"generator": {"1": {"x": 0.0, "y": -70.0, "bus": "1"}}},
        "controller_coordinates": {"EXST1": {"1": {"x": 64.0, "y": -88.0}}},
        "units": {"1": {"expanded": True, "bus": "1"}},
        "busbars": {"2": {"length": 180.0, "orientation": "vertical"}},
        "branches": {
            "line": {
                "Line_1": {
                    "routing": "polyline",
                    "bend_points": [{"x": 30.0, "y": 6.0}, {"x": 130.0, "y": 50.0}],
                    "bus1": "1",
                    "bus2": "2",
                    "source_face": "south",
                    "target_face": None,
                }
            }
        },
        "label_offsets": {"bus": {"1": {"dx": 4.0, "dy": -12.0}}},
        "connections": {
            "generator": {
                "1": {
                    "device_face": "south",
                    "bus_face": "north",
                    "bend_points": [{"x": 25.0, "y": -24.0}, {"x": 25.0, "y": 3.0}],
                    "bus": "1",
                }
            }
        },
        "figure": {"monochrome": True, "line_width": 1.5, "font": "serif"},
        "last_modified": "2026-10-06T08:00:00+00:00",
    }


@pytest.mark.integration
async def test_a_version_2_layout_round_trips_with_every_section(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    body = _layout_v2_body()
    put = await client.put("/api/workspace/layout", params={"case_path": "kundur.xlsx"}, json=body)
    assert put.status_code == 204, put.text
    assert json.loads((ws / "kundur.xlsx.layout.json").read_text(encoding="utf-8")) == body
    got = await client.get("/api/workspace/layout", params={"case_path": "kundur.xlsx"})
    assert got.status_code == 200, got.text
    assert got.json() == body


@pytest.mark.integration
async def test_a_version_1_file_on_disk_is_answered_as_version_2(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """A layout saved by an earlier release: positions only, and (from a save
    after a drag) a controller badge filed among the buses."""
    client, ws = client_workspace
    v1 = _layout_body()
    v1["schema_version"] = "1"
    v1["coordinates"]["controller-EXST1-1"] = {"x": 136.0, "y": 12.0}  # type: ignore[index]
    (ws / "ieee14.raw.layout.json").write_text(json.dumps(v1), encoding="utf-8")
    got = await client.get("/api/workspace/layout", params={"case_path": "ieee14.raw"})
    assert got.status_code == 200, got.text
    parsed = got.json()
    assert parsed["schema_version"] == "2"
    assert parsed["coordinates"] == {"1": {"x": 0.0, "y": 0.0}, "2": {"x": 100.0, "y": 50.0}}
    for section in ("controller_coordinates", "units", "busbars", "branches"):
        assert parsed[section] == {}
    assert parsed["figure"] == {}


@pytest.mark.integration
@pytest.mark.parametrize(
    ("section", "value"),
    [
        ("busbars", {"1": {"orientation": "diagonal"}}),
        ("branches", {"line": {"1": {"bend_points": [{"x": 1.0}]}}}),
        ("figure", {"palette": ["black", "white"]}),
        ("units", {"1": {"expanded": True, "x": 3.0}}),
    ],
)
async def test_put_layout_refuses_a_section_the_schema_does_not_hold(
    client_workspace: tuple[httpx.AsyncClient, Path],
    section: str,
    value: object,
) -> None:
    client, ws = client_workspace
    body = _layout_v2_body()
    body[section] = value
    resp = await client.put("/api/workspace/layout", params={"case_path": "kundur.xlsx"}, json=body)
    assert resp.status_code == 422, resp.text
    assert not (ws / "kundur.xlsx.layout.json").exists()


@pytest.mark.integration
async def test_a_layout_with_the_bends_of_every_branch_fits_under_the_cap(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """The cap was 256 kB when a layout held positions only. A few thousand
    branches with their bend points are well past that and must still save."""
    client, _ws = client_workspace
    body = _layout_v2_body()
    body["branches"] = {
        "line": {
            f"Line_{i}": {
                "routing": "polyline",
                "bend_points": [{"x": float(i + k), "y": float(i - k)} for k in range(4)],
            }
            for i in range(3000)
        }
    }
    assert len(json.dumps(body)) > 256 * 1024
    resp = await client.put("/api/workspace/layout", params={"case_path": "big.raw"}, json=body)
    assert resp.status_code == 204, resp.text
