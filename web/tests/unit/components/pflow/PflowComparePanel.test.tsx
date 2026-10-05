/**
 * Tests for `<PflowComparePanel />`: two kept power flows side by side, which
 * two they are, and what the table shows of their difference.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PflowComparePanel } from '@/components/pflow/PflowComparePanel';
import { parseRunId } from '@/api/types';
import type { PflowResult } from '@/api/types';
import type { ElementNames } from '@/lib/elementNames';
import { useCaseStore } from '@/store/case';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import {
  captureDownloads,
  exportAs,
  readBlob,
  type DownloadCapture,
} from '../../helpers/downloads';
import { lineFlow } from '../../helpers/lineFlow';

const NAMES: ElementNames = {
  buses: { '1': 'North', '2': 'South', '3': 'East' },
  lines: { L1: 'North-South' },
  generators: { G1: 'Hydro' },
  loads: { D1: 'Town' },
};

function result(id: string, overrides: Partial<PflowResult> = {}): PflowResult {
  return {
    run_id: parseRunId(id),
    converged: true,
    iterations: 3,
    mismatch: 1e-9,
    bus_voltages: { '1': 1.0, '2': 0.98, '3': 0.97 },
    bus_angles: { '1': 0, '2': -0.02, '3': -0.05 },
    line_flows: { L1: lineFlow(60, 10, { from: 1, to: 2 }, { p_to: -59, q_to: -9, loss: 1 }) },
    generator_outputs: { G1: { p: 100, q: 20, v: 1.0, bus: 1 } },
    load_consumption: { D1: { p: 98, q: 25, bus: 3 } },
    summary: {
      generation_p: 100,
      generation_q: 20,
      load_p: 98,
      load_q: 25,
      shunt_p: 0,
      shunt_q: 0,
      loss_p: 2,
      loss_q: -5,
      slack_p: 100,
      slack_q: 20,
    },
    ...overrides,
  };
}

function record(id: string, overrides: Partial<PflowResult> = {}, caseName = 'ieee14'): void {
  usePflowHistoryStore.getState().record(result(id, overrides), { caseName, names: NAMES });
}

/** The base case, then the same case with the voltage at South down and more on the line. */
function recordPair(): void {
  record('pf-1');
  record('pf-2', {
    bus_voltages: { '1': 1.0, '2': 0.95, '3': 0.969 },
    line_flows: { L1: lineFlow(72, 10, { from: 1, to: 2 }, { p_to: -70.5, q_to: -9, loss: 1.5 }) },
  });
}

function rowCells(rowId: string): string[] {
  const row = screen.getByTestId(`pflow-compare-grid-row-${rowId}`);
  return within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent ?? '');
}

function rowOrder(): string[] {
  return screen
    .getAllByTestId(/^pflow-compare-grid-row-/)
    .map((row) => row.getAttribute('data-testid')!.replace('pflow-compare-grid-row-', ''));
}

let downloads: DownloadCapture;

beforeEach(() => {
  usePflowHistoryStore.getState().clear();
  useCaseStore.setState({ selection: null });
  downloads = captureDownloads();
});

afterEach(() => {
  cleanup();
  downloads.restore();
  usePflowHistoryStore.getState().clear();
});

