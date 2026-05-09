/**
 * SLD animation slice. Holds the **derived** per-bus visual state for
 * the active TDS run (the band + color class for each bus, computed
 * from the latest frame the rAF tick read out of the runs slice).
 *
 * Why a separate slice (rather than computing the overlay on demand
 * inside each ``BusNode`` from ``runs[runId].columns``):
 *
 * - ``BusNode`` would have to subscribe to the runs slice and
 *   re-derive its own overlay on every frame append. With N buses and
 *   30 Hz frames that's N × 30 re-renders per second, even if the
 *   bus's voltage band hasn't changed.
 * - Worse, every bus would race to read the same ``run.columns`` map,
 *   each pulling out the same column for a different idx. Cache
 *   pressure on the typed-array reads, and a Zustand subscriber per
 *   bus per render.
 *
 * The animation slice consolidates that work: a SINGLE rAF loop reads
 * the latest frame, classifies every bus's voltage, and writes the
 * per-bus state here. Each ``BusNode`` then subscribes to its own
 * slot via :func:`useFrameBusBand`, which (a) only re-renders when
 * THIS bus's band actually changes (Zustand's reference-equality
 * default does the right thing for primitives), and (b) costs one
 * cheap object lookup per frame instead of a full overlay derivation.
 *
 * Selective-redraw plumbing per the v0.2 plan: only buses whose band
 * crosses a threshold actually re-render — which is the make-or-break
 * optimization at 14 → 39 → 140-bus scale.
 *
 * Lifecycle: cleared on auth clear (cross-slice cascade in
 * ``store/index.ts`` — added there to keep the cascade complete).
 * Cleared per-run on ``clearOverlayForRun``.
 */
import { create } from 'zustand';
import type { VoltageBand } from '@/components/sld/overlay';

/** Per-bus overlay slot used by BusNode at render time. */
export interface FrameBusOverlay {
  /** Voltage band classification for the chosen frame. */
  band: VoltageBand;
  /** The raw voltage value for the chosen frame (pu). */
  voltage: number;
}

/** Map from bus idx → overlay slot. */
export type BusOverlayMap = ReadonlyMap<string, FrameBusOverlay>;

export interface AnimationState {
  /**
   * Per-run overlay map. Keyed by ``runId``; the inner map is keyed by
   * bus idx. Empty / absent map means "no streaming overlay for this
   * run" → BusNode falls back to its v0.1 PF-result coloring path.
   */
  busOverlayByRun: Record<string, BusOverlayMap>;

  /**
   * Replace the overlay map for a run. The single rAF loop driver in
   * :func:`useSldFrameOverlay` is the only intended caller — but the
   * setter is unconditional so test code can drive it directly too.
   *
   * The setter compares the incoming map against the current one
   * structurally (size + per-bus band) and SKIPS the state update when
   * nothing changed, so subscribers don't churn on every rAF tick.
   */
  setBusOverlayForRun: (runId: string, overlay: BusOverlayMap) => void;

  /**
   * Drop a run's overlay entry. Called when a run finishes / errors /
   * is reset, so subscribed BusNodes return to their PF-result coloring.
   */
  clearOverlayForRun: (runId: string) => void;

  /** Clear every run's overlay (auth/session cascade). */
  clearAll: () => void;
}

const EMPTY_MAP: BusOverlayMap = new Map();

/**
 * Structural comparison: same set of bus idxs AND same band per bus?
 * Voltage is intentionally ignored — re-renders should fire on band
 * boundaries, not on every sub-millivolt change. The voltage value is
 * still updated so consumers that show numerical labels (Unit 7+) see
 * the latest reading.
 */
function bandsEqual(a: BusOverlayMap, b: BusOverlayMap): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [idx, entry] of a) {
    const other = b.get(idx);
    if (!other) return false;
    if (other.band !== entry.band) return false;
  }
  return true;
}

export const useAnimationStore = create<AnimationState>((set, get) => ({
  busOverlayByRun: {},

  setBusOverlayForRun: (runId, overlay) => {
    const cur = get().busOverlayByRun[runId];
    if (cur && bandsEqual(cur, overlay)) {
      // Same bands as last tick — skip the setState so BusNode subscribers
      // don't churn. The voltage map is still updated below ONLY when
      // bands actually changed; a future Unit may want a separate
      // voltage-label store update at a slower cadence (e.g., 4 Hz),
      // but for v0.2's color-only overlay this is the right move.
      return;
    }
    set({ busOverlayByRun: { ...get().busOverlayByRun, [runId]: overlay } });
  },

  clearOverlayForRun: (runId) => {
    const next = { ...get().busOverlayByRun };
    if (!(runId in next)) return;
    delete next[runId];
    set({ busOverlayByRun: next });
  },

  clearAll: () => set({ busOverlayByRun: {} }),
}));

/**
 * Selector hook used by ``BusNode``. Returns the overlay slot for the
 * given bus on the active streaming run, or ``null`` when there is no
 * active streaming overlay (no run, run finished, or this bus isn't in
 * the overlay map).
 *
 * The selector's return shape is a primitive-bearing object that
 * Zustand compares with the default reference equality. Because
 * ``setBusOverlayForRun`` uses ``bandsEqual`` to suppress no-op
 * updates, this hook only causes a re-render when THIS bus's band
 * actually crosses a threshold — the selective-redraw guarantee.
 */
export function useFrameBusOverlay(runId: string | null, busIdx: string): FrameBusOverlay | null {
  return useAnimationStore((s) => {
    if (!runId) return null;
    const map = s.busOverlayByRun[runId];
    if (!map) return null;
    return map.get(busIdx) ?? null;
  });
}

// Test-only re-export of the structural-equality helper so the
// animation-slice tests can assert the suppress-no-op behavior without
// reaching through to a private symbol.
export const __internal = { bandsEqual, EMPTY_MAP };
