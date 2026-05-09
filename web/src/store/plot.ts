/**
 * Plot UI slice. Tracks which series the user has selected for the
 * TimeSeriesPlot, and other ephemeral plot UI state (variable-tree
 * filter, expanded groups). Selection is keyed by run id so swapping
 * between active runs preserves each run's picker state.
 *
 * Lifecycle: not persisted across reloads. Cleared per-run on
 * ``resetSelection`` (called from the run flow when a run is reset).
 *
 * Why a dedicated slice rather than a panel-state slice on ``ui.ts``:
 * the selection set is keyed per run id and can grow large (140 buses
 * on NPCC), so we keep it isolated from the UI panel toggles to avoid
 * coupling plot-picker re-renders to unrelated UI state changes.
 */
import { create } from 'zustand';

/** Variable groups the picker recognises (matches ``RunStream.VarGroup``). */
export type VarGroup = 'bus_v' | 'gen_state' | 'line_flow';

/** Set of selected series names per run id. */
export type SelectionByRun = Record<string, ReadonlySet<string>>;

export interface PlotState {
  /**
   * Selected series per run id. The presence of a column name in the
   * set means it should be plotted; absent means hidden. New runs
   * default to empty (no series shown until the user picks any),
   * matching the empty-state copy the picker renders.
   */
  selectedByRun: SelectionByRun;
  /** Per-run text filter for the picker tree. */
  filterByRun: Record<string, string>;
  /**
   * Per-run set of expanded group keys (``"bus_v"``, ``"gen_state"``,
   * ``"line_flow"``). Defaults to all-collapsed; the picker mounts
   * each group expanded only if the user has expanded it.
   */
  expandedByRun: Record<string, ReadonlySet<string>>;
  /**
   * Per-run scrub time. ``null`` (or absent) means **live mode** — the
   * plot cursor + SLD overlay follow incoming frames at ``run.tCurrent``.
   * A number means **scrub mode** — the cursor is pinned at that t and
   * the SLD overlay reflects the closest-frame state.
   *
   * Lives in the plot slice (not the runs slice) because it's a UI
   * concern: the runs slice already exposes ``tCurrent`` (the latest
   * frame's t); ``scrubT`` is purely about where the user has parked
   * the cursor. Keeping it here also means scrub state survives a
   * frame append (which mutates the runs slice but not the plot slice).
   */
  scrubByRun: Record<string, number | null>;
  /**
   * Per-run playback flag. ``true`` while the ScrubControl's rAF loop
   * is advancing ``scrubT`` over wall-clock time; ``false`` when paused.
   * Defaults to ``false`` (paused). The ScrubControl owns the loop and
   * just reads/writes this flag — the store has no opinion about timing.
   */
  playingByRun: Record<string, boolean>;

  /** Toggle a single series. Idempotent — adds if absent, removes if present. */
  toggleSeries: (runId: string, name: string) => void;
  /** Replace the selection for a run with the given set (used by parent toggles). */
  setSelection: (runId: string, names: ReadonlySet<string>) => void;
  /** Set the filter string for a run. Empty string clears the filter. */
  setFilter: (runId: string, filter: string) => void;
  /** Toggle expanded state of a group (e.g., ``"bus_v"``) for a run. */
  toggleExpanded: (runId: string, groupKey: string) => void;
  /**
   * Set the scrub time for a run. Pass ``null`` to return to live mode.
   * Numeric values are stored as-is (clamping to ``[0, tCurrent]`` is
   * the caller's responsibility — the store has no view of run buffers).
   */
  setScrubT: (runId: string, t: number | null) => void;
  /**
   * Set the playback flag for a run. Setting ``false`` does not clear
   * ``scrubT`` — pausing leaves the cursor where it is.
   */
  setPlaying: (runId: string, value: boolean) => void;
  /** Drop a run's plot state entirely (called when a run is reset). */
  resetRun: (runId: string) => void;
  /** Clear every run's plot state (auth/session cascade). */
  clearAll: () => void;
}

