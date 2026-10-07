/**
 * SLD slice (Unit 11 of the v2.0 polish plan).
 *
 * Tracks SLD-canvas-specific UI state that doesn't belong on the case
 * slice (which holds element handles + topology) or the ui slice
 * (which holds dock + theme prefs).
 *
 * Why a dedicated slice rather than extending `case.ts`:
 *
 *  - `selectedNodeId` is a *display* concern (which React Flow node is
 *    visually highlighted + centred), not a *case* concern (which
 *    element the inspector is inspecting). They USUALLY coincide, but
 *    not always — a `meta+/` search that pans to a node should not
 *    necessarily change the inspected element until the user clicks.
 *    Keeping them separate gives later units room to diverge.
 *  - The pub-sub event for "open the search popover from the palette"
 *    deliberately does NOT live on a Zustand store — it's a transient
 *    intent, not a state, so it follows the existing
 *    `subscribePaletteDialog` pattern from `lib/commands.ts`.
 *
 * `selectedNodeId` is the React Flow node id (bus idx string for buses,
 * `${kind}-${idx}` for non-bus device nodes) — the same shape that
 * `SldCanvas`'s `onNodeClick` already produces.
 */
import { create } from 'zustand';
import { useCaseStore } from './case';

export interface SldState {
  /**
   * The currently-highlighted React Flow node, or null if none.
   *
   * Two write paths:
   *
   *  1. `SldCanvas.onNodeClick` writes the clicked node's id so the
   *     inspector and the bus-node visual highlight follow the click.
   *  2. `SldNodeSearch` writes the row's id when the user picks a
   *     match; the canvas's effect calls `setCenter()` to pan there.
   *  3. The v3 BottomDrawer per-bucket grids (`BusesGrid`, `LinesGrid`,
   *     `GeneratorsGrid`, `LoadsGrid`, `ShuntsGrid`) write the row's id
   *     so the SLD pans to the chosen element. (Replaced the v2
   *     ``ResultsTable.onRowClick`` writer retired in v3 Unit 15.)
   *
   * Read by `BusNode` (visual highlight) and `SldCanvas` (pan effect).
   */
  selectedNodeId: string | null;
  /**
   * True when the node was picked on the diagram itself: a click on it, or an
   * item of its right-click menu. The canvas then leaves the zoom alone, since
   * the user is pointing at what they see. A pick made anywhere else (a table
   * row, the search, the inspector) is a request to be shown the node, and
   * the canvas zooms in on it when the diagram is too small to read.
   */
  selectedOnDiagram: boolean;
  /** `from: 'diagram'` marks a pick made on the diagram (`selectedOnDiagram`). */
  setSelectedNodeId: (id: string | null, from?: 'diagram') => void;
  clearSelectedNodeId: () => void;
  /**
   * The nodes picked on the diagram together: by a box drawn with Shift held,
   * or by clicks with Ctrl (Cmd on a Mac) held. With two or more of them the
   * diagram shows those as selected in place of `selectedNodeId`, they move
   * together, and they are what Align and Distribute act on. The canvas keeps
   * it from React Flow's own selection; a pick made away from the diagram
   * (a table row, the search) empties it, since it asks for one node.
   */
  pickedNodeIds: string[];
  setPickedNodeIds: (ids: string[]) => void;
  /**
   * How many of them the diagram shows as picked: the ones that are drawn
   * and can be moved, counted from two. It is what Align and Distribute have
   * to act on, so the commands that offer them read this and not the ids.
   * Written by the mounted canvas, and 0 with none mounted.
   */
  pickedCount: number;
  setPickedCount: (count: number) => void;
  /**
   * The lock of the diagram's controls is on: nothing can be dragged or
   * selected, and the commands that arrange the diagram say so and do
   * nothing. Written by the mounted canvas, and false with none mounted.
   */
  diagramLocked: boolean;
  setDiagramLocked: (locked: boolean) => void;
  /**
   * How many lines, transformers and device connectors of the diagram are
   * routed by hand: what Reset manual routes has to act on. Written by the
   * mounted canvas, and 0 with none mounted.
   */
  manualRouteCount: number;
  setManualRouteCount: (count: number) => void;
}

export const useSldStore = create<SldState>((set) => ({
  selectedNodeId: null,
  selectedOnDiagram: false,
  setSelectedNodeId: (id: string | null, from?: 'diagram') =>
    set((s) => ({
      selectedNodeId: id,
      selectedOnDiagram: id !== null && from === 'diagram',
      pickedNodeIds: from === 'diagram' || s.pickedNodeIds.length === 0 ? s.pickedNodeIds : [],
    })),
  clearSelectedNodeId: () => set({ selectedNodeId: null, selectedOnDiagram: false }),
  pickedNodeIds: [],
  setPickedNodeIds: (ids: string[]) =>
    set((s) =>
      s.pickedNodeIds.length === ids.length && s.pickedNodeIds.every((id, i) => id === ids[i])
        ? s
        : { pickedNodeIds: ids },
    ),
  pickedCount: 0,
  setPickedCount: (count: number) => set({ pickedCount: count }),
  diagramLocked: false,
  setDiagramLocked: (locked: boolean) => set({ diagramLocked: locked }),
  manualRouteCount: 0,
  setManualRouteCount: (count: number) => set({ manualRouteCount: count }),
}));

