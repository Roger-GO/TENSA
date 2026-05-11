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
import { cleanup, render, screen } from '@testing-library/react';
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

  it('row click writes selectedNodeId AND case.selectedElement', async () => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<BusesGrid />);
    await user.click(screen.getByTestId('buses-grid-row-2'));
    expect(useSldStore.getState().selectedNodeId).toBe('2');
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '2' });
  });

  it('renders the empty-state when no topology is loaded', () => {
    mockTopology = null;
    render(<BusesGrid />);
    expect(screen.getByTestId('buses-grid-empty')).toBeInTheDocument();
  });
});
