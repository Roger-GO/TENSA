"""The window ``tensa desktop`` shows the UI in.

The window is pywebview's (the optional ``desktop`` extra): WebView2 on Windows,
WebKit on macOS, and WebKitGTK or Qt WebEngine on Linux. What it shows is the
server ``tensa serve`` runs, on a free loopback port, and nothing else is
different: the same API, the same Host/Origin allow-list, the same workers.

Two things share the process. The server runs in a thread, because the main
thread belongs to the window: every toolkit wants its event loop there, and macOS
insists. ``webview.start`` returns once the window has closed, and
``run_window`` then stops the server: it ends the sessions first (``close``), and
then asks uvicorn to exit, whose shutdown closes what is left. Closing the window
leaves nothing running.

The sessions are ended first because of the page's WebSocket. The UI keeps a
socket open to the server for a session's job events, and the handler that serves it
waits on a queue that only closing the session wakes. uvicorn waits for such
handlers before it runs the app's shutdown, which is where the sessions are closed,
so left alone it would sit out its whole graceful-shutdown timeout and then cancel
the handler with an error in the log.

``webview`` is imported by ``load_webview`` and nowhere else, so the module
imports, and ``tensa serve`` starts, without the extra. The import is a plain
statement rather than ``importlib``, so a bundler that follows imports
(PyInstaller) sees it.

On Linux a window needs more than pywebview: a display, and a toolkit (Qt or GTK)
that pywebview does not install. Left alone, a machine without a display or
without a toolkit gets pywebview's tracebacks, and Qt without its X11 library does
not raise at all, it aborts the process. ``check_window_support`` looks for these
before anything is started, so the command can say what is missing and how to get
it, and so that pywebview is told to use Qt straight away when GTK is not there
(it tries GTK first and logs a traceback for the one it cannot import).
"""

from __future__ import annotations

import asyncio
import ctypes
import importlib.metadata
import importlib.util
import logging
import os
import socket
import sys
import threading
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import ModuleType

import uvicorn

# What the ``desktop`` extra in pyproject.toml asks for (a test keeps them the
# same), for an install of tensa that has no such extra.
PYWEBVIEW_REQUIREMENT = "pywebview>=5,<7"

# The sentences about the GUI toolkit on Linux, said when none is installed and
# when the window could not be opened. ``libxcb-cursor0`` is what Qt 6.5 and newer
# loads for X11, and it is the one a plain Linux install most often lacks.
TOOLKIT_HELP = (
    "On Linux the window needs a GUI toolkit. Qt: pip install 'pywebview[qt]' "
    "(on X11 it also needs the system library libxcb-cursor0, for example "
    "sudo apt install libxcb-cursor0). GTK: install WebKitGTK and PyGObject with "
    "your package manager (on Debian and Ubuntu, sudo apt install python3-gi "
    "gir1.2-webkit2-4.1); a virtual environment sees them only when it was "
    "created with --system-site-packages."
)

NO_DISPLAY = (
    "tensa desktop opens a window, and this session has no display (neither "
    "DISPLAY nor WAYLAND_DISPLAY is set), as over SSH or in a container. Run it "
    "from a desktop session. To use TENSA without a window, run "
    "'tensa serve --port 8000' and open http://127.0.0.1:8000 in a browser; over "
    "SSH, forward the port first: ssh -L 8000:127.0.0.1:8000 <host>."
)

NO_TOOLKIT = (
    "tensa desktop cannot open a window: neither Qt for Python (qtpy) nor "
    "PyGObject (GTK) is installed. " + TOOLKIT_HELP
)

QT_NEEDS_XCB_CURSOR = (
    "Qt's X11 plugin needs the system library libxcb-cursor0 (since Qt 6.5), and "
    "it was not found. If the window then fails with 'Could not load the Qt "
    "platform plugin \"xcb\"', install it: sudo apt install libxcb-cursor0 (Debian "
    "and Ubuntu), sudo dnf install xcb-util-cursor (Fedora) or sudo pacman -S "
    "xcb-util-cursor (Arch)."
)

# The smallest window the UI is laid out for (the top bar, the sidebar and a
# drawer need about this much); ``--width`` and ``--height`` cannot go below it.
MIN_WIDTH = 640
MIN_HEIGHT = 400


class DesktopUnavailable(RuntimeError):
    """pywebview could not be imported."""


