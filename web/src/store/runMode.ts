/**
 * RunMode slice (Unit 8 of the v2.0 polish plan).
 *
 * Tracks which routine the TopBar's Run menu is currently advertising
 * as the "active" choice. The menu shows a checkmark next to the
 * active entry and the topbar Run button label flips to match.
 *
 * Why a dedicated slice rather than reusing ``RunButton``'s local
 * ``manualMode`` (PF / TDS only) or ``analyze.subMode`` (the
 * AnalyzePanel's PF/TDS/EIG/CPF/SE picker):
 *
 * - ``RunButton.manualMode`` is component-local and only knows PF / TDS.
 *   Lifting it would entangle the existing PF/TDS state machine with
 *   the new menu.
 * - ``analyze.subMode`` drives the right-dock Analyze panel's content
 *   choice. Reusing it would mean clicking "EIG" in the Run menu
 *   silently swaps the user's open Analyze panel — a side effect that
 *   couples two surfaces that should stay independent (e.g., the user
 *   may be looking at the EIG scatter while a TDS run streams in the
 *   PlotPanel).
 *
 * The slice is intentionally tiny: just ``activeRoutine`` +
 * ``setActiveRoutine``. Future units (Unit 9 command palette) can
 * read the same field to surface "Run <active routine>" without
 * re-deriving the choice.
 */
import { create } from 'zustand';
import type { RunRoutine } from '@/lib/useRunReadiness';

/** Routine currently selected in the Run menu. Defaults to PFlow. */
export interface RunModeState {
  activeRoutine: RunRoutine;
  setActiveRoutine: (next: RunRoutine) => void;
}

export const useRunModeStore = create<RunModeState>((set) => ({
  activeRoutine: 'pflow',
  setActiveRoutine: (next) => set({ activeRoutine: next }),
}));
