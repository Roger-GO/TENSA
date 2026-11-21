/**
 * What is read off a set of eigenvalues, by one rule wherever it is shown: the
 * eigenvalue scatter, the parameter sweep's table and the HTML report.
 */
import type { ComplexNumber } from '@/api/types';

/**
 * How many of ``eigenvalues`` are unstable: a positive real part. An
 * eigenvalue the server counts as zero arrives as exactly ``{0, 0}`` and is
 * not counted, since nothing may turn on the sign of a number that is zero.
 */
export function unstableModeCount(eigenvalues: readonly (ComplexNumber | undefined)[]): number {
  let n = 0;
  for (const z of eigenvalues) {
    if (z !== undefined && z.real > 0) n += 1;
  }
  return n;
}

/**
 * The smallest damping ratio of a set of modes, every mode counted. A zero
 * eigenvalue carries a ratio of 1, so it is the smallest only of a set that
 * holds nothing else. ``null`` for a set with no modes.
 */
export function smallestDampingRatio(dampingRatios: readonly number[]): number | null {
  if (dampingRatios.length === 0) return null;
  return Math.min(...dampingRatios);
}
