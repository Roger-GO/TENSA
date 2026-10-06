"""``tensa desktop`` CLI wiring (no window, no real server).

pywebview is replaced by a fake module that records what it is asked to do, and
uvicorn's ``Server`` by one that runs in the thread ``run_window`` gives it, comes
up when asked to, and stops when ``should_exit`` is set. What is checked is the
order of events: the server listens before the window opens, and is stopped when
the window has closed, however it closed.
"""

from __future__ import annotations

import asyncio
import logging
import socket
import sys
import threading
import types
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
import typer.main
from fastapi import FastAPI
from starlette.testclient import TestClient
from typer.testing import CliRunner

from tensa import cli, desktop
from tensa.api.app import make_app
from tensa.core.logging_setup import reset_logging

pytestmark = pytest.mark.unit

runner = CliRunner()


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """``desktop`` configures the root logger, which outlives the test that ran it."""
    root = logging.getLogger()
    level = root.level
    yield
    reset_logging()
    root.setLevel(level)


class _FakeServer:
    """Stands in for ``uvicorn.Server``: ``serve`` flips ``started`` (unless told not
    to) and returns once ``should_exit`` is set, as uvicorn's does."""

    instances: list[_FakeServer] = []
    comes_up = True
    # How long ``run`` takes to stop after ``should_exit``.
    stop_delay = 0.0

    def __init__(self, config: Any) -> None:
        self.config = config
        self.started = False
        self.should_exit = False
        self.sockets: list[socket.socket] | None = None
        self.port_during_run: int | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.ended = threading.Event()
        _FakeServer.instances.append(self)

    async def serve(self, sockets: list[socket.socket] | None = None) -> None:
        self.sockets = sockets
        self.loop = asyncio.get_running_loop()
        if sockets:
            self.port_during_run = int(sockets[0].getsockname()[1])
        if not type(self).comes_up:
            self.ended.set()
            return
        self.started = True
        while not self.should_exit:
            await asyncio.sleep(0.002)
        await asyncio.sleep(type(self).stop_delay)
        self.ended.set()


class _FakeWarm:
    def __init__(self) -> None:
        self.stopped = False

    def stop(self) -> None:
        self.stopped = True


class _FakeWebview(types.ModuleType):
    """Stands in for ``webview``: records the window it is asked for and, in
    ``start``, what state the server was in while the window was open."""

    def __init__(self) -> None:
        super().__init__("webview")
        self.settings: dict[str, Any] = {"ALLOW_DOWNLOADS": False}
        self.windows: list[dict[str, Any]] = []
        self.starts: list[dict[str, Any]] = []
        self.server_state_while_open: tuple[bool, bool] | None = None
        self.downloads_while_open: bool | None = None
        self.on_start: Callable[[], None] | None = None
        self.start_error: Exception | None = None

    def create_window(self, title: str, url: str, **kwargs: Any) -> None:
        self.windows.append({"title": title, "url": url, **kwargs})

    def start(self, **kwargs: Any) -> None:
        self.starts.append(kwargs)
        server = _FakeServer.instances[-1]
        self.server_state_while_open = (server.started, server.should_exit)
        self.downloads_while_open = self.settings["ALLOW_DOWNLOADS"]
        if self.on_start is not None:
            self.on_start()
        if self.start_error is not None:
            raise self.start_error


@pytest.fixture
def warm_starts(monkeypatch: pytest.MonkeyPatch) -> list[_FakeWarm]:
    started: list[_FakeWarm] = []

    def _start(andes_version: str, log: Any) -> _FakeWarm:
        started.append(_FakeWarm())
        return started[-1]

    monkeypatch.setattr(cli, "start_background_warm", _start)
    return started


@pytest.fixture
def fake_server(
    monkeypatch: pytest.MonkeyPatch, warm_starts: list[_FakeWarm]
) -> type[_FakeServer]:
    _FakeServer.instances = []
    _FakeServer.comes_up = True
    _FakeServer.stop_delay = 0.0
    monkeypatch.setattr(cli.uvicorn, "Server", _FakeServer)
    monkeypatch.setattr(cli, "seed_example_cases", lambda _ws: [])
    return _FakeServer


