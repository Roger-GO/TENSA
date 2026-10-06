"""Pure ASGI middleware that logs each request at ``DEBUG``.

``tensa serve`` turns uvicorn's access log off, so without this nothing in the log
says what a client asked for. Each HTTP request is one line on the ``tensa.request``
logger, written when the response has been sent::

    GET /api/sessions -> 200 (3 ms)

A WebSocket gets a line when it is accepted and one when it ends (``refused`` for a
handshake that was turned away, a rejected Host or Origin among them). Only the
path is logged, percent-encoded so a crafted one cannot break a log line in two; the
query string and the bodies are left out, since a case path or an uploaded file does
not belong in a log.

It sits outside every other middleware, so it also sees the requests they turn away.
Nothing is measured or formatted while the level is above ``DEBUG``.
"""

from __future__ import annotations

import logging
import time
from urllib.parse import quote

from tensa.security.middleware import ASGIApp, ASGIMessage, ASGIReceive, ASGIScope, ASGISend

log = logging.getLogger("tensa.request")


def make_request_log_middleware(app: ASGIApp) -> ASGIApp:
    """Log each HTTP request and each WebSocket of ``app`` at ``DEBUG``."""

    async def _app(scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
        kind = scope.get("type")
        if kind not in ("http", "websocket") or not log.isEnabledFor(logging.DEBUG):
            await app(scope, receive, send)
            return
        if kind == "http":
            await _log_http(app, scope, receive, send)
        else:
            await _log_websocket(app, scope, receive, send)

    return _app


def _path(scope: ASGIScope) -> str:
    return quote(str(scope.get("path", "")))


async def _log_http(app: ASGIApp, scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
    status: int | None = None

    async def _send(message: ASGIMessage) -> None:
        nonlocal status
        if message["type"] == "http.response.start":
            status = int(message["status"])
        await send(message)

    started = time.perf_counter()
    try:
        await app(scope, receive, _send)
    except Exception:
        if status is None:
            status = 500  # what uvicorn answers when the app fails before it responds
        raise
    finally:
        log.debug(
            "%s %s -> %s (%.0f ms)",
            scope.get("method", "?"),
            _path(scope),
            status if status is not None else "no response",
            (time.perf_counter() - started) * 1000,
        )


async def _log_websocket(
    app: ASGIApp, scope: ASGIScope, receive: ASGIReceive, send: ASGISend
) -> None:
    path = _path(scope)
    accepted = False

    async def _send(message: ASGIMessage) -> None:
        nonlocal accepted
        if message["type"] == "websocket.accept":
            accepted = True
            log.debug("WEBSOCKET %s accepted", path)
        await send(message)

    started = time.perf_counter()
    try:
        await app(scope, receive, _send)
    finally:
        if accepted:
            log.debug("WEBSOCKET %s closed after %.1f s", path, time.perf_counter() - started)
        else:
            log.debug("WEBSOCKET %s refused", path)
