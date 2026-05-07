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
import sys
from pathlib import Path

import typer
import uvicorn

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

    fastapi_app = make_app(
        expected_token=token.value,
        workspace=canonical_workspace,
        bind_host=bind,
        bind_port=port,
        max_sessions=max_sessions,
        idle_timeout_seconds=idle_timeout_seconds,
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
