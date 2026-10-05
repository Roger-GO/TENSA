import { useRunsStore } from '@/store/runs';
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

/**
 * The run a plot-side component keys its own state on: the variables picked,
 * the cursors, the scrub time. Priority:
 *
 *   1. An explicit ``runId`` prop.
 *   2. The active run.
 *   3. With no active run, the first pinned run (oldest first, as
 *      ``resolveOverlayRuns`` orders them).
 *
 * The third is what lets earlier runs be read on their own: after Reset run or
 * a case change, and after a reload of the page, which brings the finished runs
 * back but no active one. Pinning them is then enough to plot them; without it
 * the plot had nothing to hang the selection on until a new run started.
 */
export function plotRunId(
  state: Pick<RunsState, 'runs' | 'overlayRunIds' | 'activeRunId'>,
  runId?: string,
): string | null {
  if (runId) return runId;
  if (state.activeRunId !== null) return state.activeRunId;
  if (state.overlayRunIds.size === 0) return null;
  for (const id of Object.keys(state.runs)) {
    if (state.overlayRunIds.has(id)) return id;
  }
  return null;
}

/** ``plotRunId`` as a store subscription: a string, so a streamed frame re-renders nothing. */
export function usePlotRunId(runId?: string): string | null {
  return useRunsStore((s) => plotRunId(s, runId));
}
