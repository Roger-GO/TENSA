/**
 * The options of a power-flow run, and what to say about them.
 *
 * Pure and import-clean (no React, no stores): the options form, the run hook,
 * the success toast and the non-convergence panel read the same rules. The ranges
 * are the server's (`PflowRunRequest`), so an input the form accepts is one the
 * request is not refused for.
 *
 * A number left blank is `null`: the run keeps the case's own setting, which is
 * ANDES's default (1e-6, 25 iterations) unless the case file says otherwise. A
 * checkbox that has not been touched is `null` as well, so a case that asks for
 * something itself (a `_config` that turns Q limits on) is not overruled by an
 * untouched form; once it is touched it is sent whichever way it points, so such a
 * case can be told to run without. The solver settings (method, refactorisation
 * count, line search) follow the same rule.
 */
import type { PflowRunRequest, PflowSettings } from '@/api/types';

/**
 * The solver a power flow can run with: one of the engine's published `method`
 * values (`NR`, `dishonest`, `NK` for ANDES; `ac`, `dc`, `ptdf-dc` for Sienna),
 * as a string so a new engine's list needs no client change.
 */
export type PflowMethod = string;

/** What the user can set for one power-flow run. */
export interface PflowOptions {
  /** Mismatch (pu) below which the solver stops, or `null` for the case's own. */
  tolerance: number | null;
  /** Iteration limit, or `null` for the case's own. */
  maxIterations: number | null;
  /** Start every bus from 1 pu at angle 0, or `null` for the case's own. */
  flatStart: boolean | null;
  /** Hold a generator at `qmin` / `qmax` when its Q goes past one, or `null` for the case's own. */
  enforceQLimits: boolean | null;
  /** The solver: one of the engine's methods, or `null` for the case's own. */
  method: PflowMethod | null;
  /** Iterations of the dishonest method that refactorize the Jacobian, or `null` for the case's own. */
  nFactorize: number | null;
  /** The backtracking line search, or `null` for the case's own. */
  linesearch: boolean | null;
}

/** What the case itself sets for the two switches; `null` until a run has shown it. */
export interface PflowCaseSettings {
  flatStart: boolean | null;
  enforceQLimits: boolean | null;
}

export const DEFAULT_PFLOW_OPTIONS: PflowOptions = {
  tolerance: null,
  maxIterations: null,
  flatStart: null,
  enforceQLimits: null,
  method: null,
  nFactorize: null,
  linesearch: null,
};

/** ANDES's own defaults, for placeholders and for judging what is "non-default". */
export const ANDES_PFLOW_DEFAULTS = {
  tolerance: 1e-6,
  maxIterations: 25,
  method: 'NR' as PflowMethod,
  nFactorize: 4,
  linesearch: true,
} as const;

/** The server's accepted ranges. */
export const PFLOW_LIMITS = {
  toleranceMin: 1e-12,
  toleranceMax: 1e-2,
  maxIterationsMin: 1,
  maxIterationsMax: 1000,
  nFactorizeMin: 1,
  nFactorizeMax: 100,
} as const;

export function isDefaultPflowOptions(options: PflowOptions): boolean {
  return (
    options.tolerance === null &&
    options.maxIterations === null &&
    options.flatStart === null &&
    options.enforceQLimits === null &&
    options.method === null &&
    options.nFactorize === null &&
    options.linesearch === null
  );
}

/**
 * The request body: only what has been set; the rest stays the case's own. A DC
 * method is solved directly and the server refuses a tolerance or an iteration
 * limit with it, so the body leaves them out.
 */
export function pflowRequestBody(options: PflowOptions): PflowRunRequest {
  const body: PflowRunRequest = {};
  if (options.tolerance !== null) body.tolerance = options.tolerance;
  if (options.maxIterations !== null) body.max_iterations = options.maxIterations;
  if (options.flatStart !== null) body.flat_start = options.flatStart;
  if (options.enforceQLimits !== null) body.enforce_q_limits = options.enforceQLimits;
  if (options.method !== null) body.method = options.method;
  if (options.nFactorize !== null) body.n_factorize = options.nFactorize;
  if (options.linesearch !== null) body.linesearch = options.linesearch;
  if (dcIgnores(options.method)) {
    delete body.tolerance;
    delete body.max_iterations;
  }
  return body;
}

/**
 * What a run shows about the case's own switches: those its request left alone,
 * as the server reported them. A switch the request set says nothing about the case.
 */
