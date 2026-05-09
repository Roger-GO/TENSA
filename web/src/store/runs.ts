/**
 * TDS runs slice. Keyed by ``run_id`` (server-assigned, arrives in the
 * ``stream_start`` WebSocket message). Each entry holds the streamed
 * frames as typed-array columns:
 *
 * - ``t``: ``Float64Array`` of timestamps (seconds since sim start)
 * - ``columns``: ``Record<string, Float64Array>`` for each variable column
 *   (``Bus_<idx>_v``, ``Gen_<idx>_omega``, ``Line_<idx>_p``, ...). The
 *   exact set is decided by the ``vars`` flag in ``start_tds`` and surfaced
 *   in the ``stream_start.metadata.var_columns`` list.
 *
 * The storage is **columnar typed-array**, not an array of objects, for
 * the reasons documented in the v0.2 plan ("Decoded frame storage —
 * typed-array columnar layout"): JS object overhead would 5–10× the memory
 * cost. Geometric growth (double on overflow, starting at 256 rows) keeps
 * append amortized-O(1).
 *
 * **Frame buffer cap** (single source of truth per the v0.2 plan): the cap
 * lives here as a total-memory budget over all retained runs. On insert,
 * if the running total exceeds the cap:
 *
 * 1. Evict completed runs' frames first (oldest completed first).
 * 2. If no completed runs exist, drop the oldest 10% of the active run's
 *    frames + emit a ``connectionStatus: "lagged"`` event so the UI can
 *    surface a non-modal toast.
 *
 * Comparison-runs eviction policy: keep at most 1 completed + 1 active
 * run. (No comparison overlay in v0.2 → no need for more.)
 *
 * On ``resetRun``: evict the run's buffers fully.
 * On a fresh ``startRun`` while a previous run is still in store: evict
 * the oldest.
 *
 * Lifecycle: cleared on auth clear (cross-slice cascade in
 * ``store/index.ts``). Cleared on session change. Run frames are NOT
 * persisted — they only matter for the current page.
 */
import { create } from 'zustand';

/** Run lifecycle state (mirrors plan: starting → streaming → done/error/aborted). */
export type RunState = 'starting' | 'streaming' | 'done' | 'error' | 'aborted';

/** WebSocket connection status as observed by ``RunStream``. */
export type RunConnectionStatus = 'connected' | 'reconnecting' | 'disconnected' | 'lagged';

/**
 * Per-run state. ``t`` and each ``columns`` entry are typed arrays whose
 * **logical length** is ``seq_count`` — they may be over-allocated (geometric
 * growth) so callers MUST slice/use ``seq_count`` rather than reading
 * ``.length``.
 */
export interface RunRecord {
  runId: string;
  startedAt: number;
  /** Final sim time (seconds) requested via ``start_tds.tf``. */
  tf: number;
  /** Latest frame's t (seconds). 0 before the first frame arrives. */
  tCurrent: number;
  /**
   * Number of rows decoded so far. Equals the count of frames-worth-of-rows;
   * doubles as ``last_seq`` for resume bookkeeping (see ``RunStream``).
   * NOTE: this is **rows**, not WS binary messages — a single binary message
   * can carry multiple rows when the server batches.
   */
  seqCount: number;
  t: Float64Array;
  /** Variable columns, parallel arrays of length ``seqCount``. */
  columns: Record<string, Float64Array>;
  /** Column names in stream-metadata order (excluding ``t``). */
  columnNames: readonly string[];
  state: RunState;
  connection: RunConnectionStatus;
  /**
   * Set true when the UI initiated abort. The runs store has no opinion
   * about this flag — it exists so the UI can distinguish "user-aborted"
   * from "numerical instability" when state becomes done with
   * ``final_t < tf`` (see Unit 7 of the plan).
   */
  abortedLocally: boolean;
  /** Optional human-facing reason when ``state === "error"``. */
  errorReason: string | null;
}

/** Default initial capacity for typed arrays (one row each on first append). */
const INITIAL_CAPACITY = 256;

