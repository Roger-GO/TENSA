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
it, and so that pywebview is told which toolkit to use when its first choice is
not there or does not start (it tries GTK first and logs a traceback for the one
it cannot import).

An abort cannot be caught, but it can be seen from outside: ``probe_toolkit``
starts the toolkit in a child process, the way pywebview will start it here, and
reports how the child ended. A child that Qt aborted is the answer to "can a
window open", found out before the workspace is made, with Qt's own words about
what it could not load.

Every message that says how to install something takes the command from
``install_command``, and the help of ``tensa desktop`` gives the same two
commands, so what the user is told to type does not depend on where they read it.
"""

from __future__ import annotations

import asyncio
import ctypes
import importlib.metadata
import importlib.util
import logging
import os
import socket
import subprocess
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

# What pip installs for a window on Linux besides pywebview: Qt for Python, with
# its web engine. GTK with WebKitGTK works too, and comes from the distribution.
QT_REQUIREMENT = "pywebview[qt]"

# The shared library Qt 6.5 and newer loads for X11. It is the one a plain Linux
# install most often lacks, and Qt aborts the process when it cannot load it.
XCB_CURSOR_LIBRARY = "libxcb-cursor.so.0"

# The package that holds a system library, by family of distribution: pip cannot
# install these, so a message that asks for one gives all three commands.
XCB_CURSOR_INSTALL = (
    "  Debian, Ubuntu: sudo apt install libxcb-cursor0\n"
    "  Fedora:         sudo dnf install xcb-util-cursor\n"
    "  Arch:           sudo pacman -S xcb-util-cursor"
)
WEBKITGTK_INSTALL = (
    "  Debian, Ubuntu: sudo apt install python3-gi gir1.2-webkit2-4.1\n"
    "  Fedora:         sudo dnf install python3-gobject webkit2gtk4.1\n"
    "  Arch:           sudo pacman -S python-gobject webkit2gtk-4.1"
)

# The last line of every refusal: the UI does not need a window.
BROWSER_INSTEAD = (
    'To use TENSA without a window, run "tensa serve --open": it shows the same UI '
    "in your browser and needs none of this."
)

NO_DISPLAY = (
    "tensa desktop opens a window, and this session has no display (neither "
    "DISPLAY nor WAYLAND_DISPLAY is set), as over SSH or in a container. Run it "
    "from a desktop session. To use TENSA without a window, run "
    "'tensa serve --port 8000' and open http://127.0.0.1:8000 in a browser; over "
    "SSH, forward the port first: ssh -L 8000:127.0.0.1:8000 <host>."
)

# Said when the toolkit's start could not be tried in a child process (a bundled
# executable, a child that did not answer in time), so the library was only
# looked for: Qt 5 does not need it, and Qt's abort would otherwise be all there
# is to see.
QT_NEEDS_XCB_CURSOR = (
    "Qt's X11 plugin needs the system library libxcb-cursor0 (since Qt 6.5), and "
    "it was not found. If the window then fails with 'Could not load the Qt "
    "platform plugin \"xcb\"', install it: sudo apt install libxcb-cursor0 (Debian "
    "and Ubuntu), sudo dnf install xcb-util-cursor (Fedora) or sudo pacman -S "
    "xcb-util-cursor (Arch)."
)

# How long a toolkit is given to start in the child process. It takes well under
# a second; a child that takes longer than this is left alone and nothing is
# concluded from it.
PROBE_TIMEOUT = 30.0

# What the child runs for each toolkit: the imports pywebview's own platform
# module makes and, for Qt, the application object, since creating it is where Qt
# loads its platform plugin and aborts when it cannot. The first lines of the Qt
# script keep the abort from leaving a core dump, or a crash report on the
# distributions that collect them (PR_SET_DUMPABLE is 4).
_PROBE_SCRIPTS = {
    "qt": (
        "import ctypes, sys\n"
        "try:\n"
        "    ctypes.CDLL(None).prctl(4, 0)\n"
        "except Exception:\n"
        "    pass\n"
        "try:\n"
        "    from qtpy.QtWebEngineWidgets import QWebEngineView\n"
        "except ImportError as engine:\n"
        "    try:\n"
        "        from PyQt5.QtWebKitWidgets import QWebView\n"
        "    except ImportError:\n"
        "        sys.exit(f'Qt WebEngine cannot be imported: {engine}')\n"
        "from qtpy.QtWidgets import QApplication\n"
        "QApplication(['tensa-desktop-check'])\n"
        # Nothing of Qt is taken down: only whether it starts is asked.
        "import os\n"
        "os._exit(0)\n"
    ),
    "gtk": (
        "import sys\n"
        "try:\n"
        "    import gi\n"
        "    gi.require_version('Gtk', '3.0')\n"
        "    try:\n"
        "        gi.require_version('WebKit2', '4.1')\n"
        "    except ValueError:\n"
        "        gi.require_version('WebKit2', '4.0')\n"
        "    from gi.repository import Gtk, WebKit2\n"
        "except (ImportError, ValueError) as exc:\n"
        "    sys.exit(f'GTK with WebKitGTK cannot be loaded: {exc}')\n"
    ),
}

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


def install_command(*, platform: str = sys.platform, extras: list[str] | None = None) -> str:
    """The one pip command that installs what a window needs on ``platform``.

    The ``desktop`` extra brings pywebview. An install of tensa that predates the
    extra (an editable install made before it was added, say) has no such extra,
    and pip only warns about one it does not know and then installs nothing, so
    the command names pywebview itself there. On Linux pywebview brings no GUI
    toolkit, so the command adds Qt, the one pip can install. Double quotes,
    because ``cmd.exe`` passes single ones on to pip.
    """
    declared = _provided_extras() if extras is None else extras
    linux = platform.startswith("linux")
    if "desktop" in declared:
        return 'pip install "tensa[desktop]"' + (f' "{QT_REQUIREMENT}"' if linux else "")
    if not linux:
        return f'pip install "{PYWEBVIEW_REQUIREMENT}"'
    # One requirement there: pywebview with its Qt extra, inside the same bounds.
    name, _, bounds = PYWEBVIEW_REQUIREMENT.partition(">")
    return f'pip install "{name}[qt]>{bounds}"'


def install_hint(*, platform: str = sys.platform, extras: list[str] | None = None) -> str:
    """How to get pywebview, and that the UI can be used without it."""
    hint = f"Install it with: {install_command(platform=platform, extras=extras)}"
    if platform.startswith("linux"):
        hint += (
            f'\n"{QT_REQUIREMENT}" is the Qt toolkit: on Linux the window needs a GUI '
            "toolkit, which pywebview does not bring (see 'tensa desktop --help' for "
            "GTK and for what Qt needs from the system)."
        )
    return f"{hint}\n{BROWSER_INSTEAD}"


def toolkit_help(*, extras: list[str] | None = None) -> str:
    """The two ways to get a GUI toolkit on Linux, with the commands for each."""
    return (
        f"Qt: {install_command(platform='linux', extras=extras)}\n"
        "On X11, Qt also needs the system library libxcb-cursor0:\n"
        f"{XCB_CURSOR_INSTALL}\n"
        "GTK: WebKitGTK and PyGObject from the distribution (a virtual environment "
        "sees them only when it was created with --system-site-packages):\n"
        f"{WEBKITGTK_INSTALL}"
    )


def no_toolkit(*, extras: list[str] | None = None) -> str:
    """Why no window can open on a Linux machine with neither toolkit."""
    return (
        "tensa desktop cannot open a window: no GUI toolkit is installed (neither Qt "
        "for Python nor PyGObject can be imported), and on Linux pywebview does not "
        f"bring one. Install one of the two.\n{toolkit_help(extras=extras)}\n{BROWSER_INSTEAD}"
    )


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


@dataclass(frozen=True)
class ToolkitProbe:
    """How a toolkit's start in a child process ended."""

    # The child's exit status: 0 when the toolkit started, negative when a signal
    # ended it (-6 is Qt's abort).
    returncode: int
    # What the child wrote: Qt's own words about its platform plugin, or the
    # import that failed.
    output: str = ""

    @property
    def ok(self) -> bool:
        return self.returncode == 0


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


