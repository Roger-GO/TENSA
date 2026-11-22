# TENSA

TENSA (Transients, Eigenvalues & Network Simulation Application) is a power system workbench that runs in your browser. You draw or open a case, run power flow and dynamic studies, watch the results come in, and can script all of it through an API. It is built on the [ANDES](https://github.com/CURENT/andes) simulator and can also run NREL's Sienna packages. During its beta it was called ANDES App.

[![PyPI](https://img.shields.io/pypi/v/tensa)](https://pypi.org/project/tensa/)
[![server tests](https://github.com/Roger-GO/TENSA/actions/workflows/server.yml/badge.svg?branch=main)](https://github.com/Roger-GO/TENSA/actions/workflows/server.yml)
[![web tests](https://github.com/Roger-GO/TENSA/actions/workflows/web.yml/badge.svg?branch=main)](https://github.com/Roger-GO/TENSA/actions/workflows/web.yml)
[![docs build](https://github.com/Roger-GO/TENSA/actions/workflows/docs.yml/badge.svg?branch=main)](https://github.com/Roger-GO/TENSA/actions/workflows/docs.yml)
[![Documentation](https://img.shields.io/badge/docs-roger--go.github.io%2FTENSA-0f766e)](https://roger-go.github.io/TENSA/)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](./LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-3776ab)](https://www.python.org/)
[![Built on ANDES](https://img.shields.io/badge/built%20on-CURENT%2FANDES-2563eb)](https://github.com/CURENT/andes)
[![Agent-ready](https://img.shields.io/badge/agent--ready-llms.txt%20%2B%20MCP-8b5cf6)](./llms.txt)

![TENSA showing an interactive single-line diagram with a solved power flow](docs/img/hero.jpeg)

## Why TENSA, and who it is for

TENSA is for people who want to see what a power system does without writing a program first. Students and instructors get a workbench that runs on a laptop, needs no account, and shows a system's behavior on its one-line diagram. Researchers doing exploratory dynamic studies can build or edit a case, apply a fault or a line trip, and read the result in plots, tables and the diagram, then repeat the study from a script, because everything the interface does goes through a documented API. Developers of agent-driven workflows get that same API, and an MCP server, over a real simulator. Script-first tools, ANDES itself among them, are the better choice for large batches and for writing new models; TENSA is the interactive layer around ANDES and does not replace it.

It runs five analyses, each with one click:

- **Power flow** finds the steady-state voltages, angles and line flows for the generation and load you set, and lists the limits the solution breaks.
- **Time-domain simulation** follows the system through a disturbance such as a fault or a line trip, and plots the result while it is computed.
- **Eigenvalue analysis** linearizes the system at its operating point and reports its small-signal modes, with their frequency and damping.
- **Continuation power flow** traces PV and QV curves to find how far the load can grow before the power flow has no solution.
- **State estimation** estimates the bus voltages from a set of measurements, which TENSA can generate from a solved power flow, and plots the residuals.

## Quick start

You need Python 3.12 or newer. The package on PyPI ships with the UI already built:

```bash
pip install tensa
tensa serve --open
```

That starts the server on a free port and opens your browser. The first run puts five example cases in the workspace (`~/.tensa/cases`, or wherever `--workspace` points): IEEE 14, Kundur, WSCC 9-bus, IEEE 39 and NPCC 140-bus. Open one, run a power flow, add a fault and watch a time-domain run. The [quick start](https://roger-go.github.io/TENSA/quickstart/) goes through it step by step. Use `--port 8000` if you want the same address (and the browser's saved runs) every time.

Your own cases can be dropped on the window or put in the workspace: `.xlsx`, `.raw` with its `.dyr`, `.m` or `.json`.

To get the app in a window of its own instead of a browser tab, add the desktop extra:

```bash
pip install "tensa[desktop]"
tensa desktop
```

On Linux the window also needs a GUI toolkit: `pip install "tensa[desktop]" "pywebview[qt]"`. [Install](https://roger-go.github.io/TENSA/install/#a-window-of-its-own) covers each system.

It runs on Linux, macOS (Apple silicon) and Windows with Python 3.12 or 3.13. Windows on ARM is not supported, since two dependencies publish no wheels for it. Building from source is described in [Install from source](https://roger-go.github.io/TENSA/install/#install-from-source).

## Example cases

Beyond the five that start in an empty workspace, you can add more from the app (**Example cases** in the Project tab) or with `tensa examples add <id>`: dynamic cases (Kundur with a stabiliser, WECC 179-bus, the PJM 5-bus system) and steady-state cases up to the 2,000-bus Texas synthetic grid. Each entry says where its data comes from and how to cite it; some are only links to data TENSA cannot redistribute. See [Example cases](https://roger-go.github.io/TENSA/examples/) in the documentation.

## See it in action

A scripted walkthrough of the real UI builds the WSCC 9-bus system from scratch. It places every component on the one-line, saves the case and reloads it, then runs every analysis.

[![Demo: a scripted walkthrough builds WSCC 9-bus and runs every analysis](docs/img/demo.gif)](https://github.com/Roger-GO/TENSA/raw/main/docs/demo/ieee9-agent-demo.mp4)

The clip above is sped up. [Watch the full 2-minute walkthrough (MP4)](https://github.com/Roger-GO/TENSA/raw/main/docs/demo/ieee9-agent-demo.mp4). The script that drives it, [`web/scripts/agent-demo.mjs`](web/scripts/agent-demo.mjs), calls no model: it clicks and drags through the UI with Playwright, at positions written in the script. You can record it yourself:

```bash
# Terminal 1: serve on a fixed port
tensa serve --port 18800

# Terminal 2: record (writes demo-video/ieee9-agent-demo.webm)
cd web
pnpm exec playwright install chromium
node scripts/agent-demo.mjs http://127.0.0.1:18800
```

It needs a source checkout with the UI built ([CONTRIBUTING.md](./CONTRIBUTING.md) has the setup).

## Simulation engines

Besides ANDES, TENSA can run NREL's Sienna packages (PowerSystems, PowerFlows, PowerNetworkMatrices, PowerSimulationsDynamics and PowerSimulations) through an embedded Julia. It's the optional `sienna` extra, and it needs Julia 1.13:

```bash
pip install "tensa[sienna]"
tensa warm-cache --engine sienna
```

Each session runs one engine. Run the same study in two sessions and TENSA will compare the results for you. Sienna reads PSS/E `.raw`/`.dyr` and MATPOWER `.m` files and adds network matrices, a DC power flow, economic dispatch, unit commitment and a day-ahead plus real-time simulation. ANDES stays the default, and it's the one with continuation power flow and state estimation. [Engines](https://roger-go.github.io/TENSA/engines/) says how closely the two agree and how to open an ANDES case under Sienna.

## Documentation

Everything else, from installation to the API, is at **<https://roger-go.github.io/TENSA/>**.

## For agents and scripts

The UI talks to the server through a documented HTTP and WebSocket API, and scripts and LLM agents can use the same one. The [API guide](https://roger-go.github.io/TENSA/api/) explains the routes, the errors and the streaming protocol, the OpenAPI schema is at `GET /openapi.json`, and [llms.txt](./llms.txt) is a condensed API map written for LLM consumption. [examples/](./examples/) has a curl walkthrough, a Python client, and an N-2 contingency screening study driven by scripted and LLM agents. The MCP server exposes sessions, case loading and the analyses as [Model Context Protocol](https://modelcontextprotocol.io) tools, so an assistant like Claude can run simulations directly ([Agents and MCP](https://roger-go.github.io/TENSA/agents/) shows how to connect one):

```bash
pip install "tensa[mcp]"
tensa mcp --workspace ~/tensa-cases
```

## Security

TENSA has no authentication. It binds to `127.0.0.1` (loopback) by default and trusts the local OS user, and loading a case file can run code, so load only case files you trust and use `--bind` only on a network you trust.

## Getting help

TENSA has one maintainer, so replies are best effort. [SUPPORT.md](./SUPPORT.md) has the details, including which versions are supported and what TENSA promises about ANDES versions.

- **A question:** ask in the Q&A category of [GitHub Discussions](https://github.com/Roger-GO/TENSA/discussions/categories/q-a).
- **A bug or a feature request:** open an [issue](https://github.com/Roger-GO/TENSA/issues/new/choose) with the template that fits.
- **A security problem:** report it privately through [private vulnerability reporting](https://github.com/Roger-GO/TENSA/security/advisories/new), not in a public issue. [SECURITY.md](./SECURITY.md) explains what counts.
- **Something that does not work:** [Troubleshooting](https://roger-go.github.io/TENSA/troubleshooting/) covers the usual causes, and the [documentation](https://roger-go.github.io/TENSA/) the rest.

## Citation

If you use TENSA in your work, please cite it. GitHub's "Cite this repository" button builds a citation from [CITATION.cff](./CITATION.cff), and [Citing TENSA](https://roger-go.github.io/TENSA/citing/) has the details. The short form:

> Gracia Otalvaro, R. (2026). TENSA: an interactive web workbench for power system simulation. https://github.com/Roger-GO/TENSA

TENSA runs on ANDES, which does the underlying power system computation. If you cite this project, please also credit the authors behind ANDES, the [CURENT/ANDES](https://github.com/CURENT/andes) project by Cui et al.

## Contributing

PRs are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) explains the setup, the tests and the conventions, and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) applies to everyone. For anything bigger than a small fix, open an issue or a discussion first. Notes for AI coding agents are in [AGENTS.md](./AGENTS.md), and the [changelog](./CHANGELOG.md) lists what changed.

## License

TENSA is licensed under the [GNU General Public License v3.0 or later](./LICENSE) (SPDX identifier `GPL-3.0-or-later`), the same license as ANDES.

The web UI bundles third-party libraries under their own licenses; each build writes their names, versions and license texts into `THIRD-PARTY-LICENSES.txt` beside the UI.
