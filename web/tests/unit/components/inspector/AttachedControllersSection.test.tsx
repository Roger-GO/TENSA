/**
 * Tests for `<AttachedControllersSection />` (v3.1 Unit 20).
 *
 * Under a selected generator, the section lists the controllers bound to it
 * by `syn`, and each row switches the inspector selection (and SLD highlight)
 * to that controller. Empty state when the machine has no dynamic stack.
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

import { AttachedControllersSection } from '@/components/inspector/AttachedControllersSection';

const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [{ idx: 1, name: 'Bus1', kind: 'Bus', params: {} }],
  lines: [],
  transformers: [],
  generators: [{ idx: 'GENROU_1', name: 'Gen1', kind: 'GENROU', params: { bus: 1 } }],
  loads: [],
  controllers: [
    { idx: 'EXST1_1', name: 'EXST1 1', kind: 'EXST1', params: { syn: 'GENROU_1' } },
    { idx: 'IEEEG1_1', name: 'IEEEG1 1', kind: 'IEEEG1', params: { syn: 'GENROU_1' } },
    // A controller on a different machine — must NOT appear.
    { idx: 'EXST1_2', name: 'EXST1 2', kind: 'EXST1', params: { syn: 'GENROU_2' } },
  ],
};

function selectGenerator(idx = 'GENROU_1') {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    selectedElement: { kind: 'generator', idx },
  });
  mockTopology = TOPOLOGY;
}

function reset() {
  mockTopology = null;
  useCaseStore.setState({ selection: null, selectedElement: null });
  useSldStore.setState({ selectedNodeId: null });
}

describe('<AttachedControllersSection />', () => {
  beforeEach(reset);
  afterEach(() => {
    cleanup();
    reset();
  });

  it('lists only the controllers bound to the selected machine by syn', () => {
    selectGenerator('GENROU_1');
    render(<AttachedControllersSection />);
    expect(screen.getByTestId('attached-controllers-list')).toBeInTheDocument();
    expect(screen.getByTestId('attached-controller-row-EXST1_1')).toBeInTheDocument();
    expect(screen.getByTestId('attached-controller-row-IEEEG1_1')).toBeInTheDocument();
    // The other machine's exciter is excluded.
    expect(screen.queryByTestId('attached-controller-row-EXST1_2')).not.toBeInTheDocument();
  });

  it('switches the inspector + SLD selection to the controller on row click', async () => {
    selectGenerator('GENROU_1');
    render(<AttachedControllersSection />);
    await userEvent.click(screen.getByTestId('attached-controller-row-EXST1_1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'controller',
      subKind: 'exciter',
      modelClass: 'EXST1',
      idx: 'EXST1_1',
    });
    // Node id is namespaced by model class.
    expect(useSldStore.getState().selectedNodeId).toBe('controller-EXST1-EXST1_1');
  });

  it('renders the empty state for a machine with no attached controllers', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      selectedElement: { kind: 'generator', idx: 'GENROU_LONE' },
    });
    mockTopology = TOPOLOGY;
    render(<AttachedControllersSection />);
    expect(screen.getByText(/no dynamic controllers attached/i)).toBeInTheDocument();
    expect(screen.getByText(/pair this case with a \.dyr file/i)).toBeInTheDocument();
    expect(screen.queryByTestId('attached-controllers-list')).not.toBeInTheDocument();
  });

  it('renders nothing when the selection is not a generator', () => {
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
      selectedElement: { kind: 'bus', idx: '1' },
    });
    mockTopology = TOPOLOGY;
    const { container } = render(<AttachedControllersSection />);
    expect(container.firstChild).toBeNull();
  });
});
