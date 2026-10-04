/**
 * Tests for the shared command registry (`web/src/lib/commands.ts`)
 * — Unit 9 of the v2.0 polish plan.
 *
 * Coverage:
 *
 * - Shape: every command has the required fields + valid group.
 * - `when()` filter: when a gate returns false, the command is
 *   dropped from the hook's result.
 * - Group ordering: returned commands respect `COMMAND_GROUP_ORDER`
 *   when bucketed.
 * - No-duplicate-id: the registry asserts on duplicate ids (a hard
 *   error so cmdk's value-uniqueness contract is never violated).
 * - Palette dialog bridge: `subscribePaletteDialog` + the registry
 *   `__requestPaletteDialog` round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

import {
  COMMAND_GROUP_ORDER,
  useCommandRegistry,
  useMenuCommands,
  subscribePaletteDialog,
  __requestPaletteDialog,
  type CommandGroup,
} from '@/lib/commands';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
import { useCommandPaletteStore } from '@/store/commandPalette';
import { useRunsStore } from '@/store/runs';
import { useHistoryStore } from '@/store/history';
import { subscribeSldCommand } from '@/store/sld';
import type { SldCommand } from '@/store/sld';
import { usePflowStore } from '@/store/pflow';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';

// `useCurrentTopology` is a TanStack-Query wrapper; mock it to feed
// deterministic topology states without a network round-trip.
let MOCK_TOPOLOGY: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => MOCK_TOPOLOGY,
  };
});

function emptyTopology(state: TopologySummary['state'] = 'pre-setup'): TopologySummary {
  return {
    state,
    buses: [],
    lines: [],
    transformers: [],
    generators: [],
    loads: [],
    shunts: [],
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  MOCK_TOPOLOGY = emptyTopology();
  useSessionStore.setState({
    sessionId: parseSessionId('test-session'),
    recoveryInProgress: false,
    recoveryFailed: false,
    recoveryAttempts: [],
    recoveryStuckSince: null,
  });
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('cases/ieee14.raw'),
      addfiles: [],
    },
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
    addPanelOpen: false,
    addPanelKind: null,
    addPanelDirty: false,
    dragOverrides: {},
    pendingDependents: [],
    cloneInitialized: false,
    cloneUndoDepth: 0,
    cloneRedoDepth: 0,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
});

describe('useCommandRegistry — shape', () => {
  it('returns commands with the documented field shape', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    expect(result.current.length).toBeGreaterThan(0);
    for (const cmd of result.current) {
      expect(typeof cmd.id).toBe('string');
      expect(cmd.id.length).toBeGreaterThan(0);
      expect(typeof cmd.label).toBe('string');
      expect(typeof cmd.action).toBe('function');
      expect(COMMAND_GROUP_ORDER).toContain(cmd.group);
    }
  });

  it('every id is unique (no duplicates)', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const ids = result.current.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe('useCommandRegistry — edit mode command', () => {
  it('says the mode is for controller parameters, and how to leave it', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const toggle = result.current.find((c) => c.id === 'inspector.toggle-edit-mode');
    expect(toggle?.label).toBe('Switch to Edit mode (controller parameters)');

    act(() => {
      useCaseStore.setState({ editMode: 'edit' });
    });
    const { result: editing } = renderHook(() => useCommandRegistry(), { wrapper });
    expect(editing.current.find((c) => c.id === 'inspector.toggle-edit-mode')?.label).toBe(
      'Switch to Run mode',
    );
    act(() => {
      useCaseStore.setState({ editMode: 'run' });
    });
  });
});

describe('useCommandRegistry: the two Undos', () => {
  it('"Undo last addition" drops an add, "Undo parameter edit" steps back a clone edit, and they read differently', () => {
    act(() => {
      useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 2, cloneRedoDepth: 1 });
    });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const byId = (id: string) => result.current.find((c) => c.id === id);
    expect(byId('edit.undo')?.label).toBe('Undo last addition');
    expect(byId('clone.undo')?.label).toBe('Undo parameter edit');
    expect(byId('clone.redo')?.label).toBe('Redo parameter edit');
    // Only the parameter undo has Ctrl/Cmd+Z; the addition undo has no key.
    expect(byId('edit.undo')?.shortcut).toBeUndefined();
    expect(byId('clone.undo')?.shortcut).toBe('ctrl+z, meta+z');
    // The hover text of each points at the other, so a user who picked the wrong one is told.
    expect(byId('edit.undo')?.description).toMatch(/added last/);
    expect(byId('clone.undo')?.description).toMatch(/Undo last addition/);
  });
});

describe('useMenuCommands: commands kept in view while they cannot run', () => {
  const ids = (list: readonly { id: string }[]) => list.map((c) => c.id);

  it('keeps the two parameter commands, with what to do first, where the palette hides them', () => {
    const { result: registry } = renderHook(() => useCommandRegistry(), { wrapper });
    const { result: menu } = renderHook(() => useMenuCommands(), { wrapper });
    expect(ids(registry.current)).not.toContain('clone.save-as');
    expect(ids(registry.current)).not.toContain('clone.undo');
    const save = menu.current.find((c) => c.id === 'clone.save-as');
    const undo = menu.current.find((c) => c.id === 'clone.undo');
    expect(save?.unavailable).toMatch(/Nothing to save yet.*Switch to Edit mode/);
    expect(undo?.unavailable).toMatch(/Switch to Edit mode and change a controller parameter/);
    // The command still runs nothing by itself: its gate is the same one.
    expect(save?.when?.()).toBe(false);
  });

  it('does not say to switch to Edit mode when it is already on', () => {
    act(() => {
      useCaseStore.setState({ editMode: 'edit' });
    });
    const { result } = renderHook(() => useMenuCommands(), { wrapper });
    const save = result.current.find((c) => c.id === 'clone.save-as');
    const undo = result.current.find((c) => c.id === 'clone.undo');
    expect(save?.unavailable).toMatch(/Change a controller parameter in the Inspector first/);
    expect(save?.unavailable).not.toMatch(/Switch to Edit mode/);
    expect(undo?.unavailable).toMatch(/Change a controller parameter in the Inspector first/);
    act(() => {
      useCaseStore.setState({ editMode: 'run' });
    });
  });

  it('lists the runnable commands first-hand, in the order the registry has them', () => {
    const { result: registry } = renderHook(() => useCommandRegistry(), { wrapper });
    const { result: menu } = renderHook(() => useMenuCommands(), { wrapper });
    const runnable = menu.current.filter((c) => c.unavailable === null);
    expect(ids(runnable)).toEqual(ids(registry.current));
    // The greyed ones are in the place they are declared in, after Edit mode's switch.
    const order = ids(menu.current);
    expect(order.indexOf('inspector.toggle-edit-mode')).toBeLessThan(order.indexOf('clone.undo'));
    expect(order.indexOf('clone.undo')).toBeLessThan(order.indexOf('clone.save-as'));
  });

  it('says there is nothing to undo, not to switch modes, once the copy exists without edits', () => {
    act(() => {
      useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 0, cloneRedoDepth: 0 });
    });
    const { result } = renderHook(() => useMenuCommands(), { wrapper });
    expect(result.current.find((c) => c.id === 'clone.undo')?.unavailable).toMatch(
      /No controller parameter has been changed yet/,
    );
    // Save parameter edits as case is usable once the copy exists.
    expect(result.current.find((c) => c.id === 'clone.save-as')?.unavailable).toBeNull();
  });

  it('lists a command that is usable with no reason, and leaves out the ones with no reason to give', () => {
    act(() => {
      useCaseStore.setState({ cloneInitialized: true, cloneUndoDepth: 1, cloneRedoDepth: 0 });
    });
    const { result } = renderHook(() => useMenuCommands(), { wrapper });
    expect(result.current.find((c) => c.id === 'clone.undo')?.unavailable).toBeNull();
    // Redo and Discard are shown when they apply and are otherwise not listed.
    expect(ids(result.current)).not.toContain('clone.redo');
    act(() => {
      useCaseStore.setState({ cloneRedoDepth: 1 });
    });
    const { result: after } = renderHook(() => useMenuCommands(), { wrapper });
    expect(after.current.find((c) => c.id === 'clone.redo')?.unavailable).toBeNull();
  });

  it('lists none of them when no case is open, since there is nothing to edit or save', () => {
    MOCK_TOPOLOGY = null;
    const { result } = renderHook(() => useMenuCommands(), { wrapper });
    expect(ids(result.current)).not.toContain('clone.undo');
    expect(ids(result.current)).not.toContain('clone.save-as');
  });

  it('lists none of them without a session', () => {
    act(() => {
      useSessionStore.setState({ sessionId: null });
    });
    const { result } = renderHook(() => useMenuCommands(), { wrapper });
    expect(ids(result.current)).not.toContain('clone.undo');
    expect(ids(result.current)).not.toContain('clone.save-as');
  });
});

describe('useCommandRegistry — when() filter', () => {
  it('omits workspace edit commands when no topology is loaded', () => {
    MOCK_TOPOLOGY = null;
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const ids = result.current.map((c) => c.id);
    expect(ids).not.toContain('workspace.add-element');
    expect(ids).not.toContain('workspace.add-pmu');
    expect(ids).not.toContain('workspace.import-profile');
  });

  it('omits session-scoped commands when sessionId is null', () => {
    useSessionStore.setState({
      sessionId: null,
      recoveryInProgress: false,
      recoveryFailed: false,
      recoveryAttempts: [],
      recoveryStuckSince: null,
    });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const ids = result.current.map((c) => c.id);
    expect(ids).not.toContain('workspace.save-snapshot');
    expect(ids).not.toContain('workspace.load-snapshot');
    expect(ids).not.toContain('export.bundle');
    expect(ids).not.toContain('export.snapshot');
  });

  it('hides "Run EIG" until PF has converged', () => {
    // No PF result — EIG hidden.
    const first = renderHook(() => useCommandRegistry(), { wrapper });
    expect(first.result.current.map((c) => c.id)).not.toContain('run.eig');
    first.unmount();

    // PF converged — EIG appears.
    const convergedRun = {
      converged: true,
      iterations: 4,
      max_mismatch: 1e-9,
      buses: [],
    } as unknown as PflowResult;
    usePflowStore.setState({ lastRun: convergedRun, isRunning: false, error: null });
    const second = renderHook(() => useCommandRegistry(), { wrapper });
    expect(second.result.current.map((c) => c.id)).toContain('run.eig');
  });
});

describe('useCommandRegistry — group ordering', () => {
  it('returns commands in COMMAND_GROUP_ORDER buckets', () => {
    // Promote PF converged so EIG shows up; otherwise we'd just be
    // testing the present subset.
    usePflowStore.setState({
      lastRun: {
        converged: true,
        iterations: 4,
        max_mismatch: 1e-9,
        buses: [],
      } as unknown as PflowResult,
      isRunning: false,
      error: null,
    });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });

    // Build the order of unique groups as they appear.
    const seen: CommandGroup[] = [];
    for (const cmd of result.current) {
      if (!seen.includes(cmd.group)) seen.push(cmd.group);
    }
    // Each group seen must respect COMMAND_GROUP_ORDER's relative
    // positions (some groups may be empty and skipped, but the order
    // of the present groups must be a subsequence of the canonical
    // order).
    let cursor = 0;
    for (const group of seen) {
      const idx = COMMAND_GROUP_ORDER.indexOf(group);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx;
    }
  });
});

describe('useCommandRegistry — Unit 15 EIG view commands', () => {
  it('exposes navigation.eig-reset-zoom and navigation.eig-toggle-log', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const ids = result.current.map((c) => c.id);
    expect(ids).toContain('navigation.eig-reset-zoom');
    expect(ids).toContain('navigation.eig-toggle-log');
  });

  it('eig view commands carry the eig keyword for fuzzy search', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const reset = result.current.find((c) => c.id === 'navigation.eig-reset-zoom');
    const toggle = result.current.find((c) => c.id === 'navigation.eig-toggle-log');
    expect(reset?.keywords).toContain('eig');
    expect(toggle?.keywords).toContain('eig');
  });
});

describe('useCommandRegistry — v3 Unit 2 view commands', () => {
  it('exposes the three view-toggle commands', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const ids = result.current.map((c) => c.id);
    expect(ids).toContain('view.toggleLeftSidebar');
    expect(ids).toContain('view.toggleBottomDrawer');
    expect(ids).toContain('view.toggleRightInspector');
  });

  it('view commands carry the documented keyboard shortcuts', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const sidebar = result.current.find((c) => c.id === 'view.toggleLeftSidebar');
    const drawer = result.current.find((c) => c.id === 'view.toggleBottomDrawer');
    const inspector = result.current.find((c) => c.id === 'view.toggleRightInspector');
    expect(sidebar?.shortcut).toBe('meta+b, ctrl+b');
    expect(drawer?.shortcut).toBe('meta+j, ctrl+j');
    expect(inspector?.shortcut).toBe('meta+backslash, ctrl+backslash');
  });

  it('view commands belong to the "view" group', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    for (const id of [
      'view.toggleLeftSidebar',
      'view.toggleBottomDrawer',
      'view.toggleRightInspector',
    ]) {
      const cmd = result.current.find((c) => c.id === id);
      expect(cmd?.group).toBe('view');
    }
  });

  it('view.toggleLeftSidebar action flips the layout slice', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'view.toggleLeftSidebar');
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);
    cmd?.action();
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(true);
    cmd?.action();
    expect(useLayoutStore.getState().leftSidebarCollapsed).toBe(false);
  });

  it('view.toggleRightInspector action flips the layout slice', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'view.toggleRightInspector');
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(false);
    cmd?.action();
    expect(useLayoutStore.getState().rightInspectorCollapsed).toBe(true);
  });

  it('view.toggleBottomDrawer action toggles AND clears the unread bit', () => {
    useLayoutStore.setState({
      drawerHasUnreadResults: true,
      bottomDrawerCollapsed: true,
    });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'view.toggleBottomDrawer');
    cmd?.action();
    expect(useLayoutStore.getState().bottomDrawerCollapsed).toBe(false);
    expect(useLayoutStore.getState().drawerHasUnreadResults).toBe(false);
  });
});

describe('useCommandRegistry — v3.1 results view command', () => {
  it('exposes view.toggle-results-view in the view group', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'view.toggle-results-view');
    expect(cmd).toBeDefined();
    expect(cmd?.group).toBe('view');
  });

  it('carries the ⌘⇧M / Ctrl+⇧M shortcut', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'view.toggle-results-view');
    expect(cmd?.shortcut).toBe('meta+shift+m, ctrl+shift+m');
  });

  it('action flips resultsViewActive on the layout slice', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'view.toggle-results-view');
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);
    act(() => cmd?.action());
    expect(useLayoutStore.getState().resultsViewActive).toBe(true);
    act(() => cmd?.action());
    expect(useLayoutStore.getState().resultsViewActive).toBe(false);
  });
});

describe('useCommandRegistry — v3 Unit 14 auto-route on Run', () => {
  // Each test promotes a converged PF result so `run.eig` is registered
  // (gated by `pfConverged`); the EIG path is the most useful auto-route
  // assertion since EIG is the default Run target after PFlow.
  function withConvergedPf() {
    usePflowStore.setState({
      lastRun: {
        converged: true,
        iterations: 4,
        max_mismatch: 1e-9,
        buses: [],
      } as unknown as PflowResult,
      isRunning: false,
      error: null,
    });
  }

  it('Run EIG sets activeBottomDrawerTab=analysis + activeAnalysisSubTab=eig', () => {
    withConvergedPf();
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'run.eig');
    expect(cmd).toBeDefined();
    act(() => cmd?.action());
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('eig');
  });

  it('Run TDS sets the analysis sub-tab to tds', () => {
    withConvergedPf();
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'run.tds');
    act(() => cmd?.action());
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('tds');
  });

  it('with drawer NOT collapsed, drawerHasUnreadResults stays false', () => {
    withConvergedPf();
    useLayoutStore.setState({ bottomDrawerCollapsed: false });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'run.eig');
    act(() => cmd?.action());
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('eig');
    expect(layout.drawerHasUnreadResults).toBe(false);
    expect(layout.bottomDrawerCollapsed).toBe(false);
  });

  it('with drawer COLLAPSED, drawerHasUnreadResults flips to true (no auto-expand)', () => {
    withConvergedPf();
    useLayoutStore.setState({ bottomDrawerCollapsed: true });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'run.cpf');
    act(() => cmd?.action());
    const layout = useLayoutStore.getState();
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('cpf');
    expect(layout.drawerHasUnreadResults).toBe(true);
    // Critical: the drawer stays collapsed — the badge replaces the
    // auto-expand per F-DESIGN-5.
    expect(layout.bottomDrawerCollapsed).toBe(true);
  });

  it('Run PFlow leaves activeAnalysisSubTab alone (no PF sub-tab in v3)', () => {
    useLayoutStore.setState({ activeAnalysisSubTab: 'eig' });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = result.current.find((c) => c.id === 'run.pflow');
    act(() => cmd?.action());
    const layout = useLayoutStore.getState();
    // The outer drawer tab still routes to analysis; the sub-tab stays
    // on whatever the user last used (PF results land on the Buses
    // grid + inspector, not in an Analysis sub-tab).
    expect(layout.activeBottomDrawerTab).toBe('analysis');
    expect(layout.activeAnalysisSubTab).toBe('eig');
  });
});

const find = (commands: readonly { id: string }[], id: string) =>
  commands.find((c) => c.id === id) as import('@/lib/commands').Command | undefined;

function oneBusTopology(): TopologySummary {
  return {
    ...emptyTopology(),
    buses: [{ idx: '1', name: 'BUS1', kind: 'Bus', params: {} }],
  };
}

describe('useCommandRegistry: keys the browser keeps', () => {
  afterEach(() => {
    useRunsStore.getState().clearRuns();
  });

  it('the theme toggle is not on Ctrl/Cmd+D, the browser bookmark key', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(result.current, 'help.dark-mode')?.shortcut).toBe('meta+shift+l, ctrl+shift+l');
  });

  it('no binding is taken by two commands, and none by a key the app must leave to the browser', () => {
    // A converged PF, a streaming run and a diagram, so every gated command is in the list.
    usePflowStore.setState({
      lastRun: {
        converged: true,
        iterations: 1,
        max_mismatch: 0,
        buses: [],
      } as unknown as PflowResult,
      isRunning: false,
      error: null,
    });
    useRunsStore.getState().startRun({ runId: 'r', tf: 1, columnNames: [] });
    MOCK_TOPOLOGY = oneBusTopology();
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const aliases = result.current.flatMap((c) =>
      c.shortcut === undefined ? [] : c.shortcut.split(',').map((a) => a.trim()),
    );
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const reserved of ['meta+d', 'ctrl+d', 'meta+t', 'ctrl+t', 'meta+w', 'ctrl+w']) {
      expect(aliases).not.toContain(reserved);
    }
  });
});

describe('useCommandRegistry: Open case, Save and Abort run', () => {
  afterEach(() => {
    useCommandPaletteStore.setState({ open: false, page: 'commands' });
    useRunsStore.getState().clearRuns();
  });

  it('Open case is offered with a session, and switches the palette to its Open case page', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = find(result.current, 'workspace.open-case');
    expect(cmd?.group).toBe('workspace');
    expect(cmd?.shortcut).toBe('meta+o, ctrl+o');
    // The palette must not close on it: it is the same palette, on another page.
    expect(cmd?.keepPaletteOpen).toBe(true);
    act(() => cmd?.action());
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: true, page: 'open-case' });
  });

  it('Open case is not offered without a session', () => {
    useSessionStore.setState({ sessionId: null });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(result.current, 'workspace.open-case')).toBeUndefined();
  });

  it('only Open case keeps the palette open', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const keepers = result.current.filter((c) => c.keepPaletteOpen).map((c) => c.id);
    expect(keepers).toEqual(['workspace.open-case']);
  });

  it('Save carries Ctrl/Cmd+S, and Save system as has no key of its own', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const save = find(result.current, 'workspace.save');
    expect(save?.label).toBe('Save');
    expect(save?.group).toBe('workspace');
    expect(save?.shortcut).toBe('meta+s, ctrl+s');
    const saveAs = find(result.current, 'workspace.save-system');
    expect(saveAs?.label).toBe('Save system as…');
    expect(saveAs?.shortcut).toBeUndefined();
  });

  it('names the controller parameter save for what it saves, and keeps its key', () => {
    act(() => {
      useCaseStore.setState({ cloneInitialized: true });
    });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = find(result.current, 'clone.save-as');
    expect(cmd?.label).toBe('Save parameter edits as case…');
    expect(cmd?.shortcut).toBe('ctrl+shift+s, meta+shift+s');
    expect(cmd?.description).toMatch(/format of the case you opened/);
  });

  it('Save and Save system as are offered together, and only with a case to save', () => {
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(result.current, 'workspace.save')).toBeDefined();
    expect(find(result.current, 'workspace.save-system')).toBeDefined();

    MOCK_TOPOLOGY = null;
    const none = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(none.result.current, 'workspace.save')).toBeUndefined();
    expect(find(none.result.current, 'workspace.save-system')).toBeUndefined();
  });

  it('Save asks for a name, through the Save system as dialog, for a case it cannot write back', () => {
    // The selection of these tests is a raw case.
    const seen: string[] = [];
    const off = subscribePaletteDialog((key) => seen.push(key));
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    const save = find(result.current, 'workspace.save');
    expect(save?.description).toMatch(/Asks for a name and format/);
    expect(save?.description).toMatch(/ieee14\.raw is a \.raw case/);

    act(() => save?.action());
    off();

    expect(seen).toEqual(['save-system']);
  });

  it('Save says it replaces the file where it can write the case back', () => {
    act(() => {
      useCaseStore.setState({
        selection: { primaryPath: parseWorkspacePath('cases/ieee14.xlsx'), addfiles: [] },
      });
    });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(result.current, 'workspace.save')?.description).toBe(
      'Writes the system back to cases/ieee14.xlsx, replacing it.',
    );
  });

  it('Abort run (Esc) is offered only while a run can be stopped', () => {
    const none = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(none.result.current, 'run.abort')).toBeUndefined();
    none.unmount();

    useRunsStore.getState().startRun({ runId: 'r', tf: 1, columnNames: [] });
    const streaming = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = find(streaming.result.current, 'run.abort');
    expect(cmd?.group).toBe('run');
    expect(cmd?.shortcut).toBe('escape');
    streaming.unmount();

    // Already asked to stop: the second Esc has nothing to do.
    useRunsStore.getState().setAbortedLocally('r', true);
    const stopping = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(stopping.result.current, 'run.abort')).toBeUndefined();
    stopping.unmount();

    useRunsStore.getState().setAbortedLocally('r', false);
    useRunsStore.getState().markRunDone('r', 1, true);
    const done = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(done.result.current, 'run.abort')).toBeUndefined();
  });
});

describe('useCommandRegistry: Rename run', () => {
  afterEach(() => {
    useHistoryStore.getState().reset();
    useRunsStore.getState().clearRuns();
  });

  it('is offered only while there is a run to name', () => {
    const none = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(none.result.current, 'navigation.rename-run')).toBeUndefined();
    none.unmount();

    useRunsStore.getState().startRun({ runId: 'r', tf: 1, columnNames: [] });
    const some = renderHook(() => useCommandRegistry(), { wrapper });
    const cmd = find(some.result.current, 'navigation.rename-run');
    expect(cmd?.group).toBe('navigation');
    expect(cmd?.label).toBe('Rename run…');
  });

  it("opens the History drawer with the active run's name ready to edit", () => {
    useRunsStore.getState().startRun({ runId: 'first', tf: 1, columnNames: [] });
    useRunsStore.getState().startRun({ runId: 'second', tf: 1, columnNames: [] });
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    act(() => find(result.current, 'navigation.rename-run')?.action());
    expect(useHistoryStore.getState()).toMatchObject({
      drawerOpen: true,
      renamingRunId: 'second',
    });
  });

  it('falls back to the latest run when none is active', () => {
    useRunsStore.getState().startRun({ runId: 'first', tf: 1, columnNames: [] });
    useRunsStore.getState().startRun({ runId: 'second', tf: 1, columnNames: [] });
    useRunsStore.getState().clearActiveRun();
    const { result } = renderHook(() => useCommandRegistry(), { wrapper });
    act(() => find(result.current, 'navigation.rename-run')?.action());
    expect(useHistoryStore.getState().renamingRunId).toBe('second');
  });
});

describe('useCommandRegistry: Fit view and Reset to auto-layout', () => {
  it('need a diagram on screen', () => {
    // No buses: nothing to fit.
    const empty = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(empty.result.current, 'view.fit')).toBeUndefined();
    expect(find(empty.result.current, 'view.reset-layout')).toBeUndefined();
    empty.unmount();

    MOCK_TOPOLOGY = oneBusTopology();
    const shown = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(shown.result.current, 'view.fit')?.group).toBe('view');
    expect(find(shown.result.current, 'view.reset-layout')?.label).toBe('Reset to auto-layout');
    shown.unmount();

    // The full-space results view covers the diagram.
    useLayoutStore.setState({ resultsViewActive: true });
    const covered = renderHook(() => useCommandRegistry(), { wrapper });
    expect(find(covered.result.current, 'view.fit')).toBeUndefined();
    expect(find(covered.result.current, 'view.reset-layout')).toBeUndefined();
  });

  it('post to the canvas bridge', () => {
    MOCK_TOPOLOGY = oneBusTopology();
    const seen: SldCommand[] = [];
    const unsubscribe = subscribeSldCommand((c) => seen.push(c));
    try {
      const { result } = renderHook(() => useCommandRegistry(), { wrapper });
      act(() => find(result.current, 'view.fit')?.action());
      act(() => find(result.current, 'view.reset-layout')?.action());
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual(['fit-view', 'reset-layout']);
  });
});

describe('palette dialog bridge', () => {
  it('subscribers fire when __requestPaletteDialog is invoked', () => {
    const listener = vi.fn();
    const unsub = subscribePaletteDialog(listener);
    __requestPaletteDialog('pmu');
    expect(listener).toHaveBeenCalledWith('pmu');
    unsub();
    __requestPaletteDialog('pmu');
    // After unsub, listener should NOT receive the second event.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers all receive the event', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribePaletteDialog(a);
    const unsubB = subscribePaletteDialog(b);
    __requestPaletteDialog('sweep');
    expect(a).toHaveBeenCalledWith('sweep');
    expect(b).toHaveBeenCalledWith('sweep');
    unsubA();
    unsubB();
  });
});