def probe_toolkit(
    toolkit: str,
    *,
    timeout: float = PROBE_TIMEOUT,
    executable: str | None = None,
    frozen: bool | None = None,
) -> ToolkitProbe | None:
    """Start ``toolkit`` (``"qt"`` or ``"gtk"``) in a child process and say how it went.

    The child is this interpreter with this environment, so it finds the modules,
    the libraries and the display the window would. None means nothing was found
    out, and is not a refusal: a bundled executable has no interpreter to run a
    script with (its ``sys.executable`` is the program itself), and a child that
    could not be started or did not end in time says nothing about the toolkit.
    """
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if is_frozen:
        return None
    try:
        done = subprocess.run(
            [executable or sys.executable, "-c", _PROBE_SCRIPTS[toolkit]],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return ToolkitProbe(returncode=done.returncode, output=(done.stderr or done.stdout).strip())


_TOOLKIT_NAMES = {"qt": "Qt", "gtk": "GTK"}


def _said(output: str, *, lines: int = 6, width: int = 300) -> str:
    """The end of what a child wrote, indented, for quoting in a message."""
    kept = [line.rstrip() for line in output.splitlines() if line.strip()][-lines:]
    return "\n".join(f"  {line[:width]}" for line in kept) or "  (it wrote nothing)"


def _lacks_xcb_cursor(probe: ToolkitProbe, library_loads: Callable[[str], bool]) -> bool:
    """Whether Qt's failed start is the missing X11 cursor library.

    Qt 6.5 and newer names the library before it aborts. An older message only
    says that the ``xcb`` plugin could not be loaded, which has other causes, so
    there the library is looked for as well.
    """
    if "xcb-cursor" in probe.output:
        return True
    return 'platform plugin "xcb"' in probe.output and not library_loads(XCB_CURSOR_LIBRARY)


def _toolkit_problem(
    failed: Mapping[str, ToolkitProbe],
    *,
    library_loads: Callable[[str], bool],
    extras: list[str] | None = None,
) -> str:
    """The refusal for a machine whose toolkits are installed and do not start:
    what each one lacks, and the command that installs it."""
    parts: list[str] = []
    for toolkit, probe in failed.items():
        if toolkit == "qt" and _lacks_xcb_cursor(probe, library_loads):
            parts.append(
                "Qt cannot start, because the system library libxcb-cursor0 is missing "
                f"(Qt 6.5 and newer need it on X11). Install it:\n{XCB_CURSOR_INSTALL}"
            )
        elif toolkit == "qt":
            parts.append(
                f"Qt cannot start. It said:\n{_said(probe.output)}\n"
                "Qt and its web engine are installed with: "
                f"{install_command(platform='linux', extras=extras)}"
            )
        else:
            parts.append(
                "PyGObject is installed, but GTK with WebKitGTK cannot be loaded. It said:\n"
                f"{_said(probe.output)}\n"
                f"Install WebKitGTK:\n{WEBKITGTK_INSTALL}"
            )
    if "qt" not in failed:
        parts.append(f"Or use Qt instead: {install_command(platform='linux', extras=extras)}")
    body = "\n".join(parts)
    return f"tensa desktop cannot open a window: {body}\n{BROWSER_INSTEAD}"


def check_window_support(
    *,
    platform: str = sys.platform,
    env: Mapping[str, str] | None = None,
    has_module: Callable[[str], bool] = _importable,
    library_loads: Callable[[str], bool] = _library_loads,
    probe: Callable[[str], ToolkitProbe | None] = probe_toolkit,
) -> WindowSupport:
    """Look for what would keep a window from opening, before anything is started.

    Windows and macOS always have a display and a web view, so only Linux is
    checked. It needs a display (or a Qt platform chosen by hand, which is how Qt
    runs without a screen) and a toolkit that starts. The installed toolkits are
    tried in the order pywebview would take them (the one ``PYWEBVIEW_GUI`` asks
    for, else Qt in a KDE session, else GTK), each in a child process (``probe``),
    and the first that starts is the one the window uses: pywebview is asked for
    it by name when it is not its own first choice, so that it does not try the
    other first and log a traceback for it, or abort in it. When none starts the
    command stops with what each one lacks.

    A probe that found nothing out (``None``) does not stop the command. For Qt
    the X11 library is then looked for, and its absence is a warning, since Qt 5
    does not need it and a Wayland session does not use the plugin that does.
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
    installed = {"gtk": has_module("gi"), "qt": has_module("qtpy")}
    if not any(installed.values()):
        return WindowSupport(problem=no_toolkit())

    # pywebview's own order: the one asked for, else Qt in a KDE session, else GTK.
    first = requested or ("qt" if "KDE_FULL_SESSION" in environment else "gtk")
    failed: dict[str, ToolkitProbe] = {}
    for toolkit in (first, "gtk" if first == "qt" else "qt"):
        if not installed[toolkit]:
            continue
        found = probe(toolkit)
        if found is not None and not found.ok:
            failed[toolkit] = found
            continue
        warnings: list[str] = []
        if requested and toolkit != requested:
            warnings.append(
                f"PYWEBVIEW_GUI asks for {_TOOLKIT_NAMES[requested]}, which is "
                + ("not installed" if requested not in failed else "installed but does not start")
                + f"; the window uses {_TOOLKIT_NAMES[toolkit]}."
            )
        if (
            toolkit == "qt"
            and found is None
            and not (wayland or chosen_qpa)
            and not library_loads(XCB_CURSOR_LIBRARY)
        ):
            warnings.append(QT_NEEDS_XCB_CURSOR)
        return WindowSupport(warnings=tuple(warnings), gui=None if toolkit == first else toolkit)
    return WindowSupport(problem=_toolkit_problem(failed, library_loads=library_loads))


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
