"""Integration tests for ``POST /api/external-results``.

Same client fixture as ``tests/integration/test_engines_api.py``: a real
FastAPI app over an ASGI transport. No session is needed. The workbooks are laid
out as ANDES reads a TSAT export: a header row, the 6 rows ANDES skips after it,
then time and the signals.
"""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from openpyxl import Workbook

from tensa.api.app import make_app
from tensa.api.routes import external_results as route
from tensa.core.session import SessionManager

pytestmark = pytest.mark.integration


@pytest.fixture
async def client(tmp_path: Path) -> AsyncIterator[httpx.AsyncClient]:
    """Yield an httpx AsyncClient pointed at a fresh FastAPI app instance."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
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
        ) as ac:
            yield ac
    finally:
        await mgr.shutdown()


def _tsat_workbook(data: list[list[Any]]) -> bytes:
    width = max(len(row) for row in data)
    book = Workbook()
    sheet = book.active
    sheet.append(["TSAT export", *([None] * (width - 1))])
    for i in range(6):
        sheet.append([f"meta {i}", *(f"channel {j}" for j in range(1, width))])
    for row in data:
        sheet.append(row)
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


_OCTET = {"Content-Type": "application/octet-stream"}


async def test_a_tsat_workbook_answers_its_series(client: httpx.AsyncClient) -> None:
    rows = [[0.0, 1.0, 10.0], [0.1, 0.9, 11.0], [0.2, 0.8, 12.0]]
    resp = await client.post(
        "/api/external-results?source=tsat", content=_tsat_workbook(rows), headers=_OCTET
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"] == "tsat"
    assert body["samples"] == len(rows)
    assert [s["name"] for s in body["series"]] == ["column 1", "column 2"]
    for series in body["series"]:
        assert series["t"] == [0.0, 0.1, 0.2]
    assert body["series"][0]["y"] == [1.0, 0.9, 0.8]
    assert body["series"][1]["y"] == [10.0, 11.0, 12.0]


async def test_a_value_that_is_not_a_finite_number_is_null_in_strict_json(
    client: httpx.AsyncClient,
) -> None:
    rows = [[0.0, 1.0], [0.1, "inf"], [0.2, "nan"], [0.3, None], [0.4, 0.5]]
    resp = await client.post(
        "/api/external-results?source=tsat", content=_tsat_workbook(rows), headers=_OCTET
    )
    assert resp.status_code == 200, resp.text

    def refuse(token: str) -> None:
        raise AssertionError(f"the answer holds {token}, which JSON does not have")

    body = json.loads(resp.text, parse_constant=refuse)
    assert body["series"][0]["y"] == [1.0, None, None, None, 0.5]


async def test_the_response_feeds_response_metrics_as_is(client: httpx.AsyncClient) -> None:
    rows = [[0.0, 1.0], [0.1, 0.5], [0.2, 0.8], [0.3, 0.9]]
    imported = await client.post(
        "/api/external-results?source=tsat", content=_tsat_workbook(rows), headers=_OCTET
    )
    assert imported.status_code == 200, imported.text
    metrics = await client.post("/api/response-metrics", json={"series": imported.json()["series"]})
    assert metrics.status_code == 200, metrics.text
    results = metrics.json()["results"]
    assert len(results) == 1
    assert results[0]["name"] == "column 1"
    assert results[0]["error"] is None


async def test_an_imported_dip_reports_its_nadir(client: httpx.AsyncClient) -> None:
    # A frequency-nadir shape: the import must have an effect, not only succeed.
    dip = [60.0, 59.8, 59.4, 59.55, 59.7, 59.85, 59.95, 60.0]
    rows = [[i * 0.1, value] for i, value in enumerate(dip)]
    imported = await client.post(
        "/api/external-results?source=tsat", content=_tsat_workbook(rows), headers=_OCTET
    )
    assert imported.status_code == 200, imported.text
    metrics = await client.post("/api/response-metrics", json={"series": imported.json()["series"]})
    assert metrics.status_code == 200, metrics.text
    nadir = metrics.json()["results"][0]["nadir"]
    assert nadir["value"] == pytest.approx(min(dip), abs=1e-9)
    assert nadir["t"] == pytest.approx(0.2, abs=1e-9)


async def test_a_missing_source_is_422(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/external-results", content=b"whatever")
    assert resp.status_code == 422, resp.text


async def test_an_unknown_source_is_422(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/external-results?source=matlab", content=b"whatever")
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("content", [b"", b"this is not a workbook", b"t,v\n0,1\n"])
async def test_a_body_that_is_not_a_workbook_is_422(
    client: httpx.AsyncClient, content: bytes
) -> None:
    resp = await client.post("/api/external-results?source=tsat", content=content)
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["status"] == 422
    assert body["detail"]


async def test_a_multipart_body_is_415(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/external-results?source=tsat",
        files={"file": ("out.xlsx", _tsat_workbook([[0.0, 1.0]]))},
    )
    assert resp.status_code == 415, resp.text
    assert resp.json()["status"] == 415


async def test_a_workbook_past_a_bound_is_413(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tensa.core import external_results as core

    monkeypatch.setattr(core, "MAX_ROWS", 2)
    resp = await client.post(
        "/api/external-results?source=tsat",
        content=_tsat_workbook([[0.0, 1.0], [0.1, 2.0], [0.2, 3.0]]),
    )
    assert resp.status_code == 413, resp.text
    assert "more than 2 rows" in resp.json()["detail"]


async def test_a_zip_bomb_is_413_before_it_is_unpacked(client: httpx.AsyncClient) -> None:
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(_tsat_workbook([[0.0, 1.0]]))) as src, zipfile.ZipFile(
        out, "w", zipfile.ZIP_DEFLATED
    ) as dst:
        for info in src.infolist():
            dst.writestr(info.filename, src.read(info.filename))
        dst.writestr("xl/media/bomb.bin", b"\0" * (129 * 1024 * 1024))
    resp = await client.post("/api/external-results?source=tsat", content=out.getvalue())
    assert resp.status_code == 413, resp.text
    assert "unpacks to" in resp.json()["detail"]


async def test_the_workbook_is_read_off_the_event_loop(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A large workbook takes seconds to read; on the event loop it would hold up
    every other request and every live stream."""
    seen: list[bool] = []

    def reader(data: bytes, *, source: str) -> tuple[list[str], list[list[float | None]], list[float]]:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            seen.append(False)
        else:
            seen.append(True)
        return ["column 1"], [[1.0]], [0.0]

    monkeypatch.setattr(route, "excel_to_series", reader)
    resp = await client.post("/api/external-results?source=psse", content=b"PK")
    assert resp.status_code == 200, resp.text
    assert seen == [False]


