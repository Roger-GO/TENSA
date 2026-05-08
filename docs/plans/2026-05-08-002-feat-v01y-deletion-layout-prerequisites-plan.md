---
title: "feat: v0.1.y — element deletion + layout overhaul + v0.2 prerequisites"
type: feat
status: active
date: 2026-05-08
origin: docs/brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md
---

# feat: v0.1.y — element deletion + layout overhaul + v0.2 prerequisites

## Overview

The v0.1.x plan ([2026-05-08-001](2026-05-08-001-feat-v01-polish-element-builder-plan.md), now `status: completed`) shipped the case builder + editor + element rendering on `feat/v01-ui`. While testing it the user surfaced two structural gaps that the plan had explicitly deferred — **element deletion** and a **proper layout engine for non-bus elements** — plus a smaller cluster of resilience and polish items that have to land before v0.2's TDS streaming UI can rest on a stable foundation.

This plan is the "v0.1.y" intermezzo: a focused medium-sized PR (extending `feat/v01-ui` or a follow-on branch) that closes those gaps, raises the test-coverage floor for the v0.1.x surfaces that landed without dedicated tests, and runs a v0.2-readiness gate before [v0.2's plan](2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md) starts.

Four phases, eight implementation units. Phase 1 = "delete what you added" is independently shippable. Phase 2 = "and the SLD is clean *and the layout is persistent*" requires Units 3 *and* 4 together (Unit 4's sidecar writer is what makes Unit 3's push-out output durable across reloads). Phase 3 = "and the session never gets stuck" is independently shippable. Phase 4 is the readiness gate before v0.2.

## Problem Frame

Per the v0.1.x plan's Scope Boundaries + Risks:

- **No element deletion** in v0.1.x. The plan's literal text: *"ANDES 2.0 has no clean pre-setup `delete()` API; deletion would require recreating the system from scratch."* Verified empirically (see Context & Research): `andes.System` exposes no `remove()` method. The replay-buffer mechanism added in Unit 2 of v0.1.x already records every successful add — deletion can re-build the system from `replay_buffer[:-1]` for blank sessions, or `reload_case() + re-apply(buffer)` for loaded sessions. The substrate-side machinery is in place; what's missing is the endpoint, wrapper method, and UI surface.

- **Element overlap recurred** even after Unit 13c's tighter offsets + row-parity stagger. The IEEE 14 visual smoke shows clean placement for the curated case, but custom user-built systems (especially with non-canonical coords) can still produce collisions when buses sit at arbitrary spacing. Ad-hoc kind-based offsets are a local fix; the right fix is a proper sub-layout pass that knows about every element's bounding box.

- **Session state gets sticky** when the substrate restarts mid-conversation. We saw this during browser smoke: the front-end's stored session id becomes stale, the next request 404s, the error stays pinned in the global alert (`createSession.isError === true`), and `useEnsureSession` never retries. v0.2's TDS streams will run for seconds-to-minutes; a sticky-error pattern there means the user has to reload the tab on every disconnect.

- **Several v0.1.x components landed without dedicated tests** (`SaveSystemButton`, `NewSystemButton`, `WorkflowToolbar`, `BusIdxSelect`, `CancelConfirmDialog`, `StubEdge`, `TransformerEdge`). The integration covers them via `AddElementPanel` + visual smoke, but unit-level coverage will surface regressions earlier and is a prerequisite for confidently changing any of them.

The user named this plan as the gating bundle before v0.2.

## Requirements Trace

Carried forward / extended from the v0.1.x brainstorm + Unit 2/9 plans:

**Layout & placement (R7, R28, R34):**

- **R7, R28 (carry-forward).** SLD renders every element kind anchored to its parent bus. v0.1.y maintains this and **strengthens** the placement guarantee: no element overlaps another element or its parent bus regardless of input coords.
- **R34 (NEW).** The SLD's element placement is **collision-free on the v0.2 demo topology set + a synthetic worst-case** input: no non-bus element overlaps another non-bus element, and no non-bus element overlaps a bus other than its parent. Verified on IEEE 14, IEEE 39, IEEE 300, and synthetic worst-case inputs (5 generators on one bus; vertically-stacked buses 80 px apart). The "any input topology" universal guarantee is *explicitly not* a goal — it would sandbag v0.5's compound-ELK swap (compound layout produces collision-free placement by construction; a universal-guarantee post-process would have to be re-implemented inside compound-ELK to maintain the contract). Push-out is a v0.1.y bandaid; v0.5's compound-ELK is the real fix. Maps to Phase 2 (Units 3 + 4).

**Element deletion (R30, R33):**

- **R30 (carry-forward, sharpened).** Add new elements via the slide-over panel. Today this works; the symmetric **delete** affordance was deferred. v0.1.y adds it.
- **R33 (NEW).** A researcher can **delete** any element they added (via `add_element`) while the system is in `pre-setup` state. Confirmation modal flags the destructive intent (R18). On submit, the substrate rebuilds the System from the replay buffer minus the deleted entry; the SLD updates without a full page reload. Case-file-originated elements are *not* deletable in v0.1.y — see Unit 1's "reload to revert" rejection path. Maps to Phase 1 (Units 1 + 2).
- **Scope-pull-forward from v0.5.** The v0.1.x plan's Scope Boundaries explicitly said "Element deletion → v0.5 plan after this one merges." The user pulled it forward; v0.1.y honours that decision.

**Session resilience (R35):**

- **R35 (NEW).** **Session resilience**: a stale session id is recovered transparently — the next API call that 404s triggers automatic session re-creation, the topology query refetches against the new id, and the user sees no error UI for this transition. Manual reload of the tab is no longer required after a substrate restart. Maps to Phase 3 (Units 5 + 6).

**Test coverage (R36):**

- **R36 (NEW).** Every component shipped in v0.1.x with public behavioural surface (mutation hooks, modal flow, toolbar interactions) carries unit tests at the same coverage bar as the components that did get tests in v0.1.x. Maps to Phase 4 (Unit 7).

## Scope Boundaries

- **No bulk delete.** One element per click; no multi-select, no shift-click range. v0.5 / v1.0 territory.
- **No undo of deletes.** "Undo last edit" already covers the most-recent add; v0.1.y extends it to include "undo last delete" only if the substrate's replay-buffer happens to make it free, which it does (delete = pop-and-replay; undo = restore-and-replay). If implementation reveals the symmetry isn't clean, deferring is acceptable.
- **No cascade preview.** Deleting a bus that still has lines / generators / loads attached fails with a 422 listing the dependents; the UI surfaces the list and the user deletes the dependents first. We do not auto-cascade in v0.1.y because cascade semantics in ANDES are not stable across model classes (e.g., a Line with a missing terminal bus would corrupt the System). The user explicitly opts in to each delete.
- **No layout engine swap to compound-ELK.** Compound-node layout in elkjs is powerful but introduces port-constraint interactions we'd need to re-validate; for v0.1.y we stay with the existing single-pass + per-bus offsets approach and **add a collision push-out post-process** that nudges any colliding non-bus node onto the nearest free position. Compound-ELK is a v0.5 candidate.
- **No session-recovery for committed-state crashes.** If the substrate dies *while a session is committed* (mid-PF), recovery requires re-loading the case + re-running PF. v0.1.y handles only the pre-setup case (the most common, and the one most affected by short server restarts during development).
- **No production-grade auth re-flow.** v0.1.y keeps the URL-fragment + session-storage token cycle. A polished re-auth modal that survives session expiry without losing form state is v0.5 territory.
- **No README rewrite.** The v0.1.y test-coverage + docs unit updates the existing `web/README.md` and `docs/interaction-states.md` files; a marketing-grade landing-page README (with screenshots, install instructions, etc.) is out of scope.

### Deferred to Separate Tasks

- **Compound-ELK layout** — separate v0.5 plan after empirical investigation of port-constraint behaviour with nested children.
- **Multi-select bulk delete** — v0.5+.
- **Auth re-flow modal that preserves form state** — v0.5+.
- **Run history persistence** — v1.5+ per origin doc.
- **Mid-stream session recovery for TDS** — v0.2 plan should consider it; v0.1.y only handles pre-setup.

## Context & Research

### Relevant Code and Patterns

- **Origin document**: `docs/brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md` — R7, R28, R30 are v0.1 carry-forwards; R33-R36 are new for v0.1.y.
- **Predecessor plan**: `docs/plans/2026-05-08-001-feat-v01-polish-element-builder-plan.md` (status: completed). v0.1.x's Scope Boundaries are the authoritative source for what was deliberately deferred.
- **Successor plan**: `docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md` (status: active). v0.1.y's Phase 4 readiness gate validates that v0.2's prerequisites are met before that plan starts.

Existing code paths v0.1.y extends:

- `server/src/andes_app/core/wrapper.py` — `Wrapper.add_element`, `edit_element`, `undo_last_edit`, `_replay_buffer`. New `delete_element` lands here, mirroring `undo_last_edit`'s reload-and-replay pattern.
- `server/src/andes_app/api/routes/elements.py` — pre-setup-gated mutation endpoints. New `DELETE /api/sessions/{id}/elements/{model}/{idx}` follows the same shape as `PUT`.
- `server/src/andes_app/api/schemas.py` — Pydantic v2 schemas. The DELETE endpoint reuses `TopologyEntry` for the dependents list when deletion fails on attached references.
- `web/src/components/inspector/ElementInspector.tsx` — Properties tab. A trash-icon `DeleteElementButton` renders alongside the existing `EditElementButton` when state is `pre-setup`.
- `web/src/components/sld/graph.ts` — `buildGraph` + non-bus placement. The collision push-out pass runs after the existing kind-based offset computation.
- `web/src/api/queries.ts` — TanStack Query hooks. New `useDeleteElement()` mutation hook + extension to the existing 401 cascade for 404 session recovery.
- `web/src/store/session.ts` (or equivalent) — `useSessionStore` + the `useEnsureSession` cycle. A `resetSession()` action lets `useEnsureSession` recover without a tab reload.

### Institutional Learnings

- `docs/solutions/2026-05-07-cli-anything-andes-architectural-mismatch.md` — confirms why we can't shellout to `andes-cli`; the substrate is the only path. Reinforces the wrapper-only deletion approach.
- Memory `reference_andes_quirks.md` — ANDES pre-setup contract: `ss.add()` works, `ss.remove()` does NOT exist, `ss.alter()` is post-setup, `ss.PFlow.run()` requires explicit prior `ss.setup()`. v0.1.y respects all of these.
- Memory `feedback_collab_style.md` — user prefers comprehensive scope; v0.1.y bundles deletion + layout + resilience rather than splitting into three plans.

Empirical verification done at planning time:

- `andes.System` exposes no `remove`, `delete`, or `pop` method (verified via `dir(System())`).
- Each ANDES Model class exposes `__delattr__` (Python builtin) but no public per-device removal API.
- `andes/main.py:213` has `remove_output()` (file-system cleanup, unrelated).
- Conclusion: deletion MUST go through the same reload-and-replay mechanism `undo_last_edit` already uses.

### External References

- **elkjs compound-node layout**: `eclipse.dev/elk/reference/options/org-eclipse-elk-hierarchyHandling.html`. Documented as the path forward for v0.5; out of scope for v0.1.y.
- **React Flow nested nodes**: `reactflow.dev/learn/layouting/sub-flows`. Same — relevant for v0.5.
- **Collision-push-out for graph layout**: a well-known force-directed post-process; cheap to implement and idempotent. v0.1.y uses a stripped-down version: for each non-bus node, if it overlaps any other node, push it along the perpendicular to its stub edge until clear.

## Key Technical Decisions

These are settled now. Reversing any of them changes scope, sequencing, or risk and would warrant a plan revision.

- **Deletion uses reload-and-replay.** ANDES has no native pre-setup remove; the substrate's `_replay_buffer` (added in v0.1.x Unit 2) is the only path. The wrapper's `delete_element(model, idx)` mirrors `undo_last_edit`'s logic: pop the matching entry from the replay buffer, reload from file (loaded session) or recreate `andes.System()` (blank session), replay the kept entries. Cost: one full case re-parse for loaded sessions per delete (~1-2s for IEEE 14/39, ~5-10s for IEEE 300). Acceptable for v0.1.y given the spinner + budget + atomicity decisions below; if it becomes a bottleneck, v0.5 can investigate `ss.remove()` empirically once a future ANDES release ships it.

- **Deletion is atomic.** Before reload-and-replay starts, the wrapper snapshots the current `self._ss` reference (and the existing `_replay_buffer` list). If any step of the rebuild fails — a replay raises, ANDES rejects an `add_element` call, the cascade walker missed a reference — the wrapper restores both snapshots, ensuring the System is either fully rebuilt or unchanged. Never partial. Test scenario asserts this on a synthetic replay-failure injection.

- **Latency budget for deletion (resolved post-review):** completes within 1 second for cases ≤100 buses (IEEE 14, IEEE 39, blank sessions with up to 100 added elements). The dialog shows a `<Spinner />` ("Deleting...") starting at 200ms after submit; before 200ms the dialog stays in confirm-state (avoids spinner flash on fast deletes). For cases >100 buses, no hard budget — the spinner stays visible until the topology refetches. Perf test on IEEE 14 + IEEE 39 enforces the ≤1s budget in CI.

- **Cascade detection BEFORE attempting the delete.** The wrapper checks whether the target element is referenced by any other element (e.g., a Bus referenced by a Line's `bus1`/`bus2`, by a Generator's `bus`, by a Load's `bus`, by a Shunt's `bus`). If references exist, the DELETE returns 422 with `{dependents: [TopologyEntry], total: int}` — `dependents` is capped at 25 entries; `total` is the full count. The UI surfaces the first 25 with a "Showing 25 of `<total>` dependents" footer when truncated. We do not auto-cascade.

- **Layout collision push-out, not compound-ELK.** A post-process pass walks every non-bus node, computes its bounding box (size from the kind-specific footprint constants), and for each pair `(A, B)` where the boxes overlap, shifts `B` along the perpendicular to its stub-edge axis by `(overlap + safety_gap)` until clear. Push-out runs in a single pass with priority order `bus → generator → load → shunt` so buses anchor everything. Idempotent: a second pass is a no-op when collisions are already resolved.

- **Session recovery on 404 via `useSessionStore.resetSession()` + auto-retry.** The `andesClient` already routes 401 globally; v0.1.y adds a 404-on-`/sessions/{id}/*` recovery path: the global handler clears the stored session id, fires `useEnsureSession`'s create cycle, and the failing query auto-retries once with the new id. Topology + sidecar queries refetch against the new session. The user sees a brief "Reconnecting..." badge instead of a sticky error.

- **Sticky-error fix in `useEnsureSession`.** Today `useEnsureSession` gates on `!createSession.isError`, which traps the cycle once any 401/404/timeout fires. v0.1.y replaces the gate with `!createSession.isPending` AND a manual `reset()` triggered by the recovery handler. This makes session creation idempotent — repeat attempts are allowed as long as none is in flight.

- **Test coverage bar for v0.1.x components.** Each new component test covers: render-when-applicable + render-when-disabled + happy-path interaction + error-path interaction. Same shape as the existing `EditElementButton.test.tsx` pattern. No additional integration tests; existing ones cover the cross-component flow.

- **Sidecar `non_bus_coordinates` is a v0.1.y schema addition.** The curated JSONs (`ieee14.layout.json`, `ieee39.layout.json`) in v0.1.x carry only `coordinates` for buses — the `non_bus_coordinates` field does not exist anywhere yet. Unit 4 adds it across three layers in lockstep: (1) the server `SidecarLayout` Pydantic schema (currently `extra="forbid"`, so the field has to be declared before the writer can populate it), (2) the TypeScript `parseSidecar` validator + `buildSidecarLayout` writer, (3) the `SaveSystemButton.writeSidecarAlongside` partition logic. The client graph builder's `nonBusCoords` opts parameter (added in v0.1.x Unit 3) is already forward-compatible — it will read whatever the sidecar supplies. Without Unit 4, the layout overhaul would persist bus drags but lose generator/load/shunt drags on save → confusing for the user.

## Open Questions

### Resolved During Planning

- **Should deletion cascade automatically?** No — explicit per-element confirmation. Auto-cascade is fragile across ANDES model classes. (See Key Technical Decisions.)
- **Layout engine: compound-ELK or push-out?** Push-out for v0.1.y; compound-ELK deferred. (See Key Technical Decisions.)
- **What's the right session-recovery scope?** Pre-setup only; committed-state recovery is a v0.2 concern. (See Scope Boundaries.)
- **Sidecar schema extension scope?** Add `non_bus_coordinates` to the substrate Pydantic + curated JSON forward-compat reads. The full schema upgrade landed in v0.1.x; v0.1.y just wires the writer.

### Deferred to Implementation

- **Exact safety-gap pixel for collision push-out** — the implementer eyeballs it on IEEE 14, IEEE 39, and a synthetic worst-case (5 generators on one bus). Start at 8 px; tune in visual smoke.
- **Whether `useEnsureSession` should also reset on a stale-session 404 from `useTopology`** — implementer decides during Phase 3 based on whether the topology query already retries on 404 via TanStack Query's default retry. Likely yes; document the path.
- **Test-coverage unit ordering within Phase 4** — implementer sequences by component complexity (start with `BusIdxSelect`, end with `WorkflowToolbar`).

## Implementation Units

### Phase 1 — Element deletion (R33; v0.5 pull-forward)

- [ ] **Unit 1: Substrate delete API + wrapper method**

**Goal:** Land `DELETE /api/sessions/{id}/elements/{model}/{idx}` with cascade-detection + reload-and-replay semantics. Parity with the existing `add_element` / `edit_element` pre-setup gate + sanitization.

**Requirements:** R33.

**Dependencies:** None (extends v0.1.x's substrate; no other v0.1.y unit depends on it before its own start).

**Files:**
- Modify: `server/src/andes_app/core/wrapper.py` — add `delete_element(model, idx)` that pops from `_replay_buffer`, reloads (loaded) or rebuilds (blank), replays the kept entries. Add `_find_dependents(model, idx)` that walks all model classes and returns a list of references.
- Modify: `server/src/andes_app/api/routes/elements.py` — add `DELETE /sessions/{session_id}/elements/{model}/{idx}` returning 200 + updated `TopologySummary` on success, 409 if committed, 404 if idx not found, 422 + `dependents` list if cascade would orphan references.
- Modify: `server/src/andes_app/api/schemas.py` — add `DeleteElementResponse` (TopologySummary alias) + add `DeleteBlockedResponse(BaseModel)` with explicit fields `dependents: list[TopologyEntry]` (capped at 25) and `total: int` (full count). The 422 ships through this typed schema (declared via FastAPI `responses={422: {"model": DeleteBlockedResponse}}` on the route), not through `ProblemDetails.extra` — gives the generated TypeScript client an exact type instead of `[k: string]: unknown`.
- Modify: `server/src/andes_app/core/worker.py` — add `_handle_delete_element` to the HANDLERS map.
- Modify: `server/src/andes_app/core/errors.py` — add `ElementHasDependentsError` with a `dependents: list[TopologyEntry]` attribute.
- Test: `server/tests/integration/test_elements_api.py` — new tests covering the scenarios below.

**Approach:**
- Order of operations: (1) whitelist check — `model` must be in `_PARAMS_BY_MODEL`, else 422 immediately; (2) replay-buffer check — `(model, idx)` must be in `_replay_buffer`, else 422 with the "reload to revert" message; (3) cascade detection; (4) reload-and-replay. The whitelist check precedes cascade detection so an unknown `model` string never reaches the dependents walker.
- **Replay-buffer invariant**: the buffer only tracks successful `add_element` calls. `reload_case()` clears the buffer; case-file-originated elements never enter it. The `(model, idx) in _replay_buffer` check is the ground truth for "was this added by the user in this session?". Disturbances (`add_disturbance`) are *not* recorded in the replay buffer — see Risks for the implication that delete drops disturbances.
- Cascade detection: for a Bus deletion, walk every Line, Generator, Load, Shunt and check `bus1`/`bus2`/`bus` references. For a Line deletion: no dependents (Lines aren't referenced by anything). For a generator/load/shunt: no dependents.
- Replay logic mirrors `undo_last_edit` but pops a specific `(model, idx)` entry, not the most recent. If the entry isn't in the replay buffer (i.e., the element came from the loaded case file, not from `add_element`), the wrapper raises `ElementValidationError("This element came from the loaded case file. Use the Reload button in the workflow toolbar to reset to the original case.")` — v0.1.y doesn't support deleting case-file-originated elements, only user-added ones.
- Wrapper's reload uses the same code path as `reload_case`. Cost: one full re-parse per delete on loaded sessions; instant on blank.

**Patterns to follow:**
- `server/src/andes_app/core/wrapper.py` — `undo_last_edit` is the structural template.
- `server/src/andes_app/api/routes/elements.py` — `edit_element` route is the template for the new DELETE route.

**Test scenarios:**
- Happy: blank session + add 3 buses + delete Bus 2 → topology has Bus 1 and Bus 3 only.
- Happy: loaded IEEE 14 + add a 15th bus + delete it → topology back to 14 buses.
- Edge: delete a Bus that has a Line attached → 422 + `dependents: [Line entry]`. After deleting the Line, Bus deletion succeeds.
- Edge: delete a Bus with multiple dependents (Line + Generator + Load) → 422 + dependents list contains all three.
- Edge: delete a generator → no dependents check needed (generators aren't referenced by other elements); succeeds.
- Edge: delete an idx not in the replay buffer (case-file-originated) → 422 with the "reload to revert" message.
- Edge: delete on a committed session → 409 with the standard `/reload` directive.
- Edge: delete with a non-existent idx → 404.
- Auth: DELETE without `X-Andes-Token` → 401.
- Edge: replay-failure injection (test inserts a sentinel into the replay buffer that fails on re-add) → wrapper raises, the snapshot is restored, `ss` and `_replay_buffer` are unchanged from pre-delete state.
- Perf: delete on IEEE 14 + IEEE 39 completes in <1s (per the latency budget). Asserted via `pytest.mark.benchmark` or wallclock assertion.

**Verification:**
- All 7+ new server tests pass.
- Existing 152 server tests still green.
- `mypy --strict` + `ruff` clean.

---

- [ ] **Unit 2: UI delete affordance**

**Goal:** Trash-icon `DeleteElementButton` renders in the Properties tab when state is `pre-setup`. Confirm dialog flags the destructive action; on dependents-422 the dialog flips to a list view explaining what to delete first.

**Requirements:** R33.

**Dependencies:** Unit 1.

**Files:**
- Create: `web/src/components/elements/DeleteElementButton.tsx` — trash-icon button + Radix Dialog confirm + dependents-list error path.
- Modify: `web/src/components/inspector/ElementInspector.tsx` — render the delete button in the Properties tab header (or alongside the existing reset banner) when `state === 'pre-setup'` and `!isPflowRunning`.
- Modify: `web/src/api/queries.ts` — add `useDeleteElement()` hook returning `UseMutationResult<TopologySummary, Error, DeleteElementVars>`. On success, invalidate the topology query AND clear `case.selectedElement` if the deleted element was selected.
- Modify: `web/src/api/types.ts` — re-export `DeleteElementResponse` from generated.ts.
- Test: `web/tests/unit/components/elements/DeleteElementButton.test.tsx` — covers the scenarios below.

**Approach:**
- The button sits in the ElementInspector's `<header>` row, right side: `[kind+idx text, flex-grow spacer, DeleteElementButton]`. Always visible (not Properties-tab-only) when state is `pre-setup` and `!isPflowRunning`. Tooltip "Delete this element" on hover. This is a per-element action; it does NOT mirror EditElementButton's per-row pencil pattern (the per-row pencils stay where they are).
- Confirm dialog: "Delete `<kind> <idx>`? This cannot be undone." with Cancel + Delete (danger variant). After clicking Delete, if the response takes >200ms, the dialog body switches to a `<Spinner />` + "Deleting..." text (otherwise the dialog closes on success without a spinner flash).
- On 422 dependents: the dialog text changes to "Delete blocked — `<total>` element(s) reference this `<kind>`. Delete those first:" with a list of dependent entries and a Cancel button. **Each dependent entry is a clickable button.** Click → the dialog closes, the inspector navigates to that element (`useCaseStore.setSelectedElement(...)`), and the SLD canvas highlights all *remaining* dependents with a warning ring (`ring-2 ring-warning/60`) so the user can see what's left to clear. The warning ring clears when the user re-opens the Bus delete dialog and the new 422 response shows fewer dependents (or zero, allowing the Bus delete to proceed). When `total > 25`, a footer `<small>` reads "Showing 25 of `<total>` dependents. Delete the visible ones first." The footer disappears when `total ≤ 25`.
- On 200: dialog closes, topology refetches, the inspector falls back to its "no element selected" state.
- The "Undo last edit" button in WorkflowToolbar already extends to delete operations (the substrate's replay-buffer pop also covers deletes), so the user can recover.

**Patterns to follow:**
- `web/src/components/elements/EditElementButton.tsx` — pencil-icon + dialog cycle.
- `web/src/components/elements/CancelConfirmDialog.tsx` — destructive Radix Dialog.
- `web/src/components/case/SaveSystemButton.tsx` — error-surface pattern (inline 422 + retry).

**Test scenarios:**
- Happy: render with state='pre-setup' → button visible. Click → dialog opens.
- Happy: confirm → mutation fires with `{sessionId, model, idx}`; on 200 the dialog closes.
- Edge: state='committed' → button hidden (matches the EditElementButton's render guard).
- Edge: PF running → button disabled (or hidden — match Edit's behavior).
- Error: 422 with dependents → dialog flips to list view; Delete button hidden, only Cancel.
- Error: 422 case-file-originated → dialog flips to a single message: "This element came from the loaded case file. Use the Reload button in the workflow toolbar to reset to the original case." with a Cancel button only.
- Latency: mock the mutation to resolve at 50ms vs 500ms vs 2s → at 50ms the spinner never appears (dialog closes immediately); at 500ms+ the spinner appears at the 200ms threshold and stays until close.
- Dependents navigation: click a dependent entry → dialog closes, `useCaseStore.selectedElement` is set to that entry, SLD canvas applies a warning ring to remaining dependents.
- Dependents cap: 422 with `total: 30` → list shows 25 entries + "Showing 25 of 30 dependents" footer. Cap at 25 with `total: 25` → no footer.

**Verification:**
- All new tests + existing 233 web tests pass.
- Manual: load IEEE 14 in pre-setup, delete a load, run PF — converges with the topology minus the deleted load.

### Phase 2 — Layout overhaul (R34, sidecar non-bus coords)

- [ ] **Unit 3: Collision push-out post-process**

**Goal:** No non-bus element overlaps another non-bus element or a non-parent bus, regardless of input topology + coords. The single-pass kind-based offset computation in `buildGraph` runs as today; a new `pushOutCollisions` step then walks the result and shifts colliding nodes until clean.

**Requirements:** R34.

**Dependencies:** None (extends `buildGraph` in `web/src/components/sld/graph.ts`).

**Files:**
- Modify: `web/src/components/sld/graph.ts` — add `pushOutCollisions(nodes, params)` exported function. Called from `buildGraph` after the existing non-bus emission loop. Walks every pair `(A, B)` where `A.type !== 'bus'` and the bounding boxes overlap; shifts `B` along the perpendicular to its stub-edge direction by `(overlap + SAFETY_GAP)`. Idempotent; runs to fixpoint or `MAX_PASSES` (default 4).
- Modify: `web/src/components/sld/SldCanvas.tsx` — no change needed; `buildGraph` is the single integration point.
- Test: `web/tests/unit/components/sld/collisionPushOut.test.ts` — synthetic worst-case scenarios.

**Approach:**
- Bounding box per kind: bus 90×56, generator 50×46, load 50×46, shunt 50×46 (post-Unit-13c shrink). Constants exported for tests.
- Push direction per kind: generators push UP (further north), loads push DOWN (further south), shunts push LEFT-DOWN (further south-west). Exception: if pushing further would put the node outside a reasonable canvas bound, fall back to the perpendicular axis (lateral).
- Worst-case complexity: O(n²) with n = total non-bus elements. For IEEE 300 (~600 non-bus) that's 360k pair checks per render — fine for a one-time computation, batched into the existing useMemo.
- Drag overrides take precedence: a node with a `dragOverrides[id]` entry skips the push-out (the user explicitly placed it).
- **Smooth animation on relocation:** when push-out moves a node from a previous position (compared against the prior render's node positions, tracked in a `useRef` map), React Flow's built-in node position transition animates the move over `--duration-base` (200ms). Newly-emitted nodes (no prior position) appear in place without animation. This gives the user a visible signal that the layout adjusted, while keeping the deterministic-output contract.

**Patterns to follow:**
- `web/src/components/sld/graph.ts` — `computeHandleAssignments` for the structural pattern (pure function, takes topology + coords, returns a derivative map).
- D3-force collide algorithm (external reference; do not import d3).

**Test scenarios:**
- Happy: synthetic input with one generator + one load on the same bus, overlapping y → push-out separates them along x.
- Happy: 5 generators on one bus → all 5 land non-overlapping. The existing per-bus fan-stack from v0.1.x's Unit 13c (in `graph.ts`'s NON_BUS_OFFSETS computation) places generators horizontally side-by-side along the bus's north face; push-out runs *after* this and resolves any residual vertical overlaps that the fan-stack didn't catch (e.g., a generator on bus A colliding with a load on bus B that sits directly below). The two stages are sequential, not redundant.
- Happy: IEEE 300 (~600 non-bus elements) → push-out completes in <500ms (perf budget for the largest topology in the v0.2 demo set). The 50-device <50ms budget below remains the unit-test budget; the IEEE 300 budget is a manual-smoke check.
- Happy: BUS5 + BUS6 vertical neighbors with a load on BUS5 + generator on BUS6 sharing default y → push-out separates them.
- Edge: drag overrides → no push-out applied to overridden nodes.
- Edge: idempotence → running push-out twice produces the same result (fixpoint).
- Edge: 50+ devices on one canvas → completes in <50ms (unit-test perf budget).
- Animation: a node relocated by push-out (compared against the prior render's positions) renders with a `transition: transform 200ms` style applied; a newly-emitted node renders without transition.

**Verification:**
- All new tests + existing tests pass.
- Manual: synthetic 5-gen-on-one-bus topology + IEEE 14 + IEEE 39 — every device visually clear.

---

- [ ] **Unit 4: Sidecar non_bus_coordinates wired through the writer**

**Goal:** Drag positions of generators / loads / shunts persist to disk via the same sidecar JSON that holds bus coords. Reload of a saved system restores the exact layout.

**Requirements:** R34 (durability of placement decisions).

**Dependencies:** Unit 3 (so the overhauled layout's drag positions are what gets saved).

**Files:**
- Modify: `server/src/andes_app/api/schemas.py` — extend `SidecarLayout` with `non_bus_coordinates: dict[str, dict[str, BusCoord]] = Field(default_factory=dict, ...)`. Same shape as the curated JSONs (model_class → idx → BusCoord).
- Modify: `web/src/components/sld/sidecar.ts` — `parseSidecar` validates the new field; `buildSidecarLayout` accepts a `nonBusCoords` parameter and writes them through.
- Modify: `web/src/components/sld/SldCanvas.tsx` — on drag-end of a non-bus node, also push that coord into the disk-sidecar PUT (today only bus drags persist).
- Modify: `web/src/components/case/SaveSystemButton.tsx` — extend `writeSidecarAlongside` to include non-bus coords from `dragOverrides` (currently filters to bus nodes only).
- Modify: `web/src/components/sld/graph.ts` — `nonBusCoords` opts already supported (Unit 3 of v0.1.x); just wire the SLD canvas to read from the sidecar instead of an empty default.
- Test: `web/tests/unit/components/sld/sidecar.test.ts` — extend existing tests with `non_bus_coordinates` round-trip cases.

**Approach:**
- Sidecar reads pull both `coordinates` (buses) and `non_bus_coordinates` (devices). The graph builder's `nonBusCoords` param becomes the merged map of all device coords.
- **Key shape (resolved post-review): save under both layers, reader prefers model-class match with UI-category fallback.** The drag-override map keys are React Flow node IDs of the form `${uiCategory}-${idx}` (e.g., `generator-1`); the graph builder's existing `nonBusCoords` Map uses `${modelClass}|${idx}` keys (e.g., `PV|1`). On save, `writeSidecarAlongside` walks `dragOverrides` and writes each non-bus coord under BOTH keys: the exact model class (`PV|1`) AND the UI category (`generator|1`). On load, the graph builder reads model-class first, falls back to UI-category if the exact class isn't found. This survives the kind-edit case (PV → GENROU): the saved `PV|1` becomes orphaned but `generator|1` still resolves; on next save, the now-GENROU coord is written under `GENROU|1` AND `generator|1`. Doubles the field count but the sidecar is still tiny (a few hundred bytes for IEEE 300).
- Backward compat: a sidecar with no `non_bus_coordinates` field reads as `{}`. Old curated JSONs stay valid.
- Save flow: SaveSystemButton's `writeSidecarAlongside` partitions `dragOverrides` by node prefix (`generator-`, `load-`, `shunt-` → non_bus; else bus) and writes both shapes per the dual-key strategy above.

**Patterns to follow:**
- `web/src/components/sld/sidecar.ts` — existing `parseSidecar` validation pattern.
- `server/src/andes_app/api/schemas.py` — Pydantic v2 + `field_validator` for finite-coord checks.

**Test scenarios:**
- Happy: save IEEE 14 + drag-and-save → sidecar contains `non_bus_coordinates` with the dragged device positions.
- Happy: load a saved sidecar with non-bus coords → SLD renders devices at the saved positions, not the kind-default offsets.
- Edge: load an old sidecar without `non_bus_coordinates` → reads as `{}` cleanly; non-bus elements use kind-default offsets.
- Edge: NaN/Inf in a non-bus coord → sidecar validator rejects (matches BusCoord finite-check).

**Verification:**
- Server + web tests pass; mypy + lint clean.
- Manual: drag generator → save → reload page → generator at the dragged position.

### Phase 3 — Session resilience (R35)

- [ ] **Unit 5: Session-recovery on 404**

**Goal:** A stale session id surfaces no error UI; the global error handler triggers automatic recreation, the failing query retries once with the new id, and the topology + sidecar refetch transparently. The "Reconnecting..." brief badge is the only signal the user sees.

**Requirements:** R35.

**Dependencies:** None.

**Files:**
- Modify: `web/src/api/queries.ts` — extend the existing `wireGlobal401Handler` (rename to `wireGlobalErrorRecovery`) to also catch 404 on `/api/sessions/{id}/*` paths. On match, clear `useSessionStore.sessionId`, fire a re-create cycle, and tag the failing query for retry.
- Modify: `web/src/store/session.ts` — add `resetSession()` action that clears the id without invalidating the auth token. Add a `recoveryInProgress: boolean` flag for the badge.
- Modify: `web/src/components/case/WorkspaceFilePicker.tsx` — `useEnsureSession` hook: replace the `!createSession.isError` gate with `!createSession.isPending` + manual `reset()` triggered by the recovery handler. Idempotent.
- Modify: `web/src/components/shell/AppShell.tsx` (or `TopBar.tsx`) — render a `RecoveryBadge` in the top bar's right-side chrome region (sibling of any existing top-bar buttons) when `useSessionStore(s => s.recoveryInProgress) === true`. Spec: pill shape (`bg-warning/10 border border-warning/40 text-warning text-xs px-2 py-1 rounded-full`) with a small spinner icon + "Reconnecting..." label. Non-blocking — does not overlay any UI; user can still see + interact with the canvas. Session-scoped queries (`useTopology`, etc.) are already gated on `sessionId !== null` (verified in `queries.ts`), so they automatically pause during recovery and resume against the new session id without explicit blocking.
- Create: `web/src/components/shell/RecoveryBadge.tsx` — the new badge component. Auto-hides when `recoveryInProgress` flips back to `false` (post-create-success in `useEnsureSession`'s effect). On recovery-failed (>3 attempts in 30s window), the badge text changes to "Reconnection failed — reload the tab" with `bg-destructive/10 border-destructive/40 text-destructive` styling and stays pinned until tab reload.
- Test: `web/tests/unit/api/sessionRecovery.test.ts` — new test file covering the recovery flow.

**Approach:**
- The TanStack Query `MutationCache.onError` handler inspects the error: if it's a `ProblemDetailsError` with `status === 404` AND the path matches `/api/sessions/{id}/*`, the handler fires `useSessionStore.getState().resetSession()` (which sets `sessionId = null` AND `recoveryInProgress = true`) then relies on `useEnsureSession`'s effect to fire the create cycle. The retry happens via TanStack Query's default `retry: 1` for the affected queries; mutations get `retry: false` (no auto-retry on mutations, but the next user action will hit the new session).
- **Wiring `createSession.reset()` from a global handler (resolved post-review):** the global subscriber cannot directly call a hook-instance mutation method. Instead, `useEnsureSession` registers a `useEffect` that watches `useSessionStore(state => state.recoveryInProgress)`; whenever the flag transitions `false → true`, the effect calls `createSession.reset()` locally to clear any prior `isError` state, then the gate `!createSession.isPending` allows a fresh create on the next render. After the create resolves successfully, the effect clears `recoveryInProgress` back to `false` (which auto-hides the badge).
- The recovery is debounced per second (a `useRef` timestamp inside `useEnsureSession`) to avoid thrashing if multiple 404s fire in a burst. Beyond 3 attempts within a 30-second window, the recovery-failed branch surfaces a hard error.
- Documented as a self-healing path; user-visible signal is the "Reconnecting..." badge that appears immediately on `recoveryInProgress = true` and remains visible until the new session is established (typically 200ms-2s, depending on substrate restart speed).
- **Mutations carry stale request bodies (resolved post-review).** When recovery fires while a mutation is in flight, the mutation has already been constructed against the now-stale session id. With `retry: false` on mutations, the in-flight request 404s and surfaces an error; the user re-issues the action and it hits the new session. For loaded sessions: a fresh recovery-created session is *blank*, not a re-loaded case. The recovery handler must therefore also re-issue `loadCase` with the previously-loaded path (read from `useCaseStore.currentFilePath` if non-null) before clearing `recoveryInProgress`. This is part of Unit 5's scope.
- **Forward-compat caveat (security):** v0.1.y's recovery is safe under the current "no session-revocation policy" trust model. If a future SaaS phase adds server-side session revocation (e.g., admin invalidation), the recovery handler must inspect a revocation reason in the 404 body before auto-recreating; otherwise auto-recovery would defeat the revocation. Not a blocker for v0.1.y's local-trusted-user model.

**Patterns to follow:**
- `web/src/api/queries.ts` — `wireGlobal401Handler` is the structural template.

**Test scenarios:**
- Happy: stale session id + `useTopology()` fires → server returns 404 → recovery handler clears id + creates new session → topology refetches against new id → user sees no error.
- Edge: 404 on a non-session path (e.g., `/workspace/file/missing.raw`) → no recovery (this is a real 404, not a session-stale 404).
- Edge: rapid burst of 404s (3 queries fire at once) → only one recovery fires; the rest piggyback.
- Edge: recovery itself fails (substrate down) → standard 401/network error UI surfaces; the recovery isn't infinite.
- Edge: recovery-failed state (>3 attempts in 30s) → badge flips to destructive styling with "Reconnection failed — reload the tab" text and stays pinned.
- Edge: session-scoped query enabled-guard → assert `useTopology(null)` does not fire a request (current `enabled: sessionId !== null` invariant must hold during the recovery window).
- Edge: loaded-session recovery path → if `useCaseStore.currentFilePath` was non-null pre-recovery, the recovery effect re-issues `loadCase` with that path before clearing `recoveryInProgress`. New session has the case re-loaded, not blank.
- Integration: full session-restart simulation — kill the substrate, restart, trigger any user action → topology + sidecar both refetch transparently.

**Verification:**
- New tests pass.
- Manual: `pkill -HUP -f andes_app serve` mid-session, then restart with the same token → user can keep clicking without reloading the tab.

---

- [ ] **Unit 6: Sticky-error fix in `useEnsureSession`**

**Goal:** `useEnsureSession` no longer gets stuck after the first error. The cycle is idempotent: as long as no create is in-flight, a fresh attempt is allowed.

**Requirements:** R35.

**Dependencies:** Unit 5 (the recovery handler triggers reset).

**Files:**
- Modify: `web/src/components/case/WorkspaceFilePicker.tsx` — `useEnsureSession` rewrite per Key Technical Decisions.
- Test: `web/tests/unit/components/case/WorkspaceFilePicker.test.tsx` — extend existing tests with sticky-error recovery scenarios.

**Approach:**
- The current code: `shouldCreate = tokenPresent && sessionId === null && !createSession.isPending && !createSession.isError`.
- The fixed code: `shouldCreate = tokenPresent && sessionId === null && !createSession.isPending`. The `isError` gate goes away. The Unit 5 recovery effect (a `useEffect` inside `useEnsureSession` that watches `useSessionStore(s => s.recoveryInProgress)`) calls `createSession.reset()` locally whenever the recovery flag flips `false → true`, clearing any prior error state before the gate re-evaluates.
- Debounce: a `useRef`-tracked timestamp prevents rapid-fire create attempts (>1/sec).
- **Multi-component coordination:** today only `WorkspaceFilePicker` calls `useEnsureSession`. If a future component (e.g., a v0.2 session badge) also calls it, two components racing the create cycle could double-fire `POST /sessions`. Mitigation deferred — v0.1.y has only one caller; document as a known limitation if v0.2 adds a second consumer.

**Patterns to follow:**
- `web/src/components/case/WorkspaceFilePicker.tsx` — existing `useEnsureSession` shape; change the gate condition only.

**Test scenarios:**
- Happy: token present + sessionId null + no in-flight → create fires.
- Happy: create errors → next render attempts a fresh create (after debounce).
- Edge: rapid successive renders → only one create fires per debounce window.
- Edge: in-flight + new render → no new create.

**Verification:**
- New tests + existing 233+ pass.
- Manual: simulate a 401 → fix the token in storage → next user action triggers a fresh session create.

### Phase 4 — Polish + v0.2 readiness gate (R36)

- [ ] **Unit 7: Component test coverage gaps**

**Goal:** Bring the v0.1.x components without dedicated tests up to the same coverage bar as `EditElementButton`. Each test covers render-when-applicable + render-when-disabled + happy-path interaction + error-path interaction.

**Requirements:** R36.

**Dependencies:** None (purely additive).

**Files:**
- Test: `web/tests/unit/components/case/SaveSystemButton.test.tsx`
- Test: `web/tests/unit/components/case/NewSystemButton.test.tsx`
- Test: `web/tests/unit/components/case/WorkflowToolbar.test.tsx`
- Test: `web/tests/unit/components/elements/BusIdxSelect.test.tsx`
- Test: `web/tests/unit/components/elements/CancelConfirmDialog.test.tsx`
- Test: `web/tests/unit/components/elements/ElementForm.test.tsx`
- Test: `web/tests/unit/components/sld/edges/StubEdge.test.tsx` *(rendering smoke only — paths are visual)*
- Test: `web/tests/unit/components/sld/edges/TransformerEdge.test.tsx` *(same — rendering + flow-overlay smoke)*

**Approach:**
- Each test file follows the `EditElementButton.test.tsx` shape: stub `andesClient`, mount with `QueryClientProvider`, assert lifecycle + payload.
- For SaveSystemButton: cover format-radio switching, ensureExtension behavior, sidecar auto-write, 409 overwrite-flip, success/error toast.
- For NewSystemButton: cover the "no current case" path (direct fire) + "current case loaded" path (modal first), 409 surface, blank-session topology seed.
- For WorkflowToolbar: cover Reload (loaded session only) + Undo (disabled when committed) + the destructive-confirm modal.
- For BusIdxSelect: empty-state + populated-state + selection callback + optimistic-update wiring.
- For CancelConfirmDialog: render-when-open + Discard/Keep handlers.
- For ElementForm: cover the polymorphic field rendering (a Bus form has different fields than a Line form), required-field validation, idx prefill, duplicate-rejection.
- For StubEdge / TransformerEdge: render smoke + stride-offset honored + dot-render smoke.

**Patterns to follow:**
- `web/tests/unit/components/elements/EditElementButton.test.tsx` — the gold standard.
- `web/tests/unit/components/elements/AddElementPanel.test.tsx` — the form-mocking pattern.

**Test scenarios:** *Listed per file in Approach.*

**Verification:**
- Test count: 233 → ~290 (8 new test files, ~7 cases each).
- Lint + typecheck clean.

---

- [ ] **Unit 8: README + interaction-states refresh + v0.2 readiness gate**

**Goal:** The repo's README accurately describes what v0.1.y ships. The interaction-states matrix has rows for the new delete affordance, recovery badge, and dependents-error path. A v0.2 readiness checklist at the bottom of this plan is checked off before v0.2 starts.

**Requirements:** R36 + Documentation.

**Dependencies:** Units 1-7.

**Files:**
- Modify: `web/README.md` — add a "What's in v0.1.y" section listing delete, layout overhaul, session resilience, sidecar improvements.
- Modify: `web/docs/interaction-states.md` — new rows: DeleteElementButton (idle, confirm, dependents-error, **case-file-originated-error** ["reload to revert"], in-flight, success), Recovery badge (hidden, visible-during-recovery, **recovery-failed** [3 attempts in 30s window exceeded]), ElementForm prefill (default-prefilled, user-edited).
- Modify: `README.md` (root) — brief mention of the v0.1.y feature delta.
- Modify: `docs/plans/2026-05-08-002-feat-v01y-deletion-layout-prerequisites-plan.md` (this file) — populate the **v0.2 Readiness Gate** section below as a checklist; verify each row before marking the plan `status: completed`.

**Approach:**
- Keep README updates terse — bullet list of new capabilities, link to the plan for details.
- interaction-states.md follows the existing matrix shape (state name | trigger | UI | recovery).
- The readiness gate runs as a manual smoke before flipping the v0.2 plan from `status: active` to `status: in-progress` and starting Unit 1 there.

**Patterns to follow:**
- `web/docs/interaction-states.md` — existing matrix format.

**Test scenarios:** *(none — documentation-only)*

**Verification:**
- All readiness-gate items below are checked.
- Both README files render without typos.

## v0.2 Readiness Gate

Verified manually + via test suite before flipping v0.2's plan to in-progress. All boxes must be checked.

**Legend:** `[AUTO]` = verified by the test suite; `[MANUAL]` = requires interactive verification.

- [ ] **[MANUAL]** Element deletion: works on loaded IEEE 14 (delete a *user-added* element on top of the loaded case) + on a blank session built from scratch.
- [ ] **[MANUAL]** Cascade detection: deleting a Bus with dependents shows the dependents list and blocks the delete.
- [ ] **[AUTO]** Cascade-walker model coverage: every model in `_PARAMS_BY_MODEL` has either zero references or is exercised by `_find_dependents` (test asserts the invariant — see Unit 1 Risks mitigation).
- [ ] **[MANUAL]** Layout: synthetic 5-generators-on-one-bus topology renders with no overlap.
- [ ] **[MANUAL]** Layout: IEEE 39 renders with no element/element or element/non-parent-bus overlap.
- [ ] **[MANUAL]** Sidecar round-trip: drag a generator → Save System → reload page → load the saved file → generator at the dragged position.
- [ ] **[MANUAL]** Session recovery (pre-setup): kill the substrate mid-session, restart with the same token, click any canvas action → the session re-creates transparently without a tab reload. (Mid-PF / committed-state recovery is *out of scope* for v0.1.y; see Scope Boundaries.)
- [ ] **[MANUAL]** Sticky-error fix: simulate a 401 (typo in token), correct the token, next click triggers a successful session create.
- [ ] **[MANUAL]** Undo last edit: covers both add and delete operations symmetrically.
- [ ] **[AUTO]** Test count: 233 → ~290; all lint + typecheck + mypy --strict clean.
- [ ] **[MANUAL]** Documentation: README + interaction-states reflect v0.1.y changes.
- [ ] **[MANUAL]** PR on `feat/v01-ui` (or follow-on branch) is reviewed + ready to merge.

## System-Wide Impact

- **API surface delta**: one new endpoint (`DELETE /api/sessions/{id}/elements/{model}/{idx}`); one schema extension (`SidecarLayout.non_bus_coordinates`). Backward compatible — existing endpoints + schema fields unchanged.
- **Wire format**: SidecarLayout gets the new optional field. Old sidecars read as `{}` cleanly.
- **Session lifecycle**: an idle session is now self-healing on a stale id. Sessions still expire per the existing idle timeout; nothing about expiration policy changes.
- **Trust model**: unchanged. DELETE inherits the same X-Andes-Token gate as other mutations.
- **Observable failure modes**: 422 with dependents on a Bus delete. 404→recovered transparently for stale session ids (no user-visible error). Delete on case-file-originated elements rejects clearly.
- **Test coverage delta**: ~3-5 new server tests (Unit 1) + ~50 new web tests across Units 2-7. Server 152 → ~157; web 233 → ~290.
- **Performance**: collision push-out is O(n²) on non-bus count per render. For IEEE 300 (~600 elements) this is ~360k comparisons per topology change — fine. The push-out runs once per buildGraph computation, which happens on topology re-fetch, not on every drag.
- **Unchanged invariants**: v0.1.x's add/edit/blank/save/undo/reload endpoints. R8 error taxonomy. Edge routing + handle assignment + connection-dot dot rendering. v0.2 plan stays untouched.

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Cascade detection misses a reference (e.g., a future ANDES model class we haven't enumerated) → orphan reference after delete | Whitelist-based: only delete classes in `_PARAMS_BY_MODEL` are checked. Models not in the whitelist would already be unreachable via the add API, so they can't be deleted either. Add a coverage assertion in the test for "every model in `_PARAMS_BY_MODEL` is checked by `_find_dependents`". |
| Reload-and-replay is slow on large cases (IEEE 300+ buses) | Acceptable for v0.1.y; document the cost. v0.5 investigates `ss.remove()` empirically. The plan's risk treatment notes this as a known tradeoff. |
| Collision push-out produces visually unstable layouts (jitter on small topology changes) | Push-out is deterministic + idempotent. Same input → same output. Mitigation: pin the iteration order (priority `bus → generator → load → shunt`) and use a fixed `SAFETY_GAP`. Tested via the idempotence scenario. |
| Session recovery loops infinitely if the substrate keeps returning 404 | Per-second debounce + a max-recovery-attempts counter (default 3 within a 30-second window). Beyond that, surface a hard error and require a tab reload. |
| Sticky-error fix introduces a flood of session creates | The `!createSession.isPending` gate + debounce prevent flood. Tested via the rapid-render scenario. |
| Sidecar non_bus_coordinates schema change breaks tooling that reads the sidecar | Field is optional with `default_factory=dict`; old readers ignore the field. Documented as backward-compat in the schema docstring. |
| Delete drops disturbances. `add_disturbance` does NOT append to `_replay_buffer` (verified at planning time at `wrapper.py:322`). A `delete_element` reload-and-replay therefore replays only `add_element` history; any Faults / Toggles / Alters previously added via `add_disturbance` are silently lost. | Document this as a known limitation for v0.1.y. v0.1.y has no UI for adding disturbances yet (that's v0.2 territory), so the practical impact today is zero. v0.2's plan must either (a) record disturbances in the replay buffer too, or (b) re-apply the disturbance timeline from the Zustand store after delete completes, or (c) refuse delete while disturbances are present. Decide in the v0.2 plan; do not silently inherit. |
| Test coverage unit (Unit 7) takes longer than estimated | Implementer can split the unit into 2-3 PRs; the v0.2 readiness gate accepts a reduced coverage delta if the highest-risk components (SaveSystemButton, WorkflowToolbar) are covered. Document the reduced delta in the gate sign-off. |

## Documentation / Operational Notes

- **README updates** land in Unit 8 (`web/README.md` + root `README.md`).
- **interaction-states.md updates** land in Unit 8 (delete affordance, recovery badge, dependents-error path).
- **CHANGELOG entry**: under `v0.1.y — deletion + layout overhaul + resilience` describing the scope expansion.
- **PR description** when this plan completes: include a screen recording of the delete + recovery flows; include a synthetic worst-case layout screenshot demonstrating R34.
- **Plan status**: this plan transitions to `status: completed` after Unit 8's readiness gate passes. v0.2's plan flips from `status: active` to `status: in-progress` at that point.
- **Branch strategy**: extend `feat/v01-ui` (the existing PR #1 branch) OR open a follow-on `feat/v01y-cleanup` branch with PR #1 already merged. Implementer picks during Unit 1; either is fine.

## Sources & References

- **Origin document** — [docs/brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md](../brainstorms/2026-05-07-accessible-andes-power-systems-app-requirements.md). R7, R28, R30 are v0.1.x carry-forwards; R33-R36 are scope additions for v0.1.y.
- **Predecessor plan** — [docs/plans/2026-05-08-001-feat-v01-polish-element-builder-plan.md](2026-05-08-001-feat-v01-polish-element-builder-plan.md). Status: completed. Defines what shipped in v0.1.x and what was deferred.
- **Successor plan** — [docs/plans/2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md](2026-05-07-003-feat-v02-ui-disturbance-tds-streaming-plan.md). Status: active. Sequenced after v0.1.y.
- **PR #1** — `https://github.com/Roger-GO/ANDES_App/pull/1`. v0.1.y extends the same branch (or follow-on branch from this baseline).
- **ANDES `ss.remove()` empirical investigation** — verified at planning time that no public element-removal API exists in ANDES 2.0; deletion uses the substrate's replay-buffer mechanism.
- **elkjs compound-node layout** — `eclipse.dev/elk/reference/options/org-eclipse-elk-hierarchyHandling.html`. Documented as the v0.5 path forward; out of scope for v0.1.y.
- **D3-force collide algorithm** — `d3js.org/d3-force/collide`. External reference for the push-out post-process; v0.1.y implements a stripped-down variant without importing d3.
