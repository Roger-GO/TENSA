# ANDES App

**An interactive, web-based workbench for power-system modeling, simulation, and analysis.** Build a system visually, run power flow and dynamic studies with one click, watch results stream in live, and drive everything from a fully scriptable API — all running locally in your browser. ANDES App is built on the [ANDES](https://github.com/CURENT/andes) power-system simulator.

[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue)](./LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-3776ab)](https://www.python.org/)
[![Built on ANDES](https://img.shields.io/badge/built%20on-CURENT%2FANDES-2563eb)](https://github.com/CURENT/andes)
[![Agent-ready](https://img.shields.io/badge/agent--ready-llms.txt%20%2B%20MCP-8b5cf6)](./llms.txt)

![ANDES App — interactive single-line diagram with a solved power flow](docs/img/hero.jpeg)

## See it in action

An AI agent builds the WSCC 9-bus system **from scratch through the real UI** — placing every bus, line, transformer, machine, exciter, and governor; laying out the one-line; saving the case to a file and reloading it; then running power flow, a three-phase fault + streaming time-domain simulation, continuation power flow, and eigenvalue analysis.

<video src="https://github.com/Roger-GO/ANDES_App/raw/main/docs/demo/ieee9-agent-demo.mp4" poster="docs/img/hero.jpeg" controls autoplay muted loop playsinline width="100%">
  <a href="https://github.com/Roger-GO/ANDES_App/raw/main/docs/demo/ieee9-agent-demo.mp4"><img src="docs/img/demo.gif" alt="ANDES App demo — building WSCC 9-bus and running every analysis" width="100%"></a>
</video>

▶ **[Watch the full 2-minute walkthrough (MP4)](https://github.com/Roger-GO/ANDES_App/raw/main/docs/demo/ieee9-agent-demo.mp4)** — every step uses the same HTTP API any script or agent can call. You can [record it yourself](#run-the-showcase-demo-yourself).

## What you can do

- **Build a system visually** — add buses, lines, transformers, generators (static + GENROU), exciters, governors, loads, and shunts from the UI; the one-line diagram lays out automatically and is fully draggable. Build a complete dynamic case without touching a file.
- **Run five analyses, one click each** — power flow, time-domain simulation, eigenvalue / small-signal, continuation power flow (PV & QV curves), and state estimation. Each runs as a non-blocking job with live progress and cancel.
- **Watch simulations evolve live** — time-domain results stream over a WebSocket as Apache Arrow frames into interactive plots while the run is in progress, with a synchronized voltage-band overlay animating on the diagram.
- **Read the network at a glance** — traditional busbar one-line rendering with feeders, machines, and loads placed cleanly around each bus; post-power-flow voltage and MW/MVAr flow labels; voltage-violation tinting.
- **Add disturbances interactively** — bus faults, breaker toggles, and parameter changes, applied before a run and replayed on reload.
- **Edit parameters safely** — clone-on-write changes with full undo/redo and a diff view; nothing mutates the loaded case until you commit.
- **Visualize results** — voltage/angle plots, a zoom-and-pan eigenvalue scatter, PV nose curves, and residual histograms in a dedicated full-screen results view.
- **Save, reload, and reproduce** — write systems back to `xlsx`/`raw`/`json`, reload them, and export a self-contained reproducibility bundle (case + layout + results).
- **Automate everything** — a documented REST + WebSocket API with an OpenAPI schema. Anything the UI does, a script or an AI agent can do.
- **Stay local and private** — runs entirely on your machine, binds to loopback by default, no account, no telemetry.

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

[`web/scripts/agent-demo.mjs`](web/scripts/agent-demo.mjs) records the video at the top of this README by driving the real UI with Playwright — building WSCC 9-bus from scratch, then running every analysis.

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
| [`server/`](./server) | Python backend — FastAPI routers, per-session subprocess workers, Arrow streaming, clone-on-write editing, the `andes-app` CLI |
| [`web/`](./web) | React 19 + TypeScript UI — interactive SLD (React Flow), uPlot result plots, Radix UI, Tailwind v4, Zustand |
| [`examples/`](./examples) | curl + Python client walkthroughs for the API |
| [`llms.txt`](./llms.txt) | LLM-oriented API map |
| [`docs/`](./docs) | images and the demo video |

## Built on ANDES

ANDES App is built on [**CURENT/ANDES**](https://github.com/CURENT/andes), an open-source hybrid symbolic-numeric framework for power-system modeling and analysis. All power-flow and dynamic computation is performed by ANDES.

If you use ANDES App in academic work, please cite ANDES:

> H. Cui, F. Li and K. Tomsovic, "Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis," *IEEE Transactions on Power Systems*, vol. 36, no. 2, pp. 1373–1384, March 2021, doi: [10.1109/TPWRS.2020.3017019](https://doi.org/10.1109/TPWRS.2020.3017019).

```bibtex
@article{cui2021hybrid,
  author  = {Cui, Hantao and Li, Fangxing and Tomsovic, Kevin},
  title   = {Hybrid Symbolic-Numeric Framework for Power System Modeling and Analysis},
  journal = {IEEE Transactions on Power Systems},
  volume  = {36},
  number  = {2},
  pages   = {1373--1384},
  year    = {2021},
  doi     = {10.1109/TPWRS.2020.3017019}
}
```

## Contributing

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, test commands, and conventions. Guidelines for AI coding agents live in [AGENTS.md](./AGENTS.md); notable changes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## License

ANDES App is licensed under the **[GNU General Public License v3.0](./LICENSE)**, the same license as ANDES.
