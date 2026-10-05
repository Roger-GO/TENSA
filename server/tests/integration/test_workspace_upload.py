"""Integration tests for ``POST /workspace/files``, the case-file upload.

The request body is the file itself, not multipart, and the route stores it in
the workspace root under a name that is safe on every platform. The tests drive
the real app through httpx's ASGI transport against a temporary workspace; the
last one loads an uploaded IEEE 14 case into a session, so it needs ANDES.
"""

from __future__ import annotations

import errno
import os
import stat
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.api.routes import workspace as workspace_routes
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration

_OCTET = {"Content-Type": "application/octet-stream"}


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


async def _upload(
    client: httpx.AsyncClient,
    name: str,
    content: bytes | None = b"case data\n",
    *,
    overwrite: bool | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    params: dict[str, str] = {"name": name}
    if overwrite is not None:
        params["overwrite"] = "true" if overwrite else "false"
    return await client.post(
        "/api/workspace/files",
        params=params,
        content=content,
        headers=_OCTET if headers is None else headers,
    )


def _names(ws: Path) -> list[str]:
    return sorted(p.name for p in ws.iterdir())


# ---- the happy path ---------------------------------------------------------


async def test_upload_stores_the_bytes_and_the_lister_shows_the_file(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    payload = b"\xff\xfe raw bytes, not text \x00\r\n" * 100  # not valid UTF-8: kept verbatim
    resp = await _upload(client, "My Case (v2).raw", payload)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "My Case (v2).raw"
    assert body["size_bytes"] == len(payload)
    assert body["format"] == "raw"
    assert body["replaced"] is False
    assert "T" in body["modified_iso"]

    stored = ws / "My Case (v2).raw"
    assert stored.read_bytes() == payload
    if sys.platform != "win32":
        assert stat.S_IMODE(stored.stat().st_mode) == 0o600
    assert _names(ws) == ["My Case (v2).raw"]  # no temp file left

    listed = (await client.get("/api/workspace/files")).json()["files"]
    assert [f["name"] for f in listed] == ["My Case (v2).raw"]


@pytest.mark.parametrize(
    ("name", "fmt"),
    [
        ("a.xlsx", "xlsx"),
        ("a.raw", "raw"),
        ("a.dyr", "dyr"),
        ("a.json", "json"),
        ("a.m", "m"),
        ("IEEE14.RAW", "raw"),
        ("a.layout.json", "json"),
        ("été.m", "m"),
    ],
)
async def test_upload_takes_every_case_format(
    client_workspace: tuple[httpx.AsyncClient, Path], name: str, fmt: str
) -> None:
    client, ws = client_workspace
    resp = await _upload(client, name)
    assert resp.status_code == 201, resp.text
    assert resp.json()["format"] == fmt
    assert (ws / name).read_bytes() == b"case data\n"


async def test_upload_works_where_os_has_no_fchmod(
    client_workspace: tuple[httpx.AsyncClient, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``os.fchmod`` is missing on Windows before Python 3.13; the layout writer
    taught the temp writer to cope, and uploads share it."""
    monkeypatch.delattr(os, "fchmod", raising=False)
    client, ws = client_workspace
    resp = await _upload(client, "a.raw")
    assert resp.status_code == 201, resp.text
    assert _names(ws) == ["a.raw"]


# ---- never clobber unless asked ---------------------------------------------


async def test_upload_does_not_replace_a_file_unless_asked(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    (ws / "a.raw").write_bytes(b"mine")

    refused = await _upload(client, "a.raw", b"theirs")
    assert refused.status_code == 409, refused.text
    assert "already exists" in refused.json()["detail"]
    assert "overwrite=true" in refused.json()["detail"]
    explicit = await _upload(client, "a.raw", b"theirs", overwrite=False)
    assert explicit.status_code == 409, explicit.text
    assert (ws / "a.raw").read_bytes() == b"mine"
    assert _names(ws) == ["a.raw"]

    replaced = await _upload(client, "a.raw", b"theirs, longer", overwrite=True)
    assert replaced.status_code == 201, replaced.text
    assert replaced.json()["replaced"] is True
    assert replaced.json()["size_bytes"] == len(b"theirs, longer")
    assert (ws / "a.raw").read_bytes() == b"theirs, longer"
    assert _names(ws) == ["a.raw"]


async def test_overwrite_true_on_a_new_name_just_creates_it(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    resp = await _upload(client, "a.raw", overwrite=True)
    assert resp.status_code == 201, resp.text
    assert resp.json()["replaced"] is False
    assert _names(ws) == ["a.raw"]


@pytest.mark.parametrize("overwrite", [False, True])
async def test_upload_onto_a_directory_is_a_conflict(
    client_workspace: tuple[httpx.AsyncClient, Path], overwrite: bool
) -> None:
    client, ws = client_workspace
    (ws / "dir.raw").mkdir()
    resp = await _upload(client, "dir.raw", overwrite=overwrite)
    assert resp.status_code == 409, resp.text
    assert "not a regular file" in resp.json()["detail"]
    assert _names(ws) == ["dir.raw"]


async def test_a_name_taken_between_the_check_and_the_write_is_not_replaced(
    client_workspace: tuple[httpx.AsyncClient, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two uploads of one name cannot both win: the loser's file is claimed with a
    hard link, which refuses a name that exists, not renamed over it."""
    client, ws = client_workspace
    real_write_temp = workspace_routes._write_temp  # noqa: SLF001

    def write_temp_then_lose_the_race(parent: Path, data: bytes, *, prefix: str) -> Path:
        tmp = real_write_temp(parent, data, prefix=prefix)
        (ws / "a.raw").write_bytes(b"the other request won")
        return tmp

    monkeypatch.setattr(workspace_routes, "_write_temp", write_temp_then_lose_the_race)
    resp = await _upload(client, "a.raw", b"too late")
    assert resp.status_code == 409, resp.text
    assert (ws / "a.raw").read_bytes() == b"the other request won"
    assert _names(ws) == ["a.raw"]  # the loser's temp file is gone


@pytest.mark.parametrize("race", [False, True])
async def test_upload_falls_back_to_a_rename_where_hard_links_are_refused(
    client_workspace: tuple[httpx.AsyncClient, Path],
    monkeypatch: pytest.MonkeyPatch,
    race: bool,
) -> None:
    """FAT volumes and some network mounts have no hard links: the upload still
    lands, and a name that appeared meanwhile is still not replaced."""
    client, ws = client_workspace

    def no_links(src: object, dst: object) -> None:
        raise OSError(errno.EPERM, "hard links are not supported here")

    monkeypatch.setattr(os, "link", no_links)
    if race:
        real_write_temp = workspace_routes._write_temp  # noqa: SLF001

        def write_temp_then_lose_the_race(parent: Path, data: bytes, *, prefix: str) -> Path:
            tmp = real_write_temp(parent, data, prefix=prefix)
            (ws / "a.raw").write_bytes(b"the other request won")
            return tmp

        monkeypatch.setattr(workspace_routes, "_write_temp", write_temp_then_lose_the_race)
        resp = await _upload(client, "a.raw", b"too late")
        assert resp.status_code == 409, resp.text
        assert (ws / "a.raw").read_bytes() == b"the other request won"
    else:
        resp = await _upload(client, "a.raw", b"fresh")
        assert resp.status_code == 201, resp.text
        assert (ws / "a.raw").read_bytes() == b"fresh"
    assert _names(ws) == ["a.raw"]


# ---- names ------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "sub/x.raw",
        "../x.raw",
        "..\\x.raw",
        "/etc/x.raw",
        ".hidden.raw",
        ".raw",
        "CON.raw",
        "nul",
        "aux.dyr",
        "a:b.raw",
        "x.raw:stream",
        "x.raw.",
        "x.raw ",
        "a?b.raw",
        "a<b>.raw",
        "tab\tinside.raw",
        "nul\x00.raw",
        "a" * 252 + ".raw",
        "",
    ],
)
async def test_upload_refuses_a_name_that_is_not_a_safe_file_name(
    client_workspace: tuple[httpx.AsyncClient, Path], name: str
) -> None:
    client, ws = client_workspace
    (ws / "sub").mkdir()
    resp = await _upload(client, name)
    assert resp.status_code == 400, resp.text
    assert name == "" or "unsafe file name" in resp.json()["detail"]
    assert _names(ws) == ["sub"]
    assert list((ws / "sub").iterdir()) == []


async def test_upload_accepts_a_name_at_the_length_limit(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    name = "a" * 251 + ".raw"  # 255 bytes
    resp = await _upload(client, name)
    assert resp.status_code == 201, resp.text
    assert _names(ws) == [name]


@pytest.mark.parametrize("name", ["notes.txt", "case", "x.raw.bak", "x.zip", "x.RAW.exe", "raw"])
async def test_upload_refuses_a_file_type_the_workspace_does_not_hold(
    client_workspace: tuple[httpx.AsyncClient, Path], name: str
) -> None:
    client, ws = client_workspace
    resp = await _upload(client, name)
    assert resp.status_code == 422, resp.text
    assert "unsupported file type" in resp.json()["detail"]
    assert _names(ws) == []


async def test_upload_without_a_name_is_a_validation_error(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    resp = await client.post("/api/workspace/files", content=b"x", headers=_OCTET)
    assert resp.status_code == 422, resp.text
    assert _names(ws) == []


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks")
async def test_upload_never_writes_through_a_symlink(
    client_workspace: tuple[httpx.AsyncClient, Path], tmp_path: Path
) -> None:
    client, ws = client_workspace
    outside = tmp_path / "outside.raw"
    outside.write_bytes(b"outside")
    (ws / "dangling.raw").symlink_to(tmp_path / "planted.raw")
    (ws / "linked.raw").symlink_to(outside)
    for name in ("dangling.raw", "linked.raw"):
        for overwrite in (False, True):
            resp = await _upload(client, name, b"x", overwrite=overwrite)
            assert resp.status_code == 400, resp.text
    assert not (tmp_path / "planted.raw").exists()
    assert outside.read_bytes() == b"outside"


# ---- body -------------------------------------------------------------------


async def test_upload_refuses_an_empty_file(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace
    resp = await _upload(client, "a.raw", b"")
    assert resp.status_code == 422, resp.text
    assert "empty" in resp.json()["detail"]
    assert _names(ws) == []


async def test_upload_over_the_cap_is_refused_before_it_is_read(
    client_workspace: tuple[httpx.AsyncClient, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ws = client_workspace
    monkeypatch.setattr(workspace_routes, "MAX_UPLOAD_BYTES", 1024)
    resp = await _upload(client, "big.raw", b"x" * 1025)
    assert resp.status_code == 413, resp.text
    assert _names(ws) == []
    # The cap itself is allowed.
    ok = await _upload(client, "edge.raw", b"x" * 1024)
    assert ok.status_code == 201, ok.text
    assert ok.json()["size_bytes"] == 1024


async def test_upload_without_a_content_length_is_cut_off_at_the_cap(
    client_workspace: tuple[httpx.AsyncClient, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A chunked body declares no length, so the cap is applied as it streams in:
    the server stops reading at the first chunk past it."""
    client, ws = client_workspace
    monkeypatch.setattr(workspace_routes, "MAX_UPLOAD_BYTES", 1024)
    sent = 0

    async def body() -> AsyncIterator[bytes]:
        nonlocal sent
        for _ in range(100):
            sent += 1
            yield b"x" * 256

    resp = await client.post(
        "/api/workspace/files",
        params={"name": "big.raw"},
        content=body(),
        headers=_OCTET,
    )
    assert resp.status_code == 413, resp.text
    assert sent == 5  # four chunks fit, the fifth crossed the cap, no sixth was pulled
    assert _names(ws) == []


async def test_upload_in_chunks_within_the_cap_is_stored_whole(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    client, ws = client_workspace

    async def body() -> AsyncIterator[bytes]:
        for i in range(10):
            yield bytes([65 + i]) * 100

    resp = await client.post(
        "/api/workspace/files",
        params={"name": "chunked.raw"},
        content=body(),
        headers=_OCTET,
    )
    assert resp.status_code == 201, resp.text
    assert (ws / "chunked.raw").read_bytes() == b"".join(bytes([65 + i]) * 100 for i in range(10))


async def test_upload_refuses_a_multipart_body_rather_than_store_its_envelope(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """``curl -F file=@x.raw`` would otherwise save the multipart wrapper as the case."""
    client, ws = client_workspace
    resp = await client.post(
        "/api/workspace/files",
        params={"name": "a.raw"},
        files={"file": ("a.raw", b"case data")},
    )
    assert resp.status_code == 415, resp.text
    assert "--data-binary" in resp.json()["detail"]
    assert _names(ws) == []


async def test_upload_takes_the_body_whatever_its_content_type(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """``curl --data-binary`` sends a form content type, and a ``.json`` case may be
    sent as ``application/json``; neither is parsed, both are the file's bytes."""
    client, ws = client_workspace
    form = await _upload(
        client, "a.raw", b"a=b&c=d", headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    assert form.status_code == 201, form.text
    js = await _upload(
        client, "b.json", b'{"Bus": []}', headers={"Content-Type": "application/json"}
    )
    assert js.status_code == 201, js.text
    bare = await _upload(client, "c.m", b"function mpc = c", headers={})
    assert bare.status_code == 201, bare.text
    assert (ws / "a.raw").read_bytes() == b"a=b&c=d"
    assert (ws / "b.json").read_bytes() == b'{"Bus": []}'
    assert (ws / "c.m").read_bytes() == b"function mpc = c"


# ---- who may upload ---------------------------------------------------------


async def test_upload_from_a_foreign_origin_is_refused_before_the_route_runs(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    """An upload puts a file ANDES will evaluate into the workspace, so a page in
    another tab must not be able to post one: the Host/Origin middleware answers
    first."""
    client, ws = client_workspace
    resp = await _upload(
        client, "a.raw", headers={**_OCTET, "Origin": "https://evil.example"}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "bad-origin"
    assert _names(ws) == []


async def test_upload_without_a_workspace_is_a_server_error() -> None:
    app = make_app(
        workspace=Path("."),
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=1,
        idle_timeout_seconds=180.0,
    )
    app.state.workspace = None
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as ac:
        resp = await _upload(ac, "a.raw")
    assert resp.status_code == 500, resp.text


# ---- an uploaded case is a case ---------------------------------------------


async def test_an_uploaded_case_and_its_dynamic_file_load_into_a_session(
    client_workspace: tuple[httpx.AsyncClient, Path],
) -> None:
    pytest.importorskip("andes")
    import andes

    cases = Path(andes.__file__).parent / "cases" / "ieee14"
    client, ws = client_workspace
    for name in ("ieee14.raw", "ieee14.dyr"):
        resp = await _upload(client, name, (cases / name).read_bytes())
        assert resp.status_code == 201, resp.text
        assert (ws / name).read_bytes() == (cases / name).read_bytes()

    sid = (await client.post("/api/sessions")).json()["session_id"]
    loaded = await client.post(
        f"/api/sessions/{sid}/case",
        json={"primary_path": "ieee14.raw", "addfiles": ["ieee14.dyr"]},
    )
    assert loaded.status_code == 200, loaded.text
    assert len(loaded.json()["buses"]) == 14
