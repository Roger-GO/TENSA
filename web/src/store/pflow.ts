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

export interface PflowState {
  /** Most recent PF result (converged or not), or null if no run yet. */
  lastRun: PflowResult | null;
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
  isRunning: false,
  error: null,
  setRunning: (running: boolean) => set({ isRunning: running }),
  setLastRun: (result: PflowResult) => set({ lastRun: result, error: null }),
  setError: (error: ProblemDetailsError | null) => set({ error }),
  clearPflow: () => set({ lastRun: null, isRunning: false, error: null }),
}));
