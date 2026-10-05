/**
 * `lib/runHistory.ts`: what the controls that open the run history share. They
 * open it on the list of runs whatever the drawer was last set to show, name
 * how many runs it holds, and are on once a case is loaded or runs were kept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { parseSessionId, parseWorkspacePath } from '@/api/types';
import { NO_RUNS_YET, openRunHistory, runHistoryLabel, useRunHistory } from '@/lib/runHistory';
import { useCaseStore } from '@/store/case';
import { useHistoryStore } from '@/store/history';
import { DEFAULT_LAYOUT, useLayoutStore } from '@/store/layout';
import { useRunsStore } from '@/store/runs';
import { useSessionStore } from '@/store/session';

function reset(): void {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
  useHistoryStore.getState().reset();
  useRunsStore.getState().clearRuns();
  useSessionStore.setState({ sessionId: null });
  useCaseStore.setState({ selection: null });
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

/** A finished run that is no longer the active one, as a reload brings it back. */
function seedKeptRun(runId: string): void {
  useRunsStore.getState().startRun({ runId, tf: 1, columnNames: ['Bus_1_v'] });
  useRunsStore.getState().markRunDone(runId, 1, true);
  useRunsStore.getState().clearActiveRun();
}

describe('openRunHistory', () => {
  it('opens the History drawer', () => {
    openRunHistory();
    expect(useHistoryStore.getState().drawerOpen).toBe(true);
    expect(useLayoutStore.getState().historyKindFilter).toBe('runs');
  });

  it('puts the drawer back on its runs when it was left on a job list', () => {
    // A job list is of this page load only, so after a reload it is empty
    // while the runs are there: "Run history" must not open on it.
    for (const left of ['all', 'pflow'] as const) {
      useHistoryStore.getState().closeDrawer();
      useLayoutStore.setState({ historyKindFilter: left });
      openRunHistory();
      expect(useLayoutStore.getState().historyKindFilter).toBe('runs');
      expect(useHistoryStore.getState().drawerOpen).toBe(true);
    }
  });
});

describe('runHistoryLabel', () => {
  it('names how many runs there are, and nothing when there are none', () => {
    expect(runHistoryLabel(0)).toBe('Run history');
    expect(runHistoryLabel(1)).toBe('Run history (1)');
    expect(runHistoryLabel(12)).toBe('Run history (12)');
  });
});

describe('useRunHistory', () => {
  it('is off with no case and no runs, and the reason says what to do', () => {
    const { result } = renderHook(() => useRunHistory());
    expect(result.current).toEqual({ runCount: 0, available: false });
    expect(NO_RUNS_YET).toMatch(/Load a case and run a time-domain simulation/);
  });

  it('is on once a case is loaded, before any run', () => {
    useSessionStore.setState({ sessionId: parseSessionId('s1') });
    useCaseStore.setState({
      selection: { primaryPath: parseWorkspacePath('kundur_full.xlsx'), addfiles: [] },
    });
    const { result } = renderHook(() => useRunHistory());
    expect(result.current).toEqual({ runCount: 0, available: true });
  });

  it('is on with no case when runs were kept, as after a reload, and counts them', () => {
    seedKeptRun('kept-1');
    const { result } = renderHook(() => useRunHistory());
    expect(result.current).toEqual({ runCount: 1, available: true });

    act(() => seedKeptRun('kept-2'));
    expect(result.current).toEqual({ runCount: 2, available: true });

    act(() => useRunsStore.getState().clearRuns());
    expect(result.current).toEqual({ runCount: 0, available: false });
  });
});
