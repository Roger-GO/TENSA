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
  subscribePaletteDialog,
  __requestPaletteDialog,
  type CommandGroup,
} from '@/lib/commands';
import { useSessionStore } from '@/store/session';
import { useCaseStore } from '@/store/case';
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
    const inspector = result.current.find(
      (c) => c.id === 'view.toggleRightInspector',
    );
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
    const cmd = result.current.find(
      (c) => c.id === 'view.toggleRightInspector',
    );
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
