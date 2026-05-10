/**
 * TimeSeries profile slice (Unit 15 of the v2.0 plan).
 *
 * Tracks the local view of currently-staged TimeSeries devices so the
 * import dialog can render its "currently staged" list without a
 * query round-trip on every open. The slice is a thin mirror of the
 * substrate's ``GET /sessions/{id}/profiles`` response — the
 * canonical source of truth is the substrate's ``_replay_buffer``
 * (which the substrate reads from ``ss.TimeSeries`` for
 * ``list_timeseries``); this slice is the cache the dialog reads
 * while editing.
 *
 * Lifecycle:
 *
 * - Cleared on session change, auth clear, and case change (cross-
 *   slice cascade in ``store/index.ts``). A new case has a different
 *   device set so any cached profile assignments are stale by
 *   definition.
 * - The Zustand store is replaced wholesale on a successful
 *   ``listProfiles`` query — we don't merge incrementally because the
 *   substrate's list is the source of truth.
 *
 * No commit / dirty bookkeeping (parity with the PMU slice): each
 * upload + add writes through to the substrate immediately via
 * ``useUploadProfile`` / ``useAddProfile``. Stage / commit semantics
 * live in the substrate, not in the slice.
 */
import { create } from 'zustand';
import type { TopologyEntry } from '@/api/types';

export interface ProfilesState {
  /**
   * Most-recent list of TimeSeries TopologyEntries from the substrate.
   * ``[]`` before the first ``listProfiles`` query lands or after a
   * session/case clear. The dialog renders an empty state when this
   * is empty.
   */
  profiles: TopologyEntry[];
  /**
   * Replace the entire list (called from ``useListProfiles`` onSuccess
   * and ``useAddProfile`` / ``useDeleteProfile`` after their
   * respective mutations succeed; both invalidate the listProfiles
   * query so the next render is driven by the substrate's truth).
   */
  setProfiles: (profiles: readonly TopologyEntry[]) => void;
  /**
   * Append a single TimeSeries entry. Used by the addProfile
   * mutation's onSuccess so the dialog reflects the new staging
   * without waiting for the listProfiles refetch round-trip.
   */
  appendProfile: (entry: TopologyEntry) => void;
  /**
   * Remove a single TimeSeries by idx. Used by the deleteProfile
   * mutation's onSuccess for the same reason.
   */
  removeProfile: (idx: string) => void;
  /** Clear the slice — used by the cross-slice cascade. */
  clear: () => void;
}

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  profiles: [],
  setProfiles: (profiles) => set({ profiles: [...profiles] }),
  appendProfile: (entry) => {
    const list = get().profiles;
    // Idempotent: re-adding the same idx (e.g., a refetch race)
    // replaces the entry rather than duplicating it. TimeSeries idxes
    // are auto-assigned by ANDES (TimeSeries_<n>) so collisions only
    // happen via re-reads, not via user error.
    const filtered = list.filter((p) => String(p.idx) !== String(entry.idx));
    set({ profiles: [...filtered, entry] });
  },
  removeProfile: (idx) => {
    const list = get().profiles;
    const next = list.filter((p) => String(p.idx) !== String(idx));
    if (next.length === list.length) return;
    set({ profiles: next });
  },
  clear: () => set({ profiles: [] }),
}));
