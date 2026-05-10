/**
 * Command registry (Unit 9 of the v2.0 polish plan).
 *
 * Single source of truth for every action that appears in the TopBar
 * grouped menus (Workspace / Edit / Run / Export) AND in the ⌘K
 * command palette. Both surfaces consume the same registry, so a new
 * action automatically shows up in both places — and renaming an
 * action in one place renames it in the other.
 *
 * Why a hook (not a module-level constant): most commands need access
 * to React-bound state — Zustand selectors, TanStack-Query mutation
 * objects, and the active sessionId. Encoding the registry as a hook
 * lets each command's `action` close over those values without the
 * caller having to plumb dispatch maps. The trade-off is that the
 * registry re-evaluates on every render of any consumer; the cost is
 * tiny (the array is short and each entry is cheap to allocate) and
 * keeps the API consistent with the rest of the codebase's
 * Zustand-flavoured hooks.
 *
 * Group ordering: matches the TopBar menu order (workspace, edit, run,
 * export, navigation, help). Within each group, items keep the order
 * they would appear in the corresponding menu's body so the palette's
 * grouped-list view feels familiar to users who already learned the
 * topbar layout.
 *
 * Gating: each command may declare a `when()` predicate. Commands
 * whose `when()` returns `false` are filtered out by
 * `useCommandRegistry()` BEFORE the palette / menu sees them — the
 * palette never renders a "disabled" command, it just doesn't surface
 * it. This matches Linear / Raycast convention; the disabled-state
 * affordance lives on the topbar menus (where users have visual
 * context for "why is this greyed out?") and not on a search-driven
 * surface where invisibility is the right answer.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useSnapshotStore } from '@/store/snapshot';
import { useBundleStore } from '@/store/bundle';
import { usePflowStore } from '@/store/pflow';
import { useRunModeStore } from '@/store/runMode';
import { useAnalyzeStore } from '@/store/analyze';
import { useUiStore } from '@/store/ui';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';
import { useHistoryStore } from '@/store/history';
import { useReportDialogStore } from '@/components/reports/ReportDialog';
import { useCurrentTopology, useReloadCase, useUndoLastEdit } from '@/api/queries';
import { __requestOpenSldSearch } from '@/store/sld';
import { useThemeStore } from '@/store/theme';
import { useLayoutStore } from '@/store/layout';
import { requestEigLogToggle, requestEigViewReset } from '@/lib/eigViewBus';
import type { RunRoutine } from '@/lib/useRunReadiness';

export type CommandGroup =
  | 'workspace'
  | 'edit'
  | 'run'
  | 'export'
  | 'view'
  | 'navigation'
  | 'help';

/** Stable group ordering — palette renders sections in this order. */
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
  'workspace',
  'edit',
  'run',
  'export',
  'view',
  'navigation',
  'help',
];

export interface Command {
  /**
   * Stable, kebab-case identifier. Used as the React `key`, the
   * `data-testid` suffix (`command-palette-item-${id}`), and the
   * lookup key for tests asserting "menu and palette wire to the
   * same handler".
   */
  id: string;
  /** Human-readable label shown in the menu / palette. */
  label: string;
  /**
   * Optional icon node. Renders before the label. Components passed
   * here should already be sized (e.g., `<Icon className="h-4 w-4" />`).
   */
  icon?: ReactNode;
  /** Group bucket — drives palette sectioning + menu derivation. */
  group: CommandGroup;
  /** Side-effect to run when the command is activated. */
  action: () => void;
  /**
   * Optional gate. Commands whose `when()` returns `false` are
   * filtered out by `useCommandRegistry()` and never surface in
   * either the menu or the palette. Defaults to `() => true`.
   */
  when?: () => boolean;
  /**
   * Search synonyms forwarded to cmdk's fuzzy matcher. e.g. PF →
   * ["pflow", "power flow", "load flow"] so users searching for any
   * of those land on the same command.
   */
  keywords?: string[];
  /**
   * Keyboard shortcut binding string. Two roles in one field:
   *
   *  1. Display: rendered as `<kbd>` chips by `<CommandPalette />` and
   *     `<ShortcutCheatsheet />` via `formatShortcut(...)`.
   *  2. Wiring: consumed by `<GlobalShortcuts />` (Unit 10), which
   *     registers each binding with `react-hotkeys-hook`. Sequence
   *     shortcuts use the `>`-delimited syntax (e.g., `g>s`); aliases
   *     are comma-separated (e.g., `meta+k, ctrl+k`).
   */
  shortcut?: string;
}