export function caseSettingsFromRun(
  sent: PflowRunRequest,
  settings: PflowSettings | null | undefined,
): Partial<PflowCaseSettings> {
  if (settings === null || settings === undefined) return {};
  const learned: Partial<PflowCaseSettings> = {};
  if (sent.flat_start === undefined) learned.flatStart = settings.flat_start;
  if (sent.enforce_q_limits === undefined) learned.enforceQLimits = settings.enforce_q_limits;
  return learned;
}

/**
 * What a checkbox shows: the user's choice, else what the case itself sets where a
 * run that left the switch alone has shown it (`caseOwn`), else off (ANDES's
 * default).
 */
export function shownSwitch(choice: boolean | null, caseOwn: boolean | null): boolean {
  return choice ?? caseOwn ?? false;
}

export type ParsedField<T> = { ok: true; value: T } | { ok: false; error: string };

/** A tolerance as typed (`1e-8`, `0.0001`). Blank is `null`: the case's own. */
export function parseTolerance(text: string): ParsedField<number | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const value = Number(trimmed);
  const { toleranceMin, toleranceMax } = PFLOW_LIMITS;
  if (!Number.isFinite(value) || value < toleranceMin || value > toleranceMax) {
    return {
      ok: false,
      error: `Enter a number from ${formatTolerance(toleranceMin)} to ${formatTolerance(toleranceMax)}.`,
    };
  }
  return { ok: true, value };
}

/** An iteration limit as typed. Blank is `null`: the case's own. */
export function parseMaxIterations(text: string): ParsedField<number | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const value = Number(trimmed);
  const { maxIterationsMin, maxIterationsMax } = PFLOW_LIMITS;
  if (
    !/^\d+$/.test(trimmed) ||
    !Number.isSafeInteger(value) ||
    value < maxIterationsMin ||
    value > maxIterationsMax
  ) {
    return {
      ok: false,
      error: `Enter a whole number from ${maxIterationsMin} to ${maxIterationsMax}.`,
    };
  }
  return { ok: true, value };
}

/** A refactorisation count as typed. Blank is `null`: the case's own. */
export function parseNFactorize(text: string): ParsedField<number | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  const value = Number(trimmed);
  const { nFactorizeMin, nFactorizeMax } = PFLOW_LIMITS;
  if (
    !/^\d+$/.test(trimmed) ||
    !Number.isSafeInteger(value) ||
    value < nFactorizeMin ||
    value > nFactorizeMax
  ) {
    return {
      ok: false,
      error: `Enter a whole number from ${nFactorizeMin} to ${nFactorizeMax}.`,
    };
  }
  return { ok: true, value };
}

/**
 * The settings NK does not read: tolerance, max iterations and line search
 * (SciPy's newton_krylov stops by its own rule). Used to mark those inputs.
 */
export function nkIgnores(method: PflowMethod | null): boolean {
  return method === 'NK';
}

/** The settings a DC power flow does not read: tolerance and max iterations (a direct solve). */
export function dcIgnores(method: PflowMethod | null): boolean {
  return method === 'dc' || method === 'ptdf-dc';
}

/** A tolerance the way a person writes it: `1e-6`, `2.5e-4`. */
export function formatTolerance(value: number): string {
  return value.toExponential().replace('e+', 'e');
}

/**
 * The settings a run used, in a line: `tolerance 1e-6, up to 25 iterations`, then
 * `flat start` and `Q limits enforced` when they were on, then the solver when it
 * was not NR. Under Newton-Krylov the tolerance, the iteration limit and the line
 * search were not read, so the line names the method and only what did apply. A
 * DC method is a direct solve: the line names it and never a tolerance or a limit
 * (the server reports the "not used" values 0.0 and 0 for them).
 */
