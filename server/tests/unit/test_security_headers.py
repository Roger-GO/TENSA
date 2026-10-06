"""Every HTTP response carries the browser security headers.

``X-Frame-Options`` and ``frame-ancestors`` keep another page from framing the UI
(clickjacking), ``nosniff`` keeps a browser from reading a response as a type it was
not sent as, and ``Referrer-Policy`` keeps the address out of the ``Referer`` of a
link followed from it. The middleware is pure ASGI, wrapped outside the Host/Origin
check so that its rejections are stamped too.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from tensa.api.app import make_app
from tensa.security.middleware import SECURITY_HEADERS, make_security_headers_middleware

pytestmark = pytest.mark.unit

EXPECTED = {
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
}


def _has_all(headers: Any) -> bool:
    return all(headers.get(name) == value for name, value in EXPECTED.items())


def test_the_headers_are_the_four_the_policy_names() -> None:
    assert {n.decode(): v.decode() for n, v in SECURITY_HEADERS} == EXPECTED


# ---- the middleware on its own ------------------------------------------------


async def _run(scope: dict[str, Any], messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Wrap an app that sends ``messages``, call it with ``scope``, and return what
    reached the server."""
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        for message in messages:
            await send(message)

    await make_security_headers_middleware(inner)(scope, receive, send)
    return sent


def _response(headers: list[tuple[bytes, bytes]]) -> list[dict[str, Any]]:
    return [
        {"type": "http.response.start", "status": 200, "headers": headers},
        {"type": "http.response.body", "body": b"ok", "more_body": False},
    ]


async def test_it_adds_the_headers_and_keeps_the_ones_the_response_has() -> None:
    sent = await _run({"type": "http"}, _response([(b"content-type", b"text/plain")]))
    start, body = sent
    assert start["status"] == 200
    assert (b"content-type", b"text/plain") in start["headers"]
    assert all(pair in start["headers"] for pair in SECURITY_HEADERS)
    assert body == {"type": "http.response.body", "body": b"ok", "more_body": False}


async def test_it_leaves_a_header_the_response_already_sets() -> None:
    """A route that needs another policy sets its own, in any letter case."""
    own = (b"Content-Security-Policy", b"frame-ancestors 'self'")
    (start, _body) = await _run({"type": "http"}, _response([own]))
    policies = [v for n, v in start["headers"] if n.lower() == b"content-security-policy"]
    assert policies == [b"frame-ancestors 'self'"]
    # The other three are still added.
    names = {n.lower() for n, _ in start["headers"]}
    assert {b"x-frame-options", b"x-content-type-options", b"referrer-policy"} <= names


async def test_it_does_not_touch_a_websocket() -> None:
    accept = {"type": "websocket.accept", "headers": [(b"a", b"b")]}
    (sent,) = await _run({"type": "websocket"}, [accept])
    assert sent is accept


# ---- through the app ----------------------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
    app = make_app(workspace=tmp_path, bind_port=8000, static_override=static)
    return TestClient(app, base_url="http://127.0.0.1:8000")


@pytest.mark.parametrize("path", ["/openapi.json", "/api/version", "/", "/case/anything"])
def test_a_response_carries_the_headers(client: TestClient, path: str) -> None:
    response = client.get(path)
    assert response.status_code == 200
    assert _has_all(response.headers)


def test_an_error_carries_them(client: TestClient) -> None:
    response = client.get("/api/nothing-here")
    assert response.status_code == 404
    assert _has_all(response.headers)


def test_a_rejected_host_carries_them(client: TestClient) -> None:
    response = client.get("/api/version", headers={"Host": "evil.example"})
    assert response.status_code == 400
    assert _has_all(response.headers)


def test_a_rejected_origin_carries_them(client: TestClient) -> None:
    response = client.get("/api/version", headers={"Origin": "http://evil.example"})
    assert response.status_code == 400
    assert _has_all(response.headers)


def test_a_cors_preflight_carries_them(client: TestClient) -> None:
    response = client.options(
        "/api/version",
        headers={
            "Origin": "http://127.0.0.1:8000",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert _has_all(response.headers)
