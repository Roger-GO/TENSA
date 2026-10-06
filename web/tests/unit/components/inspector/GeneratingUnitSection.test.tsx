/**
 * Tests for `<GeneratingUnitSection />`.
 *
 * Under a selected generator, machine or controller, the section lists the
 * generating unit the selection belongs to: every model, each under the one
 * it refers to, with the one the Inspector shows marked. A row switches the
 * Inspector (and the diagram's highlight) to that model. A generator with no
 * dynamic models gets a line that says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCaseStore } from '@/store/case';
import type { SelectedElement } from '@/store/case';
import { useSldStore } from '@/store/sld';
import { parseWorkspacePath } from '@/api/types';
import type { TopologySummary } from '@/api/types';

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

import { GeneratingUnitSection } from '@/components/inspector/GeneratingUnitSection';

/** ieee14_full's shape for one unit, a second machine with an exciter, and a lone generator. */
const TOPOLOGY: TopologySummary = {
  state: 'pre-setup',
  buses: [
    { idx: 1, name: 'Bus1', kind: 'Bus', params: {} },
    { idx: 2, name: 'Bus2', kind: 'Bus', params: {} },
  ],
  lines: [],
  transformers: [],
  generators: [
    { idx: 2, name: '2', kind: 'PV', params: { bus: 1 } },
    { idx: 3, name: '3', kind: 'PV', params: { bus: 2 } },
    { idx: 'GENROU_1', name: 'Gen1', kind: 'GENROU', params: { bus: 1, gen: 2 } },
    { idx: 'GENROU_2', name: 'Gen2', kind: 'GENROU', params: { bus: 2 } },
  ],
  loads: [],
  controllers: [
    { idx: 'EXST1_1', name: 'EXST1 1', kind: 'EXST1', params: { syn: 'GENROU_1' } },
    { idx: 'IEEEG1_1', name: 'IEEEG1 1', kind: 'IEEEG1', params: { syn: 'GENROU_1' } },
    { idx: 'IEEEST_1', name: 'IEEEST 1', kind: 'IEEEST', params: { avr: 'EXST1_1' } },
    // A controller on a different machine: it is of another unit.
    { idx: 'EXST1_2', name: 'EXST1 2', kind: 'EXST1', params: { syn: 'GENROU_2' } },
    // A controller of a bus: it is of no unit.
    { idx: 'PMU_1', name: 'PMU 1', kind: 'PMU', params: { bus: 1 } },
  ],
};

function select(selectedElement: SelectedElement) {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14_full.xlsx'), addfiles: [] },
    selectedElement,
  });
  mockTopology = TOPOLOGY;
}

function reset() {
  mockTopology = null;
  useCaseStore.setState({ selection: null, selectedElement: null });
  useSldStore.setState({ selectedNodeId: null });
}

/** The rows of the list as `depth role-and-model`, in order. */
function rows(): string[] {
  return within(screen.getByTestId('generating-unit-list'))
    .getAllByRole('button')
    .map((row) => row.getAttribute('aria-label') ?? '');
}

