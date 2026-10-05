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
 *
 * A command a first-time user would look for before it can run (Save
 * parameter edits as case, until a controller parameter has been edited)
 * may also give an `unavailableReason`. The registry still leaves it out,
 * but `useMenuCommands()` keeps it, with the reason, for the menus to draw
 * greyed out and say what to do first.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { useSessionStore } from '@/store/session';
import { useSnapshotStore } from '@/store/snapshot';
import { useBundleStore } from '@/store/bundle';
import { usePflowStore } from '@/store/pflow';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { useRunModeStore } from '@/store/runMode';
import { useRunsStore } from '@/store/runs';
import { useAnalyzeStore } from '@/store/analyze';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useShortcutCheatsheetStore } from '@/store/shortcutCheatsheet';
import { useHistoryStore } from '@/store/history';
import { useReportDialogStore } from '@/store/reportDialog';
import {
  useAbortRun,
  useCloneRedo,
  useCloneReset,
  useCloneUndo,
  useCurrentTopology,
  useReloadCase,
  useUndoLastEdit,
} from '@/api/queries';
import { __requestOpenSldSearch, __requestSldCommand } from '@/store/sld';
import { useThemeStore } from '@/store/theme';
import { useLayoutStore } from '@/store/layout';
import { requestEigLogToggle, requestEigViewReset } from '@/lib/eigViewBus';
import { reportAbortError } from '@/lib/abortRun';
import { openPflowComparePanel } from '@/lib/openPflowPanel';
import { saveHtmlReport } from '@/lib/saveHtmlReport';
import { useSaveOpenCase } from '@/lib/useSaveOpenCase';
import { SHORTCUTS } from '@/lib/shortcuts';
import type { RunRoutine } from '@/lib/useRunReadiness';

export type CommandGroup = 'workspace' | 'edit' | 'run' | 'export' | 'view' | 'navigation' | 'help';

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
   * One or two sentences on what the command does, for the hover text of its menu
   * item and palette row. For the commands whose label alone leaves two of them
   * easy to confuse (the two Undos, the two ways to save).
   */
  description?: string;
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
   * For a command the menus keep in view while its `when()` is false: why it cannot
   * run yet, in a sentence that says what to do first, or `null` when it should
   * simply not be listed (the case it makes no sense in). Read only while `when()`
   * is false. The palette ignores it and still hides the command.
   */
  unavailableReason?: () => string | null;
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
  /**
   * Set when the action moves the palette to another of its own pages (Open case
   * lists the workspace's files in it) instead of finishing. The palette then
   * stays open after running it; every other command closes the palette.
   */
  keepPaletteOpen?: boolean;
}

/** A command as a menu lists it: runnable, or greyed out with the reason it is not. */
export interface MenuCommand extends Command {
  /** Why the command cannot run now, or `null` when it can. */
  unavailable: string | null;
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
  return useCommandSets().available;
}

/**
 * Like `useCommandRegistry()`, for the top bar menus: the same commands in the same
 * order, plus the ones that cannot run yet but give an `unavailableReason`, each marked
 * with it, in the place the command is declared in.
 */
export function useMenuCommands(): readonly MenuCommand[] {
  return useCommandSets().menu;
}

interface CommandSets {
  available: readonly Command[];
  menu: readonly MenuCommand[];
}

