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

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from andes_app import __version__
from andes_app.api.routes.cases import router as cases_router
from andes_app.api.routes.disturbances import router as disturbances_router
from andes_app.api.routes.pflow import router as pflow_router
from andes_app.api.routes.sessions import router as sessions_router
from andes_app.api.routes.tds import router as tds_router
from andes_app.api.routes.ws import router as ws_router
from andes_app.core.session import SessionManager
from andes_app.security.middleware import (
    make_host_origin_middleware,
    make_token_redaction_middleware,
)


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
) -> FastAPI:
    """Build the FastAPI app. Caller is responsible for serving it via
    uvicorn (see ``andes_app.cli``).

    The token is generated and the workspace is created by the CLI before
    this is called; both are passed in.
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
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
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

    # Routers
    app.include_router(sessions_router, tags=["sessions"])
    app.include_router(cases_router, tags=["cases"])
    app.include_router(pflow_router, tags=["pflow"])
    app.include_router(disturbances_router, tags=["disturbances"])
    app.include_router(tds_router, tags=["tds"])
    app.include_router(ws_router, tags=["streaming"])

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
