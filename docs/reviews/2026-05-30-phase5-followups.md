# Phase 5 review — deferred findings

Consolidated adversarial review of Phase 5 (Units 18–20 dynamic-properties
inspector + the no-auth fix), diff `c2be235..674c7af`. 24 findings raised, 20
confirmed real. The 4 `fix-now` findings were resolved in `review(phase5)`
(controller node-id namespacing, generator PV/GENROU de-dupe, drill-down row
aria-label; plus the orphan/role a11y aria-label and the dead-export removal
folded in). The items below are confirmed-real but deferred.

## fix-in-followup

- **[high a11y]** `ControllerNode` orphan "!" warning glyph fails WCAG AA
  contrast in light mode (~2.19:1) — `--warning` token on `bg-background`.
  Resolved partially by the new role-bearing `aria-label`, but the *visual*
  contrast of the amber "!" still needs a darker token or a non-color cue.
- **[medium correctness]** `AttachedControllersSection` syn-filtering assumes
  `SynGen.idx == StaticGen.idx`. Holds for kundur and most cases, but ANDES
  does not guarantee it; a renewable plant could mis-list. Consider matching
  on the generator's own dynamic idx, or filtering by `(syn|gen)`.
- **[medium correctness]** Generator inspector still shows the *first* bucket
  entry for a shared idx (the static PV), while the SLD node now renders the
  dynamic GENROU icon. The node-id collision is fixed; the *which-params-to-
  show* ambiguity for a generator selection remains (pre-existing).
- **[medium a11y]** Controller badge focus-name relies on the new inner
  `role="img"` aria-label; consider stamping `node.ariaLabel` in `graph.ts`
  so React Flow's focusable wrapper itself is named.
- **[medium known-finding B]** Boot creates two sessions (StrictMode double-
  invoke) and panel queries (`pmu`/`profiles`/`snapshots`/`topology`) 409
  against the blank/second session — expected dev noise, NOT worsened by the
  no-auth change. Quieten by gating panel queries on a loaded case, and/or
  hardening the `CREATE_DEBOUNCE_MS` guard against the >1s-latency race.
- **[low maintainability]** `controllers.ts` static class table is a real
  drift risk vs the ANDES model registry (documented, accepted for now).
- **[low maintainability]** Generic control-block glyph duplicated between
  `RightInspector.KindGlyph` and `ControllerGlyph` 'other'.
- **[low a11y]** Inspector header glyph is generic for all controllers; the
  'other' eyebrow reads as plain "Controller".
- **[low a11y]** Badge idx text at 9px is below comfortable legibility.
- **[low spec-flow]** Documented per-subKind accordion-state persistence is
  not implemented — all controllers share one `controller` localStorage key.
- **[low spec-flow]** Controller tether is asserted to exist but not that it
  renders visibly (SVG width/height=0).

## accept-as-is

- **[low agent-native]** The frontend sub-kind classifier recognises more
  model classes than the substrate emits — drift risk, not a parity gap.
- **[low spec-flow]** A controller whose upstream controller is itself an
  orphan can become an orphan rather than docking to it (order-dependent,
  rare, untested).