/**
 * Default total-memory cap (bytes) for retained run buffers. 200 MB per
 * the v0.2 plan; tunable via :func:`useRunsStore.setState({memoryBudgetBytes})`.
 */
export const DEFAULT_MEMORY_BUDGET_BYTES = 200 * 1024 * 1024;

/**
 * Drop-fraction applied to the active run when no completed runs are
 * available for eviction. 10% per the v0.2 plan.
 */
const ACTIVE_RUN_EVICT_FRACTION = 0.1;

export interface AppendFramePayload {
  /** Time column for this frame's rows. */
  t: Float64Array;
  /** Variable columns for this frame's rows (parallel to ``t``). */
  columns: Record<string, Float64Array>;
}

export interface StartRunPayload {
  runId: string;
  tf: number;
  /**
   * Variable column names in stream-metadata order. The store pre-allocates
   * one ``Float64Array`` per name so subsequent appends don't have to
   * branch on first-touch.
   */
  columnNames: readonly string[];
}

export interface RunsState {
  /** Map run_id → record. Insertion order = chronological start order. */
  runs: Record<string, RunRecord>;
  /** Memory budget for typed-array storage across all retained runs. */
  memoryBudgetBytes: number;
  /**
   * Active run id (the one currently streaming or most recently created).
   * UI components subscribe to ``runs[activeRunId]`` for plot + overlay.
   */
  activeRunId: string | null;

  /**
   * Register a new run on receipt of ``stream_start``. Pre-allocates typed
   * arrays sized to :data:`INITIAL_CAPACITY` per column. If a previous run
   * is in the store and the comparison-runs limit (1 active + 1 completed)
   * would be exceeded, evicts the oldest.
   */
  startRun: (payload: StartRunPayload) => void;

  /** Append rows from one decoded Arrow batch. Triggers cap-eviction if needed. */
  appendFrame: (runId: string, payload: AppendFramePayload) => void;

  /** Mark a run done (clean exit). ``finalT`` is from the WS ``done`` message. */
  markRunDone: (runId: string, finalT: number) => void;

  /** Mark a run error. ``reason`` is surfaced in the error banner. */
  markRunError: (runId: string, reason: string) => void;

  /** Mark a run aborted (the UI sets this after server confirms abort). */
  markRunAborted: (runId: string) => void;

  /** Update connection status for a run. ``"lagged"`` is set internally on cap eviction. */
  setRunConnection: (runId: string, status: RunConnectionStatus) => void;

  /** Set the abortedLocally flag (used by UI before ``markRunAborted``). */
  setAbortedLocally: (runId: string, value: boolean) => void;

  /**
   * Drop a run completely (frame buffers freed). Used by the UI's "Reset
   * run" button after an aborted/failed run.
   */
  resetRun: (runId: string) => void;

  /** Clear every run (called by the auth-clear cascade in store/index.ts). */
  clearRuns: () => void;
}

// ---- internal helpers -----------------------------------------------------

/**
 * Grow a typed array to at least ``minCapacity``, doubling each step. The
 * current logical length is preserved; the new array's tail is uninitialized
 * (which is fine — callers always overwrite from index ``length`` upward).
 */
function growFloat64(arr: Float64Array, minCapacity: number): Float64Array {
  let cap = arr.length === 0 ? INITIAL_CAPACITY : arr.length;
  while (cap < minCapacity) cap *= 2;
  const next = new Float64Array(cap);
  next.set(arr);
  return next;
}

/**
 * Returns the byte size of a run's typed-array storage. The over-allocated
 * tail counts — that's the actual heap footprint, not the logical length.
 */
function runBytes(run: RunRecord): number {
  let bytes = run.t.byteLength;
  for (const name of Object.keys(run.columns)) {
    bytes += run.columns[name]!.byteLength;
  }
  return bytes;
}

/**
 * Total typed-array storage across all retained runs (over-allocated tails
 * counted — that's the actual heap footprint, not just logical length).
 */
