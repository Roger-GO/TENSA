/**
 * Connectivity slice (Unit 17 of the v2.0 plan).
 *
 * Holds the most-recent ``ConnectivityResult`` for the active session
 * and a memoised set of "energised" bus idxes (the union of every
 * non-singleton island's bus membership) so :file:`BusNode` can
 * branch O(1) per bus when rendering the SLD's grey-out overlay.
 *
 * Per the plan's Unit 17 auto-fix: post-run only. The connectivity
 * result is set imperatively when the user clicks "Recompute
 * connectivity" on the SLD overlay (via the ``useConnectivity`` query
 * hook); it is NOT recomputed per-streaming-frame. Lifecycle:
 *
 * - Cleared on session change, auth clear, and explicit case change
 *   (cross-slice cascade in ``store/index.ts``). Keeps the SLD from
 *   greying buses based on a stale topology.
 * - The "energised" set is derived inside the setter so reads stay
 *   trivial; we never re-derive on render.
 *
 * The "non-trivial island" carve-out matches ANDES's
 * ``Bus.island_sets`` (which excludes degree-zero buses) — so a bus
 * that is in a connected component is treated as energised, and the
 * lone (singleton-island) buses are the ones the SLD greys out.
 */
import { create } from 'zustand';
import type { ConnectivityResult } from '@/api/types';

/**
 * Predicate for "non-trivial island": more than one bus. Singleton
 * islands (a single degree-zero bus) are de-energised by definition.
 */
export function isEnergisedIsland(island: readonly string[]): boolean {
  return island.length > 1;
}

/**
 * Pure helper: compute the set of energised bus idxes from a
 * ``ConnectivityResult``. Exported so :file:`BusNode` and tests
 * share one source of truth.
 *
 * Empty input (``null`` result) → empty set; the SldCanvas branches
 * on that and skips greying entirely (the user hasn't run
 * connectivity yet).
 */
export function energisedBusIdxesFor(result: ConnectivityResult | null): ReadonlySet<string> {
  if (result === null) return new Set();
  const out = new Set<string>();
  for (const island of result.islands) {
    if (!isEnergisedIsland(island)) continue;
    for (const idx of island) out.add(idx);
  }
  return out;
}

export interface ConnectivityState {
  /** Most-recent connectivity result. ``null`` until the user runs it. */
  result: ConnectivityResult | null;
  /**
   * Memoised set of bus idxes that belong to some non-trivial
   * island (i.e., are energised). ``BusNode`` uses
   * ``!energisedBusIdxes.has(idx)`` to flip the grey-out class.
   * Empty set when ``result === null``.
   */
  energisedBusIdxes: ReadonlySet<string>;

  /**
   * Set the connectivity result and re-derive the energised set in
   * one update. Pass ``null`` to clear (also clears the energised
   * set so consumers see "no data" rather than a stale snapshot).
   */
  setResult: (result: ConnectivityResult | null) => void;
  /**
   * Clear the slice — both the result and the derived set. Used by
   * the cross-slice cascade in ``store/index.ts`` on session /
   * auth / case change.
   */
  clear: () => void;
}

export const useConnectivityStore = create<ConnectivityState>((set) => ({
  result: null,
  energisedBusIdxes: new Set<string>(),
  setResult: (result) =>
    set({
      result,
      energisedBusIdxes: energisedBusIdxesFor(result),
    }),
  clear: () =>
    set({
      result: null,
      energisedBusIdxes: new Set<string>(),
    }),
}));
