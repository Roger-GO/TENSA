/**
 * Tests for ``<BusesGrid />`` (v3 Unit 13).
 *
 * Coverage:
 *
 *  - Rows render from a synthetic topology.
 *  - PF result fills V / theta cells.
 *  - No PF → V / theta render ``—``.
 *  - Row click writes BOTH selectedNodeId AND case.selectedElement
 *    per the F-DESIGN-7 dual-write pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { TopologySummary, PflowResult } from '@/api/types';

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

import { BusesGrid } from '@/components/data-grid/BusesGrid';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 1, name: 'Bus1', kind: 'Bus', params: { Vn: 138, area: 1, zone: 1 } },
    { idx: 2, name: 'Bus2', kind: 'Bus', params: { Vn: 138, area: 1, zone: 1 } },
  ],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
};

function pfConverged(): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: { '1': 1.06, '2': 1.045 },
    bus_angles: { '1': 0, '2': -0.087 },
    line_flows: {},
  } as unknown as PflowResult;
}

/** PF result with per-device outputs: gen at bus 1, gen + load at bus 2. */
function pfWithDevices(): PflowResult {
  return {
    ...pfConverged(),
    generator_outputs: {
      GENROU_1: { p: 50.5, q: 12.25, v: 1.06, bus: 1 },
      PV_2: { p: 40, q: 10, v: 1.045, bus: 2 },
    },
    load_consumption: {
      PQ_1: { p: 21.7, q: 12.7, bus: 2 },
    },
  } as unknown as PflowResult;
}

beforeEach(() => {
  mockTopology = null;
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useSldStore.setState({ selectedNodeId: null });
});

afterEach(() => {
  cleanup();
  mockTopology = null;
});

describe('<BusesGrid />', () => {
  it('renders one row per bus from the topology', () => {
    mockTopology = TOPOLOGY;
    render(<BusesGrid />);
    expect(screen.getByTestId('buses-grid-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('buses-grid-row-2')).toBeInTheDocument();
  });

  it('without a PF result, V / theta cells render em-dash', () => {
    mockTopology = TOPOLOGY;
    render(<BusesGrid />);
    const row = screen.getByTestId('buses-grid-row-1');
    // The voltage + theta cells are em-dashes pre-PF. p_inj/q_inj are
    // also em-dashes (not surfaced by v0.1 substrate per the row builder).
    expect(row.textContent).toContain('—');
  });

  it('with a PF result, V / theta cells fill from bus_voltages / bus_angles', () => {
    mockTopology = TOPOLOGY;
    usePflowStore.setState({ lastRun: pfConverged(), isRunning: false, error: null });
    render(<BusesGrid />);
    const row = screen.getByTestId('buses-grid-row-1');
    expect(row.textContent).toContain('1.060');
  });

  it('fills P/Q cells with the net bus injection (Σ gen − Σ load)', () => {
    const threeBuses: TopologySummary = {
      ...TOPOLOGY,
      buses: [
        ...TOPOLOGY.buses,
        { idx: 3, name: 'Bus3', kind: 'Bus', params: { Vn: 138, area: 1, zone: 1 } },
      ],
    };
    mockTopology = threeBuses;
    usePflowStore.setState({ lastRun: pfWithDevices(), isRunning: false, error: null });
    render(<BusesGrid />);
    // Bus 1: generator only → P = 50.5, Q = 12.25 (3-decimal numeric format).
    const row1 = screen.getByTestId('buses-grid-row-1');
    expect(row1.textContent).toContain('50.500');
    expect(row1.textContent).toContain('12.250');
    // Bus 2: gen − load → P = 40 − 21.7 = 18.3, Q = 10 − 12.7 = −2.7.
    const row2 = screen.getByTestId('buses-grid-row-2');
    expect(row2.textContent).toContain('18.300');
    expect(row2.textContent).toContain('-2.700');
    // Bus 3: no attached devices → P/Q stay em-dash.
    const row3 = screen.getByTestId('buses-grid-row-3');
    expect(row3.textContent).toContain('—');
  });

  it('P/Q cells stay em-dash when PF has not converged', () => {
    mockTopology = TOPOLOGY;
    usePflowStore.setState({
      lastRun: { ...pfWithDevices(), converged: false } as PflowResult,
      isRunning: false,
      error: null,
    });
    render(<BusesGrid />);
    const row1 = screen.getByTestId('buses-grid-row-1');
    expect(row1.textContent).not.toContain('50.500');
    expect(row1.textContent).toContain('—');
  });

  it('row click writes selectedNodeId AND case.selectedElement', async () => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<BusesGrid />);
    await user.click(screen.getByTestId('buses-grid-row-2'));
    expect(useSldStore.getState().selectedNodeId).toBe('2');
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '2' });
  });

  it('keyboard nav (ArrowDown + Enter) writes BOTH stores per F-DESIGN-7', async () => {
    // Integration-style: verifies that keyboard cursor advance + Enter
    // commit fires BusesGrid's onRowClick which dual-writes to
    // useSldStore (drives canvas pan / highlight) AND useCaseStore
    // (drives the right inspector form data).
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<BusesGrid />);
    const container = screen.getByTestId('buses-grid');
    container.focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(useSldStore.getState().selectedNodeId).toBe('2');
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '2' });
  });

  it('renders the empty-state when no topology is loaded', () => {
    mockTopology = null;
    render(<BusesGrid />);
    expect(screen.getByTestId('buses-grid-empty')).toBeInTheDocument();
  });
});

