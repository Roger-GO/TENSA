"""``tensa`` command-line entry point.

Subcommands:

- ``serve`` — start the FastAPI substrate via uvicorn. Binds to loopback by
  default; there is no authentication, so non-loopback binds expose the API
  to the whole network (a stderr warning is emitted). uvicorn's default
  access log is disabled; the substrate emits its own lines to stderr via
  ``logging``, at the level ``--log-level`` sets, as plain text or, with
  ``--log-json``, as JSON lines, and ``--log-file`` adds a rotating file (see
  ``core/logging_setup.py``). Under ``--log-level debug`` it also logs one line per
  request (``api/request_log.py``), which uvicorn's access log would have. When
  ANDES's generated code is missing or unchecked, it is generated in a background
  process while the server runs (see ``core/codegen_cache.py``).
- ``desktop``: the same server in a native window (the optional ``desktop``
  extra, pywebview) instead of a browser tab, on a free loopback port; closing
  the window stops the server (see ``desktop.py``).
- ``--version`` — print the tensa and ANDES versions and exit.
- ``warm-cache`` — run ANDES's symbolic-equation code generation
  (``andes.prepare()``) so the cache is populated; ``serve`` runs it in the
  background when the cache needs it, so running it by hand is optional.
  Subsequent ``andes.load`` calls skip the cold-start prep. The cache lives at
  ``~/.andes/pycode/`` (~1.5 MB) and is shared across all ANDES cases.
"""

from __future__ import annotations

import contextlib
import enum
import logging
import multiprocessing
import os
import signal
import socket
import sys
import threading
import time
import webbrowser
from collections.abc import Callable, Iterator
from pathlib import Path
from types import FrameType
from typing import Annotated
from urllib.parse import urlparse

import typer
import uvicorn
from fastapi import FastAPI

from tensa import __version__
from tensa import andes_version as _andes_version
from tensa.api.app import make_app
from tensa.core.codegen_cache import (
    BackgroundWarm,
    mark_cache_checked,
    pycode_dir,
    start_background_warm,
)
from tensa.core.examples import seed_example_cases
from tensa.core.logging_setup import configure_logging, resolve_log_file
from tensa.desktop import (
    MIN_HEIGHT,
    MIN_WIDTH,
    DesktopUnavailable,
    ServerNotStarted,
    WindowFailed,
    check_window_support,
    load_webview,
    run_window,
    toolkit_help,
)
from tensa.security.paths import ensure_workspace

app = typer.Typer(
    name="tensa",
    help="Substrate for the ANDES power-system simulator GUI.",
    no_args_is_help=True,
)


# uvicorn's exit status for a server that never started listening; kept so
# scripts that check for it keep working now that ``serve`` binds the socket
# itself.
_STARTUP_FAILURE = 3

# Bind addresses that listen everywhere but are not valid URL hosts.
_WILDCARD_BINDS = frozenset({"0.0.0.0", "::", ""})

# ``tensa desktop`` has no ``--bind``: its window is on this machine, so the
# server listens on loopback and nowhere else.
_DESKTOP_HOST = "127.0.0.1"

# How long a server that was asked to stop (Ctrl+C, SIGTERM) waits for the
# requests still being answered before it cancels them. uvicorn waits without
# end unless told otherwise, and a terminal or a service manager wants its
# answer within a few seconds.
_GRACEFUL_SHUTDOWN_SECONDS = 3

# The signals besides Ctrl+C that ask a server to stop: ``kill <pid>`` and a
# service manager send SIGTERM, and Ctrl+Break on Windows is SIGBREAK.
_STOP_SIGNALS = tuple(
    getattr(signal, name) for name in ("SIGTERM", "SIGBREAK") if hasattr(signal, name)
)


class LogLevel(enum.StrEnum):
    """The values ``--log-level`` takes (uvicorn's names for them too)."""

    debug = "debug"
    info = "info"
    warning = "warning"
    error = "error"
    critical = "critical"


