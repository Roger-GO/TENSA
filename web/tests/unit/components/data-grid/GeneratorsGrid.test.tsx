/**
 * Tests for ``<GeneratorsGrid />`` (v3 Unit 13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithQuery as render } from '../../helpers/gridQuery';
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

import { GeneratorsGrid } from '@/components/data-grid/GeneratorsGrid';
import { findTopologyEntry } from '@/lib/topology';

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

/**
 * A kundur-like case: static generators PV 2 and Slack 1, and a machine
 * GENROU_2 that names PV 2 in `gen` (its own idx is not a PF row key).
 */
const MACHINE_TOPOLOGY: TopologySummary = {
  state: 'committed',
  buses: [],
  lines: [],
  transformers: [],
  generators: [
    { idx: '2', name: '2', kind: 'PV', params: { bus: 2, p0: 7, v0: 1.01 } },
    { idx: '1', name: '1', kind: 'Slack', params: { bus: 1, p0: 7.459, v0: 1.03 } },
    { idx: 'GENROU_2', name: 'GENROU_2', kind: 'GENROU', params: { bus: 2, gen: 2 } },
    { idx: 'GENROU_1', name: 'GENROU_1', kind: 'GENROU', params: { bus: 1, gen: 1 } },
  ],
  loads: [],
};

