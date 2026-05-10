---
date: 2026-05-10
topic: v2-polish-phase3-smoke
status: complete
units_covered: [Unit 15 EIG scatter zoom/pan/log, Unit 16 participation table sort/filter/virt, Unit 17 CPF lambda slider, Unit 18 SE detail panel, Unit 19 SLD animation easing + line-flow arrows, Unit 20 multi-run swatch + rename]
---

# v2.0 Polish Phase 3 — Playwright smoke pass

End-to-end browser verification of Phase 3 (commits `1e46e4c`, `26fe879`, `a930771`, `a83b3b8`, `ef1615a`, `8cc8485`) on `kundur_full.xlsx`. Token in sessionStorage; PF run before each Analyze sub-mode.

## What works

| Feature | Test | Result |
|---|---|---|
| Unit 19 — line-flow arrows | After PF on kundur, `[data-testid^="line-flow-arrow-"]` count = **15** (one per topology line) | ✅ |
| Unit 19 — voltage transition CSS | `BusNode` has inline `style.transition` with `200ms var(--ease-out-quart)` | ✅ (per unit test) |
| Unit 19 — reduced-motion | global `@media (prefers-reduced-motion: reduce)` rule collapses `transition-duration` | ✅ |
| Unit 15 — EIG scatter renders | After Run EIG on kundur, `[data-testid^="eig-scatter-point-"]` = **3** points (kundur's 3 dynamic eigenmodes) | ✅ |
| Unit 15 — zoom reset button | `[data-testid="eig-scatter-zoom-reset"]` present | ✅ |
| Unit 15 — log-scale toggle | `[data-testid="eig-scatter-log-toggle"]` present | ✅ |
| Unit 15 — palette commands | `navigation.eig-reset-zoom` + `navigation.eig-toggle-log` registered (verified by `commands.test.ts`) | ✅ |
| Unit 15 — pan/zoom math | hand-rolled wheel-zoom + drag-pan + log-scale signedLog10 unit-tested | ✅ |
| Unit 16 — participation polish | sort + filter + react-window virt unit-tested (12 tests) | ✅ |
| Unit 16 — react-window dep | `react-window@1.8.11` installed (React-19-compatible peerDeps) | ✅ |
| Unit 17 — CPF lambda slider | slider + readout + nose annotation unit-tested (28 tests including post-nose interpolation) | ✅ |
| Unit 18 — SE detail panel | bar click → detail panel populates (6 tests; bin-aware since substrate ships scalar residuals only) | ✅ |
| Unit 20 — multi-run rename | `displayName` + `colorOverride` slice fields wired; double-click rename, swatch picker (8 OKLCH palette + custom hex with `aria-invalid` inline error) | ✅ |
| Unit 20 — runIdToColor override | `runIdToStrokeStyle(runId, colorOverride?)` short-circuits hash; chip + line stay in sync | ✅ |

## Verified earlier this session

- Phase 1: case-change flow fix + post-discard auto-create regression (commit `7851cd2`)
- Phase 2: TopBar grouped menus, ⌘K palette, ? cheatsheet, SLD search, dark mode, EmptyState + first-run coach (commits `292f6dd`...`c6594c6`)

## Known follow-ups (out of scope for Unit 21)

- **EIG zoom across sub-mode switch**: lifted state would require Zustand slice; currently zoom resets on remount. Plan integration test marked `it.todo` in `EIGScatter.test.tsx`. Acceptable per the unit's design note.
- **SE measurement metadata**: substrate's `SeResult` ships `residuals[]` + `flagged_indices[]` only — no per-measurement type/bus/sigma. Unit 18 detail panel shows bin members (residual indices + values + bin-level flag reason). Per-measurement detail (type, bus, expected, σ) is a substrate enhancement, not a UI bug.
- **SLD line-flow arrow rAF integration**: line flows currently update only on PF re-run, not 60Hz TDS streams. The arrow component's docstring identifies `useSldFrameOverlay` as the canonical extension point if line streaming lands later — single rAF loop, no parallel one introduced.
- **Direct `?` keypress** under Playwright still doesn't fire the cheatsheet binding (Phase 2 noted same; reachable via palette item).

## Test counts (post-Phase-3)

- Web tests: 1277 → **1372** (+95 across Units 15–20). Phase totals:
  - Unit 15: +14 (29 vs 15 baseline in EIGScatter.test.tsx)
  - Unit 16: +6 (12 vs 5 baseline; rankParticipation back-compat preserved)
  - Unit 17: +14 (28 vs 14 baseline)
  - Unit 18: +6 (bin-aware tests)
  - Unit 19: +23 (BusNode +2, LineFlowArrow +12, TopologyEdge +9)
  - Unit 20: +30 (RunLegendChip +13, runs slice +8, runIdToColor +9)
- 1 `it.todo` (EIG zoom-across-submode). Lint clean. Typecheck shows the same 7 baseline errors.

## Branch state

- `feat/v2-polish` pushed through `8cc8485` (Unit 20).
- 19 substantive commits + 2 design polish commits + 2 fix commits + 2 spike docs on the branch.

## Next

Unit 21 design-iterator pass (4 cycles) — focus on chart aesthetics, hover affordances, spacing, motion (per plan line 880).
