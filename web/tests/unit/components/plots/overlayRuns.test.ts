/**
 * Which runs a plot-side component draws (`resolveOverlayRuns`), which run
 * it keys its own state on (`plotRunId`) and which of the drawn runs its
 * single-run parts follow (`primaryRunOf`).
 */
import { describe, expect, it } from 'vitest';
import { plotRunId, primaryRunOf, resolveOverlayRuns } from '@/components/plots/overlayRuns';
import type { RunRecord } from '@/store/runs';
import { finishedRun } from '../../helpers/runs';

function state(
  ids: string[],
  activeRunId: string | null,
  pinned: string[] = [],
): { runs: Record<string, RunRecord>; activeRunId: string | null; overlayRunIds: Set<string> } {
  const runs: Record<string, RunRecord> = {};
  for (const id of ids) runs[id] = finishedRun(id);
  return { runs, activeRunId, overlayRunIds: new Set(pinned) };
}

describe('resolveOverlayRuns', () => {
  it('draws the pinned runs, oldest first, and the active run alone when none is pinned', () => {
    expect(resolveOverlayRuns(state(['a', 'b', 'c'], 'c', ['c', 'a'])).map((r) => r.runId)).toEqual(
      ['a', 'c'],
    );
    expect(resolveOverlayRuns(state(['a', 'b'], 'b')).map((r) => r.runId)).toEqual(['b']);
  });

  it('draws the active run with the pinned ones, though it is not pinned itself', () => {
    expect(resolveOverlayRuns(state(['a', 'b', 'c'], 'c', ['a', 'b'])).map((r) => r.runId)).toEqual(
      ['a', 'b', 'c'],
    );
    // In the order the runs were made, wherever the active one falls in it.
    expect(resolveOverlayRuns(state(['a', 'b', 'c'], 'a', ['c'])).map((r) => r.runId)).toEqual([
      'a',
      'c',
    ]);
  });

  it('draws the pinned runs alone once no run is active, as after Reset run or a reload', () => {
    expect(
      resolveOverlayRuns(state(['a', 'b', 'c'], null, ['a', 'b'])).map((r) => r.runId),
    ).toEqual(['a', 'b']);
  });

  it('draws the active run when every pin is of a run that is gone', () => {
    expect(resolveOverlayRuns(state(['a'], 'a', ['gone'])).map((r) => r.runId)).toEqual(['a']);
  });

  it('draws the run asked for and no other, whatever is pinned or active', () => {
    expect(resolveOverlayRuns(state(['a', 'b', 'c'], 'c', ['a']), 'b').map((r) => r.runId)).toEqual(
      ['b'],
    );
  });

  it('draws nothing with no active run and no pin', () => {
    expect(resolveOverlayRuns(state(['a', 'b'], null))).toEqual([]);
  });
});

describe('primaryRunOf', () => {
  const drawn = (ids: string[]) => ids.map((id) => finishedRun(id));

  it('is the run the plot keys its state on when that run is drawn', () => {
    expect(primaryRunOf(drawn(['a', 'b', 'c']), 'c')?.runId).toBe('c');
    expect(primaryRunOf(drawn(['a', 'b', 'c']), 'a')?.runId).toBe('a');
  });

  it('is the first run drawn when the plot has no run of its own among them', () => {
    expect(primaryRunOf(drawn(['a', 'b']), null)?.runId).toBe('a');
    expect(primaryRunOf(drawn(['a', 'b']), 'gone')?.runId).toBe('a');
  });

  it('is none when nothing is drawn', () => {
    expect(primaryRunOf([], 'a')).toBeUndefined();
  });
});

describe('plotRunId', () => {
  it('is the run asked for, when one is', () => {
    expect(plotRunId(state(['a', 'b'], 'b', ['a']), 'a')).toBe('a');
  });

  it('is the active run, pinned or not', () => {
    expect(plotRunId(state(['a', 'b'], 'b'))).toBe('b');
    expect(plotRunId(state(['a', 'b'], 'b', ['a']))).toBe('b');
  });

  it('is the oldest pinned run when no run is active, as after a reload', () => {
    expect(plotRunId(state(['a', 'b', 'c'], null, ['c', 'b']))).toBe('b');
  });

  it('is none when no run is active and none is pinned, whatever is kept', () => {
    expect(plotRunId(state(['a', 'b'], null))).toBeNull();
    expect(plotRunId(state([], null))).toBeNull();
  });

  it('ignores a pin of a run that is gone', () => {
    expect(plotRunId(state(['a'], null, ['gone']))).toBeNull();
  });
});
