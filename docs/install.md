# Install

TENSA is a Python package that ships with its web UI already built, so installing it with `pip` is all you need to use it. Node.js is only needed if you build the UI from source.

## Requirements

- **Python 3.12 or newer.** CI runs the server on 3.12 and 3.13.
- **Linux, macOS on Apple silicon, or Windows on x86-64.** CI runs the server on all three. Other combinations, such as an Intel Mac or Linux on ARM, are not tested. They work when `pip` can find or build the packages ANDES depends on.
- **Not supported: Windows on ARM.** TENSA needs `kvxopt` (through ANDES) and `pyarrow`, and neither publishes wheels for Windows ARM64, so `pip` would have to build them from source, which is not practical. A 64-bit x86 Python on a Windows ARM machine, which runs under emulation, has not been tested.
- A modern browser. The UI is a single-page app that the server serves itself.

## Install the package

Work in a virtual environment so TENSA and ANDES stay apart from your other Python packages.

=== "Linux and macOS"

    ```bash
    python3 -m venv .venv
    source .venv/bin/activate
    pip install tensa
    ```

=== "Windows (PowerShell)"

    ```powershell
    python -m venv .venv
    .venv\Scripts\Activate.ps1
    pip install tensa
    ```

    If PowerShell refuses to run `Activate.ps1`, allow scripts for that window only with `Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned`, then activate again. In `cmd.exe`, activate with `.venv\Scripts\activate.bat`.

`pip` pulls in ANDES, FastAPI, pyarrow and the rest. ANDES turns its model equations into Python code the first time they are needed. That takes about 10 seconds and leaves about 0.6 MB of code in `~/.andes/pycode`. `tensa serve` does it in the background when it starts. You can do it ahead of time with `tensa warm-cache`, which writes the same code and takes 10 to 25 seconds:

```bash
tensa warm-cache
```

## Check the install

```bash
tensa --version
```

prints the TENSA and ANDES versions:

```text
tensa 0.6.0
andes 2.0.0
```

Then start the server, as the [quick start](quickstart.md) does:

```bash
tensa serve --workspace ~/tensa-cases --port 8000 --open
```

If `tensa` is not found, the virtual environment is not active. `python -m tensa --version` runs the same program through the interpreter of whichever environment you are in.

## Optional extras

The MCP server, which lets an AI assistant run simulations as tools, is an optional extra:

```bash
pip install "tensa[mcp]"
```

See [Agents and MCP](agents.md) for how to connect a client.

### The Sienna engine

TENSA can run a session on a second engine, Sienna, which is written in Julia. A Sienna session needs three things on the machine: the `sienna` extra, a Julia executable, and the Sienna packages, which are not pip packages. Install the first two, then let TENSA install the third:

```bash
pip install "tensa[sienna]"
tensa warm-cache --engine sienna
```

