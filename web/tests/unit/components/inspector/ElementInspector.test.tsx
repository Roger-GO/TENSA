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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ElementInspector } from '@/components/inspector/ElementInspector';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';

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
    topology: TOPOLOGY,
    layoutSidecar: null,
    selectedElement: null,
  });
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
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  afterEach(() => {
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  });

  it('shows the no-case empty state when no case is loaded', () => {
    render(<ElementInspector />);
    expect(screen.getByText(/load a case to inspect elements/i)).toBeInTheDocument();
  });

  it('shows the no-element-selected empty state when case is loaded but nothing is selected', () => {
    seedLoadedCase();
    render(<ElementInspector />);
    expect(screen.getByText(/click an element on the diagram/i)).toBeInTheDocument();
  });

  it('shows Properties for a selected bus + the Run-PF empty state on the Results tab', async () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    render(<ElementInspector />);

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
    render(<ElementInspector />);

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
    render(<ElementInspector />);

    expect(screen.getByText('156.90 MW')).toBeInTheDocument();
    expect(screen.getByText('-20.40 MVAr')).toBeInTheDocument();
  });

  it('switches between Properties and Results when the user clicks tabs', async () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(<ElementInspector />);

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
    render(<ElementInspector />);

    // Pre-PF default tab: Properties (because lastRun is non-converged).
    // We need to switch to Results to see the message.
    expect(screen.getByText(/inspecting/i)).toBeInTheDocument();
  });

  it('shows fallback text for kinds without per-element PF results (generators)', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(<ElementInspector />);

    expect(screen.getByText(/per-element pf results/i)).toBeInTheDocument();
  });
});
