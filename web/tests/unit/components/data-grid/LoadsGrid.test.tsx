/**
 * Tests for ``<LoadsGrid />`` (v3 Unit 13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCaseStore } from '@/store/case';
import { useSldStore } from '@/store/sld';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

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

beforeEach(() => {
  mockTopology = null;
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
});
