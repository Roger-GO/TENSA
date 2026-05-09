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

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response
from starlette.types import Scope

from andes_app import __version__
from andes_app.api.routes.cases import router as cases_router
from andes_app.api.routes.disturbances import router as disturbances_router
from andes_app.api.routes.eig import router as eig_router
from andes_app.api.routes.elements import router as elements_router
from andes_app.api.routes.pflow import router as pflow_router
from andes_app.api.routes.reports import router as reports_router
from andes_app.api.routes.sessions import router as sessions_router
from andes_app.api.routes.snapshot import router as snapshot_router
from andes_app.api.routes.tds import router as tds_router
from andes_app.api.routes.workspace import router as workspace_router
from andes_app.api.routes.ws import router as ws_router
from andes_app.api.schemas import ProblemDetails
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
        except (FileNotFoundError, PermissionError) as exc:
            # If the SPA bundle directory disappears post-mount (or its
            # permissions change to deny read), Starlette can leak a bare
            # OSError instead of an HTTPException. Re-raise as a 404 so the
            # surrounding fallback logic handles it like any other miss.
            if path.startswith("api/") or path == "api":
                raise StarletteHTTPException(status_code=404) from exc
            try:
                return await super().get_response("index.html", scope)
            except (FileNotFoundError, PermissionError) as inner:
                raise StarletteHTTPException(status_code=404) from inner


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

    # ProblemDetails error envelope (RFC 7807). Wrap any HTTPException raised
    # by routes/dependencies into the schema declared in ``schemas.py`` so the
    # OpenAPI ``responses`` declarations match the wire shape. Registered
    # before the routers so the handler is in place before any route fires.
    app.add_exception_handler(HTTPException, _problem_details_handler)
    app.add_exception_handler(
        RequestValidationError, _request_validation_to_problem_details
    )

    # Spec-driven agents discover the per-launch token via this securityScheme.
    app.openapi = _custom_openapi_factory(app)  # type: ignore[method-assign]

    # Build the allow-lists. Hosts are checked against the request's Host
    # header (which is "127.0.0.1:port" or "localhost:port" by default).
    # Origins are checked against the Origin header on cross-origin browser
    # requests.
    bind_hosts: set[str] = {"127.0.0.1", "localhost"}
    if bind_port:
        bind_hosts.add(f"{bind_host}:{bind_port}")
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
    app.include_router(elements_router, prefix="/api", tags=["elements"])
    app.include_router(tds_router, prefix="/api", tags=["tds"])
    app.include_router(workspace_router, prefix="/api", tags=["workspace"])
    app.include_router(snapshot_router, prefix="/api", tags=["bundle"])
    app.include_router(reports_router, prefix="/api", tags=["reports"])
    app.include_router(eig_router, prefix="/api", tags=["eig"])
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


def _problem_details_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Wrap ``HTTPException`` into a ``ProblemDetails`` JSON envelope.

    Maps:

    - ``exc.status_code`` → ``status``
    - ``exc.detail`` (str)  → ``detail``
    - ``exc.detail`` (dict) → spread into the body, with ``detail`` and
      ``instance`` fields preserved if present.

    The ``type`` URI defaults to ``about:blank`` per RFC 7807 §4.2.
    """
    if not isinstance(exc, HTTPException):  # pragma: no cover — defensive
        raise exc
    status_code = int(exc.status_code)
    title = _http_reason_phrase(status_code)
    detail_value = exc.detail
    instance: str | None = None
    extra: dict[str, object] = {}
    if isinstance(detail_value, dict):
        # Preserve `instance` if the route author embedded one; spread any
        # other fields into the response so callers don't lose context.
        instance = detail_value.get("instance") if isinstance(
            detail_value.get("instance"), str
        ) else None
        if "title" in detail_value and isinstance(detail_value["title"], str):
            title = detail_value["title"]
        detail_str = (
            detail_value["detail"]
            if isinstance(detail_value.get("detail"), str)
            else None
        )
        for k, v in detail_value.items():
            if k in {"detail", "instance", "title"}:
                continue
            extra[k] = v
    elif isinstance(detail_value, str):
        detail_str = detail_value
    elif detail_value is None:
        detail_str = None
    else:
        detail_str = str(detail_value)
    body = ProblemDetails(
        type="about:blank",
        title=title,
        status=status_code,
        detail=detail_str,
        instance=instance,
    ).model_dump(mode="json")
    body.update(extra)
    headers = getattr(exc, "headers", None)
    return JSONResponse(status_code=status_code, content=body, headers=headers)


def _request_validation_to_problem_details(
    _request: Request, exc: Exception
) -> JSONResponse:
    """Wrap FastAPI's ``RequestValidationError`` into ``ProblemDetails``.

    The default FastAPI handler emits ``{"detail": [errors]}`` and, on inputs
    containing non-finite floats (e.g., a JSON ``Infinity`` literal), the
    JSON encoder raises ``ValueError``. We render the error list as a string
    so the response is always JSON-serializable.
    """
    if not isinstance(exc, RequestValidationError):  # pragma: no cover
        raise exc
    body = ProblemDetails(
        type="about:blank",
        title="Unprocessable Content",
        status=422,
        detail=f"request body failed validation: {exc.errors()!r}",
        instance=None,
    ).model_dump(mode="json")
    return JSONResponse(status_code=422, content=body)


def _http_reason_phrase(status_code: int) -> str:
    """Return the canonical reason phrase for an HTTP status code."""
    try:
        from http import HTTPStatus

        return HTTPStatus(status_code).phrase
    except ValueError:
        return "Error"


def _custom_openapi_factory(app: FastAPI):  # type: ignore[no-untyped-def]
    """Return a closure that lazily builds the OpenAPI schema with a
    ``securitySchemes`` declaration for the ``X-Andes-Token`` header so
    spec-driven agent tooling discovers the auth contract.
    """

    def custom_openapi() -> dict:  # type: ignore[type-arg]
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            description=app.description,
            routes=app.routes,
        )
        components = schema.setdefault("components", {})
        components["securitySchemes"] = {
            "AndesToken": {
                "type": "apiKey",
                "in": "header",
                "name": "X-Andes-Token",
                "description": (
                    "Per-launch token. Read from the file path printed to "
                    "stderr at startup (default ~/.andes-app/run-<pid>.token)."
                ),
            }
        }
        schema["security"] = [{"AndesToken": []}]
        app.openapi_schema = schema
        return schema

    return custom_openapi


class _PureASGIWrapper:
    """Adapter that lets us mount a pure-ASGI middleware via FastAPI's
    ``add_middleware`` API, which expects a class. The class instance becomes
    the wrapping ASGI app.
    """

    def __init__(self, app, wrap):  # type: ignore[no-untyped-def]
        self._app = wrap(app)

    async def __call__(self, scope, receive, send):  # type: ignore[no-untyped-def]
        await self._app(scope, receive, send)
