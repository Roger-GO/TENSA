/**
 * Upload notice slice. What the last "add files to the workspace" turned away,
 * kept on screen until the user dismisses it or adds files again.
 *
 * Why not only a toast: a toast is gone after a few seconds, and a file that was
 * refused (the wrong type, empty, too large, a name the server rejects) leaves
 * nothing behind in the workspace list, so a user who looked away would see no
 * sign that it was ever tried. The saved-cases list shows this beside the Add
 * files button.
 *
 * Not persisted and not tied to a session or a case: it describes the last
 * attempt in this tab, so the case cascade in ``store/index.ts`` leaves it alone.
 */
import { create } from 'zustand';

export interface UploadNoticeState {
  /** One sentence per file that was not added, each naming the file and why. Empty: nothing to show. */
  refused: readonly string[];
  /** Show these as the notice, replacing the last one. An empty list clears it. */
  show: (refused: readonly string[]) => void;
  /** Hide the notice. */
  dismiss: () => void;
}

export const useUploadNoticeStore = create<UploadNoticeState>((set) => ({
  refused: [],
  show: (refused) => set({ refused: [...refused] }),
  dismiss: () => set({ refused: [] }),
}));
