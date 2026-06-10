# Changelog

All notable changes to ANDES App are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project adheres to semantic versioning once 1.0 lands.

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
- Agent/automation surface: OpenAPI at `/openapi.json`, Swagger UI at `/docs`, `llms.txt` API map, `examples/` (curl + Python client), and an optional MCP server (`andes-app mcp`).

### Changed
- Removed the per-launch token auth system. The server now trusts the local OS user, binds to loopback by default, and keeps Host/Origin allow-list checks. Network exposure is explicit (`--bind`) and documented in SECURITY.md.

[0.3.0]: https://github.com/Roger-GO/ANDES_App/releases/tag/v0.3.0