# The options ``serve`` and ``desktop`` share, written once so the two commands
# cannot drift apart in name, default or help text.
_WorkspaceOption = Annotated[
    Path,
    typer.Option(
        "--workspace",
        help="Directory under which case files are stored. Created mode 0700 if missing.",
    ),
]
_MaxSessionsOption = Annotated[
    int, typer.Option("--max-sessions", help="Cap on concurrent sessions.")
]
_IdleTimeoutOption = Annotated[
    float,
    typer.Option(
        "--idle-timeout-seconds",
        help=(
            "Seconds without activity after which a session is closed. An open "
            "UI checks in every 30 seconds; keep this above 60."
        ),
    ),
]
_SweepWorkersOption = Annotated[
    int | None,
    typer.Option(
        "--sweep-workers",
        min=1,
        help=(
            "Most worker processes one sensitivity sweep may spread its iterations "
            "over. Default: the smaller of 4 and the number of CPUs. 1 runs every "
            "sweep on the session's own worker, one iteration after another. The "
            "bound is per sweep: sessions sweeping at once use that many times as "
            "many workers."
        ),
    ),
]
_NoWarmCacheOption = Annotated[
    bool,
    typer.Option(
        "--no-warm-cache",
        help=(
            "Do not check ANDES's generated code at startup. By default, when it "
            "is missing or has not been checked against the installed ANDES, the "
            "server runs ``tensa warm-cache`` in a background process. A case "
            "loaded while it runs waits for it; one loaded later does not wait "
            "for any generation."
        ),
    ),
]
_LogLevelOption = Annotated[
    LogLevel,
    typer.Option(
        "--log-level",
        case_sensitive=False,
        help=(
            "How much the server logs. info logs the startup, the serving URL and "
            "anything that goes wrong. debug adds one line for each HTTP request "
            "(method, path, status, time taken) and for each WebSocket. warning and "
            "above hide the serving URL. Upper or lower case both work."
        ),
    ),
]
_LogFileOption = Annotated[
    str | None,
    typer.Option(
        "--log-file",
        metavar="PATH",
        help=(
            "Also write the log to this file, which rotates at 5 MB and keeps three "
            "older ones. A name with no directory part, such as tensa.log, is "
            "written in ~/.tensa/logs; any other path is used as given. Created if "
            "missing; the server does not start if it cannot be written."
        ),
    ),
]
_LogJsonOption = Annotated[
    bool,
    typer.Option(
        "--log-json",
        help=(
            "Log one JSON object per line (time, level, logger, message, and "
            "exception when there is a traceback) instead of plain text, on stderr "
            "and in the --log-file."
        ),
    ),
]


def _start_logging(
    logger_name: str,
    level: LogLevel,
    *,
    json_lines: bool,
    log_file: str | None,
    write_file: bool = True,
) -> tuple[logging.Logger, Path | None]:
    """Configure the root logger from a command's logging options and return the
    command's own logger with the resolved log file path (``None`` without
    ``--log-file``). ``write_file=False`` leaves the file to another process, as
    ``serve --reload`` does.

    Raises ``typer.BadParameter`` when the file cannot be written.
    """
    log_path = resolve_log_file(log_file) if log_file is not None else None
    try:
        configure_logging(
            level=level.name.upper(),
            json_lines=json_lines,
            log_file=log_path if write_file else None,
        )
    except OSError as exc:
        raise typer.BadParameter(
            f"cannot write the log file {log_path}: {exc.strerror or exc}",
            param_hint="--log-file",
        ) from exc
    log = logging.getLogger(logger_name)
    if log_path is not None:
        log.info("writing the log to %s", log_path)
    log.debug(
        "debug logging is on: each HTTP request is logged as METHOD path -> status (time taken)"
    )
    return log, log_path


def _warn_if_windows(log: logging.Logger) -> None:
    """Windows: emit the trust-model caveat (the workspace boundary is
    best-effort there)."""
    if sys.platform == "win32":
        log.warning(
            "Windows detected: workspace path canonicalization is best-effort. "
            "ANDES secondary file reads may bypass the workspace boundary; "
            "do not load untrusted case files on Windows."
        )


def _prepare_workspace(workspace: Path, log: logging.Logger) -> Path:
    """Resolve the workspace and make sure it exists with safe permissions.

    First-run nicety: an EMPTY workspace (zero supported case files) gets a small
    set of bundled ANDES example cases so the file picker isn't blank.
    Best-effort: ``seed_example_cases`` never raises.
    """
    canonical_workspace = ensure_workspace(workspace)
    seeded = seed_example_cases(canonical_workspace)
    if seeded:
        log.info("workspace was empty; seeded example cases: %s", ", ".join(seeded))
    return canonical_workspace


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"tensa {__version__}")
        typer.echo(f"andes {_andes_version()}")
        raise typer.Exit()


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        callback=_version_callback,
        is_eager=True,
        help="Print the tensa and ANDES versions and exit.",
    ),
) -> None:
    """Forces Typer into subcommand mode so ``serve`` is required as an
    explicit argument (rather than being collapsed into the default-command
    form when there's only one command). Also hosts the eager ``--version``
    flag."""


