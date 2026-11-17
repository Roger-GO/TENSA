/**
 * Example cases dialog slice.
 *
 * Open / closed state for ``ExampleCasesDialog``. It lives in the store, not in the
 * dialog's module, so the Project tab, the empty states and the command palette can
 * open the dialog without importing it: the dialog is a separate chunk that loads the
 * first time it is opened. Not persisted: a reload lands with the dialog closed.
 */
import { create } from 'zustand';

export interface ExampleCasesState {
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useExampleCasesStore = create<ExampleCasesState>((set) => ({
  dialogOpen: false,
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));
