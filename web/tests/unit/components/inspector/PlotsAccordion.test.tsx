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
  });

  afterEach(() => {
    cleanup();
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
});