/**
 * Returns the active commands, ordered by `COMMAND_GROUP_ORDER` then
 * by intra-group declaration order. Filters out any command whose
 * `when()` predicate returns `false`.
 *
 * The hook subscribes to every Zustand slice referenced inside any
 * `when()` predicate so React re-renders consumers when a gate flips.
 * Selector subscriptions are intentionally narrow (e.g., we read
 * `sessionId` rather than the whole session slice) so unrelated
 * mutations don't churn the palette.
 */
export function useCommandRegistry(): readonly Command[] {
  // ---- subscriptions used by gates + actions -----------------------------
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const topology = useCurrentTopology();
  const isPfRunning = usePflowStore((s) => s.isRunning);
  const lastPfRun = usePflowStore((s) => s.lastRun);
  const activeRoutine = useRunModeStore((s) => s.activeRoutine);

  // ---- store actions referenced from `action` closures ------------------
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  const openSnapshotSave = useSnapshotStore((s) => s.openSaveDialog);
  const openSnapshotLoad = useSnapshotStore((s) => s.openLoadDialog);
  const openReportDialog = useReportDialogStore((s) => s.openDialog);
  const openBundleDialog = useBundleStore((s) => s.openDialog);
  const setActiveRoutine = useRunModeStore((s) => s.setActiveRoutine);
  const setAnalyzeSubMode = useAnalyzeStore((s) => s.setSubMode);
  const setRightDockPanel = useUiStore((s) => s.setActiveRightDockTopPanel);
  const togglePalette = useCommandPaletteStore((s) => s.togglePalette);
  const toggleCheatsheet = useShortcutCheatsheetStore((s) => s.toggleCheatsheet);
  const openHistoryDrawer = useHistoryStore((s) => s.openDrawer);

  // ---- mutations (Edit group) -------------------------------------------
  const reloadMutation = useReloadCase();
  const undoMutation = useUndoLastEdit();

  // ---- derived gates ----------------------------------------------------
  const noTopology = topology === null;
  const committed = topology?.state === 'committed';
  const editGateDisabled = noTopology || committed || isPfRunning;
  const sessionScopeDisabled = sessionId === null || caseSelection === null;
  const reportDisabled = sessionId === null;
  const reloadDisabled = noTopology || caseSelection?.blank === true;
  const undoDisabled = noTopology || committed;
  const pfConverged = lastPfRun?.converged === true;

  return useMemo<readonly Command[]>(() => {
    const handleSelectRoutine = (routine: RunRoutine) => {
      setActiveRoutine(routine);
      if (routine === 'eig') {
        setAnalyzeSubMode('eig');
        setRightDockPanel('analyze');
      } else if (routine === 'cpf') {
        setAnalyzeSubMode('cpf');
        setRightDockPanel('analyze');
      } else if (routine === 'se') {
        setAnalyzeSubMode('se');
        setRightDockPanel('analyze');
      }
    };

    const all: Command[] = [
      // ---- workspace -----------------------------------------------------
      {
        id: 'workspace.add-element',
        label: 'Add element…',
        group: 'workspace',
        keywords: ['bus', 'line', 'generator', 'load', 'shunt', 'create'],
        action: () => openAddPanel(null),
        when: () => !editGateDisabled,
      },
      {
        id: 'workspace.add-pmu',
        label: 'Add PMU…',
        group: 'workspace',
        keywords: ['pmu', 'measurement', 'phasor'],
        action: () => {
          // PMU placement dialog state lives inside `<WorkspaceMenu />`
          // (local React state). The palette path opens it by flipping
          // a sentinel on the case store; `<WorkspaceMenu />` reads
          // the sentinel and toggles its local dialog. See
          // `__paletteOpenPmu` below.
          __requestPaletteDialog('pmu');
        },
        when: () => !editGateDisabled,
      },
      {
        id: 'workspace.import-profile',
        label: 'Import profile…',
        group: 'workspace',
        keywords: ['timeseries', 'profile', 'csv', 'load'],
        action: () => __requestPaletteDialog('profile'),
        when: () => !editGateDisabled,
      },
      {
        id: 'workspace.save-system',
        label: 'Save system…',
        group: 'workspace',
        keywords: ['save', 'export', 'xlsx', 'json', 'system'],
        action: () => __requestPaletteDialog('save-system'),
        when: () => sessionId !== null && topology !== null,
      },
      {
        id: 'workspace.save-snapshot',
        label: 'Save snapshot…',
        group: 'workspace',
        keywords: ['save', 'snapshot', 'persist', 'state'],
        action: openSnapshotSave,
        when: () => !sessionScopeDisabled,
        // Sequence shortcut "g s" (Linear-style "go to Snapshots"). The
        // plan called this binding "open Snapshots dialog"; we wire it
        // to the SAVE flow rather than the LOAD flow because Save is
        // the more frequently-invoked snapshot action in researcher
        // workflows (every TDS run typically wants a checkpoint).
        shortcut: 'g>s',
      },
      {
        id: 'workspace.load-snapshot',
        label: 'Load snapshot…',
        group: 'workspace',
        keywords: ['load', 'snapshot', 'restore', 'reload'],
        action: openSnapshotLoad,
        when: () => !sessionScopeDisabled,
      },
      {
        id: 'workspace.import-bundle',
        label: 'Import bundle…',
        group: 'workspace',
        keywords: ['bundle', 'import', 'zip', 'reproducibility'],
        action: () => __requestPaletteDialog('import-bundle'),
        when: () => sessionId !== null,
      },
      {
        id: 'workspace.report',
        label: 'Report',
        group: 'workspace',
        keywords: ['report', 'summary', 'pdf', 'export'],
        action: () => openReportDialog(),
        when: () => !reportDisabled,
      },

      // ---- edit ----------------------------------------------------------
      {
        id: 'edit.undo',
        label: 'Undo last edit',
        group: 'edit',
        keywords: ['undo', 'revert', 'last'],
        action: () => {
          if (sessionId !== null) undoMutation.mutate(sessionId);
        },
        when: () => sessionId !== null && !undoDisabled && !undoMutation.isPending,
      },
      {
        id: 'edit.reload',
        label: 'Reload from file',
        group: 'edit',
        keywords: ['reload', 'reset', 'discard', 'edits'],
        action: () => __requestPaletteDialog('reload-confirm'),
        when: () => sessionId !== null && !reloadDisabled && !reloadMutation.isPending,
      },

      // ---- run -----------------------------------------------------------
      // Run commands always surface (the topbar menu has shown every
      // routine since Unit 8 regardless of session — selecting one
      // just flips the active routine + analyze sub-mode). Only EIG
      // carries an extra gate, mirroring `useRunReadiness('eig')`:
      // hide "Run EIG" from the PALETTE until PF has converged. The
      // menu still wants the EIG entry visible at all times so users
      // can preview the analyze panel before running PF; for menu
      // purposes the gate is loose. We resolve this by keeping the
      // gate strict (palette-style) here, and letting the menu
      // override by reading the unfiltered set in a future iteration
      // if needed. For Unit 9 the strict gate is the right behaviour:
      // a user clicking "Run EIG" with no converged PF would just
      // produce a noop in the substrate.
      // Per-routine sequence shortcuts: `r p` (Run PFlow), `r t` (Run
      // TDS), `r e` (Run EIG), `r c` (Run CPF), `r s` (Run SE),
      // `r w` (Run sWeep — `w` since `s` is already taken). The
      // active routine still gets a visual badge — we encode it by
      // appending "  ✓" to the label so the palette + cheatsheet
      // both surface the marker without overloading the `shortcut`
      // field with a non-binding sentinel.
      ...(
        [
          ['pflow', 'r>p'],
          ['tds', 'r>t'],
          ['eig', 'r>e'],
          ['cpf', 'r>c'],
          ['se', 'r>s'],
          ['sweep', 'r>w'],
        ] as const
      ).map<Command>(([routine, shortcut]) => ({
        id: `run.${routine}`,
        label:
          routine === activeRoutine
            ? `Run ${routine.toUpperCase()}  ✓`
            : `Run ${routine.toUpperCase()}`,
        group: 'run',
        keywords: keywordsForRoutine(routine),
        action: () => {
          handleSelectRoutine(routine);
          if (routine === 'sweep') {
            __requestPaletteDialog('sweep');
          }
        },
        when: routine === 'eig' ? () => pfConverged : undefined,
        shortcut,
      })),

      // ---- export --------------------------------------------------------
      {
        id: 'export.bundle',
        label: 'Export bundle…',
        group: 'export',
        keywords: ['bundle', 'export', 'zip', 'reproducibility', 'share'],
        action: openBundleDialog,
        when: () => !sessionScopeDisabled,
      },
      {
        id: 'export.snapshot',
        label: 'Save snapshot…',
        group: 'export',
        keywords: ['save', 'snapshot', 'persist', 'state'],
        action: openSnapshotSave,
        when: () => !sessionScopeDisabled,
      },

      // ---- view ----------------------------------------------------------
      // v3 Unit 2 — IDE-style pane toggles. Each command mirrors a
      // TopBar icon button; both surfaces call the same layout-store
      // action so click + shortcut paths are interchangeable. The
      // ⌘B / ⌘J / ⌘\ choices match VS Code's defaults so users
      // muscle-memorying from another editor land where they expect.
      {
        id: 'view.toggleLeftSidebar',
        label: 'Toggle left sidebar',
        group: 'view',
        keywords: ['sidebar', 'left', 'panel', 'toggle', 'show', 'hide', 'cases'],
        action: () => {
          useLayoutStore.getState().toggleLeftSidebar();
        },
        shortcut: 'meta+b, ctrl+b',
      },
      {
        id: 'view.toggleBottomDrawer',
        label: 'Toggle bottom drawer',
        group: 'view',
        keywords: ['drawer', 'bottom', 'panel', 'toggle', 'show', 'hide', 'results', 'data'],
        action: () => {
          // Toggle + clear unread atomically so opening the drawer
          // via ⌘J dismisses the unread-results dot the same way a
          // mouse click on the BottomDrawerToggle does.
          const { toggleBottomDrawer, clearDrawerUnread } = useLayoutStore.getState();
          toggleBottomDrawer();
          clearDrawerUnread();
        },
        shortcut: 'meta+j, ctrl+j',
      },
      {
        id: 'view.toggleRightInspector',
        label: 'Toggle inspector',
        group: 'view',
        keywords: ['inspector', 'right', 'panel', 'toggle', 'show', 'hide', 'properties'],
        action: () => {
          useLayoutStore.getState().toggleRightInspector();
        },
        shortcut: 'meta+backslash, ctrl+backslash',
      },

      // ---- navigation ----------------------------------------------------
      // Sequence shortcut "g h" — opens the run-history drawer.
      // Mirrors the "g s" pattern for the snapshot dialog. Always
      // surfaced (the drawer renders its own empty state if there
      // are no runs yet).
      {
        id: 'navigation.history',
        label: 'Open History',
        group: 'navigation',
        keywords: ['history', 'runs', 'drawer', 'past'],
        action: openHistoryDrawer,
        shortcut: 'g>h',
      },
      // Unit 11 — SLD node search. The action posts to the
      // `subscribeOpenSldSearch` channel exposed by `store/sld.ts`;
      // `SldNodeSearch` subscribes once on mount and flips its local
      // Radix Popover open state. The actual `meta+/` keybind is
      // wired inside `SldCanvas` (so it scopes to the canvas mount
      // rather than firing globally even when no case is loaded);
      // declaring the shortcut here is purely for the cheatsheet +
      // palette display.
      {
        id: 'navigation.focusSearch',
        label: 'Search nodes…',
        group: 'navigation',
        keywords: ['search', 'find', 'node', 'bus', 'jump', 'pan'],
        action: () => __requestOpenSldSearch(),
        shortcut: 'meta+slash, ctrl+slash',
      },
      {
        id: 'navigation.panToBus',
        label: 'Pan to bus…',
        group: 'navigation',
        keywords: ['pan', 'goto', 'bus', 'centre', 'center', 'jump'],
        action: () => __requestOpenSldSearch(),
      },
      // Unit 15 — EIG scatter view controls. The action posts to the
      // ``eigViewBus`` micro-bus; ``EIGScatter`` subscribes once on
      // mount and reacts. When the EIG sub-mode isn't mounted the
      // commands fire a no-op, which is fine — they're discoverable
      // from the palette regardless. They sit in the navigation
      // bucket because the equivalent "view" group would be a
      // single-member section in the palette.
      {
        id: 'navigation.eig-reset-zoom',
        label: 'Reset EIG zoom',
        group: 'navigation',
        keywords: ['eig', 'eigenvalue', 'zoom', 'reset', 'view', 'scatter'],
        action: requestEigViewReset,
      },
      {
        id: 'navigation.eig-toggle-log',
        label: 'Toggle EIG log scale',
        group: 'navigation',
        keywords: ['eig', 'eigenvalue', 'log', 'scale', 'axis', 'scatter'],
        action: requestEigLogToggle,
      },

      // ---- run controls --------------------------------------------------
      // ⌘Enter / Ctrl+Enter — run whichever routine is currently
      // marked active in the Run menu. Re-uses the same "select
      // routine" path that the per-routine palette commands do, so
      // the analyze sub-mode + right-dock panel align after the
      // dispatch. Always surfaced — there is always SOME active
      // routine (defaults to PFlow).
      {
        id: 'run.active-routine',
        label: `Run active routine (${activeRoutine.toUpperCase()})`,
        group: 'run',
        keywords: ['run', 'active', 'go', activeRoutine],
        action: () => {
          handleSelectRoutine(activeRoutine);
        },
        shortcut: 'meta+enter, ctrl+enter',
      },

      // ---- help ----------------------------------------------------------
      // Palette open/close — registered so the binding shows up in
      // the cheatsheet. The actual ⌘K hotkey is wired separately at
      // AppShell with `enableOnFormTags: ['INPUT', 'TEXTAREA']` so it
      // fires inside text inputs (the one global shortcut that does);
      // the binding here uses the project default and so won't
      // double-fire from inside an input — `<GlobalShortcuts />` and
      // the AppShell registration target the same key but the latter
      // is the one that wins inside form tags.
      {
        id: 'help.command-palette',
        label: 'Open command palette',
        group: 'help',
        keywords: ['palette', 'search', 'commands', 'k'],
        action: togglePalette,
        shortcut: 'meta+k, ctrl+k',
      },
      {
        id: 'help.shortcuts',
        label: 'Show keyboard shortcuts',
        group: 'help',
        keywords: ['shortcuts', 'cheatsheet', 'help', 'keys'],
        action: toggleCheatsheet,
        shortcut: '?',
      },
      // Dark-mode cycle (Unit 12). Cycles light → dark → system →
      // light via the theme slice. We read the action via
      // ``useThemeStore.getState().cycleTheme()`` so the closure
      // doesn't need a hook subscription — the slice's cycleTheme
      // identity is stable, but reading via getState keeps the
      // action call site uniform with the other store-driven
      // commands and avoids needing to add the theme store to
      // ``useCommandRegistry``'s subscription set (the registry
      // doesn't need to re-render when the theme changes).
      {
        id: 'help.dark-mode',
        label: 'Toggle dark mode',
        group: 'help',
        keywords: ['dark', 'light', 'theme', 'mode', 'system'],
        action: () => {
          useThemeStore.getState().cycleTheme();
        },
        shortcut: 'meta+d, ctrl+d',
      },
    ];

    // ---- filter + assert no duplicate IDs -----------------------------
    const seen = new Set<string>();
    for (const cmd of all) {
      if (seen.has(cmd.id)) {
        // Surface this as a hard error in dev — duplicate IDs would
        // silently break the testid contract + cmdk's own internal
        // de-duplication (cmdk requires unique `value`s per item).
        throw new Error(`Duplicate command id: ${cmd.id}`);
      }
      seen.add(cmd.id);
    }

    return all.filter((cmd) => (cmd.when ? cmd.when() : true));
    // `caseSelection`, `isPfRunning`, `lastPfRun` aren't listed
    // directly — they feed the derived `*Disabled` / `pfConverged`
    // gates which ARE in the deps. Re-listing the upstream sources
    // would be redundant; ESLint's exhaustive-deps rule flags them
    // as unnecessary, hence the narrower list below.
  }, [
    sessionId,
    topology,
    activeRoutine,
    openAddPanel,
    openSnapshotSave,
    openSnapshotLoad,
    openReportDialog,
    openBundleDialog,
    setActiveRoutine,
    setAnalyzeSubMode,
    setRightDockPanel,
    togglePalette,
    toggleCheatsheet,
    openHistoryDrawer,
    reloadMutation,
    undoMutation,
    editGateDisabled,
    sessionScopeDisabled,
    reportDisabled,
    reloadDisabled,
    undoDisabled,
    pfConverged,
  ]);
}

