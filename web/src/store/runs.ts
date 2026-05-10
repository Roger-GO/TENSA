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
 * **Retention policy** (Unit 9, v2.0): keep at most ``retentionLimit``
 * total runs retained (default 5, max 20) — the active run counts in
 * the cap. The active run is never *evicted* by the retention policy
 * (it always survives), so when ``retention=N`` and the user is mid-run,
 * we keep up to ``N - 1`` completed runs + 1 active. Still-streaming
 * runs (state=='starting'/'streaming') are also shielded from eviction
 * — the cap is enforced over completed (done/error/aborted) runs only,
 * and the cap is ``retention - <count of active+streaming>``.
 *
 * Per-run memory budget = total budget / retentionLimit (default
 * 200 MB / 5 = 40 MB per run). The per-run budget is informational
 * — the cap-eviction loop above operates on the total budget; the
 * retention policy provides the count cap.
 *
 * On ``resetRun``: evict the run's buffers fully.
 * On a fresh ``startRun`` while the retention limit would be exceeded:
 * evict the oldest completed run.
 *
 * **Overlay state** (Unit 9, v2.0): ``overlayRunIds`` tracks which runs
 * the user has pinned for multi-run plot overlay. The active run is the
 * "anchor" for SLD animation (``activeRunId``), independent of the
 * overlay set. The overlay set is purely a plot-side concern; selectors
 * elsewhere keep using ``activeRunId``.
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
  /**
   * Optional researcher-supplied label for this run (Unit 20, v2.0).
   * Surfaced by the ``RunLegendChip`` and any other run-identifying
   * UI when present; falls back to the auto-generated short-id + tf
   * label otherwise. Session-scoped (never persisted across reloads).
   */
  displayName?: string;
  /**
   * Optional researcher-picked stroke colour override (Unit 20, v2.0).
   * Any valid CSS colour string. When set, ``runIdToColor`` returns
   * this value instead of the hash-derived hue, and the ``TimeSeriesPlot``
   * + ``RunLegendChip`` swatches both pick it up automatically. Session-
   * scoped.
   */
  colorOverride?: string;
}

/** Default initial capacity for typed arrays (one row each on first append). */
const INITIAL_CAPACITY = 256;

/**
 * Default total-memory cap (bytes) for retained run buffers. 200 MB per
 * the v0.2 plan; tunable via :func:`useRunsStore.setState({memoryBudgetBytes})`.
 */
export const DEFAULT_MEMORY_BUDGET_BYTES = 200 * 1024 * 1024;

/**
 * Default count of completed runs to retain (v2.0 multi-run overlay,
 * KTD-8). The active/streaming run is always counted on top of this.
 */
export const DEFAULT_RETENTION_LIMIT = 5;

/** Hard cap on user-configurable retention. Caps memory-pressure surface. */
export const MAX_RETENTION_LIMIT = 20;

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
   * UI components subscribe to ``runs[activeRunId]`` for plot + SLD
   * overlay anchor.
   */
  activeRunId: string | null;
  /**
   * Set of runIds the user has pinned for multi-run plot overlay. The
   * TimeSeriesPlot renders one series family per id in this set. The
   * SLD animation overlay is NOT driven by this set (it always tracks
   * ``activeRunId`` per KTD-8).
   *
   * Empty set + non-null ``activeRunId`` = "implicit single-run mode";
   * the plot defaults to rendering the active run only (the empty set
   * is interpreted as "no explicit overlay; plot the active run"). When
   * the user pins one or more runs, the active run is no longer
   * implicit — only ids actually in the set are rendered.
   */
  overlayRunIds: ReadonlySet<string>;
  /**
   * Maximum number of completed runs to retain. Active/streaming runs
   * are always retained on top of this. User-configurable via
   * ``setRetentionLimit`` (clamped to ``[1, MAX_RETENTION_LIMIT]``).
   */
  retentionLimit: number;

  /**
   * Register a new run on receipt of ``stream_start``. Pre-allocates typed
   * arrays sized to :data:`INITIAL_CAPACITY` per column. Applies the
   * retention policy first so the new run isn't itself a candidate for
   * eviction.
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
   * run" button after an aborted/failed run. Also clears the run from
   * ``overlayRunIds`` if pinned.
   */
  resetRun: (runId: string) => void;

  /** Clear every run (called by the auth-clear cascade in store/index.ts). */
  clearRuns: () => void;

  /**
   * Replace the overlay set wholesale. Caller may pass any iterable of
   * run ids; the store dedups + filters down to ids actually present in
   * the runs map (so a stale id from the History drawer can't pin a
   * vanished run).
   */
  setOverlayRuns: (ids: Iterable<string>) => void;

  /**
   * Add a single run to the overlay set. No-op when the run isn't in
   * the runs map (defensive: prevents stale ids from leaking into the
   * overlay).
   */
  addOverlayRun: (runId: string) => void;

  /** Remove a single run from the overlay set. Idempotent. */
  removeOverlayRun: (runId: string) => void;

  /**
   * Set the retention limit (clamped to ``[1, MAX_RETENTION_LIMIT]``).
   * Re-applies the retention policy immediately so a tightening of the
   * limit evicts excess completed runs.
   */
  setRetentionLimit: (n: number) => void;

  /**
   * Set the per-run human-facing label (Unit 20, v2.0). Trimmed
   * automatically; an empty / whitespace-only value clears the override
   * back to the auto-generated default. No-op when the run id is
   * unknown.
   */
  setRunDisplayName: (runId: string, name: string) => void;

  /**
   * Set the per-run stroke colour override (Unit 20, v2.0). Pass
   * ``null`` or an empty string to clear back to the hash-derived
   * colour. Caller is responsible for validating the colour string
   * (the swatch picker rejects malformed hex inline). No-op when the
   * run id is unknown.
   */
  setRunColorOverride: (runId: string, color: string | null) => void;
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
 * Predicate: a run is "completed" for retention-policy purposes when
 * its lifecycle state has settled. ``starting`` / ``streaming`` runs
 * are still active and are NEVER evicted by the retention policy.
 */