class SessionsFirstServer(uvicorn.Server):
    """uvicorn's server, which ends the sessions before it waits for the handlers.

    Asked to stop, uvicorn waits for the requests it is answering and only then
    runs the app's shutdown, which is where the sessions are closed. A request
    that waits for a worker in the middle of a long run would hold that up for as
    long as the run takes, with its worker still running. Ended first, the
    sessions take their workers and scratch directories with them, each request
    on one is answered at once (its session is gone), and what uvicorn is left to
    wait for is short. ``tensa desktop`` does the same when its window closes
    (``run_window``'s ``close``).
    """

    def __init__(self, config: uvicorn.Config, *, app: FastAPI) -> None:
        super().__init__(config)
        self._app = app

    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        # The app's lifespan creates the manager once the server starts.
        manager = getattr(self._app.state, "session_manager", None)
        if manager is not None:
            try:
                await manager.shutdown()
            except Exception:  # noqa: BLE001 - the server must still stop
                logging.getLogger("tensa.serve").warning(
                    "could not end the sessions before the shutdown", exc_info=True
                )
        await super().shutdown(sockets=sockets)


@app.command()
def serve(
    bind: str = typer.Option(
        "127.0.0.1",
        "--bind",
        help="Interface to bind. Default loopback. Non-loopback emits a stderr warning.",
    ),
    port: int = typer.Option(
        0,
        "--port",
        help=(
            "Port to listen on. ``0`` (default) lets the OS choose; the chosen "
            "port is bound before the app is built (so the Host/Origin "
            "allow-list matches it) and printed to stderr."
        ),
    ),
    workspace: _WorkspaceOption = Path.home() / ".tensa" / "cases",
    max_sessions: _MaxSessionsOption = 4,
    idle_timeout_seconds: _IdleTimeoutOption = 180.0,
    sweep_workers: _SweepWorkersOption = None,
    allow_origin: list[str] = typer.Option(
        [],
        "--allow-origin",
        help=(
            "Additional CORS origin to accept (repeatable). Each value is added "
            "to BOTH the Host/Origin allow-list AND the FastAPI CORS allow-list "
            "so a Vite dev server (or similar) can talk to the substrate. Example: "
            "``tensa serve --allow-origin http://127.0.0.1:5173``. The host "
            "portion of each URL is also added to the Host allow-list."
        ),
    ),
    open_browser: bool = typer.Option(
        False,
        "--open",
        help=(
            "After the server starts listening, open the user's default browser "
            "at ``http://<host>:<port>/``. Works with any --port, including the "
            "default OS-assigned one."
        ),
    ),
    no_warm_cache: _NoWarmCacheOption = False,
    log_level: _LogLevelOption = LogLevel.info,
    log_file: _LogFileOption = None,
    log_json: _LogJsonOption = False,
    reload: bool = typer.Option(
        False,
        "--reload",
        help=(
            "DEV ONLY: auto-reload the server when files in the tensa "
            "package change (uvicorn reload). With the default --port 0 a "
            "free port is picked up front and reused across reloads."
        ),
    ),
) -> None:
    """Run the tensa substrate."""
    # Under ``--reload`` the server runs in a child process that opens the file
    # itself (see ``_reload_app_factory``), so two processes never rotate one file.
    log, log_path = _start_logging(
        "tensa.serve",
        log_level,
        json_lines=log_json,
        log_file=log_file,
        write_file=not reload,
    )

    _warn_if_windows(log)

    # Non-loopback bind warning (security)
    if bind not in {"127.0.0.1", "localhost", "::1"}:
        log.warning(
            "Binding to non-loopback interface %s. The API has NO authentication "
            "— anyone who can reach this interface can drive the simulator and "
            "read/write the workspace. Host/Origin checks still apply, but they "
            "do not stop direct (non-browser) clients. Only do this on a network "
            "you fully trust.",
            bind,
        )

    canonical_workspace = _prepare_workspace(workspace, log)

    # Parse --allow-origin entries into the (host, origin) pair the app
    # factory expects. We split on the URL host:port so the Host header
    # (which carries no scheme) matches alongside the Origin header (which
    # does). Validation here surfaces malformed input early; downstream code
    # works only with frozensets of strings.
    extra_hosts: set[str] = set()
    extra_origins: set[str] = set()
    for raw in allow_origin:
        parsed = urlparse(raw)
        if not parsed.scheme or not parsed.netloc:
            raise typer.BadParameter(
                f"--allow-origin expects a full URL (e.g. http://127.0.0.1:5173), got {raw!r}",
                param_hint="--allow-origin",
            )
        if parsed.scheme not in {"http", "https"}:
            raise typer.BadParameter(
                f"--allow-origin scheme must be http or https, got {parsed.scheme!r}",
                param_hint="--allow-origin",
            )
        if parsed.username is not None:
            raise typer.BadParameter(
                "--allow-origin must not contain userinfo (user@host)",
                param_hint="--allow-origin",
            )
        # Reconstruct the host portion without any userinfo so the host
        # allow-list isn't polluted with credentials-like strings.
        host_only = (
            f"{parsed.hostname}:{parsed.port}"
            if parsed.port
            else (parsed.hostname or "")
        )
        # Strip any trailing path/slash; CORS origins are scheme://host[:port].
        origin = f"{parsed.scheme}://{host_only}"
        extra_origins.add(origin)
        extra_hosts.add(host_only)
        log.info("CORS allow-origin: %s (host: %s)", origin, host_only)

    browser_host = "127.0.0.1" if bind in _WILDCARD_BINDS else bind
    url_host = f"[{browser_host}]" if ":" in browser_host else browser_host

    # ``--reload`` runs uvicorn against an import-string factory so the
    # reloader subprocess can re-import the app on source changes. The factory
    # is called with no args in the worker, so config is threaded through
    # ``ANDES_APP_RELOAD_*`` env vars set here.
    if reload:
        # uvicorn's reloader binds its own socket, so ours can't be handed
        # over; reserve a concrete port number for the factory instead (the
        # Host/Origin allow-list needs the real port). Dev only: there is a
        # small window in which another process could take the port.
        try:
            reload_port = port or _pick_free_port(bind)
        except OSError as exc:
            log.error("cannot bind %s:%s: %s", bind, port, exc)
            raise typer.Exit(code=_STARTUP_FAILURE) from exc
        os.environ["ANDES_APP_RELOAD_WORKSPACE"] = str(canonical_workspace)
        os.environ["ANDES_APP_RELOAD_BIND"] = bind
        os.environ["ANDES_APP_RELOAD_PORT"] = str(reload_port)
        os.environ["ANDES_APP_RELOAD_ORIGINS"] = ",".join(sorted(extra_origins))
        os.environ["ANDES_APP_RELOAD_HOSTS"] = ",".join(sorted(extra_hosts))
        os.environ["ANDES_APP_RELOAD_MAX_SESSIONS"] = str(max_sessions)
        os.environ["ANDES_APP_RELOAD_IDLE"] = str(idle_timeout_seconds)
        if sweep_workers is not None:
            os.environ["ANDES_APP_RELOAD_SWEEP_WORKERS"] = str(sweep_workers)
        else:
            os.environ.pop("ANDES_APP_RELOAD_SWEEP_WORKERS", None)
        os.environ["ANDES_APP_RELOAD_LOG_LEVEL"] = log_level.value
        os.environ["ANDES_APP_RELOAD_LOG_JSON"] = "1" if log_json else ""
        if log_path is not None:
            os.environ["ANDES_APP_RELOAD_LOG_FILE"] = str(log_path)
        else:
            os.environ.pop("ANDES_APP_RELOAD_LOG_FILE", None)
        watch_dir = Path(__file__).resolve().parent  # the tensa package
        log.info("dev --reload: watching %s for changes", watch_dir)
        log.info(
            "serving http://%s:%s/ (workspace: %s)",
            url_host,
            reload_port,
            canonical_workspace,
        )
        if open_browser:
            # The reloader owns the server, so there is no handle to ask; probe
            # the port instead.
            _spawn_open_browser_watcher(
                url=f"http://{url_host}:{reload_port}/",
                is_ready=lambda: _accepts_connections(browser_host, reload_port),
                log=log,
            )
        with _background_codegen_warmup(enabled=not no_warm_cache, log=log):
            uvicorn.run(
                "tensa.cli:_reload_app_factory",
                factory=True,
                reload=True,
                reload_dirs=[str(watch_dir)],
                host=bind,
                port=reload_port,
                log_level=log_level.value,
                access_log=False,
                timeout_graceful_shutdown=_GRACEFUL_SHUTDOWN_SECONDS,
            )
        return

    # Bind the listening socket BEFORE building the app. With ``--port 0`` the
    # real port only exists once the socket is bound, and ``make_app`` needs it
    # to build the Host/Origin allow-list (the SPA sends
    # ``Origin: http://127.0.0.1:<real port>``). uvicorn then serves on this
    # very socket, so the port cannot change underneath the app.
    try:
        sock = _bind_listen_socket(bind, port)
    except OSError as exc:
        log.error("cannot bind %s:%s: %s", bind, port, exc)
        raise typer.Exit(code=_STARTUP_FAILURE) from exc
    bound_port = int(sock.getsockname()[1])

    fastapi_app = make_app(
        workspace=canonical_workspace,
        bind_host=bind,
        bind_port=bound_port,
        max_sessions=max_sessions,
        idle_timeout_seconds=idle_timeout_seconds,
        sweep_workers=sweep_workers,
        extra_allowed_hosts=frozenset(extra_hosts),
        extra_allowed_origins=frozenset(extra_origins),
    )

    # ``access_log=False`` disables uvicorn's default access logger; the requests are
    # logged at DEBUG by ``tensa.api.request_log`` instead, so the default level stays
    # quiet while the UI polls. ``log_config=None`` keeps uvicorn from configuring
    # logging itself, so what it logs (an unhandled exception in a route, with its
    # traceback) goes through the handlers ``configure_logging`` installed, in their
    # format and into the log file. A server asked to stop ends the sessions,
    # then gives the requests still being answered a few seconds and no more.
    server = SessionsFirstServer(
        uvicorn.Config(
            fastapi_app,
            host=bind,
            port=bound_port,
            log_level=log_level.value,
            log_config=None,
            access_log=False,
            timeout_graceful_shutdown=_GRACEFUL_SHUTDOWN_SECONDS,
        ),
        app=fastapi_app,
    )

    # uvicorn stays quiet about the address when handed a ready-made socket,
    # so this line is the one place the real URL is printed.
    log.info(
        "serving http://%s:%s/ (workspace: %s)",
        url_host,
        bound_port,
        canonical_workspace,
    )

    if open_browser:
        _spawn_open_browser_watcher(
            url=f"http://{url_host}:{bound_port}/",
            is_ready=lambda: server.started,
            log=log,
        )

    stopped_by: list[int] = []
    try:
        with (
            _stop_signals_held(server, stopped_by),
            _background_codegen_warmup(enabled=not no_warm_cache, log=log),
        ):
            server.run(sockets=[sock])
    except KeyboardInterrupt:  # pragma: no cover - interactive Ctrl+C
        pass
    finally:
        sock.close()
    if stopped_by:
        # Everything this command started has been ended: the signal now ends the
        # process the way it would have, so whoever sent it sees the same status.
        signal.raise_signal(stopped_by[-1])
    if not server.started:
        # Mirror ``uvicorn.run``: a server that never came up is a failure.
        raise typer.Exit(code=_STARTUP_FAILURE)