Julia itself comes from [julialang.org](https://julialang.org/install/): the environment was resolved for Julia 1.13, and the command refuses a Julia of another minor version unless you add `--allow-julia-mismatch`. Point `TENSA_JULIA` (or `--julia`) at the executable when it is not on `PATH`. The command copies the `Project.toml` and `Manifest.toml` the package ships into the project folder (`~/.tensa/julia/dyn`, or `TENSA_SIENNA_PROJECT`, or `--project DIR`), has Julia download, install and precompile the exact package versions they pin, from Julia's registry, and then loads the engine's Julia module there once as a check. The first time, that is about 220 packages and their binary libraries, which took about 1.1 GB of Julia's package folder on Windows (0.8 GB of package sources and binary libraries, which Julia downloads compressed, and 0.35 GB of precompiled code), and several minutes or more, depending on the connection and the machine; Julia's own output shows the progress. Run again, with the packages already there, it takes under a minute. If a step fails, the command says which and exits with status 1, and the engine stays unavailable until a run succeeds. After an upgrade of TENSA that ships other package versions, a Sienna session says the environment was not set up by this version: run the command again.

The environment holds PowerSystems, PowerFlows, PowerNetworkMatrices and PowerSimulationsDynamics for the network, the power flow and the dynamics, and PowerSimulations with the HiGHS and Ipopt solvers for the economic dispatch, the optimal power flow and the unit commitment, at the exact versions the shipped Manifest pins. The size above was measured before the three operations packages joined it; they brought 34 more packages.

The first request of a Sienna session is slow even with the environment ready: Julia starts when the session's worker first needs it, never in the server process and never for an ANDES session, and the first use of each Julia function compiles it. On a Windows laptop the first case load took 56 to 84 seconds and the first power flow 40 to 47 seconds; later loads and power flows take under a second. What each engine can do once it runs is on the [Engines](engines.md) page.

### A window of its own

`tensa desktop` shows the same app in a native window instead of a browser tab. It starts the server on a free port of your machine, opens the window on it, and stops the server when you close the window. It needs the `desktop` extra, which installs [pywebview](https://pywebview.flowrl.com):

=== "Windows and macOS"

    ```bash
    pip install "tensa[desktop]"
    tensa desktop
    ```

    Windows uses the WebView2 runtime, which comes with Windows 11 and is a free download for Windows 10. macOS uses WebKit and needs nothing else.

=== "Linux"

    ```bash
    pip install "tensa[desktop]" "pywebview[qt]"
    tensa desktop
    ```

    On Linux the window needs a GUI toolkit, which pywebview does not bring. `"pywebview[qt]"` adds Qt. On X11, Qt also needs the system library `libxcb-cursor0`: `sudo apt install libxcb-cursor0` on Debian and Ubuntu, `sudo dnf install xcb-util-cursor` on Fedora, `sudo pacman -S xcb-util-cursor` on Arch. GTK with WebKitGTK from your distribution works instead of Qt.

Before it starts anything, the command checks that a window can open and says what is missing, with the command that installs it. [Troubleshooting](troubleshooting.md#tensa-desktop-does-not-open-a-window) has the messages. `tensa serve --open` shows the same app in your browser and needs none of this.

## Upgrade

```bash
pip install --upgrade tensa
```

After an upgrade of ANDES itself, ANDES regenerates its code for the new version. `tensa serve` notices and does it in the background, or run `tensa warm-cache`.

## Install from source

Use a source checkout to develop TENSA, or to build the UI yourself. You need Python 3.12 or newer and, to build the UI once, Node 22.22.2 or newer (24.15 or newer on Node 24) and [pnpm](https://pnpm.io/) 11.

=== "Linux and macOS"

    ```bash
    git clone https://github.com/Roger-GO/TENSA.git
    cd TENSA
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -e ./server
    cd web
    pnpm install
    pnpm build
    cd ..
    tensa serve --workspace ~/tensa-cases --port 8000 --open
    ```

=== "Windows (PowerShell)"

    ```powershell
    git clone https://github.com/Roger-GO/TENSA.git
    cd TENSA
    python -m venv .venv
    .venv\Scripts\Activate.ps1
    pip install -e ./server
    cd web
    pnpm install
    pnpm build
    cd ..
    tensa serve --workspace "$HOME\tensa-cases" --port 8000 --open
    ```

The editable install does not need the UI, so the install and the build can run in either order. `tensa serve` serves the UI from `web/dist`; without a build it starts with the API only and logs a warning. Building a wheel or an sdist (`python -m build server`) does need the UI built first, and says so when it is missing.

For the development workflow (the UI with hot reload, the test commands, the conventions), see [CONTRIBUTING.md](https://github.com/Roger-GO/TENSA/blob/main/CONTRIBUTING.md).

## If something fails

[Troubleshooting](troubleshooting.md) has the common install problems for each operating system: a `pip` build that fails, a missing command, a blocked activation script, a port that is taken.
