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
import {
  directionLabel,
  generatorName,
  hasLowerBranch,
  lambdaMeaning,
  limitName,
} from '@/lib/cpfOptions';
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
 * What a CPF run was asked for and what it found, as the `#` lines of its
 * files: the direction, whether Q limits were enforced, the generators held
 * at a limit with where each got there, and where the lower branch starts.
 */
function cpfComments(result: CpfResult): string[] {
  const isQv = result.mode === 'qv';
  const symbol = isQv ? 'Q' : 'lambda';
  const comments: string[] = [];
  if (!isQv && result.direction !== undefined && result.direction !== null) {
    comments.push(
      `direction: ${directionLabel(result.direction)} (${lambdaMeaning(result.direction).replace('λ', 'lambda')})`,
    );
  }
  if (result.q_limits_enforced !== undefined) {
    comments.push(
      result.q_limits_enforced
        ? 'generator Q limits enforced along the path'
        : 'generator Q limits not enforced along the path',
    );
  }
  for (const event of result.limit_events ?? []) {
    const where =
      event.step === 0
        ? 'from the start (held by the power flow)'
        : `from step ${event.step} (${symbol} = ${event.lam})`;
    const release = event.would_release_step;
    comments.push(
      `${generatorName(event)} on bus ${event.bus} held at ${limitName(event.limit)} ${where}` +
        (event.at_nose ? ': the nose is where it reached the limit' : '') +
        (release !== null && release !== undefined
          ? `; from step ${release} its voltage is back across the set-point and a real exciter would leave the limit`
          : ''),
    );
  }
  if (hasLowerBranch(result)) {
    comments.push(
      `full curve: steps 0 to ${result.nose_idx} are the upper branch, the rest the lower branch`,
    );
  }
  if (!result.truncated && result.complete === false) {
    comments.push('the lower branch stops before it is back at the base load');
  }
  return comments;
}

/**
 * Every bus's voltage at every step of a CPF run, not only the buses the chart
 * currently shows, followed by every generator's reactive output. The first
 * column is the continuation parameter: lambda for a PV curve, the reactive
 * injection for a QV curve.
 */
export function cpfResultToCsv(result: CpfResult): Blob {
  const isQv = result.mode === 'qv';
  const buses = result.bus_idxes.filter((bus) => result.voltages_per_bus[bus] !== undefined);
  const generators = result.generators ?? [];
  const rows = result.lambdas.map((x, step) => [
    x,
    ...buses.map((bus) => result.voltages_per_bus[bus]?.[step]),
    ...generators.map((g) => g.q[step]),
  ]);
  const comments = [
    `CPF ${isQv ? 'QV' : 'PV'} curve, bus voltages in pu` +
      (generators.length > 0 ? ', generator reactive power in MVAr' : ''),
    `max ${isQv ? 'Q' : 'lambda'} = ${result.max_lam}`,
  ];
  if (result.truncated) comments.push('truncated: no nose point was reached');
  if (result.done_msg) comments.push(result.done_msg);
  comments.push(...cpfComments(result));
  return recordsToCsv({
    columns: [
      isQv ? 'q_injection' : 'lambda',
      ...buses.map((bus) => `bus_${bus}_v`),
      ...generators.map((g) => `${g.model.toLowerCase()}_${g.idx}_q_mvar`),
    ],
    rows,
    comments,
  });
}

/**
 * Every generator's reactive output (MVAr) at every step of a CPF run, with
 * each one's limits in the header. The file of the generator panel.
 */
export function cpfGeneratorsToCsv(result: CpfResult): Blob | null {
  const generators = result.generators ?? [];
  if (generators.length === 0 || result.lambdas.length === 0) return null;
  const isQv = result.mode === 'qv';
  const limit = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : 'none';
  return recordsToCsv({
    columns: [
      isQv ? 'q_injection' : 'lambda',
      ...generators.map((g) => `${g.model.toLowerCase()}_${g.idx}_q_mvar`),
    ],
    rows: result.lambdas.map((x, step) => [x, ...generators.map((g) => g.q[step])]),
    comments: [
      `CPF ${isQv ? 'QV' : 'PV'} curve, generator reactive power in MVAr`,
      ...cpfComments(result),
      ...generators.map(
        (g) =>
          `${generatorName(g)} on bus ${g.bus}: Qmin ${limit(g.q_min)}, Qmax ${limit(g.q_max)} MVAr`,
      ),
    ],
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
