"""``tensa desktop`` CLI wiring (no window, no real server).

pywebview is replaced by a fake module that records what it is asked to do, and
uvicorn's ``Server`` by one that runs in the thread ``run_window`` gives it, comes
up when asked to, and stops when ``should_exit`` is set. What is checked is the
order of events: the server listens before the window opens, and is stopped when
the window has closed, however it closed. Whether this machine can show a window at
all (a display, a toolkit that starts) is what ``check_window_support`` answers; the
tests here stand in for it, and its own tests and those of the child process it
starts a toolkit in (``probe_toolkit``) come after them.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import logging
import re
import socket
import subprocess
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

from tensa import cli, desktop
from tensa.api.app import make_app
from tensa.core.logging_setup import reset_logging
from tests._cli import cli_runner

pytestmark = pytest.mark.unit

runner = cli_runner()


@pytest.fixture(autouse=True)
def _a_window_can_open(monkeypatch: pytest.MonkeyPatch) -> None:
    """A headless Linux machine has no display, which the command would refuse."""
    monkeypatch.setattr(cli, "check_window_support", lambda: desktop.WindowSupport())
    monkeypatch.setattr(desktop, "_provided_extras", lambda: ["desktop"])


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
    assert desktop.install_command() in result.output
    assert 'pip install "tensa[desktop]"' in result.output
    # The UI does not need the window, and the message says so.
    assert desktop.BROWSER_INSTEAD in result.output
    # It stopped before touching the workspace, a socket or a server.
    assert built_apps == [] and fake_server.instances == []
    assert not (tmp_path / "ws").exists()


def test_load_webview_names_the_extra_when_pywebview_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(sys.modules, "webview", None)
    with pytest.raises(desktop.DesktopUnavailable, match=r"tensa\[desktop\]"):
        desktop.load_webview()


def test_the_install_command_names_the_extra_only_when_this_install_has_it() -> None:
    assert desktop.install_command(platform="win32", extras=["mcp", "desktop"]) == (
        'pip install "tensa[desktop]"'
    )
    # An install made before the extra existed: pip would only warn that tensa has no
    # such extra and install nothing, so the command names pywebview itself.
    without = desktop.install_command(platform="darwin", extras=["mcp", "dev"])
    assert without == f'pip install "{desktop.PYWEBVIEW_REQUIREMENT}"'
    assert "tensa[desktop]" not in desktop.install_command(platform="win32", extras=[])


def test_the_install_command_adds_the_toolkit_on_linux_only() -> None:
    """pywebview brings a web view on Windows and macOS and none on Linux, so the one
    command a Linux user is given installs Qt as well."""
    assert desktop.install_command(platform="linux", extras=["desktop"]) == (
        'pip install "tensa[desktop]" "pywebview[qt]"'
    )
    # Without the extra it is one requirement: pywebview, its Qt extra and its bounds.
    assert desktop.install_command(platform="linux", extras=[]) == (
        'pip install "pywebview[qt]>=5,<7"'
    )
    for platform in ("win32", "darwin"):
        assert "pywebview[qt]" not in desktop.install_command(
            platform=platform, extras=["desktop"]
        )


def test_the_install_command_is_quoted_for_every_shell() -> None:
    """``cmd.exe`` passes single quotes on to pip, which then finds no such package;
    double quotes work there, in PowerShell and in a POSIX shell."""
    for platform in ("linux", "win32", "darwin"):
        for extras in (["desktop"], []):
            command = desktop.install_command(platform=platform, extras=extras)
            assert "'" not in command
            assert re.fullmatch(r'pip install(?: "[^"\s]+")+', command), command


def test_the_install_command_reads_the_extras_of_the_installed_package(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.undo()  # the autouse stand-in for what the install declares
    declared = importlib.metadata.metadata("tensa").get_all("Provides-Extra") or []
    expected = "tensa[desktop]" if "desktop" in declared else "pywebview"
    assert expected in desktop.install_command()


def test_the_install_command_is_pywebview_alone_when_tensa_has_no_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.undo()

    def _missing(_name: str) -> Any:
        raise importlib.metadata.PackageNotFoundError("tensa")

    monkeypatch.setattr(desktop.importlib.metadata, "metadata", _missing)
    assert desktop.install_command(platform="win32") == (
        f'pip install "{desktop.PYWEBVIEW_REQUIREMENT}"'
    )


def test_the_install_hint_gives_the_command_and_the_way_without_a_window() -> None:
    for platform in ("linux", "win32", "darwin"):
        hint = desktop.install_hint(platform=platform, extras=["desktop"])
        assert desktop.install_command(platform=platform, extras=["desktop"]) in hint
        assert hint.endswith(desktop.BROWSER_INSTEAD)
    # Why the Linux command is longer is said there and nowhere else.
    assert "GUI toolkit" in desktop.install_hint(platform="linux", extras=["desktop"])
    assert "toolkit" not in desktop.install_hint(platform="win32", extras=["desktop"])


def test_the_way_without_a_window_is_a_command_that_exists() -> None:
    assert '"tensa serve --open"' in desktop.BROWSER_INSTEAD
    assert "--open" in _options("serve")


def _help_text(*command: str) -> str:
    """A command's ``--help`` as one line of single-spaced words (the terminal
    wraps it, and a command to copy can fall on two lines)."""
    result = runner.invoke(cli.app, [*command, "--help"])
    assert result.exit_code == 0, result.output
    return " ".join(result.output.split())


def test_the_help_gives_the_install_commands_the_messages_give() -> None:
    """A user who reads ``--help`` and one who reads a refusal are told to type the
    same thing: both take the command from ``install_command``."""
    text = _help_text("desktop")
    for platform in ("linux", "win32", "darwin"):
        assert desktop.install_command(platform=platform, extras=["desktop"]) in text, platform
    # What cannot come from pip, and the way without a window.
    assert "libxcb-cursor0" in text
    assert "--system-site-packages" in text
    assert '"tensa serve --open"' in text


def test_the_idle_timeout_help_is_two_short_sentences() -> None:
    text = _options("desktop")["--idle-timeout-seconds"].help
    assert len(text) < 130, text
    # What a user needs to pick a value: the UI's own interval and the floor it sets.
    assert "30 seconds" in text and "60" in text


# ------------------------------------------------- a machine without a window


def test_desktop_stops_before_starting_anything_when_no_window_can_open(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    built_apps: list[dict[str, Any]],
) -> None:
    monkeypatch.setattr(
        cli, "check_window_support", lambda: desktop.WindowSupport(problem="no display here")
    )
    result = _desktop(tmp_path)
    assert result.exit_code == 1
    assert "no display here" in result.output
    # Nothing was left behind: no workspace, no server, no window.
    assert built_apps == [] and fake_server.instances == [] and webview.windows == []
    assert not (tmp_path / "ws").exists()


def test_desktop_says_what_will_probably_go_wrong_and_goes_on(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(
        cli,
        "check_window_support",
        lambda: desktop.WindowSupport(warnings=("libxcb-cursor0 is missing",)),
    )
    with caplog.at_level("WARNING", logger="tensa.desktop"):
        result = _desktop(tmp_path)
    assert result.exit_code == 0, result.output
    assert "libxcb-cursor0 is missing" in caplog.text
    assert len(webview.windows) == 1


def test_desktop_asks_pywebview_for_the_toolkit_the_check_chose(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
) -> None:
    assert _desktop(tmp_path).exit_code == 0
    # Left to pywebview unless the check had a reason.
    assert webview.starts == [{"debug": False}]

    monkeypatch.setattr(cli, "check_window_support", lambda: desktop.WindowSupport(gui="qt"))
    webview.starts.clear()
    assert _desktop(tmp_path).exit_code == 0
    assert webview.starts == [{"debug": False, "gui": "qt"}]


def test_the_toolkit_hint_follows_a_window_that_could_not_open_on_linux(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fake_server: type[_FakeServer],
    webview: _FakeWebview,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(cli.sys, "platform", "linux")
    webview.start_error = RuntimeError("no toolkit")
    with caplog.at_level("ERROR", logger="tensa.desktop"):
        assert _desktop(tmp_path).exit_code == 1
    assert desktop.toolkit_help() in caplog.text


# ---------------------------------------------- what check_window_support finds

_X11 = {"DISPLAY": ":0"}

# What Qt 6.5 and newer writes before it aborts on X11 without its cursor library.
_QT_ABORT = (
    "qt.qpa.plugin: From 6.5.0, xcb-cursor0 or libxcb-cursor0 is needed to load the Qt "
    "xcb platform plugin.\n"
    'qt.qpa.plugin: Could not load the Qt platform plugin "xcb" in "" even though it was '
    "found.\n"
    "This application failed to start because no Qt platform plugin could be initialized."
)
_STARTS = desktop.ToolkitProbe(returncode=0)
_QT_ABORTS = desktop.ToolkitProbe(returncode=-6, output=_QT_ABORT)
_NO_WEBKIT = desktop.ToolkitProbe(
    returncode=1, output="GTK with WebKitGTK cannot be loaded: Namespace WebKit2 not available"
)


def _support(
    env: dict[str, str],
    *,
    modules: tuple[str, ...] = ("qtpy",),
    libraries: tuple[str, ...] = ("libxcb-cursor.so.0",),
    platform: str = "linux",
    probes: dict[str, desktop.ToolkitProbe | None] | None = None,
    probed: list[str] | None = None,
) -> desktop.WindowSupport:
    """``check_window_support`` on a made-up machine. ``probes`` says how each toolkit's
    start in a child process ends (it starts, unless said otherwise), and ``probed``
    collects the toolkits that were tried."""

    def probe(toolkit: str) -> desktop.ToolkitProbe | None:
        if probed is not None:
            probed.append(toolkit)
        return (probes or {}).get(toolkit, _STARTS)

    return desktop.check_window_support(
        platform=platform,
        env=env,
        has_module=lambda name: name in modules,
        library_loads=lambda name: name in libraries,
        probe=probe,
    )


def test_a_session_without_a_display_cannot_open_a_window() -> None:
    probed: list[str] = []
    found = _support({}, probed=probed)
    assert found.problem == desktop.NO_DISPLAY
    assert probed == []  # nothing is started where nothing could be shown
    # It says what to do instead, and the commands it gives exist.
    assert "tensa serve --port 8000" in desktop.NO_DISPLAY
    assert "--port" in _options("serve")


@pytest.mark.parametrize(
    "env",
    [{"DISPLAY": ":0"}, {"WAYLAND_DISPLAY": "wayland-0"}, {"QT_QPA_PLATFORM": "offscreen"}],
)
def test_a_display_or_a_qt_platform_chosen_by_hand_is_enough(env: dict[str, str]) -> None:
    assert _support(env).problem is None


def test_a_machine_with_no_toolkit_is_told_both_ways_to_get_one() -> None:
    probed: list[str] = []
    found = _support(_X11, modules=(), probed=probed)
    assert found.problem == desktop.no_toolkit()
    assert probed == []
    message = desktop.no_toolkit()
    # Qt by the one command the help gives, with the library pip cannot bring.
    assert desktop.install_command(platform="linux") in message
    assert desktop.XCB_CURSOR_INSTALL in message
    # GTK from the distribution.
    assert desktop.WEBKITGTK_INSTALL in message
    assert "--system-site-packages" in message
    assert message.endswith(desktop.BROWSER_INSTEAD)


def test_only_linux_is_checked() -> None:
    # Windows and macOS always have a display and a web view of their own.
    for platform in ("win32", "darwin"):
        probed: list[str] = []
        found = _support({}, modules=(), libraries=(), platform=platform, probed=probed)
        assert found == desktop.WindowSupport()
        assert probed == []


def test_qt_alone_is_asked_for_by_name_so_pywebview_does_not_try_gtk_first() -> None:
    probed: list[str] = []
    assert _support(_X11, modules=("qtpy",), probed=probed).gui == "qt"
    assert probed == ["qt"]  # a toolkit that is not installed is not started


def test_pywebview_keeps_the_choice_when_both_toolkits_are_there() -> None:
    probed: list[str] = []
    both = _support(_X11, modules=("gi", "qtpy"), probed=probed)
    assert both == desktop.WindowSupport()
    assert probed == ["gtk"]  # GTK goes first, and it starts: Qt is not needed
    assert _support(_X11, modules=("gi",)) == desktop.WindowSupport()


def test_a_toolkit_chosen_with_pywebview_gui_stands() -> None:
    probed: list[str] = []
    env = {**_X11, "PYWEBVIEW_GUI": "qt"}
    assert _support(env, modules=("gi", "qtpy"), probed=probed) == desktop.WindowSupport()
    assert probed == ["qt"]
    # CEF and the like are pywebview's to check.
    assert _support({**_X11, "PYWEBVIEW_GUI": "cef"}, modules=()) == desktop.WindowSupport()


def test_a_kde_session_prefers_qt_even_when_gtk_is_there() -> None:
    probed: list[str] = []
    found = _support({**_X11, "KDE_FULL_SESSION": "true"}, modules=("gi", "qtpy"), probed=probed)
    assert probed == ["qt"]
    assert found == desktop.WindowSupport()  # pywebview already puts Qt first there


def test_qt_that_aborts_for_its_x11_library_stops_the_command_with_the_package() -> None:
    """Qt does not raise when it cannot load its X11 plugin, it aborts the process, so
    the only place to find that out is a child, before anything is started."""
    found = _support(_X11, libraries=(), probes={"qt": _QT_ABORTS})
    assert found.warnings == () and found.gui is None
    assert found.problem is not None
    # What is missing, the command for each family of distribution, and the way
    # without a window; none of Qt's own text, which says less.
    assert "libxcb-cursor0 is missing" in found.problem
    assert desktop.XCB_CURSOR_INSTALL in found.problem
    for command in (
        "sudo apt install libxcb-cursor0",
        "sudo dnf install xcb-util-cursor",
        "sudo pacman -S xcb-util-cursor",
    ):
        assert command in found.problem
    assert found.problem.endswith(desktop.BROWSER_INSTEAD)
    assert "qt.qpa.plugin" not in found.problem
    # One message: it does not send the user to pip for something pip cannot install.
    assert "pip install" not in found.problem


def test_an_older_qt_that_only_names_its_plugin_is_matched_by_the_missing_library() -> None:
    old_words = desktop.ToolkitProbe(
        returncode=-6, output='qt.qpa.plugin: Could not load the Qt platform plugin "xcb" in ""'
    )
    assert "libxcb-cursor0 is missing" in str(
        _support(_X11, libraries=(), probes={"qt": old_words}).problem
    )
    # With the library there, the plugin failed for another reason: Qt's words are kept.
    other = _support(_X11, probes={"qt": old_words}).problem
    assert other is not None and "libxcb-cursor0 is missing" not in other
    assert 'Could not load the Qt platform plugin "xcb"' in other


def test_qt_that_does_not_start_for_another_reason_is_quoted() -> None:
    no_engine = desktop.ToolkitProbe(
        returncode=1,
        output="Qt WebEngine cannot be imported: libnss3.so: cannot open shared object file",
    )
    problem = _support(_X11, probes={"qt": no_engine}).problem
    assert problem is not None
    assert "Qt cannot start. It said:\n  Qt WebEngine cannot be imported: libnss3.so" in problem
    assert desktop.install_command(platform="linux") in problem
    assert problem.endswith(desktop.BROWSER_INSTEAD)


def test_only_the_end_of_what_a_toolkit_wrote_is_quoted() -> None:
    long = desktop.ToolkitProbe(
        returncode=1, output="\n".join(f"line {n}" for n in range(40)) + "\n\n" + "x" * 900
    )
    problem = str(_support(_X11, probes={"qt": long}).problem)
    assert "line 35" in problem and "line 33" not in problem
    assert "x" * 300 in problem and "x" * 301 not in problem
    silent = str(_support(_X11, probes={"qt": desktop.ToolkitProbe(returncode=-11)}).problem)
    assert "(it wrote nothing)" in silent


def test_gtk_without_webkit_is_told_the_packages_and_offered_qt() -> None:
    problem = _support(_X11, modules=("gi",), probes={"gtk": _NO_WEBKIT}).problem
    assert problem is not None
    assert "Namespace WebKit2 not available" in problem
    assert desktop.WEBKITGTK_INSTALL in problem
    assert f"Or use Qt instead: {desktop.install_command(platform='linux')}" in problem
    assert problem.endswith(desktop.BROWSER_INSTEAD)


def test_the_window_uses_the_toolkit_that_starts() -> None:
    # GTK is installed without WebKitGTK (PyGObject is on most desktops): Qt it is,
    # asked for by name so that pywebview does not log GTK's traceback first.
    probed: list[str] = []
    found = _support(_X11, modules=("gi", "qtpy"), probes={"gtk": _NO_WEBKIT}, probed=probed)
    assert probed == ["gtk", "qt"]
    assert found == desktop.WindowSupport(gui="qt")
    # A KDE session, where pywebview would start Qt first and abort in it.
    kde = _support(
        {**_X11, "KDE_FULL_SESSION": "true"},
        modules=("gi", "qtpy"),
        libraries=(),
        probes={"qt": _QT_ABORTS},
    )
    assert kde == desktop.WindowSupport(gui="gtk")


def test_a_toolkit_asked_for_that_cannot_be_used_is_said_and_the_other_used() -> None:
    env = {**_X11, "PYWEBVIEW_GUI": "qt"}
    aborts = _support(env, modules=("gi", "qtpy"), libraries=(), probes={"qt": _QT_ABORTS})
    assert aborts.problem is None and aborts.gui == "gtk"
    assert aborts.warnings == (
        "PYWEBVIEW_GUI asks for Qt, which is installed but does not start; "
        "the window uses GTK.",
    )
    absent = _support({**_X11, "PYWEBVIEW_GUI": "gtk"}, modules=("qtpy",))
    assert absent.problem is None and absent.gui == "qt"
    assert absent.warnings == (
        "PYWEBVIEW_GUI asks for GTK, which is not installed; the window uses Qt.",
    )


def test_when_no_toolkit_starts_the_message_says_what_each_one_lacks() -> None:
    problem = _support(
        _X11, modules=("gi", "qtpy"), libraries=(), probes={"gtk": _NO_WEBKIT, "qt": _QT_ABORTS}
    ).problem
    assert problem is not None
    assert problem.index("GTK with WebKitGTK cannot be loaded") < problem.index("Qt cannot start")
    assert desktop.WEBKITGTK_INSTALL in problem and desktop.XCB_CURSOR_INSTALL in problem
    assert "Or use Qt instead" not in problem  # Qt is installed, and has its own line
    assert problem.count(desktop.BROWSER_INSTEAD) == 1


# A child that told nothing (a bundled executable has no interpreter to start one
# with, and one that did not end in time is not waited for): the command goes on,
# and for Qt the library is looked for instead.


def test_without_a_probe_a_missing_x11_library_is_a_warning() -> None:
    found = _support(_X11, libraries=(), probes={"qt": None})
    assert found.problem is None and found.gui == "qt"
    assert found.warnings == (desktop.QT_NEEDS_XCB_CURSOR,)
    assert "sudo apt install libxcb-cursor0" in desktop.QT_NEEDS_XCB_CURSOR
    assert _support(_X11, probes={"qt": None}).warnings == ()


@pytest.mark.parametrize(
    "env",
    [
        # Qt takes its Wayland plugin there, which needs no such library.
        {"DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-0"},
        # The platform was chosen by hand.
        {"DISPLAY": ":0", "QT_QPA_PLATFORM": "xcb"},
    ],
)
def test_the_x11_library_is_not_asked_for_where_qt_will_not_load_it(env: dict[str, str]) -> None:
    assert _support(env, libraries=(), probes={"qt": None}).warnings == ()


def test_gtk_only_needs_no_qt_library() -> None:
    for probes in ({}, {"gtk": None}):
        assert _support(_X11, modules=("gi",), libraries=(), probes=probes) == (
            desktop.WindowSupport()
        )


def test_the_real_checks_find_a_module_and_a_library_or_say_they_are_not_there() -> None:
    assert desktop._importable("sys")
    assert not desktop._importable("no_such_module_for_tensa")
    assert not desktop._library_loads("libno-such-library-for-tensa.so.9")


# ------------------------------------------------- the child a toolkit starts in


def test_the_probe_scripts_are_python() -> None:
    assert set(desktop._PROBE_SCRIPTS) == {"qt", "gtk"}
    for toolkit, script in desktop._PROBE_SCRIPTS.items():
        compile(script, f"<{toolkit} probe>", "exec")


def test_a_child_that_ends_well_means_the_toolkit_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(desktop._PROBE_SCRIPTS, "qt", "print('up')")
    found = desktop.probe_toolkit("qt")
    assert found == desktop.ToolkitProbe(returncode=0, output="up")
    assert found.ok


def test_a_child_that_fails_says_why(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(
        desktop._PROBE_SCRIPTS, "gtk", "import sys\nsys.exit('no WebKit here')"
    )
    found = desktop.probe_toolkit("gtk")
    assert found == desktop.ToolkitProbe(returncode=1, output="no WebKit here")
    assert not found.ok


@pytest.mark.skipif(sys.platform == "win32", reason="a signal does not end a process there")
def test_a_child_that_a_signal_ended_is_a_toolkit_that_does_not_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # SIGKILL stands in for Qt's SIGABRT: it ends the child the same way and leaves
    # no core dump for the machine's crash reporter to pick up.
    script = (
        "import os, signal, sys\n"
        "sys.stderr.write('could not load the platform plugin\\n')\n"
        "sys.stderr.flush()\n"
        "os.kill(os.getpid(), signal.SIGKILL)\n"
    )
    monkeypatch.setitem(desktop._PROBE_SCRIPTS, "qt", script)
    found = desktop.probe_toolkit("qt")
    assert found is not None and not found.ok
    assert found.returncode == -9
    assert found.output == "could not load the platform plugin"


def test_a_child_that_does_not_end_in_time_tells_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(desktop._PROBE_SCRIPTS, "qt", "import time\ntime.sleep(60)")
    assert desktop.probe_toolkit("qt", timeout=0.5) is None


def test_a_child_that_cannot_be_started_tells_nothing(tmp_path: Path) -> None:
    assert desktop.probe_toolkit("qt", executable=str(tmp_path / "no-python-here")) is None


def test_a_bundled_executable_starts_no_child(monkeypatch: pytest.MonkeyPatch) -> None:
    """Its ``sys.executable`` is the program itself, which would start a second copy
    of the application with ``-c`` and a script for arguments."""

    def _refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a child process was started")

    monkeypatch.setattr(desktop.subprocess, "run", _refuse)
    assert desktop.probe_toolkit("qt", frozen=True) is None
    monkeypatch.setattr(desktop.sys, "frozen", True, raising=False)
    assert desktop.probe_toolkit("gtk") is None


def test_the_child_is_this_interpreter_and_gets_no_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    def _run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        seen["command"], seen["kwargs"] = command, kwargs
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(desktop.subprocess, "run", _run)
    assert desktop.probe_toolkit("gtk") == desktop.ToolkitProbe(returncode=0)
    assert seen["command"] == [sys.executable, "-c", desktop._PROBE_SCRIPTS["gtk"]]
    assert seen["kwargs"]["stdin"] is subprocess.DEVNULL
    assert seen["kwargs"]["timeout"] == desktop.PROBE_TIMEOUT
    # The environment is inherited: the child must see the display and the libraries.
    assert "env" not in seen["kwargs"]


def _stub_package(root: Path, name: str, modules: dict[str, str]) -> None:
    """A package ``name`` under ``root`` whose modules hold the given source."""
    package = root / name
    package.mkdir()
    for module, source in modules.items():
        (package / f"{module}.py").write_text(source, encoding="utf-8")


@pytest.fixture
def stubs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A directory the child imports from before anything installed, so the real
    scripts run against stand-ins for the toolkits."""
    root = tmp_path / "stubs"
    root.mkdir()
    monkeypatch.setenv("PYTHONPATH", str(root))
    return root