function totalBytes(runs: Record<string, RunRecord>): number {
  let bytes = 0;
  for (const id of Object.keys(runs)) bytes += runBytes(runs[id]!);
  return bytes;
}

/**
 * Drop the leading ``dropRows`` rows of every column in a run, in place.
 * Returns a NEW ``RunRecord`` with shrunken arrays (typed arrays are
 * immutable in length, so this allocates fresh ones at exactly
 * ``seqCount - dropRows`` capacity to release the freed bytes back to the
 * GC).
 */
function evictHead(run: RunRecord, dropRows: number): RunRecord {
  const remaining = Math.max(0, run.seqCount - dropRows);
  const t = new Float64Array(remaining);
  t.set(run.t.subarray(dropRows, run.seqCount));
  const columns: Record<string, Float64Array> = {};
  for (const name of run.columnNames) {
    const col = run.columns[name]!;
    const next = new Float64Array(remaining);
    next.set(col.subarray(dropRows, run.seqCount));
    columns[name] = next;
  }
  return { ...run, t, columns, seqCount: remaining };
}

/**
 * Apply the cap-eviction policy after a fresh insert. Returns the next
 * runs map. Mutates nothing on the input. May set the active run's
 * ``connection`` to ``"lagged"`` when active-run eviction kicks in.
 */
function applyCapEviction(
  runs: Record<string, RunRecord>,
  budget: number,
  activeRunId: string | null,
): Record<string, RunRecord> {
  let total = totalBytes(runs);
  if (total <= budget) return runs;

  let next: Record<string, RunRecord> = { ...runs };

  // Step 1: drop completed runs' frames first (oldest first).
  // Insertion order in JS objects is preserved for string keys.
  const completed = Object.keys(next).filter(
    (id) => next[id]!.state !== 'starting' && next[id]!.state !== 'streaming' && id !== activeRunId,
  );
  for (const id of completed) {
    if (total <= budget) break;
    const dropped = next[id]!;
    delete next[id];
    total -= runBytes(dropped);
  }

  // Step 2: still over? Drop oldest 10 % of the active run's rows and
  // mark the run as ``"lagged"`` so the UI surfaces a toast.
  if (total > budget && activeRunId !== null && next[activeRunId]) {
    const active = next[activeRunId]!;
    const dropRows = Math.max(1, Math.floor(active.seqCount * ACTIVE_RUN_EVICT_FRACTION));
    const shrunk = evictHead(active, dropRows);
    next = { ...next, [activeRunId]: { ...shrunk, connection: 'lagged' } };
  }

  return next;
}

/**
 * Comparison-runs cap: keep at most 1 active + 1 completed run. Called
 * before inserting a new run in :func:`startRun`.
 */
function trimToComparisonLimit(runs: Record<string, RunRecord>): Record<string, RunRecord> {
  const ids = Object.keys(runs);
  if (ids.length <= 1) return runs;
  // Drop the oldest until at most 1 remains. The new run will be added
  // afterwards by the caller, leaving 1-active-from-the-new-call + 1
  // completed-from-the-prior-call at most.
  const next = { ...runs };
  while (Object.keys(next).length > 1) {
    const oldest = Object.keys(next)[0]!;
    delete next[oldest];
  }
  return next;
}

// ---- store -----------------------------------------------------------------