@contextlib.contextmanager
def _stop_signals_held(server: uvicorn.Server, received: list[int]) -> Iterator[None]:
    """Note a SIGTERM (or a Ctrl+Break) in ``received`` instead of letting it end
    the process, for as long as the block runs.

    uvicorn shuts the server down on these signals and then raises the signal
    again with the handler it found, so that the process ends as it would have
    without uvicorn. With the default handler that ends it on the spot, inside
    ``server.run``: nothing after it runs, and the background code generation is
    left running with its marker beside the cache. (Ctrl+C unwinds, as a
    ``KeyboardInterrupt``.) The handler here only notes the signal, so the block
    is left the ordinary way and the caller raises the signal once more when it
    has ended what it started. It also asks the server to exit, for a signal that
    comes before uvicorn listens for it.
    """
    # A handler can only be set from the main thread.
    if threading.current_thread() is not threading.main_thread():
        yield
        return

    def _note(signum: int, _frame: FrameType | None) -> None:
        received.append(signum)
        server.should_exit = True

    previous = {sig: signal.signal(sig, _note) for sig in _STOP_SIGNALS}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


@contextlib.contextmanager
def _background_codegen_warmup(*, enabled: bool, log: logging.Logger) -> Iterator[None]:
    """Generate ANDES's code in a child process while the server runs, if it needs
    it, and end the child when the server stops.

    Never stops the server: a warm-up that cannot start is logged and skipped.
    """
    warm: BackgroundWarm | None = None
    version = _andes_version()
    if enabled and version != "unknown":
        try:
            warm = start_background_warm(version, log)
        except Exception as exc:  # noqa: BLE001 — an optimisation must not stop the server
            log.warning("could not warm the ANDES generated code: %s", exc)
    try:
        yield
    finally:
        if warm is not None:
            warm.stop()


