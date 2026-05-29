"""``andes-app`` command-line entry point.

Subcommands:

- ``serve`` — start the FastAPI substrate. Generates a per-launch token,
  writes it to a mode-``0600`` file, prints the path to stderr, then runs
  uvicorn. uvicorn's default access log is disabled; the substrate emits
  its own structured stderr lines via ``logging``.
- ``warm-cache`` — run ANDES's symbolic-equation code generation
  (``andes.prepare()``) so the cache is populated. Recommended once after
  install: subsequent ``andes.load`` calls skip the multi-minute cold-start
  prep. The cache lives at ``~/.andes/pycode/`` (~1.5 MB) and is shared
  across all ANDES cases.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

import typer
import uvicorn
from fastapi import FastAPI

from andes_app.api.app import make_app
from andes_app.security.paths import ensure_workspace
from andes_app.security.token import default_token_path, install_token

app = typer.Typer(
    name="andes-app",
    help="Substrate for the ANDES power-system simulator GUI.",
    no_args_is_help=True,
)


@app.callback()
def _root() -> None:
    """No-op callback. Forces Typer into subcommand mode so ``serve`` is
    required as an explicit argument (rather than being collapsed into the
    default-command form when there's only one command)."""


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
            "port is printed to stderr."
        ),
    ),
    workspace: Path = typer.Option(
        Path.home() / ".andes-app" / "cases",
        "--workspace",
        help="Directory under which case files are stored. Created mode 0700 if missing.",
    ),
    max_sessions: int = typer.Option(
        4, "--max-sessions", help="Per-token cap on concurrent sessions."
    ),
    idle_timeout_seconds: float = typer.Option(
        180.0,
        "--idle-timeout-seconds",
        help="Sessions with no activity for this long are reaped.",
    ),
    token_file: Path | None = typer.Option(
        None,
        "--token-file",
        help=(
            "Override the default token file location "
            "(``~/.andes-app/run-<pid>.token``). Used by tests."
        ),
    ),
    allow_origin: list[str] = typer.Option(
        [],
        "--allow-origin",
        help=(
            "Additional CORS origin to accept (repeatable). Each value is added "
            "to BOTH the Host/Origin allow-list AND the FastAPI CORS allow-list "
            "so a Vite dev server (or similar) can talk to the substrate. Example: "
            "``andes-app serve --allow-origin http://127.0.0.1:5173``. The host "
            "portion of each URL is also added to the Host allow-list."
        ),
    ),
    open_browser: bool = typer.Option(
        False,
        "--open",
        help=(
            "After the server starts listening, open the user's default browser at "
            "``http://<host>:<port>/#token=<value>`` so the UI extracts the token "
            "from the URL fragment on first load (no manual paste). The fragment "
            "is never sent to the server; the UI clears it from ``location`` on "
            "boot via ``history.replaceState``."
        ),
    ),
    no_auth: bool = typer.Option(
        False,
        "--no-auth",
        help=(
            "DEV ONLY: disable X-Andes-Token enforcement. The auth dependency "
            "stays wired on every route (OpenAPI security scheme unchanged) but "
            "is bypassed, so local debugging needs no token. Loopback bind + "
            "Host/Origin checks still apply. Never use off-loopback."
        ),
    ),
    reload: bool = typer.Option(
        False,
        "--reload",
        help=(
            "DEV ONLY: auto-reload the server when files in the andes_app "
            "package change (uvicorn reload). Requires a fixed --port."
        ),
    ),
) -> None:
    """Run the andes-app substrate."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    log = logging.getLogger("andes-app.serve")

    # Windows: emit the trust-model caveat (workspace boundary is best-effort
    # on Windows in v0.1).
    if sys.platform == "win32":
        log.warning(
            "Windows detected: workspace path canonicalization is best-effort. "
            "ANDES secondary file reads may bypass the workspace boundary; "
            "do not load untrusted case files until kernel-level enforcement "
            "lands in a future plan."
        )

    # Non-loopback bind warning (security)
    if bind not in {"127.0.0.1", "localhost", "::1"}:
        log.warning(
            "Binding to non-loopback interface %s. Per-launch token + Host/Origin "
            "checks still apply, but this exposes the substrate beyond the local "
            "machine. Consider whether this is intended.",
            bind,
        )

    # Resolve workspace + ensure it exists with safe permissions
    canonical_workspace = ensure_workspace(workspace)
    log.info("workspace: %s", canonical_workspace)

    # Install the per-launch token
    token = install_token(path=token_file or default_token_path())
    log.info("andes-app token file: %s", token.path)

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

    if no_auth:
        log.warning(
            "DEV --no-auth: X-Andes-Token enforcement is DISABLED. The auth "
            "dependency is bypassed (structure preserved); use only on a "
            "trusted loopback bind for local debugging."
        )

    # ``--reload`` runs uvicorn against an import-string factory so the
    # reloader subprocess can re-import the app on source changes. The factory
    # is called with no args in the worker, so config is threaded through
    # ``ANDES_APP_RELOAD_*`` env vars set here. With --no-auth there is no token
    # churn across reloads.
    if reload:
        os.environ["ANDES_APP_RELOAD_WORKSPACE"] = str(canonical_workspace)
        os.environ["ANDES_APP_RELOAD_BIND"] = bind
        os.environ["ANDES_APP_RELOAD_PORT"] = str(port)
        os.environ["ANDES_APP_RELOAD_NO_AUTH"] = "1" if no_auth else "0"
        os.environ["ANDES_APP_RELOAD_TOKEN"] = token.value
        os.environ["ANDES_APP_RELOAD_ORIGINS"] = ",".join(sorted(extra_origins))
        os.environ["ANDES_APP_RELOAD_HOSTS"] = ",".join(sorted(extra_hosts))
        os.environ["ANDES_APP_RELOAD_MAX_SESSIONS"] = str(max_sessions)
        os.environ["ANDES_APP_RELOAD_IDLE"] = str(idle_timeout_seconds)
        watch_dir = Path(__file__).resolve().parent  # the andes_app package
        log.info("dev --reload: watching %s for changes", watch_dir)
        uvicorn.run(
            "andes_app.cli:_reload_app_factory",
            factory=True,
            reload=True,
            reload_dirs=[str(watch_dir)],
            host=bind,
            port=port,
            log_level="info",
            access_log=False,
        )
        return

    fastapi_app = make_app(
        expected_token=token.value,
        workspace=canonical_workspace,
        bind_host=bind,
        bind_port=port,
        max_sessions=max_sessions,
        idle_timeout_seconds=idle_timeout_seconds,
        extra_allowed_hosts=frozenset(extra_hosts),
        extra_allowed_origins=frozenset(extra_origins),
        require_auth=not no_auth,
    )

    # ``--open`` sentinel: spawn a watcher thread that polls until uvicorn
    # has bound a real port (relevant when ``--port 0`` is used) and then
    # opens the user's browser at the URL-fragment handoff URL. The fragment
    # is never sent to the server; the UI extracts the token client-side and
    # clears the fragment via ``history.replaceState`` on boot.
    if open_browser:
        _spawn_open_browser_watcher(
            requested_host=bind,
            requested_port=port,
            token_value=token.value,
            log=log,
        )

    # Serve. ``access_log=False`` disables uvicorn's default access logger
    # (per the trust-model docstring; the structured logger is SaaS-phase work).
    uvicorn.run(
        fastapi_app,
        host=bind,
        port=port,
        log_level="info",
        access_log=False,
    )


def _reload_app_factory() -> FastAPI:
    """App factory for ``serve --reload`` (DEV ONLY).

    uvicorn's reloader re-imports this module in a worker subprocess and calls
    this with no args, so every config value is read from the
    ``ANDES_APP_RELOAD_*`` env vars that ``serve`` sets before ``uvicorn.run``.
    Not used on the normal (non-reload) path.
    """
    workspace = Path(os.environ["ANDES_APP_RELOAD_WORKSPACE"])
    bind = os.environ.get("ANDES_APP_RELOAD_BIND", "127.0.0.1")
    port = int(os.environ.get("ANDES_APP_RELOAD_PORT", "0"))
    no_auth = os.environ.get("ANDES_APP_RELOAD_NO_AUTH") == "1"
    token = os.environ.get("ANDES_APP_RELOAD_TOKEN", "")
    origins = frozenset(
        o for o in os.environ.get("ANDES_APP_RELOAD_ORIGINS", "").split(",") if o
    )
    hosts = frozenset(
        h for h in os.environ.get("ANDES_APP_RELOAD_HOSTS", "").split(",") if h
    )
    max_sessions = int(os.environ.get("ANDES_APP_RELOAD_MAX_SESSIONS", "4"))
    idle = float(os.environ.get("ANDES_APP_RELOAD_IDLE", "180.0"))
    return make_app(
        expected_token=token,
        workspace=ensure_workspace(workspace),
        bind_host=bind,
        bind_port=port,
        max_sessions=max_sessions,
        idle_timeout_seconds=idle,
        extra_allowed_hosts=hosts,
        extra_allowed_origins=origins,
        require_auth=not no_auth,
    )


def _spawn_open_browser_watcher(
    *,
    requested_host: str,
    requested_port: int,
    token_value: str,
    log: logging.Logger,
) -> None:
    """Launch a daemon thread that opens the user's browser once the server
    is listening on a real port.

    When ``--port 0`` was passed, the actual port is OS-assigned at bind
    time and exposed via ``app.state.bound_port`` (set by uvicorn after
    ``startup``). We poll briefly with a deadline so a server that fails to
    bind doesn't leave the watcher hung forever.
    """

    deadline_seconds = 5.0
    poll_interval = 0.05

    def _watcher() -> None:
        # Pick a host the browser can navigate to. ``0.0.0.0`` binds all
        # interfaces but isn't a valid URL host; use 127.0.0.1 in that case.
        browser_host = (
            "127.0.0.1" if requested_host in {"0.0.0.0", "::", ""} else requested_host
        )
        deadline = time.monotonic() + deadline_seconds
        bound_port = requested_port
        # If the user passed --port 0, wait for uvicorn to bind. uvicorn
        # publishes the chosen port via the server.servers[].sockets list,
        # but we don't have a handle to ``server`` here — fall back to a
        # short sleep so the user's terminal is unlikely to scroll past
        # the "listening on" line.
        if bound_port == 0:
            log.warning(
                "--open with --port 0: cannot reliably reconstruct the bound port; "
                "browser will not open automatically. Pass --port <N> to use --open."
            )
            return
        # Poll a TCP probe so we don't open the browser before the listener
        # is ready (the first request would otherwise 5xx).
        import socket
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((browser_host, bound_port), timeout=0.2):
                    break
            except OSError:
                time.sleep(poll_interval)
        else:
            log.warning("--open: server did not start listening within %.1fs", deadline_seconds)
            return
        url = f"http://{browser_host}:{bound_port}/#token={token_value}"
        log.info("opening browser: %s", url.replace(token_value, "<token>"))
        try:
            webbrowser.open(url, new=2)
        except Exception as exc:  # pragma: no cover - platform-dependent
            log.warning("--open: webbrowser.open failed: %s", exc)

    threading.Thread(target=_watcher, name="andes-app-open", daemon=True).start()


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

    The brainstorm's 5-minute first-result success criterion assumes this
    has been run; without it, the first PF after a fresh install pays the
    multi-minute prep cost. We recommend running this once during install:

        pip install andes-app
        andes-app warm-cache
        andes-app serve

    The cache is rebuilt automatically when ANDES is upgraded — but only
    on the next ``andes.load``. Run ``warm-cache`` again after upgrading
    to keep the first-result latency low.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    log = logging.getLogger("andes-app.warm-cache")

    import time as _time

    import andes

    log.info("ANDES version: %s", andes.__version__)
    log.info("warming cache (quick=%s, incremental=%s)…", quick, incremental)
    started = _time.monotonic()
    andes.prepare(quick=quick, incremental=incremental)
    elapsed = _time.monotonic() - started

    cache_dir = Path.home() / ".andes" / "pycode"
    if cache_dir.exists():
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
