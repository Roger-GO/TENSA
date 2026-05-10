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
   *  3. `ResultsTable.onRowClick` writes the row's id so the SLD pans
   *     to the chosen element.
   *
   * Read by `BusNode` (visual highlight) and `SldCanvas` (pan effect).
   */
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  clearSelectedNodeId: () => void;
}

export const useSldStore = create<SldState>((set) => ({
  selectedNodeId: null,
  setSelectedNodeId: (id: string | null) => set({ selectedNodeId: id }),
  clearSelectedNodeId: () => set({ selectedNodeId: null }),
}));

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
