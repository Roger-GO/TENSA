/**
 * Tests for ``<LoadsGrid />`` (v3 Unit 13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { PflowResult, TopologySummary } from '@/api/types';

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

import { LoadsGrid } from '@/components/data-grid/LoadsGrid';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [{ idx: '0', name: 'Load0', kind: 'PQ', params: { bus: 3, p0: 90, q0: 30 } }],
};

/**
 * A kundur-like load: the case gives it as per-unit setpoints on a 100 MVA base
 * (p0 9.67, q0 1.0), the power flow solves it as 967 MW and 100 MVAr.
 */
const KUNDUR_TOPOLOGY: TopologySummary = {
  state: 'committed',
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [
    { idx: 'PQ_1', name: 'PQ_1', kind: 'PQ', params: { bus: 7, p0: 9.67, q0: 1.0 } },
    { idx: 'PQ_2', name: 'PQ_2', kind: 'PQ', params: { bus: 8, p0: 17.67, q0: 1.0 } },
  ],
};

function pfWithLoads(): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {},
    load_consumption: {
      PQ_1: { p: 967, q: 100, bus: 7 },
      PQ_2: { p: 1767.5, q: 99.75, bus: 8 },
    },
  } as unknown as PflowResult;
}

/** The P and Q cells (the 4th and 5th of idx, name, bus, P, Q, status) of a row. */
function pq(rowId: string): (string | null)[] {
  return [...screen.getByTestId(`loads-grid-row-${rowId}`).querySelectorAll('[role=cell]')]
    .slice(3, 5)
    .map((c) => c.textContent);
}

beforeEach(() => {
  mockTopology = null;
  usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    selectedElement: null,
  });
  useSldStore.setState({ selectedNodeId: null });
});

afterEach(() => {
  cleanup();
  mockTopology = null;
});

describe('<LoadsGrid />', () => {
  it('renders one row per load with load- prefixed rowId', () => {
    mockTopology = TOPOLOGY;
    render(<LoadsGrid />);
    expect(screen.getByTestId('loads-grid-row-load-0')).toBeInTheDocument();
  });

  it('row click sets selectedElement to {kind:"load", idx}', async () => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<LoadsGrid />);
    await user.click(screen.getByTestId('loads-grid-row-load-0'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'load', idx: '0' });
    expect(useSldStore.getState().selectedNodeId).toBe('load-0');
  });

  it('shows no consumption before power flow has run, not the per-unit setpoint', () => {
    mockTopology = KUNDUR_TOPOLOGY;
    render(<LoadsGrid />);
    expect(pq('load-PQ_1')).toEqual(['—', '—']);
    expect(pq('load-PQ_2')).toEqual(['—', '—']);
  });

  it('fills P and Q from the PF result, in MW and MVAr, as the diagram prints them', () => {
    mockTopology = KUNDUR_TOPOLOGY;
    usePflowStore.setState({ lastRun: pfWithLoads(), isRunning: false, error: null });
    render(<LoadsGrid />);
    expect(pq('load-PQ_1')).toEqual(['967.000', '100.000']);
    expect(pq('load-PQ_2')).toEqual(['1767.500', '99.750']);
  });

  it('leaves P and Q empty when the power flow did not converge', () => {
    mockTopology = KUNDUR_TOPOLOGY;
    usePflowStore.setState({
      lastRun: { ...pfWithLoads(), converged: false } as PflowResult,
      isRunning: false,
      error: null,
    });
    render(<LoadsGrid />);
    expect(pq('load-PQ_1')).toEqual(['—', '—']);
  });

  it('leaves a load the PF result has no row for empty', () => {
    mockTopology = KUNDUR_TOPOLOGY;
    const pf = pfWithLoads();
    delete (pf.load_consumption as Record<string, unknown>)['PQ_1'];
    usePflowStore.setState({ lastRun: pf, isRunning: false, error: null });
    render(<LoadsGrid />);
    expect(pq('load-PQ_1')).toEqual(['—', '—']);
    expect(pq('load-PQ_2')).toEqual(['1767.500', '99.750']);
  });

  it('explains on the P and Q headings where the figures come from', () => {
    mockTopology = KUNDUR_TOPOLOGY;
    render(<LoadsGrid />);
    for (const key of ['p', 'q']) {
      expect(screen.getByTestId(`loads-grid-header-${key}`)).toHaveAttribute(
        'title',
        expect.stringContaining('power flow'),
      );
    }
  });
});