def _bind_listen_socket(host: str, port: int) -> socket.socket:
    """Create a TCP socket bound to ``(host, port)``; ``port=0`` lets the OS
    pick. The socket is not yet listening: uvicorn starts the listen when
    handed it via ``Server.run(sockets=[...])``, so the port is reserved from
    here on but no connection is accepted until the app is ready.

    Raises ``OSError`` if the address cannot be bound.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        _apply_bind_options(sock)
        sock.bind((host, port))
    except OSError:
        sock.close()
        raise
    return sock


def _apply_bind_options(sock: socket.socket, *, platform: str = sys.platform) -> None:
    """Set the address-reuse option appropriate to the platform.

    POSIX: ``SO_REUSEADDR`` lets a restarted server rebind a port still in
    ``TIME_WAIT``. Windows: ``SO_REUSEADDR`` means something different and lets
    another process bind the same port while we are listening, so ask for
    ``SO_EXCLUSIVEADDRUSE`` instead (when the platform exposes it).
    """
    if platform == "win32":
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive is not None:
            sock.setsockopt(socket.SOL_SOCKET, exclusive, 1)
    else:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)


def _pick_free_port(host: str) -> int:
    """Ask the OS for a free port on ``host`` (bind to 0, read it back,
    release). Only used by ``--reload``, where the socket cannot be handed to
    the server; the caller must tolerate the small window before it is
    re-bound."""
    sock = _bind_listen_socket(host, 0)
    try:
        return int(sock.getsockname()[1])
    finally:
        sock.close()


def _accepts_connections(host: str, port: int) -> bool:
    """True when something is accepting TCP connections on ``(host, port)``."""
    try:
        with socket.create_connection((host, port), timeout=0.2):
            return True
    except OSError:
        return False


def _reload_app_factory() -> FastAPI:
    """App factory for ``serve --reload`` (DEV ONLY).

    uvicorn's reloader re-imports this module in a worker subprocess and calls
    this with no args, so every config value is read from the
    ``ANDES_APP_RELOAD_*`` env vars that ``serve`` sets before ``uvicorn.run``.
    Not used on the normal (non-reload) path.

    The logging options ride along the same way. This process owns the log file
    (``serve`` opens none under ``--reload``), and uvicorn's own lines keep its
    default format, since its reloader configures them before this runs.
    """
    log_file_env = os.environ.get("ANDES_APP_RELOAD_LOG_FILE")
    configure_logging(
        level=os.environ.get("ANDES_APP_RELOAD_LOG_LEVEL", "info").upper(),
        json_lines=bool(os.environ.get("ANDES_APP_RELOAD_LOG_JSON")),
        log_file=Path(log_file_env) if log_file_env else None,
    )
    workspace = Path(os.environ["ANDES_APP_RELOAD_WORKSPACE"])
    bind = os.environ.get("ANDES_APP_RELOAD_BIND", "127.0.0.1")
    port = int(os.environ.get("ANDES_APP_RELOAD_PORT", "0"))
    origins = frozenset(
        o for o in os.environ.get("ANDES_APP_RELOAD_ORIGINS", "").split(",") if o
    )
    hosts = frozenset(
        h for h in os.environ.get("ANDES_APP_RELOAD_HOSTS", "").split(",") if h
    )
    max_sessions = int(os.environ.get("ANDES_APP_RELOAD_MAX_SESSIONS", "4"))
    idle = float(os.environ.get("ANDES_APP_RELOAD_IDLE", "180.0"))
    sweep_workers_env = os.environ.get("ANDES_APP_RELOAD_SWEEP_WORKERS")
    return make_app(
        workspace=ensure_workspace(workspace),
        bind_host=bind,
        bind_port=port,
        max_sessions=max_sessions,
        idle_timeout_seconds=idle,
        sweep_workers=int(sweep_workers_env) if sweep_workers_env else None,
        extra_allowed_hosts=hosts,
        extra_allowed_origins=origins,
    )


def _spawn_open_browser_watcher(
    *,
    url: str,
    is_ready: Callable[[], bool],
    log: logging.Logger,
    deadline_seconds: float = 30.0,
    poll_interval: float = 0.05,
) -> threading.Thread:
    """Launch a daemon thread that opens the user's browser at ``url`` once
    ``is_ready()`` turns true.

    The port is already known when this runs (``serve`` binds before building
    the app), so only readiness needs waiting for: opening the browser earlier
    would make the first request fail. A deadline keeps a server that never
    comes up from leaving the watcher polling forever.
    """

    def _watcher() -> None:
        deadline = time.monotonic() + deadline_seconds
        while not is_ready():
            if time.monotonic() >= deadline:
                log.warning(
                    "--open: server did not start listening within %.0fs",
                    deadline_seconds,
                )
                return
            time.sleep(poll_interval)
        log.info("opening browser: %s", url)
        try:
            webbrowser.open(url, new=2)
        except Exception as exc:  # pragma: no cover - platform-dependent
            log.warning("--open: webbrowser.open failed: %s", exc)

    thread = threading.Thread(target=_watcher, name="tensa-open", daemon=True)
    thread.start()
    return thread


# Window title of ``tensa desktop``.
_DESKTOP_TITLE = "TENSA"


@app.command()
def desktop(
    workspace: _WorkspaceOption = Path.home() / ".tensa" / "cases",
    max_sessions: _MaxSessionsOption = 4,
    idle_timeout_seconds: _IdleTimeoutOption = 180.0,
    sweep_workers: _SweepWorkersOption = None,
    no_warm_cache: _NoWarmCacheOption = False,
    log_level: _LogLevelOption = LogLevel.info,
    log_file: _LogFileOption = None,
    log_json: _LogJsonOption = False,
    width: int = typer.Option(
        1280,
        "--width",
        min=MIN_WIDTH,
        help=f"Width of the window in pixels, at least {MIN_WIDTH}.",
    ),
    height: int = typer.Option(
        800,
        "--height",
        min=MIN_HEIGHT,
        help=f"Height of the window in pixels, at least {MIN_HEIGHT}.",
    ),
    devtools: bool = typer.Option(
        False,
        "--devtools",
        help=(
            "Open the web inspector (the developer tools of a browser) with the "
            "window, to see why the page misbehaves."
        ),
    ),
) -> None:
    r"""Open TENSA in a window of its own instead of a browser tab.

    Starts the server on a free port of this machine, which only this machine
    can reach, shows its UI in a native window, and stops the server when the
    window is closed. The sessions and their workers end with it. Apart from
    the window, everything works as it does under "tensa serve", and the
    options that both commands have are the same.

    The window is pywebview's. Install it with pip install "tensa\[desktop]" on
    Windows and macOS, and with pip install "tensa\[desktop]" "pywebview\[qt]"
    on Linux, where the window also needs a GUI toolkit that pywebview does not
    bring: Qt, which that command adds (on X11 it needs the system library
    libxcb-cursor0), or WebKitGTK and PyGObject from the distribution (a
    virtual environment sees them only when it was created with
    --system-site-packages).

    Before it creates the workspace or starts the server, the command checks
    that a window can open here: that pywebview is installed and, on Linux,
    that there is a display and a toolkit that starts. When something is
    missing it says what, gives the command that installs it, and exits with
    status 1. "tensa serve --open" shows the same UI in a browser and needs
    none of this. Without a display, as over SSH, run "tensa serve" and open
    its address in a browser.
    """
    # A bundled executable (PyInstaller) starts each worker process by running
    # itself again with arguments only this call understands; it has to come
    # before anything else. The entry point of such an executable calls it before
    # ``typer`` parses the command line too, which would refuse those arguments.
    multiprocessing.freeze_support()

    try:
        webview = load_webview()
    except DesktopUnavailable as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=1) from exc

    # Before the workspace is made or anything listens: a machine that cannot show
    # a window should leave nothing behind (and Qt, when it cannot start, aborts
    # the whole process without a word of ours, which is why the check starts it
    # in a child process first).
    support = check_window_support()
    if support.problem is not None:
        typer.echo(support.problem, err=True)
        raise typer.Exit(code=1)

    log, _ = _start_logging(
        "tensa.desktop", log_level, json_lines=log_json, log_file=log_file
    )
    for warning in support.warnings:
        log.warning("%s", warning)
    _warn_if_windows(log)
    canonical_workspace = _prepare_workspace(workspace, log)

    # Same order as ``serve``: bind first, so the app's Host/Origin allow-list is
    # built from the port the window will really use.
    try:
        sock = _bind_listen_socket(_DESKTOP_HOST, 0)
    except OSError as exc:
        log.error("cannot bind %s: %s", _DESKTOP_HOST, exc)
        raise typer.Exit(code=_STARTUP_FAILURE) from exc
    bound_port = int(sock.getsockname()[1])
    url = f"http://{_DESKTOP_HOST}:{bound_port}/"

    try:
        fastapi_app = make_app(
            workspace=canonical_workspace,
            bind_host=_DESKTOP_HOST,
            bind_port=bound_port,
            max_sessions=max_sessions,
            idle_timeout_seconds=idle_timeout_seconds,
            sweep_workers=sweep_workers,
        )
        # The window closing must never hang the app: after five seconds uvicorn
        # stops waiting for a connection the web view has not closed and runs the
        # shutdown that ends the workers.
        server = uvicorn.Server(
            uvicorn.Config(
                fastapi_app,
                host=_DESKTOP_HOST,
                port=bound_port,
                log_level=log_level.value,
                log_config=None,
                access_log=False,
                timeout_graceful_shutdown=5,
            )
        )

        async def _end_sessions() -> None:
            # The app's lifespan creates the manager once the server starts.
            manager = getattr(fastapi_app.state, "session_manager", None)
            if manager is not None:
                await manager.shutdown()

        log.info("serving %s in a window (workspace: %s)", url, canonical_workspace)
        with _background_codegen_warmup(enabled=not no_warm_cache, log=log):
            run_window(
                webview,
                server,
                sock,
                url=url,
                title=_DESKTOP_TITLE,
                width=width,
                height=height,
                devtools=devtools,
                log=log,
                gui=support.gui,
                close=_end_sessions,
            )
    except ServerNotStarted as exc:
        log.error("%s", exc)
        raise typer.Exit(code=_STARTUP_FAILURE) from exc
    except WindowFailed as exc:
        log.error("cannot open the window: %s", exc)
        if sys.platform.startswith("linux"):
            log.error("On Linux the window needs a GUI toolkit.\n%s", toolkit_help())
        raise typer.Exit(code=1) from exc
    finally:
        sock.close()


@app.command(name="mcp")
def mcp(
    url: str | None = typer.Option(
        None,
        "--url",
        help=(
            "Attach to an already-running tensa server "
            "(e.g. http://127.0.0.1:8000)."
        ),
    ),
    workspace: Path | None = typer.Option(
        None,
        "--workspace",
        help=(
            "Spawn a private tensa server on an ephemeral loopback port "
            "serving this workspace for the lifetime of the MCP process."
        ),
    ),
) -> None:
    """Run the MCP (Model Context Protocol) stdio server for LLM agents.

    Exposes sessions, case loading, disturbances, power flow, TDS, and
    eigenanalysis as MCP tools. Requires the optional dependency:
    ``pip install 'tensa[mcp]'``. Configure your MCP client to launch::

        tensa mcp --workspace ~/andes-cases
    """
    if (url is None) == (workspace is None):
        raise typer.BadParameter("Provide exactly one of --url or --workspace.")

    from tensa.mcp_server import run as run_mcp

    run_mcp(url=url, workspace=str(workspace) if workspace is not None else None)


@app.command(name="warm-cache")
def warm_cache(
    quick: bool = typer.Option(
        False,
        "--quick",
        help=(
            "Run the faster, less-thorough code-generation pass. Useful in "
            "CI / quick smoke checks; the default is the full prep."
        ),
    ),
    incremental: bool = typer.Option(
        False,
        "--incremental",
        help=(
            "Only regenerate models whose source changed since the last "
            "prep. Faster on top of an already-warm cache."
        ),
    ),
) -> None:
    """Warm the ANDES symbolic-equation cache.

    Runs ``andes.prepare()`` against the installed ANDES version. The
    generated Python files land at ``~/.andes/pycode/`` (~1.5 MB total)
    and are shared across all ANDES cases; subsequent ``andes.load``
    calls skip the cold-start prep.

    Running this by hand is optional. Without a warm cache, the first case
    you load pays the multi-minute prep cost, so ``tensa serve`` starts this
    command in a background process when the cache is missing or has not been
    checked against the installed ANDES (``--no-warm-cache`` skips that). Run
    it yourself to have the cache ready before the server starts:

        pip install tensa
        tensa warm-cache
        tensa serve

    After an ANDES upgrade ANDES regenerates the stale code on the next
    ``andes.load``; the check at startup, or this command, does it ahead of time.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    log = logging.getLogger("tensa.warm-cache")

    import time as _time

    import andes

    log.info("ANDES version: %s", andes.__version__)
    log.info("warming cache (quick=%s, incremental=%s)…", quick, incremental)
    started = _time.monotonic()
    andes.prepare(quick=quick, incremental=incremental)
    elapsed = _time.monotonic() - started

    cache_dir = pycode_dir()
    if cache_dir.exists():
        # ``tensa serve`` skips its background check for a cache stamped like this.
        mark_cache_checked(_andes_version(), cache_dir)
        n_files = sum(1 for _ in cache_dir.iterdir() if _.is_file())
        size_bytes = sum(p.stat().st_size for p in cache_dir.iterdir() if p.is_file())
        log.info(
            "cache ready: %d files, %.1f MB at %s (%.1fs)",
            n_files,
            size_bytes / 1024 / 1024,
            cache_dir,
            elapsed,
        )
    else:
        log.warning(
            "andes.prepare() returned but %s does not exist; ANDES may use "
            "a different cache location in this environment",
            cache_dir,
        )


if __name__ == "__main__":
    app()
