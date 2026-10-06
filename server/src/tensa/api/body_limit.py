"""Refusing a request body that is too large before it is read.

FastAPI reads a JSON body whole, parses it and checks it against the route's
model, all on the event loop, before the route (or any dependency of it) runs.
A route that counts what its body holds can therefore only answer 413 once the
server has stood still for as long as the body took, and every other request
and every live stream stood still with it. :func:`body_limited_route` gives a
route class that looks at the size first: a declared ``Content-Length`` over
the cap is refused before a byte is read, and a body sent without one (chunked)
is counted as it arrives and refused the moment it passes the cap.

The cap is in bytes because that is all there is to go by before parsing.
:func:`json_number_bytes` turns a route's own cap on how many numbers it takes
into one with room to spare: a body within the first, written the way a client
writes JSON, is not over the second, so the byte cap refuses what the route
would have refused after reading it.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import HTTPException, Request, Response, status
from fastapi.routing import APIRoute
from starlette.types import Message

# The most one number takes in a JSON body: a double written in full is 24
# characters ("-1.2345678901234567e-100"), and the rest is its separator and
# the white space a pretty-printing client puts around it.
_BYTES_PER_NUMBER = 32

# Room for what is not numbers: the names, the units, the settings.
_OTHER_BYTES = 1024 * 1024


def json_number_bytes(numbers: int) -> int:
    """The size, in bytes, that a JSON body holding ``numbers`` numbers stays under."""
    return numbers * _BYTES_PER_NUMBER + _OTHER_BYTES


def body_limited_route(max_bytes: int, what: str) -> type[APIRoute]:
    """A route class for ``APIRouter(route_class=...)`` whose routes refuse a
    body over ``max_bytes`` with 413 before it is read. ``what`` names the body
    in the refusal ("a COMTRADE export")."""
    megabytes = max_bytes // (1024 * 1024)

    def too_large() -> HTTPException:
        return HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"the body of {what} is larger than {megabytes} MiB",
        )

    class BodyLimitedRoute(APIRoute):
        def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
            handler = super().get_route_handler()

            async def limited(request: Request) -> Response:
                declared = request.headers.get("content-length", "")
                if declared.isdigit() and int(declared) > max_bytes:
                    raise too_large()
                received = 0
                receive = request.receive

                async def counted() -> Message:
                    nonlocal received
                    message = await receive()
                    if message["type"] == "http.request":
                        received += len(message.get("body", b""))
                        if received > max_bytes:
                            raise too_large()
                    return message

                return await handler(Request(request.scope, counted))

            return limited

    return BodyLimitedRoute


__all__ = ["body_limited_route", "json_number_bytes"]
