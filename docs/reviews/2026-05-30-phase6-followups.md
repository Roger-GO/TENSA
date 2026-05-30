# Phase 6 review — record

Consolidated adversarial review of Phase 6 (clone-on-write: Units 0/21/22/23/24),
diff `f7cb394..HEAD`, weighted toward security + data-integrity (this phase
writes files). 7 findings raised and confirmed — **all 7 were fixed in
`review(phase6)`** (none deferred).

## Fixed

- **[MED data-integrity] `save_as` silently clobbered an existing workspace file
  (including the loaded original).** The originals live in the same workspace, so
  a save-as named after the loaded case would destroy it through the save-as
  door. Fixed: `CloneManager.save_as(..., overwrite=False)` now refuses on any
  destination collision (resolved + checked before writing any file), threaded
  through wrapper/worker/route/schema (`CloneSaveAsRequest.overwrite`). The web
  dialog already blocked collisions client-side; this is server-side
  defence-in-depth that also closes the direct-API path. New tests:
  refuse-then-overwrite-with-flag + refuse-to-clobber-the-loaded-original
  (asserts the original is byte-identical).
- **[HIGH a11y] "Revert this field" was keyboard-unreachable** (a focusable
  button inside a Radix Tooltip on a non-focusable span). Rewrote
  `ModifiedFromOriginalDot` as a **Popover**: the dot is a real focusable button
  whose accessible name carries the diff; the Original→current text + the revert
  button live in keyboard-reachable popover content. Dot enlarged 4px→6px.
- **[MED a11y] Clone-edit save spinner not announced** → `role="status"` +
  `aria-live="polite"` + a per-param label.
- **[MED a11y] Save-as name input not associated with its error** → `useId` +
  `aria-invalid` + `aria-describedby` pointing at a single message region.
- **[MED a11y] TDS-streaming lock reason unreachable by keyboard** (tooltip on a
  disabled input) → the wrapper span is now `tabIndex=0` + `role=group` +
  `aria-label` carrying the lock reason, so the tooltip opens on focus.
- **[LOW a11y] Edit/Run `role=switch` double-announced state** → fixed
  `aria-label="Edit mode"`; `aria-checked` carries on/off.

## Coverage caveat

The review workflow's verify-phase had several StructuredOutput failures, so a
subset of raised findings were not machine-verified and are not in the confirmed
set. Mitigations: (1) the security-critical Unit 21 paths (whitelist-first,
`_assert_within_workspace`, atomic edit restore, the in-place `.dyr` token
splice) were manually reviewed at commit time; (2) the 60 clone unit+integration
tests pass; (3) Unit 25 exercises the full edit→round-trip→undo/redo→save-as flow
on the live stack as the acceptance gate.
