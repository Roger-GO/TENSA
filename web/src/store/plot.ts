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

  /** Toggle a single series. Idempotent — adds if absent, removes if present. */
  toggleSeries: (runId: string, name: string) => void;
  /** Replace the selection for a run with the given set (used by parent toggles). */
  setSelection: (runId: string, names: ReadonlySet<string>) => void;
  /** Set the filter string for a run. Empty string clears the filter. */
  setFilter: (runId: string, filter: string) => void;
  /** Toggle expanded state of a group (e.g., ``"bus_v"``) for a run. */
  toggleExpanded: (runId: string, groupKey: string) => void;
  /** Drop a run's plot state entirely (called when a run is reset). */
  resetRun: (runId: string) => void;
  /** Clear every run's plot state (auth/session cascade). */
  clearAll: () => void;
}

export const usePlotStore = create<PlotState>((set, get) => ({
  selectedByRun: {},
  filterByRun: {},
  expandedByRun: {},

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

  resetRun: (runId) => {
    const sel = { ...get().selectedByRun };
    const flt = { ...get().filterByRun };
    const exp = { ...get().expandedByRun };
    delete sel[runId];
    delete flt[runId];
    delete exp[runId];
    set({ selectedByRun: sel, filterByRun: flt, expandedByRun: exp });
  },

  clearAll: () => set({ selectedByRun: {}, filterByRun: {}, expandedByRun: {} }),
}));

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
