# tensa (server)

The TENSA server: a Python wrapper around ANDES with a FastAPI HTTP and WebSocket surface, plus the web UI it serves. The API is independently usable: agents, SDKs, and curl can drive ANDES through it without the UI.

Requires Python 3.12 or newer. Windows on ARM is not supported, because `kvxopt` (through ANDES) and `pyarrow` publish no wheels for it.

## Install (development)

From this directory:

```bash
python3.12 -m venv .venv
source .venv/bin/activate        # PowerShell: .venv\Scripts\Activate.ps1
pip install -e ".[dev]"          # add the MCP server with ".[dev,mcp]"
```

This pulls in ANDES (`>=2.0,<3.0`) and everything else the server needs. An editable install does not need the UI built first. `tensa serve` serves the UI from `../web/dist` when you have built it (`pnpm build` in `web/`) and runs API-only otherwise.

## Run

```bash
tensa warm-cache                  # one time: precompute the ANDES symbolic cache
tensa serve --workspace ./tmp
tensa --version                   # tensa and ANDES versions
```

The server has no authentication: it binds to loopback by default, so only processes on your machine can reach it. Stderr prints the serving URL and workspace path at startup. Interactive API docs are served at `/docs` (Swagger UI) and `/redoc`.

`tensa serve` flags:

- `--bind <addr>`: interface to bind. Default `127.0.0.1` (loopback only). Non-loopback emits a stderr warning: there is no authentication, so a non-loopback bind exposes the API to the whole network.
- `--port <int>`: port. Default OS-assigned ephemeral; printed to stderr.
- `--open`: open the default browser at the served URL once the server is listening. It works with the default OS-assigned port too.
- `--workspace <dir>`: case-file workspace root. Default `~/.tensa/cases`. Created with mode `0700` if missing.
- `--max-sessions <int>`: session-creation cap. Default `4`.
- `--idle-timeout-seconds <float>`: reap idle sessions after this many seconds. Default `180`.
- `--allow-origin <url>`: extra browser origin to accept, for example `http://127.0.0.1:5173` for the Vite dev server. Repeatable.
- `--reload`: development only. Restart the server when the package changes.

Windows: the server runs, but the workspace boundary is best-effort there (ANDES can read files outside the workspace), and `serve` logs a warning about it at startup. Do not load untrusted case files on Windows.

## Trust model

See the top-level docstring in `src/tensa/__init__.py`. Summary:

- Local OS user is trusted (case-load equals code execution).
- Loopback web origins from random browser tabs are NOT trusted (Host/Origin allow-list + strict CORS).
- There is no authentication: the server binds to loopback by default, and any local process can reach the API. Non-loopback binds expose the API to the whole network.
- Third-party case files are not trusted by the system but trusted by the user when they choose to load.
- Sandboxed case-file execution and kernel-level workspace enforcement are not implemented.

## Curl-only walkthrough

`tests/acceptance/walkthrough.sh` exercises the full end-to-end flow with curl alone, no UI. `tests/acceptance/test_walkthrough.py` starts a server and runs it, and CI runs it in the `acceptance` job.

## ANDES version coverage

See `ANDES_VERSIONS.md` for the seven API contracts the server depends on and the verification matrix per ANDES version.

## Tests

```bash
pytest -m "unit"         # fast, no I/O
pytest -m "integration"  # spawns subprocesses, hits ANDES
pytest -m "smoke"        # one real server, worker, power flow and short TDS (what macOS and Windows CI run besides the unit tests)
pytest -m "acceptance"   # full end-to-end (each test starts its own server)
pytest                   # all of the above
```

## License

[GNU GPL v3.0](../LICENSE)
