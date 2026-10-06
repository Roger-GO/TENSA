import { useRunsStore } from '@/store/runs';
import type { RunRecord, RunsState } from '@/store/runs';

/**
 * The runs a plot-side component reflects. Priority:
 *
 *   1. An explicit ``runId`` prop: that run only.
 *   2. A non-empty overlay set: those runs and the active run, pinned or
 *      not, in runs-map insertion order (chronological) so the legend
 *      layout is stable.
 *   3. The active run alone (legacy single-run mode).
 *
 * The active run is drawn whatever is pinned. It is the run that was just
 * started, and pins outlive the session that made them (a reload of the page
 * brings them back): a plot of the pinned runs alone went on showing two runs
 * pinned days earlier, under their own labels, after a new run with other
 * settings.
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
      if (overlayRunIds.has(id) || id === activeRunId) out.push(runs[id]!);
    }
    return out;
  }
  if (activeRunId && runs[activeRunId]) return [runs[activeRunId]!];
  return [];
}

/**
 * The one run the single-run parts of a plot follow: the CSV and COMTRADE
 * exports, the scrub cursor, the response metrics. It is the run the plot keys
 * its state on (``plotRunId``) when that run is drawn, so the active run while
 * there is one and the oldest pinned run otherwise. An export is named for
 * that run and the metrics are taken between its cursors, so they have to be
 * of it and not of whichever run happens to be drawn first.
 */
export function primaryRunOf(
  drawn: readonly RunRecord[],
  anchorRunId: string | null,
): RunRecord | undefined {
  return drawn.find((r) => r.runId === anchorRunId) ?? drawn[0];
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
