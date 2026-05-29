"""Dev serve toggles — the ``require_auth`` gate on ``require_token``.

``serve --no-auth`` builds the app with ``require_auth=False``, which makes the
``require_token`` dependency a no-op while leaving it wired on every route (the
auth structure + OpenAPI security scheme are preserved). Auth is ON by default;
these tests pin both behaviours so the toggle can't silently invert.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from andes_app.api.auth import require_token


def _request(*, require_auth: bool, supplied_token: str | None, expected: str) -> Any:
    """Minimal stand-in for the bits of ``Request`` that ``require_token`` reads."""
    app = SimpleNamespace(state=SimpleNamespace(require_auth=require_auth, expected_token=expected))
    scope = {"state": {"andes_token": supplied_token}}
    return SimpleNamespace(app=app, scope=scope)


def test_no_auth_bypasses_token_check_even_without_a_token() -> None:
    # require_auth=False -> dependency returns without raising, no token needed.
    req = _request(require_auth=False, supplied_token=None, expected="real-token")
    assert asyncio.run(require_token(req)) is None


def test_auth_on_rejects_missing_token() -> None:
    req = _request(require_auth=True, supplied_token=None, expected="real-token")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(require_token(req))
    assert ei.value.status_code == 401


def test_auth_on_rejects_wrong_token() -> None:
    req = _request(require_auth=True, supplied_token="wrong", expected="real-token")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(require_token(req))
    assert ei.value.status_code == 401


def test_auth_on_accepts_valid_token() -> None:
    req = _request(require_auth=True, supplied_token="real-token", expected="real-token")
    assert asyncio.run(require_token(req)) is None


def test_default_state_requires_auth() -> None:
    # An app.state without an explicit require_auth attr defaults to auth-on
    # (getattr default True), so a missing flag never silently disables auth.
    app = SimpleNamespace(state=SimpleNamespace(expected_token="real-token"))
    req = SimpleNamespace(app=app, scope={"state": {"andes_token": None}})
    with pytest.raises(HTTPException) as ei:
        asyncio.run(require_token(req))
    assert ei.value.status_code == 401