async def test_a_foreign_origin_cannot_post_a_workbook(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A page in another tab posting a form with a file in it is answered by the
    Host/Origin middleware, before the route reads a byte."""
    called: list[bytes] = []
    monkeypatch.setattr(
        route, "excel_to_series", lambda data, *, source: called.append(data) or ([], [], [])
    )
    resp = await client.post(
        "/api/external-results?source=tsat",
        files={"file": ("out.xlsx", _tsat_workbook([[0.0, 1.0]]))},
        headers={"Origin": "https://evil.example"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "bad-origin"
    resp = await client.post(
        "/api/external-results?source=tsat",
        content=_tsat_workbook([[0.0, 1.0]]),
        headers={**_OCTET, "Origin": "https://evil.example"},
    )
    assert resp.status_code == 400, resp.text
    assert called == []


async def _raw_post(
    app: Any, chunks: list[bytes], *, content_length: int | None
) -> tuple[int, dict[str, Any], int]:
    """POST ``chunks`` through ASGI by hand; the status, the answer, and how many
    chunks the server asked for."""
    headers = [(b"host", b"127.0.0.1:8000"), (b"content-type", b"application/octet-stream")]
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))
    path = "/api/external-results"
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"source=tsat",
        "root_path": "", "headers": headers, "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8000),
    }
    asked = 0

    async def receive() -> dict[str, Any]:
        nonlocal asked
        if asked >= len(chunks):
            return {"type": "http.disconnect"}
        chunk = chunks[asked]
        asked += 1
        return {"type": "http.request", "body": chunk, "more_body": asked < len(chunks)}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await app(scope, receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, json.loads(raw) if raw else {}, asked


async def test_a_declared_length_over_the_cap_is_refused_before_a_byte_is_read(
    tmp_path: Path,
) -> None:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    status, answer, asked = await _raw_post(
        app, [b"PK"], content_length=route.MAX_EXPORT_BYTES + 1
    )
    assert (status, asked) == (413, 0)
    assert answer["detail"] == "the export exceeds 32 MiB"


async def test_a_body_sent_without_a_length_is_counted_as_it_arrives(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(route, "MAX_EXPORT_BYTES", 100)
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    chunks = [b"x" * 40] * 10
    status, _answer, asked = await _raw_post(app, chunks, content_length=None)
    assert status == 413
    # Refused on the chunk that took it past the cap, with the rest unread.
    assert asked == 3