export function describeSettings(settings: PflowSettings): string {
  if (settings.method === 'NK') {
    const parts = ["Newton-Krylov (SciPy's own stopping rule)"];
    if (settings.flat_start) parts.push('flat start');
    if (settings.enforce_q_limits) parts.push('Q limits enforced');
    return parts.join(', ');
  }
  if (dcIgnores(settings.method ?? null)) {
    const parts = [
      settings.method === 'ptdf-dc'
        ? 'DC power flow from the PTDF matrix (direct solve)'
        : 'DC power flow (direct solve)',
    ];
    if (settings.flat_start) parts.push('flat start');
    if (settings.enforce_q_limits) parts.push('Q limits enforced');
    return parts.join(', ');
  }
  const parts = [
    `tolerance ${formatTolerance(settings.tolerance)}`,
    `up to ${settings.max_iterations} iterations`,
  ];
  if (settings.flat_start) parts.push('flat start');
  if (settings.enforce_q_limits) parts.push('Q limits enforced');
  if (settings.method !== null && settings.method !== undefined && settings.method !== 'NR') {
    parts.push(`${settings.method} method`);
  }
  if (
    settings.method === 'dishonest' &&
    settings.n_factorize !== null &&
    settings.n_factorize !== undefined
  ) {
    parts.push(`refactorizing the first ${settings.n_factorize} iterations`);
  }
  if (settings.linesearch === false) parts.push('line search off');
  return parts.join(', ');
}

/**
 * What a run used that is not ANDES's default, for the toast: `Q limits enforced`,
 * `flat start`, `tolerance 1e-4`, `up to 50 iterations`, `dishonest method`,
 * `line search off`. Empty for a plain run. Under Newton-Krylov only the method
 * is named: the tolerance, the iteration limit and the line search were not read.
 * A DC method is named as such, and never a tolerance or a limit.
 */
export function nonDefaultSettings(settings: PflowSettings | null | undefined): string[] {
  if (settings === null || settings === undefined) return [];
  if (settings.method === 'NK') {
    const parts: string[] = [];
    if (settings.enforce_q_limits) parts.push('Q limits enforced');
    if (settings.flat_start) parts.push('flat start');
    parts.push('Newton-Krylov');
    return parts;
  }
  if (dcIgnores(settings.method ?? null)) {
    const parts: string[] = [];
    if (settings.enforce_q_limits) parts.push('Q limits enforced');
    if (settings.flat_start) parts.push('flat start');
    parts.push(settings.method === 'ptdf-dc' ? 'DC power flow (PTDF)' : 'DC power flow');
    return parts;
  }
  const parts: string[] = [];
  if (settings.enforce_q_limits) parts.push('Q limits enforced');
  if (settings.flat_start) parts.push('flat start');
  if (settings.tolerance !== ANDES_PFLOW_DEFAULTS.tolerance) {
    parts.push(`tolerance ${formatTolerance(settings.tolerance)}`);
  }
  if (settings.max_iterations !== ANDES_PFLOW_DEFAULTS.maxIterations) {
    parts.push(`up to ${settings.max_iterations} iterations`);
  }
  if (settings.method !== null && settings.method !== undefined && settings.method !== 'NR') {
    parts.push(`${settings.method} method`);
  }
  if (
    settings.method === 'dishonest' &&
    settings.n_factorize !== null &&
    settings.n_factorize !== undefined &&
    settings.n_factorize !== ANDES_PFLOW_DEFAULTS.nFactorize
  ) {
    parts.push(`refactorizing the first ${settings.n_factorize} iterations`);
  }
  if (settings.linesearch === false) parts.push('line search off');
  return parts;
}

/**
 * How a run got where it did, to follow "converged" or "did not converge":
 * `in 5 iterations`, `by Newton-Krylov` for a run of that method, which keeps
 * no iteration count (the server reports 0), or `by direct solve` for a DC
 * method, whose 0 iterations would read as a failure.
 */
export function iterationsPhrase(result: {
  iterations: number;
  settings?: PflowSettings | null;
}): string {
  if (result.settings?.method === 'NK') return 'by Newton-Krylov';
  if (
    result.settings !== null &&
    result.settings !== undefined &&
    dcIgnores(result.settings.method ?? null)
  ) {
    return 'by direct solve';
  }
  return `in ${result.iterations} iterations`;
}

/** The toast for a converged run: the count, and what was not default. */
export function pflowSuccessMessage(result: {
  iterations: number;
  settings?: PflowSettings | null;
}): string {
  const method = result.settings?.method ?? null;
  // Under Newton-Krylov and under a DC method the sentence names the method already.
  const methodPart = nkIgnores(method)
    ? 'Newton-Krylov'
    : dcIgnores(method)
      ? method === 'ptdf-dc'
        ? 'DC power flow (PTDF)'
        : 'DC power flow'
      : null;
  const extra = nonDefaultSettings(result.settings).filter((part) => part !== methodPart);
  const base = `PF converged ${iterationsPhrase(result)}`;
  return extra.length === 0 ? `${base}.` : `${base} (${extra.join(', ')}).`;
}

