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
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

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
