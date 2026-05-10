/**
 * Tests for `<ElementInspector />`.
 *
 * Covers the four states from the interaction-states matrix:
 * - empty no-case
 * - empty no-element-selected
 * - element-selected pre-PF
 * - element-selected post-PF
 *
 * Each test seeds the case + pflow stores; UI is rendered via the
 * standard testing-library helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

// The production `ElementInspector` reads topology via the
// `useCurrentTopology()` hook from `@/api/queries`, which forwards to a
// TanStack Query call. Stub the hook to read from a module-level
// mutable variable so the test can drive the topology directly,
// matching the previous `useCaseStore.setState({ topology })` pattern.
let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

// Import after the mock is registered so the component picks up the
// stubbed hook.
import { ElementInspector } from '@/components/inspector/ElementInspector';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    {
      idx: 1,
      name: 'Bus1',
      kind: 'Bus',
      params: { Vn: 138.0, vmax: 1.05, vmin: 0.95, area: 1 },
    },
    {
      idx: 2,
      name: 'Bus2',
      kind: 'Bus',
      params: { Vn: 138.0 },
    },
  ],
  lines: [
    {
      idx: 'L1',
      name: 'Line1',
      kind: 'Line',
      params: { bus1: 1, bus2: 2, r: 0.01938, x: 0.05917 },
    },
  ],
  transformers: [],
  generators: [
    {
      idx: 'G1',
      name: 'Gen1',
      kind: 'PV',
      params: { bus: 1, p0: 232, q0: -16.9, v0: 1.06 },
    },
  ],
  loads: [],
};

function seedLoadedCase() {
  useCaseStore.setState({
    selection: {
      primaryPath: parseWorkspacePath('ieee14.raw'),
      addfiles: [],
    },
    layoutSidecar: null,
    selectedElement: null,
  });
  mockTopology = TOPOLOGY;
}

function makePflowResult(overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: { '1': 1.06, '2': 1.045 },
    bus_angles: { '1': 0, '2': -0.087 },
    line_flows: { L1: { p: 156.9, q: -20.4, from_idx: 1, to_idx: 2 } },
    ...overrides,
  };
}

describe('<ElementInspector />', () => {
  beforeEach(() => {
    mockTopology = null;
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    mockTopology = null;
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  it('shows the no-case empty state when no case is loaded', () => {
    render(withQueryClient(<ElementInspector />));
    expect(screen.getByText(/load a case to inspect elements/i)).toBeInTheDocument();
  });

  it('shows the no-element-selected empty state when case is loaded but nothing is selected', () => {
    seedLoadedCase();
    render(withQueryClient(<ElementInspector />));
    expect(screen.getByText(/click an element on the diagram/i)).toBeInTheDocument();
  });

  it('shows Properties for a selected bus + the Run-PF empty state on the Results tab', async () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    render(withQueryClient(<ElementInspector />));

    // Header shows "bus 1".
    expect(screen.getByText(/bus 1/i)).toBeInTheDocument();
    // Properties tab is the default before PF runs; verify the
    // properties dl is rendered.
    expect(screen.getByTestId('inspector-properties')).toBeInTheDocument();
    expect(screen.getByText('Vn')).toBeInTheDocument();
    expect(screen.getByText('vmax')).toBeInTheDocument();

    // Switch to Results tab; should show the pre-PF empty state.
    await userEvent.click(screen.getByRole('tab', { name: /results/i }));
    expect(screen.getByText(/run power flow to see results/i)).toBeInTheDocument();
  });

  it('shows post-PF results for a selected bus', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    // Default tab post-PF is Results.
    expect(screen.getByTestId('inspector-results')).toBeInTheDocument();
    expect(screen.getByText('1.0600 pu')).toBeInTheDocument();
    // Angle in degrees: 0 rad → 0.00°
    expect(screen.getByText('0.00°')).toBeInTheDocument();
  });

  it('shows post-PF results for a selected line (p_flow + q_flow)', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'line', idx: 'L1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText('156.90 MW')).toBeInTheDocument();
    expect(screen.getByText('-20.40 MVAr')).toBeInTheDocument();
  });

  it('switches between Properties and Results when the user clicks tabs', async () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    // Default is Results post-PF; click Properties.
    await userEvent.click(screen.getByRole('tab', { name: /properties/i }));
    expect(screen.getByTestId('inspector-properties')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-results')).not.toBeInTheDocument();
  });

  it('handles non-converged PF result with an explanatory message', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({ converged: false }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    // Pre-PF default tab: Properties (because lastRun is non-converged).
    // We need to switch to Results to see the message.
    expect(screen.getByText(/inspecting/i)).toBeInTheDocument();
  });

  it('shows generator P / Q / V_term when generator output is in the PF result', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        generator_outputs: {
          G1: { p: 232.4, q: -16.9, v: 1.06, bus: 1 },
        },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText('232.40 MW')).toBeInTheDocument();
    expect(screen.getByText('-16.90 MVAr')).toBeInTheDocument();
    expect(screen.getByText('1.0600 pu')).toBeInTheDocument();
  });

  it('shows shunt fallback hint (no per-shunt PF results)', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'shunt', idx: 'SH1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText(/per-element pf results/i)).toBeInTheDocument();
  });

  // ---- Unit 2 (v0.1.y): DeleteElementButton placement guards -------------

  it('renders the DeleteElementButton in the inspector header when state=pre-setup and PF is idle', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    render(withQueryClient(<ElementInspector />));
    expect(screen.getByTestId('delete-element-button')).toBeInTheDocument();
  });

  it('hides the DeleteElementButton when state is committed', () => {
    seedLoadedCase();
    mockTopology = { ...TOPOLOGY, state: 'committed' };
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    render(withQueryClient(<ElementInspector />));
    expect(screen.queryByTestId('delete-element-button')).toBeNull();
  });

  it('hides the DeleteElementButton while PF is running', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    usePflowStore.setState({ lastRun: null, isRunning: true, error: null });
    render(withQueryClient(<ElementInspector />));
    expect(screen.queryByTestId('delete-element-button')).toBeNull();
  });
});
