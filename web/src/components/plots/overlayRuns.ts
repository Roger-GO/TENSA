import type { RunRecord, RunsState } from '@/store/runs';

/**
 * The runs a plot-side component reflects. Priority:
 *
 *   1. An explicit ``runId`` prop: that run only.
 *   2. A non-empty overlay set: those runs, in runs-map insertion order
 *      (chronological) so the legend layout is stable.
 *   3. The active run alone (legacy single-run mode).
 *
 * Pure and cheap (at most ``MAX_RETENTION_LIMIT`` + 1 runs), so a store
 * selector can call it on every update.
 */
export function resolveOverlayRuns(
  state: Pick<RunsState, 'runs' | 'overlayRunIds' | 'activeRunId'>,
  runId?: string,
): RunRecord[] {
  const { runs, overlayRunIds, activeRunId } = state;
  if (runId) {
    const r = runs[runId];
    return r ? [r] : [];
  }
  if (overlayRunIds.size > 0) {
    const out: RunRecord[] = [];
    for (const id of Object.keys(runs)) {
      if (overlayRunIds.has(id)) out.push(runs[id]!);
    }
    return out;
  }
  if (activeRunId && runs[activeRunId]) return [runs[activeRunId]!];
  return [];
}
