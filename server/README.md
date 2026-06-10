# andes-app (server)

Phase A substrate: Python wrapper around ANDES + FastAPI HTTP/WebSocket surface. The substrate is independently usable — agents, SDKs, and curl can drive ANDES through it without any UI.

## Install (development)

```bash
# Use a venv that has ANDES 2.0.x installed.
# If you don't have one yet:
python3.12 -m venv ~/andes-project/.venv
source ~/andes-project/.venv/bin/activate
pip install --upgrade pip
pip install andes  # >=2.0,<3.0

# Install andes-app in editable mode with dev dependencies
pip install -e ".[dev]"
```

## Run

```bash
andes-app serve --workspace ./tmp
```

The server has no authentication: it binds to loopback by default, so only processes on your machine can reach it. Stderr prints the serving URL and workspace path at startup. Interactive API docs are served at `/docs` (Swagger UI) and `/redoc`.

CLI flags:

- `--bind <addr>` — interface to bind. Default `127.0.0.1` (loopback only). Non-loopback emits a stderr warning: there is no authentication, so a non-loopback bind exposes the API to the whole network.
- `--port <int>` — port. Default OS-assigned ephemeral; printed to stderr.
- `--workspace <dir>` — case-file workspace root. Default `~/.andes-app/cases`. Created with mode `0700` if missing.
- `--max-sessions <int>` — session-creation cap. Default `min(4, max(1, cpu_count // 2))`.
- `--idle-timeout-seconds <int>` — reap idle sessions after this many seconds. Default `180`.
- `--worker-rss-limit-mb <int>` — per-worker `RLIMIT_AS` (Linux). Default `1500`.

Windows: the substrate runs but emits a stderr warning about the path-canonicalization limitation (R23 is best-effort on Windows in v0.1).

## Trust model

See the top-level docstring in `src/andes_app/__init__.py`. Summary:

- Local OS user is trusted (case-load equals code execution).
- Loopback web origins from random browser tabs are NOT trusted (Host/Origin allow-list + strict CORS).
- There is no authentication: the server binds to loopback by default, and any local process can reach the API. Non-loopback binds expose the API to the whole network.
- Third-party case files are not trusted by the system but trusted by the user when they choose to load.
- Sandboxed case-file execution and kernel-level workspace enforcement are deferred to the SaaS phase.

## Curl-only walkthrough

The Phase A acceptance test is `tests/acceptance/walkthrough.sh`. It exercises the full end-to-end flow with curl and websocat — no UI. Land in Unit 8.

## ANDES version coverage

See `ANDES_VERSIONS.md` for the seven API contracts the substrate depends on and the verification matrix per ANDES version.

## Tests

```bash
pytest -m "unit"         # fast, no I/O
pytest -m "integration"  # spawns subprocesses, hits ANDES
pytest -m "acceptance"   # full end-to-end (requires running server)
pytest                   # all of the above
```

## License

[MIT](../LICENSE)
