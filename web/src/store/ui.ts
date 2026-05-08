/**
 * UI slice. Tracks ephemeral display preferences that don't belong on
 * any of the other slices (auth/session/case/pflow). Currently a single
 * preference: the "Hide labels" toggle in the top bar (R9 — for the
 * screenshot-clean wedge demo look).
 *
 * Lifecycle: not persisted. Resets on tab close. The toggle is a
 * per-session preference, not a per-tab survival concern.
 */
import { create } from 'zustand';

export interface UiState {
  /**
   * When true, voltage / angle / flow magnitude labels are suppressed on
   * the SLD canvas. Color encoding (limit-band stroke) remains visible.
   */
  hideLabels: boolean;
  setHideLabels: (hide: boolean) => void;
  toggleHideLabels: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  hideLabels: false,
  setHideLabels: (hide: boolean) => set({ hideLabels: hide }),
  toggleHideLabels: () => set((s) => ({ hideLabels: !s.hideLabels })),
}));
