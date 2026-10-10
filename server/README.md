# TENSA

TENSA (Transients, Eigenvalues & Network Simulation Application) is an interactive, web-based workbench for power system modeling, simulation, and analysis, built on the [ANDES](https://github.com/CURENT/andes) simulator. You build a system in the browser, run power flow and dynamic studies with one click, watch time-domain results stream in while the run is still going, and drive the same operations from a documented HTTP and WebSocket API. It runs on your machine.

This package is the TENSA server, and it ships with the web UI already built, so `pip install tensa` is all you need. The API is independently usable: agents, SDKs, and curl can drive ANDES through it without the UI.

Requires Python 3.12 or newer. Windows on ARM is not supported, because `kvxopt` (through ANDES) and `pyarrow` publish no wheels for it.

The [documentation](https://roger-go.github.io/TENSA/) has the [install guide](https://roger-go.github.io/TENSA/install/) for each operating system, a [quick start](https://roger-go.github.io/TENSA/quickstart/), a [tour of the UI](https://roger-go.github.io/TENSA/ui-tour/) and [troubleshooting](https://roger-go.github.io/TENSA/troubleshooting/).

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

To get the app in a window of its own instead of a browser tab, install the desktop extra and run `tensa desktop` (the Desktop window section below says more, including what Linux needs besides the extra):

```bash
pip install "tensa[desktop]"       # on Linux: pip install "tensa[desktop]" "pywebview[qt]"
tensa desktop
```

## Running the server

The server has no authentication: it binds to loopback by default, so only processes on your machine can reach it. Stderr prints the serving URL and workspace path at startup. Interactive API docs are served at `/docs` (Swagger UI) and `/redoc`, and the OpenAPI schema at `/openapi.json`.

`tensa serve` flags:

- `--bind <addr>`: interface to bind. Default `127.0.0.1` (loopback only). Non-loopback emits a stderr warning: there is no authentication, so a non-loopback bind exposes the API to the whole network.
- `--port <int>`: port. Default OS-assigned ephemeral; printed to stderr.
- `--open`: open the default browser at the served URL once the server is listening. It works with the default OS-assigned port too.
- `--workspace <dir>`: case-file workspace root. Default `~/.tensa/cases`. Created with mode `0700` if missing.
- `--max-sessions <int>`: session-creation cap. Default `4`.
- `--idle-timeout-seconds <float>`: reap sessions after this many seconds without activity. A browser tab with the UI open checks in every 30 seconds, so its session lasts until the tab closes, and a tab that is closed or reloaded closes its session as it goes. Keep the value above `60` so a background tab, whose timers the browser slows down, is not caught out. Default `180`.
- `--sweep-workers <int>`: the most worker processes one sensitivity sweep may spread its iterations over. Default: the smaller of `4` and the number of CPUs. A sweep with four or more values runs on several extra workers, each given at least two values, and leaves the session's own System as it was. `1` runs every sweep on the session's own worker, one value after another. The bound applies to each sweep, not to the server: sessions sweep independently, so sweeps running in several sessions at once use that many times as many workers. On a small machine, lower it together with `--max-sessions`.
- `--allow-origin <url>`: extra browser origin to accept, for example `http://127.0.0.1:5173` for the Vite dev server. Repeatable.
- `--no-warm-cache`: skip the startup check of ANDES's generated code. ANDES turns its model equations into Python code the first time it needs them, which takes about 30 s on a laptop and would otherwise happen inside the first case you load. By default, when that code is missing or has not been checked against the installed ANDES (after an upgrade, say), `serve` generates it in a background process, the same work as `tensa warm-cache`, and logs when it finishes. A case you load while that runs waits for it, instead of generating the code a second time alongside it.
- `--log-level <level>`: how much to log: `debug`, `info`, `warning`, `error` or `critical`, in upper or lower case. Default `info`, which logs the startup, the serving URL and anything that goes wrong. `debug` adds one line for each HTTP request, such as `GET /api/sessions -> 200 (3 ms)` (the path, not the query string), and one when each WebSocket opens and one when it closes. A request the Host or Origin check turns away shows there as a 400. A level above `info` hides the serving URL.
- `--log-file <path>`: also write the log to a file, in the same format as stderr. The file rotates at 5 MB and keeps three older ones. A name with no directory part, such as `tensa.log`, is written in `~/.tensa/logs`; any other path is used as given. Missing directories are created, and the server does not start if the file cannot be written. Nothing is written to disk unless you ask.
- `--log-json`: log each line as a JSON object (`time`, `level`, `logger`, `message`, and `exception` when there is a traceback) instead of plain text, on stderr and in the log file.
- `--reload`: development only. Restart the server when the package changes.

To keep a record of what the server did, requests included, start it with `tensa serve --log-level debug --log-file tensa.log` and read `~/.tensa/logs/tensa.log` afterwards. The server logs the file's full path when it starts.

Windows: the server runs, but the workspace boundary is best-effort there (ANDES can read files outside the workspace), and `serve` logs a warning about it at startup. Do not load untrusted case files on Windows.

`GET /api/health` is the call for a script, a process supervisor or a container health check. It answers `{"status": "ok", ...}` with the tensa and ANDES versions, the number of open sessions against the `--max-sessions` cap, and whether ANDES's generated code is ready. It never waits for a worker, so it answers while a run holds every session. A worker that crashes in native code (a segfault in a numerical library, say) prints the Python stack of its threads to the server's stderr; that goes to the terminal, not into the `--log-file`.

Every response carries `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, so another page cannot put the UI in a frame.

## Desktop window

`tensa desktop` shows the app in a window of its own, for someone who would rather open a program than a web address. It starts the server on a free port of your machine, opens the window on it, and stops the server when you close the window; the sessions and their workers end with it. Everything inside the window is the same app, served by the same code as `tensa serve`.

```bash
pip install "tensa[desktop]"       # on Linux: pip install "tensa[desktop]" "pywebview[qt]"
tensa desktop --workspace ~/tensa-cases
```

The window is [pywebview](https://pywebview.flowrl.com)'s, so it uses the web view the system already has. What each system needs besides `pip install "tensa[desktop]"`:

- Windows: the WebView2 runtime, which comes with Windows 11 and is a free download for Windows 10. Nothing else.
- macOS: nothing else (it uses WebKit).
- Linux: a desktop session, because the window needs a display, and one GUI toolkit, which pywebview does not bring:
  - Qt, which pip installs when you add `"pywebview[qt]"` to the command. On X11, Qt 6 also needs a system library, `libxcb-cursor0` (`sudo apt install libxcb-cursor0` on Debian and Ubuntu, `sudo dnf install xcb-util-cursor` on Fedora, `sudo pacman -S xcb-util-cursor` on Arch).
  - GTK: WebKitGTK and PyGObject from your distribution (`sudo apt install python3-gi gir1.2-webkit2-4.1` on Debian and Ubuntu, `sudo dnf install python3-gobject webkit2gtk4.1` on Fedora, `sudo pacman -S python-gobject webkit2gtk-4.1` on Arch). A virtual environment sees them only when it was created with `python -m venv --system-site-packages`; otherwise use Qt.
  - With both installed pywebview uses GTK, or Qt in a KDE session; set `PYWEBVIEW_GUI=qt` or `PYWEBVIEW_GUI=gtk` to choose. If the one it would take does not start and the other does, `tensa desktop` uses the other.

So the one command for a first install is `pip install "tensa[desktop]"` on Windows and macOS and `pip install "tensa[desktop]" "pywebview[qt]"` on Linux, with the system package above on X11, and then `tensa desktop`. The command's own help and its messages give the same two commands.

Over SSH or on a server there is no display, so no window can open. Run `tensa serve --port 8000` there instead and open `http://127.0.0.1:8000` in a browser; over SSH, forward the port first with `ssh -L 8000:127.0.0.1:8000 <host>`.

Before it creates the workspace or starts the server, the command checks that a window can open: that pywebview is installed and, on Linux, that there is a display and that a toolkit starts. It finds the last out by starting the toolkit in a short-lived child process, because Qt does not report a missing system library as an error. It aborts the whole program (`Could not load the Qt platform plugin "xcb"`, exit status 134), which no Python code can catch but a parent process can see. When something is missing the command prints one message and exits with status 1, having created nothing. The message says what is missing, gives the command that installs it (for a system library, the one for Debian and Ubuntu, for Fedora and for Arch), and ends with the way that needs none of it: `tensa serve --open` shows the same UI in your browser. If no window can be opened after the check, the command logs why and exits with status 1 too. One message comes from outside the command:

- `pip` warns that `tensa` "does not provide the extra desktop". The copy of tensa that is installed is older than the extra (releases before 0.5.0 have none), so the extra installs nothing. Upgrade tensa with `pip install -U "tensa[desktop]"`, or install pywebview itself with `pip install "pywebview>=5,<7"`. When pywebview is missing, the message `tensa desktop` prints names whichever of the two works for the copy you have.

`tensa desktop` flags:

- `--workspace <dir>`: case-file workspace root. Default `~/.tensa/cases`. Created with mode `0700` if missing.
- `--max-sessions <int>`: session-creation cap. Default `4`.
- `--idle-timeout-seconds <float>`: reap sessions after this many seconds without activity. Default `180`.
- `--sweep-workers <int>`: the most worker processes one sensitivity sweep may spread its iterations over. Default: the smaller of `4` and the number of CPUs.
- `--no-warm-cache`: skip the startup check of ANDES's generated code, as for `tensa serve`.
- `--log-level <level>`: how much to log. Default `info`.
- `--log-file <path>`: also write the log to a rotating file; a bare name goes in `~/.tensa/logs`.
- `--log-json`: log each line as a JSON object.
- `--width <int>`: width of the window in pixels, at least `640`. Default `1280`.
- `--height <int>`: height of the window in pixels, at least `400`. Default `800`.
- `--devtools`: open the web inspector with the window, to see why the page misbehaves.

The options that `tensa serve` has too mean the same here. There is no `--bind` or `--port`: the window is on your machine, so the server listens on `127.0.0.1` and takes whatever port the system gives it. It has no authentication, as ever, so while the window is open any program on your machine can reach that port; the address is in the log at the default level. The window keeps nothing between launches (its port is different each time, and its browser data is private), so the results the page stores in the browser and its list of recent cases start empty; the workspace, the layout files and anything you saved are on disk as before. Exports (CSV, COMTRADE, HTML report, Save system as) are downloads, and the window asks where to put them.

There is no installer, signed application or bundled executable yet. Building one is future work, and what follows is an outline of it that has not been built, not a recipe known to work. A bundler has to start from a script of its own rather than the `tensa` command, because each worker is a copy of the program started again with arguments that only `multiprocessing.freeze_support()` understands, and the command-line parser would refuse them:

```python
# tensa_desktop.py
import multiprocessing
import sys

from tensa.cli import app

if __name__ == "__main__":
    multiprocessing.freeze_support()
    app(["desktop", *sys.argv[1:]])
```

```bash
pip install pyinstaller "tensa[desktop]"
pyinstaller --windowed --name TENSA --collect-all tensa --collect-all andes tensa_desktop.py
```

`--collect-all tensa` carries the built UI (`tensa/static`), and `--collect-all andes` carries ANDES, which writes its generated model code to `~/.andes/pycode` the first time it needs it. Signing the application (and, on macOS, notarizing it) and making an installer are separate work on top.

## Using the API

Anything the UI does, a script can do. A request with a JSON body needs a `Content-Type: application/json` header (with curl, `-H 'Content-Type: application/json' -d '{...}'`), or the server answers 422.

- The [API guide](https://roger-go.github.io/TENSA/api/) explains the routes, the errors and the streaming protocol, and the [route reference](https://roger-go.github.io/TENSA/reference/api/) lists every route.
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

The [documentation site](https://roger-go.github.io/TENSA/) covers the UI, the concepts, the API and the command line. The [project README](https://github.com/Roger-GO/TENSA#readme) has the feature overview and the demo video, and the [changelog](https://github.com/Roger-GO/TENSA/blob/main/CHANGELOG.md) lists what changed in each release. Report problems on the [issue tracker](https://github.com/Roger-GO/TENSA/issues).

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

`ANDES_VERSIONS.md` lists the fourteen API contracts the server depends on and the verification matrix per ANDES version.

## License

[GNU GPL v3.0](https://github.com/Roger-GO/TENSA/blob/main/LICENSE)
