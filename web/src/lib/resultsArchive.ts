/**
 * The results this browser keeps between visits: the finished time-domain runs
 * and the power flows kept for comparison, in an IndexedDB database.
 *
 * Why IndexedDB and not ``localStorage``, which holds the layout and the recent
 * cases: a run is typed arrays of samples, tens of megabytes on a large case,
 * and ``localStorage`` takes strings up to about 5 MB in all. IndexedDB stores
 * a ``Float64Array`` as it is.
 *
 * This module only reads and writes. What is written when, and what is done
 * with what is read back, is ``store/resultsPersistence.ts``.
 *
 * Layout (version 1):
 *
 * - ``runs``: one record per finished run, without its samples
 *   (``ArchivedRunMeta``, keyed by ``runId``). Renaming a run rewrites this and
 *   not the samples.
 * - ``run-data``: the samples of a run (``ArchivedRunData``, keyed by
 *   ``runId``), cut to the rows the run holds.
 * - ``pflow``: one record per kept power flow (``PflowSnapshot``, keyed by
 *   ``id``).
 * - ``state``: the small values that go with them, under the keys ``runs`` (the
 *   run counter, the overlay pins, the retention limit) and ``pflow`` (the
 *   counter and which two are compared).
 *
 * The database belongs to the page's origin, so every tab on one server address
 * shares it, like the recent cases (what two tabs open at once do to each
 * other's results is in ``store/resultsPersistence.ts``), and so would anything
 * else served from that address later (``SECURITY.md``). What is written is results and the
 * labels that go with them: samples, solved values, element and case names, the
 * names the user gave. No request, no path and no error text of the server.
 * A browser without IndexedDB, or one that refuses it (some private modes),
 * gets ``null`` from ``openResultsArchive`` and the results stay in the tab as
 * before.
 */
import type { PflowHistoryPayload, PflowSnapshot } from '@/store/pflowHistory';
import type { RunRecord, RunState } from '@/store/runs';
import { isFiniteNumber } from '@/lib/finite';

export const RESULTS_DB_NAME = 'tensa-results';
export const RESULTS_DB_VERSION = 1;

const RUNS = 'runs';
const RUN_DATA = 'run-data';
const PFLOW = 'pflow';
const STATE = 'state';
const STORES = [RUNS, RUN_DATA, PFLOW, STATE] as const;

const RUNS_STATE_KEY = 'runs';
const PFLOW_STATE_KEY = 'pflow';

/** A finished run without its samples. */
export type ArchivedRunMeta = Omit<RunRecord, 't' | 'columns'>;

/** The samples of a run: the time column and each variable column, of one length. */
export interface ArchivedRunData {
  runId: string;
  t: Float64Array;
  columns: Record<string, Float64Array>;
}

/** What is kept of the runs slice besides the runs. */
export interface ArchivedRunsState {
  runCount: number;
  /** The runs pinned to the plot overlay. */
  overlayRunIds: string[];
  retentionLimit: number;
}

/** What is kept of the power-flow history besides the results. */
export type ArchivedPflowState = Pick<PflowHistoryPayload, 'count' | 'baselineId' | 'comparedId'>;

export interface ArchiveContents {
  /** Oldest first. A run whose record or samples did not read back whole is left out. */
  runs: RunRecord[];
  runsState: ArchivedRunsState | null;
  /** Oldest first. */
  pflow: PflowSnapshot[];
  pflowState: ArchivedPflowState | null;
  /**
   * The ids of what is stored but did not read back as a run or a power flow:
   * a record with a field missing or of another kind, samples without their
   * record. They are of no use and can be deleted.
   */
  staleRunIds: string[];
  stalePflowIds: string[];
}

export interface ResultsArchive {
  read: () => Promise<ArchiveContents>;
  /** Write a run with its samples, replacing what was kept under its id. */
  putRun: (run: RunRecord) => Promise<void>;
  /** Write a run's record only: its name, colour or state changed, its samples did not. */
  putRunMeta: (run: RunRecord) => Promise<void>;
  deleteRun: (runId: string) => Promise<void>;
  putRunsState: (state: ArchivedRunsState) => Promise<void>;
  putPflow: (snapshot: PflowSnapshot) => Promise<void>;
  deletePflow: (id: string) => Promise<void>;
  putPflowState: (state: ArchivedPflowState) => Promise<void>;
  close: () => void;
}

const FINISHED: ReadonlySet<RunState> = new Set(['done', 'error', 'aborted']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * A ``Float64Array`` wherever it was made. What a database hands back need not
 * come from this page's own ``Float64Array`` constructor, which is all
 * ``instanceof`` would accept.
 */
function isFloat64Array(value: unknown): value is Float64Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Float64Array]'
  );
}