export const useRunsStore = create<RunsState>((set, get) => ({
  runs: {},
  memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  activeRunId: null,

  startRun: ({ runId, tf, columnNames }) => {
    const trimmed = trimToComparisonLimit(get().runs);
    const columns: Record<string, Float64Array> = {};
    for (const name of columnNames) columns[name] = new Float64Array(0);
    const record: RunRecord = {
      runId,
      startedAt: Date.now(),
      tf,
      tCurrent: 0,
      seqCount: 0,
      t: new Float64Array(0),
      columns,
      columnNames: [...columnNames],
      state: 'starting',
      connection: 'connected',
      abortedLocally: false,
      errorReason: null,
    };
    set({ runs: { ...trimmed, [runId]: record }, activeRunId: runId });
  },

  appendFrame: (runId, { t, columns }) => {
    const cur = get().runs[runId];
    if (!cur) {
      // Defensive: a frame arrived for a run we don't know about. Drop
      // and return — RunStream is responsible for warning at the call site.
      return;
    }
    const addedRows = t.length;
    if (addedRows === 0) return;
    const nextSeq = cur.seqCount + addedRows;

    // Grow ``t``.
    let nextT = cur.t;
    if (nextSeq > nextT.length) nextT = growFloat64(nextT, nextSeq);
    // ``set`` is the typed-array equivalent of memcpy. Free in V8.
    nextT.set(t, cur.seqCount);

    // Grow + copy each column. We iterate the ``cur.columnNames`` list (the
    // run's authoritative column set) — frames that include unknown
    // columns are simply ignored (forward-compat: a future schema field
    // that the runs store doesn't pre-allocate is still preserved on the
    // ``DecodedFrame`` and could be surfaced separately, but the runs
    // slice's columnar storage is fixed at start_tds time).
    const nextCols: Record<string, Float64Array> = { ...cur.columns };
    for (const name of cur.columnNames) {
      const incoming = columns[name];
      if (!incoming) continue;
      let arr = nextCols[name]!;
      if (nextSeq > arr.length) arr = growFloat64(arr, nextSeq);
      arr.set(incoming, cur.seqCount);
      nextCols[name] = arr;
    }

    // Latest t (last value of the t-column). For monotonic streams this
    // is also the maximum.
    const tCurrent = t[addedRows - 1] ?? cur.tCurrent;

    const updated: RunRecord = {
      ...cur,
      t: nextT,
      columns: nextCols,
      seqCount: nextSeq,
      tCurrent,
      state: cur.state === 'starting' ? 'streaming' : cur.state,
    };

    const nextRuns = applyCapEviction(
      { ...get().runs, [runId]: updated },
      get().memoryBudgetBytes,
      runId,
    );
    set({ runs: nextRuns });
  },

  markRunDone: (runId, finalT) => {
    const cur = get().runs[runId];
    if (!cur) return;
    set({
      runs: {
        ...get().runs,
        [runId]: { ...cur, state: 'done', tCurrent: Math.max(cur.tCurrent, finalT) },
      },
    });
  },

  markRunError: (runId, reason) => {
    const cur = get().runs[runId];
    if (!cur) return;
    set({
      runs: {
        ...get().runs,
        [runId]: { ...cur, state: 'error', errorReason: reason },
      },
    });
  },

  markRunAborted: (runId) => {
    const cur = get().runs[runId];
    if (!cur) return;
    set({
      runs: {
        ...get().runs,
        [runId]: { ...cur, state: 'aborted' },
      },
    });
  },

  setRunConnection: (runId, status) => {
    const cur = get().runs[runId];
    if (!cur) return;
    set({
      runs: {
        ...get().runs,
        [runId]: { ...cur, connection: status },
      },
    });
  },

  setAbortedLocally: (runId, value) => {
    const cur = get().runs[runId];
    if (!cur) return;
    set({
      runs: {
        ...get().runs,
        [runId]: { ...cur, abortedLocally: value },
      },
    });
  },

  resetRun: (runId) => {
    const next = { ...get().runs };
    delete next[runId];
    const nextActive = get().activeRunId === runId ? null : get().activeRunId;
    set({ runs: next, activeRunId: nextActive });
  },

  clearRuns: () => set({ runs: {}, activeRunId: null }),
}));

// Test-only: re-export internal helpers for the runs.test.ts assertions on
// growth / eviction math without exposing them as part of the public API.
export const __internal = {
  growFloat64,
  runBytes,
  totalBytes,
  evictHead,
  applyCapEviction,
  trimToComparisonLimit,
  INITIAL_CAPACITY,
  ACTIVE_RUN_EVICT_FRACTION,
};
