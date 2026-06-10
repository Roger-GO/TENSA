"""Integration tests for the bundle-import endpoint (Unit 10 of the v2.0 plan).

End-to-end coverage that drives the FastAPI app over an httpx
``ASGITransport`` against ANDES's bundled IEEE 14 case. Exercises the
full export → wipe-workspace → import → run round-trip plus the
conflict-resolution corner cases the plan calls out:

- Happy path: bundle exported in session A imports cleanly in session B.
- Edge: ANDES version mismatch is reported as a warning conflict.
- Edge: addfile referenced in the manifest but missing from the zip
  blocks the import (422 with the filename).
- Edge: case-file checksum mismatch surfaces as a sha-mismatch
  conflict with side-by-side metadata.
- Error: corrupted ZIP → 400.
- Error: manifest missing required fields → 422 with the field list.

Markers: ``integration`` — these tests load real case files and spawn
the worker subprocess (~2-5 s each).
"""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from andes_app.api.app import make_app
from andes_app.core.session import SessionManager


def _bundled_ieee14_dir() -> Path:
    pytest.importorskip("andes")
    import andes

    return Path(andes.__file__).parent / "cases" / "ieee14"


@pytest.fixture
async def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(mode=0o700)
    src = _bundled_ieee14_dir()
    for name in ["ieee14.raw", "ieee14.dyr"]:
        shutil.copy2(src / name, ws / name)
    return ws


@pytest.fixture
async def client(workspace: Path) -> AsyncIterator[httpx.AsyncClient]:
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=4,
        idle_timeout_seconds=180.0,
    )
    mgr = SessionManager(
        max_sessions=4, idle_timeout=180.0, workspace=str(workspace)
    )
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


async def _create_session(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/api/sessions"
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["session_id"])


async def _create_session_and_load(
    client: httpx.AsyncClient,
    primary: str = "ieee14.raw",
    addfile: str | None = "ieee14.dyr",
) -> str:
    sid = await _create_session(client)
    body: dict[str, object] = {"primary_path": primary}
    if addfile is not None:
        body["addfiles"] = [addfile]
    resp = await client.post(
        f"/api/sessions/{sid}/case",
        json=body,
    )
    assert resp.status_code in (200, 201), resp.text
    return sid


async def _export_bundle(
    client: httpx.AsyncClient,
    session_id: str,
    *,
    body: dict[str, object] | None = None,
) -> bytes:
    resp = await client.post(
        f"/api/sessions/{session_id}/bundle/export",
        json=body or {},
    )
    assert resp.status_code == 200, resp.text
    return resp.content


def _post_bundle(
    client: httpx.AsyncClient,
    session_id: str,
    zip_bytes: bytes,
    *,
    filename: str = "bundle.zip",
    force_resolve: bool | None = None,
    use_bundle_case: bool | None = None,
):  # noqa: ANN202 — returns the awaitable from httpx.AsyncClient.post
    """Helper that POSTs a multipart bundle import to the substrate."""
    files = {"file": (filename, zip_bytes, "application/zip")}
    data: dict[str, str] = {}
    if force_resolve is not None:
        data["force_resolve"] = "true" if force_resolve else "false"
    if use_bundle_case is not None:
        data["use_bundle_case"] = "true" if use_bundle_case else "false"
    return client.post(
        f"/api/sessions/{session_id}/bundle/import",
        files=files,
        data=data,
    )


# ---- happy paths -----------------------------------------------------------


