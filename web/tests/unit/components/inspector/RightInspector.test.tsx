/**
 * Tests for ``<RightInspector />`` (v3 Unit 7).
 *
 * Covers:
 *   - Header reads "Bus <name>" when a bus is selected.
 *   - All three accordion sections render (Properties / Plots /
 *     Disturbances).
 *   - Clicking a section trigger toggles its open state.
 *   - Per-element-kind open-state persists across selections via
 *     localStorage under
 *     ``tensa:layout-v1:rightInspector:openSections:<kind>``.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useDisturbanceStore } from '@/store/disturbance';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return {
    ...actual,
    useCurrentTopology: () => mockTopology,
    useTopologySchema: () => ({ data: undefined }),
    useReloadCase: () => ({ mutate: () => {}, isPending: false }),
  };
});

import { RightInspector } from '@/components/inspector/RightInspector';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 5, name: 'BUS_5', kind: 'Bus', params: { Vn: 138 } },
    { idx: 7, name: 'BUS_7', kind: 'Bus', params: { Vn: 138 } },
  ],
  lines: [],
  transformers: [],
  generators: [{ idx: 'G1', name: 'GEN_1', kind: 'PV', params: { bus: 5, p0: 200 } }],
  loads: [],
};

function seedLoadedCase() {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    layoutSidecar: null,
    selectedElement: null,
  });
  mockTopology = TOPOLOGY;
}

beforeEach(() => {
  window.localStorage.clear();
  mockTopology = null;
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  useDisturbanceStore.getState().clearDisturbances();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  mockTopology = null;
  useCaseStore.setState({
    selection: null,
    topology: null,
    layoutSidecar: null,
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  useDisturbanceStore.getState().clearDisturbances();
});

describe('<RightInspector />', () => {
  it('shows EmptyState when nothing is selected', () => {
    render(withQueryClient(<RightInspector />));
    expect(screen.getByTestId('right-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('renders header + 3 sections when a bus is selected', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<RightInspector />));
    const header = screen.getByTestId('right-inspector-header');
    expect(header.textContent).toContain('Bus');
    expect(header.textContent).toContain('BUS_5');
    expect(screen.getByTestId('right-inspector-accordion')).toBeInTheDocument();
    expect(screen.getByTestId('right-inspector-section-properties')).toBeInTheDocument();
    expect(screen.getByTestId('right-inspector-section-plots')).toBeInTheDocument();
    expect(screen.getByTestId('right-inspector-section-disturbances')).toBeInTheDocument();
  });

  it('Properties opens by default; clicking Plots trigger reveals plots-accordion', async () => {
    const user = userEvent.setup();
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(withQueryClient(<RightInspector />));
    // Properties starts open → properties-accordion mounted.
    expect(screen.getByTestId('properties-accordion')).toBeInTheDocument();
    // Plots starts closed → plots-accordion not in the DOM tree.
    expect(screen.queryByTestId('plots-accordion')).toBeNull();
    await user.click(screen.getByTestId('right-inspector-section-trigger-plots'));
    expect(screen.getByTestId('plots-accordion')).toBeInTheDocument();
  });

  it('persists per-kind open state across selections', async () => {
    const user = userEvent.setup();
    seedLoadedCase();
    // Bus selection → user opens Plots in addition to Properties.
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    const { unmount } = render(withQueryClient(<RightInspector />));
    await user.click(screen.getByTestId('right-inspector-section-trigger-plots'));
    expect(
      window.localStorage.getItem('tensa:layout-v1:rightInspector:openSections:bus'),
    ).toContain('plots');
    unmount();

    // Switch to a generator selection — the bus-specific persisted state
    // should NOT carry over (separate kind, separate slot).
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    render(withQueryClient(<RightInspector />));
    // Generator has no persisted state → defaults to properties only.
    expect(screen.queryByTestId('plots-accordion')).toBeNull();

    // Now back to a bus — should restore the persisted-with-plots-open
    // state.
    cleanup();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '7' } });
    render(withQueryClient(<RightInspector />));
    expect(screen.getByTestId('plots-accordion')).toBeInTheDocument();
  });
});