_NO_QT5 = {"__init__": "", "QtWebKitWidgets": "raise ImportError('no QtWebKit')"}


def test_the_qt_script_passes_when_the_web_engine_and_the_application_start(
    stubs: Path,
) -> None:
    _stub_package(
        stubs,
        "qtpy",
        {
            "__init__": "",
            "QtWebEngineWidgets": "QWebEngineView = object",
            "QtWidgets": "class QApplication:\n    def __init__(self, argv):\n        pass\n",
        },
    )
    assert desktop.probe_toolkit("qt") == desktop.ToolkitProbe(returncode=0)


def test_the_qt_script_names_a_web_engine_that_cannot_be_imported(stubs: Path) -> None:
    _stub_package(
        stubs,
        "qtpy",
        {
            "__init__": "",
            "QtWebEngineWidgets": "raise ImportError('libnss3.so: cannot open shared object file')",
            "QtWidgets": "raise AssertionError('not reached')",
        },
    )
    _stub_package(stubs, "PyQt5", _NO_QT5)
    found = desktop.probe_toolkit("qt")
    # The first failure is the one that matters, not the fallback's.
    assert found == desktop.ToolkitProbe(
        returncode=1,
        output="Qt WebEngine cannot be imported: libnss3.so: cannot open shared object file",
    )


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Qt aborts like this on Linux")
def test_the_qt_script_reports_an_application_that_aborts_and_leaves_no_core_dump(
    stubs: Path,
) -> None:
    """The real thing: the application object writes Qt's words and aborts. The
    script has switched core dumps off by then (``PR_GET_DUMPABLE`` is 3), so the
    abort leaves nothing for the machine's crash reporter."""
    aborting = (
        "import ctypes, os, sys\n"
        "class QApplication:\n"
        "    def __init__(self, argv):\n"
        f"        sys.stderr.write({_QT_ABORT!r} + '\\n')\n"
        "        dumpable = ctypes.CDLL(None).prctl(3)\n"
        "        sys.stderr.write(f'dumpable: {dumpable}\\n')\n"
        "        sys.stderr.flush()\n"
        "        os.abort()\n"
    )
    _stub_package(
        stubs,
        "qtpy",
        {"__init__": "", "QtWebEngineWidgets": "QWebEngineView = object", "QtWidgets": aborting},
    )
    found = desktop.probe_toolkit("qt")
    assert found is not None
    assert found.returncode == -6
    assert "xcb-cursor0 or libxcb-cursor0 is needed" in found.output
    assert found.output.endswith("dumpable: 0")
    # And it reads as the missing library, whatever the loader says.
    assert desktop._lacks_xcb_cursor(found, lambda _name: True)


