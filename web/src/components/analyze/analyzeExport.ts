/**
 * CSV for the Analyze panel's results: the eigenvalues, a mode's participation
 * factors, a CPF curve and the SE residuals. Pure functions of the result, so
 * each one is tested without mounting a chart; the charts wire them to their
 * `<ExportMenu>`.
 *
 * Each file is wide-form (one row per mode, step or measurement) and carries
 * the numbers at full precision, not the rounded ones the panel prints. The
 * `#` comment lines say what the run was, for a reader who gets the file
 * without the screen.
 */
import { recordsToCsv } from '@/components/export/exportToCsv';
import type { CpfResult, EigResult, ParticipationFactor, SeResult } from '@/api/types';

/**
 * Every computed eigenvalue, whatever the scatter's display filter hides. The
 * `mode` column is the index the participation endpoint takes as `mode_idx`.
 */
export function eigResultToCsv(result: EigResult): Blob {
  const rows = result.eigenvalues.map((z, i) => [
    i,
    z.real,
    z.imag,
    result.damping_ratios[i],
    result.frequencies_hz[i],
  ]);
  return recordsToCsv({
    columns: ['mode', 'real', 'imag', 'damping_ratio', 'frequency_hz'],
    rows,
    comments: [`${result.mode_count} modes, ${result.state_count} states`],
  });
}

/**
 * The participation factors in the order the table shows them (its filter and
 * sort already applied by the caller). `modeIdx` and `filter` are recorded in
 * the header so a filtered file says it is.
 */
export function participationToCsv(
  rows: readonly ParticipationFactor[],
  modeIdx: number | null,
  filter: string,
): Blob {
  const comments: string[] = [];
  if (modeIdx !== null) comments.push(`participation factors of mode ${modeIdx}`);
  const query = filter.trim();
  if (query !== '') comments.push(`filtered to states matching "${query}"`);
  return recordsToCsv({
    columns: ['state', 'factor'],
    rows: rows.map((r) => [r.state_name, r.factor]),
    comments,
  });
}

/**
 * Every bus's voltage at every step of a CPF run, not only the buses the chart
 * currently shows. The first column is the continuation parameter: lambda for a
 * PV curve, the reactive injection for a QV curve.
 */
export function cpfResultToCsv(result: CpfResult): Blob {
  const isQv = result.mode === 'qv';
  const buses = result.bus_idxes.filter((bus) => result.voltages_per_bus[bus] !== undefined);
  const rows = result.lambdas.map((x, step) => [
    x,
    ...buses.map((bus) => result.voltages_per_bus[bus]?.[step]),
  ]);
  const comments = [
    isQv ? 'CPF QV curve, bus voltages in pu' : 'CPF PV curve, bus voltages in pu',
    `max ${isQv ? 'Q' : 'lambda'} = ${result.max_lam}`,
  ];
  if (result.truncated) comments.push('truncated: no nose point was reached');
  if (result.done_msg) comments.push(result.done_msg);
  return recordsToCsv({
    columns: [isQv ? 'q_injection' : 'lambda', ...buses.map((bus) => `bus_${bus}_v`)],
    rows,
    comments,
  });
}

/**
 * One row per measurement: its residual and whether SE flagged it (more than
 * three sigma from the estimate). `measurement` is the index into
 * `residuals`, which is all the wire shape identifies a measurement by.
 */
export function seResidualsToCsv(result: SeResult): Blob {
  const flagged = new Set(result.flagged_indices);
  return recordsToCsv({
    columns: ['measurement', 'residual', 'flagged'],
    rows: result.residuals.map((r, i) => [i, r, flagged.has(i)]),
    comments: [
      `SE ${result.converged ? 'converged' : 'did not converge'} in ${result.iterations} iterations, ` +
        `J = ${result.mismatch}`,
    ],
  });
}
