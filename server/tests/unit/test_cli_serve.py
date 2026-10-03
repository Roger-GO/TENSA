"""``tensa serve`` CLI wiring (no ANDES, no real server).

The bug these cover: ``--port 0`` (the default) used to build the app with
``bind_port=0`` before uvicorn bound the real port, so the Host/Origin
allow-list held only port-less origins and the SPA's
``Origin: http://127.0.0.1:<real port>`` was rejected with ``400 bad-origin``.
``serve`` now binds the socket first, builds the app from the real port, and
hands uvicorn that same socket.

uvicorn's ``Server`` is replaced by a fake that records what it was given, so
the tests exercise ``serve``'s wiring without a listening server.
"""

from __future__ import annotations

import os
import socket
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from typer.testing import CliRunner

from tensa import cli
from tensa.api.app import make_app

pytestmark = pytest.mark.unit

runner = CliRunner()


class _FakeServer:
    """Stands in for ``uvicorn.Server``: records ``run(sockets=...)`` and, like
    a server that came up, flips ``started`` unless told not to."""

    instances: list[_FakeServer] = []
    start_ok = True

    def __init__(self, config: Any) -> None:
        self.config = config
        self.started = False
        self.sockets: list[socket.socket] | None = None
        self.bound_port_during_run: int | None = None
        _FakeServer.instances.append(self)

    def run(self, sockets: list[socket.socket] | None = None) -> None:
        self.sockets = sockets
        if sockets:
            self.bound_port_during_run = int(sockets[0].getsockname()[1])
        self.started = type(self).start_ok


@pytest.fixture
def fake_server(monkeypatch: pytest.MonkeyPatch) -> type[_FakeServer]:
    _FakeServer.instances = []
    _FakeServer.start_ok = True
    monkeypatch.setattr(cli.uvicorn, "Server", _FakeServer)
    # Seeding copies ANDES example files into the workspace; irrelevant here.
    monkeypatch.setattr(cli, "seed_example_cases", lambda _ws: [])
    return _FakeServer


