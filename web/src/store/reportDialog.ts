/**
 * Report dialog slice (Unit 4 of the v2.0 plan).
 *
 * Open / closed state for ``ReportDialog``, plus the routine tab the user last
 * had open. It lives in the store, not in the dialog's module, so the command
 * palette and the menus can open the dialog without importing the dialog (the
 * dialog is a separate chunk that loads when it is first opened).
 *
 * Single state field for visibility: there is no status / error machinery here
 * because the report endpoint itself is GET-only and TanStack Query owns the
 * loading / error state.
 */
import { create } from 'zustand';
import type { ReportRoutine } from '@/api/queries';

interface ReportDialogState {
  dialogOpen: boolean;
  /** The tab the user last had open; preserved across open/close. */
  activeRoutine: ReportRoutine;
  openDialog: (routine?: ReportRoutine) => void;
  closeDialog: () => void;
  setActiveRoutine: (routine: ReportRoutine) => void;
}

export const useReportDialogStore = create<ReportDialogState>((set) => ({
  dialogOpen: false,
  activeRoutine: 'pflow',
  openDialog: (routine?: ReportRoutine) =>
    set((state) => ({
      dialogOpen: true,
      activeRoutine: routine ?? state.activeRoutine,
    })),
  closeDialog: () => set({ dialogOpen: false }),
  setActiveRoutine: (routine: ReportRoutine) => set({ activeRoutine: routine }),
}));
