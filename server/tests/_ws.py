"""Opening a WebSocket on Starlette's ``TestClient``, and leaving it in order.

``client.websocket_connect(...)`` runs the route in a task of the client's event
loop, and leaving its ``with`` block does three things in a row without waiting in
between: it sends the disconnect, cancels the task, and takes the task's result.
Where the cancellation finds the route is then a matter of timing: before it has
read the disconnect, half-way through putting its own tasks away, or after it has
returned. A test that leaves that way tests a different ending of the route from
one run to the next, and a route that mishandles a cancellation at one of those
points fails now and then, or nearly every time on a machine with one core (the
job-event feed did both).

``websocket_session`` opens the same socket and leaves it one step at a time: it
closes the socket, as a client that goes away does, waits until the route has
returned of its own accord, and only then lets the client take the task down, when
nothing of the route is left to cancel. A route that does not return once its
client has gone fails the test that opened it, and the failure says so.

``tests/unit/test_ws_sessions.py`` holds the helper to that, and the suite to
opening its sockets nowhere else.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Iterator
from typing import Any

from starlette.testclient import TestClient, WebSocketTestSession
from starlette.types import Receive, Scope, Send

# How long a route gets to return once its socket is closed. The job-event feed
# returns within a few turns of the event loop; a route that streams a run does
# not read its socket meanwhile and returns when the run ends. The bound is what
# makes a route that never returns a failed test and not a suite that hangs.
ROUTE_END_TIMEOUT = 60.0


@contextlib.contextmanager
def websocket_session(
    client: TestClient,
    url: str,
    *,
    route_end_timeout: float = ROUTE_END_TIMEOUT,
    **kwargs: Any,
) -> Iterator[WebSocketTestSession]:
    """``client.websocket_connect(url, **kwargs)``, left only once the route has
    returned.

    Use it as the client's own method is used. A connection the app refuses raises
    from the ``with`` line as it does there, and an exception in the block leaves at
    once, without the wait, so a failed assertion is reported as itself.
    """
    session = client.websocket_connect(url, **kwargs)
    returned = threading.Event()
    app = session.app

    async def watched(scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await app(scope, receive, send)
        finally:
            returned.set()

    # The session calls its ``app`` when it is entered, in the client's event loop.
    session.app = watched
    with session:
        yield session
        session.close()
        if not returned.wait(route_end_timeout):
            raise AssertionError(
                f"the route of {url} had not returned {route_end_timeout:g} s after "
                "its socket was closed"
            )
