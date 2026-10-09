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
import type { ConnectorStyle } from '@/components/sld/connections';
import type { FigureSettings } from '@/components/sld/figure/figureSettings';

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
export type StaticElementKind = 'bus' | 'line' | 'transformer' | 'generator' | 'load' | 'shunt';

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
 *
 * `modelClass` is the controller's ANDES model class (e.g. `EXST1`). ANDES
 * idx is model-local, so two different controllers can share an idx; the
 * inspector disambiguates by `(modelClass, idx)` and the SLD node id is
 * namespaced `controller-<modelClass>-<idx>` (review(phase5)).
 */
export type SelectedElement =
  | {
      kind: StaticElementKind;
      idx: string;
      /**
       * The ANDES model of the element, when a table that knows it selects it. A
       * generator and a machine can share an idx (a Slack 1 and a GENROU 1), and the
       * diagram has one node for both, so the idx alone finds the first of them; the
       * class says which one was meant.
       */
      modelClass?: string;
    }
  | { kind: 'controller'; subKind: ControllerSubKind; modelClass: string; idx: string };

/**
 * Per-node coordinate overrides captured from user drags on the SLD
 * canvas. Lives in the case store (rather than a `useState` inside
 * SldCanvasInner) so they outlive the canvas when the results view takes
 * its place, and so a restored snapshot can set them. Cleared on case
 * change.
 */
export type DragOverrides = Record<string, { x: number; y: number }>;

/**
 * The route of one branch as chosen in this visit: the points it is drawn
 * through, and where its two buses stood when it was made. The diagram draws
 * it only while they still stand there, so a bus that is moved takes its
 * branches along, routed afresh.
 */
export interface RouteOverride {
  points: [number, number][];
  anchors: { source: { x: number; y: number }; target: { x: number; y: number } };
  /**
   * Set on a route that was drawn by hand. The diagram keeps it as it is (a
   * tidy routes the other lines around it) and brings it along when one of
   * its ends is moved, where a route the diagram made is made afresh.
   */
  manual?: true;
}

/**
 * The routes chosen in this visit, by edge id (`line-<idx>`,
 * `transformer-<idx>`, and `stub-<node id>` for the connector of a device
 * that was drawn by hand, whose anchors are where the device and its bus
 * stood): by Tidy diagram, by hand, or by an undo that put an earlier
 * arrangement back. They sit on top of the routes of the saved layout as the
 * drags sit on top of its positions. `null` for a branch says it has no fixed
 * route, whatever the saved layout holds for it: it is routed from where its
 * buses stand, and a connector is worked out from where its device stands.
 */
export type RouteOverrides = Record<string, RouteOverride | null>;