@pytest.fixture
def webview(monkeypatch: pytest.MonkeyPatch) -> _FakeWebview:
    fake = _FakeWebview()
    monkeypatch.setitem(sys.modules, "webview", fake)
    return fake


@pytest.fixture
def built_apps(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def _spy(**kwargs: Any) -> FastAPI:
        app = make_app(**kwargs)
        calls.append({"kwargs": kwargs, "app": app})
        return app

    monkeypatch.setattr(cli, "make_app", _spy)
    return calls


@pytest.fixture
def freeze_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    monkeypatch.setattr(cli.multiprocessing, "freeze_support", lambda: calls.append("freeze"))
    return calls


def _desktop(tmp_path: Path, *args: str) -> Any:
    return runner.invoke(cli.app, ["desktop", "--workspace", str(tmp_path / "ws"), *args])


def _get(app: FastAPI, port: int, origin: str | None) -> int:
    headers = {"Origin": origin} if origin is not None else {}
    client = TestClient(app, base_url=f"http://127.0.0.1:{port}")
    return client.get("/openapi.json", headers=headers).status_code


# ----------------------------------------------------------- the window


def test_desktop_serves_on_a_free_loopback_port_and_opens_a_window_on_it(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    built_apps: list[dict[str, Any]],
) -> None:
    result = _desktop(tmp_path)
    assert result.exit_code == 0, result.output

    (server,) = fake_server.instances
    port = server.port_during_run
    assert port is not None and port > 0
    assert server.sockets is not None and len(server.sockets) == 1
    assert server.config.host == "127.0.0.1"
    assert server.config.port == port

    # What the window loads is the page of the server that is listening.
    (window,) = webview.windows
    assert window["url"] == f"http://127.0.0.1:{port}/"
    assert window["title"] == "TENSA"
    assert (window["width"], window["height"]) == (1280, 800)
    assert window["min_size"] == (desktop.MIN_WIDTH, desktop.MIN_HEIGHT)
    assert webview.starts == [{"debug": False}]

    # The app was built for the port the window uses: the page's own origin is
    # accepted, another port's is not.
    (built,) = built_apps
    assert built["kwargs"]["bind_host"] == "127.0.0.1"
    assert built["kwargs"]["bind_port"] == port
    assert _get(built["app"], port, f"http://127.0.0.1:{port}") == 200
    assert _get(built["app"], port, f"http://127.0.0.1:{port + 1}") == 400


def test_desktop_allows_downloads_so_the_exports_work(
    tmp_path: Path, fake_server: type[_FakeServer], webview: _FakeWebview
) -> None:
    assert webview.settings["ALLOW_DOWNLOADS"] is False
    assert _desktop(tmp_path).exit_code == 0
    # pywebview refuses a download unless told otherwise, and the UI saves its
    # CSV, COMTRADE and HTML exports by downloading them.
    assert webview.downloads_while_open is True


def test_the_server_listens_before_the_window_opens_and_stops_after_it_closes(
    tmp_path: Path, fake_server: type[_FakeServer], webview: _FakeWebview
) -> None:
    assert _desktop(tmp_path).exit_code == 0

    (server,) = fake_server.instances
    # While the window was open the server was up and had not been told to stop.
    assert webview.server_state_while_open == (True, False)
    # After it closed the server was told to stop, and had stopped by the time the
    # command returned.
    assert server.should_exit
    assert server.ended.is_set()
    assert server.sockets is not None and server.sockets[0].fileno() == -1


def test_desktop_passes_its_options_through(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    built_apps: list[dict[str, Any]],
) -> None:
    result = _desktop(
        tmp_path,
        "--max-sessions", "2",
        "--idle-timeout-seconds", "90",
        "--sweep-workers", "3",
        "--width", "1000",
        "--height", "700",
        "--devtools",
    )  # fmt: skip
    assert result.exit_code == 0, result.output
    kwargs = built_apps[0]["kwargs"]
    assert kwargs["max_sessions"] == 2
    assert kwargs["idle_timeout_seconds"] == 90.0
    assert kwargs["sweep_workers"] == 3
    (window,) = webview.windows
    assert (window["width"], window["height"]) == (1000, 700)
    assert webview.starts == [{"debug": True}]


def test_desktop_leaves_the_sweep_worker_bound_to_the_default_unless_asked(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    built_apps: list[dict[str, Any]],
) -> None:
    assert _desktop(tmp_path).exit_code == 0
    assert built_apps[0]["kwargs"]["sweep_workers"] is None


@pytest.mark.parametrize(
    "flags",
    [("--width", "639"), ("--height", "399"), ("--sweep-workers", "0")],
)
def test_desktop_refuses_a_window_smaller_than_the_page_is_laid_out_for(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    flags: tuple[str, str],
) -> None:
    result = _desktop(tmp_path, *flags)
    assert result.exit_code == 2
    assert fake_server.instances == []
    assert webview.windows == []


# ------------------------------------------------- however the window ends


def test_the_server_is_stopped_when_the_window_cannot_be_opened(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    caplog: pytest.LogCaptureFixture,
) -> None:
    webview.start_error = RuntimeError("You must have either QT or GTK installed")
    with caplog.at_level("ERROR", logger="tensa.desktop"):
        result = _desktop(tmp_path)
    assert result.exit_code == 1
    assert "cannot open the window: You must have either QT or GTK installed" in caplog.text
    (server,) = fake_server.instances
    assert server.should_exit and server.ended.is_set()
    assert server.sockets is not None and server.sockets[0].fileno() == -1


def test_the_server_is_stopped_when_the_event_loop_is_interrupted(
    tmp_path: Path, fake_server: type[_FakeServer], webview: _FakeWebview
) -> None:
    def _interrupt() -> None:
        raise KeyboardInterrupt

    webview.on_start = _interrupt
    result = _desktop(tmp_path)
    assert result.exit_code != 0  # Click's "Aborted!", whose status depends on its version
    (server,) = fake_server.instances
    assert server.should_exit and server.ended.is_set()


def test_no_window_opens_when_the_server_never_listens(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake_server.comes_up = False
    with caplog.at_level("ERROR", logger="tensa.desktop"):
        result = _desktop(tmp_path)
    assert result.exit_code == 3
    assert "the server stopped before it began listening" in caplog.text
    assert webview.windows == [] and webview.starts == []


# ------------------------------------------------- ending the sessions first


class _FakeManager:
    """Stands in for the session manager the app's lifespan creates."""

    def __init__(self, server: type[_FakeServer], fail: bool = False) -> None:
        self.server = server
        self.fail = fail
        self.calls: list[tuple[bool, bool]] = []

    async def shutdown(self) -> None:
        current = self.server.instances[-1]
        # On the server's own loop, while it is still serving.
        self.calls.append((asyncio.get_running_loop() is current.loop, current.should_exit))
        if self.fail:
            raise RuntimeError("a worker would not end")


def test_the_sessions_are_ended_on_the_servers_loop_before_it_is_told_to_exit(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    built_apps: list[dict[str, Any]],
) -> None:
    """A WebSocket of the page waits for its session to close, and uvicorn waits for it
    before it runs the app's shutdown, so the sessions must not wait for that."""
    manager = _FakeManager(fake_server)

    def _lifespan_has_run() -> None:
        built_apps[0]["app"].state.session_manager = manager

    webview.on_start = _lifespan_has_run
    assert _desktop(tmp_path).exit_code == 0
    assert manager.calls == [(True, False)]
    assert fake_server.instances[0].should_exit


def test_the_server_is_stopped_even_when_the_sessions_cannot_be_ended(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    built_apps: list[dict[str, Any]],
    caplog: pytest.LogCaptureFixture,
) -> None:
    manager = _FakeManager(fake_server, fail=True)
    webview.on_start = lambda: setattr(built_apps[0]["app"].state, "session_manager", manager)
    with caplog.at_level("WARNING", logger="tensa.desktop"):
        assert _desktop(tmp_path).exit_code == 0
    assert "could not end the sessions before stopping the server" in caplog.text
    assert "a worker would not end" in caplog.text
    (server,) = fake_server.instances
    assert server.should_exit and server.ended.is_set()


def test_the_sessions_are_ended_when_the_window_cannot_be_opened_too(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    built_apps: list[dict[str, Any]],
) -> None:
    manager = _FakeManager(fake_server)
    webview.on_start = lambda: setattr(built_apps[0]["app"].state, "session_manager", manager)
    webview.start_error = RuntimeError("no toolkit")
    assert _desktop(tmp_path).exit_code == 1
    assert manager.calls == [(True, False)]


# ------------------------------------------------------ optional dependency


def test_desktop_says_how_to_install_pywebview_when_it_is_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    built_apps: list[dict[str, Any]],
) -> None:
    # ``None`` in ``sys.modules`` makes ``import webview`` raise ImportError.
    monkeypatch.setitem(sys.modules, "webview", None)
    result = _desktop(tmp_path)
    assert result.exit_code == 1
    assert "pip install 'tensa[desktop]'" in result.output
    # It stopped before touching the workspace, a socket or a server.
    assert built_apps == [] and fake_server.instances == []
    assert not (tmp_path / "ws").exists()


def test_load_webview_names_the_extra_when_pywebview_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "webview", None)
    with pytest.raises(desktop.DesktopUnavailable, match=r"tensa\[desktop\]"):
        desktop.load_webview()


