"""Integration tests for the SPA static-file mount + ``/api`` prefix.

Asserts the end-to-end shape of Unit 10's wheel-bundling change:

- ``GET /`` returns the SPA's ``index.html``.
- ``GET /openapi.json`` still returns the OpenAPI spec (NOT shadowed by
  the StaticFiles mount).
- ``GET /api/sessions`` reaches the router and returns the session list
  (the substrate routes are NOT shadowed by the SPA).
- ``GET /<unknown-frontend-path>`` falls back to ``index.html`` so
  client-side routing survives a hard reload (the ``_SpaStaticFiles``
  subclass handles this).
- ``GET /api/<unknown>`` returns 404 from the API router, NOT the SPA
  HTML.
- The app still functions when no SPA bundle is found — substrate API
  remains usable from curl.

The fixture builds a minimal ``index.html`` in a tmp_path and pins
``make_app(static_override=...)`` to it, so this test runs even in
environments where ``web/dist/`` has not been built. (That keeps the
gate independent of the JavaScript toolchain.)
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from tensa.api.app import make_app
from tensa.core.session import SessionManager

INDEX_HTML = (
    "<!doctype html><html><head><title>tensa</title></head>"
    '<body><div id="root">test</div></body></html>'
)


async def _make_client(
    workspace: Path, static_override: Path | None
) -> tuple[httpx.AsyncClient, SessionManager]:
    """Build a FastAPI app + httpx ASGITransport for one test.

    Returns (client, session_manager) so the test can shut down the manager
    cleanly. The fixture wrappers below use this and yield via
    ``AsyncIterator``.
    """
    app = make_app(
        workspace=workspace,
        bind_host="127.0.0.1",
        bind_port=8000,
        max_sessions=2,
        idle_timeout_seconds=180.0,
        static_override=static_override,
    )
    mgr = SessionManager(max_sessions=2, idle_timeout=180.0)
    await mgr.start()
    app.state.session_manager = mgr
    app.state.workspace = workspace
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1:8000"
    )
    return client, mgr


@pytest.fixture
async def client_with_static(
    tmp_path: Path,
) -> AsyncIterator[tuple[httpx.AsyncClient, Path]]:
    """Yield an httpx client backed by a FastAPI app with a tmp_path SPA dir."""
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text(INDEX_HTML)
    # A static asset that should be served from ``/assets/foo.js``.
    (static_dir / "assets").mkdir()
    (static_dir / "assets" / "foo.js").write_text("export const x = 1;\n")

    client, mgr = await _make_client(workspace, static_override=static_dir)
    try:
        async with client as ac:
            yield ac, static_dir
    finally:
        await mgr.shutdown()


@pytest.mark.integration
async def test_get_root_returns_index_html(
    client_with_static: tuple[httpx.AsyncClient, Path],
) -> None:
    """``GET /`` returns ``index.html`` (the SPA entry point)."""
    client, _static = client_with_static
    resp = await client.get("/")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/html")
    assert '<div id="root">' in resp.text


@pytest.mark.integration
async def test_get_static_asset_served_from_assets_path(
    client_with_static: tuple[httpx.AsyncClient, Path],
) -> None:
    """Static sub-paths (``/assets/foo.js``) are served verbatim — the
    StaticFiles mount handles the bytes."""
    client, _static = client_with_static
    resp = await client.get("/assets/foo.js")
    assert resp.status_code == 200, resp.text
    assert "export const x = 1;" in resp.text


@pytest.mark.integration
async def test_openapi_json_not_shadowed_by_spa(
    client_with_static: tuple[httpx.AsyncClient, Path],
) -> None:
    """``GET /openapi.json`` returns the OpenAPI spec, not the SPA HTML."""
    client, _static = client_with_static
    resp = await client.get("/openapi.json")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["openapi"].startswith("3."), body
    assert "paths" in body
    # Sanity: the spec should reflect the /api prefix on the substrate routes.
    assert any(p.startswith("/api/") for p in body["paths"]), list(body["paths"])[:5]


@pytest.mark.integration
async def test_api_sessions_reaches_router(
    client_with_static: tuple[httpx.AsyncClient, Path],
) -> None:
    """``GET /api/sessions`` returns the session list — proving the
    router is not shadowed by the SPA mount."""
    client, _static = client_with_static
    resp = await client.get("/api/sessions")
    assert resp.status_code == 200, resp.text
    assert isinstance(resp.json().get("sessions"), list), resp.text


@pytest.mark.integration
async def test_unknown_frontend_path_falls_back_to_index_html(
    client_with_static: tuple[httpx.AsyncClient, Path],
) -> None:
    """``GET /case/foo`` (a future client-side SPA route) falls back to
    ``index.html`` so a hard reload of a deep link still loads the app.

    The ``_SpaStaticFiles`` subclass implements this fallback (stock
    Starlette ``html=True`` returns 404 instead).
    """
    client, _static = client_with_static
    resp = await client.get("/some-frontend-path")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/html")
    assert '<div id="root">' in resp.text


@pytest.mark.integration
async def test_unknown_api_path_returns_404_not_spa(
    client_with_static: tuple[httpx.AsyncClient, Path],
) -> None:
    """``GET /api/<unknown>`` returns 404 from the FastAPI router (NOT the
    SPA HTML). This proves the SPA mount doesn't swallow API misses."""
    client, _static = client_with_static
    resp = await client.get("/api/does-not-exist")
    assert resp.status_code == 404, resp.text
    # The SPA HTML carries an obvious marker — make sure that's NOT what
    # we got back. A real 404 from FastAPI is JSON / plain text.
    assert '<div id="root">' not in resp.text


@pytest.mark.integration
async def test_app_still_serves_api_when_no_spa_bundle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When no SPA bundle is found, the substrate stays usable: ``/api/*``
    and ``/openapi.json`` still answer. ``GET /`` 404s (as documented in
    the warning log)."""
    # Force ``_find_spa_dir`` to return None so the no-mount branch fires.
    monkeypatch.setattr(
        "tensa.api.app._find_spa_dir", lambda: None
    )
    workspace = tmp_path / "ws"
    workspace.mkdir(mode=0o700)
    client, mgr = await _make_client(workspace, static_override=None)
    try:
        async with client as ac:
            # API still answers
            resp = await ac.get("/api/sessions")
            assert resp.status_code == 200, resp.text
            # OpenAPI still answers
            resp = await ac.get("/openapi.json")
            assert resp.status_code == 200, resp.text
            # GET / 404s because no mount was registered
            resp = await ac.get("/")
            assert resp.status_code == 404, resp.text
    finally:
        await mgr.shutdown()
