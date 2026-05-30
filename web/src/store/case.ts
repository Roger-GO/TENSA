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
import type { TopologyEntry, TopologySummary, SidecarLayout, WorkspacePath } from '@/api/types';
import type { ControllerSubKind } from '@/lib/controllers';

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
 * The static (power-flow-topology) element kinds. Each mirrors a
 * `TopologySummary` bucket name and is selectable from the SLD canvas or a
 * data grid. Controllers are dynamic devices handled by the separate
 * `'controller'` variant of `SelectedElement` below.
 */
export type StaticElementKind =
  | 'bus'
  | 'line'
  | 'transformer'
  | 'generator'
  | 'load'
  | 'shunt';

/**
 * A handle to one element on the SLD canvas. Written by `SldCanvas`
 * (Unit 8) on node click; read by `ElementInspector` (Unit 9) to drive
 * the right-dock inspector.
 *
 * `kind` mirrors the topology bucket name; `idx` is the ANDES idx as a
 * string so the same shape works for both numeric and string-named idx
 * values.
 *
 * v3.1 Unit 18 widens this to a discriminated union: dynamic controllers
 * (exciters / governors / PSS / renewable / measurement / profile) read
 * from `topology.controllers` and carry an extra `subKind` derived from
 * the controller's ANDES model class (see `@/lib/controllers`). The
 * `subKind` drives the inspector/SLD glyph and per-kind accordion-state
 * persistence; the rendered params still key on the matched entry's real
 * `kind` (e.g. `EXST1`), exactly as for static elements.
 */
export type SelectedElement =
  | { kind: StaticElementKind; idx: string }
  | { kind: 'controller'; subKind: ControllerSubKind; idx: string };

/**
 * Per-node coordinate overrides captured from user drags on the SLD
 * canvas. Lives in the case store (rather than a `useState` inside
 * SldCanvasInner) so the SaveSystemButton can snapshot the current
 * layout into the auto-saved sidecar without prop-drilling. Cleared on
 * case change.
 */
export type DragOverrides = Record<string, { x: number; y: number }>;

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
  /**
   * Drop coordinate captured when the AddElementPanel was opened via a
   * drag-and-drop interaction from the Component Library (v3 Unit 5).
   *
   * Set to a `{x, y}` flow-coordinate when the user drops a tile onto
   * the canvas; null when the panel was opened any other way (the
   * "+ Add element" button, the command palette, the SldEmptySystem
   * CTA). Per the F-FEAS-5 resolution, AddElementPanel reads this
   * field as an optional position seed for the Bus form (Bus is the
   * only kind whose canvas position is user-controllable; non-Bus
   * elements anchor to a parent bus). For non-Bus kinds the field is
   * informational and the panel ignores it.
   */
  addPanelDropCoord: { x: number; y: number } | null;
  /** Per-node coord overrides captured from user drags (Unit 13a). */
  dragOverrides: DragOverrides;
  /**
   * Topology entries flagged as dependents of an in-flight delete attempt
   * (v0.1.y Unit 2). Populated when a ``DELETE`` returns 422 with the
   * ``DeleteBlockedResponse`` body and the user clicks one of the
   * dependent entries to navigate to it; the SLD canvas reads this list
   * and applies a warning ring to the matching nodes so the user can see
   * what's left to clear before re-issuing the delete. Cleared when the
   * blocking delete eventually succeeds (the topology refetch resolves
   * with no dependents) or when the user explicitly clears it.
   */
  pendingDependents: TopologyEntry[];
  setCase: (selection: CaseSelection) => void;
  setDragOverrides: (next: DragOverrides) => void;
  clearDragOverrides: () => void;
  setTopology: (topology: TopologySummary | null) => void;
  setLayoutSidecar: (sidecar: SidecarLayout | null) => void;
  setSelectedElement: (element: SelectedElement | null) => void;
  setPendingDependents: (entries: TopologyEntry[]) => void;
  clearPendingDependents: () => void;
  /**
   * Open the AddElementPanel.
   *
   * `dropCoord` is set when the panel opens via a Component Library
   * drag-drop onto the canvas (v3 Unit 5). Other call sites omit it and
   * the field stays null. Calling with no `dropCoord` argument resets a
   * previously-stored coord so a stale drag from an earlier open doesn't
   * leak into a fresh "+ Add element" click.
   */
  openAddPanel: (kind: string | null, dropCoord?: { x: number; y: number }) => void;
  closeAddPanel: () => void;
  setAddPanelKind: (kind: string | null) => void;
  setAddPanelDirty: (dirty: boolean) => void;
  /** Clear the drop coord WITHOUT closing the panel. Reserved for the
   *  SldCanvas `onDragEnd` cleanup hook per F-DESIGN-1 (called on cancel
   *  drop / out-of-bounds); a no-op in practice because the drop handler
   *  is the only writer and `closeAddPanel` already clears the field. */
  closeAddPanelDropCoord: () => void;
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
  addPanelDropCoord: null,
  dragOverrides: {},
  pendingDependents: [],
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
      addPanelDropCoord: null,
      dragOverrides: {},
      pendingDependents: [],
    }),
  setDragOverrides: (next: DragOverrides) => set({ dragOverrides: next }),
  clearDragOverrides: () => set({ dragOverrides: {} }),
  setTopology: (topology: TopologySummary | null) => set({ topology }),
  setLayoutSidecar: (sidecar: SidecarLayout | null) => set({ layoutSidecar: sidecar }),
  setSelectedElement: (element: SelectedElement | null) => set({ selectedElement: element }),
  setPendingDependents: (entries: TopologyEntry[]) => set({ pendingDependents: entries }),
  clearPendingDependents: () => set({ pendingDependents: [] }),
  openAddPanel: (kind: string | null, dropCoord?: { x: number; y: number }) =>
    set({
      addPanelOpen: true,
      addPanelKind: kind,
      addPanelDirty: false,
      // When called WITHOUT a dropCoord (e.g., from "+ Add element"
      // button or palette), explicitly null the field so a stale coord
      // from an earlier drag-and-drop open doesn't leak into the form.
      addPanelDropCoord: dropCoord ?? null,
    }),
  closeAddPanel: () =>
    set({
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      addPanelDropCoord: null,
    }),
  setAddPanelKind: (kind: string | null) => set({ addPanelKind: kind, addPanelDirty: false }),
  setAddPanelDirty: (dirty: boolean) => set({ addPanelDirty: dirty }),
  closeAddPanelDropCoord: () => set({ addPanelDropCoord: null }),
  clearCase: () =>
    set({
      selection: null,
      topology: null,
      layoutSidecar: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      addPanelDropCoord: null,
      dragOverrides: {},
      pendingDependents: [],
    }),
}));
