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
  /**
   * Workspace-relative path to the loaded case file, or `null` for a
   * blank session (Unit 7) where the topology was created via
   * `POST /api/sessions/{id}/blank` and has no underlying file.
   */
  primaryPath: WorkspacePath | null;
  addfiles: WorkspacePath[];
  /**
   * `true` when the session was started blank rather than loaded from
   * a file. The CaseNav summary card uses this to label "New system"
   * instead of a filename and reword "Change case" to "Discard system".
   */
  blank?: boolean;
}

/**
 * A handle to one element on the SLD canvas. Written by `SldCanvas`
 * (Unit 8) on node click; read by `ElementInspector` (Unit 9) to drive
 * the right-dock inspector.
 *
 * `kind` mirrors the topology bucket name (`bus`, `line`, `transformer`,
 * `generator`, `load`, `shunt`); `idx` is the ANDES idx as a string so
 * the same shape works for both numeric and string-named idx values.
 */
export interface SelectedElement {
  kind: 'bus' | 'line' | 'transformer' | 'generator' | 'load' | 'shunt';
  idx: string;
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
  /**
   * The element currently being inspected on the SLD canvas, or null if
   * nothing is selected. Single source of truth for "what's clicked"
   * — Unit 8 writes; Unit 9 reads.
   */
  selectedElement: SelectedElement | null;
  /** Add-element panel open state (Unit 6). */
  addPanelOpen: boolean;
  /** Currently-selected kind in the AddElementPanel kind picker. */
  addPanelKind: string | null;
  /** True when any field in the AddElementPanel form has been touched. */
  addPanelDirty: boolean;
  setCase: (selection: CaseSelection) => void;
  setTopology: (topology: TopologySummary | null) => void;
  setLayoutSidecar: (sidecar: SidecarLayout | null) => void;
  setSelectedElement: (element: SelectedElement | null) => void;
  openAddPanel: (kind: string | null) => void;
  closeAddPanel: () => void;
  setAddPanelKind: (kind: string | null) => void;
  setAddPanelDirty: (dirty: boolean) => void;
  clearCase: () => void;
}

export const useCaseStore = create<CaseState>((set) => ({
  selection: null,
  topology: null,
  layoutSidecar: null,
  selectedElement: null,
  addPanelOpen: false,
  addPanelKind: null,
  addPanelDirty: false,
  setCase: (selection: CaseSelection) =>
    // A new case wipes the old topology + sidecar + selection so
    // consumers don't see stale data while the new fetches are in flight.
    set({
      selection,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
    }),
  setTopology: (topology: TopologySummary | null) => set({ topology }),
  setLayoutSidecar: (sidecar: SidecarLayout | null) => set({ layoutSidecar: sidecar }),
  setSelectedElement: (element: SelectedElement | null) => set({ selectedElement: element }),
  openAddPanel: (kind: string | null) =>
    set({ addPanelOpen: true, addPanelKind: kind, addPanelDirty: false }),
  closeAddPanel: () =>
    set({ addPanelOpen: false, addPanelKind: null, addPanelDirty: false }),
  setAddPanelKind: (kind: string | null) =>
    set({ addPanelKind: kind, addPanelDirty: false }),
  setAddPanelDirty: (dirty: boolean) => set({ addPanelDirty: dirty }),
  clearCase: () =>
    set({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
    }),
}));
