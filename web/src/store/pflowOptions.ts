/**
 * Power-flow options slice. The options form writes them; `useRunPflow` reads
 * them when a run starts, so every control that posts a power flow (the top-bar
 * button, the Analysis PF tab, the recoveries EIG / CPF / SE offer) runs with the
 * same ones. A time-domain run or a snapshot restore that has to solve the power
 * flow itself does so with the case's own settings, not these: running the power
 * flow first is what makes it start from them.
 *
 * Lifecycle: in memory only, and reset when the case changes (the cascade in
 * `store/index.ts`). They are the user's way to rescue one case (a flat start, a
 * looser tolerance), and a setting made for one should not follow the user to
 * the next without being asked for.
 *
 * `caseSettings` is what the case itself sets for the two switches, learned from
 * a run that left them alone (the server reports what a run used), so the form
 * can show a switch that a case turns on as ticked. It is kept when the options
 * are reset, and goes with the case.
 */
import { create } from 'zustand';
import {
  DEFAULT_PFLOW_OPTIONS,
  type PflowCaseSettings,
  type PflowOptions,
} from '@/lib/pflowOptions';

const UNKNOWN_CASE_SETTINGS: PflowCaseSettings = { flatStart: null, enforceQLimits: null };

export interface PflowOptionsState {
  options: PflowOptions;
  caseSettings: PflowCaseSettings;
  setOptions: (patch: Partial<PflowOptions>) => void;
  /** Put the options back to the case's own (the form's Reset). */
  resetOptions: () => void;
  noteCaseSettings: (patch: Partial<PflowCaseSettings>) => void;
  /** Another case opened: the options and what was learned about the old one go. */
  resetForNewCase: () => void;
}

export const usePflowOptionsStore = create<PflowOptionsState>((set) => ({
  options: DEFAULT_PFLOW_OPTIONS,
  caseSettings: UNKNOWN_CASE_SETTINGS,
  setOptions: (patch) => set((state) => ({ options: { ...state.options, ...patch } })),
  resetOptions: () => set({ options: DEFAULT_PFLOW_OPTIONS }),
  noteCaseSettings: (patch) =>
    set((state) => ({ caseSettings: { ...state.caseSettings, ...patch } })),
  resetForNewCase: () =>
    set({ options: DEFAULT_PFLOW_OPTIONS, caseSettings: UNKNOWN_CASE_SETTINGS }),
}));
