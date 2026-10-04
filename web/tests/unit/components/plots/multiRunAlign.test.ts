/**
 * ``alignRuns`` / ``resampleOnto`` — the shared time axis behind the
 * multi-run overlay plot. The properties that matter: the axis is the
 * ascending union of every run's timestamps without repeats, every run row
 * lands on its own timestamp, and the over-allocated typed-array tails of a
 * streaming run are never read.
 */
import { describe, it, expect } from 'vitest';
import { alignRuns, resampleOnto } from '@/components/plots/multiRunAlign';

/** A run record's time column: ``t`` over-allocated with a garbage tail. */
function runOf(times: number[], tail = 0) {
  const t = new Float64Array(times.length + tail).fill(-7);
  t.set(times);
  return { t, seqCount: times.length };
}

/** The obvious implementation: a Set of the times, sorted, then a Map back to the index. */
function referenceAlign(runs: ReturnType<typeof runOf>[]) {
  const set = new Set<number>();
  for (const r of runs) for (let i = 0; i < r.seqCount; i += 1) set.add(r.t[i]!);
  const axis = Float64Array.from(set).sort();
  const index = new Map<number, number>();
  axis.forEach((v, j) => index.set(v, j));
  const rowToAxis = runs.map((r) =>
    Int32Array.from({ length: r.seqCount }, (_, k) => index.get(r.t[k]!)!),
  );
  return { axis, rowToAxis };
}

describe('alignRuns', () => {
  it('returns an empty axis for no runs and for runs with no rows', () => {
    expect(alignRuns([]).t.length).toBe(0);
    const empty = alignRuns([runOf([]), runOf([], 4)]);
    expect(empty.t.length).toBe(0);
    expect(empty.rowToAxis.map((m) => m.length)).toEqual([0, 0]);
  });

  it('keeps a single run as it is', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, 0.1, 0.2])]);
    expect(Array.from(t)).toEqual([0, 0.1, 0.2]);
    expect(Array.from(rowToAxis[0]!)).toEqual([0, 1, 2]);
  });

  it('puts runs that share a timeline on the same axis', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, 1, 2]), runOf([0, 1, 2])]);
    expect(Array.from(t)).toEqual([0, 1, 2]);
    expect(Array.from(rowToAxis[0]!)).toEqual([0, 1, 2]);
    expect(Array.from(rowToAxis[1]!)).toEqual([0, 1, 2]);
  });

  it('merges mismatched timelines into their union', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, 2.5, 5]), runOf([0, 5, 10])]);
    expect(Array.from(t)).toEqual([0, 2.5, 5, 10]);
    expect(Array.from(rowToAxis[0]!)).toEqual([0, 1, 2]);
    expect(Array.from(rowToAxis[1]!)).toEqual([0, 2, 3]);
  });

  it('interleaves runs whose timestamps never coincide', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, 1, 2]), runOf([0.5, 1.5]), runOf([3])]);
    expect(Array.from(t)).toEqual([0, 0.5, 1, 1.5, 2, 3]);
    expect(Array.from(rowToAxis[0]!)).toEqual([0, 2, 4]);
    expect(Array.from(rowToAxis[1]!)).toEqual([1, 3]);
    expect(Array.from(rowToAxis[2]!)).toEqual([5]);
  });

  it('gives the rows of a run that repeat a timestamp one slot on the axis', () => {
    // A TDS run repeats the step time when a disturbance fires.
    const { t, rowToAxis } = alignRuns([runOf([0, 1, 1, 2]), runOf([1, 2])]);
    expect(Array.from(t)).toEqual([0, 1, 2]);
    expect(Array.from(rowToAxis[0]!)).toEqual([0, 1, 1, 2]);
    expect(Array.from(rowToAxis[1]!)).toEqual([1, 2]);
  });

  it('reads only the rows a run holds, never its over-allocated tail', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, 1], 6), runOf([0.5], 3)]);
    expect(Array.from(t)).toEqual([0, 0.5, 1]);
    expect(rowToAxis.map((m) => m.length)).toEqual([2, 1]);
  });

  it('terminates and maps every row when a time is NaN', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, NaN, 2]), runOf([1])]);
    expect(t.length).toBeLessThanOrEqual(4);
    for (const rows of rowToAxis) {
      for (const k of rows) expect(k).toBeLessThan(t.length);
    }
    expect(t.includes(1)).toBe(true);
  });

  it('agrees with a Set, sort and Map on random runs', () => {
    // A small seeded generator, so a failure reproduces. A coarse time grid
    // makes runs coincide at some timestamps and repeat others.
    let state = 12345;
    const rand = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const runCount = 1 + Math.floor(rand() * 5);
      const runs: ReturnType<typeof runOf>[] = [];
      for (let r = 0; r < runCount; r += 1) {
        const rows = Math.floor(rand() * 40);
        let time = Math.floor(rand() * 4) / 4;
        const times: number[] = [];
        for (let k = 0; k < rows; k += 1) {
          times.push(time);
          time += Math.floor(rand() * 3) / 4;
        }
        runs.push(runOf(times, Math.floor(rand() * 5)));
      }
      const got = alignRuns(runs);
      const want = referenceAlign(runs);
      expect(Array.from(got.t)).toEqual(Array.from(want.axis));
      got.rowToAxis.forEach((rows, r) => {
        expect(Array.from(rows)).toEqual(Array.from(want.rowToAxis[r]!));
      });
    }
  });
});

describe('resampleOnto', () => {
  it('places a run on the axis and leaves NaN where it has no row', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, 2.5, 5]), runOf([0, 5, 10])]);
    const first = resampleOnto(Float64Array.from([1.0, 0.95, 0.9]), rowToAxis[0]!, t.length);
    expect(Array.from(first.subarray(0, 3))).toEqual([1.0, 0.95, 0.9]);
    expect(Number.isNaN(first[3])).toBe(true);
    const second = resampleOnto(Float64Array.from([1.0, 0.99, 0.98]), rowToAxis[1]!, t.length);
    expect(second[0]).toBe(1.0);
    expect(Number.isNaN(second[1])).toBe(true);
    expect(second[2]).toBe(0.99);
    expect(second[3]).toBe(0.98);
  });

  it('reads only the first rows of an over-allocated column', () => {
    const rows = Int32Array.from([0, 1]);
    const column = Float64Array.from([5, 6, 99, 99]);
    expect(Array.from(resampleOnto(column, rows, 3).subarray(0, 2))).toEqual([5, 6]);
    expect(Number.isNaN(resampleOnto(column, rows, 3)[2])).toBe(true);
  });

  it('keeps the last value of rows that share a timestamp', () => {
    const { t, rowToAxis } = alignRuns([runOf([0, 1, 1])]);
    const out = resampleOnto(Float64Array.from([10, 20, 30]), rowToAxis[0]!, t.length);
    expect(Array.from(out)).toEqual([10, 30]);
  });

  it('returns a fresh array each call', () => {
    const rows = Int32Array.from([0]);
    const column = Float64Array.from([1]);
    expect(resampleOnto(column, rows, 1)).not.toBe(resampleOnto(column, rows, 1));
  });
});
