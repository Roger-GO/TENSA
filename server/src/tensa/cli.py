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
import os
import socket
import sys
import threading
import time
import webbrowser
from collections.abc import Callable, Iterator
from pathlib import Path
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


class LogLevel(enum.StrEnum):
    """The values ``--log-level`` takes (uvicorn's names for them too)."""

    debug = "debug"
    info = "info"
    warning = "warning"
    error = "error"
    critical = "critical"


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
    workspace: Path = typer.Option(
        Path.home() / ".tensa" / "cases",
        "--workspace",
        help="Directory under which case files are stored. Created mode 0700 if missing.",
    ),
    max_sessions: int = typer.Option(
        4, "--max-sessions", help="Cap on concurrent sessions."
    ),
    idle_timeout_seconds: float = typer.Option(
        180.0,
        "--idle-timeout-seconds",
        help=(
            "Sessions with no activity for this long are reaped. A browser tab "
            "with the UI open checks in every 30 seconds, so its session lives "
            "until the tab closes; keep this above 60 seconds so a background "
            "tab, whose timers the browser slows down, is not caught out."
        ),
    ),
    sweep_workers: int | None = typer.Option(
        None,
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
    no_warm_cache: bool = typer.Option(
        False,
        "--no-warm-cache",
        help=(
            "Do not check ANDES's generated code at startup. By default, when it "
            "is missing or has not been checked against the installed ANDES, the "
            "server runs ``tensa warm-cache`` in a background process. A case "
            "loaded while it runs waits for it; one loaded later does not wait "
            "for any generation."
        ),
    ),
    log_level: LogLevel = typer.Option(
        LogLevel.info,
        "--log-level",
        case_sensitive=False,
        help=(
            "How much the server logs. info logs the startup, the serving URL and "
            "anything that goes wrong. debug adds one line for each HTTP request "
            "(method, path, status, time taken) and for each WebSocket. warning and "
            "above hide the serving URL. Upper or lower case both work."
        ),
    ),
    log_file: str | None = typer.Option(
        None,
        "--log-file",
        metavar="PATH",
        help=(
            "Also write the log to this file, which rotates at 5 MB and keeps three "
            "older ones. A name with no directory part, such as tensa.log, is "
            "written in ~/.tensa/logs; any other path is used as given. Created if "
            "missing; the server does not start if it cannot be written."
        ),
    ),
    log_json: bool = typer.Option(
        False,
        "--log-json",
        help=(
            "Log one JSON object per line (time, level, logger, message, and "
            "exception when there is a traceback) instead of plain text, on stderr "
            "and in the --log-file."
        ),
    ),
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
    log_path = resolve_log_file(log_file) if log_file is not None else None
    try:
        configure_logging(
            level=log_level.name.upper(),
            json_lines=log_json,
            log_file=None if reload else log_path,
        )
    except OSError as exc:
        raise typer.BadParameter(
            f"cannot write the log file {log_path}: {exc.strerror or exc}",
            param_hint="--log-file",
        ) from exc
    log = logging.getLogger("tensa.serve")
    if log_path is not None:
        log.info("writing the log to %s", log_path)
    log.debug(
        "debug logging is on: each HTTP request is logged as METHOD path -> status (time taken)"
    )

    # Windows: emit the trust-model caveat (workspace boundary is best-effort
    # on Windows).
    if sys.platform == "win32":
        log.warning(
            "Windows detected: workspace path canonicalization is best-effort. "
            "ANDES secondary file reads may bypass the workspace boundary; "
            "do not load untrusted case files on Windows."
        )

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

    # Resolve workspace + ensure it exists with safe permissions
    canonical_workspace = ensure_workspace(workspace)

    # First-run nicety: an EMPTY workspace (zero supported case files) gets
    # a small set of bundled ANDES example cases so the file picker isn't
    # blank. Best-effort — seed_example_cases never raises.
    seeded = seed_example_cases(canonical_workspace)
    if seeded:
        log.info("workspace was empty; seeded example cases: %s", ", ".join(seeded))

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
    # format and into the log file.
    server = uvicorn.Server(
        uvicorn.Config(
            fastapi_app,
            host=bind,
            port=bound_port,
            log_level=log_level.value,
            log_config=None,
            access_log=False,
        )
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

    try:
        with _background_codegen_warmup(enabled=not no_warm_cache, log=log):
            server.run(sockets=[sock])
    except KeyboardInterrupt:  # pragma: no cover - interactive Ctrl+C
        pass
    finally:
        sock.close()
    if not server.started:
        # Mirror ``uvicorn.run``: a server that never came up is a failure.
        raise typer.Exit(code=_STARTUP_FAILURE)


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
