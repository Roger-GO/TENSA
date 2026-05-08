/**
 * Case slice. Tracks the loaded case (path + addfiles + topology summary +
 * sidecar layout, if read). The Inspector and SLD canvas read from here.
 *
 * Lifecycle: cleared on session clear (cross-slice cascade) and on case
 * change (the `setCase` setter overwrites; no separate clear needed when
 * loading a different case in the same session).
 *
 * Topology + sidecar live in TanStack Query's cache too; this slice only
 * holds the "currently chosen" handle. We avoid duplicating server-state
 * — the slice is a pointer, the cache is the data.
 */
import { create } from 'zustand';
import type { TopologySummary, SidecarLayout, WorkspacePath } from '@/api/types';

export interface CaseSelection {
  primaryPath: WorkspacePath;
  addfiles: WorkspacePath[];
}

export interface CaseState {
  /** The currently-selected case + addfiles, or null if none loaded. */
  selection: CaseSelection | null;
  /**
   * Last successfully fetched topology summary for the current selection.
   * Mirrors the TanStack Query cache; held here so non-Query consumers
   * (selection-driven side effects) can read the topology synchronously.
   */
  topology: TopologySummary | null;
  /** Last sidecar layout read, if any. `null` if no sidecar exists yet. */
  layoutSidecar: SidecarLayout | null;
  setCase: (selection: CaseSelection) => void;
  setTopology: (topology: TopologySummary | null) => void;
  setLayoutSidecar: (sidecar: SidecarLayout | null) => void;
  clearCase: () => void;
}

export const useCaseStore = create<CaseState>((set) => ({
  selection: null,
  topology: null,
  layoutSidecar: null,
  setCase: (selection: CaseSelection) =>
    // A new case wipes the old topology + sidecar so consumers don't see
    // stale data while the new fetches are in flight.
    set({ selection, topology: null, layoutSidecar: null }),
  setTopology: (topology: TopologySummary | null) => set({ topology }),
  setLayoutSidecar: (sidecar: SidecarLayout | null) => set({ layoutSidecar: sidecar }),
  clearCase: () => set({ selection: null, topology: null, layoutSidecar: null }),
}));
