/**
 * PMU placement slice (Unit 14 of the v2.0 plan).
 *
 * Tracks the local view of currently-placed PMUs so the placement
 * dialog can render its "currently placed" list without a query
 * round-trip on every open. The slice is a thin mirror of the
 * substrate's ``GET /sessions/{id}/pmu`` response — the canonical
 * source of truth is the substrate's ``_replay_buffer`` (which the
 * substrate reads from ``ss.PMU.idx.v`` for ``list_pmus``); this
 * slice is the cache the dialog reads while editing.
 *
 * Lifecycle:
 *
 * - Cleared on session change, auth clear, and case change (cross-
 *   slice cascade in ``store/index.ts``). A new case has a different
 *   bus set so any cached PMU placements are stale by definition.
 * - The Zustand store is replaced wholesale on a successful
 *   ``listPmus`` query — we don't merge incrementally because the
 *   substrate's list is the source of truth.
 *
 * No commit / dirty bookkeeping (unlike the disturbance slice): each
 * add / delete writes through to the substrate immediately via
 * ``useAddPmu`` / ``useDeletePmu``. The placement dialog flow is:
 *
 *   1. user picks bus from list → useAddPmu.mutate() → substrate 201
 *   2. onSuccess writes the new entry into this slice + invalidates
 *      the listPmus query so any other component sees it
 *   3. user can place more PMUs or close the dialog
 *
 * The "live updates as the user types" pattern from the disturbance
 * editor doesn't fit here — PMU placements are point-in-time decisions,
 * not iterative drafts.
 */
import { create } from 'zustand';
import type { TopologyEntry } from '@/api/types';

export interface PmuState {
  /**
   * Most-recent list of PMU TopologyEntries from the substrate. ``[]``
   * before the first ``listPmus`` query lands or after a session/case
   * clear. The dialog renders an empty state when this is empty.
   */
  pmus: TopologyEntry[];
  /**
   * Replace the entire list (called from ``useListPmus`` onSuccess and
   * ``useAddPmu`` / ``useDeletePmu`` after their respective mutations
   * succeed; both invalidate the listPmus query so the next render is
   * driven by the substrate's truth).
   */
  setPmus: (pmus: readonly TopologyEntry[]) => void;
  /**
   * Append a single PMU entry. Used by the addPmu mutation's onSuccess
   * so the dialog reflects the new placement without waiting for the
   * listPmus refetch round-trip.
   */
  appendPmu: (entry: TopologyEntry) => void;
  /**
   * Remove a single PMU by idx. Used by the deletePmu mutation's
   * onSuccess for the same reason.
   */
  removePmu: (idx: string) => void;
  /** Clear the slice — used by the cross-slice cascade. */
  clear: () => void;
}

export const usePmuStore = create<PmuState>((set, get) => ({
  pmus: [],
  setPmus: (pmus) => set({ pmus: [...pmus] }),
  appendPmu: (entry) => {
    const list = get().pmus;
    // Idempotent: re-adding the same idx (e.g., a refetch race) replaces
    // the entry rather than duplicating it. PMU idxes are auto-assigned
    // by ANDES (PMU_<n>) so collisions only happen via re-reads, not via
    // user error.
    const filtered = list.filter((p) => String(p.idx) !== String(entry.idx));
    set({ pmus: [...filtered, entry] });
  },
  removePmu: (idx) => {
    const list = get().pmus;
    const next = list.filter((p) => String(p.idx) !== String(idx));
    if (next.length === list.length) return;
    set({ pmus: next });
  },
  clear: () => set({ pmus: [] }),
}));
