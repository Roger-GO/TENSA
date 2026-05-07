# ANDES App

A web-based GUI for [ANDES](https://github.com/CURENT/andes), the open-source Python power-system simulator. Modern UX vs. legacy commercial tools (PowerWorld, PSS/E, PowerFactory) — free, web-based, cross-platform.

This repo contains **Phase A**: the substrate (Python wrapper around ANDES + FastAPI HTTP/WebSocket surface). The web UI ships as v0.1 in a separate plan.

## Status

Pre-1.0. Phase A in active development. See `docs/plans/2026-05-07-001-feat-andes-app-phase-a-substrate-plan.md` for the implementation plan.

## Quick Start

You will need Python 3.12+ and ANDES 2.0.x installed.

```bash
# 1. Activate a venv with ANDES installed
source ~/andes-project/.venv/bin/activate     # or wherever you installed andes

# 2. Install andes-app in editable mode
pip install -e ./server

# 3. Warm the ANDES cache (one-time, ~30 s on first run)
#    Generates ~/.andes/pycode/ so subsequent andes.load calls skip the
#    multi-minute cold-start prep. Run again after upgrading ANDES.
andes-app warm-cache

# 4. Run the substrate
andes-app serve --workspace ./tmp

# Reads token file path from stderr; e.g.:
#   andes-app token file: /home/<user>/.andes-app/run-12345.token
# In another shell, cat the file to get the token, then drive the API:
TOKEN=$(cat /home/<user>/.andes-app/run-12345.token)

curl -X POST -H "X-Andes-Token: $TOKEN" http://127.0.0.1:<port>/sessions
# → {"session_id": "..."}
```

The full curl-only walkthrough is in `server/tests/acceptance/walkthrough.sh` (lands in Unit 8) and proves Phase A's R3 acceptance criterion.

## Architecture

- `server/` — Python substrate (FastAPI + ANDES Python API wrapper, per-session subprocess workers, WebSocket streaming via Apache Arrow IPC)
- `docs/brainstorms/` — product requirements (origin doc)
- `docs/plans/` — implementation plans
- `docs/solutions/` — institutional learnings

## License

[MIT](./LICENSE)