/** One adjusted retry a failed run offers. */
export interface PflowRetry {
  /** Stable id for keys and test ids. */
  id: 'more-iterations' | 'flat-start' | 'looser-tolerance' | 'no-q-limits';
  /** The button text. */
  label: string;
  /** Why it may help, for the button's tooltip. */
  hint: string;
  /** What to change in the options before running again. */
  changes: Partial<PflowOptions>;
}

/** The smallest power of ten above `value`: 3.2e-6 gives 1e-5, and 1e-5 gives 1e-4. */
function powerOfTenAbove(value: number): number {
  // Number(`1e${n}`) is exact where Math.pow(10, n) for negative n is not.
  return Number(`1e${Math.floor(Math.log10(value)) + 1}`);
}

/**
 * The adjusted retries worth offering after a run that did not converge, from what
 * the run used and how it ended:
 *
 * - More iterations, when the solver stopped at the limit (an iteration count past
 *   `max_iterations`), as opposed to giving up early on a diverging or NaN solution,
 *   which more iterations would not cure. Doubles the limit, at least to 50.
 * - A flat start, when the run did not use one.
 * - A looser tolerance, when the final mismatch is within a thousandth of a pu and
 *   so close that the tolerance alone kept it from being accepted: the next power of
 *   ten above the mismatch.
 * - Switching Q-limit enforcement off, when it was on: generators flipping between
 *   PV and PQ is a common reason a solution does not settle. The change is an
 *   explicit "off", which also overrides a case that turns the limits on itself.
 */
export function pflowRetries(run: {
  iterations: number;
  mismatch: number;
  settings: PflowSettings;
}): PflowRetry[] {
  const { settings } = run;
  const retries: PflowRetry[] = [];
  const maxIterations = PFLOW_LIMITS.maxIterationsMax;
  if (run.iterations > settings.max_iterations && settings.max_iterations < maxIterations) {
    const next = Math.min(maxIterations, Math.max(50, settings.max_iterations * 2));
    retries.push({
      id: 'more-iterations',
      label: `Retry with ${next} iterations`,
      hint: `The solver stopped at its limit of ${settings.max_iterations} iterations. Allow it more.`,
      changes: { maxIterations: next },
    });
  }
  if (!settings.flat_start) {
    retries.push({
      id: 'flat-start',
      label: 'Retry from a flat start',
      hint: "Start every bus from 1 pu at angle 0 instead of the case's own voltages and angles.",
      changes: { flatStart: true },
    });
  }
  if (Number.isFinite(run.mismatch) && run.mismatch > settings.tolerance && run.mismatch <= 1e-3) {
    const next = Math.min(PFLOW_LIMITS.toleranceMax, powerOfTenAbove(run.mismatch));
    retries.push({
      id: 'looser-tolerance',
      label: `Retry at tolerance ${formatTolerance(next)}`,
      hint: `The mismatch got down to ${run.mismatch.toExponential(2)}, close to the tolerance of ${formatTolerance(settings.tolerance)}. Accepting up to ${formatTolerance(next)} is a less exact solution.`,
      changes: { tolerance: next },
    });
  }
  if (settings.enforce_q_limits) {
    retries.push({
      id: 'no-q-limits',
      label: 'Retry without Q limits',
      hint: 'Generators switching between holding their voltage and holding a Q limit can keep a solution from settling.',
      changes: { enforceQLimits: false },
    });
  }
  return retries;
}

/**
 * The settings of a run for the retry rules: what the server reported, or, from a
 * server that reports none, what the options form holds over ANDES's defaults.
 */
export function settingsOrAssumed(
  settings: PflowSettings | null | undefined,
  options: PflowOptions,
): PflowSettings {
  if (settings !== null && settings !== undefined) return settings;
  return {
    tolerance: options.tolerance ?? ANDES_PFLOW_DEFAULTS.tolerance,
    max_iterations: options.maxIterations ?? ANDES_PFLOW_DEFAULTS.maxIterations,
    flat_start: options.flatStart ?? false,
    enforce_q_limits: options.enforceQLimits ?? false,
    method: options.method ?? ANDES_PFLOW_DEFAULTS.method,
    n_factorize: options.nFactorize ?? ANDES_PFLOW_DEFAULTS.nFactorize,
    linesearch: options.linesearch ?? ANDES_PFLOW_DEFAULTS.linesearch,
  };
}
