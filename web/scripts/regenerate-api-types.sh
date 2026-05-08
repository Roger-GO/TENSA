#!/usr/bin/env bash
# regenerate-api-types.sh — regenerate src/api/generated.ts from a live
# substrate's /openapi.json.
#
# Strategy: spawn `andes-app serve` with a temp token + temp workspace on
# an ephemeral port (8765 by default; override via PORT env). Wait for the
# OpenAPI endpoint to respond, fetch the spec, run `pnpm exec
# openapi-typescript` against it, then kill the substrate.
#
# Pre-reqs:
# - The andes-app virtualenv is activated (or its `andes-app` is on PATH).
#   The default expectation matches AGENTS.md: `~/andes-project/.venv`.
# - `pnpm install` has already run in `web/`.
#
# Usage (from repo root):
#   ./web/scripts/regenerate-api-types.sh
#
# Override the substrate binary or port:
#   ANDES_APP=/path/to/andes-app PORT=8800 ./web/scripts/regenerate-api-types.sh
set -euo pipefail

PORT="${PORT:-8765}"
ANDES_APP="${ANDES_APP:-andes-app}"

# Resolve the web/ dir relative to this script so the script works from
# any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TMP_TOKEN_FILE="$(mktemp -t andes-regen-token.XXXXXX)"
TMP_WORKSPACE="$(mktemp -d -t andes-regen-ws.XXXXXX)"
TMP_OPENAPI="$(mktemp -t andes-regen-openapi.XXXXXX.json)"
SERVE_PID=""

cleanup() {
  if [[ -n "$SERVE_PID" ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
  fi
  rm -f "$TMP_TOKEN_FILE" "$TMP_OPENAPI"
  rm -rf "$TMP_WORKSPACE"
}
trap cleanup EXIT

echo "[regen] starting $ANDES_APP serve on port $PORT..."
"$ANDES_APP" serve \
  --port "$PORT" \
  --token-file "$TMP_TOKEN_FILE" \
  --workspace "$TMP_WORKSPACE" \
  >/dev/null 2>&1 &
SERVE_PID=$!

# Wait for the server to be ready (up to 10 seconds). We poll openapi.json
# directly — it returns 200 even unauthenticated for an OpenAPI spec on
# this substrate (and the 401 path here would be a contract change worth
# noticing at codegen time anyway).
for _ in $(seq 1 20); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/openapi.json"; then
    break
  fi
  sleep 0.5
done

if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/openapi.json"; then
  echo "[regen] substrate did not become ready on port $PORT" >&2
  exit 1
fi

TOKEN="$(cat "$TMP_TOKEN_FILE")"
echo "[regen] fetching openapi.json..."
curl -sf -H "X-Andes-Token: $TOKEN" \
  "http://127.0.0.1:$PORT/openapi.json" -o "$TMP_OPENAPI"

echo "[regen] running openapi-typescript..."
cd "$WEB_DIR"
pnpm exec openapi-typescript "$TMP_OPENAPI" -o src/api/generated.ts

echo "[regen] formatting generated file..."
pnpm exec prettier --write src/api/generated.ts >/dev/null 2>&1 || true

echo "[regen] done. src/api/generated.ts is up to date."
