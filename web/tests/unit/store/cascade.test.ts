/**
 * Tests for the cross-slice cascade wired in ``store/index.ts``.
 *
 * Concerns:
 *  - A case change drops the previous case's PF result and EIG / CPF / SE
 *    results and releases its active TDS run, so none of them can leave a Run
 *    button on the new case enabled (or disabled) by state that belongs to the
 *    old one. The finished runs stay, with their names, colours and overlay
 *    pins: they exist only in this tab and are worth comparing across cases.
 *  - Clearing the PF result by itself (Reload case, Reset run) drops the
 *    analysis results computed from it, whether or not an Analyze view is
 *    mounted to notice.
 *  - A session clear drops the case and PF result, except mid-recovery, when
 *    the case selection has to survive so it can be re-loaded.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRunReadiness } from '@/lib/useRunReadiness';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { useAnalyzeStore } from '@/store/analyze';
import { useCaseStore } from '@/store/case';
import { blankFaultSpec, useDisturbanceStore } from '@/store/disturbance';
import { usePflowStore } from '@/store/pflow';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { CpfResult, EigResult, PflowResult } from '@/api/types';

const PF: PflowResult = {
  run_id: 'pf-1',
  converged: true,
  iterations: 4,
  mismatch: 1e-7,
  bus_voltages: {},
  bus_angles: {},
  line_flows: {},
  generator_outputs: {},
  load_consumption: {},
};

const EIG: EigResult = {
  eigenvalues: [{ real: -0.1, imag: 1.0 }],
  damping_ratios: [0.1],
  frequencies_hz: [0.159],
  mode_count: 1,
  state_count: 1,
  state_names: ['delta_1'],
  tds_initialized: true,
};

const CPF: CpfResult = {
  lambdas: [0, 1],
  voltages_per_bus: { '1': [1.0, 0.9] },
  bus_idxes: ['1'],
  nose_idx: 1,
  max_lam: 1,
  truncated: false,
  done_msg: 'Nose point',
  mode: 'pv',
};

function caseOf(name: string) {
  return { primaryPath: parseWorkspacePath(name), addfiles: [] };
}

/** A case with a PF result, an EIG result, SE measurements and a finished TDS run. */
function seedResults(): void {
  useCaseStore.getState().setCase(caseOf('kundur_full.xlsx'));
  usePflowStore.getState().setLastRun(PF);
  useAnalyzeStore.getState().setEigResult(EIG);
  useAnalyzeStore.getState().setSeMeasurementsCount(30);
  useRunsStore.getState().startRun({ runId: 'run-1', tf: 1, columnNames: ['Bus_1_v'] });
}

beforeEach(() => {
  __resetCascadeForTests();
  wireStoreCascade();
});

afterEach(() => {
  __resetCascadeForTests();
});

describe('store cascade — case change', () => {
  it('drops the previous case results and releases its active TDS run when another case is set', () => {
    seedResults();
    expect(useRunsStore.getState().activeRunId).toBe('run-1');

    useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));

    expect(usePflowStore.getState().lastRun).toBeNull();
    expect(useAnalyzeStore.getState().eigResult).toBeNull();
    expect(useAnalyzeStore.getState().seMeasurementsCount).toBeNull();
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });

  it('keeps the finished runs, with their names, colours and overlay pins', () => {
    seedResults();
    useRunsStore.getState().markRunDone('run-1', 1);
    useRunsStore.getState().setRunDisplayName('run-1', 'Base case');
    useRunsStore.getState().setRunColorOverride('run-1', '#aa3300');
    useRunsStore.getState().addOverlayRun('run-1');

    useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));

    const { runs, activeRunId, overlayRunIds } = useRunsStore.getState();
    expect(activeRunId).toBeNull();
    expect(Object.keys(runs)).toEqual(['run-1']);
    expect(runs['run-1']?.displayName).toBe('Base case');
    expect(runs['run-1']?.colorOverride).toBe('#aa3300');
    expect(runs['run-1']?.state).toBe('done');
    expect(overlayRunIds.has('run-1')).toBe(true);
  });

  it('does not let a kept run hold Run PF back on the new case', () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-1') });
    seedResults();
    // Leave the run as the only thing gating Run PF (the seeded EIG would too).
    useAnalyzeStore.getState().clearEigResult();
    useRunsStore.getState().markRunDone('run-1', 1);
    const before = renderHook(() => useRunReadiness('pflow'));
    expect(before.result.current.disabledReason).toMatch(/Reset the run first/);

    useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));

    const after = renderHook(() => useRunReadiness('pflow'));
    expect(after.result.current.ready).toBe(true);
    expect(Object.keys(useRunsStore.getState().runs)).toEqual(['run-1']);
  });

  it('lets a run on the new case start after one on the old case was kept', () => {
    seedResults();
    useRunsStore.getState().markRunDone('run-1', 1);
    useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));

    useRunsStore.getState().startRun({ runId: 'run-2', tf: 1, columnNames: ['Bus_1_v'] });

    const { runs, activeRunId } = useRunsStore.getState();
    expect(activeRunId).toBe('run-2');
    expect(Object.keys(runs).sort()).toEqual(['run-1', 'run-2']);
  });

  it('drops them when the case is cleared', () => {
    seedResults();
    useCaseStore.getState().clearCase();
    expect(usePflowStore.getState().lastRun).toBeNull();
    expect(useAnalyzeStore.getState().eigResult).toBeNull();
    expect(useRunsStore.getState().activeRunId).toBeNull();
    expect(Object.keys(useRunsStore.getState().runs)).toEqual(['run-1']);
  });
});

