---
date: 2026-05-10
topic: v2-polish-phase2-smoke
status: complete
units_covered: [Unit 8 TopBar grouped menus, Unit 9 ⌘K palette, Unit 10 keyboard shortcuts + cheatsheet, Unit 11 SLD navigation polish, Unit 12 dark mode, Unit 13 empty states + first-run coach]
---

# v2.0 Polish Phase 2 — Playwright smoke pass

End-to-end browser verification of Phase 2 (commits `292f6dd`, `39d7795`, `e7d13f5`, `086de63`, `eff6981`, `36be434`) on `kundur_full.xlsx`. Token in sessionStorage; localStorage cleared first to exercise the first-run path.

## What works

| Feature | Test | Result |
|---|---|---|
| Unit 8 — TopBar grouped menus | `data-testid="top-bar-{left,center,right}"` present; left contains Workspace/Edit/Run; center has Run + RunStatusBadge; right has Export/Labels/Theme/History | ✅ |
| Unit 8 — `topbar-menu-*` count | 4 menus mounted (workspace, edit, run, export) | ✅ |
| Unit 9 — ⌘K opens palette | `Meta+K` press → `[data-testid="command-palette"]` mounts; 14 items rendered | ✅ |
| Unit 9 — palette filter | typing "shortcut" narrows to `Show keyboard shortcuts` only | ✅ |
| Unit 9 — palette item action | clicking the cheatsheet item closes palette + opens cheatsheet | ✅ |
| Unit 10 — cheatsheet rows | ≥10 shortcut rows rendered (11 visible, exceeds plan minimum) | ✅ |
| Unit 10 — RunMenu active marker | `Run PFLOW  ✓` shown in palette when active routine = pflow | ✅ |
| Unit 10 — shortcut hint chips | `R then P` rendered next to Run PFLOW item | ✅ |
| Unit 10 — ⌘K binding | wired via `useHotkeys('meta+k, ctrl+k', …)` | ✅ |
| Unit 10 — `?` direct binding | Playwright synthetic Shift+Slash did NOT trigger via the AppShell binding (cheatsheet still reachable via palette item; verify in real browser) | ⚠️  Playwright quirk |
| Unit 11 — ⌘/ opens SLD search | Meta+Slash → search popover mounts, input auto-focused | ✅ |
| Unit 11 — SLD search filter | typing "101" narrows from 20 rows to 5 (matches both buses + generators with idx containing "101") | ✅ |
| Unit 11 — selectedNodeId store | new `useSldStore` slice; `setSelectedNodeId` writes from canvas click + search row pick + inspector row click | ✅ |
| Unit 12 — Theme toggle mount | `[data-testid="theme-toggle"]` present in TopBar right cluster | ✅ |
| Unit 12 — Toggle cycles | click → light → dark → system → light; `localStorage[andes-app:theme-preference]` persists | ✅ |
| Unit 12 — `.dark` applied | after dark click, `document.documentElement.className === "dark"`; `body bg = oklch(0.13 0.01 270)` | ✅ |
| Unit 12 — destructive→danger sweep | 30 components migrated; lint + type pass | ✅ |
| Unit 13 — Coach mounts at step 1 | with `andes-app:first-run-coach-v1` absent, coach shows "Step 1 of 3 — Pick a case" | ✅ |
| Unit 13 — Auto-advance step 1 → 2 | loading kundur (10 buses) flips coach to "Step 2 of 3 — Run power flow" | ✅ |
| Unit 13 — EmptyState canonical | 8 inline empty-states migrated to `<EmptyState />` from `@/components/ui/EmptyState` | ✅ |

## Verified earlier in this session (Phase 1 smoke)

- Case load → ieee14 14 buses
- Discard & change case → kundur 10 buses (after the post-discard auto-create regression fix in `7851cd2`)
- Run PF on kundur → flow numbers render on SLD edges (360.74 MW, 701.40 MW, etc.)

## Known follow-ups (out of scope for Unit 14)

- **Direct `?` keypress** doesn't open the cheatsheet under Playwright. Reachable via palette + cheatsheet item. May be a Playwright/react-hotkeys-hook key-event-target mismatch; verify in real browser before flagging as a bug.
- **SLD search row formatting**: rows currently render `${idx}${type}` concatenated ("11bus", "22generator"); display copy could use a separator and a type chip — Phase 3 visual polish.
- **MiniMap viewport-rect contrast in dark mode** — Unit 11 migrated to `--color-primary` token; Unit 12 dark-mode overrides apply automatically. Visual diff still worth doing in design-iterator cycles.
- **Chart palettes** (`CPFCurveChart`, `TimeSeriesPlot`) now theme-aware; dark-mode contrast verified by chart tests but visual review during design-iterator cycles is appropriate.
- **5 chart-internal empty states** (EIGScatter, EIGDampingChart, CPFCurveChart, SEResidualChart, EIGParticipationTable) intentionally left with their existing styling per Unit 13 report — Phase 3 chart polish should sweep them.
- **TimeSeriesPlot empty state** has its own local component shadow — kept for the per-mode copy/testid.

## Test counts (post-Phase-2)

- Web tests: 1217 → **1277** (+60 across Units 8-13: TopBarMenu 13, RunMenu 11, WorkspaceMenu 9, ExportMenu 6, EditMenu 3, TopBarMenu wrapper, AppShell tab-order, CommandPalette 12, commands 7, ShortcutCheatsheet 9, useGlobalShortcuts 9, shortcutFormatter 24, shortcutCheatsheet store 6, SldNodeSearch 11, sld store 6, theme store 8, useTheme 7, ThemeToggle 7, EmptyState 6, FirstRunCoach 9, firstRun store 8)
- All passing as of `36be434`. Lint clean (`--max-warnings 0`). Typecheck has the same 7 pre-existing baseline errors (acknowledged inline).

## Branch state

- `feat/v2-polish` pushed through `36be434` (Unit 13).
- 6 substantive Phase 2 commits + 2 Phase 1 polish commits + 1 regression fix on the branch.

## Next

Unit 14 design-iterator pass (4 cycles) — focus on TopBar typography + spacing, cheatsheet + palette polish in light/dark, coach card visual refinement, EmptyState consistency. Then Phase 3 (chart polish + final smoke).
