# Changelog

All notable changes to TENSA are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project adheres to semantic versioning once 1.0 lands.

## [Unreleased]

### Added
- `tensa --version` prints the tensa and ANDES versions.
- Agent-evaluation example: a PowerAgentBench-SS-style budgeted N-2 screening study on IEEE 39-bus (`examples/contingency_screening/`) with an exhaustive API-computed oracle, scripted baselines, an audited LLM-agent run, and scoring. Line elements now accept edits to the connection-status parameter `u`, so contingency studies can outage a branch through the API or inspector.

### Fixed
- `tensa serve` with the default OS-assigned port (`--port 0`) rejected the web UI's own requests with `400 bad-origin`: the Host/Origin allow-list was built from port 0 before the real port existed, so the browser's `Origin: http://127.0.0.1:<port>` never matched. The server now binds its listening socket first, builds the allow-list from the real port, and serves on that same socket, so the printed URL always works. `--open` now works with any port, including the default (it used to refuse port 0), and `--reload` with port 0 picks a free port up front. On Windows the socket asks for exclusive use of the port instead of `SO_REUSEADDR`, which there lets another process share it.
- The time-domain step size `h` was silently ignored: it was written to `TDS.config.h`, which ANDES never reads, so every run used the 1/30 s default. `h` now sets `TDS.config.tstep`, and the trapezoidal integrator steps at exactly the requested size in batch runs, streaming runs, and sweeps. The TDS report now shows the step actually used. The QNDF integrator still chooses its own step (ANDES ignores `tstep` there), so bound it with `max_step`. The API and UI wording for `h` now says so and no longer claims a 1/120 s default.
- Workspace path handling on macOS: the lookup that canonicalizes case files called libc's variadic `fcntl` through ctypes without a prototype, which passes the buffer where the callee does not look on Apple Silicon, so loading a case could fail there. It now uses the standard-library `fcntl`. The workspace root and the parent folders of files written back (layout sidecars, saves) are canonicalized the same way, so `--workspace ~/Cases` on a folder stored as `~/cases`, or with a different Unicode normalization, no longer rejects every load as outside the workspace.
- Workspace paths that cannot be resolved now return a 4xx instead of a 500: permission denied on a parent folder (layout read/write), and on Windows a missing file or an invalid file name (`WinError 123`) when loading a case.

## [0.4.0] — 2026-07-05

### Changed
- **Renamed the project from "ANDES App" to TENSA** (Transients, Eigenvalues & Network Simulation Application). The Python package, CLI command (`tensa serve`), MCP server, default workspace directory (`~/.tensa/cases`), and repository (github.com/Roger-GO/TENSA) all follow. ANDES remains the simulation engine and is credited unchanged; only this project's own identity changed. Existing installs: reinstall with `pip install -e ./server` and move cases from `~/.andes-app/` if you used the default workspace.

### Added
- Showcase demo: a captioned video of an agent building WSCC 9-bus from scratch through the UI and running every analysis, embedded in a rewritten, production-ready README.
- First-run example cases: an empty workspace is auto-seeded with IEEE-14, Kundur, and WSCC-9.

### Changed
- Relicensed from MIT to **GNU GPL v3.0** to match ANDES, which TENSA is built on. Added an ANDES citation (Cui et al., 2021) to the README.
- GENROU exposes its full subtransient reactance + time-constant set, with d/q reactance-ordering validation that names the offending value (prevents textbook transient values silently clashing with unset subtransient defaults).
- Eigenvalue scatter: numeric axis ticks + gridlines, points colored by damping band with a legend, and an "All modes" filter toggle so a well-damped system isn't an empty plot.
- Bus data grid now shows net per-bus P/Q computed from the power-flow result.
- Branding: logo, favicon, and "TENSA" wordmark.

### Fixed
- Single-line diagram readability: buses render as traditional busbars; branch/feeder taps land on the bar instead of floating off it; each bus's machines and loads sit on the face pointing away from the network (a bottom bus's machine hangs below it, not up through its own feeder) with short, non-crossing stubs; edge flow labels render above bus boxes.
- Result charts: continuation-power-flow traces now get a distinct colour per bus (single-digit bus names no longer collapse into one band) with a labelled per-λ voltage readout; the eigenvalue scatter uses smaller markers, a larger plot, and a discoverable zoom/pan hint; CPF/EIG/SE charts no longer overflow and clip at the bottom of the full-screen results view.
- A crashed per-session worker now returns a clean `503` with "reload the case or start a new session" guidance instead of leaving a zombie session that errors on every call; snapshot dill-restore falls back safely instead of crashing the worker.
- Snapshot/disturbance list and layout-sidecar reads return `200` (empty/null) instead of `404`/`409`, removing browser-console error noise.
- Run-mode "Add element" panel narrowed so it no longer covers the diagram.
- TDS run badge distinguishes "Halted at t=X" (non-converged) from "Done at t=X".
- Continuation power flow no longer 500s when it doesn't converge (NaN tails are truncated to the finite curve).

## [0.3.0] — 2026-06-09

First public open-source release.

### Added
- Interactive web UI: case loading, single-line diagram (auto-layout + drag), inspector with live parameter editing, full-space results view.
- Visual model builder: add buses, lines, transformers, loads, shunts, PV/Slack generators, synchronous machines (GENROU/GENCLS), exciters (IEEEX1, ESDC2A, EXST1, SEXS), and governors (TGOV1, IEEEG1) from the UI — build a complete dynamic case from scratch without touching a file.
- Analyses: power flow, time-domain simulation (batch + live Arrow-IPC streaming), eigenvalue analysis, continuation power flow / QV curves, state estimation, PMU placement, parameter sweeps with per-iteration results.
- Disturbance editor: bus faults, breaker toggles, and parameter alters (`+ - * / =` methods), applied pre-setup with replay on reload.
- Non-blocking jobs API with progress, cancellation, and a live job-event WebSocket feed.
- Clone-on-write parameter editing with undo/redo, diff view, and save-as (xlsx/raw/dyr writers).
- Reproducibility bundles (export/import a zip of case + disturbances + sim params).
- Snapshots: save/restore named in-session system states.
- Agent/automation surface: OpenAPI at `/openapi.json`, Swagger UI at `/docs`, `llms.txt` API map, `examples/` (curl + Python client), and an optional MCP server (`tensa mcp`).

### Changed
- Removed the per-launch token auth system. The server now trusts the local OS user, binds to loopback by default, and keeps Host/Origin allow-list checks. Network exposure is explicit (`--bind`) and documented in SECURITY.md.

[0.4.0]: https://github.com/Roger-GO/TENSA/releases/tag/v0.4.0
[0.3.0]: https://github.com/Roger-GO/TENSA/releases/tag/v0.3.0
