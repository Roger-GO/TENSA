"""FastAPI application factory.

Middleware ordering is load-bearing — both Host/Origin and token-redaction
are pure ASGI (not BaseHTTPMiddleware), so they apply uniformly to HTTP and
WebSocket-upgrade scopes. The execution order (outermost → innermost) is:

    1. Host/Origin check (rejects bad-host before any FastAPI code runs)
    2. Token redaction (swaps the header value before logs/exceptions see it)
    3. CORS (FastAPI's middleware — allows preflights and validates origins)
    4. FastAPI router (auth dependency runs here, reads the captured token
       from scope state)

uvicorn's default access log is disabled at startup; the substrate is
local-only and the access logger is SaaS-phase work.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.types import Scope

from andes_app import __version__
from andes_app.api.routes.cases import router as cases_router
from andes_app.api.routes.disturbances import router as disturbances_router
from andes_app.api.routes.pflow import router as pflow_router
from andes_app.api.routes.sessions import router as sessions_router
from andes_app.api.routes.tds import router as tds_router
from andes_app.api.routes.workspace import router as workspace_router
from andes_app.api.routes.ws import router as ws_router
from andes_app.core.session import SessionManager
from andes_app.security.middleware import (
    make_host_origin_middleware,
    make_token_redaction_middleware,
)

log = logging.getLogger(__name__)


class _SpaStaticFiles(StaticFiles):
    """``StaticFiles`` with SPA-style fallback.

    Stock Starlette ``StaticFiles(html=True)`` only serves an ``index.html``
    when the URL points at a real directory; otherwise it returns 404. A
    React/Vite SPA wants the opposite: any unknown path that doesn't have
    a file extension should fall through to ``index.html`` so the
    client-side router can pick up the route on hard reload.

    We override ``get_response`` to catch a 404 on a missing file and
    re-serve ``index.html`` with a 200. The ``/api/*`` namespace lives on
    its own routers (registered before this mount in ``make_app``), so
    the fallback never shadows the substrate API.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            # Only 404 from a missing file falls back. 401 / 405 / etc.
            # propagate untouched. The ``api/`` namespace also propagates
            # — an unknown ``/api/<path>`` is a real API miss and must
            # surface as 404, not the SPA HTML.
            if exc.status_code != 404:
                raise
            if path.startswith("api/") or path == "api":
                raise
            return await super().get_response("index.html", scope)


def _find_spa_dir() -> Path | None:
    """Resolve the SPA bundle directory for the StaticFiles mount.

    Two locations are considered, in order:

    1. ``andes_app/static/`` next to the package (wheel-installed location;
       hatch ``force-include`` copies ``web/dist/`` here at build time).
    2. ``../../web/dist/`` relative to the package (dev mode where the
       source tree is editable-installed alongside ``web/``).

    Returns ``None`` if neither location holds an ``index.html`` — the
    substrate stays usable via ``/api/*`` and ``GET /`` will 404.
    """
    # ``app.py`` is at ``server/src/andes_app/api/app.py``. Going up:
    #   parent      → ``server/src/andes_app/api/``
    #   parent.parent → ``server/src/andes_app/`` (the package root)
    pkg_static = Path(__file__).resolve().parent.parent / "static"
    if (pkg_static / "index.html").is_file():
        return pkg_static
    # Dev mode: ``web/dist/`` sits five levels up from app.py:
    #   api → andes_app → src → server → <project root> → web/dist
    dev_dist = (
        Path(__file__).resolve().parent.parent.parent.parent.parent / "web" / "dist"
    )
    if (dev_dist / "index.html").is_file():
        return dev_dist
    return None


def make_app(
    *,
    expected_token: str,
    workspace: Path,
    bind_host: str = "127.0.0.1",
    bind_port: int = 0,
    max_sessions: int = 4,
    idle_timeout_seconds: float = 180.0,
    extra_allowed_hosts: frozenset[str] = frozenset(),
    extra_allowed_origins: frozenset[str] = frozenset(),
    static_override: Path | None = None,
) -> FastAPI:
    """Build the FastAPI app. Caller is responsible for serving it via
    uvicorn (see ``andes_app.cli``).

    The token is generated and the workspace is created by the CLI before
    this is called; both are passed in.

    ``static_override`` lets tests pin the SPA directory to a tmp_path with a
    minimal ``index.html``; production callers leave it ``None`` so the
    resolver picks up the wheel-installed or dev-mode bundle.
    """

    @asynccontextmanager
    async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
        mgr = SessionManager(
            max_sessions=max_sessions,
            idle_timeout=idle_timeout_seconds,
            workspace=str(workspace),
        )
        await mgr.start()
        app.state.session_manager = mgr
        app.state.expected_token = expected_token
        app.state.workspace = workspace
        try:
            yield
        finally:
            await mgr.shutdown()

    app = FastAPI(
        title="andes-app substrate",
        version=__version__,
        description=(
            "HTTP / WebSocket API for the ANDES power-system simulator. "
            "Phase A substrate; v0.1+ ships a React UI on top."
        ),
        lifespan=_lifespan,
    )

    # Build the allow-lists. Hosts are checked against the request's Host
    # header (which is "127.0.0.1:port" or "localhost:port" by default).
    # Origins are checked against the Origin header on cross-origin browser
    # requests.
    bind_hosts = {f"{bind_host}:{bind_port}", "127.0.0.1", "localhost"}
    if bind_port:
        bind_hosts.add(f"127.0.0.1:{bind_port}")
        bind_hosts.add(f"localhost:{bind_port}")
    allowed_hosts = frozenset(bind_hosts | extra_allowed_hosts)

    bind_origins = {
        f"http://127.0.0.1:{bind_port}" if bind_port else "http://127.0.0.1",
        f"http://localhost:{bind_port}" if bind_port else "http://localhost",
    }
    allowed_origins = frozenset(bind_origins | extra_allowed_origins)

    # Mount in *reverse* order — Starlette's user_middleware is applied as a
    # stack, with the most-recently-added middleware being innermost.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(allowed_origins),
        allow_credentials=False,  # token is in a header, not a cookie
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["X-Andes-Token", "Content-Type"],
    )

    # Pure-ASGI middleware go on the outermost layer. We wrap ``app`` itself
    # rather than using ``add_middleware`` because the latter doesn't support
    # callable factories cleanly with our parameters.
    app.add_middleware(
        _PureASGIWrapper,
        wrap=lambda inner: make_token_redaction_middleware(
            make_host_origin_middleware(
                inner,
                allowed_hosts=allowed_hosts,
                allowed_origins=allowed_origins,
            )
        ),
    )

    # Routers — all substrate routes are namespaced under ``/api`` so the
    # SPA mount at ``/`` (added below) doesn't shadow them. ``/openapi.json``
    # is registered by FastAPI itself and stays at the root path.
    app.include_router(sessions_router, prefix="/api", tags=["sessions"])
    app.include_router(cases_router, prefix="/api", tags=["cases"])
    app.include_router(pflow_router, prefix="/api", tags=["pflow"])
    app.include_router(disturbances_router, prefix="/api", tags=["disturbances"])
    app.include_router(tds_router, prefix="/api", tags=["tds"])
    app.include_router(workspace_router, prefix="/api", tags=["workspace"])
    app.include_router(ws_router, prefix="/api", tags=["streaming"])

    # SPA mount goes LAST so the ``/api/*`` routers and ``/openapi.json``
    # win the dispatch race. ``html=True`` makes ``GET /`` return
    # ``index.html`` and unknown sub-paths fall back to it (so client-side
    # routes like ``/case/foo`` survive a hard reload).
    spa_dir = static_override if static_override is not None else _find_spa_dir()
    if spa_dir is not None and (spa_dir / "index.html").is_file():
        app.mount(
            "/",
            _SpaStaticFiles(directory=str(spa_dir), html=True),
            name="spa",
        )
        log.info("SPA mounted at / from %s", spa_dir)
    else:
        log.warning(
            "No SPA bundle found at andes_app/static or ../web/dist; "
            "GET / will 404. Run 'pnpm build' in web/ to populate the bundle, "
            "or install the wheel that ships it."
        )

    return app


class _PureASGIWrapper:
    """Adapter that lets us mount a pure-ASGI middleware via FastAPI's
    ``add_middleware`` API, which expects a class. The class instance becomes
    the wrapping ASGI app.
    """

    def __init__(self, app, wrap):  # type: ignore[no-untyped-def]
        self._app = wrap(app)

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        await self._app(scope, receive, send)
