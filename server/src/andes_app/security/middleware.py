"""Pure ASGI middleware: Host/Origin validation + token redaction.

These run BEFORE FastAPI's routing layer and BEFORE any logging or exception
handler can see the request. They are pure ASGI (not ``BaseHTTPMiddleware``)
so they apply uniformly to HTTP and WebSocket-upgrade scopes — important for
the WS auth path because the Host check must hold for the upgrade itself,
not just for HTTP requests.

Host/Origin validation defeats DNS rebinding from random browser tabs even
when a per-launch token would otherwise be the only gate. Token redaction
ensures the token never reaches a log formatter or exception handler — the
ASGI scope's headers are mutated in place so any downstream handler that
prints the request sees a sentinel.
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


REDACTED = b"<redacted>"
TOKEN_HEADER_NAME = b"x-andes-token"


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


def make_token_redaction_middleware(app: ASGIApp) -> ASGIApp:
    """Replace the value of the ``X-Andes-Token`` header with ``<redacted>``
    in the request scope before any downstream handler/log/exception sees it.

    Auth itself is performed by the FastAPI dependency (``api.auth``), which
    runs in a separate code path that captures the token from the *original*
    headers list before the redaction middleware swaps the value. Concretely,
    the auth dep reads from the inbound scope headers; the redaction
    middleware mutates them in place after the auth dep has run? — that
    ordering is not safe. Instead, this middleware reads the real token,
    saves it into ``scope["state"]["andes_token"]``, replaces the header
    value with ``<redacted>``, and the auth dep reads from
    ``scope["state"]["andes_token"]`` instead of the headers list. See
    ``api.auth`` for the consumer side.
    """

    async def _app(scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
        if scope.get("type") not in ("http", "websocket"):
            await app(scope, receive, send)
            return

        headers: list[tuple[bytes, bytes]] = list(scope.get("headers", []))
        new_headers: list[tuple[bytes, bytes]] = []
        captured_token: str | None = None
        for name, value in headers:
            if name.lower() == TOKEN_HEADER_NAME:
                if captured_token is None:
                    captured_token = value.decode("latin-1")
                new_headers.append((name, REDACTED))
            else:
                new_headers.append((name, value))
        scope["headers"] = new_headers
        # Stash the real token in the scope's state for the auth dep to read.
        scope.setdefault("state", {})["andes_token"] = captured_token
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
