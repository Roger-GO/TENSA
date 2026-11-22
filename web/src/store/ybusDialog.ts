/**
 * Ybus dialog slice.
 *
 * Open / closed state for ``YbusDialog``. It lives in the store, not in the
 * dialog's module, so the command palette can open the dialog without
 * importing it: the dialog is a separate chunk that loads the first time it
 * is opened. Not persisted: a reload lands with the dialog closed.
 */
import { create } from 'zustand';

export interface YbusDialogState {
  open: boolean;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useYbusDialogStore = create<YbusDialogState>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
}));
