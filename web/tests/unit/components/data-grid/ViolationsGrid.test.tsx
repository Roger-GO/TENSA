/**
 * Tests for ``<ViolationsGrid />``: the table of every limit the last
 * converged power flow breaks or runs up to (bus voltage, line loading,
 * generator reactive power).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useCaseStore } from '@/store/case';
import { usePflowStore } from '@/store/pflow';
import { useSldStore } from '@/store/sld';
import { useUnitsStore } from '@/store/units';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import type { PflowResult, TopologySummary } from '@/api/types';
import { LIMITS_TOPOLOGY, limitsPflow } from '../../helpers/limitsCase';
import { lineFlow } from '../../helpers/lineFlow';

let mockTopology: TopologySummary | null = null;
vi.mock('@/api/queries', async () => {
  const actual = await vi.importActual<typeof import('@/api/queries')>('@/api/queries');
  return { ...actual, useCurrentTopology: () => mockTopology };
});

import { ViolationsGrid } from '@/components/data-grid/ViolationsGrid';

function rowCells(rowId: string): (string | null)[] {
  return [
    ...screen.getByTestId(`violations-grid-row-${rowId}`).querySelectorAll('[role=cell]'),
  ].map((c) => c.textContent);
}

// The totals a converged power flow comes with, which is how it is told from
// the operating point read back after a time-domain run.
const SUMMARY = {
  generation_p: 50,
  generation_q: 45,
  load_p: 48,
  load_q: 40,
  shunt_p: 0,
  shunt_q: 0,
  loss_p: 2,
  loss_q: 5,
};

/** A power flow solved on the open case, as the pflow slice holds one. */
function solve(result: PflowResult): void {
  usePflowStore.setState({ lastRun: result, lastSolved: result });
}

beforeEach(() => {
  mockTopology = null;
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    selectedElement: null,
  });
  usePflowStore.setState({ lastRun: null, lastSolved: null, isRunning: false, error: null });
  useSldStore.setState({ selectedNodeId: null });
  useUnitsStore.setState({ mode: 'pu' });
});

afterEach(() => {
  cleanup();
  mockTopology = null;
  useUnitsStore.setState({ mode: 'pu' });
});

