#!/usr/bin/env bash
# Phase A R3 acceptance: curl-only end-to-end walkthrough of the substrate.
#
# Required env:
#   ANDES_APP_PORT       — port the substrate is listening on
#   ANDES_APP_TOKEN_FILE — path to the per-launch token file written by `serve`
#
# Required workspace state (current dir):
#   ieee14.raw + ieee14.dyr placed inside the workspace before this runs
#
# Exits 0 on success; non-zero on any unexpected response.

set -euo pipefail

PORT="${ANDES_APP_PORT:?ANDES_APP_PORT must be set}"
TOKEN_FILE="${ANDES_APP_TOKEN_FILE:?ANDES_APP_TOKEN_FILE must be set}"
TOKEN="$(cat "$TOKEN_FILE")"
BASE="http://127.0.0.1:$PORT"

curl_t() {
  curl --silent --show-error --fail-with-body \
    -H "X-Andes-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

# Tiny JSON helpers via inline python — avoids requiring jq.
jget() {
  python3 -c "import sys,json; v=json.load(sys.stdin)$1; print(v)"
}

http_status() {
  curl --silent --output /dev/null -w '%{http_code}' \
    -H "X-Andes-Token: $TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

# Substrate routes are mounted under ``/api`` (Unit 10 wheel-bundling adds
# the prefix so the SPA can own ``/``). ``/openapi.json`` stays at the root.

# 1. Create session
echo "==> POST /api/sessions"
SESSION_ID="$(curl_t -X POST "$BASE/api/sessions" | jget '["session_id"]')"
echo "    session_id=$SESSION_ID"

# 2. Negative test: client-supplied session_id is rejected with 422
echo "==> POST /api/sessions with body session_id (expect 422)"
HTTP="$(http_status -X POST "$BASE/api/sessions" -d '{"session_id":"attacker"}')"
test "$HTTP" = "422" || { echo "expected 422, got $HTTP"; exit 1; }

# 3. Load IEEE 14 (.raw + .dyr addfile)
echo "==> POST /api/sessions/{id}/case (load ieee14.raw + ieee14.dyr)"
curl_t -X POST "$BASE/api/sessions/$SESSION_ID/case" \
  -d '{"primary_path":"ieee14.raw","addfiles":["ieee14.dyr"]}' >/dev/null

# 4. Topology — expect 14 buses, pre-setup state
echo "==> GET /api/sessions/{id}/topology (expect 14 buses, state=pre-setup)"
N_BUSES="$(curl_t "$BASE/api/sessions/$SESSION_ID/topology" | jget '["buses"].__len__()')"
test "$N_BUSES" = "14" || { echo "expected 14 buses, got $N_BUSES"; exit 1; }
STATE="$(curl_t "$BASE/api/sessions/$SESSION_ID/topology" | jget '["state"]')"
test "$STATE" = "pre-setup" || { echo "expected pre-setup, got $STATE"; exit 1; }

# 5. Add disturbances (single Fault on bus 4)
echo "==> POST /api/sessions/{id}/disturbances (Fault on bus 4)"
curl_t -X POST "$BASE/api/sessions/$SESSION_ID/disturbances" -d '{
  "disturbances": [
    {"kind":"fault","bus_idx":4,"tf":1.0,"tc":1.1,"xf":0.0001,"rf":0.0}
  ]
}' >/dev/null

# 6. Run PF — expect converged
echo "==> POST /api/sessions/{id}/pflow (expect converged)"
CONVERGED="$(curl_t -X POST "$BASE/api/sessions/$SESSION_ID/pflow" -d '{}' | jget '["converged"]')"
test "$CONVERGED" = "True" || { echo "expected converged True, got $CONVERGED"; exit 1; }

# 7. Negative test: post-setup add returns 409 with /reload guidance
echo "==> POST /api/sessions/{id}/disturbances post-setup (expect 409)"
HTTP="$(http_status -X POST "$BASE/api/sessions/$SESSION_ID/disturbances" \
  -d '{"disturbances":[{"kind":"fault","bus_idx":5,"tf":2.0,"tc":2.1}]}')"
test "$HTTP" = "409" || { echo "expected 409, got $HTTP"; exit 1; }

# 8. /reload returns to pre-setup
echo "==> POST /api/sessions/{id}/reload (expect state=pre-setup)"
STATE="$(curl_t -X POST "$BASE/api/sessions/$SESSION_ID/reload" | jget '["state"]')"
test "$STATE" = "pre-setup" || { echo "expected pre-setup, got $STATE"; exit 1; }

# 9. Re-add and run TDS batch (1-second sim)
echo "==> POST /api/sessions/{id}/disturbances (after reload)"
curl_t -X POST "$BASE/api/sessions/$SESSION_ID/disturbances" \
  -d '{"disturbances":[{"kind":"fault","bus_idx":4,"tf":0.5,"tc":0.6}]}' >/dev/null

echo "==> POST /api/sessions/{id}/tds (1-second batch)"
FINAL_T="$(curl_t -X POST "$BASE/api/sessions/$SESSION_ID/tds" \
  -d '{"tf":1.0,"h":0.008333}' | jget '["final_t"]')"
echo "    final_t=$FINAL_T (expect ~1.0; abort-on-fault may shorten)"

# 10. Close the session
echo "==> DELETE /api/sessions/{id}"
HTTP="$(http_status -X DELETE "$BASE/api/sessions/$SESSION_ID")"
test "$HTTP" = "204" || { echo "expected 204, got $HTTP"; exit 1; }

# 11. Auth gate — request without token → 401
echo "==> POST /api/sessions without token (expect 401)"
HTTP="$(curl --silent --output /dev/null -w '%{http_code}' \
  -X POST "$BASE/api/sessions")"
test "$HTTP" = "401" || { echo "expected 401, got $HTTP"; exit 1; }

echo "==> walkthrough OK"
