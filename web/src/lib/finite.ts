/**
 * The one check of "a number that can be shown, compared or summed": a JS
 * number that is neither NaN nor infinite. A result or a param that is missing,
 * null, text or not finite fails it.
 */

/** Whether `value` is a finite number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `value` when it is a finite number, `null` otherwise. */
export function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}
