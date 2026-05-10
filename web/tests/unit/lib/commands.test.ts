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
import { renderHook, cleanup } from '@testing-library/react';
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
      lastRun: { converged: true, iterations: 4, max_mismatch: 1e-9, buses: [] } as unknown as PflowResult,
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