describe('<ViolationsGrid />', () => {
  it('asks for a case before one is loaded', () => {
    render(<ViolationsGrid />);
    expect(screen.getByTestId('violations-grid-empty')).toHaveTextContent(
      'Load a case to check its limits.',
    );
  });

  it('asks for a power flow before one has converged', () => {
    mockTopology = LIMITS_TOPOLOGY;
    render(<ViolationsGrid />);
    expect(screen.getByTestId('violations-grid-empty')).toHaveTextContent('Run a power flow');
    cleanup();
    solve(limitsPflow({ converged: false }));
    render(<ViolationsGrid />);
    expect(screen.getByTestId('violations-grid-empty')).toHaveTextContent('Run a power flow');
  });

  it('says what was checked when every limit holds, and how many lines it could not check', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(
      limitsPflow({
        bus_voltages: { '1': 1.0, '2': 1.0, '3': 1.0 },
        line_flows: {
          L1: lineFlow(10, 1, undefined, { rate_a: 100, loading_pct: 10 }),
          L3: lineFlow(5, 1),
        },
        generator_outputs: { '1': { p: 40, q: 5, v: 1, bus: 1, q_min: -40, q_max: 15 } },
      }),
    );
    render(<ViolationsGrid />);
    const empty = screen.getByTestId('violations-grid-empty');
    expect(empty).toHaveTextContent('No limit is violated.');
    expect(empty).toHaveTextContent('Checked 3 buses, 1 rated line, 1 generator.');
    expect(empty).toHaveTextContent(
      '1 line has no rating (rate_a) and is not checked for overload.',
    );
    // ...and how to bring a line into the check.
    expect(empty).toHaveTextContent("Set a line's rate_a in the Inspector to check it.");
  });

  // The operating point read back after a time-domain run: converged, with the
  // bus voltages and nothing else (``GET /operating-point``).
  const operatingPoint: PflowResult = {
    run_id: parseRunId('run-op'),
    converged: true,
    iterations: 0,
    mismatch: 0,
    bus_voltages: { '1': 1.0, '2': 1.0, '3': 1.0 },
    bus_angles: { '1': 0, '2': 0, '3': 0 },
  };

  it('keeps the power flow report after a time-domain run, and says it is the power flow', () => {
    mockTopology = LIMITS_TOPOLOGY;
    usePflowStore.getState().setLastRun(limitsPflow({ summary: SUMMARY }));
    // What the run's end does: the tables read the operating point from here on.
    usePflowStore.getState().setLastRun(operatingPoint);
    render(<ViolationsGrid />);
    expect(screen.getByTestId('violations-grid-row-line-L1')).toBeInTheDocument();
    expect(screen.getByTestId('violations-grid-row-generator-1')).toBeInTheDocument();
    const hint = screen.getByTestId('violations-grid-hint');
    expect(hint).toHaveTextContent('Checked 3 buses, 3 rated lines, 2 generators.');
    expect(hint).toHaveTextContent(
      'This is the power flow the time-domain run started from. The run itself is not checked against the limits.',
    );
  });

  it('does not call a time-domain run with no power flow an all-clear', () => {
    mockTopology = LIMITS_TOPOLOGY;
    usePflowStore.getState().setLastRun(operatingPoint);
    render(<ViolationsGrid />);
    const empty = screen.getByTestId('violations-grid-empty');
    expect(empty).not.toHaveTextContent('No limit is violated');
    expect(empty).toHaveTextContent('A time-domain run is not checked against the limits.');
    expect(empty).toHaveTextContent('Reset the run and run a power flow');
  });

  it('says nothing of a run while the power flow is the latest result', () => {
    mockTopology = LIMITS_TOPOLOGY;
    usePflowStore.getState().setLastRun(limitsPflow({ summary: SUMMARY }));
    render(<ViolationsGrid />);
    expect(screen.getByTestId('violations-grid-hint')).not.toHaveTextContent('time-domain run');
  });

  it('lists the violations before the warnings, one row per element', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    render(<ViolationsGrid />);
    const rows = screen
      .getAllByRole('row')
      .map((r) => r.getAttribute('data-testid'))
      .filter((id): id is string => id !== null && id.startsWith('violations-grid-row-'));
    expect(rows.map((id) => id.replace('violations-grid-row-', ''))).toEqual([
      'bus-1',
      'transformer-T1',
      'line-L1',
      'generator-1',
      'bus-2',
      'line-L2',
      'generator-2',
    ]);
  });

  it('describes each finding: severity, type, element, what is wrong, the value and the limit', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    render(<ViolationsGrid />);
    // severity, type, name, idx, finding, value, limit, unit
    expect(rowCells('bus-1')).toEqual([
      'Violation',
      'Bus voltage',
      'Bus1',
      '1',
      'Above vmax',
      '1.070',
      '1.050',
      'pu',
    ]);
    expect(rowCells('bus-2')).toEqual([
      'Warning',
      'Bus voltage',
      'Bus2',
      '2',
      'Near vmin',
      '0.915',
      '0.900',
      'pu',
    ]);
    expect(rowCells('line-L1')).toEqual([
      'Violation',
      'Line loading',
      'Line1-2',
      'L1',
      'Over rating',
      '112.400',
      '100.000',
      '%',
    ]);
    expect(rowCells('generator-1')).toEqual([
      'Violation',
      'Generator Q',
      'PV_1',
      '1',
      'Above Qmax',
      '30.000',
      '15.000',
      'MVAr',
    ]);
    expect(rowCells('generator-2')[4]).toBe('At Qmax');
  });

  it('reads a bus voltage in kV under the actual-units display, and leaves the rest alone', () => {
    mockTopology = LIMITS_TOPOLOGY;
    useUnitsStore.setState({ mode: 'actual' });
    solve(limitsPflow());
    render(<ViolationsGrid />);
    // 1.07 pu and its 1.05 pu limit on a 110 kV bus.
    expect(rowCells('bus-1').slice(5)).toEqual(['117.700', '115.500', 'kV']);
    expect(rowCells('line-L1').slice(5)).toEqual(['112.400', '100.000', '%']);
    expect(rowCells('generator-1').slice(5)).toEqual(['30.000', '15.000', 'MVAr']);
  });

  it('keeps a bus whose rated voltage the case does not give in per unit', () => {
    mockTopology = { ...LIMITS_TOPOLOGY, buses_without_vn: [1] };
    useUnitsStore.setState({ mode: 'actual' });
    solve(limitsPflow());
    render(<ViolationsGrid />);
    expect(rowCells('bus-1').slice(5)).toEqual(['1.070', '1.050', 'pu']);
  });

  it('summarises the findings above the table', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    render(<ViolationsGrid />);
    const hint = screen.getByTestId('violations-grid-hint');
    expect(hint).toHaveTextContent('4 violations and 3 warnings.');
    expect(hint).toHaveTextContent('Checked 3 buses, 3 rated lines, 2 generators.');
  });

  it('selects a bus the way its own table does: the diagram node and the inspector', async () => {
    const user = userEvent.setup();
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    render(<ViolationsGrid />);
    await user.click(screen.getByTestId('violations-grid-row-bus-1'));
    expect(useSldStore.getState().selectedNodeId).toBe('1');
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'bus', idx: '1' });
  });

  it('selects a line, a transformer and a generator by their own kind', async () => {
    const user = userEvent.setup();
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    render(<ViolationsGrid />);

    await user.click(screen.getByTestId('violations-grid-row-line-L1'));
    expect(useSldStore.getState().selectedNodeId).toBe('line-L1');
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'line', idx: 'L1' });

    await user.click(screen.getByTestId('violations-grid-row-transformer-T1'));
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'transformer', idx: 'T1' });

    // PV 1 is named by the machine GENROU_1: the two are one symbol on the
    // diagram, under the idx of the generator.
    await user.click(screen.getByTestId('violations-grid-row-generator-1'));
    expect(useSldStore.getState().selectedNodeId).toBe('generator-1');
    expect(useCaseStore.getState().selectedElement).toEqual({ kind: 'generator', idx: '1' });
  });

  it('highlights the row of a generator whose symbol is selected on the diagram', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    // What a click on the symbol of the unit of PV 1 and GENROU_1 writes.
    useSldStore.setState({ selectedNodeId: 'generator-1' });
    render(<ViolationsGrid />);
    expect(screen.getByTestId('violations-grid-row-generator-1')).toHaveAttribute(
      'data-selected',
      'true',
    );
  });

  it('highlights the row of the element selected on the diagram', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    useSldStore.setState({ selectedNodeId: 'line-L1' });
    render(<ViolationsGrid />);
    expect(screen.getByTestId('violations-grid-row-line-L1')).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(screen.getByTestId('violations-grid-row-bus-1')).toHaveAttribute(
      'data-selected',
      'false',
    );
  });

  it('offers the table as a CSV export', () => {
    mockTopology = LIMITS_TOPOLOGY;
    solve(limitsPflow());
    render(<ViolationsGrid />);
    expect(screen.getByRole('button', { name: /export/i })).toBeEnabled();
  });
});
