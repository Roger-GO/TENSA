"""Pure ASGI middleware: Host/Origin validation and security response headers.

These run BEFORE FastAPI's routing layer and BEFORE any logging or exception
handler can see the request. They are pure ASGI (not ``BaseHTTPMiddleware``)
so they apply uniformly to HTTP and WebSocket-upgrade scopes — important
because the Host check must hold for the WS upgrade itself, not just for
HTTP requests.

Host/Origin validation defeats DNS rebinding from random browser tabs: a
hostile page can make the browser send requests to 127.0.0.1, but it cannot
forge the Host/Origin headers to match the allow-list.

The response headers (``SECURITY_HEADERS``) tell a browser not to put the app in
a frame, not to guess a response's content type, and not to send a referrer. A
hostile page that frames the UI at the loopback address could otherwise get a
click or a keystroke into it.
"""

from __future__ import annotations

import collections.abc as cabc
from typing import Any

# ASGI scope/message types. We don't depend on the exact typing of asgiref
# so use plain dicts as the contract.
ASGIScope = dict[str, Any]
ASGIMessage = dict[str, Any]
ASGIApp = cabc.Callable[
    [ASGIScope, cabc.Callable[[], cabc.Awaitable[ASGIMessage]], cabc.Callable[[ASGIMessage], cabc.Awaitable[None]]],
    cabc.Awaitable[None],
]
ASGIReceive = cabc.Callable[[], cabc.Awaitable[ASGIMessage]]
ASGISend = cabc.Callable[[ASGIMessage], cabc.Awaitable[None]]

# Sent with every HTTP response. ``frame-ancestors`` is the modern form of
# ``X-Frame-Options`` and is sent beside it for browsers that only know the old
# one. The policy lists no other directive, so scripts, styles and connections
# are not restricted.
SECURITY_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"x-frame-options", b"DENY"),
    (b"content-security-policy", b"frame-ancestors 'none'"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
)


def make_security_headers_middleware(app: ASGIApp) -> ASGIApp:
    """Add ``SECURITY_HEADERS`` to every HTTP response.

    A header the response already carries is left as it is, so a route that needs
    a different policy can set its own. WebSocket scopes pass through untouched:
    the headers describe a document, and a handshake has none.

    Wrap the Host/Origin middleware with this one, so that a request it rejects
    carries the headers too.
    """

    async def _app(scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
        if scope.get("type") != "http":
            await app(scope, receive, send)
            return

        async def _send(message: ASGIMessage) -> None:
            if message["type"] == "http.response.start":
                headers: list[tuple[bytes, bytes]] = list(message.get("headers", []))
                present = {name.lower() for name, _ in headers}
                missing = [pair for pair in SECURITY_HEADERS if pair[0] not in present]
                if missing:
                    message = {**message, "headers": [*headers, *missing]}
            await send(message)

        await app(scope, receive, _send)

    return _app


def make_host_origin_middleware(
    app: ASGIApp,
    *,
    allowed_hosts: frozenset[str],
    allowed_origins: frozenset[str],
) -> ASGIApp:
    """Reject requests whose ``Host`` header is not in ``allowed_hosts``, or
    whose ``Origin`` (when present) is not in ``allowed_origins``.

    Applies to both HTTP and WebSocket scopes. On rejection:

    - HTTP: respond with ``400 Bad Request`` + a tiny JSON body.
    - WebSocket: send ``websocket.close`` with code 1008.
    """

    async def _app(scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
        scope_type = scope.get("type")
        if scope_type not in ("http", "websocket"):
            await app(scope, receive, send)
            return

        headers: list[tuple[bytes, bytes]] = scope.get("headers", [])
        host = _header_value(headers, b"host")
        origin = _header_value(headers, b"origin")

        if host is not None and host.decode("latin-1").split(":")[0:2] is not None:
            host_str = host.decode("latin-1")
            if host_str not in allowed_hosts and host_str.split(":")[0] not in {
                h.split(":")[0] for h in allowed_hosts
            }:
                await _reject(scope_type, send, reason="bad-host")
                return
        if origin is not None:
            origin_str = origin.decode("latin-1")
            if origin_str not in allowed_origins:
                await _reject(scope_type, send, reason="bad-origin")
                return

        await app(scope, receive, send)

    return _app


def _header_value(headers: list[tuple[bytes, bytes]], name_lower: bytes) -> bytes | None:
    for name, value in headers:
        if name.lower() == name_lower:
            return value
    return None


async def _reject(scope_type: str, send: ASGISend, *, reason: str) -> None:
    if scope_type == "http":
        body = (
            b'{"type":"about:blank","title":"Bad Request","status":400,'
            b'"detail":"' + reason.encode("ascii") + b'"}'
        )
        await send(
            {
                "type": "http.response.start",
                "status": 400,
                "headers": [
                    (b"content-type", b"application/problem+json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})
    else:  # websocket
        await send({"type": "websocket.close", "code": 1008, "reason": reason})