/**
 * The record of a run without its samples, as it is stored. The reason a run
 * failed is left out: it is the server's own error text, which the jobs slice
 * keeps out of browser storage too (``store/jobs.ts``), and nothing shows it
 * for a run that is no longer the active one. The run comes back marked as
 * failed, with what it had streamed.
 */
export function runMetaOf(run: RunRecord): ArchivedRunMeta {
  const { t: _t, columns: _columns, ...meta } = run;
  return { ...meta, errorReason: null };
}

/**
 * The samples of a run, copied and cut to the rows it holds. The arrays in the
 * store are over-allocated (they double as the run grows), and a view of one
 * would be stored with the whole buffer behind it.
 */
export function runDataOf(run: RunRecord): ArchivedRunData {
  const columns: Record<string, Float64Array> = {};
  for (const name of run.columnNames) {
    const column = run.columns[name];
    if (column !== undefined) columns[name] = column.slice(0, run.seqCount);
  }
  return { runId: run.runId, t: run.t.slice(0, run.seqCount), columns };
}

/**
 * Put a stored record and its samples back together, or ``null`` when either
 * is not what this version writes (a record from a newer or an older build, a
 * write that was cut short). Only a finished run is ever stored.
 */
export function runFromArchive(meta: unknown, data: unknown): RunRecord | null {
  if (!isRecord(meta) || !isRecord(data)) return null;
  const { runId, seqCount, columnNames, state } = meta;
  if (typeof runId !== 'string' || runId.length === 0 || data.runId !== runId) return null;
  if (!isFiniteNumber(seqCount) || !Number.isInteger(seqCount) || seqCount < 0) return null;
  if (!Array.isArray(columnNames) || !columnNames.every((n) => typeof n === 'string')) return null;
  if (typeof state !== 'string' || !FINISHED.has(state as RunState)) return null;
  if (!isFiniteNumber(meta.startedAt) || !isFiniteNumber(meta.tf)) return null;
  if (!isFiniteNumber(meta.tCurrent)) return null;
  const t = data.t;
  if (!isFloat64Array(t) || t.length !== seqCount) return null;
  if (!isRecord(data.columns)) return null;
  const columns: Record<string, Float64Array> = {};
  for (const name of columnNames as string[]) {
    const column = data.columns[name];
    if (!isFloat64Array(column) || column.length !== seqCount) return null;
    columns[name] = column;
  }
  return { ...(meta as unknown as ArchivedRunMeta), t, columns };
}

function isPflowSnapshot(value: unknown): value is PflowSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (!isFiniteNumber(value.ordinal) || !isFiniteNumber(value.takenAt)) return false;
  if (typeof value.caseName !== 'string') return false;
  if (value.name !== undefined && typeof value.name !== 'string') return false;
  const { result, names } = value;
  if (!isRecord(result) || result.converged !== true) return false;
  // What is printed of how it converged, as numbers and not as whatever is there.
  if (typeof result.iterations !== 'number' || typeof result.mismatch !== 'number') return false;
  if (!isRecord(result.bus_voltages) || !isRecord(result.bus_angles)) return false;
  if (!isRecord(names)) return false;
  return ['buses', 'lines', 'generators', 'loads'].every((bucket) => isRecord(names[bucket]));
}

function runsStateFrom(value: unknown): ArchivedRunsState | null {
  if (!isRecord(value)) return null;
  const { runCount, overlayRunIds, retentionLimit } = value;
  if (!isFiniteNumber(runCount) || !isFiniteNumber(retentionLimit)) return null;
  if (!Array.isArray(overlayRunIds) || !overlayRunIds.every((id) => typeof id === 'string')) {
    return null;
  }
  return { runCount, overlayRunIds: overlayRunIds as string[], retentionLimit };
}

function pflowStateFrom(value: unknown): ArchivedPflowState | null {
  if (!isRecord(value)) return null;
  const { count, baselineId, comparedId } = value;
  if (!isFiniteNumber(count)) return null;
  const idOrNull = (id: unknown): id is string | null => id === null || typeof id === 'string';
  if (!idOrNull(baselineId) || !idOrNull(comparedId)) return null;
  return { count, baselineId, comparedId };
}

