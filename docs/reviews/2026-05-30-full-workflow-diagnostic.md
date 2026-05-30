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

5. **WS never reached the backend (dev proxy + path)**: RunStream connected to
   `/ws/{id}` via a separate Vite `/ws` rewrite proxy whose rewrite didn't apply
   on the WS upgrade; the `/api` proxy lacked `ws: true`. JobStream/SweepStream
   already used the real `/api/ws/...` path. *(fixed: `/api` proxy `ws:true` +
   RunStream → `/api/ws/{id}`; removed the `/ws` rewrite proxy)*

**RESOLVED — TDS now runs end-to-end** (verified live: WS → `{type:'ready'}`,
run completes "Done at t=10.00"). Commits b2141b6 + 7232e52.

**Remaining "can't see results" issues (tie into the IA finding):**
- The per-element **trajectory Plots are below the fold** in the inspector —
  you must scroll past Properties to find them. Low discoverability.
- Clicking a generator shows **kind: Slack (static)**, not the dynamic
  **GENROU** rotor trajectory, because PV/Slack and GENROU share an idx (the
  node-id collision flagged in review(phase5)). So the post-TDS rotor-angle /
  speed trajectory is hard to reach from the diagram.
- TDS run state surfaces well in the TOP BAR ("Done at t=10.00") + the SLD bus
  colour overlay; but there is no prominent "here are your results" surface.

### Environment degradation (blocking reliable live iteration)
After this long session, BOTH dev file-watchers went stale: Vite served
pre-edit modules until restarted; the backend `--reload` didn't pick up `ws.py`
until restarted; process restarts via chained shell were flaky (exit 144); and
dynamic-`import()` store probes returned duplicate/stale module instances
(false `authDisabled:false`, `runCount:0`). This made each verification a
multi-step fight. **Recommendation: restart the full stack fresh, then run the
pipelines as a committed deterministic Playwright e2e** rather than ad-hoc live
probing.

### Pipelines C–L — partially run (see session-2 below)

---

## Session 2 (fresh stack) — named-flaw resolutions

All four user-named flaws are now fixed + verified live on a clean stack.

**Dev launch config (root of much session-1 churn).** The backend must be
started with the Vite dev origin allowed and the real workspace, else the
browser silently fails:
`andes-app serve --no-auth --bind 127.0.0.1 --port 18766
  --workspace /home/roger-gracia/andes-cases
  --allow-origin http://localhost:5173 --allow-origin http://127.0.0.1:5173`.
Without `--allow-origin`, `POST /api/sessions` → 400 `bad-origin` (CSRF
Origin allowlist), so no session is ever created and every gated action
no-ops. Without `--workspace`, Saved Cases is empty. `curl` masks both (no
Origin header / different default). Recorded to memory.

### "text overlaps (TDS and Export)" — FIXED (cee4f6f)
The right top-bar slot was `flex-1 justify-end`; when the dense right
cluster exceeded its squeezed box it overflowed LEFT and laid Export over
the run controls (a Run-PF click was intercepted by Export). Rebuilt the bar
as three content-sized (`shrink-0`) slots + two `flex-1` spacers; the bar
scrolls (hidden scrollbar) when truly cramped. Verified 1024–1440px: zero
pairwise slot overlap.

### "drag and drop not really working" — FIXED (22e806b)
The drop target lived only in `SldCanvasInner` (buses present). Both EMPTY
states — the "No case loaded" placeholder and `SldEmptySystem` — had no drop
handlers, so the advertised "drag a component onto the canvas to start a
blank system" was a silent no-op, with no drag-over feedback anywhere. Added
a reusable `ComponentDropZone` (type-gated + dashed-ring affordance); the
no-case drop spins up a blank system then opens the kind's add form, the
empty-system drop opens it directly. Verified end-to-end: drop Bus → blank
system → Add Bus → bus lands in topology + renders on canvas.

### "i click TDS and it does not happen" — RESOLVED (holds on fresh stack)
The session-1 5-layer no-auth/WS fix chain (b2141b6 + 7232e52) holds: TDS
switches mode → runs → "Done at t=10.00". Re-verified clean.

### "no easy way of seeing results" — FIXED (f32c07f), partial
Concrete facet: after a TDS-only run the Buses grid showed `—` for every
V/θ because the grid reads `pflow.lastRun`, which only PF sets. Added a
read-only `GET /sessions/{id}/operating-point` (reads `ss.Bus.v/a`, no
re-solve); RunButton fetches it on TDS `done` → grid AND SLD voltage
labels/colour overlay now populate. Verified live on kundur_full.
- Known nuance: post-TDS bus *angles* carry common-mode reference drift
  (~9.5 rad / ~549°). V is correct; θ is faithful-but-large. Candidate
  follow-up: normalise θ to the slack bus for the post-TDS read.
- Broader IA redesign (bottom-drawer conflation + view/edit split) still
  open — see the cross-cutting finding above.

### Branch health
`fix/no-auth-tds-workflows`: web suite 170 files / 1715 pass; touched backend
files 27 pass. Fixed 11 pre-existing RunButton TDS test failures (stale
`/ws/` mock-server URL vs the `/api/ws/` production path) in e460c97.

### Analysis routines (Pipelines C/E) — verified ✅
Run menu → routine opens the bottom-drawer Analysis tab → sub-tabs
(Plot / EIG / CPF / SE / TDS), each with config + Run + results.
- **CPF** ✅ — nose curve renders (44 steps, max λ=0.6082, "Nose: λ=0.61,
  V_min=0.72"); SLD updates with line flows.
- **EIG** ✅ — eigenvalue scatter (3 of 52 visible, damping<0.05); and
  exemplary state-mutation visibility: a banner "Running EIG initialised the
  dynamic state. Subsequent TDS or re-run PF will start from this initialised
  dae." + a top-bar **Reload case** recovery button appear after EIG. This is
  the error-visibility pillar working as intended.
- Pre-setup gating IS surfaced: EIG/CPF-nose/SE-Run wrap their disabled Run
  button in a Radix tooltip (`AnalyzeRunButton` + `useRunReadiness`) → "Run
  PFlow first; <routine> requires a converged operating point." + an "Open PF
  view" recovery. (Earlier "disabled with no reason" note was a false alarm —
  the reason shows on hover.)

**Minor inconsistency (follow-up, not yet fixed):** the **CPF QV-curve**
(`cpf-qv-run`) and **SE "Generate Measurements"** buttons do NOT use the
shared readiness/tooltip — they enable in pre-setup and surface the
prerequisite only as a post-click 409 banner, unlike their siblings. Low
severity (the error is still shown), but worth aligning to the shared pattern.

### Pipelines still to run
SE end-to-end, SWEEP, CPF-QV, F (concurrency/recovery), G (export round-trip),
I–L (PMU / profile-import / multi-case compare).