function pfWithGenerators(): PflowResult {
  return {
    run_id: parseRunId('run-1'),
    converged: true,
    iterations: 4,
    mismatch: 1e-6,
    bus_voltages: {},
    bus_angles: {},
    line_flows: {},
    generator_outputs: {
      '2': { p: 700, q: 185.25, v: 1.01, bus: 2 },
      '1': { p: 745.9, q: -12.5, v: 1.03, bus: 1 },
    },
  } as unknown as PflowResult;
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

/** The text of the named columns of a row, found by column key so a new column shifts nothing. */
function cellTexts(rowId: string, ...keys: string[]): (string | null)[] {
  return keys.map((key) => screen.getByTestId(`generators-grid-cell-${rowId}-${key}`).textContent);
}

describe('<GeneratorsGrid />', () => {
  it('renders rows with kind-namespaced rowIds (avoids dup keys when PV+GENROU share idx)', () => {
    mockTopology = TOPOLOGY;
    render(<GeneratorsGrid />);
    // GENROU generator at idx=0 → "genrou-0"; PV at idx=1 → "pv-1".
    expect(screen.getByTestId('generators-grid-row-genrou-0')).toBeInTheDocument();
    expect(screen.getByTestId('generators-grid-row-pv-1')).toBeInTheDocument();
  });

  it('row click sets selectedElement to {kind:"generator", idx} + canvas-aligned selectedNodeId', async () => {
    const user = userEvent.setup();
    mockTopology = TOPOLOGY;
    render(<GeneratorsGrid />);
    await user.click(screen.getByTestId('generators-grid-row-pv-1'));
    expect(useCaseStore.getState().selectedElement).toEqual({
      kind: 'generator',
      idx: '1',
      modelClass: 'PV',
    });
    // Canvas node id stays kind-agnostic so SLD highlight follows.
    expect(useSldStore.getState().selectedNodeId).toBe('generator-1');
  });

  it('names the model of the row, so a machine that shares its idx with a static generator is the one inspected', async () => {
    const user = userEvent.setup();
    mockTopology = {
      ...TOPOLOGY,
      generators: [
        { idx: '1', name: 'Slack_1', kind: 'Slack', params: { bus: 1 } },
        { idx: '1', name: 'GENROU_1', kind: 'GENROU', params: { bus: 1, gen: 1 } },
      ],
    };
    render(<GeneratorsGrid />);
    await user.click(screen.getByTestId('generators-grid-row-genrou-1'));
    const selected = useCaseStore.getState().selectedElement;
    expect(selected).toEqual({ kind: 'generator', idx: '1', modelClass: 'GENROU' });
    expect(selected && findTopologyEntry(mockTopology, selected)?.name).toBe('GENROU_1');
    await user.click(screen.getByTestId('generators-grid-row-slack-1'));
    const slack = useCaseStore.getState().selectedElement;
    expect(slack && findTopologyEntry(mockTopology, slack)?.name).toBe('Slack_1');
  });

  it('shows no output before power flow has run', () => {
    mockTopology = MACHINE_TOPOLOGY;
    render(<GeneratorsGrid />);
    for (const id of ['pv-2', 'slack-1', 'genrou-GENROU_2', 'genrou-GENROU_1']) {
      expect(cellTexts(id, 'p', 'q')).toEqual(['—', '—']);
    }
  });

  it('fills P and Q from the PF result, in MW and MVAr, for static generators and machines alike', () => {
    mockTopology = MACHINE_TOPOLOGY;
    usePflowStore.setState({ lastRun: pfWithGenerators(), isRunning: false, error: null });
    render(<GeneratorsGrid />);
    const pq = (id: string) => cellTexts(id, 'p', 'q');
    expect(pq('pv-2')).toEqual(['700.000', '185.250']);
    expect(pq('slack-1')).toEqual(['745.900', '-12.500']);
    // A machine has no PF row of its own: it shows the one of the generator it names.
    expect(pq('genrou-GENROU_2')).toEqual(['700.000', '185.250']);
    expect(pq('genrou-GENROU_1')).toEqual(['745.900', '-12.500']);
  });

  it('does not print the per-unit setpoint of the case as MW', () => {
    mockTopology = MACHINE_TOPOLOGY;
    render(<GeneratorsGrid />);
    expect(screen.getByTestId('generators-grid-row-pv-2').textContent).not.toContain('7.000');
  });

  it('leaves P and Q empty when the power flow did not converge', () => {
    mockTopology = MACHINE_TOPOLOGY;
    usePflowStore.setState({
      lastRun: { ...pfWithGenerators(), converged: false } as PflowResult,
      isRunning: false,
      error: null,
    });
    render(<GeneratorsGrid />);
    expect(cellTexts('pv-2', 'p', 'q')).toEqual(['—', '—']);
  });

  it('leaves a generator the PF result has no row for empty', () => {
    mockTopology = MACHINE_TOPOLOGY;
    const pf = pfWithGenerators();
    delete (pf.generator_outputs as Record<string, unknown>)['2'];
    usePflowStore.setState({ lastRun: pf, isRunning: false, error: null });
    render(<GeneratorsGrid />);
    expect(cellTexts('pv-2', 'p')).toEqual(['—']);
    expect(cellTexts('slack-1', 'p')).toEqual(['745.900']);
  });

  it('explains on the P and Q headings where the figures come from', () => {
    mockTopology = MACHINE_TOPOLOGY;
    render(<GeneratorsGrid />);
    expect(screen.getByTestId('generators-grid-header-p')).toHaveAttribute(
      'title',
      expect.stringContaining('power flow'),
    );
    expect(screen.getByTestId('generators-grid-header-q')).toHaveAttribute(
      'title',
      expect.stringContaining('power flow'),
    );
  });
});

describe('<GeneratorsGrid /> reactive limits', () => {
  function withLimits(): PflowResult {
    return {
      ...pfWithGenerators(),
      generator_outputs: {
        '2': { p: 700, q: 185.25, v: 1.01, bus: 2, q_min: -50, q_max: 150 },
        '1': { p: 745.9, q: -12.5, v: 1.03, bus: 1, q_min: -50, q_max: 150 },
      },
    } as unknown as PflowResult;
  }
  const limitCells = (id: string) => cellTexts(id, 'q_min', 'q_max', 'q_check');

  it('shows the limits and where Q stands against them', () => {
    mockTopology = MACHINE_TOPOLOGY;
    usePflowStore.setState({ lastRun: withLimits(), isRunning: false, error: null });
    render(<GeneratorsGrid />);
    expect(limitCells('pv-2')).toEqual(['-50.000', '150.000', 'Above Qmax']);
    expect(limitCells('slack-1')).toEqual(['-50.000', '150.000', 'Within limits']);
    // A machine reads the row of the generator it names.
    expect(limitCells('genrou-GENROU_2')).toEqual(['-50.000', '150.000', 'Above Qmax']);
  });

  it('leaves the limits empty before a power flow, and for a generator with none', () => {
    mockTopology = MACHINE_TOPOLOGY;
    const { unmount } = render(<GeneratorsGrid />);
    expect(limitCells('pv-2')).toEqual(['—', '—', '—']);
    unmount();
    const pf = withLimits();
    pf.generator_outputs = {
      ...pf.generator_outputs,
      '2': { p: 0, q: 0, v: 1.0, bus: 2, q_min: null, q_max: null },
    };
    usePflowStore.setState({ lastRun: pf, isRunning: false, error: null });
    render(<GeneratorsGrid />);
    expect(limitCells('pv-2')).toEqual(['—', '—', '—']);
    expect(limitCells('slack-1')[2]).toBe('Within limits');
  });
});
