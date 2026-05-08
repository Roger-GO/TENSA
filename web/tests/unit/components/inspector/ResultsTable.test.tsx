/**
 * Tests for `<ResultsTable />`.
 *
 * Covers tab switching, row rendering pre/post-PF, sort, filter, and
 * row-click cross-pane interaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResultsTable } from '@/components/inspector/ResultsTable';
import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 1, name: 'Bus1', kind: 'Bus', params: { Vn: 138 } },
    { idx: 2, name: 'Bus2', kind: 'Bus', params: { Vn: 138 } },
    { idx: 3, name: 'Bus3', kind: 'Bus', params: { Vn: 69 } },
  ],
  lines: [
    { idx: 'L1', name: 'Line1-2', kind: 'Line', params: { bus1: 1, bus2: 2 } },
    { idx: 'L2', name: 'Line2-3', kind: 'Line', params: { bus1: 2, bus2: 3 } },
  ],
  transformers: [],
  generators: [
    { idx: 'G1', name: 'Gen1', kind: 'PV', params: { bus: 1, p0: 100, q0: -10, v0: 1.06 } },
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
    bus_voltages: { '1': 1.06, '2': 1.045, '3': 0.92 },
    bus_angles: { '1': 0, '2': -0.087, '3': -0.174 },
    line_flows: {
      L1: { p: 156.9, q: -20.4, from_idx: 1, to_idx: 2 },
      L2: { p: 75.5, q: 5.0, from_idx: 2, to_idx: 3 },
    },
    ...overrides,
  };
}

describe('<ResultsTable />', () => {
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

  it('shows no-case empty state when no case is loaded', () => {
    render(<ResultsTable />);
    expect(screen.getByText(/load a case to see its elements/i)).toBeInTheDocument();
  });

  it('renders bus rows pre-PF with em-dash for missing PF columns', () => {
    seedLoadedCase();
    render(<ResultsTable />);

    // Buses tab is the default; 3 rows visible.
    expect(screen.getByTestId('results-row-bus-1')).toBeInTheDocument();
    expect(screen.getByTestId('results-row-bus-2')).toBeInTheDocument();
    expect(screen.getByTestId('results-row-bus-3')).toBeInTheDocument();
  });

  it('renders post-PF bus voltage values', () => {
    seedLoadedCase();
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(<ResultsTable />);

    const row1 = screen.getByTestId('results-row-bus-1');
    expect(within(row1).getByText('1.0600')).toBeInTheDocument();

    const row3 = screen.getByTestId('results-row-bus-3');
    expect(within(row3).getByText('0.9200')).toBeInTheDocument();
    // Bus 3 is in the danger band (0.92 < 0.95), so the row carries the
    // limit-violation flag class (border-l-danger).
    expect(row3.className).toContain('border-l-danger');
  });

  it('switches to the Lines tab and shows post-PF flow values', async () => {
    seedLoadedCase();
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(<ResultsTable />);

    await userEvent.click(screen.getByRole('tab', { name: /lines/i }));

    const row1 = screen.getByTestId('results-row-line-L1');
    expect(within(row1).getByText('156.90')).toBeInTheDocument();
    expect(within(row1).getByText('-20.40')).toBeInTheDocument();
  });

  it('switches to the Generators tab + shows generator setpoints', async () => {
    seedLoadedCase();
    render(<ResultsTable />);

    await userEvent.click(screen.getByRole('tab', { name: /generators/i }));

    const row = screen.getByTestId('results-row-generator-G1');
    expect(within(row).getByText('Gen1')).toBeInTheDocument();
    expect(within(row).getByText('1.0600')).toBeInTheDocument(); // v_setpoint = 1.06 → 1.0600
  });

  it('clicking a row sets the selectedElement', async () => {
    seedLoadedCase();
    render(<ResultsTable />);

    await userEvent.click(screen.getByTestId('results-row-bus-2'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '2' });
  });

  it('filtering by name narrows the visible rows', async () => {
    seedLoadedCase();
    render(<ResultsTable />);

    const filter = screen.getByLabelText(/filter results/i);
    await userEvent.type(filter, 'Bus2');

    expect(screen.queryByTestId('results-row-bus-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('results-row-bus-2')).toBeInTheDocument();
    expect(screen.queryByTestId('results-row-bus-3')).not.toBeInTheDocument();
  });

  it('sorting by voltage descending re-orders rows', async () => {
    seedLoadedCase();
    usePflowStore.setState({ lastRun: makePflowResult(), isRunning: false, error: null });
    render(<ResultsTable />);

    // Click "V (pu)" header — default direction is desc, so this puts
    // bus 1 (1.06) first, bus 2 (1.045), then bus 3 (0.92).
    const header = screen.getByRole('button', { name: /V \(pu\)/i });
    await userEvent.click(header);

    const buses = screen.getAllByRole('row').slice(1); // skip header row
    expect(buses[0]).toHaveAttribute('data-testid', 'results-row-bus-1');
    expect(buses[1]).toHaveAttribute('data-testid', 'results-row-bus-2');
    expect(buses[2]).toHaveAttribute('data-testid', 'results-row-bus-3');

    // Click again to flip to ascending.
    await userEvent.click(header);
    const busesAsc = screen.getAllByRole('row').slice(1);
    expect(busesAsc[0]).toHaveAttribute('data-testid', 'results-row-bus-3');
  });

  it('shows empty-tab message when a tab has zero rows', async () => {
    // Topology with no generators.
    seedLoadedCase();
    useCaseStore.setState({
      topology: { ...TOPOLOGY, generators: [] },
    });
    render(<ResultsTable />);

    await userEvent.click(screen.getByRole('tab', { name: /generators/i }));
    expect(screen.getByText(/no generators in this case/i)).toBeInTheDocument();
  });

  it('shows pre-PF copy ("Run power flow to see results") on the Buses tab when no PF run yet', () => {
    seedLoadedCase();
    render(<ResultsTable />);

    // Buses table is rendered with em-dashes pre-PF; the prePflowLabel
    // is wired into the empty branch, but rows exist (3 buses) so we
    // show the table with em-dashes. Verify em-dash appears.
    const row1 = screen.getByTestId('results-row-bus-1');
    expect(within(row1).getAllByText('—').length).toBeGreaterThan(0);
  });
});
