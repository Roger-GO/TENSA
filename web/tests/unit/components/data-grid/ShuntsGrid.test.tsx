/**
 * Tests for ``<ShuntsGrid />`` (v3 Unit 13).
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

import { ShuntsGrid } from '@/components/data-grid/ShuntsGrid';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [],
  loads: [],
  shunts: [{ idx: '0', name: 'Shunt0', kind: 'Shunt', params: { bus: 9, b: 0.19, g: 0 } }],
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

describe('<ShuntsGrid />', () => {
  it('renders one row per shunt with shunt- prefixed rowId', () => {
    mockTopology = TOPOLOGY;
    render(<ShuntsGrid />);
    expect(screen.getByTestId('shunts-grid-row-shunt-0')).toBeInTheDocument();
  });

  it('row click sets selectedElement to {kind:"shunt", idx}', async () => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<ShuntsGrid />);
    await user.click(screen.getByTestId('shunts-grid-row-shunt-0'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'shunt', idx: '0' });
    expect(useSldStore.getState().selectedNodeId).toBe('shunt-0');
  });

  it('renders empty state when no shunts in topology', () => {
    mockTopology = {
      ...TOPOLOGY,
      shunts: [],
    };
    render(<ShuntsGrid />);
    expect(screen.getByTestId('shunts-grid-empty')).toBeInTheDocument();
  });
});
