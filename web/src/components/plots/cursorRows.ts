import type uPlot from 'uplot';
import type { DeltaCursors } from '@/store/plot';
import { valueAt } from '@/lib/series';
import type { AxisPlan } from './axes';

/** One plotted series as the cursor readout shows it. */
export interface CursorRow {
  /** Stable key: the chart and the series' place in it. */
  key: string;
  /** The series' legend label. */
  label: string;
  /** What its axis reads (``V (pu)``, ``δ (°)``): the unit the values below are in. */
  axis: string;
  /** Its value at cursor A and at cursor B; ``null`` while the cursor is not placed or the series has no value there. */
  a: number | null;
  b: number | null;
}

/** What the readout needs of one chart of the plot: its uPlot options and data, and its axes. */
export interface CursorChart {
  key: string;
  options: uPlot.Options;
  data: uPlot.AlignedData;
  axes: readonly AxisPlan[];
}

/**
 * The value of every plotted series at each cursor, read from the data the
 * charts were handed, so each is in the unit its chart shows it in (kV or pu,
 * Hz or pu, degrees) and a run that ended before the cursor has none there.
 */
export function buildCursorRows(
  charts: readonly CursorChart[],
  cursors: DeltaCursors,
): CursorRow[] {
  const rows: CursorRow[] = [];
  for (const chart of charts) {
    const x = chart.data[0] as ArrayLike<number>;
    const series = chart.options.series ?? [];
    for (let i = 1; i < series.length; i += 1) {
      const y = chart.data[i] as ArrayLike<number> | undefined;
      if (y === undefined) continue;
      const entry = series[i]!;
      const axis = chart.axes.find((candidate) => candidate.scale === entry.scale);
      rows.push({
        key: `${chart.key}:${i}`,
        label: typeof entry.label === 'string' ? entry.label : `${chart.key} ${i}`,
        axis: axis?.label ?? '',
        a: cursors.a === null ? null : valueAt(x, y, cursors.a),
        b: cursors.b === null ? null : valueAt(x, y, cursors.b),
      });
    }
  }
  return rows;
}

/** What the next click on the plot does, from where the cursors stand. */
export function cursorHint(cursors: DeltaCursors | undefined): string {
  if (cursors === undefined || cursors.a === null) return 'Click the plot to place cursor A';
  if (cursors.b === null) return 'Click again to place cursor B';
  return 'Click to start over from A';
}

/**
 * ``t`` held to the stretch of time the runs cover, so a time typed for a
 * cursor lands on the plot and not past its end, where nothing draws it.
 */
export function clampToRuns(
  t: number,
  runs: readonly { t: ArrayLike<number>; seqCount: number }[],
): number {
  let first = Infinity;
  let last = -Infinity;
  for (const run of runs) {
    if (run.seqCount === 0) continue;
    first = Math.min(first, run.t[0] ?? Infinity);
    last = Math.max(last, run.t[run.seqCount - 1] ?? -Infinity);
  }
  return first <= last ? Math.min(last, Math.max(first, t)) : t;
}
