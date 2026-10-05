/**
 * Which runs a plot-side component draws (`resolveOverlayRuns`) and which run
 * it keys its own state on (`plotRunId`).
 */
import { describe, expect, it } from 'vitest';
import { plotRunId, resolveOverlayRuns } from '@/components/plots/overlayRuns';
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

  it('draws nothing with no active run and no pin', () => {
    expect(resolveOverlayRuns(state(['a', 'b'], null))).toEqual([]);
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
