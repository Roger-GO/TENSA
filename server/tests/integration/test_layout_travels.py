"""The diagram's layout goes where the case goes.

End to end against the real worker and ANDES's bundled IEEE 14 case: a layout
saved beside a case is still there after the case is saved under a new name,
after a snapshot is restored, and after a reproducibility bundle is exported
and imported somewhere else. Each test places things, saves by one path, and
reads the placement back. The last section holds the size cap to the same
rule: a layout the server takes, right up to the cap, goes by every one of
those paths, and one over it is taken by none.

Markers: ``integration`` (each test spawns a worker and loads a case).
"""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.layout import MAX_LAYOUT_BYTES
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration


def _bundled_ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    shutil.copy2(_bundled_ieee14_dir() / "ieee14.raw", ws / "ieee14.raw")
    return ws


async def _client_for(workspace: Path) -> tuple[httpx.AsyncClient, SessionManager]:
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(max_sessions=4, idle_timeout=180.0, workspace=str(workspace))
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000"
    )
    return client, mgr


@pytest.fixture
async def client(workspace: Path) -> AsyncIterator[httpx.AsyncClient]:
    ac, mgr = await _client_for(workspace)
    try:
        yield ac
    finally:
        await ac.aclose()
        await mgr.shutdown()


async def _open(client: httpx.AsyncClient, primary: str = "ieee14.raw") -> str:
    resp = await client.post("/api/sessions")
    assert resp.status_code == 201, resp.text
    sid = str(resp.json()["session_id"])
    resp = await client.post(f"/api/sessions/{sid}/case", json={"primary_path": primary})
    assert resp.status_code in (200, 201), resp.text
    return sid


def _placement(shift: float = 0.0) -> dict[str, Any]:
    """Every kind of thing a layout holds, placed by hand. ``shift`` moves the
    buses, so two placements of one case can be told apart."""
    return {
        "schema_version": "2",
        "andes_version": "2.0.0",
        "coordinates": {
            str(i): {"x": 100.0 * i + shift, "y": 50.0 * (i % 3)} for i in range(1, 15)
        },
        "non_bus_coordinates": {
            "PQ": {"PQ_1": {"x": 215.0, "y": 170.0, "bus": "2"}},
            "load": {"PQ_1": {"x": 215.0, "y": 170.0, "bus": "2"}},
            "generator": {"1": {"x": 90.0, "y": -40.0, "bus": None}},
        },
        "controller_coordinates": {"TGOV1": {"1": {"x": 160.0, "y": -60.0}}},
        "units": {"1": {"expanded": True, "bus": "1"}},
        "busbars": {"4": {"length": 220.0, "orientation": "vertical"}},
        "branches": {
            "line": {
                "Line_1": {
                    "routing": "polyline",
                    "bend_points": [
                        {"x": 130.0, "y": 56.0},
                        {"x": 130.0, "y": 80.0},
                        {"x": 230.0, "y": 80.0},
                    ],
                    "bus1": "1",
                    "bus2": "2",
                    "source_face": "south",
                    "target_face": None,
                }
            }
        },
        "label_offsets": {"bus": {"2": {"dx": 6.0, "dy": -14.0}}},
        "connections": {"load": {"PQ_1": {"device_face": "north", "bus_face": "south"}}},
        "figure": {"monochrome": True, "line_width": 1.5},
        "last_modified": "2026-10-06T08:00:00+00:00",
    }


async def _put_layout(client: httpx.AsyncClient, case: str, layout: dict[str, Any]) -> None:
    resp = await client.put("/api/workspace/layout", params={"case_path": case}, json=layout)
    assert resp.status_code == 204, resp.text


async def _get_layout(client: httpx.AsyncClient, case: str) -> dict[str, Any] | None:
    resp = await client.get("/api/workspace/layout", params={"case_path": case})
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] | None = resp.json()
    return body


# ---- Save system as ---------------------------------------------------------