describe('<BusesGrid /> voltage limits', () => {
  /** The cell texts of one row, in column order. */
  function cells(busIdx: string): string[] {
    const row = screen.getByTestId(`buses-grid-row-${busIdx}`);
    return within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? '');
  }

  const LIMITED: TopologySummary = {
    ...TOPOLOGY,
    buses: [
      // Own limits 0.9 / 1.1.
      { idx: 1, name: 'Bus1', kind: 'Bus', params: { vmin: 0.9, vmax: 1.1 } },
      // Tight own limits, 1.0 / 1.02.
      { idx: 2, name: 'Bus2', kind: 'Bus', params: { vmin: 1.0, vmax: 1.02 } },
      // No limits in the case: the 0.95 / 1.05 default.
      { idx: 3, name: 'Bus3', kind: 'Bus', params: { Vn: 138 } },
    ],
  };

  it('puts the limits each bus is judged on right after V', () => {
    mockTopology = LIMITED;
    render(<BusesGrid />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(headers.slice(0, 6).map((h) => h.replace(/[·▲▼]/g, ''))).toEqual([
      'idx',
      'name',
      'V (pu)',
      'vmin (pu)',
      'vmax (pu)',
      'Limit check',
    ]);
    expect(cells('1').slice(3, 5)).toEqual(['0.900', '1.100']);
    expect(cells('2').slice(3, 5)).toEqual(['1.000', '1.020']);
    // A bus whose case sets none shows the default it is judged on.
    expect(cells('3').slice(3, 5)).toEqual(['0.950', '1.050']);
  });

  it('shows no verdict before a power flow has converged', () => {
    mockTopology = LIMITED;
    render(<BusesGrid />);
    expect(cells('1')[5]).toBe('—');
  });

  it('reads each bus against its own limits in words', () => {
    mockTopology = LIMITED;
    usePflowStore.setState({
      lastRun: {
        ...pfConverged(),
        // 0.93 is below the default band but fine for Bus1; Bus2 is beyond its
        // own upper limit although 1.03 is inside the default band.
        bus_voltages: { '1': 0.93, '2': 1.03, '3': 0.94 },
      } as PflowResult,
    });
    render(<BusesGrid />);
    expect(cells('1')[5]).toBe('Within limits');
    expect(cells('2')[5]).toBe('Above vmax');
    expect(cells('3')[5]).toBe('Below vmin');
  });

  it('marks a bus near a limit', () => {
    mockTopology = LIMITED;
    usePflowStore.setState({
      lastRun: {
        ...pfConverged(),
        bus_voltages: { '1': 0.91, '2': 1.01, '3': 1.04 },
      } as PflowResult,
    });
    render(<BusesGrid />);
    expect(cells('1')[5]).toBe('Near vmin');
    expect(cells('3')[5]).toBe('Near vmax');
  });

  it('says how to change a limit while the case has not been run', () => {
    mockTopology = LIMITED;
    render(<BusesGrid />);
    const hint = screen.getByTestId('buses-grid-hint');
    expect(hint).toHaveTextContent("To change a bus's vmin or vmax");
    expect(hint).toHaveTextContent('click the pencil');
  });

  it('says how to unlock the limits once a run has locked the case', () => {
    mockTopology = { ...LIMITED, state: 'committed' };
    render(<BusesGrid />);
    const hint = screen.getByTestId('buses-grid-hint');
    expect(hint).toHaveTextContent('vmin and vmax are locked once a run has started');
    expect(hint).toHaveTextContent('Reset run');
  });

  it('has no hint before a case is loaded', () => {
    mockTopology = null;
    render(<BusesGrid />);
    expect(screen.queryByTestId('buses-grid-hint')).not.toBeInTheDocument();
  });
});
