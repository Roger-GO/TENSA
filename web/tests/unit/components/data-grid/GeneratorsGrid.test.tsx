/**
 * Tests for ``<GeneratorsGrid />`` (v3 Unit 13).
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

import { GeneratorsGrid } from '@/components/data-grid/GeneratorsGrid';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [],
  lines: [],
  transformers: [],
  generators: [
    { idx: '0', name: 'Gen0', kind: 'GENROU', params: { bus: 1, p0: 100, q0: -10 } },
    { idx: '1', name: 'Gen1', kind: 'PV', params: { bus: 2, p0: 50, q0: 5 } },
  ],
  loads: [],
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

describe('<GeneratorsGrid />', () => {
  it('renders rows with generator-prefixed rowIds', () => {
    mockTopology = TOPOLOGY;
    render(<GeneratorsGrid />);
    expect(screen.getByTestId('generators-grid-row-generator-0')).toBeInTheDocument();
    expect(screen.getByTestId('generators-grid-row-generator-1')).toBeInTheDocument();
  });

  it('row click sets selectedElement to {kind:"generator", idx}', async () => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<GeneratorsGrid />);
    await user.click(screen.getByTestId('generators-grid-row-generator-1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: '1',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('generator-1');
  });
});
