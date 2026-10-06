/**
 * Tests for ``<PlotsAccordion />`` (v3 Unit 9).
 *
 * Exercises the three-tier data-source cascade per the F-FEAS-6 plan:
 *   1. Active TDS run + matching column → InlineSparkline.
 *   2. PF result fallback → static badge.
 *   3. Neither → EmptyState.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { useCaseStore } from '@/store/case';
import { useRunsStore } from '@/store/runs';
import { usePflowStore } from '@/store/pflow';
import { useUnitsStore } from '@/store/units';
import type { UnitBases } from '@/lib/units';
import { parseRunId, parseWorkspacePath } from '@/api/types';
import { PlotsAccordion } from '@/components/inspector/PlotsAccordion';

function seedLoadedCase() {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
    layoutSidecar: null,
    selectedElement: null,
  });
}

/**
 * Push a synthetic run record directly into the store so we don't need
 * the WS-driven append path. The runs store reads ``runs[id].columns``
 * and ``seqCount`` directly.
 */
function seedRunWithColumn(columnName: string, samples: number[]) {
  const runId = 'run-test';
  const t = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) t[i] = i * 0.05;
  const col = new Float64Array(samples);
  useRunsStore.setState({
    runs: {
      [runId]: {
        runId,
        startedAt: Date.now(),
        tf: 1.0,
        tCurrent: t[t.length - 1] ?? 0,
        seqCount: samples.length,
        t,
        columns: { [columnName]: col },
        columnNames: [columnName],
        state: 'streaming',
        connection: 'connected',
        abortedLocally: false,
        errorReason: null,
      },
    },
    activeRunId: runId,
    overlayRunIds: new Set<string>(),
  });
}

/** Seed an active run holding several columns, optionally with the unit bases it was made on. */
function seedRunWithColumns(columns: Record<string, number[]>, bases?: UnitBases) {
  const runId = 'run-multi';
  const names = Object.keys(columns);
  const rows = columns[names[0]!]!.length;
  const t = new Float64Array(rows);
  for (let i = 0; i < rows; i += 1) t[i] = i * 0.1;
  useRunsStore.setState({
    runs: {
      [runId]: {
        runId,
        startedAt: Date.now(),
        tf: 1.0,
        tCurrent: t[rows - 1] ?? 0,
        seqCount: rows,
        t,
        columns: Object.fromEntries(names.map((n) => [n, new Float64Array(columns[n]!)])),
        columnNames: names,
        ...(bases ? { bases } : {}),
        state: 'streaming',
        connection: 'connected',
        abortedLocally: false,
        errorReason: null,
      },
    },
    activeRunId: runId,
    overlayRunIds: new Set<string>(),
  });
}

/** The label and the latest value each sparkline shows. */
function sparklines(): Array<{ label: string; value: string }> {
  return screen.getAllByTestId('inline-sparkline').map((el) => ({
    label: el.querySelector('span')?.textContent ?? '',
    value: el.querySelector('[data-testid="inline-sparkline-value"]')?.textContent ?? '',
  }));
}

