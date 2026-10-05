/**
 * ``buildCursorRows``: the value of every plotted series under each A/B cursor,
 * read from the charts' own data; ``clampToRuns``, which holds a typed time to the
 * stretch the runs cover.
 */
import { describe, expect, it } from 'vitest';
import type uPlot from 'uplot';
import { buildCursorRows, clampToRuns, cursorHint } from '@/components/plots/cursorRows';
import type { CursorChart } from '@/components/plots/cursorRows';
import type { AxisPlan } from '@/components/plots/axes';

const VOLTS: AxisPlan = {
  quantity: 'voltage',
  scale: 'y',
  side: 'left',
  unit: 'pu',
  label: 'V (pu)',
};
const ANGLE: AxisPlan = {
  quantity: 'angle',
  scale: 'y2',
  side: 'right',
  unit: '°',
  label: 'θ (°)',
};

function chart(key: string, data: uPlot.AlignedData, series: uPlot.Series[]): CursorChart {
  return {
    key,
    data,
    axes: [VOLTS, ANGLE],
    options: { width: 100, height: 100, series: [{ label: 't' }, ...series] },
  };
}

const BUS = chart(
  'bus_v',
  [new Float64Array([0, 1, 2]), new Float64Array([1.0, 0.9, 0.8]), new Float64Array([0, 10, 40])],
  [
    { label: 'Bus_1_v', scale: 'y' },
    { label: 'Bus_1_a', scale: 'y2' },
  ],
);

describe('buildCursorRows', () => {
  it('reads each series at each cursor by linear interpolation', () => {
    const rows = buildCursorRows([BUS], { a: 0.5, b: 1.5 });

    expect(rows.map((r) => [r.label, r.a, r.b])).toEqual([
      ['Bus_1_v', expect.closeTo(0.95), expect.closeTo(0.85)],
      ['Bus_1_a', 5, 25],
    ]);
  });

  it('names the axis each series is drawn on, so its unit is known', () => {
    const rows = buildCursorRows([BUS], { a: 0, b: 1 });

    expect(rows.map((r) => r.axis)).toEqual(['V (pu)', 'θ (°)']);
  });

  it('leaves a cursor that is not placed as null', () => {
    const [volts] = buildCursorRows([BUS], { a: 1, b: null });

    expect(volts!.a).toBe(0.9);
    expect(volts!.b).toBeNull();
  });

  it('has no value where the run does not reach, or the series has a gap', () => {
    const gappy = chart(
      'gap',
      [new Float64Array([0, 1, 2, 3]), new Float64Array([1, Number.NaN, 3, 4])],
      [{ label: 'Gap', scale: 'y' }],
    );

    const [row] = buildCursorRows([gappy], { a: 0.5, b: 3.5 });

    expect(row!.a).toBeNull();
    expect(row!.b).toBeNull();
  });

  it('lists every series of every chart, each with a key of its own', () => {
    const other = chart(
      'gen_state',
      [new Float64Array([0, 1]), new Float64Array([1, 1])],
      [{ label: 'Gen_1_omega', scale: 'y' }],
    );

    const rows = buildCursorRows([BUS, other], { a: 0, b: 1 });

    expect(rows.map((r) => r.label)).toEqual(['Bus_1_v', 'Bus_1_a', 'Gen_1_omega']);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it('is empty for no charts', () => {
    expect(buildCursorRows([], { a: 0, b: 1 })).toEqual([]);
  });
});

describe('cursorHint', () => {
  it('says what the next click does', () => {
    expect(cursorHint(undefined)).toBe('Click the plot to place cursor A');
    expect(cursorHint({ a: null, b: null })).toBe('Click the plot to place cursor A');
    expect(cursorHint({ a: 1, b: null })).toBe('Click again to place cursor B');
    expect(cursorHint({ a: 1, b: 2 })).toBe('Click to start over from A');
  });
});

describe('clampToRuns', () => {
  const run = (times: number[], seqCount = times.length) => ({
    t: Float64Array.from(times),
    seqCount,
  });

  it('leaves a time inside the run alone and holds one outside to its ends', () => {
    const runs = [run([1, 2, 3])];

    expect(clampToRuns(2.5, runs)).toBe(2.5);
    expect(clampToRuns(0, runs)).toBe(1);
    expect(clampToRuns(9, runs)).toBe(3);
  });

  it('covers the whole stretch of several runs', () => {
    const runs = [run([0, 1]), run([0.5, 6])];

    expect(clampToRuns(5, runs)).toBe(5);
    expect(clampToRuns(7, runs)).toBe(6);
  });

  it('counts only the rows a run has received, not the room its arrays keep', () => {
    const runs = [run([0, 1, 2, 0, 0], 3)];

    expect(clampToRuns(4, runs)).toBe(2);
  });

  it('leaves the time as it is when no run has rows', () => {
    expect(clampToRuns(4, [])).toBe(4);
    expect(clampToRuns(4, [run([], 0)])).toBe(4);
  });
});