@pytest.fixture
def built_apps(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Spy on ``make_app``: record each call's kwargs, build the real app."""
    calls: list[dict[str, Any]] = []

    def _spy(**kwargs: Any) -> FastAPI:
        app = make_app(**kwargs)
        calls.append({"kwargs": kwargs, "app": app})
        return app

    monkeypatch.setattr(cli, "make_app", _spy)
    return calls


def _get(app: FastAPI, port: int, origin: str | None) -> int:
    """GET ``/openapi.json`` (needs no session state) as a browser on ``port``."""
    headers = {"Origin": origin} if origin is not None else {}
    client = TestClient(app, base_url=f"http://127.0.0.1:{port}")
    return client.get("/openapi.json", headers=headers).status_code


# ------------------------------------------------------- bind + socket options


def test_bind_listen_socket_resolves_port_zero_to_a_real_port() -> None:
    sock = cli._bind_listen_socket("127.0.0.1", 0)
    try:
        port = int(sock.getsockname()[1])
        assert port > 0
        # The port is held by this socket, so nothing else can take it while
        # the app is being built.
        rival = socket.socket()
        try:
            with pytest.raises(OSError):
                rival.bind(("127.0.0.1", port))
        finally:
            rival.close()
    finally:
        sock.close()


def test_bind_listen_socket_raises_when_port_is_taken() -> None:
    holder = socket.socket()
    try:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        taken = int(holder.getsockname()[1])
        with pytest.raises(OSError):
            cli._bind_listen_socket("127.0.0.1", taken)
    finally:
        holder.close()


class _RecordingSocket:
    def __init__(self) -> None:
        self.options: list[tuple[int, int, int]] = []

    def setsockopt(self, level: int, optname: int, value: int) -> None:
        self.options.append((level, optname, value))


def test_bind_options_use_reuseaddr_on_posix() -> None:
    sock = _RecordingSocket()
    cli._apply_bind_options(sock, platform="linux")  # type: ignore[arg-type]
    assert sock.options == [(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)]


def test_bind_options_use_exclusive_addr_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The constant only exists on Windows; fake it so the branch runs here.
    monkeypatch.setattr(socket, "SO_EXCLUSIVEADDRUSE", -5, raising=False)
    sock = _RecordingSocket()
    cli._apply_bind_options(sock, platform="win32")  # type: ignore[arg-type]
    assert sock.options == [(socket.SOL_SOCKET, -5, 1)]
    # Never SO_REUSEADDR on Windows: it would let another process share the port.
    assert all(opt[1] != socket.SO_REUSEADDR for opt in sock.options)


def test_bind_options_set_nothing_on_windows_without_exclusive_addr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(socket, "SO_EXCLUSIVEADDRUSE", raising=False)
    sock = _RecordingSocket()
    cli._apply_bind_options(sock, platform="win32")  # type: ignore[arg-type]
    assert sock.options == []


# ------------------------------------------------------------- serve wiring


def test_serve_builds_the_app_with_the_real_bound_port(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0"]
    )
    assert result.exit_code == 0, result.output

    (server,) = fake_server.instances
    assert server.sockets is not None and len(server.sockets) == 1
    port = server.bound_port_during_run
    assert port is not None and port > 0

    # The app, uvicorn's config, and the socket uvicorn serves on agree.
    (built,) = built_apps
    assert built["kwargs"]["bind_port"] == port
    assert server.config.port == port

    # The SPA's real origin is accepted; a different port still is not.
    app = built["app"]
    assert _get(app, port, f"http://127.0.0.1:{port}") == 200
    assert _get(app, port, f"http://localhost:{port}") == 200
    assert _get(app, port, f"http://127.0.0.1:{port + 1}") == 400


def test_serve_exits_3_without_building_the_app_when_the_port_is_taken(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    holder = socket.socket()
    try:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        taken = int(holder.getsockname()[1])
        result = runner.invoke(
            cli.app,
            ["serve", "--workspace", str(tmp_path / "ws"), "--port", str(taken)],
        )
    finally:
        holder.close()
    assert result.exit_code == 3
    assert built_apps == []
    assert fake_server.instances == []


def test_serve_exits_3_when_the_server_never_starts(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    fake_server.start_ok = False
    result = runner.invoke(
        cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0"]
    )
    assert result.exit_code == 3


def test_serve_open_browser_works_with_port_zero(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    opened: list[str] = []
    done = threading.Event()

    def _open(url: str, new: int = 0) -> bool:
        opened.append(url)
        done.set()
        return True

    monkeypatch.setattr(cli.webbrowser, "open", _open)
    result = runner.invoke(
        cli.app,
        ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0", "--open"],
    )
    assert result.exit_code == 0, result.output
    assert done.wait(5.0), "browser was not opened"
    port = fake_server.instances[0].bound_port_during_run
    assert port is not None and port > 0
    assert opened == [f"http://127.0.0.1:{port}/"]


def test_serve_reload_resolves_port_zero_for_the_app_factory(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
) -> None:
    run_kwargs: dict[str, Any] = {}
    monkeypatch.setattr(cli.uvicorn, "run", lambda *a, **kw: run_kwargs.update(kw))
    with mock.patch.dict(os.environ):
        result = runner.invoke(
            cli.app,
            [
                "serve",
                "--workspace",
                str(tmp_path / "ws"),
                "--port",
                "0",
                "--reload",
            ],
        )
        assert result.exit_code == 0, result.output
        port = run_kwargs["port"]
        assert port > 0
        assert os.environ["ANDES_APP_RELOAD_PORT"] == str(port)
        # The reloader's subprocess builds the app from those env vars.
        app = cli._reload_app_factory()
    assert _get(app, port, f"http://127.0.0.1:{port}") == 200


def test_serve_prints_the_real_url(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("INFO", logger="tensa.serve"):
        result = runner.invoke(
            cli.app, ["serve", "--workspace", str(tmp_path / "ws"), "--port", "0"]
        )
    assert result.exit_code == 0, result.output
    port = fake_server.instances[0].bound_port_during_run
    assert f"serving http://127.0.0.1:{port}/" in caplog.text
    assert "os-assigned" not in caplog.text


# ------------------------------------------------------------ open watcher


def _watch(
    is_ready: Callable[[], bool], **kwargs: Any
) -> tuple[threading.Thread, list[str]]:
    opened: list[str] = []
    log = mock.Mock()
    with mock.patch.object(cli.webbrowser, "open", lambda url, new=0: opened.append(url)):
        thread = cli._spawn_open_browser_watcher(
            url="http://127.0.0.1:1234/",
            is_ready=is_ready,
            log=log,
            poll_interval=0.001,
            **kwargs,
        )
        thread.join(5.0)
    assert not thread.is_alive()
    return thread, opened


def test_open_watcher_opens_once_ready() -> None:
    polls = iter([False, False, True])
    _, opened = _watch(lambda: next(polls))
    assert opened == ["http://127.0.0.1:1234/"]


def test_open_watcher_gives_up_at_the_deadline() -> None:
    _, opened = _watch(lambda: False, deadline_seconds=0.05)
    assert opened == []


def test_accepts_connections_probe() -> None:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
        assert cli._accepts_connections("127.0.0.1", port) is False  # not listening
        sock.listen()
        assert cli._accepts_connections("127.0.0.1", port) is True
    finally:
        sock.close()
