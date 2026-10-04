/**
 * What this tab holds that closing or reloading it would lose.
 *
 * The session lives in the substrate and the run results in this tab's memory, and
 * neither survives a reload: a new session starts empty, and the plots are gone. The
 * unload guard (``useUnsavedWorkGuard``) asks this before the browser leaves the
 * page.
 *
 * - **Edits**: elements added, parameters changed, a system built from scratch, that
 *   no save has written to the workspace (``hasUnsavedEdits`` in the edit journal,
 *   which Save, Save system as and Save parameter edits as case reset).
 * - **Runs**: a time-domain run, finished or streaming, or a sensitivity sweep. Their
 *   results exist only in this tab (there is no run file to save), so one that has
 *   produced any data counts, and so does one still running.
 */
import { hasUnsavedEdits } from '@/store/editJournal';
import { useRunsStore } from '@/store/runs';
import { useSweepStore } from '@/store/sweep';

export interface UnsavedWork {
  /** Edits or a build that no save has written out. */
  edits: boolean;
  /** Run or sweep results that exist only in this tab. */
  runs: boolean;
}

export function unsavedWork(): UnsavedWork {
  const runs = Object.values(useRunsStore.getState().runs);
  const sweeps = Object.values(useSweepStore.getState().sweeps);
  return {
    edits: hasUnsavedEdits(),
    runs:
      runs.some((r) => r.seqCount > 0 || r.state === 'starting' || r.state === 'streaming') ||
      sweeps.some((s) => s.iterations.length > 0 || s.state === 'pending' || s.state === 'running'),
  };
}

/** True when leaving the page would lose something. */
export function hasUnsavedWork(): boolean {
  const work = unsavedWork();
  return work.edits || work.runs;
}
