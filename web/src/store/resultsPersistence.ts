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
 * **More than one tab.** The archive belongs to the address, so the tabs open
 * on it share one, and each mirrors its own lists into it as if it were alone.
 * A tab that loads takes what the others wrote for its own, and what it then
 * deletes (Delete, Clear runs, Change case, its retention limit) is gone from
 * the archive while another tab still lists it. So a tab says what it deleted
 * on a ``BroadcastChannel``, and a tab that hears of a run it lists stops
 * counting it as kept: the unload guard asks for it again, as for a run that
 * could not be written, and the tab writes no more of it. That is all that is
 * reconciled. The run is not written back, a kept power flow deleted elsewhere
 * is not announced (nothing asks before one is lost), and the small records
 * beside the results (the run counter, the overlay pins, the retention limit,
 * which two power flows are compared) are those of the tab that wrote last.
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

/** The name of the channel on which the tabs of one address say what they deleted. */
export const RESULTS_CHANNEL_NAME = 'tensa-results';

/** What a tab says once it has deleted a run from the archive. */
export interface RunDeletedMessage {
  type: 'run-deleted';
  runId: string;
}

/** The channel to the other tabs: as much of a ``BroadcastChannel`` as is used. */
export interface ResultsChannel {
  post: (message: RunDeletedMessage) => void;
  /** Hand what the other tabs post to ``handler``. It is not checked: see ``runDeletedIn``. */
  listen: (handler: (message: unknown) => void) => void;
  close: () => void;
}

/** The browser's channel, or ``null`` where it has none or will not open one. */
function openResultsChannel(): ResultsChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    const channel = new BroadcastChannel(RESULTS_CHANNEL_NAME);
    return {
      post: (message) => channel.postMessage(message),
      listen: (handler) => {
        channel.onmessage = (event: MessageEvent<unknown>) => handler(event.data);
      },
      close: () => channel.close(),
    };
  } catch {
    return null;
  }
}

/** The run a message says was deleted, or ``null`` for anything else on the channel. */
function runDeletedIn(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null;
  const { type, runId } = message as Partial<Record<keyof RunDeletedMessage, unknown>>;
  return type === 'run-deleted' && typeof runId === 'string' ? runId : null;
}

export interface ResultsPersistenceOptions {
  /** Opens the archive; ``null`` for a browser that has none. */
  open?: () => Promise<ResultsArchive | null>;
  /** Opens the channel to the other tabs; ``null`` for a browser that has none. */
  channel?: () => ResultsChannel | null;
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
  const openChannel = options.channel ?? openResultsChannel;
  let archive: ResultsArchive | null = null;
  let channel: ResultsChannel | null = null;
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
  // The runs another tab has deleted from the archive. One that this tab still
  // lists stays in this tab only: it is not counted as kept and not written.
  const deletedElsewhere = new Set<string>();

  /** Delete a run from the archive, and tell the other tabs, which may list it as kept. */
  const deleteRun = (runId: string): void => {
    void enqueue((a) => a.deleteRun(runId)).then((deleted) => {
      if (!deleted) return;
      try {
        channel?.post({ type: 'run-deleted', runId });
      } catch {
        // The channel has closed: the page is going.
      }
    });
  };

  const onMessage = (message: unknown): void => {
    const runId = runDeletedIn(message);
    if (runId === null || stopped) return;
    deletedElsewhere.add(runId);
    keptRuns.delete(runId);
    archivedRunIds.delete(runId);
  };

  const syncRuns = (state: RunsState): void => {
    // Once this tab no longer lists such a run either, there is nothing to remember.
    for (const id of deletedElsewhere) {
      if (state.runs[id] === undefined) deletedElsewhere.delete(id);
    }
    for (const id of Object.keys(state.runs)) {
      const run = state.runs[id]!;
      // Nothing to keep of a run that is still going, or that ended with no rows.
      if (!isFinished(run) || run.seqCount === 0) continue;
      if (deletedElsewhere.has(id)) continue;
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
      deleteRun(id);
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
    // Listening before the archive is read: a run another tab deletes while it
    // is being read would otherwise come back counted as kept.
    channel = openChannel();
    channel?.listen(onMessage);

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
        // Deleted by another tab since it was read: neither kept nor to delete.
        if (deletedElsewhere.has(read.runId)) continue;
        const run = runs[read.runId];
        if (run !== undefined && run.seqCount === read.seqCount) {
          keptRuns.set(run.runId, { record: run, seqCount: run.seqCount, t: run.t });
          archivedRunIds.add(run.runId);
        } else {
          deleteRun(read.runId);
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
      for (const id of contents.staleRunIds) deleteRun(id);
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
      // Let the writes in flight finish before the connection and the channel go.
      const closing = archive;
      const closingChannel = channel;
      void queue.then(() => {
        closing?.close();
        closingChannel?.close();
      });
    },
  };
}
