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

`pip` pulls in ANDES, FastAPI, pyarrow and the rest. ANDES turns its model equations into Python code the first time they are needed, which takes about 30 seconds on a laptop. `tensa serve` does that in the background when it starts, or you can do it ahead of time:

```bash
tensa warm-cache
```

## Check the install

```bash
tensa --version
```

prints the TENSA and ANDES versions:

```text
tensa 0.4.0
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

## Upgrade

```bash
pip install --upgrade tensa
```

After an upgrade of ANDES itself, ANDES regenerates its code for the new version. `tensa serve` notices and does it in the background, or run `tensa warm-cache`.

## Install from source

Use a source checkout to develop TENSA, or to build the UI yourself. You need Python 3.12 or newer and, to build the UI once, Node 22 and [pnpm](https://pnpm.io/) 11.

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
