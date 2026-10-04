/**
 * Tests for ``<LinesGrid />`` (v3 Unit 13).
 *
 * Smoke tests — line rowId is ``line-${idx}`` per F-DESIGN-6, and click
 * writes selectedElement (line). Canvas pan would no-op for line ids
 * since lines aren't React Flow nodes; we still write selectedNodeId
 * so the data-grid row highlight stays in sync.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import { lineFlow } from '../../helpers/lineFlow';
import type { PflowResult, TopologySummary } from '@/api/types';

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

import { LinesGrid } from '@/components/data-grid/LinesGrid';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [],
  lines: [
    { idx: 'L1', name: 'Line1-2', kind: 'Line', params: { bus1: 1, bus2: 2 } },
    { idx: 'L2', name: 'Line2-3', kind: 'Line', params: { bus1: 2, bus2: 3 } },
  ],
  transformers: [],
  generators: [],
  loads: [],
};

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

describe('<LinesGrid />', () => {
  it('renders rows with line-prefixed rowIds', () => {
    mockTopology = TOPOLOGY;
    render(<LinesGrid />);
    expect(screen.getByTestId('lines-grid-row-line-L1')).toBeInTheDocument();
    expect(screen.getByTestId('lines-grid-row-line-L2')).toBeInTheDocument();
  });

  it('row click sets selectedElement to {kind:"line", idx}', async () => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<LinesGrid />);
    await user.click(screen.getByTestId('lines-grid-row-line-L1'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'line', idx: 'L1' });
    expect(useSldStore.getState().selectedNodeId).toBe('line-L1');
  });
});

function solved(): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-7,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {
      L1: lineFlow(
        112.4,
        10,
        { from: 1, to: 2 },
        { p_to: -110.2, q_to: -5, loss: 2.2, rate_a: 100, loading_pct: 112.4 },
      ),
      L2: lineFlow(20, 2, { from: 2, to: 3 }, { p_to: -19.9, q_to: -1.5, loss: 0.1 }),
    },
  };
}

function cells(rowId: string): (string | null)[] {
  return [...screen.getByTestId(`lines-grid-row-${rowId}`).querySelectorAll('[role=cell]')].map(
    (c) => c.textContent,
  );
}

describe('<LinesGrid /> both ends, loss and loading', () => {
  it('reads the power at both ends and the loss from the PF result', () => {
    mockTopology = TOPOLOGY;
    usePflowStore.setState({ lastRun: solved(), isRunning: false, error: null });
    render(<LinesGrid />);
    // idx, from, to, P_from, Q_from, P_to, Q_to, loss, rating, loading, check
    expect(cells('line-L1').slice(3, 8)).toEqual([
      '112.400',
      '10.000',
      '-110.200',
      '-5.000',
      '2.200',
    ]);
  });

  it('shows the rating, the loading and the verdict of a rated line', () => {
    mockTopology = TOPOLOGY;
    usePflowStore.setState({ lastRun: solved(), isRunning: false, error: null });
    render(<LinesGrid />);
    expect(cells('line-L1').slice(8)).toEqual(['100.000', '112.400', 'Over rating']);
  });

  it('leaves the rating, loading and verdict of an unrated line empty', () => {
    mockTopology = TOPOLOGY;
    usePflowStore.setState({ lastRun: solved(), isRunning: false, error: null });
    render(<LinesGrid />);
    expect(cells('line-L2').slice(8)).toEqual(['—', '—', '—']);
    // The two ends and the loss are there all the same.
    expect(cells('line-L2').slice(3, 8)).toEqual(['20.000', '2.000', '-19.900', '-1.500', '0.100']);
  });

  it('leaves every figure empty before a power flow and after one that did not converge', () => {
    mockTopology = TOPOLOGY;
    const { unmount } = render(<LinesGrid />);
    expect(cells('line-L1').slice(3)).toEqual(Array(8).fill('—'));
    unmount();
    usePflowStore.setState({
      lastRun: { ...solved(), converged: false },
      isRunning: false,
      error: null,
    });
    render(<LinesGrid />);
    expect(cells('line-L1').slice(3)).toEqual(Array(8).fill('—'));
  });
});
