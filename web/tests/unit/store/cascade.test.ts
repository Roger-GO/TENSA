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
 *  - A session the user discarded takes every time-domain run. A session that
 *    was lost and is being recovered takes the runs still streaming and
 *    releases the active one; the finished runs stay.
 *  - A session clear drops the messages of the session that ended, recovery or not:
 *    they are that worker's log.
 *  - The power flows kept for comparison stay across a case change and a
 *    recovery, and go with a session the user discarded.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRunReadiness } from '@/lib/useRunReadiness';
import { __resetCascadeForTests, wireStoreCascade } from '@/store';
import { useAnalyzeStore } from '@/store/analyze';
import { useMessagesStore } from '@/store/messages';
import { useCaseStore } from '@/store/case';
import { blankFaultSpec, useDisturbanceStore } from '@/store/disturbance';
import { usePflowStore } from '@/store/pflow';
import { usePflowHistoryStore } from '@/store/pflowHistory';
import { usePflowOptionsStore } from '@/store/pflowOptions';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';
import { DEFAULT_TDS_CONFIG, useUiStore } from '@/store/ui';
import { parseSessionId, parseWorkspacePath } from '@/api/types';
import type { CpfResult, EigResult, PflowResult } from '@/api/types';
import { NO_ELEMENT_NAMES } from '@/lib/elementNames';

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
  useUiStore.setState({ tdsConfig: { ...DEFAULT_TDS_CONFIG } });
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

  it('puts the power-flow options back to the defaults, so a setting made for one case does not follow to the next', () => {
    useCaseStore.getState().setCase(caseOf('kundur_full.xlsx'));
    usePflowOptionsStore.getState().setOptions({ flatStart: true, tolerance: 1e-3 });
    // What a run showed about the old case (its file turns Q limits on) is not
    // true of the next one either.
    usePflowOptionsStore.getState().noteCaseSettings({ enforceQLimits: true });

    useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));

    expect(usePflowOptionsStore.getState().options).toEqual({
      tolerance: null,
      maxIterations: null,
      flatStart: null,
      enforceQLimits: null,
    });
    expect(usePflowOptionsStore.getState().caseSettings).toEqual({
      flatStart: null,
      enforceQLimits: null,
    });
  });

  it('keeps the power-flow options while the same case is reloaded or its PF result replaced', () => {
    useCaseStore.getState().setCase(caseOf('kundur_full.xlsx'));
    usePflowStore.getState().setLastRun(PF);
    usePflowOptionsStore.getState().setOptions({ enforceQLimits: true });

    usePflowStore.getState().clearPflow();
    usePflowStore.getState().setLastRun(PF);

    expect(usePflowOptionsStore.getState().options.enforceQLimits).toBe(true);
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

describe('store cascade — ANDES variables picked for the next run', () => {
  const pick = () => useUiStore.getState().setTdsConfig({ daeVars: ['omega GENROU 1'] });

  it('are names of devices of the old case, so another case empties the list', () => {
    seedResults();
    pick();

    useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));

    expect(useUiStore.getState().tdsConfig.daeVars).toEqual([]);
  });

  it('are emptied when the case is cleared, and the rest of the run settings stay', () => {
    seedResults();
    useUiStore.getState().setTdsConfig({ tf: 25, daeVars: ['omega GENROU 1'] });

    useCaseStore.getState().clearCase();

    expect(useUiStore.getState().tdsConfig.daeVars).toEqual([]);
    expect(useUiStore.getState().tdsConfig.tf).toBe(25);
  });

  it('stay while a PF result is replaced or cleared on the same case', () => {
    seedResults();
    pick();

    usePflowStore.getState().clearPflow();

    expect(useUiStore.getState().tdsConfig.daeVars).toEqual(['omega GENROU 1']);
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
    // The System the active run stepped went with the worker, so no run is active.
    expect(useRunsStore.getState().activeRunId).toBeNull();
  });

  describe('the time-domain runs', () => {
    /** A finished run with a name and a pin, and a second run still streaming. */
    function seedRuns(): void {
      useRunsStore.getState().markRunDone('run-1', 1, true);
      useRunsStore.getState().setRunDisplayName('run-1', 'Base case');
      useRunsStore.getState().addOverlayRun('run-1');
      useRunsStore.getState().startRun({ runId: 'run-2', tf: 5, columnNames: ['Bus_1_v'] });
      useRunsStore.getState().appendFrame('run-2', {
        t: new Float64Array([0, 0.1]),
        columns: { Bus_1_v: new Float64Array([1, 1]) },
      });
    }

    it('all go with a session the user discarded', () => {
      seedRuns();
      useSessionStore.getState().clearSession();
      expect(useRunsStore.getState().runs).toEqual({});
      expect(useRunsStore.getState().overlayRunIds.size).toBe(0);
    });

    it('stay, when finished, while a lost session is being recovered', () => {
      seedRuns();
      useSessionStore.getState().resetSession();

      const { runs, activeRunId, overlayRunIds } = useRunsStore.getState();
      // The finished run is a result and stays, with its name and its pin. The
      // one that was streaming lost its stream with the worker.
      expect(Object.keys(runs)).toEqual(['run-1']);
      expect(runs['run-1']).toMatchObject({ state: 'done', displayName: 'Base case' });
      expect(overlayRunIds.has('run-1')).toBe(true);
      expect(activeRunId).toBeNull();
    });

    it('leave Run PF free on the recovered session', () => {
      useAnalyzeStore.getState().clearEigResult();
      useRunsStore.getState().markRunDone('run-1', 1, true);
      useSessionStore.getState().resetSession();
      useSessionStore.setState({ sessionId: parseSessionId('sess-2'), recoveryInProgress: false });

      const { result } = renderHook(() => useRunReadiness('pflow'));
      expect(result.current.disabledReason ?? '').not.toMatch(/Reset the run first/);
    });
  });

  describe('the power flows kept for comparison', () => {
    function keepPf(): void {
      usePflowHistoryStore
        .getState()
        .record(PF, { caseName: 'kundur_full', names: NO_ELEMENT_NAMES });
    }

    it('go with a session the user discarded', () => {
      keepPf();
      useSessionStore.getState().clearSession();
      expect(usePflowHistoryStore.getState().snapshots).toEqual([]);
    });

    it('stay while the session is being recovered', () => {
      keepPf();
      useSessionStore.getState().resetSession();
      expect(usePflowHistoryStore.getState().snapshots.map((s) => s.id)).toEqual(['pf-1']);
    });

    it('stay when another case is opened, to be compared with its result', () => {
      keepPf();
      useCaseStore.getState().setCase(caseOf('wscc9.xlsx'));
      expect(usePflowStore.getState().lastRun).toBeNull();
      expect(usePflowHistoryStore.getState().snapshots.map((s) => s.caseName)).toEqual([
        'kundur_full',
      ]);
    });
  });

  describe('the messages ANDES logged', () => {
    function seedMessages(): void {
      useMessagesStore.getState().receive('sess-1', {
        messages: [
          { seq: 1, time: 1, level: 'warning', logger: 'andes', source: '', text: 'x', repeat: 1 },
        ],
        first_seq: 1,
        last_seq: 1,
        next_after: 1,
        dropped: 0,
      });
    }

    it('go with the session that ended', () => {
      seedMessages();
      useSessionStore.getState().clearSession();
      expect(useMessagesStore.getState().messages).toEqual([]);
      expect(useMessagesStore.getState().sessionId).toBeNull();
      expect(useMessagesStore.getState().cursor).toBe(0);
    });

    it('go with a session that is being recovered too: they are its worker’s log', () => {
      seedMessages();
      useSessionStore.getState().resetSession();
      expect(useMessagesStore.getState().messages).toEqual([]);
    });
  });
});