# ------------------------------------------------------- freeze_support


def test_desktop_calls_freeze_support_before_anything_else(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
) -> None:
    order: list[str] = []
    monkeypatch.setattr(cli.multiprocessing, "freeze_support", lambda: order.append("freeze"))
    real_load = cli.load_webview

    def _load() -> types.ModuleType:
        order.append("import")
        return real_load()

    monkeypatch.setattr(cli, "load_webview", _load)
    assert _desktop(tmp_path).exit_code == 0
    # A frozen executable's worker process must get to ``freeze_support`` before
    # the command does any work of its own.
    assert order == ["freeze", "import"]


def test_desktop_calls_freeze_support_even_when_it_cannot_go_on(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    freeze_calls: list[str],
) -> None:
    monkeypatch.setitem(sys.modules, "webview", None)
    assert _desktop(tmp_path).exit_code == 1
    assert freeze_calls == ["freeze"]


# ----------------------------------------------------------- warm-up child


def test_the_generated_code_is_warmed_while_the_window_is_open_and_stopped_after(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    warm_starts: list[_FakeWarm],
) -> None:
    during: list[bool] = []
    webview.on_start = lambda: during.extend(w.stopped for w in warm_starts)
    assert _desktop(tmp_path).exit_code == 0
    assert during == [False]
    assert warm_starts[0].stopped