function isCompletedState(state: RunState): boolean {
  return state === 'done' || state === 'error' || state === 'aborted';
}

/**
 * Apply the retention policy: drop the oldest completed runs until the
 * total retained count is ``<= retention``. The active run + any
 * starting/streaming runs are NEVER candidates for eviction; they
 * count toward the cap but can't be removed. So the eligible-for-
 * eviction pool is "completed AND not active" — we evict from this
 * pool (oldest first, by insertion order) until total <= retention.
 *
 * Insertion order = chronological order (preserved for string keys in
 * JS objects). Returns a NEW runs map; mutates nothing on the input.
 */
function applyRetentionPolicy(
  runs: Record<string, RunRecord>,
  retention: number,
  activeRunId: string | null,
): Record<string, RunRecord> {
  const ids = Object.keys(runs);
  if (ids.length <= retention) return runs;
  // Walk in insertion order; collect completed runs (excluding the
  // active id even if it has settled — the active flag shields it).
  const completedIds: string[] = [];
  for (const id of ids) {
    const r = runs[id]!;
    if (id === activeRunId) continue;
    if (!isCompletedState(r.state)) continue;
    completedIds.push(id);
  }
  // We need to drop ``ids.length - retention`` runs total, but only
  // completed-non-active runs are eligible. If there aren't enough
  // eligible runs to bring the total down to the cap, evict as many
  // as we can — the remainder is unavoidable (e.g., 6 still-streaming
  // runs with retention=5 would all stay).
  const dropTarget = ids.length - retention;
  const dropCount = Math.min(dropTarget, completedIds.length);
  if (dropCount === 0) return runs;
  const next = { ...runs };
  for (let i = 0; i < dropCount; i += 1) {
    delete next[completedIds[i]!];
  }
  return next;
}

/**
 * Filter the overlay set down to ids that actually exist in the runs
 * map. Returns the same set instance when no filtering occurred (so
 * downstream ``React.useMemo`` doesn't churn).
 */
function reconcileOverlay(
  overlay: ReadonlySet<string>,
  runs: Record<string, RunRecord>,
): ReadonlySet<string> {
  let stale: string[] | null = null;
  for (const id of overlay) {
    if (!runs[id]) {
      if (stale === null) stale = [];
      stale.push(id);
    }
  }
  if (stale === null) return overlay;
  const next = new Set(overlay);
  for (const id of stale) next.delete(id);
  return next;
}

// ---- store -----------------------------------------------------------------