describe('<GeneratingUnitSection />', () => {
  beforeEach(reset);
  afterEach(() => {
    cleanup();
    reset();
  });

  it('lists every model of the unit of the selected generator, and none of another unit', () => {
    select({ kind: 'generator', idx: '2', modelClass: 'PV' });
    render(<GeneratingUnitSection />);
    expect(screen.getByRole('region', { name: 'Generating unit' })).toBeInTheDocument();
    // The generator, the machine that names it, the machine's exciter with
    // its stabiliser, and its governor.
    expect(rows()).toEqual([
      'Generator: PV 2',
      'Machine: GENROU GENROU_1',
      'Exciter: EXST1 EXST1_1',
      'PSS: IEEEST IEEEST_1',
      'Governor: IEEEG1 IEEEG1_1',
    ]);
    // The other machine's exciter is excluded.
    expect(screen.queryByTestId('generating-unit-row-EXST1-EXST1_2')).not.toBeInTheDocument();
  });

  it('marks the model the Inspector shows, which is not a row to press', () => {
    select({ kind: 'generator', idx: '2', modelClass: 'PV' });
    render(<GeneratingUnitSection />);
    const own = screen.getByTestId('generating-unit-row-PV-2');
    expect(own).toHaveAttribute('aria-current', 'true');
    expect(own).toBeDisabled();
    const machine = screen.getByTestId('generating-unit-row-GENROU-GENROU_1');
    expect(machine).not.toHaveAttribute('aria-current');
    expect(machine).toBeEnabled();
  });

  it('sets each model in under the one it refers to', () => {
    select({ kind: 'generator', idx: '2', modelClass: 'PV' });
    render(<GeneratingUnitSection />);
    const indent = (testId: string) => screen.getByTestId(testId).parentElement?.className ?? '';
    expect(indent('generating-unit-row-PV-2')).toBe('');
    expect(indent('generating-unit-row-GENROU-GENROU_1')).toBe('ml-3');
    expect(indent('generating-unit-row-EXST1-EXST1_1')).toBe('ml-6');
    expect(indent('generating-unit-row-IEEEST-IEEEST_1')).toBe('ml-9');
    expect(indent('generating-unit-row-IEEEG1-IEEEG1_1')).toBe('ml-6');
  });

  it('switches the inspector + SLD selection to the controller on row click', async () => {
    select({ kind: 'generator', idx: '2', modelClass: 'PV' });
    render(<GeneratingUnitSection />);
    await userEvent.click(screen.getByTestId('generating-unit-row-EXST1-EXST1_1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'controller',
      subKind: 'exciter',
      modelClass: 'EXST1',
      idx: 'EXST1_1',
    });
    // Node id is namespaced by model class.
    expect(useSldStore.getState().selectedNodeId).toBe('controller-EXST1-EXST1_1');
  });

  it('goes from the generator to its machine, by the machine’s own idx and model', async () => {
    select({ kind: 'generator', idx: '2', modelClass: 'PV' });
    render(<GeneratingUnitSection />);
    await userEvent.click(screen.getByTestId('generating-unit-row-GENROU-GENROU_1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: 'GENROU_1',
      modelClass: 'GENROU',
    });
    expect(useSldStore.getState().selectedNodeId).toBe('generator-GENROU_1');
  });

  it('lists the same unit under one of its controllers, with the way back to the generator', async () => {
    select({ kind: 'controller', subKind: 'pss', modelClass: 'IEEEST', idx: 'IEEEST_1' });
    render(<GeneratingUnitSection />);
    expect(rows()).toHaveLength(5);
    expect(screen.getByTestId('generating-unit-row-IEEEST-IEEEST_1')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await userEvent.click(screen.getByTestId('generating-unit-row-PV-2'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: '2',
      modelClass: 'PV',
    });
  });

  it('lists the unit of a machine that names no generator', () => {
    select({ kind: 'generator', idx: 'GENROU_2' });
    render(<GeneratingUnitSection />);
    expect(rows()).toEqual(['Machine: GENROU GENROU_2', 'Exciter: EXST1 EXST1_2']);
    expect(screen.getByTestId('generating-unit-row-GENROU-GENROU_2')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('says so for a generator that has no dynamic models', () => {
    select({ kind: 'generator', idx: '3', modelClass: 'PV' });
    render(<GeneratingUnitSection />);
    expect(screen.getByText(/no dynamic models attached/i)).toBeInTheDocument();
    expect(screen.getByText(/pair this case with a \.dyr file/i)).toBeInTheDocument();
    expect(screen.queryByTestId('generating-unit-list')).not.toBeInTheDocument();
  });

  it('renders nothing for a controller that belongs to no unit', () => {
    select({ kind: 'controller', subKind: 'measurement', modelClass: 'PMU', idx: 'PMU_1' });
    const { container } = render(<GeneratingUnitSection />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the selection is not a generator or a controller', () => {
    select({ kind: 'bus', idx: '1' });
    const { container } = render(<GeneratingUnitSection />);
    expect(container.firstChild).toBeNull();
  });
});