export interface CaseState {
  /** The currently-selected case + addfiles, or null if none loaded. */
  selection: CaseSelection | null;
  /**
   * Workspace path of a case that is being loaded right now, or `null`.
   * `selection` is only set once a load succeeds, so without this the UI
   * reads "No case loaded" for the whole time a slow load runs (the first
   * load of a case also generates ANDES code for its models). Set and cleared
   * by `useLoadCase`.
   */
  loadingPath: string | null;
  /**
   * Last successfully fetched topology summary for the current selection.
   * Mirrors the TanStack Query cache; held here so non-Query consumers
   * (selection-driven side effects) can read the topology synchronously.
   */
  topology: TopologySummary | null;
  /**
   * The workspace file Save system as last wrote a copy of this system to, or
   * `null`. The session goes on editing what it had open, so the Project tab
   * says so until another case is opened (`setCase` and `clearCase` drop it).
   */
  savedCopy: string | null;
  /** Last sidecar layout read, if any. `null` if no sidecar exists yet. */
  layoutSidecar: SidecarLayout | null;
  /**
   * The layout of the diagram as it is drawn now: every position and every
   * fixed route, whatever placed them (a drag, a saved or curated layout, or
   * auto-layout). The canvas writes it each time it rebuilds the diagram, and
   * it stays after the canvas unmounts (the full-space results view). It is what
   * a save sends with the system: Save, Save system as, a snapshot, a bundle.
   * `null` until the diagram of the open case has been drawn once.
   */
  diagramLayout: SidecarLayout | null;
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
   * The bus the AddElementPanel was opened from: "Add element here" in the
   * diagram's right-click menu of a bus. The form of whichever kind is picked
   * opens with that bus chosen, and keeps doing so for the next element until
   * the panel is closed or opened another way. Null otherwise.
   */
  addPanelBus: string | null;
  /** Per-node coord overrides captured from user drags (Unit 13a). */
  dragOverrides: DragOverrides;
  /** The branch routes chosen in this visit; kept here like the drags, for the same reasons. */
  routeOverrides: RouteOverrides;
  /**
   * How the diagram draws the connector of a generator, load or shunt to its
   * bus, as chosen in this visit: a straight line, or one with a right
   * angle. `null` until it is chosen, which leaves it to the saved layout
   * (its `connector_style` figure setting) and to straight without one. Kept
   * here like the drags, so the choice outlives the canvas and reaches the
   * layout every save sends.
   */
  connectorStyle: ConnectorStyle | null;
  /**
   * The choices a figure of the diagram is drawn with, as made in this
   * visit: the ones that were changed, each over what the saved layout holds
   * (in its `figure` section) and over the default without one. `null`
   * until one is changed. Kept here like the connector style, and for the
   * same reasons.
   */
  figureSettings: Partial<FigureSettings> | null;
  /**
   * The generating units whose control chain was drawn out or folded away in
   * this visit, by the idx of the unit: `true` drawn out, `false` folded. A
   * unit absent from it is drawn as the saved layout says (its `units`
   * section), and folded without one. Kept here like the drags and the
   * connector style, and for the same reasons.
   */
  unitExpansion: Record<string, boolean>;
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
  /**
   * Inspector edit/run mode (v3.1 Unit 22). In `'edit'` mode the inspector's
   * whitelisted controller params become editable and commit via the
   * clone-on-write endpoint; `'run'` mode (the default) keeps them read-only.
   * Switching to `'edit'` ensures the clone is initialised on first edit.
   */
  editMode: 'run' | 'edit';
  /**
   * `true` once the per-session clone-on-write copy has been initialised
   * (the first edit, or an explicit init). Gates the Modified-from-Original
   * diff query (Unit 23) — nothing to diff before a clone exists.
   */
  cloneInitialized: boolean;
  /** Number of clone edits recoverable via undo (substrate is source of truth). */
  cloneUndoDepth: number;
  /** Number of undone clone edits re-appliable via redo. */
  cloneRedoDepth: number;
  setCase: (selection: CaseSelection) => void;
  setSavedCopy: (filename: string | null) => void;
  setLoadingPath: (path: string | null) => void;
  setDragOverrides: (next: DragOverrides) => void;
  clearDragOverrides: () => void;
  setRouteOverrides: (next: RouteOverrides) => void;
  /**
   * Set where the nodes stand and how the branches run in one step, and with
   * `unitExpansion` which control chains are drawn out. The diagram is drawn
   * from all of them together, so an arrangement that is put in place (by
   * Tidy diagram, or by an undo) goes in at once: set one after the other,
   * the diagram in between would be half of each.
   */
  setArrangement: (next: {
    dragOverrides: DragOverrides;
    routeOverrides: RouteOverrides;
    unitExpansion?: Record<string, boolean>;
  }) => void;
  setConnectorStyle: (style: ConnectorStyle | null) => void;
  setFigureSettings: (settings: Partial<FigureSettings> | null) => void;
  setUnitExpansion: (next: Record<string, boolean>) => void;
  setTopology: (topology: TopologySummary | null) => void;
  setLayoutSidecar: (sidecar: SidecarLayout | null) => void;
  setDiagramLayout: (layout: SidecarLayout | null) => void;
  setSelectedElement: (element: SelectedElement | null) => void;
  setPendingDependents: (entries: TopologyEntry[]) => void;
  clearPendingDependents: () => void;
  /** Set the inspector edit/run mode (Unit 22). */
  setEditMode: (mode: 'run' | 'edit') => void;
  /** Mark the clone-on-write copy as initialised (Unit 22). */
  setCloneInitialized: (initialized: boolean) => void;
  /**
   * Record the clone undo/redo stack depths returned by an edit / undo /
   * redo response. Also flips `cloneInitialized` true (a depth implies a
   * live clone).
   */
  setCloneDepths: (undoDepth: number, redoDepth: number) => void;
  /** Open the AddElementPanel, on `kind` when one is given. */
  openAddPanel: (kind: string | null) => void;
  /**
   * Open the AddElementPanel from a bus of the diagram: the bus goes to
   * `addPanelBus`, for the form to open on. No kind is picked yet, unless the
   * panel is already open, which keeps the kind it shows.
   */
  openAddPanelOnBus: (busIdx: string) => void;
  closeAddPanel: () => void;
  setAddPanelKind: (kind: string | null) => void;
  setAddPanelDirty: (dirty: boolean) => void;
  clearCase: () => void;
}

