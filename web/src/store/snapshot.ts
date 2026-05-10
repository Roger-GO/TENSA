/**
 * Snapshot slice (Unit 7 of the v2.0 plan).
 *
 * Tracks the local UI state for the snapshot menu + save/load dialogs.
 * The actual save / restore / list / delete I/O lives in
 * ``src/api/queries.ts``; this slice owns dialog open/close, the
 * pending-name input, the list of snapshots fetched from the substrate
 * (so the load dialog can render before the network responds when a
 * user re-opens it), and last-error / last-fallback messages for
 * inline display.
 *
 * Lifecycle: not persisted across sessions. Resets on session change /
 * auth clear via the cross-slice cascade in ``src/store/index.ts``.
 */
import { create } from 'zustand';

/** Mutation phase the dialogs read to gate confirm buttons + spinners. */
export type SnapshotMutationStatus = 'idle' | 'pending' | 'success' | 'error';

/** Snapshot listing entry as returned by ``GET /sessions/{id}/snapshots``. */
export interface SnapshotListEntry {
  name: string;
  saved_at: string;
  has_pflow: boolean;
  has_tds: boolean;
  has_dill: boolean;
  andes_version: string;
  disturbance_count: number;
}

/** Restore-result payload echoed in the load-success toast. */
export interface SnapshotRestoreOutcome {
  used_dill: boolean;
  fallback_reason: string | null;
  disturbances_replayed: number;
  name: string;
}

export interface SnapshotState {
  /** True while the SaveSnapshotDialog is mounted in the open position. */
  saveDialogOpen: boolean;
  /** True while the LoadSnapshotDialog is mounted in the open position. */
  loadDialogOpen: boolean;
  /** Locally-tracked name input for the save dialog. */
  pendingName: string;
  /** Last-known list of snapshots (for instant render on re-open). */
  snapshots: readonly SnapshotListEntry[];
  /** Save mutation phase. */
  saveStatus: SnapshotMutationStatus;
  /** Restore mutation phase. */
  restoreStatus: SnapshotMutationStatus;
  /** Inline save-side error message. */
  saveError: string | null;
  /** Inline restore-side error message. */
  restoreError: string | null;
  /** Restore success outcome — surfaced as an inline toast inside the load
   *  dialog to highlight when the slow path was taken. */
  lastRestoreOutcome: SnapshotRestoreOutcome | null;

  /** Open the save dialog (resets transient status + pendingName). */
  openSaveDialog: () => void;
  /** Open the load dialog. */
  openLoadDialog: () => void;
  /** Close either dialog. */
  closeDialogs: () => void;
  /** Update the pending name input. */
  setPendingName: (name: string) => void;
  /** Cache the substrate's listing for instant re-open render. */
  setSnapshots: (snapshots: readonly SnapshotListEntry[]) => void;
  /** Mark the save mutation as in-flight. */
  markSavePending: () => void;
  /** Mark save success — closes the dialog after a short beat. */
  markSaveSuccess: () => void;
  /** Mark save error — surfaces inline. */
  markSaveError: (message: string) => void;
  /** Mark the restore mutation as in-flight. */
  markRestorePending: () => void;
  /** Mark restore success — record the outcome for the inline toast. */
  markRestoreSuccess: (outcome: SnapshotRestoreOutcome) => void;
  /** Mark restore error — surfaces inline. */
  markRestoreError: (message: string) => void;
  /** Reset the slice (used by the session-change cascade). */
  reset: () => void;
}

const INITIAL: Omit<
  SnapshotState,
  | 'openSaveDialog'
  | 'openLoadDialog'
  | 'closeDialogs'
  | 'setPendingName'
  | 'setSnapshots'
  | 'markSavePending'
  | 'markSaveSuccess'
  | 'markSaveError'
  | 'markRestorePending'
  | 'markRestoreSuccess'
  | 'markRestoreError'
  | 'reset'
> = {
  saveDialogOpen: false,
  loadDialogOpen: false,
  pendingName: '',
  snapshots: [],
  saveStatus: 'idle',
  restoreStatus: 'idle',
  saveError: null,
  restoreError: null,
  lastRestoreOutcome: null,
};

export const useSnapshotStore = create<SnapshotState>((set) => ({
  ...INITIAL,
  openSaveDialog: () =>
    set({
      saveDialogOpen: true,
      loadDialogOpen: false,
      saveStatus: 'idle',
      saveError: null,
      pendingName: '',
    }),
  openLoadDialog: () =>
    set({
      loadDialogOpen: true,
      saveDialogOpen: false,
      restoreStatus: 'idle',
      restoreError: null,
    }),
  closeDialogs: () => set({ saveDialogOpen: false, loadDialogOpen: false }),
  setPendingName: (name) => set({ pendingName: name }),
  setSnapshots: (snapshots) => set({ snapshots: [...snapshots] }),
  markSavePending: () => set({ saveStatus: 'pending', saveError: null }),
  markSaveSuccess: () => set({ saveStatus: 'success', saveError: null }),
  markSaveError: (message) => set({ saveStatus: 'error', saveError: message }),
  markRestorePending: () => set({ restoreStatus: 'pending', restoreError: null }),
  markRestoreSuccess: (outcome) =>
    set({
      restoreStatus: 'success',
      restoreError: null,
      lastRestoreOutcome: outcome,
    }),
  markRestoreError: (message) => set({ restoreStatus: 'error', restoreError: message }),
  reset: () => set({ ...INITIAL }),
}));
