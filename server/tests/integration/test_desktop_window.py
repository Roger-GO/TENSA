"""``tensa desktop`` against the real server and a real worker.

pywebview is replaced by a module whose ``start`` stands in for the window: it
makes the requests the page would, from the origin the page has, while the server
is up, and its returning is the window closing. What the unit tests cannot show
is checked here: the server thread really serves on the port the window was given,
the window's own origin passes the Host/Origin check, and closing the window
leaves neither a listener nor a worker process behind, and does so without waiting
out uvicorn's graceful-shutdown timeout for the page's open WebSocket.
"""

from __future__ import annotations

import contextlib
import json
import logging
import multiprocessing
import socket
import sys
import types
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import ClientConnection, connect

from tensa import cli
from tensa.core.logging_setup import reset_logging
from tensa.desktop import WindowSupport

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _a_window_can_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """A headless Linux machine has no display, which the command would refuse."""
    monkeypatch.setattr(cli, "check_window_support", lambda: WindowSupport())


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    root = logging.getLogger()
    level = root.level
    yield
    reset_logging()
    root.setLevel(level)


def _lowered(headers: Any) -> dict[str, str]:
    return {name.lower(): value for name, value in headers.items()}


def _call(method: str, url: str, origin: str) -> tuple[int, dict[str, Any], dict[str, str]]:
    """A request as the page makes it: with the origin it was loaded from."""
    request = urllib.request.Request(
        url, data=b"" if method == "POST" else None, method=method, headers={"Origin": origin}
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, json.loads(response.read()), _lowered(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, {}, _lowered(exc.headers)


class _Window(types.ModuleType):
    """What the user would do in the window: load the page's API, start a session."""

    def __init__(self) -> None:
        super().__init__("webview")
        self.settings = {"ALLOW_DOWNLOADS": False}
        self.url = ""
        self.health: tuple[int, dict[str, Any], dict[str, str]] | None = None
        self.foreign: tuple[int, dict[str, Any], dict[str, str]] | None = None
        self.session: tuple[int, dict[str, Any], dict[str, str]] | None = None
        self.workers_while_open: list[int] = []
        # The page keeps one of these open for as long as its session lives.
        self.events: ClientConnection | None = None
        self.sockets = contextlib.ExitStack()

    def create_window(self, title: str, url: str, **_kwargs: Any) -> None:
        self.url = url

    def start(self, **_kwargs: Any) -> None:
        base = self.url.rstrip("/")
        self.health = _call("GET", f"{base}/api/health", base)
        self.foreign = _call("GET", f"{base}/api/health", "http://127.0.0.1:1")
        self.session = _call("POST", f"{base}/api/sessions", base)
        self.workers_while_open = [p.pid for p in multiprocessing.active_children() if p.pid]
        assert self.session[0] in {200, 201}
        port = self.url.rsplit(":", 1)[1].rstrip("/")
        events = self.sockets.enter_context(
            connect(
                f"ws://127.0.0.1:{port}/api/ws/{self.session[1]['session_id']}/jobs/events",
                origin=base,
            )
        )
        assert json.loads(events.recv(timeout=30))["type"] == "ready"
        self.events = events


def test_the_window_reaches_the_server_and_closing_it_leaves_nothing_running(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    request: pytest.FixtureRequest,
) -> None:
    window = _Window()
    monkeypatch.setitem(sys.modules, "webview", window)
    # The test's end closes the socket the "page" opened, whatever happens before.
    request.addfinalizer(window.sockets.close)
    before = {p.pid for p in multiprocessing.active_children()}

    with caplog.at_level("INFO"):
        result = CliRunner().invoke(
            cli.app,
            ["desktop", "--workspace", str(tmp_path / "ws"), "--no-warm-cache"],
        )
    assert result.exit_code == 0, result.output

    # The window was given a loopback address, and the page's own origin passed.
    assert window.url.startswith("http://127.0.0.1:")
    assert window.health is not None and window.health[0] == 200
    assert window.health[1]["status"] == "ok"
    # The page cannot be put in a frame of another page, the window is no frame.
    assert window.health[2]["x-frame-options"] == "DENY"
    # An origin of another port is still turned away.
    assert window.foreign is not None and window.foreign[0] == 400
    # A session started from the window has a worker process of its own...
    assert window.session is not None and window.session[0] in {200, 201}
    started = set(window.workers_while_open) - before
    assert started, "no worker was started"

    # ...which is gone, with the listener, once the window has closed. Another
    # test's leftovers are not this test's to judge, so only the new ones count.
    assert not {p.pid for p in multiprocessing.active_children()} & started
    port = int(window.url.rsplit(":", 1)[1].rstrip("/"))
    with socket.socket() as probe, pytest.raises(OSError):
        probe.settimeout(2)
        probe.connect(("127.0.0.1", port))

    # The page's WebSocket was ended by closing its session (4404), not cut off when
    # uvicorn ran out of patience, which logs an error and takes its whole timeout.
    assert window.events is not None
    with pytest.raises(ConnectionClosed) as closed:
        while True:
            window.events.recv(timeout=10)
    assert closed.value.rcvd is not None and closed.value.rcvd.code == 4404
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors == []
