"""Authentication dependency.

The token-redaction ASGI middleware (``security.middleware``) captures the
``X-Andes-Token`` header value from the inbound scope and stashes it under
``scope["state"]["andes_token"]`` before any FastAPI handler runs. The auth
dependency reads from there — by the time it executes, the header in the
scope has already been swapped to the redaction sentinel, so anything that
later prints the headers (logs, exception handlers) sees only ``<redacted>``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from andes_app.security.token import constant_time_eq


def _expected_token_from_app(request: Request) -> str:
    token = getattr(request.app.state, "expected_token", None)
    if token is None:
        # The CLI is responsible for installing the token at app startup; if
        # we got here without one, that's a configuration bug, not a
        # client-facing 401. Surface as 500.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="server is not configured with an authentication token",
        )
    return str(token)


def _supplied_token_from_scope(request: Request) -> str | None:
    state = request.scope.get("state") or {}
    val = state.get("andes_token")
    return str(val) if isinstance(val, str) else None


async def require_token(request: Request) -> None:
    """FastAPI dependency. Raises 401 if the inbound request did not carry a
    valid ``X-Andes-Token`` header.

    When the app was built with ``require_auth=False`` (the ``serve --no-auth``
    dev toggle), this is a no-op: the dependency stays wired on every route so
    the auth contract and OpenAPI security scheme are preserved, but the token
    is not enforced. Auth is on by default; ``--no-auth`` is opt-in and
    loopback-only. The Host/Origin ASGI middleware still runs regardless, so
    this does not open the substrate to cross-origin callers.
    """
    if not getattr(request.app.state, "require_auth", True):
        return
    expected = _expected_token_from_app(request)
    supplied = _supplied_token_from_scope(request)
    if supplied is None or not constant_time_eq(expected, supplied):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid X-Andes-Token header",
        )


# Annotated alias for use in route signatures
RequireToken = Annotated[None, Depends(require_token)]
