/**
 * What this tab holds that closing or reloading it would lose.
 *
 * The session lives in the substrate, and a reload starts a new, empty one. The
 * unload guard (``useUnsavedWorkGuard``) asks this before the browser leaves the
 * page.
 *
 * - **Edits**: elements added, parameters changed, a system built from scratch, that
 *   no save has written to the workspace (``hasUnsavedEdits`` in the edit journal,
 *   which Save, Save system as and Save parameter edits as case reset).
 * - **Runs**: a time-domain run that is still starting or streaming, since leaving
 *   ends it, and a finished one whose results the browser has not kept. A finished
 *   run is written to the browser's storage and comes back after a reload
 *   (``store/resultsPersistence.ts``), so it only counts until that write is done,
 *   or for good where the browser has no storage to give or it is full. A
 *   sensitivity sweep is not kept: one that is running or has results counts.
 */
import { hasUnsavedEdits } from '@/store/editJournal';
import { isRunArchived } from '@/store/resultsPersistence';
import { useRunsStore } from '@/store/runs';
import { useSweepStore } from '@/store/sweep';

export interface UnsavedWork {
  /** Edits or a build that no save has written out. */
  edits: boolean;
  /** Run or sweep results that a reload would not bring back. */
  runs: boolean;
}

export function unsavedWork(): UnsavedWork {
  const runs = Object.values(useRunsStore.getState().runs);
  const sweeps = Object.values(useSweepStore.getState().sweeps);
  return {
    edits: hasUnsavedEdits(),
    runs:
      runs.some(
        (r) =>
          r.state === 'starting' ||
          r.state === 'streaming' ||
          (r.seqCount > 0 && !isRunArchived(r.runId)),
      ) ||
      sweeps.some((s) => s.iterations.length > 0 || s.state === 'pending' || s.state === 'running'),
  };
}

/** True when leaving the page would lose something. */
export function hasUnsavedWork(): boolean {
  const work = unsavedWork();
  return work.edits || work.runs;
}
