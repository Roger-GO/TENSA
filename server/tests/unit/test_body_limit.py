"""A body that is too large is refused before it is read.

``tensa.api.body_limit`` gives the route class. These drive a small app, and
the two routes that use it, through ASGI by hand, so the test sees how much of
the body the server asked for before it answered.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import APIRouter, FastAPI
from pydantic import BaseModel

from tensa.api.app import make_app
from tensa.api.body_limit import body_limited_route, json_number_bytes
from tensa.api.routes import comtrade as comtrade_route
from tensa.api.routes import metrics as metrics_route
from tensa.api.schemas import MAX_COMTRADE_VALUES, MAX_METRIC_SAMPLES_TOTAL

pytestmark = pytest.mark.unit

CAP = 64


class _Numbers(BaseModel):
    values: list[float]


def _app() -> FastAPI:
    router = APIRouter(route_class=body_limited_route(CAP, "a list of numbers"))

    @router.post("/sum")
    async def total(body: _Numbers) -> dict[str, float]:
        return {"sum": sum(body.values)}

    app = FastAPI()
    app.include_router(router)
    return app


async def _call(
    app: Any,
    path: str,
    chunks: list[bytes],
    *,
    declare: bool = True,
    content_length: int | None = None,
) -> tuple[int, dict[str, Any], int]:
    """POST ``chunks`` to ``path``; returns the status, the JSON answer, and how
    many of the chunks the server asked for."""
    headers = [(b"host", b"127.0.0.1:8000"), (b"content-type", b"application/json")]
    if declare:
        length = sum(len(c) for c in chunks) if content_length is None else content_length
        headers.append((b"content-length", str(length).encode()))
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
        "root_path": "", "headers": headers, "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8000),
    }
    asked = 0

    async def receive() -> dict[str, Any]:
        nonlocal asked
        if asked >= len(chunks):
            return {"type": "http.disconnect"}
        chunk = chunks[asked]
        asked += 1
        return {"type": "http.request", "body": chunk, "more_body": asked < len(chunks)}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await app(scope, receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, json.loads(raw) if raw else {}, asked


def _body(n: int) -> bytes:
    return json.dumps({"values": [1.5] * n}).encode()


async def test_a_body_within_the_cap_reaches_the_route() -> None:
    body = _body(8)
    assert len(body) <= CAP
    status, answer, asked = await _call(_app(), "/sum", [body])
    assert (status, answer, asked) == (200, {"sum": 12.0}, 1)


async def test_a_declared_length_over_the_cap_is_refused_before_a_byte_is_read() -> None:
    body = _body(40)
    assert len(body) > CAP
    status, answer, asked = await _call(_app(), "/sum", [body])
    assert status == 413
    assert asked == 0
    assert answer["detail"] == "the body of a list of numbers is larger than 0 MiB"


async def test_a_length_that_is_declared_is_believed_whatever_follows() -> None:
    """The header alone decides: nothing is read to find out it was wrong."""
    status, _answer, asked = await _call(_app(), "/sum", [_body(2)], content_length=10**12)
    assert (status, asked) == (413, 0)


async def test_a_body_sent_without_a_length_is_counted_as_it_arrives() -> None:
    body = _body(40)
    chunks = [body[i : i + 20] for i in range(0, len(body), 20)]
    assert len(chunks) > 5
    status, _answer, asked = await _call(_app(), "/sum", chunks, declare=False)
    assert status == 413
    # Refused on the chunk that took it past the cap, with the rest unread.
    assert asked == CAP // 20 + 1 < len(chunks)


async def test_a_body_sent_without_a_length_within_the_cap_reaches_the_route() -> None:
    body = _body(8)
    chunks = [body[:10], body[10:30], body[30:]]
    status, answer, asked = await _call(_app(), "/sum", chunks, declare=False)
    assert (status, answer, asked) == (200, {"sum": 12.0}, 3)


async def test_a_body_the_model_refuses_is_still_a_422() -> None:
    status, _answer, _asked = await _call(_app(), "/sum", [b'{"values": "many"}'])
    assert status == 422


def test_no_body_within_a_cap_on_numbers_is_over_the_cap_on_bytes() -> None:
    # The longest a double is in JSON, as Python and as a browser write it,
    # with the separator Python's ``json.dumps`` puts after it.
    longest = json.dumps(-1.2345678901234567e-100)
    assert len(longest) == 24
    assert json_number_bytes(1000) >= 1000 * (len(longest) + len(", "))
    # The rest of a body (names, units, settings) has room too.
    assert json_number_bytes(0) >= 1024 * 1024


def test_the_routes_caps_follow_from_what_they_take() -> None:
    # A COMTRADE export: the values, and with one channel as many times.
    assert json_number_bytes(2 * MAX_COMTRADE_VALUES) == comtrade_route.MAX_COMTRADE_BYTES
    # Response metrics: a time and a value per sample.
    assert json_number_bytes(2 * MAX_METRIC_SAMPLES_TOTAL) == metrics_route.MAX_METRICS_BYTES


@pytest.mark.parametrize(
    ("path", "cap", "what"),
    [
        ("/api/comtrade", comtrade_route.MAX_COMTRADE_BYTES, "a COMTRADE export"),
        ("/api/response-metrics", metrics_route.MAX_METRICS_BYTES, "a response-metrics request"),
    ],
)
async def test_the_two_routes_that_take_long_series_refuse_an_oversized_body_unread(
    tmp_path: Path, path: str, cap: int, what: str
) -> None:
    app = make_app(workspace=tmp_path, static_override=tmp_path)
    status, answer, asked = await _call(app, path, [b"{}"], content_length=cap + 1)
    assert status == 413
    assert asked == 0
    assert answer["status"] == 413
    assert answer["detail"] == f"the body of {what} is larger than {cap // (1024 * 1024)} MiB"

    # One byte less is read, and then judged for what it holds.
    status, _answer, asked = await _call(app, path, [b"{}"], content_length=cap)
    assert (status, asked) == (422, 1)