class ServerNotStarted(RuntimeError):
    """The server thread ended, or took too long, before it listened."""


class WindowFailed(RuntimeError):
    """The window could not be opened, or its event loop failed.

    On Linux this is what a missing GUI toolkit looks like: pywebview needs GTK
    or Qt there and raises when it finds neither.
    """


def _provided_extras() -> list[str]:
    """The extras this install of tensa declares; none when it has no metadata."""
    try:
        return importlib.metadata.metadata("tensa").get_all("Provides-Extra") or []
    except importlib.metadata.PackageNotFoundError:
        return []


def install_hint(*, platform: str = sys.platform, extras: list[str] | None = None) -> str:
    """How to get pywebview: the ``desktop`` extra, or pywebview itself.

    An install of tensa that predates the extra (an editable install made before
    it was added, say) has no such extra, and pip only warns about one it does not
    know and then installs nothing, so the hint must not name it there. On Linux a
    toolkit is needed as well, and the hint says so in the same breath.
    """
    declared = _provided_extras() if extras is None else extras
    command = (
        "pip install 'tensa[desktop]'"
        if "desktop" in declared
        else f"pip install '{PYWEBVIEW_REQUIREMENT}'"
    )
    hint = f"Install it with: {command}"
    if platform.startswith("linux"):
        hint += (
            "\nOn Linux the window also needs a GUI toolkit; the easiest is Qt: "
            "pip install 'pywebview[qt]' (see 'tensa desktop --help' for GTK and for "
            "what Qt needs from the system)."
        )
    return hint


def load_webview() -> ModuleType:
    """Import pywebview, or raise ``DesktopUnavailable`` saying how to get it."""
    try:
        import webview
    except ImportError as exc:
        raise DesktopUnavailable(
            f"tensa desktop needs pywebview, which is not installed ({exc}).\n{install_hint()}"
        ) from exc
    module: ModuleType = webview
    return module


@dataclass(frozen=True)
class WindowSupport:
    """What ``check_window_support`` found out about opening a window here."""

    # Why no window can open (the command stops with it), or None.
    problem: str | None = None
    # What will probably go wrong; said, and the command goes on.
    warnings: tuple[str, ...] = ()
    # The toolkit to ask pywebview for, or None to leave the choice to it.
    gui: str | None = None


def _importable(name: str) -> bool:
    """Whether ``name`` (a top-level module) can be found, without importing it."""
    return importlib.util.find_spec(name) is not None


def _library_loads(name: str) -> bool:
    """Whether the dynamic loader finds the shared library ``name``."""
    try:
        ctypes.CDLL(name)
    except OSError:
        return False
    return True


def check_window_support(
    *,
    platform: str = sys.platform,
    env: Mapping[str, str] | None = None,
    has_module: Callable[[str], bool] = _importable,
    library_loads: Callable[[str], bool] = _library_loads,
) -> WindowSupport:
    """Look for what would keep a window from opening, before anything is started.

    Windows and macOS always have a display and a web view, so only Linux is
    checked. It needs a display (or a Qt platform chosen by hand, which is how Qt
    runs without a screen) and a toolkit. When only Qt is installed pywebview is
    asked for it, so that it does not try GTK first and log a traceback for the
    import that fails; when the user chose a toolkit with ``PYWEBVIEW_GUI`` that
    stands. The Qt library check is a warning, not a stop: Qt 5 does not need it
    and a Wayland session does not use the plugin that does, and Qt's abort, which
    no Python code can catch, would otherwise be all there is to see.
    """
    if not platform.startswith("linux"):
        return WindowSupport()
    environment = os.environ if env is None else env
    chosen_qpa = environment.get("QT_QPA_PLATFORM")
    wayland = environment.get("WAYLAND_DISPLAY")
    if not (environment.get("DISPLAY") or wayland or chosen_qpa):
        return WindowSupport(problem=NO_DISPLAY)

    requested = environment.get("PYWEBVIEW_GUI", "").lower()
    if requested and requested not in ("qt", "gtk"):
        # Another toolkit (CEF, say) was asked for by hand; pywebview reports its
        # own problems with it.
        return WindowSupport()
    has_gtk, has_qt = has_module("gi"), has_module("qtpy")
    if not (has_gtk or has_qt):
        return WindowSupport(problem=NO_TOOLKIT)

    # pywebview's own order: the one asked for, else Qt in a KDE session, else GTK.
    first = requested or ("qt" if "KDE_FULL_SESSION" in environment else "gtk")
    uses_qt = has_qt and (first == "qt" or not has_gtk)
    gui = "qt" if uses_qt and not has_gtk and not requested else None
    warnings: list[str] = []
    if uses_qt and not (wayland or chosen_qpa) and not library_loads("libxcb-cursor.so.0"):
        warnings.append(QT_NEEDS_XCB_CURSOR)
    return WindowSupport(warnings=tuple(warnings), gui=gui)


