import uPlot from 'uplot';
import type { AxisPlan } from './axes';

/**
 * How the y axes of a chart are ranged.
 *
 * uPlot ranges an axis a little beyond its data, and numbers the axis in steps
 * it picks from the span. When the span is minute next to the values (rotor speeds
 * of a case at rest are 1.0000001 and 1.0, the first rows of a run) its steps are
 * smaller than the decimals it rounds to, the tick loop never advances, and it
 * fills an array until JavaScript refuses (``RangeError: Invalid array length``,
 * thrown from a microtask, so the chart skips that draw and the console logs an
 * error). uPlot guards the extreme of this (a span 10 orders of magnitude below the
 * values counts as flat) but not the band between that and a span it can number.
 * Such a signal is flat for anyone reading the chart, so it is ranged as flat.
 */

/** A span smaller than this share of the largest value is drawn as flat. */
export const MIN_RELATIVE_SPAN = 1e-5;

/** uPlot's own y range, except that a span below :data:`MIN_RELATIVE_SPAN` is flat. */
export function readableYRange(_u: uPlot, min: number, max: number): uPlot.Range.MinMax {
  const largest = Math.max(Math.abs(min), Math.abs(max));
  const flat = max - min < MIN_RELATIVE_SPAN * largest;
  return uPlot.rangeNum(flat ? max : min, max, 0.1, true);
}

/** The ``scales`` entries of the y axes in ``axes``, all ranged by :func:`readableYRange`. */
export function yScales(axes: readonly AxisPlan[]): Record<string, uPlot.Scale> {
  return Object.fromEntries(axes.map((axis) => [axis.scale, { range: readableYRange }]));
}
