/**
 * Line loading and what it means against a line's rating. Pure and
 * import-clean (no React, no stores), so the line edges, the legend, the
 * Lines table and the Violations table all read the same rules.
 *
 * A line is judged by its `loading_pct`: the larger of its two terminal
 * apparent powers as a percentage of its `rate_a`, which the server works out
 * after a power flow. A line the case gives no rating has no loading and is
 * never judged. Over 100 % is an overload; from `LOADING_WARNING_PCT` up to
 * the rating is amber.
 */

/** Loading band of a line. */
export type LoadingBand = 'success' | 'warning' | 'danger' | 'neutral';

/** Loading, in percent of the rating, from which a line is flagged as close to it. */
export const LOADING_WARNING_PCT = 80;

/** Loading, in percent of the rating, above which a line is overloaded. */
export const LOADING_LIMIT_PCT = 100;

/**
 * Judge a line's loading. Beyond the rating is danger, from
 * `LOADING_WARNING_PCT` up to it warning. `null` (a line with no rating) and
 * anything that is not a finite number are neutral: there is nothing to judge.
 * Pure; exported for testing.
 */
export function assessLoading(loadingPct: number | null | undefined): LoadingBand {
  if (typeof loadingPct !== 'number' || !Number.isFinite(loadingPct)) return 'neutral';
  if (loadingPct > LOADING_LIMIT_PCT) return 'danger';
  if (loadingPct >= LOADING_WARNING_PCT) return 'warning';
  return 'success';
}

/** A loading as it is printed: one decimal and a percent sign, `87.3%`. */
export function formatLoading(loadingPct: number): string {
  return `${loadingPct.toFixed(1)}%`;
}

/**
 * A line's standing against its rating in words, for the tooltip of its
 * label and the Violations table. `null` for a line that is not close to
 * its rating, and for one with nothing to judge.
 */
export function loadingStatusText(band: LoadingBand): string | null {
  switch (band) {
    case 'danger':
      return 'Over rating';
    case 'warning':
      return 'Near rating';
    default:
      return null;
  }
}

/**
 * A line's standing against its rating in words for a table cell: the
 * verdict of `loadingStatusText`, or `Within rating` for a line that is not
 * close to it. `null` for a line with no rating, and before a power flow.
 */
export function loadingCheckText(loadingPct: number | null | undefined): string | null {
  const band = assessLoading(loadingPct);
  return band === 'success' ? 'Within rating' : loadingStatusText(band);
}
