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
 * The slice is intentionally tiny: ``activeRoutine`` +
 * ``setActiveRoutine``, which the command palette reads to offer
 * "Run again", and the run a command asked for (``runRequest``), which
 * the Run button of that routine takes and starts (``useRequestedRun``).
 */
import { create } from 'zustand';
import type { RunRoutine } from '@/lib/useRunReadiness';

/**
 * A run that a command asked for and its Run button has not started yet. Each
 * request is an object of its own, so asking twice for one routine is two.
 */
export interface RunRequest {
  routine: RunRoutine;
}

/** Routine currently selected in the Run menu. Defaults to PFlow. */
export interface RunModeState {
  activeRoutine: RunRoutine;
  setActiveRoutine: (next: RunRoutine) => void;
  /**
   * The run a command of the Run menu or the palette asked for. Each routine
   * is started by the component that owns its Run button (the top bar for PF
   * and TDS, the Analysis tab of the routine for EIG, CPF and SE), which
   * takes the request with `takeRunRequest` once it is on screen and starts
   * the run as a click on its button would.
   */
  runRequest: RunRequest | null;
  requestRun: (routine: RunRoutine) => void;
  /** Take the request when it is for one of `routines`: it is answered once. */
  takeRunRequest: (routines: readonly RunRoutine[]) => RunRoutine | null;
}

export const useRunModeStore = create<RunModeState>((set, get) => ({
  activeRoutine: 'pflow',
  setActiveRoutine: (next) => set({ activeRoutine: next }),
  runRequest: null,
  requestRun: (routine) => set({ runRequest: { routine } }),
  takeRunRequest: (routines) => {
    const request = get().runRequest;
    if (request === null || !routines.includes(request.routine)) return null;
    set({ runRequest: null });
    return request.routine;
  },
}));