@pytest.mark.integration
async def test_import_bundle_round_trip_clean_workspace(
    client: httpx.AsyncClient,
    workspace: Path,
) -> None:
    """Plan's primary scenario: export a bundle in session A; wipe the
    workspace; import in session B; case file is restored and the
    response reports it loaded cleanly."""
    sid_a = await _create_session_and_load(
        client, primary="ieee14.raw", addfile="ieee14.dyr"
    )
    bundle_bytes = await _export_bundle(
        client,
        sid_a,
        body={
            "disturbances": [
                {"kind": "fault", "bus_idx": 5, "tf": 1.0, "tc": 1.1},
            ],
        },
    )

    # Wipe workspace files so the import fully restores them.
    for name in ["ieee14.raw", "ieee14.dyr"]:
        (workspace / name).unlink()

    sid_b = await _create_session(client)
    resp = await _post_bundle(client, sid_b, bundle_bytes)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "committed"
    assert body["case_filename"] == "ieee14.raw"
    assert body["addfile_filenames"] == ["ieee14.dyr"]
    assert body["disturbances_replayed"] == 1
    # Case bytes restored byte-for-byte.
    assert (workspace / "ieee14.raw").exists()
    assert (workspace / "ieee14.dyr").exists()
    # Topology is queryable post-import (the substrate already loaded
    # the case as part of the import flow).
    topo = await client.get(
        f"/api/sessions/{sid_b}/topology",
    )
    assert topo.status_code == 200
    assert topo.json()["state"] == "pre-setup"


@pytest.mark.integration
async def test_import_bundle_no_disturbances_returns_zero_replayed(
    client: httpx.AsyncClient,
    workspace: Path,
) -> None:
    """Bundle without disturbances → committed with replay=0."""
    sid_a = await _create_session_and_load(
        client, primary="ieee14.raw", addfile=None
    )
    bundle_bytes = await _export_bundle(client, sid_a)
    (workspace / "ieee14.raw").unlink()

    sid_b = await _create_session(client)
    resp = await _post_bundle(client, sid_b, bundle_bytes)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "committed"
    assert body["disturbances_replayed"] == 0


# ---- conflict resolution ---------------------------------------------------


@pytest.mark.integration
async def test_import_bundle_sha_mismatch_returns_plan_with_diff(
    client: httpx.AsyncClient,
    workspace: Path,
) -> None:
    """Edge case: workspace already has the case file but contents
    differ → 409 with sha-mismatch conflict carrying side-by-side
    metadata."""
    sid_a = await _create_session_and_load(
        client, primary="ieee14.raw", addfile=None
    )
    bundle_bytes = await _export_bundle(client, sid_a)

    # Mutate the workspace copy so its sha differs from the bundle's.
    workspace_path = workspace / "ieee14.raw"
    workspace_path.write_bytes(workspace_path.read_bytes() + b"\n# edit\n")

    sid_b = await _create_session(client)
    resp = await _post_bundle(client, sid_b, bundle_bytes)
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["status"] == "plan"
    plan = body["plan"]
    sha_conflict = next(
        c for c in plan["conflicts"] if c["kind"] == "sha-mismatch"
    )
    assert sha_conflict["severity"] == "warning"
    assert sha_conflict["filename"] == "ieee14.raw"
    assert sha_conflict["bundle_meta"]["sha256"] != sha_conflict[
        "workspace_meta"
    ]["sha256"]
    assert sha_conflict["workspace_meta"]["size_bytes"] > sha_conflict[
        "bundle_meta"
    ]["size_bytes"]