describe('<PflowComparePanel />', () => {
  it('says what to do before any power flow has converged', () => {
    render(<PflowComparePanel />);
    expect(screen.getByTestId('pflow-compare-empty')).toHaveTextContent(
      /No power flow has converged yet/,
    );
    expect(screen.queryByTestId('pflow-compare-grid')).not.toBeInTheDocument();
  });

  it('names the one result kept, and asks for a second', () => {
    record('pf-1', {}, 'kundur_full');
    render(<PflowComparePanel />);
    const empty = screen.getByTestId('pflow-compare-empty');
    expect(empty).toHaveTextContent('One power flow is kept so far (PF #1 · kundur_full');
    expect(empty).toHaveTextContent(/run a power flow again/);
  });

  it('compares the latest result (B) with the one before it (A)', () => {
    recordPair();
    render(<PflowComparePanel />);
    expect(screen.getByTestId('pflow-compare-select-a')).toHaveValue('pf-1');
    expect(screen.getByTestId('pflow-compare-select-b')).toHaveValue('pf-2');
    expect(screen.getByTestId('pflow-compare-headline')).toHaveTextContent(
      'Largest change: ΔV -0.0300 pu at South (2); ΔP +12.00 MW at North-South (L1).',
    );
  });

  it('lists the buses with both voltages and their difference, the largest change first', () => {
    recordPair();
    render(<PflowComparePanel />);
    expect(screen.getByRole('table', { name: 'Buses: B compared with A' })).toBeInTheDocument();
    expect(rowOrder()).toEqual(['2', '3', '1']);
    // idx, name, V A, V B, ΔV, θ A, θ B, Δθ
    expect(rowCells('2')).toEqual([
      '2',
      'South',
      '0.9800',
      '0.9500',
      '-0.03000',
      '-1.146',
      '-1.146',
      '0.0000',
    ]);
  });

  it('switches to the lines, the generators, the loads and the totals', async () => {
    const user = userEvent.setup();
    recordPair();
    render(<PflowComparePanel />);

    await user.click(screen.getByTestId('pflow-compare-table-lines'));
    expect(screen.getByRole('table', { name: 'Lines: B compared with A' })).toBeInTheDocument();
    const line = rowCells('L1');
    // idx, name, from, to, P A, P B, ΔP, ...
    expect(line.slice(0, 7)).toEqual(['L1', 'North-South', '1', '2', '60.00', '72.00', '+12.000']);
    // ... Δloss, then the loading, which a line with no rating does not have.
    expect(line.slice(12)).toEqual(['+0.5000', '—', '—', '—']);

    await user.click(screen.getByTestId('pflow-compare-table-generators'));
    expect(rowCells('G1').slice(0, 6)).toEqual(['G1', 'Hydro', '1', '100.00', '100.00', '0.000']);

    await user.click(screen.getByTestId('pflow-compare-table-loads'));
    expect(rowCells('D1').slice(0, 3)).toEqual(['D1', 'Town', '3']);

    await user.click(screen.getByTestId('pflow-compare-table-totals'));
    expect(rowCells('generation')[0]).toBe('Generation');
    expect(screen.getByTestId('pflow-compare-table-totals')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows how many rows each table has on its button', () => {
    recordPair();
    render(<PflowComparePanel />);
    expect(screen.getByTestId('pflow-compare-table-buses')).toHaveTextContent('Buses 3');
    expect(screen.getByTestId('pflow-compare-table-lines')).toHaveTextContent('Lines 1');
  });

  it('lets another result be picked as the reference, and does not offer B for it', async () => {
    const user = userEvent.setup();
    recordPair();
    record('pf-3', { bus_voltages: { '1': 1.0, '2': 0.99, '3': 0.97 } });
    render(<PflowComparePanel />);

    const selectA = screen.getByTestId('pflow-compare-select-a');
    expect(selectA).toHaveValue('pf-2');
    expect(within(selectA).getByRole('option', { name: /^PF #3/ })).toBeDisabled();
    expect(within(selectA).getByRole('option', { name: /^PF #1/ })).toBeEnabled();

    await user.selectOptions(selectA, 'pf-1');
    expect(usePflowHistoryStore.getState().baselineId).toBe('pf-1');
    // 0.99 at South against the base case's 0.98.
    expect(rowCells('2')[4]).toBe('+0.01000');
  });

  it('keeps following the latest run as B, with the picked reference', async () => {
    const user = userEvent.setup();
    recordPair();
    render(<PflowComparePanel />);
    await user.selectOptions(screen.getByTestId('pflow-compare-select-a'), 'pf-1');

    act(() => record('pf-3', { bus_voltages: { '1': 1.0, '2': 0.99, '3': 0.97 } }));

    expect(screen.getByTestId('pflow-compare-select-a')).toHaveValue('pf-1');
    expect(screen.getByTestId('pflow-compare-select-b')).toHaveValue('pf-3');
  });

  it('swaps A and B, which turns every difference round', async () => {
    const user = userEvent.setup();
    recordPair();
    render(<PflowComparePanel />);
    await user.click(screen.getByTestId('pflow-compare-swap'));
    expect(screen.getByTestId('pflow-compare-select-a')).toHaveValue('pf-2');
    expect(screen.getByTestId('pflow-compare-select-b')).toHaveValue('pf-1');
    expect(rowCells('2')[4]).toBe('+0.03000');
  });

  it('names a result from its pencil, and the name is what the pickers show', async () => {
    const user = userEvent.setup();
    recordPair();
    render(<PflowComparePanel />);
    await user.click(screen.getByTestId('pflow-compare-rename-a'));
    const input = screen.getByTestId('pflow-compare-name-input-a');
    await user.type(input, 'Base case{Enter}');

    expect(usePflowHistoryStore.getState().snapshots[0]?.name).toBe('Base case');
    const selectA = screen.getByTestId('pflow-compare-select-a');
    expect(
      within(selectA).getByRole('option', { name: /^Base case · ieee14/ }),
    ).toBeInTheDocument();
  });

  it('deletes a result, and goes back to asking for a second when one is left', async () => {
    const user = userEvent.setup();
    recordPair();
    render(<PflowComparePanel />);
    await user.click(screen.getByTestId('pflow-compare-delete-a'));
    expect(usePflowHistoryStore.getState().snapshots.map((s) => s.id)).toEqual(['pf-2']);
    expect(screen.getByTestId('pflow-compare-empty')).toHaveTextContent(
      'One power flow is kept so far (PF #2',
    );
  });

  it('says the two results are the same when nothing moved', () => {
    record('pf-1');
    record('pf-2');
    render(<PflowComparePanel />);
    expect(screen.getByTestId('pflow-compare-headline')).toHaveTextContent(
      'The two results are the same.',
    );
    // Equal changes keep the order of the result.
    expect(rowOrder()).toEqual(['1', '2', '3']);
  });

  it('marks a bus only one of the two results has', () => {
    record('pf-1');
    record('pf-2', {
      bus_voltages: { '1': 1.0, '2': 0.98, '4': 1.01 },
      bus_angles: { '1': 0, '2': -0.02, '4': 0.01 },
    });
    render(<PflowComparePanel />);
    expect(screen.getByTestId('pflow-compare-grid-header-onlyIn')).toBeInTheDocument();
    // idx, name, only in, V A, V B, ΔV
    expect(rowCells('4').slice(0, 6)).toEqual(['4', '4', 'B', '—', '1.0100', '—']);
    expect(rowCells('3').slice(2, 6)).toEqual(['A', '0.9700', '—', '—']);
    expect(screen.getByTestId('pflow-compare-headline')).toHaveTextContent(
      '2 elements are in one of the two results only.',
    );
  });

  it('exports the table on screen as CSV, at full precision', async () => {
    const user = userEvent.setup();
    recordPair();
    render(<PflowComparePanel />);
    await exportAs(user, 'csv');
    expect(downloads.filenames[0]).toMatch(/^case_pf-compare-buses_.*\.csv$/);
    const csv = await readBlob(downloads.blobs[0]!);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('idx,name,V A (pu),V B (pu),ΔV (pu),θ A (deg),θ B (deg),Δθ (deg)');
    expect(lines[1]?.split(',').slice(0, 4)).toEqual(['2', 'South', '0.98', '0.95']);
    expect(Number(lines[1]?.split(',')[4])).toBeCloseTo(-0.03, 12);
  });
});