describe('store cascade — scheduled disturbances', () => {
  function scheduleFault(): void {
    useDisturbanceStore.getState().addDisturbance({ ...blankFaultSpec(), bus_idx: 7 });
  }

  it('drops the disturbances scheduled for the old case when another case is set', () => {
    seedResults();
    scheduleFault();
    expect(useDisturbanceStore.getState().disturbances).toHaveLength(1);

    useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));

    const { disturbances, dirty, committed } = useDisturbanceStore.getState();
    expect(disturbances).toEqual([]);
    expect(dirty).toBe(false);
    expect(committed).toBe(false);
  });

  it('drops them when the case is cleared, and when the session ends', () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-1'), recoveryInProgress: false });
    seedResults();
    scheduleFault();
    useCaseStore.getState().clearCase();
    expect(useDisturbanceStore.getState().disturbances).toEqual([]);

    seedResults();
    scheduleFault();
    useSessionStore.getState().clearSession();
    expect(useDisturbanceStore.getState().disturbances).toEqual([]);
  });

  it('keeps them while the session is being recovered, so the next run still applies them', () => {
    useSessionStore.setState({ sessionId: parseSessionId('sess-1'), recoveryInProgress: false });
    seedResults();
    scheduleFault();

    useSessionStore.getState().resetSession();

    expect(useDisturbanceStore.getState().disturbances).toHaveLength(1);
  });

  it('keeps them when a PF result is replaced or cleared on the same case', () => {
    seedResults();
    scheduleFault();
    usePflowStore.getState().clearPflow();
    expect(useDisturbanceStore.getState().disturbances).toHaveLength(1);
  });
});

describe('store cascade — PF result cleared on its own', () => {
  it('drops the EIG / CPF / SE results computed from it', () => {
    seedResults();
    useAnalyzeStore.getState().setCpfResult(CPF);

    // What Reload case and Reset run both do after the re-parse.
    usePflowStore.getState().clearPflow();

    expect(useAnalyzeStore.getState().eigResult).toBeNull();
    expect(useAnalyzeStore.getState().cpfResult).toBeNull();
    expect(useAnalyzeStore.getState().seMeasurementsCount).toBeNull();
    // The case itself, and its TDS runs, stay: only the operating point went.
    expect(useCaseStore.getState().selection).not.toBeNull();
    expect(useRunsStore.getState().activeRunId).toBe('run-1');
  });

  it('leaves the analysis results alone when a new PF result replaces the old one', () => {
    seedResults();
    usePflowStore.getState().setLastRun({ ...PF, run_id: 'pf-2' });
    expect(useAnalyzeStore.getState().eigResult).not.toBeNull();
  });
});

describe('store cascade — session clear', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionId: parseSessionId('sess-1'),
      recoveryInProgress: false,
    });
    seedResults();
  });

  it('drops the case and the PF result when the session ends', () => {
    useSessionStore.getState().clearSession();
    expect(useCaseStore.getState().selection).toBeNull();
    expect(usePflowStore.getState().lastRun).toBeNull();
    expect(useAnalyzeStore.getState().eigResult).toBeNull();
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });

  it('keeps the case selection while the session is being recovered', () => {
    useSessionStore.getState().resetSession();
    expect(useCaseStore.getState().selection).not.toBeNull();
    // Runs are tied to the dead worker, so they go either way.
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });
});
