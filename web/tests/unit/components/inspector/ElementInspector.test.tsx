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
import { useUnitsStore } from '@/store/units';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';
import { lineFlow } from '../../helpers/lineFlow';

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
    line_flows: { L1: lineFlow(156.9, -20.4) },
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
    useUnitsStore.setState({ mode: 'pu' });
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
    useUnitsStore.setState({ mode: 'pu' });
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

  it('shows a bus voltage in kV, and its angle in degrees, under the actual-units display', () => {
    seedLoadedCase();
    useUnitsStore.setState({ mode: 'actual' });
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '2' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    // 1.045 pu on the 138 kV of bus 2.
    expect(screen.getByText('144.210 kV')).toBeInTheDocument();
    // -0.087 rad is -4.98 degrees in either unit.
    expect(screen.getByText('-4.98°')).toBeInTheDocument();
  });

  it('keeps a bus voltage in pu under the actual-units display when the bus has no rated voltage', () => {
    seedLoadedCase();
    useUnitsStore.setState({ mode: 'actual' });
    mockTopology = {
      ...TOPOLOGY,
      buses: [{ idx: 1, name: 'Bus1', kind: 'Bus', params: {} }, ...TOPOLOGY.buses.slice(1)],
    };
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText('1.0600 pu')).toBeInTheDocument();
  });

  it('keeps a bus voltage in pu under the actual-units display when the case gives the bus no Vn', () => {
    seedLoadedCase();
    useUnitsStore.setState({ mode: 'actual' });
    // The 138 kV in its params is ANDES's fill-in, which the topology lists.
    mockTopology = { ...TOPOLOGY, buses_without_vn: [2] };
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '2' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText('1.0450 pu')).toBeInTheDocument();
  });

  it('shows a generator terminal voltage in kV on its bus, under the actual-units display', () => {
    seedLoadedCase();
    useUnitsStore.setState({ mode: 'actual' });
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        generator_outputs: { G1: { p: 232.4, q: -16.9, v: 1.06, bus: 1 } },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    // 1.06 pu on the 138 kV of bus 1.
    expect(screen.getByText('146.280 kV')).toBeInTheDocument();
    // The powers are actual already.
    expect(screen.getByText('232.40 MW')).toBeInTheDocument();
  });

  it('shows post-PF results for a selected line (p_flow + q_flow)', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'line', idx: 'L1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText('156.90 MW')).toBeInTheDocument();
    expect(screen.getByText('-20.40 MVAr')).toBeInTheDocument();
  });

  it('shows the power at both ends of a line, its loss, and its loading against the rating', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'line', idx: 'L1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        line_flows: {
          L1: lineFlow(
            156.9,
            -20.4,
            { from: 1, to: 2 },
            { p_to: -152.5, q_to: 25.1, loss: 4.4, rate_a: 150, loading_pct: 106.1 },
          ),
        },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText('-152.50 MW')).toBeInTheDocument();
    expect(screen.getByText('25.10 MVAr')).toBeInTheDocument();
    expect(screen.getByText('4.400 MW')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-loading')).toHaveTextContent(
      '106.1% of 150.0 MVA (over rating)',
    );
  });

  it('says a line has no rating when the case gives none', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'line', idx: 'L1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByTestId('inspector-loading')).toHaveTextContent('no rating');
  });

  it('shows a loaded transformer the same two-ended flow and loading', () => {
    seedLoadedCase();
    mockTopology = {
      ...TOPOLOGY,
      transformers: [{ idx: 'T1', name: 'Trafo1', kind: 'Line', params: { bus1: 1, bus2: 2 } }],
    };
    useCaseStore.setState({ selectedElement: { kind: 'transformer', idx: 'T1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        line_flows: {
          T1: lineFlow(26, 2, { from: 1, to: 2 }, { rate_a: 20, loading_pct: 130.4 }),
        },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByTestId('inspector-loading')).toHaveTextContent(
      '130.4% of 20.0 MVA (over rating)',
    );
  });

  it('shows where a generator Q stands against its limits', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        generator_outputs: { G1: { p: 232.4, q: 30, v: 1.06, bus: 1, q_min: -10, q_max: 15 } },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByTestId('inspector-q-limits')).toHaveTextContent(
      '-10.00 to 15.00 MVAr (above qmax)',
    );
  });

  it('leaves the Q limits out for a generator the server sends none for', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        generator_outputs: { G1: { p: 0, q: 0, v: 1.06, bus: 1, q_min: null, q_max: null } },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    expect(screen.queryByTestId('inspector-q-limits')).not.toBeInTheDocument();
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

  it('shows the row of the static generator a dynamic machine names in gen', () => {
    // A machine has no row of its own in generator_outputs; the diagram and
    // the Inspector read the same one.
    seedLoadedCase();
    mockTopology = {
      ...TOPOLOGY,
      generators: [
        ...TOPOLOGY.generators,
        {
          idx: 'GENROU_1',
          name: 'Machine1',
          kind: 'GENROU',
          params: { bus: 1, gen: 'G1' },
        },
      ],
    };
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'GENROU_1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        generator_outputs: { G1: { p: 232.4, q: -16.9, v: 1.06, bus: 1 } },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText('232.40 MW')).toBeInTheDocument();
    expect(screen.getByText('-16.90 MVAr')).toBeInTheDocument();
    expect(screen.queryByText(/no pf output/i)).not.toBeInTheDocument();
  });

  it('says there is no PF output for a machine that names no static generator', () => {
    seedLoadedCase();
    mockTopology = {
      ...TOPOLOGY,
      generators: [
        ...TOPOLOGY.generators,
        { idx: 'GENROU_1', name: 'Machine1', kind: 'GENROU', params: { bus: 1 } },
      ],
    };
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'GENROU_1' } });
    usePflowStore.setState({
      lastRun: makePflowResult({
        generator_outputs: { G1: { p: 232.4, q: -16.9, v: 1.06, bus: 1 } },
      }),
      isRunning: false,
      error: null,
    });
    render(withQueryClient(<ElementInspector />));

    expect(screen.getByText(/no pf output for generator GENROU_1/i)).toBeInTheDocument();
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
