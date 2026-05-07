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

Stderr prints the path to a per-launch token file (mode `0600`). Read the token from that file and pass it in the `X-Andes-Token` header on every HTTP request, or as the first WebSocket message payload (`{"type":"auth","token":"..."}`).

CLI flags:

- `--bind <addr>` — interface to bind. Default `127.0.0.1` (loopback only). Non-loopback emits a stderr warning.
- `--port <int>` — port. Default OS-assigned ephemeral; printed to stderr.
- `--workspace <dir>` — case-file workspace root. Default `~/.andes-app/cases`. Created with mode `0700` if missing.
- `--max-sessions <int>` — session-creation cap. Default `min(4, max(1, cpu_count // 2))`.
- `--idle-timeout-seconds <int>` — reap idle sessions after this many seconds. Default `180`.
- `--worker-rss-limit-mb <int>` — per-worker `RLIMIT_AS` (Linux). Default `1500`.
- `--token-file <path>` — override the per-launch token file location. Useful for CI fixtures.

Windows: the substrate runs but emits a stderr warning about the path-canonicalization limitation (R23 is best-effort on Windows in v0.1).

## Trust model

See the top-level docstring in `src/andes_app/__init__.py`. Summary:

- Local OS user is trusted (case-load equals code execution).
- Loopback web origins from random browser tabs are NOT trusted.
- Browser extensions / processes with filesystem read access can read the token file.
- Third-party case files are not trusted by the system but trusted by the user when they choose to load.
- Daily token rotation, sandboxed case-file execution, and kernel-level workspace enforcement are deferred to the SaaS phase.

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