@pytest.mark.parametrize(("filename", "fmt"), [("mine.xlsx", "xlsx"), ("mine.json", "json")])
async def test_a_case_saved_under_a_new_name_opens_with_the_same_placement(
    client: httpx.AsyncClient, filename: str, fmt: str
) -> None:
    sid = await _open(client)
    placed = _placement()
    await _put_layout(client, "ieee14.raw", placed)

    resp = await client.post(
        f"/api/sessions/{sid}/save", json={"filename": filename, "format": fmt}
    )
    assert resp.status_code == 201, resp.text

    # Reload: a new session opens the saved file, and its layout is the one placed.
    await _open(client, filename)
    assert await _get_layout(client, filename) == placed
    # The original keeps its own.
    assert await _get_layout(client, "ieee14.raw") == placed


async def test_a_case_saved_as_raw_keeps_only_the_placement_that_survives_renumbering(
    client: httpx.AsyncClient,
) -> None:
    """A ``.raw`` file holds no idx: the system read back from it has its
    devices and branches numbered afresh. A position keyed by an idx alone
    would land on whatever element has that idx then, so only what is keyed
    by bus, or says which buses it belongs to, is carried to the copy."""
    sid = await _open(client)
    placed = _placement()
    await _put_layout(client, "ieee14.raw", placed)

    resp = await client.post(
        f"/api/sessions/{sid}/save", json={"filename": "copy.raw", "format": "raw"}
    )
    assert resp.status_code == 201, resp.text

    carried = await _get_layout(client, "copy.raw")
    assert carried is not None
    assert carried["coordinates"] == placed["coordinates"]
    assert carried["busbars"] == placed["busbars"]
    assert carried["figure"] == placed["figure"]
    assert carried["label_offsets"] == placed["label_offsets"]  # a bus's label
    # The load says its bus and the route its two buses: both can be found again.
    assert carried["non_bus_coordinates"] == {
        "PQ": placed["non_bus_coordinates"]["PQ"],
        "load": placed["non_bus_coordinates"]["load"],
    }
    assert carried["branches"] == placed["branches"]
    # The generator's position names no bus, and these have nothing to go by.
    assert carried["controller_coordinates"] == {}
    assert carried["units"] == {}
    assert carried["connections"] == {}
    # The case the layout was made for keeps all of it.
    assert await _get_layout(client, "ieee14.raw") == placed