function useCommandSets(): CommandSets {
  // ---- subscriptions used by gates + actions -----------------------------
  const sessionId = useSessionStore((s) => s.sessionId);
  const caseSelection = useCaseStore((s) => s.selection);
  const topology = useCurrentTopology();
  const isPfRunning = usePflowStore((s) => s.isRunning);
  const lastPfRun = usePflowStore((s) => s.lastRun);
  const hasPflowHistory = usePflowHistoryStore((s) => s.snapshots.length > 0);
  // Something an HTML report would hold: a power flow (the last one, or one
  // kept), a time-domain run or the eigenvalues. Booleans, so a streamed frame
  // does not re-render consumers.
  const hasRuns = useRunsStore((s) => Object.keys(s.runs).length > 0);
  const hasEigResult = useAnalyzeStore((s) => s.eigResult !== null);
  const hasReportContent = lastPfRun !== null || hasPflowHistory || hasRuns || hasEigResult;
  const activeRoutine = useRunModeStore((s) => s.activeRoutine);

  // ---- store actions referenced from `action` closures ------------------
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  const openSnapshotSave = useSnapshotStore((s) => s.openSaveDialog);
  const openSnapshotLoad = useSnapshotStore((s) => s.openLoadDialog);
  const openReportDialog = useReportDialogStore((s) => s.openDialog);
  const openBundleDialog = useBundleStore((s) => s.openDialog);
  const setActiveRoutine = useRunModeStore((s) => s.setActiveRoutine);
  const setAnalyzeSubMode = useAnalyzeStore((s) => s.setSubMode);
  const setActiveCpfSubMode = useAnalyzeStore((s) => s.setActiveCpfSubMode);
  const togglePalette = useCommandPaletteStore((s) => s.togglePalette);
  const openPalettePage = useCommandPaletteStore((s) => s.openPage);
  const toggleCheatsheet = useShortcutCheatsheetStore((s) => s.toggleCheatsheet);
  const openHistoryDrawer = useHistoryStore((s) => s.openDrawer);
  const startRenamingRun = useHistoryStore((s) => s.startRenaming);
  // The run "Rename run" acts on: the active one, else the latest started. A
  // string, so a streamed frame does not re-render consumers.
  const renameTargetRunId = useRunsStore((s) => {
    if (s.activeRunId !== null && s.runs[s.activeRunId] !== undefined) return s.activeRunId;
    const ids = Object.keys(s.runs);
    return ids[ids.length - 1] ?? null;
  });

  // ---- mutations (Edit group) -------------------------------------------
  const reloadMutation = useReloadCase();
  const undoMutation = useUndoLastEdit();

  // ---- save (Workspace group) --------------------------------------------
  // `target` is what Save does now: write the open file, or ask for a name.
  const { target: saveTarget, save: saveOpenCase } = useSaveOpenCase();

  // ---- abort (Run group) -------------------------------------------------
  // True while a time-domain run is starting or streaming and has not been
  // asked to stop. A boolean, so a streamed frame does not re-render consumers.
  const abortableRun = useRunsStore((s) => {
    const run = s.activeRunId === null ? undefined : s.runs[s.activeRunId];
    return (
      run !== undefined &&
      (run.state === 'starting' || run.state === 'streaming') &&
      !run.abortedLocally
    );
  });
  const abortMutation = useAbortRun();
  // The diagram is on screen: a case with buses is loaded and the full-space
  // results view is not covering it. Fit view and Reset to auto-layout act on it.
  const resultsViewActive = useLayoutStore((s) => s.resultsViewActive);

  // ---- clone-on-write edit (Unit 22) ------------------------------------
  const editMode = useCaseStore((s) => s.editMode);
  const setEditMode = useCaseStore((s) => s.setEditMode);
  const cloneInitialized = useCaseStore((s) => s.cloneInitialized);
  const cloneUndoDepth = useCaseStore((s) => s.cloneUndoDepth);
  const cloneRedoDepth = useCaseStore((s) => s.cloneRedoDepth);
  const cloneUndoMutation = useCloneUndo();
  const cloneRedoMutation = useCloneRedo();
  const cloneResetMutation = useCloneReset();

  // ---- derived gates ----------------------------------------------------
  const noTopology = topology === null;
  const committed = topology?.state === 'committed';
  const editGateDisabled = noTopology || committed || isPfRunning;
  const sessionScopeDisabled = sessionId === null || caseSelection === null;
  const reportDisabled = sessionId === null;
  const reloadDisabled = noTopology || caseSelection?.blank === true;
  const undoDisabled = noTopology || committed;
  const pfConverged = lastPfRun?.converged === true;
  const diagramVisible = topology !== null && topology.buses.length > 0 && !resultsViewActive;

  return useMemo<CommandSets>(() => {
    const handleSelectRoutine = (routine: RunRoutine, opts?: { cpfSubMode?: 'nose' | 'qv' }) => {
      setActiveRoutine(routine);
      if (routine === 'eig') {
        setAnalyzeSubMode('eig');
      } else if (routine === 'cpf') {
        setAnalyzeSubMode('cpf');
        // Default the CPF sub-tab to the nose-curve flow unless the
        // caller asked for the QV variant (``run.cpfQv``).
        setActiveCpfSubMode(opts?.cpfSubMode ?? 'nose');
      } else if (routine === 'se') {
        setAnalyzeSubMode('se');
      }
      // v3 Unit 14 auto-route — every Run command also points the
      // BottomDrawer at the matching Analysis sub-tab. Per the
      // F-DESIGN-5 resolution: write the layout fields unconditionally
      // (so opening the drawer later lands on the right sub-tab) but
      // ONLY auto-expand the drawer if it's already open. If it's
      // collapsed, flip the unread bit so the BottomDrawerToggle
      // badges a dot — the user opens the drawer at their pace and
      // the click clears the badge atomically.
      const layout = useLayoutStore.getState();
      layout.setActiveBottomDrawerTab('analysis');
      // ``sweep`` isn't an AnalysisSubTab value: it is a dialog. For it
      // we leave activeAnalysisSubTab alone (its last-set value will
      // surface when the user opens the drawer) but still flip the
      // unread bit so the user knows results arrived. The power flow's
      // tab is ``pf`` (its options and the system summary); for
      // tds/eig/cpf/se the routine name maps 1:1 to the AnalysisSubTab id.
      if (routine === 'pflow') {
        layout.setActiveAnalysisSubTab('pf');
      } else if (routine === 'tds' || routine === 'eig' || routine === 'cpf' || routine === 'se') {
        layout.setActiveAnalysisSubTab(routine);
      }
      if (layout.bottomDrawerCollapsed) {
        layout.setDrawerHasUnreadResults(true);
      }
    };

    const all: Command[] = [
      // ---- workspace -----------------------------------------------------
      // Opens the palette's Open case page (the workspace's case files), from the
      // menu, the palette itself and Ctrl/Cmd+O (which is the browser's Open File
      // otherwise; see `<GlobalShortcuts />`).
      {
        id: 'workspace.open-case',
        label: 'Open case…',
        group: 'workspace',
        keywords: ['open', 'case', 'load', 'file', 'workspace', 'switch', 'change'],
        action: () => openPalettePage('open-case'),
        when: () => sessionId !== null,
        shortcut: SHORTCUTS.openCase,
        keepPaletteOpen: true,
      },
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
      // Save writes the open file back where that is safe (an xlsx or json case with
      // nothing else in the way, see `saveInPlaceTarget`) and otherwise asks for a name
      // and format, as the first save of a new document does: it opens the dialog of
      // Save system as, which says why. Ctrl/Cmd+S is the browser's Save Page otherwise;
      // see `<GlobalShortcuts />`.
      {
        id: 'workspace.save',
        label: 'Save',
        description: saveTarget.ok
          ? `Writes the system back to ${saveTarget.filename}, replacing it.`
          : `Asks for a name and format to save under. ${saveTarget.reason}`,
        group: 'workspace',
        keywords: ['save', 'write', 'overwrite', 'replace', 'file', 'system'],
        action: () => {
          if (saveTarget.ok) saveOpenCase();
          else __requestPaletteDialog('save-system');
        },
        when: () => sessionId !== null && topology !== null,
        shortcut: SHORTCUTS.save,
      },
      {
        id: 'workspace.save-system',
        label: 'Save system as…',
        description:
          'Writes the whole system to a new file in the workspace, as xlsx, raw or json, and leaves the case you opened as it is. To keep controller parameter edits in the format of the case, use Save parameter edits as case.',
        group: 'workspace',
        keywords: ['save', 'save as', 'export', 'xlsx', 'raw', 'json', 'system', 'new file'],
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
      // Drops the last add (an element, a PMU or a profile). It has nothing to do with
      // parameter edits: those are the two commands below, which carry Ctrl/Cmd+Z.
      {
        id: 'edit.undo',
        label: 'Undo last addition',
        description:
          'Removes the element, PMU or profile you added last. The system is rebuilt from the case file and the additions that remain, so changes to the parameters of existing elements are dropped too.',
        group: 'edit',
        keywords: ['undo', 'revert', 'last', 'add', 'addition', 'element', 'remove'],
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

      // ---- clone-on-write edit (Unit 22) --------------------------------
      // Edit/Run mode toggle — flips the inspector between read-only (Run)
      // and clone-editable (Edit). Mirrors the EditModeToggle button so the
      // shortcut + click paths are interchangeable. Always surfaced when a
      // session exists (the toggle itself no-ops on a non-controller).
      {
        id: 'inspector.toggle-edit-mode',
        label:
          editMode === 'edit'
            ? 'Switch to Run mode'
            : 'Switch to Edit mode (controller parameters)',
        description:
          editMode === 'edit'
            ? 'Edit mode is on: controller parameters (exciters, governors) can be changed in the Inspector. Switch to Run mode to lock them.'
            : 'Unlocks the controller parameters (exciters, governors) in the Inspector, and keeps your changes in a copy of the case, so the file you opened stays as it was. Bus, line, generator and load values are edited with the pencil beside them before the case is run, in either mode.',
        group: 'edit',
        keywords: ['edit', 'run', 'mode', 'toggle', 'inspector', 'controller', 'parameter'],
        action: () => setEditMode(editMode === 'edit' ? 'run' : 'edit'),
        when: () => sessionId !== null,
      },
      // Clone undo / redo (Ctrl+Z / Ctrl+Shift+Z). NOTE: the existing
      // ``edit.undo`` (Undo last addition) is palette/menu-only with NO shortcut
      // binding, so Ctrl+Z is free to bind here without collision. Gated on a
      // live clone + a non-empty stack so the binding is a no-op otherwise.
      {
        id: 'clone.undo',
        label: 'Undo parameter edit',
        description:
          'Steps back the last controller parameter you changed in Edit mode. To remove an element you added, use Undo last addition.',
        group: 'edit',
        keywords: ['undo', 'clone', 'parameter', 'edit', 'revert', 'controller'],
        action: () => {
          if (sessionId !== null) cloneUndoMutation.mutate(sessionId);
        },
        when: () =>
          sessionId !== null &&
          cloneInitialized &&
          cloneUndoDepth > 0 &&
          !cloneUndoMutation.isPending,
        // Listed greyed out while there is nothing to undo, so the two Undos sit side
        // by side in the menu and the second says what it is for.
        unavailableReason: () => {
          if (sessionId === null || topology === null || cloneUndoMutation.isPending) return null;
          return cloneInitialized
            ? 'No controller parameter has been changed yet.'
            : editMode === 'edit'
              ? 'Change a controller parameter in the Inspector first.'
              : 'Switch to Edit mode and change a controller parameter first.';
        },
        shortcut: 'ctrl+z, meta+z',
      },
      {
        id: 'clone.redo',
        label: 'Redo parameter edit',
        description: 'Re-applies the controller parameter edit you just undid.',
        group: 'edit',
        keywords: ['redo', 'clone', 'parameter', 'edit', 'reapply', 'controller'],
        action: () => {
          if (sessionId !== null) cloneRedoMutation.mutate(sessionId);
        },
        when: () =>
          sessionId !== null &&
          cloneInitialized &&
          cloneRedoDepth > 0 &&
          !cloneRedoMutation.isPending,
        shortcut: 'ctrl+shift+z, meta+shift+z',
      },
      {
        id: 'clone.save-as',
        label: 'Save parameter edits as case…',
        description:
          'Writes the case files with your controller parameter edits to the workspace under a new name, in the format of the case you opened. The original case is not changed.',
        group: 'edit',
        keywords: ['save', 'save as', 'custom', 'case', 'clone', 'workspace', 'tuned', 'parameter'],
        action: () => __requestPaletteDialog('save-as-custom'),
        when: () => sessionId !== null && cloneInitialized,
        // Listed greyed out, in the Edit menu and beside the other saves in the
        // Workspace menu, until Edit mode has made the copy that holds the edits.
        unavailableReason: () => {
          if (sessionId === null || topology === null) return null;
          return editMode === 'edit'
            ? 'Nothing to save yet. Change a controller parameter in the Inspector first.'
            : 'Nothing to save yet. Switch to Edit mode and change a controller parameter first.';
        },
        shortcut: 'ctrl+shift+s, meta+shift+s',
      },
      {
        id: 'clone.reset',
        label: 'Discard all parameter edits',
        group: 'edit',
        keywords: ['discard', 'reset', 'clone', 'edits', 'revert', 'original'],
        action: () => {
          if (sessionId !== null) cloneResetMutation.mutate(sessionId);
        },
        // No shortcut — destructive, menu/palette-only per the plan.
        when: () => sessionId !== null && cloneInitialized && !cloneResetMutation.isPending,
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
        // ``run.cpf`` routes to the CPF nose-curve flow; the direction
        // (load | gen) knob lives in the panel's Advanced disclosure, so
        // we surface "load" / "gen" / "direction" as search synonyms so
        // a user searching for the gen-direction nose lands here.
        keywords:
          routine === 'cpf'
            ? [...keywordsForRoutine(routine), 'direction', 'load', 'gen', 'generation']
            : keywordsForRoutine(routine),
        action: () => {
          handleSelectRoutine(routine);
          if (routine === 'sweep') {
            __requestPaletteDialog('sweep');
          }
        },
        when: routine === 'eig' ? () => pfConverged : undefined,
        shortcut,
      })),
      // v3.1 Unit 13 — CPF QV-curve command. Routes to the CPF sub-tab
      // and flips the CPF sub-mode to ``qv`` so the QV bus-picker +
      // chart mount. Shipped with the feature for palette
      // discoverability (per the retired-Unit-17 note).
      {
        id: 'run.cpfQv',
        label: 'Run CPF QV-curve',
        group: 'run',
        keywords: ['cpf', 'qv', 'qv curve', 'reactive', 'voltage stability', 'bus', 'q margin'],
        action: () => {
          handleSelectRoutine('cpf', { cpfSubMode: 'qv' });
        },
      },
      // Esc. Stops the streaming time-domain run the way the Abort button does.
      // Only offered while a run can be stopped, so Esc does nothing otherwise,
      // and `<GlobalShortcuts />` leaves an Esc that a dialog, menu or popover
      // already used to close itself.
      {
        id: 'run.abort',
        label: 'Abort run',
        group: 'run',
        keywords: ['abort', 'cancel', 'stop', 'halt', 'interrupt', 'tds', 'run'],
        action: () => {
          // ``mutateAsync``: an error is reported even when the palette, whose
          // registry this action came from, has closed by the time it arrives.
          if (sessionId !== null) abortMutation.mutateAsync(sessionId).catch(reportAbortError);
        },
        when: () => abortableRun && sessionId !== null && !abortMutation.isPending,
        shortcut: SHORTCUTS.abortRun,
      },

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
      // One file with what the study came to: the power flow tables, the
      // comparison of two power flows, the charts of the plotted runs and
      // ANDES's own reports. Offered once there is a result to put in it, which
      // can be before a case is opened (the runs kept from an earlier visit).
      {
        id: 'export.html-report',
        label: 'Export HTML report',
        description:
          "One file with the power flow tables, the comparison of two power flows, the charts of the plotted runs and ANDES's own reports. It opens in any browser and prints.",
        group: 'export',
        keywords: ['report', 'html', 'print', 'pdf', 'document', 'results', 'tables', 'charts'],
        action: () => void saveHtmlReport(),
        when: () => hasReportContent,
        unavailableReason: () =>
          sessionScopeDisabled
            ? null
            : 'Nothing to report yet. Run a power flow or a time-domain simulation first.',
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
        shortcut: SHORTCUTS.toggleLeftSidebar,
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
        shortcut: SHORTCUTS.toggleBottomDrawer,
      },
      {
        id: 'view.toggleRightInspector',
        label: 'Toggle inspector',
        group: 'view',
        keywords: ['inspector', 'right', 'panel', 'toggle', 'show', 'hide', 'properties'],
        action: () => {
          useLayoutStore.getState().toggleRightInspector();
        },
        shortcut: SHORTCUTS.toggleRightInspector,
      },
      // v3.1 Unit 11 — Activity panel. Opens/expands the BottomDrawer onto
      // the Activity tab (Active sub-tab) so the user can watch in-flight
      // jobs + the failure/retry history. ⌘⇧J mirrors the ⌘J drawer toggle
      // but is unconditional-open (it always reveals Activity rather than
      // toggling the drawer shut). Clearing the unread bit matches the ⌘J
      // path so the BottomDrawerToggle badge dismisses on open.
      {
        id: 'view.toggleActivityPanel',
        label: 'Open Activity panel',
        group: 'view',
        keywords: ['activity', 'jobs', 'running', 'progress', 'panel', 'drawer', 'tasks'],
        action: () => {
          const layout = useLayoutStore.getState();
          layout.setActiveBottomDrawerTab('activity');
          layout.setActivityPanelTab('active');
          layout.setBottomDrawerCollapsed(false);
          layout.clearDrawerUnread();
        },
        shortcut: 'meta+shift+j, ctrl+shift+j',
      },
      // What ANDES said while a command ran: opens the BottomDrawer onto the
      // Messages tab (warnings and errors first). Always opens, like Activity.
      {
        id: 'view.openMessages',
        label: 'Open Messages',
        group: 'view',
        keywords: ['messages', 'warnings', 'errors', 'log', 'andes', 'console', 'output', 'drawer'],
        action: () => {
          const layout = useLayoutStore.getState();
          layout.setResultsViewActive(false);
          layout.setActiveBottomDrawerTab('messages');
          layout.setBottomDrawerCollapsed(false);
          layout.clearDrawerUnread();
        },
      },
      // Two of the power flows kept, side by side: opens the BottomDrawer onto
      // the Analysis tab's Compare sub-tab. Offered once a power flow has
      // converged; the tab says what to do while there is only one to compare.
      {
        id: 'view.comparePflow',
        label: 'Compare power flows',
        group: 'view',
        keywords: [
          'compare',
          'difference',
          'diff',
          'delta',
          'power flow',
          'pf',
          'a vs b',
          'before',
        ],
        action: openPflowComparePanel,
        when: () => hasPflowHistory,
      },
      // v3.1 — full-space results view. Toggles
      // ``useLayoutStore.resultsViewActive``, which makes the AppShell
      // short-circuit the diagram + inspector + drawer and render the
      // dedicated ResultsView instead ("results in a new page, hide the
      // system and its parameters"). Mirrors the ResultsViewToggle button
      // so click + shortcut paths are interchangeable. ⌘⇧M is free —
      // ⌘M is unbound and ⌘⇧S/⌘⇧Z are taken but not the M variant.
      // Deliberately NOT auto-entered on Run; the user opts in.
      {
        id: 'view.toggle-results-view',
        label: 'Toggle results view',
        group: 'view',
        keywords: [
          'results',
          'view',
          'maximize',
          'fullscreen',
          'plot',
          'analysis',
          'page',
          'hide diagram',
        ],
        action: () => {
          useLayoutStore.getState().toggleResultsView();
        },
        shortcut: SHORTCUTS.toggleResultsView,
      },
      // The diagram's own viewport and layout, acted on through the canvas bridge
      // in `store/sld.ts` (the canvas holds the React Flow instance and the
      // layout). Both are also in the diagram's right-click menu.
      {
        id: 'view.fit',
        label: 'Fit view',
        group: 'view',
        keywords: ['fit', 'zoom', 'centre', 'center', 'frame', 'viewport', 'diagram', 'sld'],
        action: () => __requestSldCommand('fit-view'),
        when: () => diagramVisible,
      },
      {
        id: 'view.reset-layout',
        label: 'Reset to auto-layout',
        group: 'view',
        keywords: ['layout', 'reset', 'auto', 'arrange', 'positions', 'drag', 'diagram', 'sld'],
        action: () => __requestSldCommand('reset-layout'),
        when: () => diagramVisible,
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
      // Opens the History drawer with the run's name ready to type, the same
      // field as the pencil on its row. Offered while there is a run to name.
      {
        id: 'navigation.rename-run',
        label: 'Rename run…',
        group: 'navigation',
        keywords: ['rename', 'name', 'label', 'title', 'run', 'history', 'legend', 'tds'],
        action: () => {
          if (renameTargetRunId !== null) startRenamingRun(renameTargetRunId);
        },
        when: () => renameTargetRunId !== null,
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
        shortcut: SHORTCUTS.searchNodes,
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
        shortcut: SHORTCUTS.commandPalette,
      },
      {
        id: 'help.shortcuts',
        label: 'Show keyboard shortcuts',
        group: 'help',
        keywords: ['shortcuts', 'cheatsheet', 'help', 'keys'],
        action: toggleCheatsheet,
        shortcut: SHORTCUTS.cheatsheet,
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
        // Not Ctrl/Cmd+D: that is the browser's Bookmark.
        shortcut: SHORTCUTS.toggleTheme,
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

    const menu: MenuCommand[] = [];
    const available: Command[] = [];
    for (const cmd of all) {
      if (cmd.when ? cmd.when() : true) {
        available.push(cmd);
        menu.push({ ...cmd, unavailable: null });
        continue;
      }
      const reason = cmd.unavailableReason?.() ?? null;
      if (reason !== null) menu.push({ ...cmd, unavailable: reason });
    }
    return { available, menu };
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
    setActiveCpfSubMode,
    togglePalette,
    openPalettePage,
    toggleCheatsheet,
    openHistoryDrawer,
    startRenamingRun,
    renameTargetRunId,
    reloadMutation,
    undoMutation,
    saveTarget,
    saveOpenCase,
    editMode,
    setEditMode,
    cloneInitialized,
    cloneUndoDepth,
    cloneRedoDepth,
    cloneUndoMutation,
    cloneRedoMutation,
    cloneResetMutation,
    editGateDisabled,
    sessionScopeDisabled,
    reportDisabled,
    reloadDisabled,
    undoDisabled,
    pfConverged,
    hasPflowHistory,
    hasReportContent,
    abortableRun,
    abortMutation,
    diagramVisible,
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
  | 'sweep'
  | 'save-as-custom';

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
