/**
 * History slice (Unit 9 of the v2.0 plan).
 *
 * Tracks the local UI state for the run-history drawer: open/closed
 * flag, and the last-pinned-from-history snapshot (used by the success
 * toast inside the drawer). The drawer reads its run list directly
 * from ``useRunsStore`` — no copy lives here — so the slice stays
 * minimal.
 *
 * Sweep-progress fields (Unit 18 of the v2.0 plan) extend this slice
 * later; the basic version landed in Unit 9 only owns drawer
 * open/close + a transient toast message.
 *
 * Lifecycle: not persisted across sessions. Closes on session change /
 * auth clear (the drawer is meaningless against a vanished session).
 */
import { create } from 'zustand';

export interface HistoryState {
  /** True while the HistoryDrawer is mounted in the open position. */
  drawerOpen: boolean;
  /**
   * Last user-facing message surfaced inside the drawer (e.g. "Pinned
   * run-abc to overlay"). Cleared after a brief beat by the caller.
   * Optional — most actions don't surface a toast.
   */
  toastMessage: string | null;

  /** Open the drawer (resets stale toast). */
  openDrawer: () => void;
  /** Close the drawer (toast preserved so a fast re-open doesn't lose it). */
  closeDrawer: () => void;
  /** Set or clear the inline toast message. */
  setToast: (message: string | null) => void;
  /** Reset every transient field (used on session change / auth clear). */
  reset: () => void;
}

const INITIAL: Pick<HistoryState, 'drawerOpen' | 'toastMessage'> = {
  drawerOpen: false,
  toastMessage: null,
};

export const useHistoryStore = create<HistoryState>((set) => ({
  ...INITIAL,
  openDrawer: () => set({ drawerOpen: true, toastMessage: null }),
  closeDrawer: () => set({ drawerOpen: false }),
  setToast: (message) => set({ toastMessage: message }),
  reset: () => set({ ...INITIAL }),
}));
