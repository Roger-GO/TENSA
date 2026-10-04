/**
 * History slice (Unit 9 of the v2.0 plan).
 *
 * Tracks the local UI state for the run-history drawer: open/closed
 * flag, and the last-pinned-from-history snapshot (used by the success
 * toast inside the drawer). The drawer reads its run list directly
 * from ``useRunsStore`` — no copy lives here — so the slice stays
 * minimal.
 *
 * The slice also says which run's name is being edited, so that the pencil on a
 * row and the "Rename run" command open the same field.
 *
 * Sweep-progress fields (Unit 18 of the v2.0 plan) extend this slice
 * later; the basic version landed in Unit 9 only owns drawer
 * open/close + a transient toast message.
 *
 * Lifecycle: not persisted across sessions. Closes on session change (the
 * drawer is meaningless against a vanished session).
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
  /** The run whose name is being edited in the drawer, or ``null`` when none is. */
  renamingRunId: string | null;

  /** Open the drawer (resets stale toast). */
  openDrawer: () => void;
  /** Close the drawer (toast preserved so a fast re-open doesn't lose it). */
  closeDrawer: () => void;
  /** Open the drawer with the name of ``runId`` ready to edit. */
  startRenaming: (runId: string) => void;
  /** Stop editing a run's name (the edit itself is saved or dropped by the field). */
  stopRenaming: () => void;
  /** Set or clear the inline toast message. */
  setToast: (message: string | null) => void;
  /** Reset every transient field (used on session change). */
  reset: () => void;
}

const INITIAL: Pick<HistoryState, 'drawerOpen' | 'toastMessage' | 'renamingRunId'> = {
  drawerOpen: false,
  toastMessage: null,
  renamingRunId: null,
};

export const useHistoryStore = create<HistoryState>((set) => ({
  ...INITIAL,
  openDrawer: () => set({ drawerOpen: true, toastMessage: null }),
  // A name still being typed when the drawer closes is not carried over to the
  // next time it opens.
  closeDrawer: () => set({ drawerOpen: false, renamingRunId: null }),
  startRenaming: (runId) => set({ drawerOpen: true, toastMessage: null, renamingRunId: runId }),
  stopRenaming: () => set({ renamingRunId: null }),
  setToast: (message) => set({ toastMessage: message }),
  reset: () => set({ ...INITIAL }),
}));