// The nodes picked together are those of one diagram. A bus goes by its idx,
// which the next case has as well, so another case (or none) starts with
// nothing picked. Wired here, as the layout history wires its own reset, so
// it holds wherever the store is in use.
let wiredSelection: unknown = useCaseStore.getState().selection;
useCaseStore.subscribe((state) => {
  if (state.selection === wiredSelection) return;
  wiredSelection = state.selection;
  if (useSldStore.getState().pickedNodeIds.length > 0) {
    useSldStore.setState({ pickedNodeIds: [], pickedCount: 0 });
  }
});

// ---------------------------------------------------------------------------
// SLD search popover bridge.
//
// Mirrors the `subscribePaletteDialog` channel in `lib/commands.ts`:
// the command palette + topbar menu post a "open the SLD search" intent
// here; the `SldNodeSearch` component subscribes once on mount and
// flips its local Radix Popover open state.
//
// We deliberately keep this OUT of the Zustand store — the popover's
// `open` state is owned by Radix + the local React tree, and lifting it
// to global state would require careful handling of the close-on-pick
// cascade that Radix already gets right.
// ---------------------------------------------------------------------------

type Listener = () => void;
const searchListeners: Set<Listener> = new Set();

/** Fire all subscribed search-popover-open listeners. */
export function __requestOpenSldSearch(): void {
  for (const l of searchListeners) l();
}

/**
 * Subscribe to "open the SLD search popover" intents. Returns an
 * unsubscribe function. The `SldNodeSearch` component subscribes once
 * on mount and toggles its local Radix Popover state when the event
 * fires.
 */
export function subscribeOpenSldSearch(listener: Listener): () => void {
  searchListeners.add(listener);
  return () => {
    searchListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Canvas command bridge.
//
// Fit view, Reset to auto-layout, the choice of how device connectors are
// drawn, Tidy diagram, resetting the routes drawn by hand, undoing a change to
// the arrangement and aligning what is picked are commands in the registry
// (palette, shortcuts) but act on
// state only the mounted canvas holds: React Flow's viewport, and the diagram
// as it is drawn. Same shape as the search bridge above: the registry posts an
// intent, the canvas subscribes once on mount. With no canvas mounted (no case
// loaded, or the full-space results view) a request reaches nobody, which is
// fine: the registry gates these commands on there being a diagram to act on.
// ---------------------------------------------------------------------------

export type SldCommand =
  | 'fit-view'
  | 'reset-layout'
  | 'connectors-straight'
  | 'connectors-elbow'
  /** Route every line and transformer afresh, with nothing moved. */
  | 'tidy'
  /** The same, after the buses are lined up on the grid and the devices put back beside them. */
  | 'tidy-relayout'
  | 'undo-layout'
  | 'redo-layout'
  /** Give every line that was routed by hand back to the automatic routing. */
  | 'reset-manual-routes'
  | 'align-left'
  | 'align-centre'
  | 'align-right'
  | 'align-top'
  | 'align-middle'
  | 'align-bottom'
  | 'distribute-horizontal'
  | 'distribute-vertical';

type CommandListener = (command: SldCommand) => void;
const commandListeners: Set<CommandListener> = new Set();

/** Ask the mounted canvas to run `command`. */
export function __requestSldCommand(command: SldCommand): void {
  for (const l of commandListeners) l(command);
}

/**
 * Subscribe to canvas commands. Returns an unsubscribe function. `SldCanvas`
 * subscribes once on mount.
 */
export function subscribeSldCommand(listener: CommandListener): () => void {
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Generating-unit bridge.
//
// The symbol of a generating unit has a control that draws its control chain
// out and folds it away again, and the right-click menu has the same item.
// Whether a chain is drawn out is part of the layout, which the mounted canvas
// keeps and writes beside the case, so both post the intent here and the
// canvas acts on it, as it does on the commands above.
// ---------------------------------------------------------------------------

type UnitListener = (unitIdx: string, expanded: boolean) => void;
const unitListeners: Set<UnitListener> = new Set();

/** Ask the mounted canvas to draw the chain of a generating unit out, or to fold it away. */
export function __requestUnitExpanded(unitIdx: string, expanded: boolean): void {
  for (const l of unitListeners) l(unitIdx, expanded);
}

/**
 * Subscribe to requests to draw a unit's chain out or fold it away. Returns an
 * unsubscribe function. `SldCanvas` subscribes once on mount.
 */
export function subscribeUnitExpanded(listener: UnitListener): () => void {
  unitListeners.add(listener);
  return () => {
    unitListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Line-route bridge.
//
// A line of the diagram is picked to have its route moved by hand with a click
// on it. A line is a pixel or two wide, which not every pointer can be aimed
// at, and a row of the Lines table names the same line: picking the row posts
// the intent here, and the canvas shows the handles of that line and brings it
// into view, as a click on the line does.
// ---------------------------------------------------------------------------

type RouteListener = (branchIdx: string) => void;
const routeListeners: Set<RouteListener> = new Set();

/** Ask the mounted canvas to pick the line or transformer `branchIdx`, so that its route can be moved by hand. */
export function __requestRouteEdit(branchIdx: string): void {
  for (const l of routeListeners) l(branchIdx);
}

/**
 * Subscribe to requests to pick a line. Returns an unsubscribe function.
 * `SldCanvas` subscribes once on mount.
 */
export function subscribeRouteEdit(listener: RouteListener): () => void {
  routeListeners.add(listener);
  return () => {
    routeListeners.delete(listener);
  };
}