export const useCaseStore = create<CaseState>((set) => ({
  selection: null,
  loadingPath: null,
  topology: null,
  savedCopy: null,
  layoutSidecar: null,
  diagramLayout: null,
  selectedElement: null,
  addPanelOpen: false,
  addPanelKind: null,
  addPanelDirty: false,
  addPanelBus: null,
  dragOverrides: {},
  routeOverrides: {},
  connectorStyle: null,
  figureSettings: null,
  unitExpansion: {},
  pendingDependents: [],
  editMode: 'run',
  cloneInitialized: false,
  cloneUndoDepth: 0,
  cloneRedoDepth: 0,
  setCase: (selection: CaseSelection) =>
    // A new case wipes the old topology + sidecar + selection so
    // consumers don't see stale data while the new fetches are in flight.
    // The clone-on-write state is per-case too — a new case has no clone.
    set({
      selection,
      topology: null,
      savedCopy: null,
      layoutSidecar: null,
      diagramLayout: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      addPanelBus: null,
      dragOverrides: {},
      routeOverrides: {},
      connectorStyle: null,
      figureSettings: null,
      unitExpansion: {},
      pendingDependents: [],
      editMode: 'run',
      cloneInitialized: false,
      cloneUndoDepth: 0,
      cloneRedoDepth: 0,
    }),
  setSavedCopy: (filename: string | null) => set({ savedCopy: filename }),
  setLoadingPath: (path: string | null) => set({ loadingPath: path }),
  setDragOverrides: (next: DragOverrides) => set({ dragOverrides: next }),
  clearDragOverrides: () => set({ dragOverrides: {} }),
  setRouteOverrides: (next: RouteOverrides) => set({ routeOverrides: next }),
  setArrangement: (next) =>
    set({
      dragOverrides: next.dragOverrides,
      routeOverrides: next.routeOverrides,
      ...(next.unitExpansion === undefined ? {} : { unitExpansion: next.unitExpansion }),
    }),
  setConnectorStyle: (style: ConnectorStyle | null) => set({ connectorStyle: style }),
  setFigureSettings: (settings: Partial<FigureSettings> | null) =>
    set({ figureSettings: settings }),
  setUnitExpansion: (next: Record<string, boolean>) => set({ unitExpansion: next }),
  setTopology: (topology: TopologySummary | null) => set({ topology }),
  setLayoutSidecar: (sidecar: SidecarLayout | null) => set({ layoutSidecar: sidecar }),
  setDiagramLayout: (layout: SidecarLayout | null) => set({ diagramLayout: layout }),
  setSelectedElement: (element: SelectedElement | null) => set({ selectedElement: element }),
  setPendingDependents: (entries: TopologyEntry[]) => set({ pendingDependents: entries }),
  clearPendingDependents: () => set({ pendingDependents: [] }),
  setEditMode: (mode: 'run' | 'edit') => set({ editMode: mode }),
  setCloneInitialized: (initialized: boolean) => set({ cloneInitialized: initialized }),
  setCloneDepths: (undoDepth: number, redoDepth: number) =>
    set({ cloneUndoDepth: undoDepth, cloneRedoDepth: redoDepth, cloneInitialized: true }),
  openAddPanel: (kind: string | null) =>
    set({
      addPanelOpen: true,
      addPanelKind: kind,
      addPanelDirty: false,
      // Not on the bus of an earlier "Add element here".
      addPanelBus: null,
    }),
  openAddPanelOnBus: (busIdx: string) =>
    set((s) => ({
      addPanelOpen: true,
      // A panel that is open keeps the kind it shows: the same form, on this bus.
      addPanelKind: s.addPanelOpen ? s.addPanelKind : null,
      addPanelDirty: false,
      addPanelBus: busIdx,
    })),
  closeAddPanel: () =>
    set({
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      addPanelBus: null,
    }),
  setAddPanelKind: (kind: string | null) => set({ addPanelKind: kind, addPanelDirty: false }),
  setAddPanelDirty: (dirty: boolean) => set({ addPanelDirty: dirty }),
  clearCase: () =>
    set({
      selection: null,
      topology: null,
      savedCopy: null,
      layoutSidecar: null,
      diagramLayout: null,
      selectedElement: null,
      addPanelOpen: false,
      addPanelKind: null,
      addPanelDirty: false,
      addPanelBus: null,
      dragOverrides: {},
      routeOverrides: {},
      connectorStyle: null,
      figureSettings: null,
      unitExpansion: {},
      pendingDependents: [],
      editMode: 'run',
      cloneInitialized: false,
      cloneUndoDepth: 0,
      cloneRedoDepth: 0,
    }),
}));
