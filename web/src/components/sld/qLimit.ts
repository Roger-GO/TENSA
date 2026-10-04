/**
 * Where a generator's reactive output stands against its limits. Pure and
 * import-clean (no React, no stores), so the generator node, the legend, the
 * Generators table and the Violations table read the same rules.
 *
 * The power flow does not hold a generator to its `qmin` / `qmax` unless the
 * run enforced them (a PF option), so an output can lie past either one: that is
 * a violation. An output on the limit (the solver's tolerance either side) is the
 * generator running at its limit, which is worth a flag but not a violation, and
 * is where a run that enforced the limits leaves a generator it held. A generator
 * the server sends no limits for (one switched off) has nothing to be judged
 * against.
 */
import type { VoltageBand, VoltageSide } from './voltage';

/** Reactive power, in MVAr, either side of a limit that still counts as on it. */
export const Q_LIMIT_TOLERANCE_MVAR = 0.01;

/** Where an output stands against the generator's limits. */
export type QLimitState =
  | 'within'
  | 'at-max'
  | 'at-min'
  | 'above-max'
  | 'below-min'
  /** Nothing to judge: no output, or no limits. */
  | 'none';

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Judge a generator's reactive output `q` (MVAr) against its limits. Either
 * limit may be missing, and is then not checked. Past a limit wins over on
 * it, and the upper limit over the lower one for a generator whose two
 * limits coincide. Pure; exported for testing.
 */
export function assessQLimit(
  q: number | null | undefined,
  qMin: number | null | undefined,
  qMax: number | null | undefined,
): QLimitState {
  if (!finite(q)) return 'none';
  const hasMax = finite(qMax);
  const hasMin = finite(qMin);
  if (!hasMax && !hasMin) return 'none';
  if (hasMax && q > qMax + Q_LIMIT_TOLERANCE_MVAR) return 'above-max';
  if (hasMin && q < qMin - Q_LIMIT_TOLERANCE_MVAR) return 'below-min';
  if (hasMax && q >= qMax - Q_LIMIT_TOLERANCE_MVAR) return 'at-max';
  if (hasMin && q <= qMin + Q_LIMIT_TOLERANCE_MVAR) return 'at-min';
  return 'within';
}

/** The band and limit end a state is drawn with, as a bus voltage's are. */
export function qLimitMarker(state: QLimitState): {
  band: VoltageBand;
  side: VoltageSide | null;
} {
  switch (state) {
    case 'above-max':
      return { band: 'danger', side: 'high' };
    case 'below-min':
      return { band: 'danger', side: 'low' };
    case 'at-max':
      return { band: 'warning', side: 'high' };
    case 'at-min':
      return { band: 'warning', side: 'low' };
    case 'within':
      return { band: 'success', side: null };
    default:
      return { band: 'neutral', side: null };
  }
}

/** The words for a state, or `null` when there is nothing to say. */
export function qLimitText(state: QLimitState): string | null {
  switch (state) {
    case 'above-max':
      return 'Above Qmax';
    case 'below-min':
      return 'Below Qmin';
    case 'at-max':
      return 'At Qmax';
    case 'at-min':
      return 'At Qmin';
    case 'within':
      return 'Within limits';
    default:
      return null;
  }
}

/** The tooltip and accessible name of a generator's limit marker. */
export function qLimitMarkerLabel(state: QLimitState): string | null {
  switch (state) {
    case 'above-max':
      return 'Reactive power beyond its upper limit';
    case 'below-min':
      return 'Reactive power beyond its lower limit';
    case 'at-max':
      return 'Reactive power at its upper limit';
    case 'at-min':
      return 'Reactive power at its lower limit';
    default:
      return null;
  }
}
