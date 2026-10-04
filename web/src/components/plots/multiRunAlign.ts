import type { RunRecord } from '@/store/runs';

/** The part of a run the alignment reads. */
export type AlignableRun = Pick<RunRecord, 't' | 'seqCount'>;

/**
 * The shared time axis of several runs and where each run's rows sit on it.
 *
 * uPlot's ``AlignedData`` wants every series to share one x column, but
 * overlay runs can have different step sizes and end times. The axis is the
 * union of every run's timestamps, ascending and without repeats.
 */
export interface AlignedRuns {
  /** The merged time axis. */
  t: Float64Array;
  /**
   * One entry per input run, in order: row ``k`` of run ``r`` sits at
   * ``t[rowToAxis[r][k]]``. Its length is the run's ``seqCount``.
   */
  rowToAxis: readonly Int32Array[];
}

/**
 * Merge the time columns of ``runs`` onto one axis, in a single pass.
 *
 * Each run's ``t`` is non-decreasing (a TDS stream's guarantee, which
 * ``findClosestFrameIdx`` already relies on), so the merge walks one cursor
 * per run and emits the smallest unconsumed time each step. That costs
 * O(rows x runs) with plain typed-array reads, where a ``Set`` of the times
 * plus a sort plus a ``Map`` from time to index (the obvious way) hashes
 * every row of every run on every call. Only the rows the runs hold are
 * read, never the over-allocated tails.
 *
 * The result does not depend on the group or the variables being plotted,
 * so a caller aligns once and resamples as many columns as it needs with
 * ``resampleOnto``.
 */
export function alignRuns(runs: readonly AlignableRun[]): AlignedRuns {
  const count = runs.length;
  const times = runs.map((r) => r.t);
  const lengths = runs.map((r) => r.seqCount);
  const rowToAxis = lengths.map((n) => new Int32Array(n));
  const heads = new Array<number>(count).fill(0);
  let total = 0;
  for (const n of lengths) total += n;

  const axis = new Float64Array(total);
  let size = 0;
  for (;;) {
    // The next axis value is the smallest time no run has consumed yet.
    let leader = -1;
    let next = 0;
    for (let r = 0; r < count; r += 1) {
      const head = heads[r]!;
      if (head >= lengths[r]!) continue;
      const value = times[r]![head]!;
      if (leader < 0 || value < next) {
        leader = r;
        next = value;
      }
    }
    if (leader < 0) break;
    axis[size] = next;
    for (let r = 0; r < count; r += 1) {
      let head = heads[r]!;
      const length = lengths[r]!;
      if (head >= length) continue;
      const t = times[r]!;
      // The leader always advances, so a NaN time (never equal to itself)
      // cannot stall the loop. The other runs advance past every row equal
      // to the axis value, repeats within a run included.
      if (r !== leader && t[head] !== next) continue;
      const rows = rowToAxis[r]!;
      do {
        rows[head] = size;
        head += 1;
      } while (head < length && t[head] === next);
      heads[r] = head;
    }
    size += 1;
  }
  return { t: size === total ? axis : axis.slice(0, size), rowToAxis };
}

/**
 * Lay one run's column onto the shared axis. Rows the run has are copied to
 * their place on the axis; every other point of the axis is NaN, which uPlot
 * draws as a gap, so a run that ended early simply has no line past its end.
 * ``rowToAxis`` is the run's entry from ``alignRuns``; ``values`` may be the
 * whole (over-allocated) column, since only the first ``rowToAxis.length``
 * rows are read.
 */
export function resampleOnto(
  values: ArrayLike<number>,
  rowToAxis: Int32Array,
  axisLength: number,
): Float64Array {
  const out = new Float64Array(axisLength).fill(NaN);
  for (let k = 0; k < rowToAxis.length; k += 1) out[rowToAxis[k]!] = values[k]!;
  return out;
}
