# Interaction state matrix (R19)

This is the Phase 1 deliverable for R19. It enumerates every primary surface in
v0.1 against every interaction state it can occupy. Implementers reference this
during component build to ensure no state is silently elided.

The cells seeded by the v0.1 plan are filled in; the visual treatment column
captures the design intent (no implementation code — that lives in the
component files themselves).

## Conventions

- "Banner" = inline non-modal strip with text + dismiss control; never blocks
  interaction with the surface beneath it.
- "Overlay banner" = banner positioned at the top of the right dock, above
  inspector + results table; non-modal.
- "Modal" = Radix Dialog with overlay + focus trap. Reserved for destructive
  confirmations and runtime-crash exception (R18).
- "Skeleton" = grey rounded-rectangle placeholders with subtle shimmer; used
  while a network round trip is in flight.
- "EmptyState" = centered illustration + caption + optional CTA; used when the
  surface has nothing to render and the user can act to populate it.
- All animation uses `--duration-base` (200ms) with `--ease-out-spring`
  unless noted. Skeletons fade in over `--duration-slow` (300ms).

## Surfaces

### SLD canvas (Unit 8)

| State                        | Trigger                                                                               | Visual treatment                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-load empty               | No case loaded.                                                                       | Full-canvas EmptyState centered: subtle topology line illustration; caption "Pick a case file to begin." in muted-foreground; no CTA (left rail is the action surface).                                                                                         |
| Case-loaded loading          | Case picked, ELK auto-layout in flight.                                               | `SldLayoutSkeleton`: 5-7 grey rounded-rectangle nodes (`bg-muted`, `--radius-md`) arranged in a vague 3-row layered pattern; "Computing layout…" caption below; soft fade-in over 300ms.                                                                        |
| Case-loaded success (pre-PF) | Topology rendered, no PF run yet.                                                     | Full SLD with neutral-stroke buses (`stroke-foreground/40`); no voltage labels; no flow arrows; line edges drawn in `border` color.                                                                                                                             |
| Post-PF success              | PF converged.                                                                         | Voltage labels appear adjacent to each bus (`font-numeric`, `text-xs`); bus stroke colored by limit-violation band (success / warning / danger tokens); line edges show directional arrows + flow magnitude labels (`font-numeric`). Labels fade in over 200ms. |
| Error banner                 | Drift (topology no longer matches stored layout) or auto-layout fallback (>30 buses). | Banner above the canvas (`bg-warning/10`, `border-warning/30`, `text-foreground`) with text + dismiss control; canvas content remains visible underneath at full opacity.                                                                                       |
| Scrub-active                 | Reserved for v0.2.                                                                    | RESERVED — filled in v0.2 plan when the time-scrub control is introduced.                                                                                                                                                                                       |

### Inspector (right dock, top region; Unit 9)

| State                     | Trigger                                              | Visual treatment                                                                                                                                      |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty no-case             | No case loaded.                                      | EmptyState: caption "Load a case to inspect elements."                                                                                                |
| Empty no-element-selected | Case loaded, nothing clicked yet.                    | EmptyState: caption "Click an element on the diagram to inspect it."                                                                                  |
| Element-selected pre-PF   | Element clicked, no PF run yet.                      | Tabs: Properties (default selected) shows parameter table; Results tab shows nested EmptyState "Run power flow to see results."                       |
| Element-selected post-PF  | Element clicked, PF run available.                   | Tabs: Results tab now default-selected and populated; Properties tab still available.                                                                 |
| Convergence-error banner  | PF returned non-convergence; element still selected. | Overlay banner at top of right dock (above inspector); inspector remains visible underneath at full opacity in its current state. NO takeover.        |
| Runtime-error modal       | Uncaught exception in substrate worker.              | Inspector visually unchanged; modal overlay locks foreground per R18 (one allowed non-destructive modal — alternatives are insufficient for a crash). |

