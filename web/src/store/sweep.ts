/**
 * Sweep slice (Unit 18 of the v2.0 plan).
 *
 * The sweep store is intentionally **separate from the runs slice**:
 * runs caps at 5-20 retained TDS runs (KTD-8) for memory pressure,
 * but a sweep keeps every iteration's result so the user can browse
 * the whole parameter sweep without losing data. A sweep with 50
 * iterations would blow the runs cap on its own; routing sweep
 * results into a separate store keeps both concerns clean.
 *
 * Per-iteration results are minimal: ``parameter_value`` + ``converged``
 * + ``final_t`` + ``callpert_count`` + optional ``error``. Full per-step
 * state would balloon memory at 50 iterations × N seconds × M
 * variables × 120 Hz; the sweep is a coarse-grained sensitivity tool,
 * not a full per-iteration time-series store.
 *
 * Lifecycle: not persisted across sessions. Cleared on session change /
 * auth clear via the cross-slice cascade in ``src/store/index.ts``.
 */
import { create } from 'zustand';

/** Sweep lifecycle state mirrors the substrate buffer's state machine. */
export type SweepState = 'pending' | 'running' | 'completed' | 'error' | 'aborted';

/** One iteration's outcome. Mirrors `SweepIterationResult` on the substrate. */
export interface SweepIteration {
  iteration: number;
  parameter_value: number;
  converged: boolean;
  final_t: number;
  callpert_count: number;
  error: string | null;
}

/** Per-sweep record, keyed by `sweepId` in the store. */
export interface SweepRecord {
  sweepId: string;
  parameterKind: string;
  /**
   * For v2.0 the target identifier is the disturbance index (zero-based)
   * the sweep mutates inside the snapshot's recorded log. The UI surfaces
   * this in the progress panel so the user can recall what they're sweeping.
   */
  parameterTarget: number;
  snapshotName: string;
  total: number;
  state: SweepState;
  /** Per-iteration results, ordered by iteration index (always 0..N). */
  iterations: SweepIteration[];
  /** ``true`` when the sweep was cancelled before all iterations completed. */
  truncated: boolean;
  /** Substrate-side error, ``{category, detail}`` or null. */
  error: { category: string; detail: string } | null;
  /** Local timestamp when the sweep started (ms). */
  startedAt: number;
}

export interface SweepStartPayload {
  sweepId: string;
  parameterKind: string;
  parameterTarget: number;
  snapshotName: string;
  total: number;
}

export interface SweepStoreState {
  /**
   * Map sweepId → record. Insertion order = chronological start order.
   */
  sweeps: Record<string, SweepRecord>;
  /**
   * Currently-active sweep id. Set by ``startSweep``; cleared when the
   * sweep transitions to a terminal state via ``markSweepFinished``.
   * The UI uses this to surface a global "Sweep in progress" banner +
   * to drive the sweep-results viewer.
   */
  activeSweepId: string | null;

  /** Register a new sweep on receipt of the start-sweep response. */
  startSweep: (payload: SweepStartPayload) => void;
  /** Append (or update) one iteration's result. */
  appendIteration: (sweepId: string, iter: SweepIteration) => void;
  /**
   * Mark a sweep as finished. ``state`` is one of "completed" / "error"
   * / "aborted"; ``truncated`` matches the substrate's flag. Clears
   * ``activeSweepId`` when the finished sweep was the active one.
   */
  markSweepFinished: (
    sweepId: string,
    state: 'completed' | 'error' | 'aborted',
    extra?: {
      truncated?: boolean;
      error?: { category: string; detail: string } | null;
    },
  ) => void;
  /**
   * Drop a sweep completely (full record + iterations freed). Used by
   * the History drawer's per-sweep "Reset" button.
   */
  resetSweep: (sweepId: string) => void;
  /** Clear every sweep (called by the auth-clear cascade in store/index.ts). */
  clearSweeps: () => void;
  /**
   * Set the active sweep id directly. Used when the user clicks a
   * historical sweep in the History drawer to bring it into the
   * results viewer; the sweep's state is unchanged.
   */
  setActiveSweep: (sweepId: string | null) => void;
}

export const useSweepStore = create<SweepStoreState>((set, get) => ({
  sweeps: {},
  activeSweepId: null,

  startSweep: ({ sweepId, parameterKind, parameterTarget, snapshotName, total }) => {
    const record: SweepRecord = {
      sweepId,
      parameterKind,
      parameterTarget,
      snapshotName,
      total,
      state: 'pending',
      iterations: [],
      truncated: false,
      error: null,
      startedAt: Date.now(),
    };
    set({
      sweeps: { ...get().sweeps, [sweepId]: record },
      activeSweepId: sweepId,
    });
  },

  appendIteration: (sweepId, iter) => {
    const cur = get().sweeps[sweepId];
    if (!cur) return;
    // Dedup by iteration index — the WS may replay early iterations
    // when the client attaches mid-sweep. Replace if present, else
    // append.
    const existing = cur.iterations.findIndex((i) => i.iteration === iter.iteration);
    let nextIters: SweepIteration[];
    if (existing >= 0) {
      nextIters = [...cur.iterations];
      nextIters[existing] = iter;
    } else {
      nextIters = [...cur.iterations, iter];
      // Keep iterations sorted by iteration index so renderers don't
      // have to. Iteration ordering is the natural sweep ordering
      // (and matches parameter-value ordering for monotonic ranges).
      nextIters.sort((a, b) => a.iteration - b.iteration);
    }
    set({
      sweeps: {
        ...get().sweeps,
        [sweepId]: {
          ...cur,
          iterations: nextIters,
          state: cur.state === 'pending' ? 'running' : cur.state,
        },
      },
    });
  },

  markSweepFinished: (sweepId, state, extra) => {
    const cur = get().sweeps[sweepId];
    if (!cur) return;
    set({
      sweeps: {
        ...get().sweeps,
        [sweepId]: {
          ...cur,
          state,
          truncated: extra?.truncated ?? cur.truncated,
          error: extra?.error ?? cur.error,
        },
      },
      // Clear the active flag when the finished sweep was the active
      // one; the UI uses ``activeSweepId`` to drive the "in progress"
      // banner + results viewer.
      activeSweepId: get().activeSweepId === sweepId ? null : get().activeSweepId,
    });
  },

  resetSweep: (sweepId) => {
    const next = { ...get().sweeps };
    delete next[sweepId];
    set({
      sweeps: next,
      activeSweepId: get().activeSweepId === sweepId ? null : get().activeSweepId,
    });
  },

  clearSweeps: () => set({ sweeps: {}, activeSweepId: null }),

  setActiveSweep: (sweepId) => set({ activeSweepId: sweepId }),
}));