export const usePlotStore = create<PlotState>((set, get) => ({
  selectedByRun: {},
  filterByRun: {},
  expandedByRun: {},
  scrubByRun: {},
  playingByRun: {},

  toggleSeries: (runId, name) => {
    const current = get().selectedByRun[runId] ?? new Set<string>();
    const next = new Set(current);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    set({ selectedByRun: { ...get().selectedByRun, [runId]: next } });
  },

  setSelection: (runId, names) => {
    set({ selectedByRun: { ...get().selectedByRun, [runId]: new Set(names) } });
  },

  setFilter: (runId, filter) => {
    set({ filterByRun: { ...get().filterByRun, [runId]: filter } });
  },

  toggleExpanded: (runId, groupKey) => {
    const current = get().expandedByRun[runId] ?? new Set<string>();
    const next = new Set(current);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    set({ expandedByRun: { ...get().expandedByRun, [runId]: next } });
  },

  setScrubT: (runId, t) => {
    set({ scrubByRun: { ...get().scrubByRun, [runId]: t } });
  },

  setPlaying: (runId, value) => {
    set({ playingByRun: { ...get().playingByRun, [runId]: value } });
  },

  resetRun: (runId) => {
    const sel = { ...get().selectedByRun };
    const flt = { ...get().filterByRun };
    const exp = { ...get().expandedByRun };
    const scrub = { ...get().scrubByRun };
    const playing = { ...get().playingByRun };
    delete sel[runId];
    delete flt[runId];
    delete exp[runId];
    delete scrub[runId];
    delete playing[runId];
    set({
      selectedByRun: sel,
      filterByRun: flt,
      expandedByRun: exp,
      scrubByRun: scrub,
      playingByRun: playing,
    });
  },

  clearAll: () =>
    set({
      selectedByRun: {},
      filterByRun: {},
      expandedByRun: {},
      scrubByRun: {},
      playingByRun: {},
    }),
}));

// ---- helpers --------------------------------------------------------------

/**
 * Binary search for the largest index ``i`` where ``t[i] <= target``.
 * Returns ``-1`` when ``target < t[0]`` or ``length === 0``. Used by the
 * ScrubControl + TimeSeriesPlot to translate a scrub time into a frame
 * index for ``uPlot.setCursor({ idx })`` and the SLD overlay lookup.
 *
 * Operates on the **logical prefix** of a Float64Array (the runs slice
 * over-allocates for geometric growth), so callers MUST pass the actual
 * row count via ``length`` rather than ``arr.length``.
 *
 * Assumes ``t`` is monotonically non-decreasing (a guarantee from
 * ANDES TDS streams). Behavior is undefined otherwise.
 */
export function findClosestFrameIdx(t: Float64Array, length: number, target: number): number {
  if (length <= 0) return -1;
  if (target < t[0]!) return -1;
  if (target >= t[length - 1]!) return length - 1;
  let lo = 0;
  let hi = length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (t[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---- column-name parsing --------------------------------------------------

/**
 * Variable-group descriptor. Built from the run's ``columnNames`` list
 * by classifying each column. Bus voltages match ``Bus_<idx>_v``;
 * generator state matches ``Gen_<idx>_<field>`` (omega/delta);
 * line flows match ``Line_<idx>_<field>`` (p/q).
 *
 * Unknown column shapes are dropped — the picker only surfaces the
 * three documented groups. (Forward-compat: a future schema field
 * just won't appear in the picker; the UI falls back to no-op.)
 */
export interface ParsedSeries {
  /** Original column name (key into ``RunRecord.columns``). */
  name: string;
  /** Group bucket. */
  group: VarGroup;
  /** Element identifier (e.g., ``"5"`` for ``Bus_5_v``). */
  elementIdx: string;
  /** Field name within the group (``"v"``, ``"omega"``, ``"delta"``, ``"p"``, ``"q"``). */
  field: string;
}

const BUS_RE = /^Bus_(.+)_v$/;
const GEN_RE = /^Gen_(.+)_(omega|delta)$/;
const LINE_RE = /^Line_(.+)_(p|q)$/;

/**
 * Classify a column name into a ``ParsedSeries`` or ``null`` when the
 * shape doesn't match any documented group.
 */
export function parseColumnName(name: string): ParsedSeries | null {
  const bus = BUS_RE.exec(name);
  if (bus) return { name, group: 'bus_v', elementIdx: bus[1]!, field: 'v' };
  const gen = GEN_RE.exec(name);
  if (gen) return { name, group: 'gen_state', elementIdx: gen[1]!, field: gen[2]! };
  const line = LINE_RE.exec(name);
  if (line) return { name, group: 'line_flow', elementIdx: line[1]!, field: line[2]! };
  return null;
}

/** Human-readable label for a variable group (used in the picker header). */
export function groupLabel(group: VarGroup): string {
  switch (group) {
    case 'bus_v':
      return 'Bus voltages';
    case 'gen_state':
      return 'Generator state';
    case 'line_flow':
      return 'Line flows';
  }
}

/** Y-axis label for a group (used in TimeSeriesPlot). */
export function groupAxisLabel(group: VarGroup): string {
  switch (group) {
    case 'bus_v':
      return 'V (pu)';
    case 'gen_state':
      return 'ω (pu) / δ (rad)';
    case 'line_flow':
      return 'P (MW) / Q (MVar)';
  }
}