### Results table (right dock, bottom region; Unit 9)

| State             | Trigger                                                                                                   | Visual treatment                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Empty pre-PF      | Case loaded, no PF run yet.                                                                               | EmptyState: caption "Run power flow to see results."                                                                                      |
| Populated post-PF | PF converged.                                                                                             | Sortable rows; default sort = `idx` ascending per column-definition tables in Unit 9; numeric columns use `font-numeric` and right-align. |
| Sort active       | User clicked a column header.                                                                             | Column-header chevron up/down; sort applied; other column headers neutral.                                                                |
| Filter active     | User typed in the filter input.                                                                           | Filter input populated; row-count badge ("N / total") on the right side of the filter row; filtered-out rows hidden (not greyed).         |
| Empty tab         | Tab represents a model class with no rows in current case (e.g., no generators in a load-flow-only case). | EmptyState within the tab panel: caption "No \<model\> in this case." (e.g., "No generators in this case.").                              |

### Run controls (top bar; Unit 7)

| State              | Trigger                          | Visual treatment                                                                                                                                                   |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle (no case)     | No case loaded.                  | "Run PF" button disabled (`opacity-50`, `pointer-events-none`); tooltip on hover/focus: "Load a case first."                                                       |
| Idle (case loaded) | Case loaded, no PF in flight.    | "Run PF" button enabled, primary style; default focus surface for the top bar.                                                                                     |
| Running            | PF mutation in flight.           | "Run PF" button shows inline spinner (left of label, `--duration-base` rotation loop); button disabled while running; "Cancel" optional v0.1.                      |
| Success            | PF converged.                    | Button returns to enabled state; toast (top-right, `--duration-base` slide-in): "PF converged in N iterations." Auto-dismiss after 4s.                             |
| Error              | PF failed (any taxonomy bucket). | Button returns to enabled; appropriate error surface rendered per R8: parse → case-nav banner; non-convergence → right-dock overlay banner; runtime crash → modal. |

### Case nav (left rail; Unit 7)

| State           | Trigger                                         | Visual treatment                                                                                                                                                                                               |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty workspace | `GET /workspace/files` returned an empty list.  | EmptyState within left rail: caption "No supported case files in workspace. Place a `.raw` / `.xlsx` / `.json` / `.m` file in the workspace dir." Path of workspace dir shown in `font-numeric` below caption. |
| Populated list  | Workspace contains supported files.             | File list, primary case selectable; selected row uses `bg-muted` + `text-foreground`; `.dyr` addfile selector visible as a secondary control when a `.raw` is picked.                                          |
| Loading         | `GET /workspace/files` in flight.               | Skeleton: 3-5 grey rows (`bg-muted`, `--radius-sm`) with shimmer; "Loading workspace…" caption hidden (skeleton speaks for itself).                                                                            |
| Parse error     | Selected case failed to parse on the substrate. | Inline banner above the list (`bg-danger/10`, `border-danger/30`, `text-foreground`) with the substrate's `detail` field + dismiss; selection of the offending file is unset.                                  |

## Cross-cutting behaviors

These apply to every surface unless explicitly overridden:

- **Focus-visible**: every interactive element shows a 2px ring at
  `--color-ring` with a 2px offset on `:focus-visible` only — NOT on click
  (R20 floor; covered by `app-shell.test.tsx` integration test in Unit 4 and
  by individual component tests here).
- **Disabled**: `opacity-50 pointer-events-none`. No tooltip unless the
  component author explicitly adds one (Run PF disabled is the v0.1 example;
  it adds a tooltip explaining the disabled cause).
- **Dark mode**: every state must render legibly in both light and dark.
  Token-level guarantees: foreground/background contrast >= 7:1 for body
  text; >= 4.5:1 for muted-foreground.
- **Reduced motion**: when `prefers-reduced-motion: reduce` is set, durations
  collapse to 0ms; transforms disabled. Implemented globally in
  `globals.css`.