async def test_a_save_over_another_case_does_not_leave_it_that_case_layout(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    """``other.raw`` had a layout of its own. Saved over by a case that has
    none, it must not keep a layout made for the system it used to hold."""
    shutil.copy2(workspace / "ieee14.raw", workspace / "other.raw")
    await _put_layout(client, "other.raw", _placement(shift=5000.0))
    sid = await _open(client)

    resp = await client.post(
        f"/api/sessions/{sid}/save",
        json={"filename": "other.raw", "format": "raw", "overwrite": True},
    )
    assert resp.status_code == 201, resp.text
    assert await _get_layout(client, "other.raw") is None


async def test_a_save_over_the_open_case_keeps_its_layout(client: httpx.AsyncClient) -> None:
    sid = await _open(client)
    placed = _placement()
    await _put_layout(client, "ieee14.raw", placed)
    resp = await client.post(
        f"/api/sessions/{sid}/save",
        json={"filename": "ieee14.raw", "format": "raw", "overwrite": True},
    )
    assert resp.status_code == 201, resp.text
    assert await _get_layout(client, "ieee14.raw") == placed


# ---- snapshots --------------------------------------------------------------


async def test_a_snapshot_holds_the_layout_it_is_sent_and_a_restore_puts_it_back(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    sid = await _open(client)
    at_save = _placement()
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot", json={"name": "placed", "layout": at_save}
    )
    assert resp.status_code == 200, resp.text
    saved = resp.json()
    assert saved["metadata"]["has_layout"] is True
    assert "layout" not in saved["metadata"]  # the echo names it, it does not repeat it
    on_disk = json.loads(
        (workspace / "snapshots" / "ieee14" / "placed.json").read_text(encoding="utf-8")
    )
    assert on_disk["layout"] == at_save

    # Everything is moved afterwards.
    await _put_layout(client, "ieee14.raw", _placement(shift=900.0))

    resp = await client.post(f"/api/sessions/{sid}/snapshot/restore", json={"name": "placed"})
    assert resp.status_code == 200, resp.text
    restored = resp.json()
    assert restored["layout"] == at_save
    assert restored["metadata"]["has_layout"] is True
    # Reload: the layout beside the case is the snapshot's again.
    assert await _get_layout(client, "ieee14.raw") == at_save


async def test_a_snapshot_saved_without_a_layout_takes_the_one_beside_the_case(
    client: httpx.AsyncClient,
) -> None:
    """What a script gets: it sends no layout, and the one on disk is kept."""
    sid = await _open(client)
    on_disk = _placement()
    await _put_layout(client, "ieee14.raw", on_disk)
    resp = await client.post(f"/api/sessions/{sid}/snapshot", json={"name": "from-disk"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["metadata"]["has_layout"] is True

    await _put_layout(client, "ieee14.raw", _placement(shift=900.0))
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot/restore", json={"name": "from-disk"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["layout"] == on_disk
    assert await _get_layout(client, "ieee14.raw") == on_disk


async def test_a_snapshot_with_no_layout_restores_without_touching_the_one_on_disk(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    """A snapshot saved by an earlier release, or of a case nothing was placed in."""
    sid = await _open(client)
    resp = await client.post(f"/api/sessions/{sid}/snapshot", json={"name": "bare"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["metadata"]["has_layout"] is False
    stored = json.loads(
        (workspace / "snapshots" / "ieee14" / "bare.json").read_text(encoding="utf-8")
    )
    assert "layout" not in stored

    later = _placement(shift=900.0)
    await _put_layout(client, "ieee14.raw", later)
    resp = await client.post(f"/api/sessions/{sid}/snapshot/restore", json={"name": "bare"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["layout"] is None
    assert await _get_layout(client, "ieee14.raw") == later


async def test_a_snapshot_refuses_a_layout_that_is_not_one(client: httpx.AsyncClient) -> None:
    sid = await _open(client)
    bad = _placement()
    bad["busbars"] = {"4": {"orientation": "diagonal"}}
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot", json={"name": "bad", "layout": bad}
    )
    assert resp.status_code == 422, resp.text
    listing = await client.get(f"/api/sessions/{sid}/snapshots")
    assert listing.json()["snapshots"] == []


async def test_a_snapshot_whose_layout_no_longer_validates_still_restores(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    sid = await _open(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot", json={"name": "edited", "layout": _placement()}
    )
    assert resp.status_code == 200, resp.text
    path = workspace / "snapshots" / "ieee14" / "edited.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["layout"]["coordinates"]["1"] = {"x": "left"}  # edited by hand, badly
    path.write_text(json.dumps(stored), encoding="utf-8")

    resp = await client.post(f"/api/sessions/{sid}/snapshot/restore", json={"name": "edited"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["layout"] is None
    assert await _get_layout(client, "ieee14.raw") is None


async def test_the_layout_stays_out_of_the_job_record(client: httpx.AsyncClient) -> None:
    """A job's summary is what Retry repeats and what the Activity panel lists;
    thousands of coordinates do not belong in it."""
    sid = await _open(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot", json={"name": "placed", "layout": _placement()}
    )
    assert resp.status_code == 200, resp.text
    job = await client.get(f"/api/sessions/{sid}/jobs/{resp.json()['job_id']}")
    assert job.status_code == 200, job.text
    assert "layout" not in job.json()["request_summary"]
    assert job.json()["request_summary"]["name"] == "placed"


async def test_a_system_built_from_scratch_gets_its_layout_back_in_the_reply_only(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    """It has no case file, so there is nowhere to keep a layout beside: the
    snapshot holds it, the restore returns it, and no layout file appears."""
    resp = await client.post("/api/sessions")
    sid = str(resp.json()["session_id"])
    resp = await client.post(f"/api/sessions/{sid}/blank")
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        json={"model": "Bus", "params": {"idx": 1, "name": "B1", "Vn": 110.0}},
    )
    assert resp.status_code == 201, resp.text
    placed = _placement()
    placed["coordinates"] = {"1": {"x": 40.0, "y": 60.0}}

    resp = await client.post(
        f"/api/sessions/{sid}/snapshot", json={"name": "scratch", "layout": placed}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["metadata"]["has_layout"] is True
    resp = await client.post(f"/api/sessions/{sid}/snapshot/restore", json={"name": "scratch"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["layout"] == placed
    assert list(workspace.rglob("*.layout.json")) == []


# ---- reproducibility bundles ------------------------------------------------


async def _export(
    client: httpx.AsyncClient, sid: str, body: dict[str, Any] | None = None
) -> bytes:
    resp = await client.post(f"/api/sessions/{sid}/bundle/export", json=body or {})
    assert resp.status_code == 200, resp.text
    return resp.content


def _entry(zip_bytes: bytes, name: str) -> Any:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        return json.loads(zf.read(name))


async def test_a_bundle_carries_the_layout_to_another_workspace(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    sid = await _open(client)
    placed = _placement()
    bundle = await _export(client, sid, {"layout": placed})
    assert _entry(bundle, "layout.json") == placed
    assert "layout.json" in _entry(bundle, "manifest.json")["files"]

    # Somewhere else: an empty workspace, another server.
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir(mode=0o700)
    other, mgr = await _client_for(elsewhere)
    try:
        resp = await other.post("/api/sessions")
        sid_b = str(resp.json()["session_id"])
        resp = await other.post(
            f"/api/sessions/{sid_b}/bundle/import",
            files={"file": ("bundle.zip", bundle, "application/zip")},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "committed"
        assert body["layout_restored"] is True
        assert body["warnings"] == []
        assert await _get_layout(other, "ieee14.raw") == placed
    finally:
        await other.aclose()
        await mgr.shutdown()


async def test_a_bundle_exported_without_a_layout_takes_the_one_beside_the_case(
    client: httpx.AsyncClient,
) -> None:
    sid = await _open(client)
    on_disk = _placement()
    await _put_layout(client, "ieee14.raw", on_disk)
    bundle = await _export(client, sid)
    assert _entry(bundle, "layout.json") == on_disk


async def test_a_bundle_of_a_case_nothing_was_placed_in_has_no_layout(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    sid = await _open(client)
    bundle = await _export(client, sid)
    with zipfile.ZipFile(io.BytesIO(bundle)) as zf:
        assert "layout.json" not in zf.namelist()
    # Imported over the same workspace, it reports none and writes none.
    resp = await client.post("/api/sessions")
    sid_b = str(resp.json()["session_id"])
    resp = await client.post(
        f"/api/sessions/{sid_b}/bundle/import",
        files={"file": ("bundle.zip", bundle, "application/zip")},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["layout_restored"] is False
    assert not (workspace / "ieee14.raw.layout.json").exists()


async def test_a_bundle_of_an_edited_case_carries_the_layout_to_the_exported_file(
    client: httpx.AsyncClient, tmp_path: Path
) -> None:
    """An edited case is bundled as ``<stem>.xlsx``, not the file it was read
    from; the layout must land beside the file the import writes."""
    sid = await _open(client)
    resp = await client.post(
        f"/api/sessions/{sid}/elements",
        json={"model": "Bus", "params": {"idx": 99, "name": "NEW", "Vn": 69.0}},
    )
    assert resp.status_code == 201, resp.text
    placed = _placement()
    placed["coordinates"]["99"] = {"x": 1500.0, "y": 0.0}
    bundle = await _export(client, sid, {"layout": placed})
    assert _entry(bundle, "manifest.json")["case_filename"] == "ieee14.xlsx"

    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir(mode=0o700)
    other, mgr = await _client_for(elsewhere)
    try:
        resp = await other.post("/api/sessions")
        sid_b = str(resp.json()["session_id"])
        resp = await other.post(
            f"/api/sessions/{sid_b}/bundle/import",
            files={"file": ("bundle.zip", bundle, "application/zip")},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["layout_restored"] is True
        assert await _get_layout(other, "ieee14.xlsx") == placed
    finally:
        await other.aclose()
        await mgr.shutdown()


async def test_a_bundle_with_no_layout_that_replaces_a_case_leaves_it_no_layout(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    """The workspace has another system under the bundle's file name, with a
    layout of its own. Once the bundle's case has taken its place, that layout
    describes a file that is gone, and must not be drawn over the new one."""
    sid = await _open(client)
    bundle = await _export(client, sid)  # nothing placed yet: no layout.json
    (workspace / "ieee14.raw").write_bytes(b"--- another system ---")
    await _put_layout(client, "ieee14.raw", _placement(shift=5000.0))

    resp = await client.post("/api/sessions")
    sid_b = str(resp.json()["session_id"])
    resp = await client.post(
        f"/api/sessions/{sid_b}/bundle/import",
        files={"file": ("bundle.zip", bundle, "application/zip")},
        data={"force_resolve": "true", "use_bundle_case": "true"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "committed"
    assert body["layout_restored"] is False
    assert body["warnings"][-1] == (
        "the diagram layout beside workspace 'ieee14.raw' was removed: "
        "it was made for the file the bundle's copy replaced"
    )
    assert await _get_layout(client, "ieee14.raw") is None


async def test_bundle_export_refuses_a_layout_that_is_not_one(client: httpx.AsyncClient) -> None:
    sid = await _open(client)
    bad = _placement()
    bad["figure"] = {"palette": ["black", "white"]}
    resp = await client.post(f"/api/sessions/{sid}/bundle/export", json={"layout": bad})
    assert resp.status_code == 422, resp.text


# ---- the cap ----------------------------------------------------------------


def _compact(doc: dict[str, Any]) -> bytes:
    """``doc`` as a client sends it and as the server stores it: compact JSON."""
    return json.dumps(doc, separators=(",", ":")).encode("utf-8")


def _route(points: int = 4) -> dict[str, Any]:
    return {
        "routing": "polyline",
        "bend_points": [{"x": 1000.5 + k, "y": 2000.5 + k} for k in range(points)],
        "bus1": "1",
        "bus2": "2",
        "source_face": None,
        "target_face": None,
    }


def _placement_of_about(size: int) -> dict[str, Any]:
    """``_placement()`` with routed lines added until one more would take it
    past ``size`` bytes of compact JSON: the layout of a case of a few
    thousand buses."""
    doc = _placement()
    lines = doc["branches"]["line"]
    one = len(_compact({"L00000": _route()})) - 1  # the entry and its comma, less the braces
    for i in range((size - len(_compact(doc))) // one):
        lines[f"L{i:05d}"] = _route()
    assert size - one < len(_compact(doc)) <= size
    return doc


async def _import_elsewhere(bundle: bytes, elsewhere: Path) -> tuple[dict[str, Any], Any]:
    """Import ``bundle`` into the empty workspace ``elsewhere`` on another
    server; the import's answer and the layout then beside the case."""
    elsewhere.mkdir(mode=0o700)
    other, mgr = await _client_for(elsewhere)
    try:
        resp = await other.post("/api/sessions")
        sid = str(resp.json()["session_id"])
        resp = await other.post(
            f"/api/sessions/{sid}/bundle/import",
            files={"file": ("bundle.zip", bundle, "application/zip")},
        )
        assert resp.status_code == 200, resp.text
        return resp.json(), await _get_layout(other, "ieee14.raw")
    finally:
        await other.aclose()
        await mgr.shutdown()


async def test_a_layout_just_under_the_cap_goes_everywhere_the_case_goes(
    client: httpx.AsyncClient, workspace: Path, tmp_path: Path
) -> None:
    """The cap is on the layout as the server stores it, so one the server
    takes fits in the file beside the case, in a snapshot and in a bundle, and
    is read back from each of them."""
    sid = await _open(client)
    placed = _placement_of_about(MAX_LAYOUT_BYTES)
    await _put_layout(client, "ieee14.raw", placed)
    assert await _get_layout(client, "ieee14.raw") == placed
    # The file is the layout as it was measured: no larger than what was sent.
    assert (workspace / "ieee14.raw.layout.json").stat().st_size == len(_compact(placed))

    # Saved under a new name.
    resp = await client.post(
        f"/api/sessions/{sid}/save", json={"filename": "mine.xlsx", "format": "xlsx"}
    )
    assert resp.status_code == 201, resp.text
    assert await _get_layout(client, "mine.xlsx") == placed

    # A snapshot that is sent no layout takes the one beside the case.
    resp = await client.post(f"/api/sessions/{sid}/snapshot", json={"name": "big"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["metadata"]["has_layout"] is True
    await _put_layout(client, "ieee14.raw", _placement(shift=900.0))
    resp = await client.post(f"/api/sessions/{sid}/snapshot/restore", json={"name": "big"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["layout"] == placed
    assert await _get_layout(client, "ieee14.raw") == placed

    # A bundle, with the layout taken from beside the case and with it sent.
    for n, body in enumerate(({}, {"layout": placed})):
        bundle = await _export(client, sid, body)
        answer, imported = await _import_elsewhere(bundle, tmp_path / f"elsewhere-{n}")
        assert answer["layout_restored"] is True
        assert answer["warnings"] == []
        assert imported == placed


def _placement_over_the_cap() -> dict[str, Any]:
    return _placement_of_about(MAX_LAYOUT_BYTES + len(_compact({"L00000": _route()})))


async def test_a_layout_over_the_cap_is_refused_in_a_request_body_that_is_under_it(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    """A request body under the cap can still hold a layout over it: the
    server writes out every field a client left to its default. Taken, it
    would be a layout the server could write nowhere."""
    doc = _placement()
    doc["branches"]["line"] = {f"L{i:06d}": {} for i in range(120_000)}
    body = _compact(doc)
    assert len(body) < MAX_LAYOUT_BYTES
    resp = await client.put(
        "/api/workspace/layout",
        params={"case_path": "ieee14.raw"},
        headers={"Content-Type": "application/json"},
        content=body,
    )
    assert resp.status_code == 413, resp.text
    assert str(MAX_LAYOUT_BYTES) in resp.json()["detail"]
    assert [p.name for p in workspace.iterdir()] == ["ieee14.raw"]  # nothing written


async def test_a_snapshot_refuses_a_layout_over_the_cap(client: httpx.AsyncClient) -> None:
    """A snapshot that held one could not put it back: a restore writes the
    layout beside the case, where the cap applies."""
    sid = await _open(client)
    resp = await client.post(
        f"/api/sessions/{sid}/snapshot",
        json={"name": "too-big", "layout": _placement_over_the_cap()},
    )
    assert resp.status_code == 413, resp.text
    assert str(MAX_LAYOUT_BYTES) in resp.json()["detail"]
    listing = await client.get(f"/api/sessions/{sid}/snapshots")
    assert listing.json()["snapshots"] == []


async def test_a_snapshot_holding_a_layout_over_the_cap_restores_without_it(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    """A snapshot file edited by hand, or saved before a snapshot's layout was
    held to the cap: the operating point comes back, and the layout beside
    the case is left as it is."""
    sid = await _open(client)
    beside = _placement()
    await _put_layout(client, "ieee14.raw", beside)
    resp = await client.post(f"/api/sessions/{sid}/snapshot", json={"name": "bloated"})
    assert resp.status_code == 200, resp.text
    path = workspace / "snapshots" / "ieee14" / "bloated.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["layout"] = _placement_over_the_cap()
    path.write_text(json.dumps(stored), encoding="utf-8")

    resp = await client.post(f"/api/sessions/{sid}/snapshot/restore", json={"name": "bloated"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["layout"] is None
    assert await _get_layout(client, "ieee14.raw") == beside


async def test_bundle_export_refuses_a_layout_over_the_cap(client: httpx.AsyncClient) -> None:
    sid = await _open(client)
    resp = await client.post(
        f"/api/sessions/{sid}/bundle/export", json={"layout": _placement_over_the_cap()}
    )
    assert resp.status_code == 413, resp.text
    assert str(MAX_LAYOUT_BYTES) in resp.json()["detail"]
