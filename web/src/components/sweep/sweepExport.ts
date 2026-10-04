/**
 * CSV for a sensitivity sweep's results: one row per iteration, with the
 * parameter value it ran at and how it ended. Pure function of the record, so
 * it is tested without mounting the panel.
 */
import { recordsToCsv } from '@/components/export/exportToCsv';
import type { SweepRecord } from '@/store/sweep';

export function sweepToCsv(sweep: SweepRecord): Blob {
  const comments = [
    `sweep of ${sweep.parameterKind}, disturbance ${sweep.parameterTarget}, snapshot ${sweep.snapshotName}`,
    `${sweep.iterations.length} of ${sweep.total} iterations, ${sweep.state}`,
  ];
  if (sweep.error !== null) comments.push(`${sweep.error.category}: ${sweep.error.detail}`);
  return recordsToCsv({
    columns: ['iteration', 'parameter_value', 'converged', 'final_t', 'callpert_count', 'error'],
    rows: sweep.iterations.map((it) => [
      it.iteration,
      it.parameter_value,
      it.converged,
      it.final_t,
      it.callpert_count,
      it.error,
    ]),
    comments,
  });
}
