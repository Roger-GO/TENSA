/**
 * Exponential-backoff helper for `RunStream` reconnect.
 *
 * Sequence (ms): 250, 500, 1000, 2000, 4000, 8000 — capped, max attempts =
 * 5 (per Unit 2 plan, "Reconnect/resume integration"). After
 * ``maxAttempts`` failures, ``RunStream`` emits
 * ``onConnectionStatus({state: "disconnected", reason: "max_retries"})``
 * and the UI surfaces the permanent-failure modal.
 *
 * Implementation note: kept as a tiny pure helper rather than inlined into
 * ``RunStream`` so the math is unit-testable in isolation. The schedule is
 * exposed (not hidden) — tests assert against the exact delay sequence.
 */

/** Default reconnect schedule per Unit 2 plan. */
export const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000, 8000];

/** Default cap on reconnect attempts before giving up. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

export interface BackoffOptions {
  /**
   * Schedule of delays between attempts. ``delayForAttempt(n)`` returns
   * ``delays[min(n, delays.length - 1)]`` so the last value caps further
   * attempts. Defaults to :data:`DEFAULT_RECONNECT_DELAYS_MS`.
   */
  delays?: readonly number[];
  /**
   * Maximum number of reconnect attempts before
   * :func:`shouldGiveUp` returns true. Defaults to
   * :data:`DEFAULT_MAX_RECONNECT_ATTEMPTS`.
   */
  maxAttempts?: number;
}

/**
 * Returns the backoff delay (ms) for the ``attempt``-th reconnect (0-indexed).
 *
 * Past the end of the schedule, the last value is repeated (capped). If
 * ``attempt`` exceeds ``maxAttempts``, ``null`` is returned to signal the
 * caller should stop.
 */
export function delayForAttempt(attempt: number, opts: BackoffOptions = {}): number | null {
  const delays = opts.delays ?? DEFAULT_RECONNECT_DELAYS_MS;
  const max = opts.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  if (attempt < 0) return null;
  if (attempt >= max) return null;
  if (delays.length === 0) return 0;
  const idx = Math.min(attempt, delays.length - 1);
  return delays[idx]!;
}

/**
 * Convenience predicate: true when ``attempt`` (0-indexed) has reached the
 * give-up threshold. Mirrors the negation of ``delayForAttempt`` returning
 * a number, but reads more clearly at call sites that branch on "should I
 * retry one more time?"
 */
export function shouldGiveUp(attempt: number, opts: BackoffOptions = {}): boolean {
  const max = opts.maxAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  return attempt >= max;
}
