/**
 * Model documentation dialog slice.
 *
 * Open / closed state for ``ModelDocDialog``, with the model it was opened
 * for. It lives in the store, not in the dialog's module, so a form's button
 * and the command palette can open the dialog without importing it: the
 * dialog is a separate chunk that loads the first time it is opened. Not
 * persisted: a reload lands with the dialog closed.
 */
import { create } from 'zustand';

export interface ModelDocState {
  dialogOpen: boolean;
  /** The model the dialog shows, when opened for one (from a form); null = browse mode (palette). */
  model: string | null;
  openDialog: (model?: string) => void;
  closeDialog: () => void;
}

export const useModelDocStore = create<ModelDocState>((set) => ({
  dialogOpen: false,
  model: null,
  openDialog: (model) => set({ dialogOpen: true, model: model ?? null }),
  // Keep ``model`` so a reopen during the close animation does not flash; the
  // next ``openDialog`` overwrites it.
  closeDialog: () => set({ dialogOpen: false }),
}));