describe('<PlotsAccordion />', () => {
  beforeEach(() => {
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
    useUnitsStore.setState({ mode: 'pu' });
  });

  afterEach(() => {
    cleanup();
    useUnitsStore.setState({ mode: 'pu' });
    useCaseStore.setState({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
    });
    usePflowStore.setState({ lastRun: null, isRunning: false, error: null });
    useRunsStore.setState({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() });
  });

  it('shows EmptyState when nothing is selected', () => {
    render(<PlotsAccordion />);
    expect(screen.getByTestId('plots-accordion')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('bus + active TDS run with voltage column → renders sparkline', () => {
    seedLoadedCase();
    seedRunWithColumn('Bus_5_v', [1.0, 1.01, 0.99, 1.02, 1.03]);
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(<PlotsAccordion />);
    expect(screen.getByTestId('inline-sparkline')).toBeInTheDocument();
    expect(screen.getByTestId('inline-sparkline-path')).toBeInTheDocument();
  });

  it('bus + only PF result (no TDS) → static V badge', () => {
    seedLoadedCase();
    usePflowStore.setState({
      lastRun: {
        run_id: parseRunId('pf-1'),
        converged: true,
        iterations: 4,
        mismatch: 1e-6,
        bus_voltages: { '5': 1.024 },
        bus_angles: { '5': -0.087 },
      },
      isRunning: false,
      error: null,
    });
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(<PlotsAccordion />);
    expect(screen.getByTestId('plots-static-badge')).toBeInTheDocument();
    expect(screen.getByText('1.0240')).toBeInTheDocument();
  });

  it('bus + nothing → EmptyState', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
    render(<PlotsAccordion />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('shunt selection → EmptyState (no per-shunt data path)', () => {
    seedLoadedCase();
    useCaseStore.setState({ selectedElement: { kind: 'shunt', idx: 'SH1' } });
    render(<PlotsAccordion />);
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
  });

  it('generator + run with omega/delta columns → two sparklines', () => {
    seedLoadedCase();
    // Two columns must be in the same run record so the per-column
    // subscriptions both succeed against the same active run.
    const runId = 'run-gen';
    const t = new Float64Array([0, 0.1, 0.2, 0.3]);
    const omega = new Float64Array([1.0, 1.001, 0.999, 1.0005]);
    const delta = new Float64Array([0, 0.05, 0.1, 0.07]);
    useRunsStore.setState({
      runs: {
        [runId]: {
          runId,
          startedAt: Date.now(),
          tf: 1.0,
          tCurrent: 0.3,
          seqCount: 4,
          t,
          columns: { Gen_G1_omega: omega, Gen_G1_delta: delta },
          columnNames: ['Gen_G1_omega', 'Gen_G1_delta'],
          state: 'streaming',
          connection: 'connected',
          abortedLocally: false,
          errorReason: null,
        },
      },
      activeRunId: runId,
      overlayRunIds: new Set<string>(),
    });
    useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
    render(<PlotsAccordion />);
    const sparklines = screen.getAllByTestId('inline-sparkline');
    expect(sparklines.length).toBe(2);
  });

  describe('generator PF badge (a machine has no row of its own)', () => {
    function seedMachine(genLink: Record<string, number | string>) {
      seedLoadedCase();
      useCaseStore.setState({
        topology: {
          state: 'committed',
          buses: [{ idx: 1, name: 'b1', kind: 'Bus', params: {} }],
          lines: [],
          transformers: [],
          generators: [
            { idx: 2, name: 'pv', kind: 'PV', params: { bus: 1 } },
            { idx: 'GENROU_2', name: 'm2', kind: 'GENROU', params: { bus: 1, ...genLink } },
          ],
          loads: [],
        },
        selectedElement: { kind: 'generator', idx: 'GENROU_2' },
      });
      usePflowStore.setState({
        lastRun: {
          run_id: parseRunId('pf-1'),
          converged: true,
          iterations: 4,
          mismatch: 1e-6,
          bus_voltages: {},
          bus_angles: {},
          generator_outputs: { '2': { p: 40, q: 30.436, v: 1.03, bus: 1 } },
        },
        isRunning: false,
        error: null,
      });
    }

    it('reads the row of the static generator the machine names in gen', () => {
      seedMachine({ gen: 2 });
      render(<PlotsAccordion />);
      expect(screen.getByTestId('plots-static-badge')).toBeInTheDocument();
      expect(screen.getByText('40.00 MW')).toBeInTheDocument();
      expect(screen.getByText('30.44 MVAr')).toBeInTheDocument();
    });

    it('shows no badge for a machine that names no generator', () => {
      seedMachine({});
      render(<PlotsAccordion />);
      expect(screen.queryByTestId('plots-static-badge')).not.toBeInTheDocument();
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
  });

  describe('a static generator and the machine that takes its place in a run', () => {
    // ieee14_full's shape: PV 2 on bus 1, and GENROU_2 that names it.
    function seedUnit(selectedElement: { kind: 'generator'; idx: string; modelClass?: string }) {
      seedLoadedCase();
      useCaseStore.setState({
        topology: {
          state: 'committed',
          buses: [{ idx: 1, name: 'b1', kind: 'Bus', params: {} }],
          lines: [],
          transformers: [],
          generators: [
            { idx: 2, name: 'pv', kind: 'PV', params: { bus: 1 } },
            { idx: 'GENROU_2', name: 'm2', kind: 'GENROU', params: { bus: 1, gen: 2 } },
          ],
          loads: [],
        },
        selectedElement,
      });
      // A run records the speed and the angle under the idx of the machine.
      seedRunWithColumns({
        Gen_GENROU_2_omega: [1.0, 1.001, 0.999, 1.0005],
        Gen_GENROU_2_delta: [0, 0.05, 0.1, 0.07],
      });
    }

    it('shows the speed and the angle of its machine under the static generator', () => {
      // What a click on the symbol of the unit selects.
      seedUnit({ kind: 'generator', idx: '2', modelClass: 'PV' });
      render(<PlotsAccordion />);
      expect(sparklines().map((s) => s.label)).toEqual(['ω (pu)', 'δ (°)']);
    });

    it('shows them under the machine itself as before', () => {
      seedUnit({ kind: 'generator', idx: 'GENROU_2', modelClass: 'GENROU' });
      render(<PlotsAccordion />);
      expect(sparklines()).toHaveLength(2);
    });

    it('shows nothing of a machine under a static generator that has none', () => {
      seedUnit({ kind: 'generator', idx: '2', modelClass: 'PV' });
      useCaseStore.setState((state) => ({
        topology: {
          ...state.topology!,
          generators: [{ idx: 2, name: 'pv', kind: 'PV', params: { bus: 1 } }],
        },
      }));
      render(<PlotsAccordion />);
      expect(screen.queryByTestId('inline-sparkline')).not.toBeInTheDocument();
    });
  });

  describe('units', () => {
    const GEN = { Gen_G1_omega: [1.0, 1.001, 0.999, 1.0005], Gen_G1_delta: [0, 0.05, 0.1, 0.07] };

    it('reads the rotor angle in degrees and the speed in pu by default', () => {
      seedLoadedCase();
      seedRunWithColumns(GEN, { busKv: {}, freqHz: 60 });
      useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
      render(<PlotsAccordion />);
      expect(sparklines()).toEqual([
        { label: 'ω (pu)', value: '1.0005' },
        // 0.07 rad is 4.01 degrees.
        { label: 'δ (°)', value: '4.01' },
      ]);
    });

    it('reads the speed in Hz of the run system frequency in the actual mode', () => {
      seedLoadedCase();
      useUnitsStore.setState({ mode: 'actual' });
      seedRunWithColumns(GEN, { busKv: {}, freqHz: 50 });
      useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
      render(<PlotsAccordion />);
      expect(sparklines()).toEqual([
        { label: 'f (Hz)', value: '50.025' },
        { label: 'δ (°)', value: '4.01' },
      ]);
    });

    it('keeps the speed in pu in the actual mode for a run that recorded no frequency', () => {
      seedLoadedCase();
      useUnitsStore.setState({ mode: 'actual' });
      seedRunWithColumns(GEN);
      useCaseStore.setState({ selectedElement: { kind: 'generator', idx: 'G1' } });
      render(<PlotsAccordion />);
      expect(sparklines()[0]).toEqual({ label: 'ω (pu)', value: '1.0005' });
    });

    it('reads a bus voltage in kV in the actual mode, with the bases of the run', () => {
      seedLoadedCase();
      useUnitsStore.setState({ mode: 'actual' });
      // The open case says bus 5 is 230 kV; the run was made on a case where it is 100 kV.
      useCaseStore.setState({
        topology: {
          state: 'pre-setup',
          buses: [{ idx: 5, name: 'b5', kind: 'Bus', params: { Vn: 230 } }],
          lines: [],
          transformers: [],
          generators: [],
          loads: [],
        },
        selectedElement: { kind: 'bus', idx: '5' },
      });
      seedRunWithColumns({ Bus_5_v: [1.0, 1.01, 0.99, 1.03] }, { busKv: { '5': 100 }, freqHz: 60 });
      render(<PlotsAccordion />);
      expect(sparklines()).toEqual([{ label: 'Voltage (kV)', value: '103.000' }]);
    });

    it('keeps a bus voltage in pu by default', () => {
      seedLoadedCase();
      seedRunWithColumns({ Bus_5_v: [1.0, 1.01, 0.99, 1.03] }, { busKv: { '5': 100 }, freqHz: 60 });
      useCaseStore.setState({ selectedElement: { kind: 'bus', idx: '5' } });
      render(<PlotsAccordion />);
      expect(sparklines()).toEqual([{ label: 'Voltage (pu)', value: '1.0300' }]);
    });

    it('reads the PF voltage badge in kV with the bases of the open case', () => {
      seedLoadedCase();
      useUnitsStore.setState({ mode: 'actual' });
      useCaseStore.setState({
        topology: {
          state: 'pre-setup',
          buses: [{ idx: 5, name: 'b5', kind: 'Bus', params: { Vn: 138 } }],
          lines: [],
          transformers: [],
          generators: [],
          loads: [],
        },
        selectedElement: { kind: 'bus', idx: '5' },
      });
      usePflowStore.setState({
        lastRun: {
          run_id: parseRunId('pf-1'),
          converged: true,
          iterations: 4,
          mismatch: 1e-6,
          bus_voltages: { '5': 1.024 },
          bus_angles: { '5': -0.087 },
        },
        isRunning: false,
        error: null,
      });
      render(<PlotsAccordion />);
      const badge = screen.getByTestId('plots-static-badge');
      expect(badge).toHaveTextContent('Voltage (kV)');
      // 1.024 pu on 138 kV.
      expect(screen.getByText('141.312')).toBeInTheDocument();
    });
  });
});