def test_desktop_with_no_warm_cache_starts_no_child(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    warm_starts: list[_FakeWarm],
) -> None:
    assert _desktop(tmp_path, "--no-warm-cache").exit_code == 0
    assert warm_starts == []


def test_the_warm_up_child_ends_when_the_window_cannot_be_opened(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    warm_starts: list[_FakeWarm],
) -> None:
    webview.start_error = RuntimeError("no toolkit")
    assert _desktop(tmp_path).exit_code == 1
    assert warm_starts[0].stopped


# ------------------------------------------------------------------ logging


def test_desktop_logs_the_url_it_serves(
    tmp_path: Path,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("INFO", logger="tensa.desktop"):
        assert _desktop(tmp_path).exit_code == 0
    port = fake_server.instances[0].port_during_run
    assert f"serving http://127.0.0.1:{port}/ in a window" in caplog.text


def test_desktop_refuses_a_log_file_it_cannot_write(
    tmp_path: Path, fake_server: type[_FakeServer], webview: _FakeWebview
) -> None:
    blocker = tmp_path / "a-file"
    blocker.write_text("not a directory", encoding="utf-8")
    result = _desktop(tmp_path, "--log-file", str(blocker / "tensa.log"))
    assert result.exit_code == 2
    assert "cannot write the log file" in result.output
    assert fake_server.instances == [] and webview.windows == []


# ---------------------------------------------------------------- the options


def _options(command: str) -> dict[str, Any]:
    """The long options of a command, keyed by flag. Typer ships its own copy of
    click's classes, so they are read by attribute."""
    found = typer.main.get_command(cli.app).commands[command]  # type: ignore[attr-defined]
    return {opt: param for param in found.params for opt in param.opts if opt.startswith("--")}


def test_the_options_both_commands_have_are_defined_once() -> None:
    serve, desktop_options = _options("serve"), _options("desktop")
    shared = {
        "--workspace",
        "--max-sessions",
        "--idle-timeout-seconds",
        "--sweep-workers",
        "--no-warm-cache",
        "--log-level",
        "--log-file",
        "--log-json",
    }
    for flag in shared:
        assert desktop_options[flag].help == serve[flag].help, flag
        assert desktop_options[flag].default == serve[flag].default, flag


def test_desktop_has_no_option_that_would_expose_the_server() -> None:
    """The window is on this machine, so the server is only ever on loopback and
    its port is the system's choice: no ``--bind`` or ``--port``, and no extra
    origins to admit."""
    assert set(_options("desktop")) == {
        "--workspace",
        "--max-sessions",
        "--idle-timeout-seconds",
        "--sweep-workers",
        "--no-warm-cache",
        "--log-level",
        "--log-file",
        "--log-json",
        "--width",
        "--height",
        "--devtools",
    }


# ---------------------------------------------------------- run_window itself


def _run_window(server: _FakeServer, webview: _FakeWebview, **kwargs: Any) -> None:
    with socket.socket() as sock:
        desktop.run_window(
            webview,
            server,  # type: ignore[arg-type]
            sock,
            url="http://127.0.0.1:1/",
            title="t",
            width=800,
            height=600,
            devtools=False,
            log=logging.getLogger("test"),
            **kwargs,
        )


def test_run_window_gives_up_waiting_for_a_server_that_never_listens() -> None:
    class _NeverStarted(_FakeServer):
        async def serve(self, sockets: list[socket.socket] | None = None) -> None:
            while not self.should_exit:  # alive, but never ``started``
                await asyncio.sleep(0.002)
            self.ended.set()

    server = _NeverStarted(config=None)
    fake = _FakeWebview()
    with pytest.raises(desktop.ServerNotStarted, match="did not start listening within"):
        _run_window(server, fake, start_timeout=0.05)
    assert fake.windows == []
    # It was asked to stop and did, so no thread is left behind.
    assert server.should_exit and server.ended.is_set()


def test_run_window_does_not_wait_for_ever_for_a_server_that_will_not_stop(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class _Stubborn(_FakeServer):
        stop_delay = 1.0

    server = _Stubborn(config=None)
    with caplog.at_level("WARNING", logger="test"):
        _run_window(server, _FakeWebview(), stop_timeout=0.05)
    # It returned while the server was still stopping, and said so.
    assert not server.ended.is_set()
    assert "the server did not stop within" in caplog.text
    assert server.ended.wait(10), "the server thread outlived the test"


def test_run_window_stops_the_server_even_when_ending_the_sessions_takes_too_long(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def _never() -> None:
        await asyncio.sleep(30)

    server = _FakeServer(config=None)
    with caplog.at_level("WARNING", logger="test"):
        _run_window(server, _FakeWebview(), close=_never, stop_timeout=0.2)
    assert "could not end the sessions before stopping the server" in caplog.text
    assert server.should_exit and server.ended.wait(5)
