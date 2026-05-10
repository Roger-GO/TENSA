/**
 * Bundle slice (Unit 3 of the v2.0 plan).
 *
 * Tracks the local UI state for the reproducibility-bundle export
 * dialog: open/closed flag, the most recent export's preview file list,
 * mutation status (idle / pending / success / error), and the last
 * error message (if any) for inline display in the dialog.
 *
 * The actual ``POST /api/sessions/{id}/bundle/export`` mutation lives
 * in ``src/api/queries.ts`` (``useExportBundle``) — this slice only
 * owns the dialog-side ephemeral state. We split the two so the
 * mutation can be triggered from any component (TopBar button, future
 * keyboard shortcut, future "Export bundle for this run" affordance in
 * the run history drawer) without coupling each call site to a Zustand
 * subscribe.
 *
 * Lifecycle: not persisted across sessions. Closes on session change /
 * auth clear because the dialog can't meaningfully re-open against a
 * vanished session.
 */
import { create } from 'zustand';

/** Mutation phase the dialog reads to gate the confirm button + spinner. */
export type BundleExportStatus = 'idle' | 'pending' | 'success' | 'error';

/** One file entry in the bundle's preview list. */
export interface BundlePreviewFile {
  /** In-zip path (e.g., ``case/ieee14.raw``, ``manifest.json``). */
  name: string;
  /** Optional byte size — preview list shows when present. */
  bytes?: number;
}

export interface BundleState {
  /** True while the BundleExportDialog is mounted in the open position. */
  dialogOpen: boolean;
  /** Last-known preview file list (after a successful prepare or export). */
  previewFiles: readonly BundlePreviewFile[];
  /** Mutation phase. */
  status: BundleExportStatus;
  /** Inline error message — populated on ``status === 'error'``. */
  errorMessage: string | null;
  /** Last successful export filename (used in the success toast/copy). */
  lastExportedFilename: string | null;

  /** Open the dialog (and reset transient status). */
  openDialog: () => void;
  /** Close the dialog without resetting the success/error trail. */
  closeDialog: () => void;
  /** Mark the export as in-flight. */
  markPending: () => void;
  /** Mark the export as complete. ``filename`` is the suggested download name. */
  markSuccess: (filename: string, previewFiles: readonly BundlePreviewFile[]) => void;
  /** Mark the export as failed; the ``message`` is rendered inline. */
  markError: (message: string) => void;
  /** Reset everything (used on session change / auth clear via the cascade). */
  reset: () => void;
}

const INITIAL: Omit<
  BundleState,
  'openDialog' | 'closeDialog' | 'markPending' | 'markSuccess' | 'markError' | 'reset'
> = {
  dialogOpen: false,
  previewFiles: [],
  status: 'idle',
  errorMessage: null,
  lastExportedFilename: null,
};

export const useBundleStore = create<BundleState>((set) => ({
  ...INITIAL,
  openDialog: () =>
    set({
      dialogOpen: true,
      // Resetting status on open — a stale 'error' from a prior attempt
      // shouldn't pin the confirm button into the failed state.
      status: 'idle',
      errorMessage: null,
    }),
  closeDialog: () => set({ dialogOpen: false }),
  markPending: () => set({ status: 'pending', errorMessage: null }),
  markSuccess: (filename, previewFiles) =>
    set({
      status: 'success',
      lastExportedFilename: filename,
      previewFiles: [...previewFiles],
      errorMessage: null,
    }),
  markError: (message) => set({ status: 'error', errorMessage: message }),
  reset: () => set({ ...INITIAL }),
}));
