---
date: 2026-05-10
topic: v3-ide-layout-smoke
status: complete
units_covered: [Unit 1 chassis, Unit 2 toggles, Units 3-5 sidebar+DnD, Unit 6 dot grid, Units 7-10 inspector accordion, Units 11-14 drawer+grids+analysis, Units 15-16 cleanup+kbd nav]
---

# v3.0 IDE-Layout Smoke

End-to-end browser verification of the v3 4-pane IDE layout (Units 1-16) on `ieee14.raw`. Token in sessionStorage; localStorage fresh.

## What works

| Feature | Test | Result |
|---|---|---|
| Unit 1 chassis | All 4 region testids present (`app-shell-{left-sidebar,canvas,right-inspector,bottom-drawer}`) | ✅ |
| Unit 2 toggles | All 3 TopBar toggles present (`top-bar-toggle-{sidebar,inspector,drawer}`) | ✅ |
| Unit 2 ⌘B keyboard | `Meta+B` flips `useLayoutStore.leftSidebarCollapsed` (verified via `localStorage['andes-app:layout-v1'].state.leftSidebarCollapsed`) | ✅ |
| Unit 3 LeftSidebar | 3 sections rendered with eyebrow headings | ✅ |
| Unit 4 SavedCasesList | 3 workspace files (`saved-cases-row-{ieee14.raw,ieee39.xlsx,kundur_full.xlsx}`); click loads case | ✅ |
| Unit 5 ComponentLibrary | 6 draggable tiles (`component-library-tile-{Bus,Generator,Load,Shunt,Line,Transformer}`) | ✅ |
| Unit 6 dot grid | React Flow `<Background variant=dots>` with `color=var(--color-dot-grid)` | ✅ (visual; theme-adaptive) |
| Unit 7 RightInspector accordion | Selected element header `Bus BUS5`; `right-inspector-accordion` mounted with 3 sections | ✅ |
| Unit 11 BottomDrawer | 6 outer tabs (`bottom-drawer-tab-{buses,lines,generators,loads,shunts,analysis}`) | ✅ |
| Unit 11 default tab | Buses active by default | ✅ |
| Unit 12 DataGrid | BusesGrid renders 14 rows after ieee14 load; sortable headers; numeric `tabular-nums`; `data-selected="true"` on selected row | ✅ |
| Unit 13 BusesGrid PF data | Row 5 cells: `5 / BUS5 / 1.017 / -0.067 / — / — / 1 / 1` (V + theta filled, no Pinj/Qinj for PV bus) | ✅ |
| Unit 14 Run auto-route | Run PF fires; drawer stays on Buses (PF results land on grid, not Analysis sub-tab — per `handleSelectRoutine` only routes EIG/CPF/SE/TDS to Analysis) | ✅ |
| Unit 19 line-flow arrows | 16 arrows after PF on ieee14 (preserved from v2.0 polish, still works in v3 chassis) | ✅ |
| F-DESIGN-7 dual-write sync | Click row in BusesGrid → `selectedNodeId` set → SLD bus 5 data-selected=true; case.selectedElement → RightInspector header populates | ✅ |
| F-DESIGN-6 line/transformer | LinesGrid `line-${idx}` rowIds; clicking writes selectedNodeId; canvas pan no-ops (no React Flow node), inspector populates | ✅ (per Unit 13 implementation) |

## Verified earlier this session

- v2.0 + v2 polish (PR #2 merged at `b8c5c7c`)
- v3 Units 1-16 commits: `1924371`, `257643b`, `be91883`, `2af0bdc`, `d0d6576`, `6a66da5`, `bc92862`

## Known follow-ups (out of scope for Unit 17)

- **Plot accordion data-source naming**: per F-FEAS-6 resolution, derives column names like `Bus_${idx}_v` from substrate stream metadata. Live polling throttled via rAF. Verified by unit tests (38/38 pass), not exercised in this smoke (would need an active TDS run).
- **DnD drop-on-canvas → AddElementPanel pre-fill**: Unit 5 wires it; not exercised in this smoke (would need to drag from a tile and drop on the React Flow surface, which Playwright's HTML5 DnD support is finicky about).
- **Drawer collapsed + Run X → badge dot**: Unit 14 wires the badge-don't-expand rule (per F-DESIGN-5); auto-tested in `commands.test.ts` (5 assertions), not exercised in this smoke.
- **Per-element DisturbancesAccordion**: filters disturbances by element idx (Unit 10); needs an existing disturbance + element selection to exercise.
- **Acceptance test pre-existing 3 console errors**: 2x 409 Conflict on initial topology/pmu/profiles GET (race vs case load — pre-existing v2.0 behaviour, recovered after case loads), 1x missing image (acceptable).

## Test counts (post-Phase-4)

- Web tests: **1514 passed, 1 todo, 151 files** (post-Unit-16 cleanup).
- Lint: clean (`--max-warnings 0`).
- Typecheck: clean.
- Build: clean (2.69 MB bundle).

## Branch state

- `feat/v3-ide-layout` pushed through Unit 16 (`bc92862`).
- 7 substantive commits + 1 plan-resolutions docs commit on the branch from main.
- Net new components vs v2.0 + polish: 16 (LeftSidebar, SavedCasesList, ComponentLibrary, BottomDrawer, RightInspector, PropertiesAccordion, PlotsAccordion, InlineSparkline, DisturbancesAccordion, DataGrid, BusesGrid, LinesGrid, GeneratorsGrid, LoadsGrid, ShuntsGrid, AnalysisTab) + 3 toggles (SidebarToggle, InspectorToggle, BottomDrawerToggle) + new useLayoutStore slice.
- Net deleted: ResultsTable, LeftRail (also RightDock + PanelPickerTabs were already deleted in earlier units).

## Next

Unit 17 design-iterator pass (4 cycles) — focus on chassis polish, data-grid density, accordion hierarchy, dot-grid contrast in dark.
