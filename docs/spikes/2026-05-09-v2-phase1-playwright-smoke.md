---
date: 2026-05-09
topic: v2-phase1-playwright-smoke
status: complete
units_covered: [Unit 2 export, Unit 3 bundle export, Unit 4 reports, Unit 6 EIG + Analyze]
---

# v2.0 Phase 1 — Playwright smoke pass

End-to-end browser verification of the v2.0 Phase 1 cut (commits `28f73f6`, `2062532`, `eba0a4c`, `ff1888a`, `8281742`) on `kundur_full.xlsx` and `ieee14.raw`.

## What works (confirmed visually + functionally)

| Feature | Test | Result |
|---|---|---|
| Token modal + session create | paste token, modal closes | ✅ |
| Case load (kundur_full.xlsx) | 10 buses + 4 GENROU generators rendered | ✅ |
| Run PF | converged in 4 iterations, mismatch 3.745e-7, voltages 0.954–1.000 pu | ✅ |
| Right dock IA (Unit 6 KTD-6) | 4 tabs: Inspector / Disturbances / Plot / Analyze (TDS-config folded) | ✅ |
| Topbar Report + Export bundle buttons | both visible, both functional | ✅ |
| Unit 4 — Report dialog | PFlow report with 4 structured tables, real ANDES output, LaTeX copy button | ✅ |
| Unit 3 — Bundle export | `.zip` containing `case/kundur_full.xlsx` + `manifest.json` with sha256 + ANDES version + app version | ✅ |
| Unit 2 — CSV export from ResultsTable | long-form `row_label,column,value` schema, 8+ buses serialised | ✅ |
| Unit 2 — PNG export from SldCanvas | valid PNG (733×816 RGBA, ~88KB) | ✅ |
| Analyze panel + sub-mode picker | PF / TDS / EIG sub-modes switchable | ✅ |
| Unit 6 — Run EIG on kundur_full | 52 eigenvalues computed; scatter shows 3 visible (filter: damping<5% AND \|Re\|<5) | ✅ |
| Unit 6 — TDS-initialized banner | "Running EIG initialised the dynamic state…" surfaced post-run | ✅ |
| Unit 6 — Mode selection → participation table | clicked scatter point #24; 52 participation factors loaded sorted by \|factor\|; top contributor: delta GENROU 4 = 0.1985 | ✅ |

## Issues found

### 🔴 Issue 1: EIG side-effect causes PF re-run to 500

**Steps:** load kundur → Run PF (converged) → switch to Analyze → Run EIG (succeeds) → switch back to PF mode → Run PF again.

**Expected (per Unit 6 KTD):** PF re-runs from the EIG-initialised dae state; result may differ but the operation succeeds.

**Observed:** `POST /api/sessions/{id}/pflow` returns 500. UI surfaces no specific error; just a generic failure.

**Severity:** Medium. The TDS-initialized banner warns the user, but the error path needs to be cleaner: either substrate-side reset of TDS state before PF re-run, OR a specific 422 with actionable message ("EIG mutated dae state; reload case to restore pre-EIG PF behavior").

**Suggested follow-up:** new unit "EIG side-effect cleanup" — substrate `Wrapper.run_pflow` detects `_ss.TDS.initialized == True` and either calls `_ss.reset()` first OR raises a typed error with a clear message.

### 🟡 Issue 2: "Change case" does not trigger a new `/case` POST

**Steps:** load kundur → Change case → pick ieee14.raw → Load.

**Expected:** substrate session swaps to ieee14; new topology returned.

**Observed:** Frontend Load button click does NOT fire `POST /api/sessions/{id}/case`. Substrate retains kundur. Subsequent Run EIG on the "ieee14" session actually runs against kundur.

**Severity:** Medium. Pre-existing v0.1 behaviour, not a v2.0 regression. The Change case → Load flow appears to only re-render the picker UI; case-swap on the substrate side requires either page reload or close session + new session.

**Suggested follow-up:** investigate `web/src/components/case/` Change-case flow; either wire it to a new `POST /case` or document the limitation in the UI ("To switch cases, reload the page").

### 🟡 Issue 3: Duplicate React keys in SLD generator rendering

**Observed:** Console logs 8 React warnings on kundur load:
- `Encountered two children with the same key, stub-generator-1` (and -2/-3/-4)
- `Encountered two children with the same key, generator-1` (and -2/-3/-4)

**Severity:** Low. Pre-existing v0.1 issue; functional rendering is unaffected. kundur has 4 GENROU on shared buses with adjacent generators; key-collision in the SLD's generator-rendering loop.

**Suggested follow-up:** `web/src/components/sld/SldCanvas.tsx` generator key construction needs to include the generator's `idx`, not just position-based.

## Edge cases tested

| Edge case | Result |
|---|---|
| Bundle export with no run yet (PF only) | `manifest.run_id: null`; sim_params.json + results.csv omitted; preview list reflects this | ✅ |
| Mode click on filtered scatter (mode 24, originally hidden by filter) | participation slice fetched on demand; 52 rows returned | ✅ |
| Empty-modes case (IEEE 14 stock, no .dyr) | **could not test** due to Issue 2 (case-change doesn't swap) | ⏭️ |
| EIG on PF-not-yet-run | not tested directly; pre-condition gate exists in substrate | ⏭️ |
| LaTeX copy from report | dialog renders the button; clipboard write not exercised in headless Playwright | ⏭️ |

## Test counts (post-Phase 1)

- **Server:** 280 (was 202 pre-Phase-1; +78)
- **Web:** 763 (was 650 pre-Phase-1; +113)
- All passing as of Unit 6 commit `8281742`.

## Next session

When resuming /ce-work:

1. **Fix Issue 1** (EIG side-effect → PF 500) before continuing to Phase 2 — it's a real domain-correctness bug surfaced by the smoke and noted as a P1 in the doc-review.
2. Consider whether Issue 2 (case-change flow) is in scope for the v2.0 wiring effort. If yes, add a small unit to wire it. If no, document it as a known v1.0 limitation in the v1.5 release notes.
3. Issue 3 (duplicate keys) is pure polish — can wait for v2.5.
4. Resume Phase 2: Unit 5 (xf default) → Unit 6.5 (disturbance-replay buffer) → Unit 7 (snapshot) → Unit 8 (whitelist) → Unit 9 (multi-run + history).
