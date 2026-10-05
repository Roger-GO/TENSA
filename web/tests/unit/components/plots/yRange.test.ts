/**
 * ``readableYRange``: uPlot's own y range, except that a span too small to number
 * is drawn as flat. The span below which uPlot's tick loop never ends was found in
 * the browser; here it is checked that the range is what uPlot gives for flat
 * data, and that every other span is left to uPlot.
 */
import { describe, expect, it } from 'vitest';
import uPlot from 'uplot';
import { MIN_RELATIVE_SPAN, readableYRange, yScales } from '@/components/plots/yRange';
import type { AxisPlan } from '@/components/plots/axes';

const unused = null as unknown as uPlot;
const flat = (value: number) => uPlot.rangeNum(value, value, 0.1, true);
const usual = (min: number, max: number) => uPlot.rangeNum(min, max, 0.1, true);

describe('readableYRange', () => {
  it('leaves a span uPlot can number to uPlot', () => {
    expect(readableYRange(unused, 0.9, 1.1)).toEqual(usual(0.9, 1.1));
    expect(readableYRange(unused, -40, 130)).toEqual(usual(-40, 130));
    expect(readableYRange(unused, 1, 1 + 1e-4)).toEqual(usual(1, 1 + 1e-4));
  });

  it('draws a span in the band that overflows the ticks of uPlot as flat', () => {
    // 1e-7 ... 1e-10 of the value: every one of these made uPlot throw in the browser.
    for (const span of [1e-7, 1e-8, 1e-9, 1e-10]) {
      expect(readableYRange(unused, 1, 1 + span)).toEqual(flat(1 + span));
    }
  });

  it('keeps data that is exactly flat as flat, and zeros as uPlot ranges them', () => {
    expect(readableYRange(unused, 1, 1)).toEqual(flat(1));
    expect(readableYRange(unused, 0, 0)).toEqual(usual(0, 0));
  });

  it('judges the span against the largest value, whatever its sign', () => {
    expect(readableYRange(unused, -1 - 1e-8, -1)).toEqual(flat(-1));
    expect(readableYRange(unused, 100, 100 + 1e-4)).toEqual(flat(100 + 1e-4));
    // The same absolute span around a small value is a real swing.
    expect(readableYRange(unused, 0, 1e-4)).toEqual(usual(0, 1e-4));
  });

  it('draws a span just over the floor as data', () => {
    const span = 2 * MIN_RELATIVE_SPAN;
    expect(readableYRange(unused, 1, 1 + span)).toEqual(usual(1, 1 + span));
  });

  it('is a range that always has a width: no tick loop can stand still on it', () => {
    for (const [min, max] of [
      [1, 1 + 1e-9],
      [1, 1],
      [0, 0],
      [0.99998, 1],
    ] as const) {
      const [lo, hi] = readableYRange(unused, min, max) as [number, number];
      expect(hi).toBeGreaterThan(lo);
      expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
    }
  });
});

describe('yScales', () => {
  const axes: AxisPlan[] = [
    { quantity: 'voltage', scale: 'y', side: 'left', unit: 'pu', label: 'V (pu)' },
    { quantity: 'angle', scale: 'y2', side: 'right', unit: '°', label: 'θ (°)' },
  ];

  it('ranges every y axis of a chart', () => {
    const scales = yScales(axes);
    expect(Object.keys(scales)).toEqual(['y', 'y2']);
    expect(scales['y']!.range).toBe(readableYRange);
    expect(scales['y2']!.range).toBe(readableYRange);
  });

  it('names no scale a chart does not draw', () => {
    expect(Object.keys(yScales(axes.slice(0, 1)))).toEqual(['y']);
    expect(yScales([])).toEqual({});
  });
});