/** A request as a promise of its result. */
function requested<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction has committed, which is when its writes are on disk. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted'));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(RESULTS_DB_NAME, RESULTS_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RUNS)) db.createObjectStore(RUNS, { keyPath: 'runId' });
      if (!db.objectStoreNames.contains(RUN_DATA)) {
        db.createObjectStore(RUN_DATA, { keyPath: 'runId' });
      }
      if (!db.objectStoreNames.contains(PFLOW)) db.createObjectStore(PFLOW, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    // Another tab holds an older version open and will not let go.
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

/** The browser's IndexedDB, or ``null`` where there is none or reading it throws. */
function defaultFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

/**
 * Open the archive. ``null`` when the browser has no IndexedDB or will not open
 * the database: the caller then keeps nothing between visits.
 */
export async function openResultsArchive(
  factory: IDBFactory | null = defaultFactory(),
): Promise<ResultsArchive | null> {
  if (factory === null) return null;
  let db: IDBDatabase;
  try {
    db = await openDatabase(factory);
  } catch {
    return null;
  }
  // A later version opened in another tab needs this connection out of its way.
  db.onversionchange = () => db.close();

  /** One write, as its own transaction. */
  const write = async (
    stores: readonly string[],
    work: (transaction: IDBTransaction) => void,
  ): Promise<void> => {
    const transaction = db.transaction([...stores], 'readwrite');
    const done = committed(transaction);
    try {
      work(transaction);
    } catch (err) {
      // A value that cannot be stored throws here, before anything is queued.
      // Give the transaction up, and let the caller have the reason it threw.
      done.catch(() => undefined);
      try {
        transaction.abort();
      } catch {
        // Already finished or aborted.
      }
      throw err;
    }
    await done;
  };

  return {
    read: async () => {
      const transaction = db.transaction([...STORES], 'readonly');
      const [metas, datas, snapshots, runsState, pflowState] = await Promise.all([
        requested(transaction.objectStore(RUNS).getAll() as IDBRequest<unknown[]>),
        requested(transaction.objectStore(RUN_DATA).getAll() as IDBRequest<unknown[]>),
        requested(transaction.objectStore(PFLOW).getAll() as IDBRequest<unknown[]>),
        requested(transaction.objectStore(STATE).get(RUNS_STATE_KEY) as IDBRequest<unknown>),
        requested(transaction.objectStore(STATE).get(PFLOW_STATE_KEY) as IDBRequest<unknown>),
      ]);
      // Every stored record has its key in it (the stores are keyed by a path).
      const storedRunIds = new Set<string>();
      const dataById = new Map<string, unknown>();
      for (const data of datas) {
        if (!isRecord(data) || typeof data.runId !== 'string') continue;
        storedRunIds.add(data.runId);
        dataById.set(data.runId, data);
      }
      const runs: RunRecord[] = [];
      for (const meta of metas) {
        if (!isRecord(meta) || typeof meta.runId !== 'string') continue;
        storedRunIds.add(meta.runId);
        const run = runFromArchive(meta, dataById.get(meta.runId));
        if (run !== null) runs.push(run);
      }
      runs.sort((a, b) => a.startedAt - b.startedAt);
      const readRunIds = new Set(runs.map((r) => r.runId));
      const pflow = snapshots.filter(isPflowSnapshot).sort((a, b) => a.ordinal - b.ordinal);
      const readPflowIds = new Set(pflow.map((s) => s.id));
      const stalePflowIds: string[] = [];
      for (const snapshot of snapshots) {
        if (!isRecord(snapshot) || typeof snapshot.id !== 'string') continue;
        if (!readPflowIds.has(snapshot.id)) stalePflowIds.push(snapshot.id);
      }
      return {
        runs,
        runsState: runsStateFrom(runsState),
        pflow,
        pflowState: pflowStateFrom(pflowState),
        staleRunIds: [...storedRunIds].filter((id) => !readRunIds.has(id)),
        stalePflowIds,
      };
    },

    putRun: (run) =>
      write([RUNS, RUN_DATA], (transaction) => {
        transaction.objectStore(RUNS).put(runMetaOf(run));
        transaction.objectStore(RUN_DATA).put(runDataOf(run));
      }),

    putRunMeta: (run) =>
      write([RUNS], (transaction) => {
        transaction.objectStore(RUNS).put(runMetaOf(run));
      }),

    deleteRun: (runId) =>
      write([RUNS, RUN_DATA], (transaction) => {
        transaction.objectStore(RUNS).delete(runId);
        transaction.objectStore(RUN_DATA).delete(runId);
      }),

    putRunsState: (state) =>
      write([STATE], (transaction) => {
        transaction.objectStore(STATE).put(state, RUNS_STATE_KEY);
      }),

    putPflow: (snapshot) =>
      write([PFLOW], (transaction) => {
        transaction.objectStore(PFLOW).put(snapshot);
      }),

    deletePflow: (id) =>
      write([PFLOW], (transaction) => {
        transaction.objectStore(PFLOW).delete(id);
      }),

    putPflowState: (state) =>
      write([STATE], (transaction) => {
        transaction.objectStore(STATE).put(state, PFLOW_STATE_KEY);
      }),

    close: () => db.close(),
  };
}
