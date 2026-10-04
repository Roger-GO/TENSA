/**
 * Power-flow options slice. The options form writes them; `useRunPflow` reads
 * them when a run starts, so every control that starts a power flow (the top-bar
 * button, the Analysis PF tab, the recoveries EIG / CPF / SE offer) runs with the
 * same ones.
 *
 * Lifecycle: in memory only, and reset when the case changes (the cascade in
 * `store/index.ts`). They are the user's way to rescue one case (a flat start, a
 * looser tolerance), and a setting made for one should not follow the user to
 * the next without being asked for.
 */
import { create } from 'zustand';
import { DEFAULT_PFLOW_OPTIONS, type PflowOptions } from '@/lib/pflowOptions';

export interface PflowOptionsState {
  options: PflowOptions;
  setOptions: (patch: Partial<PflowOptions>) => void;
  resetOptions: () => void;
}

export const usePflowOptionsStore = create<PflowOptionsState>((set) => ({
  options: DEFAULT_PFLOW_OPTIONS,
  setOptions: (patch) => set((state) => ({ options: { ...state.options, ...patch } })),
  resetOptions: () => set({ options: DEFAULT_PFLOW_OPTIONS }),
}));
