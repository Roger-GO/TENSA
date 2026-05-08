---
title: "feat: v0.2 readiness bridge — finalize v0.1.y polish + verify gate"
type: feat
status: active
date: 2026-05-08
origin: docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md
---

# feat: v0.2 readiness bridge — finalize v0.1.y polish + verify gate

## Overview

The v0.1.y plan ([2026-05-08-002](2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md)) was marked `status: completed` after 8 implementation units shipped. Browser smoke testing during the readiness gate uncovered **6 substantive bugs** that the test suite (384 web tests + 168 server tests, all green) didn't catch — the tests checked rendered output but not discoverability, visibility, observer-state desync, or mount-lifecycle interactions.

Five of the six bugs are already fixed (commits `3e3d9d0`, `8334d42`, `cb49696`). One residual React dev-mode warning remains. Several v0.1.y readiness-gate `[MANUAL]` items were verified by Playwright during this session; a few weren't reachable through synthesized events and need explicit browser smokes before flipping v0.2 to in-progress.

This plan is the bridge: fix the residual warning, verify the still-unverified gate items, address the deferred mid-stream session recovery callout, write the bridge addendum onto the v0.1.y plan, open the PR, and flip the v0.2 plan to `status: in-progress`. No new feature work.

## Problem Frame

The v0.1.y plan declared a v0.2 readiness gate. We have evidence in this session that:

- **Verified working in browser:** element deletion (case-file-originated rejection, cascade detection with clickable dependents, atomic delete on user-added elements), system-from-scratch + run PF, edit-add-delete-rerun cycles on both loaded and from-scratch systems, save→change-case→reload round-trip preserves all parameter modifications.
- **Verified by automated tests:** 384 web + 168 server tests pass, mypy --strict + ruff + typecheck + lint all clean.
- **Not yet verified end-to-end:** layout collision push-out on synthetic worst-case inputs, sidecar drag-position round-trip (Playwright can't synthesize React Flow pointer events reliably; data-layer round-trip is asserted by Unit 4's 30 sidecar unit tests), session recovery on real substrate restart (browser hit recovery only via stale-id manipulation), sticky-error fix on a real typo-token cycle, undo-last-edit symmetry on both add and delete operations.
- **Outstanding bug:** React dev-mode warning *"Cannot update a component (`SaveSystemButton`) while rendering a different component (`SldCanvasInner`)."* Dev-only; production strips it. Likely caused by a setState-during-render path introduced when v0.1.y's Unit 4 wired SaveSystemButton to read from `useCaseStore.dragOverrides` while SldCanvas is also writing to it.

The v0.2 plan ([2026-05-07-003](2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md)) is `status: active`. It expects:
- A stable element-add/edit/delete UI surface (✅ shipped in v0.1.y)
- A working session-resilience layer for long-running TDS streams (✅ shipped + recovery hook lifted to App root in `8334d42`)
- A clean error-surface taxonomy for run failures (✅ extended for 4xx PF errors in `cb49696`)
- An honest readiness gate assertion before depending on any of these

The bridge work below makes that assertion honest.

## Requirements Trace

Carried forward from v0.1.y:

- **R36 (carry-forward).** Component test coverage stays green. No regression in the 384 web / 168 server test count.
- **v0.2 Readiness Gate (carry-forward).** All `[MANUAL]` items in the v0.1.y plan's gate get explicit verification.

New for this plan:

- **R37 (NEW).** Zero React dev-mode warnings on the load-case + edit-element + run-PF golden path. The current setState-during-render warning is a real bug under StrictMode dev — even though production strips it, it indicates a render-loop hazard that could cascade to user-visible re-render storms (the 25× PF retry burst observed during smoke is consistent with this).
- **R38 (NEW).** v0.1.y branch has an open PR with the full feature delta described, ready for review or merge. The v0.1.y plan's gate item ("PR on `feat/v01-ui` is reviewed + ready to merge") gets actually fulfilled rather than checked optimistically.

## Scope Boundaries

- **No new v0.1.y features.** Bug fixes + verification only.
- **No v0.2 implementation work in this plan.** The v0.2 plan owns its 9 units; this bridge stops at flipping its status.
- **No mid-stream (committed-state) session recovery.** v0.1.y explicitly scoped this out — TDS streams will need their own recovery story in v0.2 Unit 6 / 7. This plan does not pull that forward.
- **No layout overhaul beyond the push-out + dual-key sidecar already in v0.1.y.** Compound-ELK stays a v0.5 candidate.
- **No automated-browser CI.** The Playwright smokes in Unit 2 are run by the implementer in this session, not added to CI. Adding browser-smoke automation is a v0.5+ ask.