def test_the_gtk_script_names_what_cannot_be_loaded(stubs: Path) -> None:
    _stub_package(
        stubs,
        "gi",
        {
            "__init__": (
                "def require_version(namespace, version):\n"
                "    if namespace == 'WebKit2':\n"
                "        raise ValueError('Namespace WebKit2 not available')\n"
            ),
        },
    )
    assert desktop.probe_toolkit("gtk") == desktop.ToolkitProbe(
        returncode=1,
        output="GTK with WebKitGTK cannot be loaded: Namespace WebKit2 not available",
    )


def test_the_gtk_script_takes_either_version_of_webkit(stubs: Path) -> None:
    _stub_package(
        stubs,
        "gi",
        {
            "__init__": (
                "def require_version(namespace, version):\n"
                "    if (namespace, version) == ('WebKit2', '4.1'):\n"
                "        raise ValueError('Namespace WebKit2 not available for version 4.1')\n"
            ),
            "repository": "Gtk = WebKit2 = object()",
        },
    )
    assert desktop.probe_toolkit("gtk") == desktop.ToolkitProbe(returncode=0)


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
        # Bound, as the command hands it over: the stand-in server reads its port,
        # and Windows refuses to name the address of a socket that has none.
        sock.bind(("127.0.0.1", 0))
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
