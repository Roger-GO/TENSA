# Troubleshooting

Start with what the program tells you. The terminal where `tensa serve` runs prints the address it serves, the workspace it uses, and every warning and error the server raises. In the UI, the **Messages** tab lists what ANDES logged while it loaded the case and ran, and a run that fails says why in a banner or a toast. `tensa --version` prints the TENSA and ANDES versions, which a bug report needs.

The first sections are for every operating system. Sections for [Linux](#linux), [macOS](#macos) and [Windows](#windows) follow.

## Installing

### `tensa` is not found

The virtual environment you installed into is not active in this terminal. Activate it (`source .venv/bin/activate`, or `.venv\Scripts\Activate.ps1` in PowerShell), or run the program through that environment's interpreter: `python -m tensa serve ...`.

### `pip install` tries to build `kvxopt` or `pyarrow` and fails

`pip` only builds those packages from source when no ready-made wheel matches your Python and your platform, and building them is not practical. TENSA is tested on Python 3.12 and 3.13, on Linux, macOS with Apple silicon and Windows on x86-64. Check `python --version` and the architecture of the interpreter. Windows on ARM is not supported at all, because neither package publishes wheels for it. A newer Python than 3.13 can be ahead of the wheels: use 3.12 or 3.13.

### The UI is missing from a source install

`tensa serve` logs `No SPA bundle found` and `GET /` answers 404, while `/docs` and the API work. A source checkout does not carry the built UI. Run `pnpm install` and `pnpm build` in `web/` once (Node 22 and pnpm 11), or install the package with `pip install tensa`, which ships it.

## Starting the server

### The port is taken

`tensa serve` logs `cannot bind 127.0.0.1:8000` and exits with status 3 when something else holds the port. Choose another with `--port`, or leave `--port` out: the operating system then picks a free one and the server prints it.

### The browser shows a 400 error

The page or a request answers 400 with `bad-host` or `bad-origin` when you reach the server by an address it was not told about. By default it accepts `127.0.0.1` and `localhost` on its own port, and nothing else, which keeps other web pages from driving it. Use one of those two addresses. For anything else, see [Reaching the server from another machine](#reaching-the-server-from-another-machine). The same message appears when the Vite development server (`http://127.0.0.1:5173`) talks to the server without `--allow-origin http://127.0.0.1:5173`, or when you open it as `localhost:5173`.

### The workspace has no cases

An empty workspace is filled with three example cases the first time the server starts. A workspace that already holds a case file, even an unrelated one, is not filled. The list shows files with the extensions `.xlsx`, `.raw`, `.dyr`, `.m` and `.json`. Add the examples by copying cases in, dropping files on the window, or pointing `--workspace` at an empty directory.

## Using the UI

### The first case takes a long time to load

ANDES turns its model equations into Python code the first time it needs them, about 30 seconds on a laptop and longer on a slow machine, and the first case you load waits for that. `tensa warm-cache` does it ahead of time, and `tensa serve` does it in the background when the code is missing or stale, which it also is after an upgrade of ANDES. Later cases load in a moment.

### A run says the case is locked, or the Add buttons are greyed out

A power flow or a time-domain run builds the system, and ANDES takes no structural change after that. Press **Reset run** in the top bar (or in the bar of a table), which reloads the case from its file. The edits you made since opening it are discarded by that, so save the system first if you want to keep them. [Concepts](concepts.md#setup-and-the-reload-rule) has the details. In the API this is the 409 you get from `POST .../disturbances`, and `POST .../reload` is the way back.

### The power flow does not run after an eigenvalue analysis

An eigenvalue run initialises the dynamic state, and a power flow cannot start from there. Reload the case (**Reload case** beside the run button), then run the power flow.

### The power flow does not converge

The panel offers adjusted retries. By hand, raise the iteration limit, start from a flat voltage profile, or loosen the tolerance, all in the **PF** tab of the **Analysis** drawer. A case whose starting point is far from the solution often converges from a flat start. The **Messages** tab says what ANDES saw.

### A time-domain run stops early

A banner reads `TDS halted at t=...`. A near-bolted fault is a common cause: a fault with a reactance below 0.01 per unit can make a fixed-step integration diverge, and the fault form warns about it. Raise the reactance, or pick the adaptive **QNDF** integrator in the **TDS** tab. Systems with inverter-based generation can need a reactance of 0.1 or more. The **Messages** tab lists any device whose initialisation failed.

### A time-domain run has nothing to simulate

The case badge in the left rail reads `Static-only`: the case has no dynamic models, so a time-domain or eigenvalue run has nothing to integrate. A `.raw` file holds only the power flow data, and needs its `.dyr` file loaded with it. Drop both on the window together and the pair opens as one case, or choose an `.xlsx` or `.json` case that has the dynamic data in it.

### The page says `Reconnecting...` or `Cannot reach substrate`

The page lost its session. `Reconnecting...` goes away on its own. `Cannot reach substrate` stays: the server stopped, or the connection dropped for good. Check that `tensa serve` is still running, then press **Reload** in the badge. A session that sits idle for longer than `--idle-timeout-seconds` (180 s by default) is closed by the server, which a tab left open in the background can reach if the computer sleeps. The page opens a new session when it can.

### The server refuses a new session

The status 429 means the server holds its limit of sessions, four by default. Every open browser tab holds one. Close tabs you no longer use, wait for idle sessions to be closed (180 s), or start the server with a higher `--max-sessions`.

## Scripts and agents

### A request answers 422

A JSON body sent without `Content-Type: application/json` is not read, and the route answers 422. `curl -d` and the `data=` argument of `requests` do not set the header; the `json=` argument of `requests` and `httpx` does. The `detail` of the answer lists the fields at fault, and `recovery` says what to do when the problem is the state of the session.

### A script cannot reach `127.0.0.1` through a proxy

If `HTTP_PROXY` or `HTTPS_PROXY` is set, a client that honours it sends local requests to the proxy. Add the local addresses to the exclusions: `NO_PROXY=127.0.0.1,localhost`.

### The assistant does not see the MCP server

The client could not start `tensa mcp`. Give the full path to `tensa` in its configuration, from the environment where you ran `pip install "tensa[mcp]"`, and restart the client. [Agents and MCP](agents.md) has examples.

## Reaching the server from another machine

By default only the machine that runs the server can reach it. To reach it from another one:

```bash
tensa serve --workspace ~/tensa-cases --port 8000 --bind 0.0.0.0 --allow-origin http://192.168.1.20:8000
```

`--bind 0.0.0.0` listens on every interface, and `--allow-origin` names the address the other machine will type, which the server must know to accept the browser's `Origin` header. Repeat `--allow-origin` for each address in use. The server logs a warning at startup, because **there is no authentication**: anyone who can reach the port can drive the simulator, read and write the workspace, and load case files that run code. Use it only on a network you trust.

On a server with no display, an SSH tunnel is safer than a wider bind. Forward the same port number on both sides, so that the browser's `Origin` matches:

```bash
ssh -L 8000:127.0.0.1:8000 you@the-server
```

Then open `http://127.0.0.1:8000` on your own machine. With a different local port, start the server with `--allow-origin` for that origin as well. `--open` cannot open a browser on a machine that has none, so leave it out.

## Linux

- **A headless machine.** Use the SSH tunnel above and leave `--open` out.
- **`python3 -m venv` fails.** Some distributions split the module into a package, such as `python3-venv` on Debian and Ubuntu.
- **`pip` builds a package from source.** A very old `pip` cannot read the wheel tags of current packages. Upgrade it first with `python -m pip install --upgrade pip`. Linux on ARM is not a tested platform.

## macOS

- **Apple silicon is the tested platform.** CI runs on it. An Intel Mac is not tested, and `pip` may find no wheel for a package there.
- **Use a current Python from python.org or Homebrew**, not the one the system tools provide, and a virtual environment.
- **`pip` offers to compile and then fails.** Install the Xcode command line tools (`xcode-select --install`) if `pip` has to build something, and check that the interpreter is 3.12 or 3.13.

## Windows

- **Use PowerShell.** The activation script is `.venv\Scripts\Activate.ps1`. If it is refused with a message about running scripts, allow it for that window only with `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`. In `cmd.exe` use `.venv\Scripts\activate.bat`.
- **Windows on ARM is not supported.** `kvxopt` and `pyarrow` publish no wheels for it.
- **`tensa` is not recognised.** Run `python -m tensa serve ...` from the environment, or use the full path of `.venv\Scripts\tensa.exe`.
- **The server warns about the workspace.** `Windows detected: workspace path canonicalization is best-effort.` is expected. On Windows ANDES can read files outside the workspace, so do not load case files you do not trust.
- **A port that looks free is refused.** The server asks Windows for exclusive use of its port, so it fails when any other program holds the port, even one that uses it differently. Choose another `--port`.
- **A file name is refused.** The server refuses a file name that Windows could not hold, on every operating system, so that a workspace can move between them. That covers reserved device names such as `CON.raw`, a trailing dot or space, control characters, and the characters `<>:"/\|?*`. Rename the file.
- **Bash snippets.** The `curl` commands in these pages are for a POSIX shell. In PowerShell, use the [Python client](quickstart.md#the-same-from-a-script), or `Invoke-RestMethod`.

## Reporting a problem

Open an issue on [GitHub](https://github.com/Roger-GO/TENSA/issues) with the output of `tensa --version`, your operating system and Python version, the case file or a small case that shows it, what you did, and the text the server printed. If an API call failed, include its response: the problem document says what the server thinks went wrong.
