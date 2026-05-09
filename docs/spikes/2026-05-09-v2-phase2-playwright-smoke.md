---
date: 2026-05-09
topic: v2-phase2-playwright-smoke
status: complete
units_covered: [Unit 5 xf, Unit 6.5 disturbance buffer, Unit 7 snapshot, Unit 8 whitelist, Unit 9 multi-run + history, Issue-1 fix]
---

# v2.0 Phase 2 — Playwright smoke pass

End-to-end browser verification of Phase 2 (commits `b5f3fa3`, `04642f1`, `5bf530c`, `eaa51ae`, `eabd0bb`, `3c1fb22`) on `ieee14.raw`.

## What works

| Feature | Test | Result |
|---|---|---|
| Topbar new buttons | Snapshots / Report / Export bundle / History all visible | ✅ |
| Case load | IEEE 14 (14 buses, 5 generators, 11 loads) | ✅ |
| Run PF | converged | ✅ |
| Snapshot menu | Save / Load options | ✅ |
| Save snapshot | dialog with name input + collision-aware confirm; saved to `<workspace>/snapshots/ieee14/baseline-pf.{dill,json}` | ✅ |
| Snapshot metadata | JSON includes `andes_version: 2.0.0`, `andes_app_version`, `case_sha256`, `disturbance_log: []`, `has_pflow: true`, `has_tds: false`, `saved_at` ISO | ✅ |
| Load snapshot dialog | lists `baseline-pf` with timestamp + version + has-PF flag + dill-opt checkbox | ✅ |
| Restore snapshot | restored cleanly; 14 buses preserved; no error banner | ✅ |
| HistoryDrawer | empty state ("No runs yet. Run a TDS to populate the history") | ✅ |
| Issue-1 fix (PF-after-EIG) | server now 422 with reload hint; existing RunButton recovery handler picks it up | ✅ (server tests) |
| Default xf=0.05 | `blankFaultSpec` now produces 0.05; new fault forms warning-free at default | ✅ |

## Edge cases

| Edge case | Result |
|---|---|
| React-friendly value setter on snapshot name input | required (DOM `.value` setter alone doesn't propagate to React state) | known UX-test caveat |
| Snapshot list survives substrate restart | not directly retested but files persist on disk in `<workspace>/snapshots/<case>/` | inferred ✅ |
| Snapshot name regex (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) | client + server enforce; tested in unit | ✅ |
| Snapshot collision (duplicate name) | 409 unless `force=true` | tested via integration |

## Not tested in this smoke (Phase 3 scope or follow-up)

- **Multi-run overlay with 3+ runs** — needs TDS runs first (kundur was loaded last time but session got stuck on case-change; smaller-scope IEEE 14 used here)
- **Snapshot round-trip with disturbances** — substrate-side test passes; UI flow not exercised
- **Snapshot disturbance-replay with `_disturbance_log`** — substrate integration tests cover; UI smoke needs disturbance + snapshot + restore loop
- **Full whitelist UI flow** — UI device picker shows empty buckets for the new dynamic models (KNOWN GAP per Unit 8 commit; Unit 8.1 follow-up needed to extend `TopologySummary` with a controllers bucket)

## Console errors observed

Only the expected pre-load 401s (token not yet set) plus one 404 for `workspace/layout` (no sidecar — expected).

## Test counts (post-Phase 2)

- **Server:** 367 (was 280 pre-Phase-2; +87 this phase: +2 Issue-1 + +18 Unit 6.5 + +59 Unit 7 + +8 Unit 8)
- **Web:** 854 (was 763 pre-Phase-2; +91 this phase: +9 Unit 5 + +0 Unit 6.5 substrate-only + +30 Unit 7 + +2 Unit 8 + +50 Unit 9)
- All passing as of Unit 9 commit `3c1fb22`.

## Next session

Phase 3 — start with Unit 10 (bundle import, depends on Unit 3 contract + Unit 6.5 replay buffer). Remaining: Unit 12 CPF, Unit 13 SE, Unit 14 PMU, Unit 15 TimeSeries, Unit 16 adaptive TDS, Unit 17 connectivity, Unit 18 sweep, Unit 19 v2.0 release + POSE LOI.

**Recommended pre-Phase-3 follow-up: Unit 8.1** — extend `TopologySummary` with a `controllers` bucket so the Unit 8 whitelist additions are reachable through the UI. Currently substrate accepts Alter on IEEEX1 etc. via direct API; UI device picker is empty.