export const useRunsStore = create<RunsState>((set, get) => ({
  runs: {},
  memoryBudgetBytes: DEFAULT_MEMORY_BUDGET_BYTES,
  activeRunId: null,
  overlayRunIds: new Set<string>(),
  retentionLimit: DEFAULT_RETENTION_LIMIT,

  startRun: ({ runId, tf, columnNames }) => {
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
    // Apply retention AFTER inserting the new run + flipping the active
    // id so the previously-active run (which has just settled into the
    // "completed-non-active" pool) is correctly counted toward the
    // retention cap. The new run is shielded from eviction by passing
    // its id as ``activeRunId``. Still-streaming runs are never evicted
    // by retention regardless.
    const inserted = { ...get().runs, [runId]: record };
    const nextRuns = applyRetentionPolicy(inserted, get().retentionLimit, runId);
    set({
      runs: nextRuns,
      activeRunId: runId,
      overlayRunIds: reconcileOverlay(get().overlayRunIds, nextRuns),
    });
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
    set({
      runs: nextRuns,
      overlayRunIds: reconcileOverlay(get().overlayRunIds, nextRuns),
    });
  },

  markRunDone: (runId, finalT) => {
    const cur = get().runs[runId];
    if (!cur) return;
    // Apply retention policy on completion: the just-completed run now
    // counts toward the completed cap. Pass ``activeRunId`` so the
    // active run (which may be this same id) is shielded from eviction.
    const nextRuns = applyRetentionPolicy(
      {
        ...get().runs,
        [runId]: { ...cur, state: 'done', tCurrent: Math.max(cur.tCurrent, finalT) },
      },
      get().retentionLimit,
      get().activeRunId,
    );
    set({
      runs: nextRuns,
      overlayRunIds: reconcileOverlay(get().overlayRunIds, nextRuns),
    });
  },

  markRunError: (runId, reason) => {
    const cur = get().runs[runId];
    if (!cur) return;
    const nextRuns = applyRetentionPolicy(
      {
        ...get().runs,
        [runId]: { ...cur, state: 'error', errorReason: reason },
      },
      get().retentionLimit,
      get().activeRunId,
    );
    set({
      runs: nextRuns,
      overlayRunIds: reconcileOverlay(get().overlayRunIds, nextRuns),
    });
  },

  markRunAborted: (runId) => {
    const cur = get().runs[runId];
    if (!cur) return;
    const nextRuns = applyRetentionPolicy(
      {
        ...get().runs,
        [runId]: { ...cur, state: 'aborted' },
      },
      get().retentionLimit,
      get().activeRunId,
    );
    set({
      runs: nextRuns,
      overlayRunIds: reconcileOverlay(get().overlayRunIds, nextRuns),
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
    set({
      runs: next,
      activeRunId: nextActive,
      overlayRunIds: reconcileOverlay(get().overlayRunIds, next),
    });
  },

  clearRuns: () => set({ runs: {}, activeRunId: null, overlayRunIds: new Set<string>() }),

  setOverlayRuns: (ids) => {
    const runs = get().runs;
    const next = new Set<string>();
    for (const id of ids) {
      if (runs[id]) next.add(id);
    }
    set({ overlayRunIds: next });
  },

  addOverlayRun: (runId) => {
    if (!get().runs[runId]) return;
    const next = new Set(get().overlayRunIds);
    next.add(runId);
    set({ overlayRunIds: next });
  },

  removeOverlayRun: (runId) => {
    if (!get().overlayRunIds.has(runId)) return;
    const next = new Set(get().overlayRunIds);
    next.delete(runId);
    set({ overlayRunIds: next });
  },

  setRetentionLimit: (n) => {
    const clamped = Math.max(1, Math.min(MAX_RETENTION_LIMIT, Math.floor(n)));
    if (clamped === get().retentionLimit) return;
    const nextRuns = applyRetentionPolicy(get().runs, clamped, get().activeRunId);
    set({
      retentionLimit: clamped,
      runs: nextRuns,
      overlayRunIds: reconcileOverlay(get().overlayRunIds, nextRuns),
    });
  },

  setRunDisplayName: (runId, name) => {
    const cur = get().runs[runId];
    if (!cur) return;
    const trimmed = name.trim();
    // Skip the update when nothing is actually changing — keeps Zustand
    // subscribers from churning on no-op blur commits.
    const nextDisplayName = trimmed.length === 0 ? undefined : trimmed;
    if (cur.displayName === nextDisplayName) return;
    const nextRecord: RunRecord = { ...cur };
    if (nextDisplayName === undefined) delete nextRecord.displayName;
    else nextRecord.displayName = nextDisplayName;
    set({
      runs: {
        ...get().runs,
        [runId]: nextRecord,
      },
    });
  },

  setRunColorOverride: (runId, color) => {
    const cur = get().runs[runId];
    if (!cur) return;
    const next = color === null || color.trim().length === 0 ? undefined : color;
    if (cur.colorOverride === next) return;
    const nextRecord: RunRecord = { ...cur };
    if (next === undefined) delete nextRecord.colorOverride;
    else nextRecord.colorOverride = next;
    set({
      runs: {
        ...get().runs,
        [runId]: nextRecord,
      },
    });
  },
}));

// Test-only: re-export internal helpers for the runs.test.ts assertions on
// growth / eviction math without exposing them as part of the public API.
export const __internal = {
  growFloat64,
  runBytes,
  totalBytes,
  evictHead,
  applyCapEviction,
  applyRetentionPolicy,
  reconcileOverlay,
  isCompletedState,
  INITIAL_CAPACITY,
  ACTIVE_RUN_EVICT_FRACTION,
};
