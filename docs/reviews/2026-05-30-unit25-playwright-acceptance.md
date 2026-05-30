# Unit 25 — Playwright UX acceptance gate

Date: 2026-05-30
Stack: live FastAPI substrate (`:18766`, `--no-auth --reload`) + Vite web client
(`:5173`), driven via Playwright MCP against `kundur_full.xlsx`.

The v3.1 overhaul targets UX, so green `pytest`/`vitest` is necessary but not
sufficient. This pass drove the UX-critical workflows in a real browser. **The
gate did its job**: all unit suites were green (1710 web + 393 substrate) yet
the live pass surfaced **four real integration bugs** that the unit tests could
not, each now fixed and re-verified (commit `e7148b0`).

## Bugs the live gate caught (all fixed + re-verified live)

1. **Dynamic-content badge stuck "loading" + run-readiness gate blind.** The
   badge + gate read the `case.topology` store mirror, but the plain topology
   query is served from the TanStack cache, so its `queryFn` never set the
   mirror. → `useSyncTopologyMirror()` at the app root.
2. **Modified-from-Original dot never appeared after an edit.** The diff refetch
   raced the post-edit query storm for the substrate's non-blocking session
   lock and 409'd. → `useCloneDiff` retries on a transient 409.
3. **Undo left the input showing the just-undone value.** `CloneEditField`
   seeded local state once and never re-synced. → value-change effect.
4. **Every Run button stuck on "Sign in to run." under `--no-auth`.** The
   readiness token gate ignored `authDisabled`. → honours it (+ regression test).

## Pillar results

- **Pillar 4 — dynamic inspector + clone-on-write (headline, exhaustively
  verified):** controllers render + are inspectable on the SLD (GOVERNOR eyebrow)
  and via the generator drill-down; the dynamic-content badge reads
  "Dynamic — 4 governor, TDS/EIG available"; **Edit mode → edit `TGOV1.T1`
  (0.49→0.654) → round-trip (value persists) → Modified-from-Original dot
  appears (keyboard-reachable, diff in the accessible name) → undo (input
  reverts to 0.49, dot clears) → redo (0.654) → Save As `kundur_tuned_t1` (new
  case appears in Saved cases + written to the workspace) → reload it → the edit
  is preserved (`TGOV1.T1 == 0.654`).** Screenshot: `phase7-pillar4-clone-edit.png`.
- **Pillar 1 — non-blocking:** Run PF enabled (after fix #4) and runs to results;
  the Activity tab is present in the bottom drawer. Job execution is in a worker
  process by design. Screenshot: `phase7-pillar1-pf-run.png`.
- **Pillar 3 — GUI parity:** the Analysis tab + command-palette hint (⌘K) are
  present; the parity ledger (Unit 16 CI guard) keeps every route GUI-reachable
  and is green for all 57 routes incl. the 7 clone routes.
- **Pillar 2 — error visibility:** the clone-edit failure path (revert + inline
  `ProblemDetailsErrorSurface`) and the recovery-CTA surfaces were built +
  adversarially reviewed across Phases 2–4 and are unit-tested; not re-driven
  exhaustively here.

## Environment notes

- The long-running Vite dev server (up since May 10) had a stale in-memory
  module cache and did not pick up edits; it was restarted
  (`VITE_ANDES_PORT=18766 pnpm dev --host 0.0.0.0`).
- A test artifact `kundur_tuned_t1.xlsx` was written to the dev workspace
  (`/tmp/andes_test`) by the save-as verification; harmless.
- Screenshots `phase7-*.png` are transient (gitignored, per the polish-screenshot
  convention).
