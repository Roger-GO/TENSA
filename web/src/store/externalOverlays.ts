/**
 * External overlay traces: the series of a TSAT or PSS/E export the user
 * imported to draw over the plotted runs, dashed, on the plot's existing axes.
 *
 * Kept for this visit only: nothing is persisted (no localStorage, no
 * IndexedDB), so a reload drops them. They also go when the open case changes
 * or is closed, where the cascade in ``store/index.ts`` clears the other
 * slices that belong to a case, and one by one from their remove control in
 * the plot's legend row.
 *
 * The dialog's open flag lives here too, so ``TimeSeriesPlot`` opens the
 * dialog without importing it: the dialog is a separate chunk, fetched the
 * first time it is opened.
 */
import { create } from 'zustand';

export interface ExternalOverlayTrace {
  /** Stable id within the store: ``${source}:${name}`` of the import that added it. */
  id: string;
  source: 'tsat' | 'psse';
  /** The series name as the server sent it (``column 1``, ...). */
  name: string;
  /** Legend label: ``${source}: ${name}``. */
  label: string;
  /** Sample times in seconds, sorted ascending once at import. */
  t: Float64Array;
  /** The values, paired with ``t``; a null of the export is NaN (uPlot draws a gap). */
  y: Float64Array;
  /** Which axis: the group's primary one ('left') or the right-hand one ('right'). */
  axis: 'left' | 'right';
}

export interface ExternalOverlaysState {
  traces: readonly ExternalOverlayTrace[];
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** Add traces, replacing one whose id is already held (importing twice does not duplicate). */
  addTraces: (traces: ExternalOverlayTrace[]) => void;
  removeTrace: (id: string) => void;
  clear: () => void;
}

export const useExternalOverlaysStore = create<ExternalOverlaysState>((set) => ({
  traces: [],
  dialogOpen: false,
  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
  addTraces: (added) =>
    set((state) => {
      const byId = new Map(state.traces.map((trace) => [trace.id, trace]));
      for (const trace of added) byId.set(trace.id, trace);
      return { traces: [...byId.values()] };
    }),
  removeTrace: (id) => set((state) => ({ traces: state.traces.filter((t) => t.id !== id) })),
  clear: () => set({ traces: [], dialogOpen: false }),
}));
