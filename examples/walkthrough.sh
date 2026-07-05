#!/usr/bin/env bash
# End-to-end TENSA API walkthrough in plain curl.
#
# Prereqs: a running server (`tensa serve --workspace <dir> --port 8000`)
# and a case file inside that workspace (this script assumes ANDES's bundled
# ieee14 xlsx has been copied in as `ieee14_full.xlsx` — adjust CASE below).
set -euo pipefail

BASE="${ANDES_APP_URL:-http://127.0.0.1:8000}/api"
CASE="${ANDES_APP_CASE:-ieee14_full.xlsx}"

jqr() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

echo "# 1. Create a session"
SESSION=$(curl -sf -X POST "$BASE/sessions" | jqr "['session_id']")
echo "session_id=$SESSION"

echo "# 2. Load a case (path is relative to the server's --workspace)"
curl -sf -X POST "$BASE/sessions/$SESSION/case" \
  -H 'Content-Type: application/json' \
  -d "{\"primary_path\": \"$CASE\"}" | jqr "['state']"

echo "# 3. Add a disturbance: 3-phase fault at bus 7, t=1.0..1.1 s (pre-setup only)"
curl -sf -X POST "$BASE/sessions/$SESSION/disturbances" \
  -H 'Content-Type: application/json' \
  -d '{"disturbances": [{"kind":"fault","bus_idx":"7","tf":1.0,"tc":1.1,"xf":0.05,"rf":0.0}]}' \
  >/dev/null && echo "fault registered"

echo "# 4. Solve the power flow"
curl -sf -X POST "$BASE/sessions/$SESSION/pflow" \
  -H 'Content-Type: application/json' -d '{}' | jqr "['converged']"

echo "# 5. Run a 5-second time-domain simulation (batch, synchronous)"
curl -sf -X POST "$BASE/sessions/$SESSION/tds" \
  -H 'Content-Type: application/json' \
  -d '{"tf": 5.0}' | jqr "['converged']"

echo "# 6. Read the final operating point (first 3 bus voltages, pu)"
curl -sf "$BASE/sessions/$SESSION/operating-point" \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['bus_voltages']; print(dict(list(d.items())[:3]))"

echo "# 7. Clean up"
curl -sf -X DELETE "$BASE/sessions/$SESSION" -o /dev/null -w '%{http_code}\n'
