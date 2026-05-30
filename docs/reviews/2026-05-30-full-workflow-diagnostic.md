# Full-workflow diagnostic (live Playwright pass)

Driven against the live stack (`:5173` web / `:18766` substrate, `--no-auth`).
Every pipeline run end-to-end; each finding records the failure mode so fixes
are grounded. Status legend: ✅ works · ⚠️ works-with-issues · ❌ broken.

## Cross-cutting design finding (raised by user, confirmed)

**The bottom drawer conflates three roles** — element data tables (Buses/…/
Shunts), analysis Results (Analysis), and the Activity log — and the app
**splits viewing from editing**: values are read in the bottom grid but edited
in the side inspector, so one element lives in two places with no single source
of truth.
Proposed direction (to validate): bottom drawer = "data & results console";
side = "selected-element editor"; selecting a grid row drives the inspector;
make grid cells inline-editable (or a clear "edit in inspector" affordance) so
view+edit unify.

---

## Findings by pipeline

### Pipeline A — steady-state PF + what-if ✅ (with minor gaps)
- PF runs, converges ("PF converged in 4 iterations."), per-bus V/θ populate the
  Buses grid. Results ARE visible — but only in the bottom grid (ties into the
  IA finding: the user expects results more prominently).
- ⚠️ Bus `P (MW)` / `Q (MVAr)` columns show `—` (not populated).
- ⚠️ After PF the case is "committed", so inline static edits require a Reset
  first — a friction point for the what-if loop.

### Pipeline B — TDS ❌ broken (root-caused; multi-layer no-auth bug chain)
**"Click TDS, nothing happens" reproduced.** Traced + fixed a chain:
1. **Run-readiness gate** blocked TDS/EIG in no-auth ("Sign in to run.") — token
   gate ignored `authDisabled`. *(fixed earlier, e7148b0)*
2. **`RunButton.startTds` silent no-op**: `if (!sessionId || !token) return` — in
   no-auth `token` is null so the handler bailed with no error, no WS, nothing.
   *(fixed: honor `authDisabled` + pass `token ?? ''`)*
3. **`SweepProgressPanel`** had the same `!token` guard on its progress stream.
   *(fixed)*
4. **WS protocol desync (substrate)**: `require_ws_auth` returned `True` in
   no-auth WITHOUT consuming the client's `{type:'auth'}` frame, so the handler
   read that stale frame as the TDS config → run never started → button stuck
   on "Streaming…". *(fixed: consume+discard the auth frame in no-auth; unit
   test updated)*

After all four fixes the button now *reacts* (reaches "Streaming…"), but
**end-to-end TDS streaming is still not confirmed live** — there may be one more
layer (WS URL/proxy in this dev setup, or stream framing). Blocked from clean
verification by the environment degradation below.

### Environment degradation (blocking reliable live iteration)
After this long session, BOTH dev file-watchers went stale: Vite served
pre-edit modules until restarted; the backend `--reload` didn't pick up `ws.py`
until restarted; process restarts via chained shell were flaky (exit 144); and
dynamic-`import()` store probes returned duplicate/stale module instances
(false `authDisabled:false`, `runCount:0`). This made each verification a
multi-step fight. **Recommendation: restart the full stack fresh, then run the
pipelines as a committed deterministic Playwright e2e** rather than ad-hoc live
probing.

### Pipelines C–L — NOT YET RUN
EIG / CPF+QV / SE, build-from-scratch + drag-drop, concurrency/export/layout
(incl. the TDS/Export overlap), sweeps / PMU / profile-import / multi-case —
deferred: the TDS blocker + environment wrangling consumed the run. To be done
on a fresh stack via the deterministic e2e.
