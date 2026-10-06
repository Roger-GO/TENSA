/**
 * Power-flow slice. Tracks the most recent PF run for the active case.
 *
 * Lifecycle: cleared on case change (the case slice triggers this via the
 * cross-slice cascade in `store/index.ts`).
 *
 * Like the case slice, the actual `PflowResult` is also kept in the
 * TanStack Query cache; this slice mirrors the latest result so the
 * results table + SLD overlay can read synchronously without subscribing
 * to a query key. `isRunning` + `error` exist for error-banner placement
 * (R8 error taxonomy: non-convergence overlay vs. inline parse errors).
 */
import { create } from 'zustand';
import type { PflowResult } from '@/api/types';
import type { ProblemDetailsError } from '@/api/client';

/**
 * Whether a result is what a power flow gave. The operating point read back
 * after a time-domain run comes in the same shape and reads as converged, but
 * it is bus voltages and angles only: a power flow that converged has its
 * totals (`summary`), and one that did not says so.
 */
export function isSolvedPflow(result: PflowResult): boolean {
  return !result.converged || result.summary != null;
}

export interface PflowState {
  /**
   * Most recent PF result (converged or not), or null if no run yet. After a
   * time-domain run it is the operating point that run ended at.
   */
  lastRun: PflowResult | null;
  /**
   * The last result a power flow gave on the open case, which the operating
   * point read back after a time-domain run does not replace. What judges a
   * power flow (the Violations report) reads this, not `lastRun`.
   */
  lastSolved: PflowResult | null;
  /** True while a PF run is in flight. */
  isRunning: boolean;
  /**
   * The last typed error from a PF run, or null if the last run was a
   * `200`-shaped response (whether converged or not — non-convergence is
   * a `200` body with `converged: false`, not a server error).
   */
  error: ProblemDetailsError | null;
  setRunning: (running: boolean) => void;
  setLastRun: (result: PflowResult) => void;
  setError: (error: ProblemDetailsError | null) => void;
  clearPflow: () => void;
}

export const usePflowStore = create<PflowState>((set) => ({
  lastRun: null,
  lastSolved: null,
  isRunning: false,
  error: null,
  setRunning: (running: boolean) => set({ isRunning: running }),
  setLastRun: (result: PflowResult) =>
    set((state) => ({
      lastRun: result,
      lastSolved: isSolvedPflow(result) ? result : state.lastSolved,
      error: null,
    })),
  setError: (error: ProblemDetailsError | null) => set({ error }),
  clearPflow: () => set({ lastRun: null, lastSolved: null, isRunning: false, error: null }),
}));
