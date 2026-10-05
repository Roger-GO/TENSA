/**
 * What counts as work a reload would lose: unsaved edits, and run or sweep results
 * that exist only in this tab. Nothing here keeps results in the browser, so every
 * run that holds data counts; `resultsPersistence.test.ts` covers the run that
 * stops counting once the browser has it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasUnsavedWork, unsavedWork } from '@/lib/unsavedWork';
import { useEditJournalStore } from '@/store/editJournal';
import { useRunsStore } from '@/store/runs';
import { useSweepStore } from '@/store/sweep';
import { useCaseStore } from '@/store/case';
import { parseWorkspacePath } from '@/api/types';

function clean(): void {
  useCaseStore.setState({
    selection: { primaryPath: parseWorkspacePath('ieee14.raw'), addfiles: [] },
  });
  useEditJournalStore.getState().reset();
  useRunsStore.getState().clearRuns();
  useSweepStore.getState().clearSweeps();
}

beforeEach(clean);
afterEach(() => {
  clean();
  useCaseStore.setState({ selection: null });
});

function startRun(runId = 'r1'): void {
  useRunsStore.getState().startRun({ runId, tf: 5, columnNames: ['Bus_1_v'] });
}

function startSweep(sweepId = 's1'): void {
  useSweepStore.getState().startSweep({
    sweepId,
    parameterKind: 'disturbance.fault.tc',
    parameterTarget: 0,
    snapshotName: 'snap',
    total: 3,
  });
}

describe('unsavedWork', () => {
  it('is nothing for a tab that has only loaded a case', () => {
    expect(unsavedWork()).toEqual({ edits: false, runs: false });
    expect(hasUnsavedWork()).toBe(false);
  });

  it('counts an edit, and a build from scratch, until it is saved', () => {
    useEditJournalStore.getState().record({ op: 'add', model: 'Bus', params: { idx: 1 } });
    expect(unsavedWork()).toEqual({ edits: true, runs: false });

    useEditJournalStore.getState().markSaved();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('counts a run that has streamed some of its results', () => {
    startRun();
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([0, 0.1]),
      columns: { Bus_1_v: new Float64Array([1, 1]) },
    });
    useRunsStore.getState().markRunDone('r1', 0.1, true);

    expect(unsavedWork()).toEqual({ edits: false, runs: true });
  });

  it('counts a run that is still starting, since leaving kills it', () => {
    startRun();

    expect(hasUnsavedWork()).toBe(true);
  });

  it('stops counting a run once it is deleted from the history', () => {
    startRun();
    useRunsStore.getState().removeRun('r1');

    expect(hasUnsavedWork()).toBe(false);
  });

  it('still counts a run that Reset run released, since its results stay in the tab', () => {
    startRun();
    useRunsStore.getState().appendFrame('r1', {
      t: new Float64Array([0, 0.1]),
      columns: { Bus_1_v: new Float64Array([1, 1]) },
    });
    useRunsStore.getState().markRunDone('r1', 0.1, true);
    useRunsStore.getState().clearActiveRun();

    expect(hasUnsavedWork()).toBe(true);
  });

  it('counts a sweep that is running or has results, until it is dropped', () => {
    startSweep();
    expect(unsavedWork().runs).toBe(true);

    useSweepStore.getState().markSweepFinished('s1', 'aborted');
    expect(unsavedWork().runs).toBe(false);

    useSweepStore.getState().appendIteration('s1', {
      iteration: 0,
      parameter_value: 0.1,
      converged: true,
      final_t: 5,
      callpert_count: 100,
      error: null,
    });
    expect(unsavedWork().runs).toBe(true);

    useSweepStore.getState().resetSweep('s1');
    expect(hasUnsavedWork()).toBe(false);
  });

  it('reports edits and runs separately when both are there', () => {
    useEditJournalStore.getState().markOpaque();
    startRun();

    expect(unsavedWork()).toEqual({ edits: true, runs: true });
  });
});