### Deferred to Separate Tasks

- **Compound-ELK layout swap** — v0.5 plan, post-empirical investigation.
- **Mid-stream / committed-state session recovery** — v0.2 Unit 6 / 7 territory.
- **Browser-smoke CI integration** — v0.5+; the team will add Playwright to GitHub Actions when the feature surface stabilizes.
- **Multi-component `useEnsureSession` coordination** (the comment in `WorkspaceFilePicker.tsx` warning that a second consumer would double-fire `POST /sessions`) — handled when v0.2's session badge is added (v0.2 plan is aware).

## Context & Research

### Relevant Code and Patterns

- **Predecessor plan**: `docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md` (`status: completed`). v0.1.y's Scope Boundaries + Risks remain authoritative for what was deliberately deferred.
- **Successor plan**: `docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md` (`status: active`). Unchanged by this bridge; status flip happens at the end of this plan's work.
- **Brainstorm**: `docs/brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md` — R7, R28, R30 (carry-forwards), R33–R36 (v0.1.y), R37–R38 (new in this bridge plan).

Code paths this plan touches:

- `web/src/components/case/SaveSystemButton.tsx` — current source of the React setState-during-render warning. Reads `dragOverrides` + `topology`; the read pattern needs to move to `useEffect` or to a derived selector that doesn't run during the SldCanvas render.
- `web/src/components/sld/SldCanvas.tsx` — `SldCanvasInner` calls `setDragOverrides(next)` during render or in a synchronous code path that triggers SaveSystemButton's selector. The fix likely involves moving the prune step to a `useEffect` (already there at line 316) and making SaveSystemButton's drag-override read happen outside SldCanvas's render frame (via `useStore.getState()` inside a callback rather than a top-level subscription).
- `docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md` — gets a `## Browser Smoke Addendum` section appended documenting which gate items were verified, by what means, and which fixes shipped in commits `3e3d9d0` / `8334d42` / `cb49696`.
- `docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md` — status flip from `active` → `in-progress` at the end of Unit 5.

### Institutional Learnings

- Memory `feedback_collab_style.md` — user prefers comprehensive scope, engages with adversarial pressure-testing, values forward-compatible architecture. Browser smoke tested every flow before declaring done; the residual 25× PF burst tells us the React warning isn't cosmetic.
- Memory `reference_andes_quirks.md` — ANDES rejects post-setup `ss.add()`; the substrate uses reload-and-replay. v0.1.y's delete path inherits this; v0.2's disturbance editor commits before TDS starts. No mid-run topology edits.
- Memory `feedback_deepening_needs_source_grounding.md` — verify claims against source. The v0.1.y bridge benefited from this: every browser-smoke fix was anchored to the actual failure observed (network log, console error, fiber state) rather than speculation.

### Browser smoke findings (this session)

For the addendum:

| Bug | Root cause | Fix commit |
|---|---|---|
| Edit pencil invisible (`opacity-0` group-hover only) | Dev-mode discoverability — pencils only appear on hover | `3e3d9d0` |
| Picker listed `*.layout.json` sidecars as cases | Filter only checked extension format, not sidecar suffix | `3e3d9d0` |
| "Connecting…" stuck after session created | TanStack v5 mutation observer desync (StrictMode dev) — `isPending` stays true after MutationCache transitions to `success` | `3e3d9d0` (derive `creating` against `sessionId === null`) |
| Results table missing Loads + Shunts tabs | v0.1.y Unit 7 didn't add tabs even though loads/shunts existed in the data | `3e3d9d0` |
| Recovery effect tied to picker mount | Picker unmounts after case load → recovery hangs forever once the page has any loaded case | `8334d42` (lifted to App root) |
| PF 4xx errors silently dropped | RuntimeCrashModal gated on `ServerError` (5xx); ConvergencePanel gated on `lastRun`; 4xx fell through both | `cb49696` (inline error toast with reload-and-retry button when message mentions "reload") |

Sharp edges identified but not v0.1.y bugs:

- **Vite 6 + http-proxy-3 stops forwarding `X-Andes-Token` after ~10h uptime.** Workaround: `pkill -f vite && pnpm dev`. Documented in v0.1.y commit `cb49696`'s body. Tracked separately; not blocking.
- **Substrate restart needed mid-session.** Old substrate at PID 1957830 / 1959185 had been running since before v0.1.y's mutation endpoints existed; it didn't have `/api/topology/schema` or `/api/sessions/{id}/elements/...`. Restart picked them up. Documented; the user is aware.
- **Substrate's CORS `--allow-origin` is exact-match.** Browser must hit `127.0.0.1:5173`, not `localhost:5173`. Documented.

### External References

None — this is internal bridge work.

## Key Technical Decisions

These are settled now.

- **Fix the React warning by moving SaveSystemButton's drag-override read to a callback (not a subscription).** SaveSystemButton currently uses `useCaseStore((s) => s.dragOverrides)` at the component top, which subscribes to every change. SldCanvasInner's `setDragOverrides(next)` (line 326 in `SldCanvas.tsx`) fires during the prune-effect and synchronously notifies subscribers. The cleanest fix: SaveSystemButton reads `useCaseStore.getState().dragOverrides` inside `writeSidecarAlongside` only when Save is clicked — no top-level subscription, no render trigger when overrides change. The `topology` read can stay subscribed (it's already from a TanStack Query that doesn't fire during SldCanvas's render).

- **Verify gate items via Playwright in this session, not by adding to CI.** This plan's Unit 2 is a one-time verification batch. Adding Playwright tests to CI is a v0.5+ task — the surface is still moving fast enough that brittle E2E tests would generate false-positive churn. The verification record lands in the v0.1.y addendum (Unit 3) so future sessions can see what was checked.

- **Sidecar drag-position round-trip stays verified by unit tests, not browser smoke.** React Flow pointer events resist synthesized JS dispatch. The 30 sidecar unit tests (Unit 4 of v0.1.y) cover the round-trip on the data layer; the dual-key shape and `nonBusCoordsAsMap` resolution are exercised. Browser smoke would be redundant + brittle. Documented in the addendum.

- **Open PR before flipping v0.2 status.** The PR is the actual sign-off artifact; flipping v0.2 status without a reviewable PR turns the gate into a self-certification ceremony.

- **No new requirements (R37, R38) drive new feature work.** They drive the addendum contents and the PR creation. The bridge plan is bounded.

## Open Questions

### Resolved During Planning

- **Should we also fix the multi-component `useEnsureSession` coordination caveat?** No — only one consumer today; v0.2 will add a second when it ships the session badge, and the v0.2 plan owns that fix.
- **Should browser smoke be CI'd?** No — deferred to v0.5+. Documented above.
- **Should we soften R34 further (the layout-collision-free guarantee)?** No — already softened in v0.1.y's doc-review pass to "v0.2 demo set + synthetic worst-case." Browser smoke didn't surface a topology where push-out fails.
- **Does the PF 422 toast need to handle other 422 messages besides "reload"?** No — the substrate's other 422 from PF doesn't currently mention reload (it's the dependents-list cascade for delete, not PF). The toast renders the message verbatim regardless; the "Reload case + retry" button only appears on the reload-suggestion path.

### Deferred to Implementation

- **Exact React fix for the setState-during-render warning** — implementer reproduces under StrictMode dev, identifies the precise subscription chain via React DevTools fiber inspection, and applies the minimum change (callback-only read vs. effect deferral vs. selector memoization). Likely outcome: SaveSystemButton stops subscribing to `dragOverrides` at top level and reads it lazily inside `writeSidecarAlongside`.
- **Whether the React warning's fix changes any Unit 4 sidecar test behavior** — implementer runs the existing 30 sidecar tests after the fix; if any break, that signals the fix changed observable behavior (would be a bug — the warning should be silenceable without behavior change). Tests should remain green untouched.

## Implementation Units

### Phase 1 — Residual bug fixes

- [ ] **Unit 1: Fix the React setState-during-render warning**

**Goal:** Eliminate the dev-mode console warning *"Cannot update a component (`SaveSystemButton`) while rendering a different component (`SldCanvasInner`)."* End state: load IEEE 14, click around, edit, save — zero React warnings in the dev console.

**Requirements:** R37.

**Dependencies:** None.

**Files:**
- Modify: `web/src/components/case/SaveSystemButton.tsx` — drop the top-level `useCaseStore((s) => s.dragOverrides)` subscription; read `useCaseStore.getState().dragOverrides` inside `writeSidecarAlongside` only.
- Possibly modify: `web/src/components/sld/SldCanvas.tsx` — only if removing SaveSystemButton's subscription doesn't fully silence the warning. The prune-effect at line 316 already runs in `useEffect` (not during render), so this should be a no-op; included for the case where StrictMode's double-invoke surfaces a different render-time setState path.
- Test: `web/tests/unit/components/case/SaveSystemButton.test.tsx` — extend to assert that toggling `dragOverrides` in the store does NOT cause SaveSystemButton to re-render (subscription removed).

**Approach:**
- The warning fires during SldCanvasInner's render. Its source is the synchronous notification chain when SldCanvas calls `setDragOverrides(next)` and SaveSystemButton's selector schedules a re-render in the same tick.
- Removing the top-level subscription breaks the chain. SaveSystemButton only needs `dragOverrides` at click time (during `writeSidecarAlongside`); the in-memory snapshot from `getState()` is sufficient there.
- If the warning persists after the SaveSystemButton change, fall back to the pattern in `useSessionRecovery.ts`: `useEffect(() => { ... }, [dragOverrides])` with a stable callback closure, so SaveSystemButton doesn't read during render at all.

**Patterns to follow:**
- `web/src/api/useSessionRecovery.ts` — read store with selectors at top level; do work in `useEffect`. Same pattern applies here for any cross-component coordination.
- `web/src/components/inspector/ElementInspector.tsx` line 362 — `paramMetas` uses `useMemo` with explicit deps, no setState side effect during render. SaveSystemButton's `writeSidecarAlongside` should follow the same shape.

**Test scenarios:**
- Unit-test (vitest): mount `<SaveSystemButton />` with a QueryClient + store, then call `useCaseStore.getState().setDragOverrides({...})` and assert SaveSystemButton's render count does NOT increment. Use `@testing-library/react`'s `render` + a render-counter ref.
- Manual smoke: run `pnpm dev`, load IEEE 14, edit a parameter, save the system. Watch dev console for the setState-during-render warning. Should be absent.
- Regression: existing 11 SaveSystemButton tests stay green (the public surface — onClick → format-radio → POST `/save` + sidecar PUT — is unchanged).

**Verification:**
- New test asserts no re-render on `dragOverrides` change.
- Existing 384 web tests still pass.
- Manual: dev console clean during golden-path (load → edit → save) flow.

---

### Phase 2 — Verify remaining readiness-gate items

- [ ] **Unit 2: Playwright batch verifying [MANUAL] gate items**

**Goal:** Each `[MANUAL]` item in v0.1.y's readiness gate that wasn't verified during this session gets a Playwright run with a recorded outcome (pass/fail + a one-line note). Output: an inline test record block in the v0.1.y plan addendum.

**Requirements:** v0.2 Readiness Gate (carry-forward).

**Dependencies:** Unit 1 lands (so the dev console is clean during smoke).

**Files:**
- No code changes. This unit produces a verification record only.
- Test: there is no test file added — the verification is a session-level smoke recorded in Unit 3's addendum.

**Approach:**

Run these checks via Playwright MCP, capture pass/fail + a sentence per:

1. **Layout: synthetic 5-generators-on-one-bus topology renders with no overlap.** Build via `+ New system` → 1 Bus + 5 PV generators all on Bus 1 → screenshot the SLD canvas region. Assert no two generator nodes' bounding boxes overlap (DOM `getBoundingClientRect` math).
2. **Layout: IEEE 39 renders with no overlap.** Workspace setup is `~/andes-cases`; if `ieee39.raw` is not present, copy it from ANDES's bundled cases. Load it, screenshot, run the same overlap-check math across all non-bus pairs.
3. **Session recovery: kill substrate mid-session.** With a loaded case in the browser, run `kill -TERM` on the substrate worker process (find PID via `ps`), restart it with `andes-app serve`, click any canvas action in the browser. Record: badge appeared, recovery completed, case re-loaded, case-store selection preserved.
4. **Sticky-error fix: simulate a 401 then correct.** Inject a typo into `sessionStorage['andes-app:auth-token']`, click any action that triggers a session-scoped request, confirm the modal opens. Paste the correct token, confirm the modal closes and a fresh session is created.
5. **Undo last edit on add + delete.** Load IEEE 14, add BUS15, click Undo → BUS15 gone. Add BUS15 again, delete it, click Undo → BUS15 restored. Both operations symmetric.

If any check fails: file a P1 bug as a todo task on the v0.1.y plan and block the v0.2 status flip until fixed.

**Test scenarios (the smokes themselves):**
- Happy: each of the 5 checks above passes with the expected post-state.
- Edge: layout 5-gen-on-one-bus also has at least one bus-generator stub edge rendered without crossing through another generator node.
- Edge: session recovery survives a 5+ second substrate downtime (badge shows "Reconnecting…" while down; flips off when up).
- Failure path: if substrate fails to restart, the recovery handler hits the 3-attempts-in-30s window and the badge flips to "Reconnection failed" destructive style.

**Verification:**
- All 5 manual smokes pass + are recorded in Unit 3's addendum block.
- If any smoke surfaces a regression, that becomes a new P1 unit added here before this plan can complete.

---

### Phase 3 — Documentation, PR, and v0.2 status flip

- [ ] **Unit 3: v0.1.y plan addendum**

**Goal:** v0.1.y plan gains a `## Browser Smoke Addendum` section near the bottom (after the existing readiness gate, before sources) capturing what shipped after the original `status: completed` flip. End state: future readers can see exactly which post-completion fixes landed and which gate items were actually verified.

**Requirements:** R36, R38.

**Dependencies:** Unit 2 records the smoke results.

**Files:**
- Modify: `docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md` — append the addendum section.

**Approach:**
- Add a `## Browser Smoke Addendum` section (after the readiness gate, before "Sources & References"). Sections inside:
  - **Post-completion fixes:** the 6-row table from "Browser smoke findings (this session)" above, with commit refs (`3e3d9d0`, `8334d42`, `cb49696`, plus Unit 1's commit from this plan).
  - **Verified manual gate items:** 5-row table mirroring Unit 2's smoke results: Layout 5-gen / Layout IEEE 39 / Session recovery / Sticky-error fix / Undo last edit. Each row: smoke ID, pass/fail, one-line note, smoke date.
  - **Sharp edges noted:** Vite proxy 10h-uptime header drop; substrate restart for v0.1.y endpoints; substrate CORS exact-match (use 127.0.0.1, not localhost).
  - **Outstanding (deferred):** multi-component `useEnsureSession` coordination → v0.2 owns; mid-stream session recovery → v0.2 owns; layout overhaul → v0.5 owns.
- Re-flip the readiness gate `[MANUAL]` checkboxes from `[ ]` to `[x]` only for the items Unit 2 verified pass.

**Patterns to follow:**
- `docs/plans/2026-05-08-001-feat-v01-polish-element-builder-plan.md` Unit 13 — that plan added Unit 13a/13b/13c addendums for post-completion fixes; mirror that pattern at the section level.

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- Section reads cleanly; no broken markdown.
- Every commit ref resolves (`git show <sha>` works).
- Every `[MANUAL]` box that's now checked maps to a Unit 2 smoke that passed.

---

- [ ] **Unit 4: Open PR for v0.1.y branch**

**Goal:** A reviewable PR exists for `feat/v01-ui` describing the v0.1.x → v0.1.y delta, ready for sign-off. End state: PR URL recorded, ready for merge.

**Requirements:** R38.

**Dependencies:** Unit 3 (addendum landed).

**Files:**
- No file changes. This unit creates a PR via `gh pr create`.

**Approach:**
- Push the branch (it's been local-only).
- Use `gh pr create` with a body that summarizes:
  - **Scope (v0.1.y):** element deletion (Unit 1 substrate + Unit 2 UI), collision push-out (Unit 3) + sidecar dual-key writer (Unit 4), session recovery (Unit 5 + Unit 6), test backfill (Unit 7), docs (Unit 8).
  - **Bridge fixes (this plan):** the 7 commits from `f8aa2c8` through `cb49696` plus Unit 1's commit from this plan.
  - **Verified gate items:** 11/11 from the v0.1.y readiness gate.
  - **Test count:** server 152 → 168, web 233 → 384, all clean.
  - **Demo:** screen recording of the load → edit → run-PF → save → reload → verify-modifications-stayed flow (the session we ran in this conversation).

**Patterns to follow:**
- The repo's existing PR template if any; otherwise a lightweight summary + test-count delta.

**Test scenarios:**
- Test expectation: none — PR is a process artifact.

**Verification:**
- PR URL is live and the body renders cleanly on GitHub.
- CI passes if any is wired (no CI configured for this repo today; if added, it must pass).
- One reviewer (or self-review) signs off.

---

- [ ] **Unit 5: Flip v0.2 plan to `status: in-progress`**

**Goal:** The v0.2 plan transitions from `status: active` to `status: in-progress`, signaling that prerequisites are met and Unit 1 of v0.2 may begin.

**Requirements:** R38 (the gate's last item is "PR ready to merge").

**Dependencies:** Unit 4 (PR exists).

**Files:**
- Modify: `docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md` — frontmatter `status: active` → `status: in-progress`.

**Approach:**
- One-line frontmatter change. No prose modification.

**Test scenarios:**
- Test expectation: none — status flag flip.

**Verification:**
- Frontmatter reads `status: in-progress`.
- Memory `project_phase_a_progress.md` (or equivalent project-state memory) is updated to reflect v0.1.y completion + v0.2 start.

## System-Wide Impact

- **Interaction graph:** Unit 1 narrows SaveSystemButton's subscription footprint. SldCanvas continues to write `dragOverrides`; SaveSystemButton no longer re-renders when it changes. No other component is affected — the picker, inspector, and toolbar don't subscribe to `dragOverrides`.
- **Error propagation:** unchanged. PF errors continue to flow through `pflow.error` (5xx → RuntimeCrashModal, 4xx → RunButton's new toast, 200-non-converged → ConvergencePanel).
- **State lifecycle risks:** none — the `dragOverrides` data hasn't changed shape; only the subscription pattern in one component changes.
- **API surface parity:** unchanged. No new endpoints, no schema changes.
- **Integration coverage:** Unit 2's manual smokes ARE the integration coverage for v0.1.y's gate. Unit tests stay; no new automated integration tests in this bridge plan.
- **Unchanged invariants:** v0.1.x + v0.1.y's shipped surfaces stay frozen. v0.2 plan's prerequisites assertion ("v0.1.y delivers a stable element CRUD + session resilience") is what this bridge makes honest.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Unit 1's React fix breaks an existing sidecar test | Run all 30 sidecar tests after the change; existing tests should stay green untouched. If any breaks, the fix changed observable behavior, which means the warning was a real bug (not just dev-mode noise) and the broken test needs a real adjustment, not a workaround. |
| Unit 2 surfaces a regression we missed | Add a P1 unit here for the regression; do not flip v0.2 status until fixed. The whole point of this bridge is to catch what the test suite missed. |
| Browser smokes are non-deterministic (substrate restart timing, recovery debounce) | Each smoke runs 2× to confirm reproducibility; if it fails one of two, treat as flake and document; if it fails two of two, it's a real bug. |
| Vite proxy stops forwarding `X-Andes-Token` mid-smoke (10h uptime issue) | Restart Vite at the start of Unit 2 to ensure a fresh proxy. Document in the smoke header. |
| `gh` CLI not authenticated | If `gh auth status` returns unauthenticated, surface a manual PR-creation step in Unit 4's verification (URL and body content shipped to user; user pastes into GitHub). |

## Documentation / Operational Notes

- **README delta in v0.1.y Unit 8** is already shipped. This bridge does not modify it again.
- **Memory `project_phase_a_progress.md`** (or whichever project-state memory is current) gets a one-line update at the end of Unit 5: "v0.1.y completed (commits f8aa2c8 → cb49696 + bridge fix); v0.2 started YYYY-MM-DD."
- **Plan transition:** this bridge plan flips to `status: completed` at the end of Unit 5. v0.2 plan flips to `status: in-progress` simultaneously.
- **Branch strategy:** stay on `feat/v01-ui` (PR #1's branch). Unit 5's status flip lands as the last commit on that branch before merge.

## Sources & References

- **Predecessor plan**: [docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md](2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md). Status: completed. The bridge inherits its readiness gate.
- **Successor plan**: [docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md](2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md). Status: active → in-progress at end of Unit 5.
- **Origin brainstorm**: [docs/brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md](../brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md). R7, R28, R30 are v0.1.x carry-forwards; R33–R36 are v0.1.y; R37–R38 are this bridge.
- **Bridge commits (post-v0.1.y completion):**
  - `3e3d9d0` — fix(web): browser-smoke fixes for v0.1.y inspector + picker (4 fixes)
  - `8334d42` — fix(web): lift session-recovery effect to App root (Unit 5 bug)
  - `cb49696` — fix(web): surface 4xx PF errors instead of silently dropping them
  - Unit 1 of this plan — fix(web): React setState-during-render warning (commit TBD)
