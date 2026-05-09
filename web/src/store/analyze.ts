/**
 * Analyze panel slice (Unit 6 — Analyze panel + EIG sub-mode).
 *
 * Tracks:
 *
 * - ``subMode`` — which routine the Analyze panel is showing
 *   (``pflow`` / ``tds`` / ``eig``). Per KTD-6 the picker replaces
 *   the v0.1 ``RunMode = 'pf' | 'tds'`` toggle inside the new Analyze
 *   panel. CPF and SE arrive in Phase 3.
 * - ``eigResult`` — most recent EIG result for the active session.
 *   Mirrored from the TanStack Query cache so EIGScatter /
 *   EIGParticipationTable / EIGDampingChart can read synchronously.
 *   Cleared on case change (cross-slice cascade in ``store/index.ts``)
 *   and on successful ``Wrapper.reload_case``.
 * - ``selectedModeId`` — which eigenvalue point the user clicked.
 *   Drives EIGParticipationTable's per-mode fetch + the bar
 *   highlight. ``null`` means "no selection / show empty state".
 * - ``filter`` — display-only filter applied by EIGScatter. Per
 *   KTD-7: damping ratio < 5% AND |Re| < 5 by default; the user can
 *   widen via the filter UI (knobs land in a follow-up unit; the
 *   store carries the values today so the scatter applies them on
 *   first render).
 *
 * Lifecycle: not persisted across tabs. EIG results cleared on case
 * change OR when ``selectedModeId`` would point past ``mode_count``
 * (set automatically by ``setEigResult``).
 */
import { create } from 'zustand';
import type { EigResult } from '@/api/types';

/** Sub-mode picker values for the Analyze panel. */
export type AnalyzeSubMode = 'pflow' | 'tds' | 'eig';

export const ANALYZE_SUB_MODES: readonly AnalyzeSubMode[] = [
  'pflow',
  'tds',
  'eig',
] as const;

/**
 * EIG scatter filter (KTD-7). Defaults match the plan: hide
 * well-damped fast modes so the under-damped / oscillatory modes
 * dominate the visible scatter on large cases (kundur, NPCC).
 */
export interface EigFilter {
  /** Maximum damping ratio (modes with damping > this are hidden). */
  dampingMax: number;
  /** Maximum |Re(eig)| (modes whose real part is more negative are hidden). */
  realAbsMax: number;
}

export const DEFAULT_EIG_FILTER: EigFilter = {
  dampingMax: 0.05,
  realAbsMax: 5,
};

export interface AnalyzeState {
  subMode: AnalyzeSubMode;
  setSubMode: (next: AnalyzeSubMode) => void;

  eigResult: EigResult | null;
  setEigResult: (result: EigResult | null) => void;
  clearEigResult: () => void;

  selectedModeId: number | null;
  setSelectedModeId: (id: number | null) => void;

  filter: EigFilter;
  setFilter: (next: Partial<EigFilter>) => void;
  resetFilter: () => void;
}

export const useAnalyzeStore = create<AnalyzeState>((set) => ({
  subMode: 'pflow',
  setSubMode: (next) => set({ subMode: next }),

  eigResult: null,
  setEigResult: (result) =>
    set((s) => {
      // If the new result has fewer modes than the current selection,
      // clear the selection so consumers don't dereference past the
      // end of the array. Null result also clears selection.
      let nextSelected = s.selectedModeId;
      if (result === null) {
        nextSelected = null;
      } else if (
        nextSelected !== null &&
        nextSelected >= result.mode_count
      ) {
        nextSelected = null;
      }
      return { eigResult: result, selectedModeId: nextSelected };
    }),
  clearEigResult: () => set({ eigResult: null, selectedModeId: null }),

  selectedModeId: null,
  setSelectedModeId: (id) => set({ selectedModeId: id }),

  filter: { ...DEFAULT_EIG_FILTER },
  setFilter: (next) =>
    set((s) => ({ filter: { ...s.filter, ...next } })),
  resetFilter: () => set({ filter: { ...DEFAULT_EIG_FILTER } }),
}));

/**
 * Pure helper: return the indices of eigenvalues that pass the filter.
 * Exported so the scatter component and tests share one source of
 * truth for the filter logic.
 *
 * Filter contract (per KTD-7):
 * - Hide modes with damping > ``filter.dampingMax``.
 * - Hide modes with ``|Re(z)|`` > ``filter.realAbsMax``.
 *
 * "Hide" means "exclude from the result"; the visible-set is the
 * intersection of both conditions.
 */
export function applyEigFilter(
  result: EigResult,
  filter: EigFilter,
): number[] {
  const visible: number[] = [];
  for (let i = 0; i < result.eigenvalues.length; i++) {
    const z = result.eigenvalues[i];
    if (z === undefined) continue;
    const damp = result.damping_ratios[i] ?? 0;
    if (damp > filter.dampingMax) continue;
    if (Math.abs(z.real) > filter.realAbsMax) continue;
    visible.push(i);
  }
  return visible;
}