def run_window(
    webview: ModuleType,
    server: uvicorn.Server,
    sock: socket.socket,
    *,
    url: str,
    title: str,
    width: int,
    height: int,
    devtools: bool,
    log: logging.Logger,
    gui: str | None = None,
    close: Callable[[], Awaitable[None]] | None = None,
    start_timeout: float = 60.0,
    stop_timeout: float = 30.0,
) -> None:
    """Serve on ``sock`` in a thread and show ``url`` in a window until it closes.

    ``gui`` names the toolkit pywebview is asked to use first (``"qt"``), or is None
    to leave the choice to it. ``close`` is a coroutine function that ends the
    sessions; it runs on the server's event loop once the window has closed, before
    the server is asked to exit. Returns when the window has closed and the server has stopped (or has not
    within ``stop_timeout`` seconds, which is logged: the thread is a daemon, so it
    does not hold the process up, and a worker whose server has gone ends itself).
    Raises ``ServerNotStarted`` when the server never began listening, in which
    case no window is opened, and ``WindowFailed`` when pywebview fails.
    """
    loops: list[asyncio.AbstractEventLoop] = []

    def _serve() -> None:
        # uvicorn's ``Server.run`` would do the same with a loop of its own; this
        # one is ours so that ``close`` can be run on it.
        with asyncio.Runner() as runner:
            loops.append(runner.get_loop())
            runner.run(server.serve(sockets=[sock]))

    thread = threading.Thread(target=_serve, name="tensa-server", daemon=True)
    thread.start()
    try:
        _wait_until_started(server, thread, start_timeout)
        try:
            # The UI saves files by clicking a download link (CSV, COMTRADE and HTML
            # exports, Save system as, reports); pywebview refuses downloads unless
            # told otherwise.
            webview.settings["ALLOW_DOWNLOADS"] = True
            webview.create_window(
                title,
                url,
                width=width,
                height=height,
                min_size=(MIN_WIDTH, MIN_HEIGHT),
            )
            log.info("opening a window on %s", url)
            # Blocks until the last window closes. It has to run on this, the main,
            # thread.
            webview.start(debug=devtools, **({"gui": gui} if gui else {}))
        except Exception as exc:
            raise WindowFailed(str(exc) or type(exc).__name__) from exc
        log.info("the window was closed; stopping the server")
    finally:
        # Also the way out when the window raised, when the server never came up
        # and when Ctrl+C interrupts the event loop.
        if close is not None and loops and thread.is_alive():
            _run_on_loop(loops[0], close, stop_timeout, log)
        server.should_exit = True
        thread.join(stop_timeout)
        if thread.is_alive():
            log.warning("the server did not stop within %.0f s; leaving it", stop_timeout)


def _run_on_loop(
    loop: asyncio.AbstractEventLoop,
    close: Callable[[], Awaitable[None]],
    timeout: float,
    log: logging.Logger,
) -> None:
    """Run ``close`` on the server's loop and wait for it. A failure is logged and
    does not stop the server from being stopped."""

    async def _close() -> None:
        await close()

    try:
        asyncio.run_coroutine_threadsafe(_close(), loop).result(timeout)
    except Exception as exc:  # noqa: BLE001 - the server is stopped either way
        log.warning("could not end the sessions before stopping the server: %r", exc)


def _wait_until_started(
    server: uvicorn.Server, thread: threading.Thread, timeout: float
) -> None:
    """Wait for uvicorn to report that it is listening.

    Opening the window earlier would make its first request fail.
    """
    deadline = time.monotonic() + timeout
    while not server.started:
        if not thread.is_alive():
            raise ServerNotStarted("the server stopped before it began listening")
        if time.monotonic() >= deadline:
            raise ServerNotStarted(f"the server did not start listening within {timeout:.0f} s")
        time.sleep(0.02)
