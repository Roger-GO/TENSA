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
"""

from __future__ import annotations

import asyncio
import logging
import socket
import threading
import time
from collections.abc import Awaitable, Callable
from types import ModuleType

import uvicorn

INSTALL_HINT = "pip install 'tensa[desktop]'"

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


def load_webview() -> ModuleType:
    """Import pywebview, or raise ``DesktopUnavailable`` saying how to get it."""
    try:
        import webview
    except ImportError as exc:
        raise DesktopUnavailable(
            f"tensa desktop needs pywebview, which could not be imported ({exc}). "
            f"Install it with: {INSTALL_HINT}"
        ) from exc
    module: ModuleType = webview
    return module


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
    close: Callable[[], Awaitable[None]] | None = None,
    start_timeout: float = 60.0,
    stop_timeout: float = 30.0,
) -> None:
    """Serve on ``sock`` in a thread and show ``url`` in a window until it closes.

    ``close`` is a coroutine function that ends the sessions; it runs on the
    server's event loop once the window has closed, before the server is asked to
    exit. Returns when the window has closed and the server has stopped (or has not
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
            webview.start(debug=devtools)
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
