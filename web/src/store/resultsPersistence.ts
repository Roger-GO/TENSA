/**
 * Keeps results across a reload of the page: the finished time-domain runs
 * (``store/runs.ts``) and the power flows kept for comparison
 * (``store/pflowHistory.ts``). They used to live in the tab's memory only, so a
 * reload, or a tab closed by mistake, took every plot with it.
 *
 * ``startResultsPersistence`` does two things, in this order:
 *
 * 1. **Puts back** what the browser kept (``lib/resultsArchive.ts``, an
 *    IndexedDB database) into the two slices. A run comes back as an earlier
 *    run: finished, not the active one, with its name, colour and overlay pin.
 * 2. **Mirrors** the slices into the archive from then on. A run is written
 *    once, when it finishes (its samples do not change after that); renaming it
 *    rewrites its small record only; deleting it, or the retention limit
 *    pushing it out, deletes it. A run still streaming is not written: the
 *    session that was computing it does not survive the page.
 *
 * So the archive holds what the History drawer and the Compare tab list, no
 * more: Clear runs, Delete and a discarded session (Change case) empty it the
 * same way they empty the lists.
 *
 * ``isRunArchived`` says whether a reload would bring a run back, which is what
 * the unload guard needs to know (``lib/unsavedWork.ts``): a run that is safely
 * kept is no reason to ask before leaving.
 *
 * Where IndexedDB is missing or refuses (some private modes), nothing is kept
 * and everything else works as before. A write that fails (the browser's
 * storage is full) leaves the run in the tab, says so once, and the unload
 * guard goes on asking for it.
 */
import type { ResultsArchive } from '@/lib/resultsArchive';
import { toast } from '@/lib/toast';
import { usePflowHistoryStore, type PflowHistoryState, type PflowSnapshot } from './pflowHistory';
import { useRunsStore, type RunRecord, type RunsState } from './runs';

/** The runs a reload would bring back as they are now. */
const archivedRunIds = new Set<string>();

/** True when the run's samples are in the browser's archive, so a reload keeps it. */
export function isRunArchived(runId: string): boolean {
  return archivedRunIds.has(runId);
}

export interface ResultsPersistence {
  /** Resolves once what was kept has been put back, or there was nothing to read. */
  ready: Promise<void>;
  /** Resolves once every write asked for so far has finished. */
  flushed: () => Promise<void>;
  /** Stop mirroring and let the database go. What is in the slices stays. */
  stop: () => void;
}

export interface ResultsPersistenceOptions {
  /** Opens the archive; ``null`` for a browser that has none. */
  open?: () => Promise<ResultsArchive | null>;
  /** Told about a write that failed. The default says so once per page load. */
  onWriteError?: (error: unknown) => void;
}

function isFinished(run: RunRecord): boolean {
  return run.state === 'done' || run.state === 'error' || run.state === 'aborted';
}

let warned = false;

/** Say once that results are not being kept, and why it matters. */
function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  const reason = error instanceof Error && error.message.length > 0 ? ` (${error.message})` : '';
  toast.warning('Results could not be kept in this browser', {
    description: `They stay in this tab and will be gone when it is closed or reloaded${reason}.`,
  });
}

/** Test seam: let the next failure warn again. */
export function __resetResultsPersistenceForTests(): void {
  warned = false;
  archivedRunIds.clear();
}

/** What was last written of a run: enough to tell which part of it changed since. */
interface KeptRun {
  record: RunRecord;
  seqCount: number;
  t: Float64Array;
}