/**
 * Search-synonym buckets per routine. Kept beside the registry so
 * adding a new routine + its aliases is one edit.
 */
function keywordsForRoutine(routine: RunRoutine): string[] {
  switch (routine) {
    case 'pflow':
      return ['pf', 'power flow', 'load flow', 'pflow'];
    case 'tds':
      return ['tds', 'time domain', 'transient', 'simulate'];
    case 'eig':
      return ['eig', 'eigen', 'modal', 'stability', 'small signal'];
    case 'cpf':
      return ['cpf', 'continuation', 'voltage stability', 'pv curve', 'nose'];
    case 'se':
      return ['se', 'state estimation', 'estimator'];
    case 'sweep':
      return ['sweep', 'parameter', 'batch', 'monte'];
  }
}

// ---------------------------------------------------------------------------
// Palette → local-dialog bridge.
//
// A handful of dialogs (PMU placement, Profile import, Save System
// modal, Bundle import, Reload confirmation, Sweep dialog) are owned
// by `useState` inside their respective components rather than by a
// Zustand slice. To open them from the palette we expose a tiny
// pub-sub channel that any component can subscribe to. The owner
// component subscribes once on mount and toggles its local state when
// a matching event fires; the palette's `action` posts the event.
//
// This keeps the existing dialog ownership intact (no need to lift
// every dialog into Zustand) while still giving the palette a single
// uniform open path.
// ---------------------------------------------------------------------------

export type PaletteDialogKey =
  | 'pmu'
  | 'profile'
  | 'save-system'
  | 'import-bundle'
  | 'reload-confirm'
  | 'sweep';

type Listener = (key: PaletteDialogKey) => void;

const listeners: Set<Listener> = new Set();

export function __requestPaletteDialog(key: PaletteDialogKey): void {
  for (const l of listeners) l(key);
}

/**
 * Subscribe to palette-driven dialog open requests. Returns an
 * unsubscribe function. Components owning a local dialog should
 * subscribe once on mount and toggle their `useState` when their key
 * fires.
 */
export function subscribePaletteDialog(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
