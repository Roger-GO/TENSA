# ANDES App

**An interactive, web-based workbench for [ANDES](https://github.com/CURENT/andes)** — the open-source Python power-system simulator. Build, edit, simulate, and analyze power systems from your browser, with live-streaming time-domain results, an interactive single-line diagram, and a fully scriptable HTTP API designed for both humans and AI agents.

[![Built on ANDES](https://img.shields.io/badge/built%20on-CURENT%2FANDES-2563eb)](https://github.com/CURENT/andes)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-3776ab)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Agent-ready](https://img.shields.io/badge/agent--ready-llms.txt%20%2B%20MCP-8b5cf6)](./llms.txt)

ANDES App is **not a wrapper around the ANDES CLI**. It is a substrate built on the ANDES Python API that adds capabilities native ANDES does not have: visual model building, live result streaming, session management, clone-on-write parameter editing with undo/redo, and a machine-readable API surface for interoperability with other tools and AI agents.

![ANDES App — interactive single-line diagram with a solved power flow](docs/img/hero.jpeg)

## See it in action

An AI agent builds the WSCC 9-bus system **from scratch through the real UI** — placing every bus, line, transformer, machine, exciter, and governor; laying out the one-line; saving the case to a file and reloading it; then running power flow, a three-phase fault + streaming time-domain simulation, continuation power flow, and eigenvalue analysis.

[![Watch the ANDES App demo — building WSCC 9-bus and running every analysis](docs/img/demo.gif)](docs/demo/ieee9-agent-demo.mp4)

▶ **[Watch the full 2-minute walkthrough (MP4)](docs/demo/ieee9-agent-demo.mp4)** — every step uses the same HTTP API any script or LLM agent can call. You can [record it yourself](#run-the-showcase-demo-yourself).

## Why ANDES App?

ANDES is a powerful simulation engine. ANDES App turns it into an interactive, shareable, scriptable application.

| | ANDES (CLI / notebook) | **ANDES App** |
|---|---|---|
| **Build a system** | Hand-edit `xlsx`/`raw` files | Visual builder — drag buses, lines, machines, exciters, governors onto the canvas |
| **Run PFlow / TDS / EIG / CPF / SE** | Scripted, batch, blocking | One click; non-blocking jobs with live progress + cancel |
| **Watch a simulation evolve** | Wait, then plot | Live Apache-Arrow streaming into interactive plots **and** an animated voltage overlay on the diagram |
| **Add disturbances** | Edit the case file | Faults, breaker toggles, and load/parameter changes added interactively before a run |
| **Edit parameters safely** | Mutate in place | Clone-on-write editing with **undo/redo** and a diff view |
| **Visualize the network** | DIY matplotlib | Traditional one-line diagram (busbars, feeders, machines) with per-bus voltage bands |
| **See the results** | Roll your own | Voltage/angle plots, eigenvalue scatter (zoom/pan), PV nose curves, residual histograms — in a dedicated results view |
| **Share / reproduce a study** | Zip files manually | One-click reproducibility bundle (case + layout + results) export/import |
| **Drive it from other tools** | Python imports only | REST + WebSocket API with an OpenAPI schema — usable from curl, Python, MATLAB, or an LLM agent |
| **Use it from an AI agent** | — | First-class: [`llms.txt`](./llms.txt), worked [examples/](./examples/), and an [MCP server](#for-agents-and-scripts) |
| **Access remotely** | — | Serve on your LAN; any browser becomes a client |

## Features

- **Visual system builder** — add buses, lines, transformers, generators (static + GENROU), exciters, governors, loads, and shunts from the UI; the diagram lays out automatically and is fully draggable.
- **Five analyses, one click each** — power flow, time-domain simulation, eigenvalue/small-signal, continuation power flow (PV & QV curves), and state estimation. Each runs as a non-blocking job with progress and cancel.
- **Live time-domain streaming** — results stream over a WebSocket as Apache Arrow frames into interactive plots while the simulation runs, with a synchronized voltage-band overlay animating on the one-line diagram.
- **Interactive single-line diagram** — traditional busbar one-line rendering; feeders tap cleanly onto bars; machines/loads sit beside their bus; post-PF voltage and MW/MVAr flow labels; voltage-violation tinting.
- **Safe, reversible editing** — clone-on-write parameter changes with full undo/redo and a diff view; nothing mutates the loaded case until you commit.
- **Save / load / reproduce** — write systems back to `xlsx`/`raw`/`json`, reload them, and export a self-contained reproducibility bundle.
- **Built for automation** — a documented REST + WebSocket API with an OpenAPI schema; everything the UI does, a script or agent can do.
- **Local-first & private** — runs entirely on your machine, binds to loopback by default, no account, no telemetry.

## Quick start

**Requirements:** Python **3.12+**, and Node **22+ with [pnpm](https://pnpm.io/)** (Node is only needed to build the UI once).

```bash
# 0. Clone
git clone https://github.com/Roger-GO/ANDES_App.git
cd ANDES_App

# 1. Install the server (pulls in ANDES, FastAPI, pyarrow)
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -e ./server

# 2. Build the web UI (one time)
cd web && pnpm install && pnpm build && cd ..

# 3. Warm the ANDES symbolic cache (one time, ~30 s; rerun after upgrading ANDES)
andes-app warm-cache

# 4. Serve — UI and API on one port — and open the browser
andes-app serve --workspace ~/andes-cases --port 8000 --open
```

Then open **`http://127.0.0.1:8000`**. On first run an empty workspace is auto-seeded with **IEEE-14, Kundur, and WSCC-9** example cases, so there's something to open immediately. Load a case (or build one from scratch), run a power flow, add a disturbance, and stream a time-domain simulation.

> **Tip:** put your own `.xlsx` / `.raw` / `.dyr` / `.json` cases in the `--workspace` directory and they'll appear in the file picker.

## Run the showcase demo yourself

[`web/scripts/agent-demo.mjs`](web/scripts/agent-demo.mjs) records the captioned video at the top of this README by driving the real UI with Playwright — building WSCC 9-bus from scratch, then running every analysis.

```bash
# Terminal 1 — serve on a fixed port
andes-app serve --workspace ~/andes-cases --port 18800

# Terminal 2 — record (writes demo-video/ieee9-agent-demo.webm)
cd web && pnpm exec playwright install chromium   # one time
node scripts/agent-demo.mjs http://127.0.0.1:18800
```

## For agents and scripts

The entire app is driven by a documented HTTP + WebSocket API — **everything the UI can do, a script or LLM agent can do.**

- **OpenAPI schema:** `GET /openapi.json` — interactive docs at `/docs` (Swagger) and `/redoc`.
- **[llms.txt](./llms.txt)** — a condensed API map written for LLM consumption: endpoints, workflow ordering, enums, and gotchas.
- **[examples/](./examples/)** — curl walkthroughs and a self-contained Python client.
- **MCP server** — expose sessions, case loading, power flow, TDS, and disturbances as [Model Context Protocol](https://modelcontextprotocol.io) tools so assistants like Claude can run simulations directly:
  ```bash
  pip install -e './server[mcp]'
  andes-app mcp --workspace ~/andes-cases
  ```

A typical programmatic flow:

```
POST /api/sessions                         → session_id
POST /api/sessions/{id}/case               → load a case (xlsx/raw/dyr/json/m)
POST /api/sessions/{id}/disturbances       → add faults/toggles/alters (pre-setup)
POST /api/sessions/{id}/pflow              → solve power flow
POST /api/sessions/{id}/tds                → batch TDS (or stream via WS /api/ws/{id})
GET  /api/sessions/{id}/operating-point    → bus voltages / angles
```

## Development mode

```bash
# Terminal 1 — backend
andes-app serve --workspace ~/andes-cases --port 8000

# Terminal 2 — frontend with hot reload
cd web && VITE_ANDES_PORT=8000 pnpm dev    # → http://localhost:5173
```

## Network access & security

To reach the app from another machine on your network:

```bash
andes-app serve --workspace ~/andes-cases --port 8000 \
  --bind 0.0.0.0 --allow-origin http://<your-lan-ip>:8000
```

> ⚠️ **Security:** ANDES App has **no authentication**. It binds to `127.0.0.1` (loopback) by default and trusts the local OS user. Binding to a non-loopback address exposes the API — including case-file parsing, which evaluates expressions — to everyone who can reach that interface. Only do this on networks you trust, and never load untrusted case files in that mode. See [SECURITY.md](./SECURITY.md).

## Architecture

```
┌──────────────┐  REST + WebSocket   ┌───────────────────┐  multiprocessing  ┌──────────────┐
│ React 19 SPA │ ◄────────────────►  │ FastAPI substrate │ ◄──────────────►  │ ANDES worker │
│ (or any HTTP │     /api/* + /ws    │  sessions, jobs,  │   data + control  │  one System  │
│  client)     │                     │  Arrow streaming  │       pipes       │  per session │
└──────────────┘                     └───────────────────┘                   └──────────────┘
```

One `andes.System` lives per session in an isolated subprocess, so the API process never blocks on a simulation and a crashed run can't take the server down.

## Project layout

| Path | What's there |
|---|---|
| [`server/`](./server) | Python substrate — FastAPI routers, per-session subprocess workers, Arrow streaming, clone-on-write editing, the `andes-app` CLI |
| [`web/`](./web) | React 19 + TypeScript UI — interactive SLD (React Flow), uPlot result plots, Radix UI, Tailwind v4, Zustand |
| [`examples/`](./examples) | curl + Python client walkthroughs for the API |
| [`llms.txt`](./llms.txt) | LLM-oriented API map |
| [`docs/`](./docs) | images and the demo video |

## Contributing

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, test commands, and conventions. Guidelines for AI coding agents live in [AGENTS.md](./AGENTS.md); changes worth noting are tracked in [CHANGELOG.md](./CHANGELOG.md).

## Acknowledgements

ANDES App is built on top of [**CURENT/ANDES**](https://github.com/CURENT/andes) by Hantao Cui et al. All power-system modeling and numerical simulation is performed by ANDES; this project provides the interactive application layer around it.

## License

[MIT](./LICENSE)
