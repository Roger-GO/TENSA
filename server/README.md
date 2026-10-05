# TENSA

TENSA (Transients, Eigenvalues & Network Simulation Application) is an interactive, web-based workbench for power system modeling, simulation, and analysis, built on the [ANDES](https://github.com/CURENT/andes) simulator. You build a system in the browser, run power flow and dynamic studies with one click, watch time-domain results stream in while the run is still going, and drive the same operations from a documented HTTP and WebSocket API. It runs on your machine.

This package is the TENSA server, and it ships with the web UI already built, so `pip install tensa` is all you need. The API is independently usable: agents, SDKs, and curl can drive ANDES through it without the UI.

Requires Python 3.12 or newer. Windows on ARM is not supported, because `kvxopt` (through ANDES) and `pyarrow` publish no wheels for it.

## Quick start

```bash
pip install tensa
tensa warm-cache                  # optional: generate ANDES's code now (about 30 s)
tensa serve --workspace ~/tensa-cases --port 8000 --open
tensa --version                   # tensa and ANDES versions
```

Open the address `tensa serve` prints (`http://127.0.0.1:8000` above). On first run an empty workspace is seeded with three example cases (IEEE-14, Kundur, and WSCC-9). To use your own cases, drop `.xlsx`, `.raw`, `.dyr`, `.m` or `.json` files onto the browser window, or put them in the workspace directory, and they show up in the Saved cases list. Scripts add one with `POST /api/workspace/files?name=<file>`, sending the file's bytes as the body.

The optional MCP server exposes sessions, case loading, power flow, time-domain simulation, and disturbances as [Model Context Protocol](https://modelcontextprotocol.io) tools, so an assistant such as Claude can run simulations directly:

```bash
pip install "tensa[mcp]"
tensa mcp --workspace ~/tensa-cases
```

## Running the server

The server has no authentication: it binds to loopback by default, so only processes on your machine can reach it. Stderr prints the serving URL and workspace path at startup. Interactive API docs are served at `/docs` (Swagger UI) and `/redoc`, and the OpenAPI schema at `/openapi.json`.

`tensa serve` flags:

- `--bind <addr>`: interface to bind. Default `127.0.0.1` (loopback only). Non-loopback emits a stderr warning: there is no authentication, so a non-loopback bind exposes the API to the whole network.
- `--port <int>`: port. Default OS-assigned ephemeral; printed to stderr.
- `--open`: open the default browser at the served URL once the server is listening. It works with the default OS-assigned port too.
- `--workspace <dir>`: case-file workspace root. Default `~/.tensa/cases`. Created with mode `0700` if missing.
- `--max-sessions <int>`: session-creation cap. Default `4`.
- `--idle-timeout-seconds <float>`: reap sessions after this many seconds without activity. A browser tab with the UI open checks in every 30 seconds, so its session lasts until the tab closes. Keep the value above `60` so a background tab, whose timers the browser slows down, is not caught out. Default `180`.
- `--sweep-workers <int>`: the most worker processes one sensitivity sweep may spread its iterations over. Default: the smaller of `4` and the number of CPUs. A sweep with four or more values runs on several extra workers, each given at least two values, and leaves the session's own System as it was. `1` runs every sweep on the session's own worker, one value after another. The bound applies to each sweep, not to the server: sessions sweep independently, so sweeps running in several sessions at once use that many times as many workers. On a small machine, lower it together with `--max-sessions`.
- `--allow-origin <url>`: extra browser origin to accept, for example `http://127.0.0.1:5173` for the Vite dev server. Repeatable.
- `--no-warm-cache`: skip the startup check of ANDES's generated code. ANDES turns its model equations into Python code the first time it needs them, which takes about 30 s on a laptop and would otherwise happen inside the first case you load. By default, when that code is missing or has not been checked against the installed ANDES (after an upgrade, say), `serve` generates it in a background process, the same work as `tensa warm-cache`, and logs when it finishes. A case you load while that runs waits for it, instead of generating the code a second time alongside it.
- `--reload`: development only. Restart the server when the package changes.

Windows: the server runs, but the workspace boundary is best-effort there (ANDES can read files outside the workspace), and `serve` logs a warning about it at startup. Do not load untrusted case files on Windows.

## Using the API

Anything the UI does, a script can do. A request with a JSON body needs a `Content-Type: application/json` header (with curl, `-H 'Content-Type: application/json' -d '{...}'`), or the server answers 422.

- The [llms.txt](https://github.com/Roger-GO/TENSA/blob/main/llms.txt) API map lists the endpoints, the order they are used in, the enums, and the gotchas.
- The [examples](https://github.com/Roger-GO/TENSA/tree/main/examples) folder has a curl walkthrough and a self-contained Python client.

## Trust model

The canonical statement is the top-level docstring of [`tensa/__init__.py`](https://github.com/Roger-GO/TENSA/blob/main/server/src/tensa/__init__.py), and the [security policy](https://github.com/Roger-GO/TENSA/blob/main/SECURITY.md) summarizes it. In short:

- Local OS user is trusted (case-load equals code execution).
- Loopback web origins from random browser tabs are NOT trusted (Host/Origin allow-list + strict CORS).
- There is no authentication: the server binds to loopback by default, and any local process can reach the API. Non-loopback binds expose the API to the whole network.
- Third-party case files are not trusted by the system but trusted by the user when they choose to load.
- Sandboxed case-file execution and kernel-level workspace enforcement are not implemented.

## More

The [project README](https://github.com/Roger-GO/TENSA#readme) has the feature tour and the demo video, and the [changelog](https://github.com/Roger-GO/TENSA/blob/main/CHANGELOG.md) lists what changed in each release. Report problems on the [issue tracker](https://github.com/Roger-GO/TENSA/issues).

## Development

Work on the server from a source checkout, in the `server/` directory:

```bash
python3.12 -m venv .venv
source .venv/bin/activate        # PowerShell: .venv\Scripts\Activate.ps1
pip install -e ".[dev]"          # add the MCP server with ".[dev,mcp]"
```

This pulls in ANDES (`>=2.0,<3.0`) and everything else the server needs. An editable install does not need the UI built first. `tensa serve` serves the UI from `../web/dist` when you have built it (`pnpm build` in `web/`) and runs API-only otherwise.

```bash
pytest -m "unit"         # fast, no I/O
pytest -m "integration"  # spawns subprocesses, hits ANDES
pytest -m "smoke"        # one real server, worker, power flow and short TDS (what macOS and Windows CI run besides the unit tests)
pytest -m "acceptance"   # full end-to-end (each test starts its own server)
pytest                   # all of the above
```

`tests/acceptance/walkthrough.sh` exercises the full end-to-end flow with curl alone, no UI. `tests/acceptance/test_walkthrough.py` starts a server and runs it, and CI runs it in the `acceptance` job.

`ANDES_VERSIONS.md` lists the nine API contracts the server depends on and the verification matrix per ANDES version.

## License

[GNU GPL v3.0](https://github.com/Roger-GO/TENSA/blob/main/LICENSE)