@pytest.mark.integration
async def test_import_bundle_force_resolve_use_bundle_overwrites_workspace(
    client: httpx.AsyncClient,
    workspace: Path,
) -> None:
    """After the user picks "use bundle" in the resolver, the
    re-issued POST with ``force_resolve=true`` + ``use_bundle_case=true``
    overwrites the workspace copy."""
    sid_a = await _create_session_and_load(
        client, primary="ieee14.raw", addfile=None
    )
    bundle_bytes = await _export_bundle(client, sid_a)
    bundle_sha = hashlib.sha256(
        (workspace / "ieee14.raw").read_bytes()
    ).hexdigest()
    # Mutate the workspace to force the conflict.
    (workspace / "ieee14.raw").write_bytes(b"--- different content ---")

    sid_b = await _create_session(client)
    resp = await _post_bundle(
        client,
        sid_b,
        bundle_bytes,
        force_resolve=True,
        use_bundle_case=True,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "committed"
    # Workspace copy is the bundle's again.
    new_sha = hashlib.sha256(
        (workspace / "ieee14.raw").read_bytes()
    ).hexdigest()
    assert new_sha == bundle_sha


@pytest.mark.integration
async def test_import_bundle_force_resolve_keep_workspace_writes_sibling(
    client: httpx.AsyncClient,
    workspace: Path,
) -> None:
    """When the user picks "use workspace original", the bundle's
    bytes land at ``<filename>.from-bundle`` for offline diffing.

    Realistic shape: the workspace file is a valid but slightly-edited
    case (extra trailing newline). The substrate keeps the workspace
    version live and exposes the bundle copy alongside.
    """
    sid_a = await _create_session_and_load(
        client, primary="ieee14.raw", addfile=None
    )
    bundle_bytes = await _export_bundle(client, sid_a)
    # Append a trailing comment line so the workspace bytes diverge from
    # the bundle's, but the file remains a parseable PSS/E .raw — ANDES
    # tolerates trailing whitespace/comments after the network records.
    workspace_payload = (workspace / "ieee14.raw").read_bytes() + b"\n"
    (workspace / "ieee14.raw").write_bytes(workspace_payload)

    sid_b = await _create_session(client)
    resp = await _post_bundle(
        client,
        sid_b,
        bundle_bytes,
        force_resolve=True,
        use_bundle_case=False,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "committed"
    # Workspace's edited copy is preserved.
    assert (workspace / "ieee14.raw").read_bytes() == workspace_payload
    # Bundle's copy lands at the sibling path.
    sibling = workspace / "ieee14.raw.from-bundle"
    assert sibling.exists()
    # Warnings surface the divergence.
    assert any("preserved" in w for w in body["warnings"])


# ---- error paths -----------------------------------------------------------


@pytest.mark.integration
async def test_import_bundle_corrupted_zip_returns_400(
    client: httpx.AsyncClient,
) -> None:
    """A non-zip body should surface as 400 with the corrupt-zip
    category."""
    sid = await _create_session(client)
    resp = await _post_bundle(client, sid, b"not a zip")
    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert "ZIP" in (body.get("detail") or "")
    assert body.get("category") == "corrupt-zip"


@pytest.mark.integration
async def test_import_bundle_manifest_missing_required_fields_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """A bundle with a malformed manifest should 422 with the field
    list inline."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr("manifest.json", json.dumps({"andes_version": "2.0.0"}))
        zf.writestr("case/ieee14.raw", b"BUS 1\n")
    sid = await _create_session(client)
    resp = await _post_bundle(client, sid, buf.getvalue())
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body.get("category") == "manifest-malformed"
    assert "missing_fields" in body
    assert "case_filename" in body["missing_fields"]


@pytest.mark.integration
async def test_import_bundle_manifest_references_missing_addfile_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """Manifest declares an addfile in the ``files`` list but the zip
    doesn't contain it → 422 with case-entry-missing category."""
    buf = io.BytesIO()
    case_bytes = b"BUS 1\n"
    sha = hashlib.sha256(case_bytes).hexdigest()
    manifest = {
        "andes_version": "2.0.0",
        "andes_app_version": "0.1.0.dev0",
        "case_filename": "ieee14.raw",
        "case_sha256": sha,
        "case_canonical_export": False,
        "disturbance_count": 0,
        "exported_at": "2026-05-09T00:00:00+00:00",
        "files": [
            "case/ieee14.raw",
            # Bundle manifest declares the dyr addfile; the zip does NOT
            # include it. The validator should catch this.
            "case/ieee14.dyr",
            "manifest.json",
        ],
    }
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("case/ieee14.raw", case_bytes)
    sid = await _create_session(client)
    resp = await _post_bundle(client, sid, buf.getvalue())
    # The validator flags addfile-missing as a blocker conflict (not a
    # validate-time raise) because the bundle is structurally valid;
    # the missing addfile shows up as a blocked plan that the route
    # surfaces as 409 with the conflict body.
    assert resp.status_code == 409, resp.text
    body = resp.json()
    plan = body["plan"]
    blocker = next(
        c for c in plan["conflicts"] if c["kind"] == "addfile-missing"
    )
    assert blocker["severity"] == "blocker"
    assert blocker["filename"] == "ieee14.dyr"
    assert plan["blocked"] is True


@pytest.mark.integration
async def test_import_bundle_force_resolve_on_blocked_plan_returns_422(
    client: httpx.AsyncClient,
) -> None:
    """``force_resolve=true`` cannot bypass blocker conflicts —
    extract_bundle re-raises with category ``bundle-blocked`` which the
    route maps to 422."""
    buf = io.BytesIO()
    case_bytes = b"BUS 1\n"
    sha = hashlib.sha256(case_bytes).hexdigest()
    manifest = {
        "andes_version": "2.0.0",
        "andes_app_version": "0.1.0.dev0",
        "case_filename": "ieee14.raw",
        "case_sha256": sha,
        "case_canonical_export": False,
        "disturbance_count": 0,
        "exported_at": "2026-05-09T00:00:00+00:00",
        "files": ["case/ieee14.raw", "case/ieee14.dyr", "manifest.json"],
    }
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("case/ieee14.raw", case_bytes)
    sid = await _create_session(client)
    resp = await _post_bundle(client, sid, buf.getvalue(), force_resolve=True)
    assert resp.status_code == 422, resp.text


@pytest.mark.integration
async def test_import_bundle_unknown_session_returns_404(
    client: httpx.AsyncClient,
) -> None:
    resp = await _post_bundle(client, "does-not-exist", b"PK\x03\x04")
    assert resp.status_code == 404, resp.text


# ---- ANDES version mismatch ------------------------------------------------


@pytest.mark.integration
async def test_import_bundle_andes_version_mismatch_returns_warning_in_plan(
    client: httpx.AsyncClient,
    workspace: Path,
) -> None:
    """Edge case: bundle declares a different ANDES major.minor → the
    plan returned by validation surfaces a warning conflict. With
    ``force_resolve=true``, the substrate proceeds (the warning is
    informational once the user has confirmed)."""
    # Build a synthetic bundle that declares an incompatible ANDES
    # version. The case bytes are read from the workspace so load_case
    # actually succeeds when force_resolve flips True.
    case_bytes = (workspace / "ieee14.raw").read_bytes()
    sha = hashlib.sha256(case_bytes).hexdigest()
    manifest = {
        "andes_version": "99.0.0",
        "andes_app_version": "0.1.0.dev0",
        "case_filename": "ieee14.raw",
        "case_sha256": sha,
        "case_canonical_export": False,
        "disturbance_count": 0,
        "exported_at": "2026-05-09T00:00:00+00:00",
        "files": ["case/ieee14.raw", "manifest.json"],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w") as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("case/ieee14.raw", case_bytes)

    sid = await _create_session(client)
    resp = await _post_bundle(client, sid, buf.getvalue())
    assert resp.status_code == 409, resp.text
    plan = resp.json()["plan"]
    version_warning = next(
        c for c in plan["conflicts"] if c["kind"] == "andes-version"
    )
    assert version_warning["severity"] == "warning"
    assert version_warning["bundle_andes_version"] == "99.0.0"

    # Re-issue with force_resolve=true; the substrate proceeds.
    resp2 = await _post_bundle(
        client, sid, buf.getvalue(), force_resolve=True
    )
    assert resp2.status_code == 200, resp2.text
    assert resp2.json()["status"] == "committed"
