/**
 * Per-routine error detail formatters (v3.1 Phase 3, Unit 9) — PURE helpers.
 *
 * The migration of the bespoke error components onto the single
 * `<ProblemDetailsErrorSurface>` primitive keeps each routine's EXACT
 * diagnostic block — iteration count, last mismatch, `t_current`, rows
 * decoded, etc. — by funnelling it through these formatters. They produce the
 * human `detail` string + the `dl`-grid row data that the routine's extras
 * renderer (`RoutineDetailGrid` / `NumericalErrorDetails`) draws.
 *
 * The number formatting + labels match the pre-migration bespoke components
 * 1:1 — see the per-component tests. The JSX renderers live in
 * `routineErrorDetails.tsx`; this file is pure so the formatters stay easy to
 * unit-test and reuse across surfaces.
 */
import type { RunRecord } from '@/store/runs';

/** A single `<dt>/<dd>` pair in a routine detail grid. */
export interface DetailRow {
  /** Monospace key label (matches the bespoke component's `<dt>`). */
  key: string;
  /** Monospace value (matches the bespoke component's `<dd>`). */
  value: string;
  /** Whether the value should truncate (long ids) vs break-words. */
  truncate?: boolean;
}

// ---- PF non-convergence -----------------------------------------------------

export interface PflowConvergenceDetailData {
  iterations: number;
  /** Last Newton mismatch. May be non-finite. */
  mismatch: number;
  runId: string;
}

/** The one-line banner detail for a non-converged PF run. */
export function pflowConvergenceDetail(iterations: number): string {
  return `in ${iterations} iteration${iterations === 1 ? '' : 's'}.`;
}

/**
 * The detail rows for a non-converged PF run (iterations / last mismatch /
 * run_id), with the EXACT pre-migration formatting (`toExponential(3)`,
 * em-dash for a non-finite mismatch).
 */
export function pflowConvergenceRows(data: PflowConvergenceDetailData): DetailRow[] {
  const mismatch = Number.isFinite(data.mismatch) ? data.mismatch.toExponential(3) : '—';
  return [
    { key: 'iterations', value: String(data.iterations) },
    { key: 'last mismatch', value: mismatch },
    { key: 'run_id', value: data.runId, truncate: true },
  ];
}

// ---- TDS numerical instability ----------------------------------------------

/** The one-line banner detail for a halted TDS run. */
export function numericalErrorDetail(): string {
  return '— numerical instability.';
}

/**
 * The detail rows for a halted TDS run — the data backing the bespoke
 * `NumericalErrorDetails` grid (final_t / tf / rows decoded / last reason /
 * run_id), with the EXACT pre-migration number formatting (`toFixed(4)`).
 */
export function numericalErrorRows(run: RunRecord): DetailRow[] {
  return [
    { key: 'final_t', value: `${run.tCurrent.toFixed(4)} s` },
    { key: 'tf (requested)', value: `${run.tf.toFixed(4)} s` },
    { key: 'rows decoded', value: String(run.seqCount) },
    { key: 'last reason', value: run.errorReason ?? '—' },
    { key: 'run_id', value: run.runId, truncate: true },
  ];
}

/** Build the JSON report blob the numerical-error "Copy report" button copies. */
export function numericalErrorReport(run: RunRecord): string {
  return JSON.stringify(
    {
      run_id: run.runId,
      final_t: run.tCurrent,
      tf: run.tf,
      seq_count: run.seqCount,
      error_reason: run.errorReason ?? null,
      timestamp: new Date().toISOString(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    },
    null,
    2,
  );
}
