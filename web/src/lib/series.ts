/**
 * Small pure helpers for reading a sampled signal: the value between two
 * samples, and a number shown to a few significant digits. Used by the A/B
 * cursor readout and the response-metrics table, which must agree with each
 * other and with the chart they annotate.
 */

/**
 * The value of the signal ``(t, y)`` at ``target``, linearly interpolated, or
 * ``null`` when ``target`` lies outside the span the signal is sampled over, or
 * the samples it falls between are not numbers (a gap in the run, or in a
 * run that ended before the others of an overlay).
 *
 * Only the first ``length`` samples count: a run's typed arrays are
 * over-allocated, so the caller passes how many rows are real. ``t`` must not
 * decrease. Where several samples share a time (an event at that instant), the
 * last of them is the value at it.
 */
export function valueAt(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  target: number,
  length: number = Math.min(t.length, y.length),
): number | null {
  if (length <= 0 || !Number.isFinite(target)) return null;
  const first = t[0]!;
  const last = t[length - 1]!;
  if (target < first || target > last) return null;
  // The last sample at or before the target.
  let lo = 0;
  let hi = length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (t[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  const y0 = y[lo]!;
  if (!Number.isFinite(y0)) return null;
  // On a sample (the last one included: the target is not past it).
  if (t[lo] === target || lo === length - 1) return y0;
  const y1 = y[lo + 1]!;
  if (!Number.isFinite(y1)) return null;
  const t0 = t[lo]!;
  const t1 = t[lo + 1]!;
  return y0 + ((y1 - y0) * (target - t0)) / (t1 - t0);
}

/**
 * ``value`` to ``digits`` significant digits, in exponent form when it is very
 * large or very small, and ``–`` when it is missing or not a number.
 */
export function formatSignificant(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || magnitude < 1e-4) return value.toExponential(digits - 1);
  return String(Number(value.toPrecision(digits)));
}