export function startResultsPersistence(
  options: ResultsPersistenceOptions = {},
): ResultsPersistence {
  // The archive's code is fetched when it is first needed, after the first
  // paint, and not with the entry chunk.
  const open =
    options.open ?? (async () => (await import('@/lib/resultsArchive')).openResultsArchive());
  const onWriteError = options.onWriteError ?? warnOnce;
  let archive: ResultsArchive | null = null;
  let stopped = false;
  const unsubscribe: Array<() => void> = [];

  // Writes go one after another, in the order they were asked for, so a run
  // that is written and then deleted is not deleted first.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: (archive: ResultsArchive) => Promise<void>): Promise<boolean> => {
    const result = queue.then(async () => {
      if (archive === null || stopped) return false;
      try {
        await work(archive);
        return true;
      } catch (err) {
        onWriteError(err);
        return false;
      }
    });
    queue = result.then(() => undefined);
    return result;
  };

  // ---- runs -----------------------------------------------------------------

  const keptRuns = new Map<string, KeptRun>();
  let keptRunsState = '';

  const syncRuns = (state: RunsState): void => {
    for (const id of Object.keys(state.runs)) {
      const run = state.runs[id]!;
      // Nothing to keep of a run that is still going, or that ended with no rows.
      if (!isFinished(run) || run.seqCount === 0) continue;
      const kept = keptRuns.get(id);
      if (kept === undefined || kept.seqCount !== run.seqCount || kept.t !== run.t) {
        keptRuns.set(id, { record: run, seqCount: run.seqCount, t: run.t });
        archivedRunIds.delete(id);
        void enqueue((a) => a.putRun(run)).then((written) => {
          // Only if nothing has replaced or removed the run while it was written.
          if (written && keptRuns.get(id)?.t === run.t) archivedRunIds.add(id);
        });
      } else if (kept.record !== run) {
        keptRuns.set(id, { ...kept, record: run });
        void enqueue((a) => a.putRunMeta(run));
      }
    }
    for (const id of [...keptRuns.keys()]) {
      if (state.runs[id] !== undefined) continue;
      keptRuns.delete(id);
      archivedRunIds.delete(id);
      void enqueue((a) => a.deleteRun(id));
    }
    const runsState = {
      runCount: state.runCount,
      overlayRunIds: [...state.overlayRunIds],
      retentionLimit: state.retentionLimit,
    };
    const serialized = JSON.stringify(runsState);
    if (serialized !== keptRunsState) {
      keptRunsState = serialized;
      void enqueue((a) => a.putRunsState(runsState));
    }
  };

  // ---- power flows ------------------------------------------------------------

  const keptPflow = new Map<string, PflowSnapshot>();
  let keptPflowState = '';

  const syncPflow = (state: PflowHistoryState): void => {
    const present = new Set<string>();
    for (const snapshot of state.snapshots) {
      present.add(snapshot.id);
      if (keptPflow.get(snapshot.id) === snapshot) continue;
      keptPflow.set(snapshot.id, snapshot);
      void enqueue((a) => a.putPflow(snapshot));
    }
    for (const id of [...keptPflow.keys()]) {
      if (present.has(id)) continue;
      keptPflow.delete(id);
      void enqueue((a) => a.deletePflow(id));
    }
    const pflowState = {
      count: state.count,
      baselineId: state.baselineId,
      comparedId: state.comparedId,
    };
    const serialized = JSON.stringify(pflowState);
    if (serialized !== keptPflowState) {
      keptPflowState = serialized;
      void enqueue((a) => a.putPflowState(pflowState));
    }
  };

  // ---- start ------------------------------------------------------------------

  const ready = (async () => {
    let opened: ResultsArchive | null;
    try {
      opened = await open();
    } catch {
      opened = null;
    }
    if (opened === null) return;
    if (stopped) {
      opened.close();
      return;
    }
    archive = opened;

    try {
      const contents = await opened.read();
      if (stopped) return;
      useRunsStore.getState().restoreRuns({
        runs: contents.runs,
        ...(contents.runsState === null ? {} : contents.runsState),
      });
      usePflowHistoryStore.getState().restore({
        snapshots: contents.pflow,
        count: contents.pflowState?.count ?? 0,
        baselineId: contents.pflowState?.baselineId ?? null,
        comparedId: contents.pflowState?.comparedId ?? null,
      });
      // What the slices now hold of what was read is in the archive already:
      // note it, so the first sync does not write it all again. What did not go
      // back into them (a power flow past the cap) has no list to be deleted
      // from, so it is deleted here.
      const runs = useRunsStore.getState().runs;
      for (const read of contents.runs) {
        const run = runs[read.runId];
        if (run !== undefined && run.seqCount === read.seqCount) {
          keptRuns.set(run.runId, { record: run, seqCount: run.seqCount, t: run.t });
          archivedRunIds.add(run.runId);
        } else {
          void enqueue((a) => a.deleteRun(read.runId));
        }
      }
      const snapshots = usePflowHistoryStore.getState().snapshots;
      for (const read of contents.pflow) {
        const snapshot = snapshots.find((s) => s.id === read.id);
        if (snapshot !== undefined) keptPflow.set(snapshot.id, snapshot);
        else void enqueue((a) => a.deletePflow(read.id));
      }
      // A record this version cannot read is of no use here and would otherwise
      // stay for good. (A build that changes what a record holds bumps the
      // database version, and an older build cannot open that database at all,
      // so this never deletes what a newer build wrote.)
      for (const id of contents.staleRunIds) void enqueue((a) => a.deleteRun(id));
      for (const id of contents.stalePflowIds) void enqueue((a) => a.deletePflow(id));
    } catch (err) {
      // What was kept could not be read. Go on keeping what comes next.
      onWriteError(err);
    }
    if (stopped) return;

    // Whatever finished while the archive was being read is written now.
    syncRuns(useRunsStore.getState());
    syncPflow(usePflowHistoryStore.getState());
    unsubscribe.push(useRunsStore.subscribe(syncRuns));
    unsubscribe.push(usePflowHistoryStore.subscribe(syncPflow));
  })();

  return {
    ready,
    flushed: async () => {
      await ready;
      await queue;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const off of unsubscribe) off();
      archivedRunIds.clear();
      // Let the writes in flight finish before the connection goes.
      const closing = archive;
      void queue.then(() => closing?.close());
    },
  };
}
