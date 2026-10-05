/**
 * The frequency controllers of a time-domain run, and what to say about them.
 *
 * Pure and import-clean (no React, no stores): the editor in the TDS tab, the
 * Run button and their tests read the same rules. A controller is a set of
 * numbers the substrate's own code acts on while the run goes (see
 * `server/src/tensa/core/tds_controllers.py`): a droop, power in proportion to
 * the frequency deviation, or a fast frequency response, a fixed power delivered
 * once. Powers are in MW (positive discharging), frequencies in Hz, times in
 * seconds. The ranges are the server's, so a controller the form accepts is one
 * the run is not refused for.
 */
import type {
  DroopController,
  FfrController,
  TdsControllerCatalogue,
  TdsControllerResult,
  TdsControllerTarget,
} from '@/api/types';

/** What a run is sent for one controller. */
export type TdsControllerSpec = DroopController | FfrController;
export type TdsControllerType = TdsControllerSpec['type'];
export type TdsFrequencySource = TdsControllerSpec['frequency'];

/** A controller as the TDS tab keeps it between runs. */
export interface TdsControllerEntry {
  /** What the run is sent. */
  spec: TdsControllerSpec;
  /**
   * The ANDES variables the run records so the plot shows the controller at
   * work on its device: the command the device received, its current, and its
   * state of charge where it has one.
   */
  record: readonly string[];
}

/** The most controllers one run takes (the substrate refuses more). */
export const MAX_TDS_CONTROLLERS = 32;

/** The server's accepted ranges. */
export const CONTROLLER_LIMITS = { periodMin: 0.001, periodMax: 60 } as const;

export const CONTROLLER_TYPE_LABELS: Record<TdsControllerType, string> = {
  droop: 'Droop',
  ffr: 'Fast frequency response',
};

export const CONTROLLER_TYPE_HINTS: Record<TdsControllerType, string> = {
  droop:
    'Power in proportion to how far the frequency is from nominal: it discharges when the frequency is low and absorbs when it is high.',
  ffr: 'A fixed power, delivered once: it waits for the frequency to cross a threshold or to move fast, holds its power for a set time, then lets go.',
};

/** The fields of the form, as typed. A blank optional field is left out of the run. */
export interface ControllerDraft {
  type: TdsControllerType;
  /** {@link targetKey} of the device, or `''` while none is picked. */
  target: string;
  frequency: TdsFrequencySource;
  period: string;
  tStart: string;
  ramp: string;
  // Droop.
  gain: string;
  deadband: string;
  pMax: string;
  // Fast frequency response.
  power: string;
  triggerDeviation: string;
  triggerRocof: string;
  hold: string;
}

export type ControllerDraftField = Exclude<keyof ControllerDraft, 'type' | 'frequency'>;
export type ControllerDraftErrors = Partial<Record<ControllerDraftField, string>>;

/** One key for a device across the list, the form and the store. */
export function targetKey(target: { model: string; idx: number | string }): string {
  return `${target.model}\u0000${String(target.idx)}`;
}

/**
 * The device in words, as the substrate's messages name it: `ESD1 1`, and
 * `ESD1_1` alone for an idx that already says what it is.
 */
export function targetLabel(target: { model: string; idx: number | string }): string {
  const idx = String(target.idx);
  return typeof target.idx === 'string' && idx.includes(target.model)
    ? idx
    : `${target.model} ${idx}`;
}

/**
 * A device's own limit when it is one a default can be built on. ANDES's
 * default `pmx` is 9999 pu, which is "no limit" and not a size.
 */
function usableLimit(target: TdsControllerTarget | undefined): number | null {
  const limit = target?.p_limit;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && limit < 1e5
    ? limit
    : null;
}

/** A number as a person would type it: no float noise, no trailing zeros. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return String(Number(value.toPrecision(6)));
}

/**
 * The form as it opens for `target`: a droop that reaches the device's limit
 * at half a hertz, or an FFR of the device's full power for ten seconds at
 * 0.1 Hz. With no usable limit the size is left for the user to give.
 */
export function defaultDraft(
  catalogue: TdsControllerCatalogue | undefined,
  type: TdsControllerType = 'droop',
  target?: TdsControllerTarget,
): ControllerDraft {
  const device = target ?? catalogue?.targets.find((t) => t.in_service) ?? catalogue?.targets[0];
  const limit = usableLimit(device);
  return {
    type,
    target: device === undefined ? '' : targetKey(device),
    frequency: catalogue?.coi_available === false ? 'bus' : 'coi',
    period: '0.1',
    tStart: '0',
    ramp: '',
    gain: limit === null ? '' : formatNumber(limit * 2),
    deadband: '0.02',
    pMax: '',
    power: limit === null ? '' : formatNumber(limit),
    triggerDeviation: '0.1',
    triggerRocof: '',
    hold: '10',
  };
}

/** The form filled from a controller already in the list, for editing it. */
export function draftFromSpec(spec: TdsControllerSpec): ControllerDraft {
  const optional = (value: number | null | undefined) =>
    value === null || value === undefined ? '' : formatNumber(value);
  const base = defaultDraft(undefined, spec.type);
  const shared = {
    ...base,
    target: targetKey(spec),
    frequency: spec.frequency,
    period: formatNumber(spec.period),
    tStart: formatNumber(spec.t_start),
    ramp: optional(spec.ramp),
  };
  if (spec.type === 'droop') {
    return {
      ...shared,
      gain: formatNumber(spec.gain),
      deadband: formatNumber(spec.deadband),
      pMax: optional(spec.p_max),
    };
  }
  return {
    ...shared,
    power: formatNumber(spec.power),
    triggerDeviation: optional(spec.trigger_deviation),
    triggerRocof: optional(spec.trigger_rocof),
    hold: formatNumber(spec.hold),
  };
}

/** The number typed in a field; `null` when blank, `NaN` when it is not a number. */
function typed(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

function required(
  errors: ControllerDraftErrors,
  field: ControllerDraftField,
  text: string,
  rule: (value: number) => string | null,
): void {
  const value = typed(text);
  if (value === null) errors[field] = 'Required';
  else if (Number.isNaN(value)) errors[field] = 'Enter a number';
  else {
    const problem = rule(value);
    if (problem !== null) errors[field] = problem;
  }
}

function optional(
  errors: ControllerDraftErrors,
  field: ControllerDraftField,
  text: string,
  rule: (value: number) => string | null,
): void {
  const value = typed(text);
  if (value === null) return;
  if (Number.isNaN(value)) errors[field] = 'Enter a number or leave blank';
  else {
    const problem = rule(value);
    if (problem !== null) errors[field] = problem;
  }
}

const aboveZero = (value: number) => (value > 0 ? null : 'Must be above 0');
const notNegative = (value: number) => (value >= 0 ? null : 'Must not be negative');

/**
 * What is wrong with the form, field by field; empty when it can be added.
 * Only the fields of the chosen kind are checked.
 */
export function validateDraft(draft: ControllerDraft): ControllerDraftErrors {
  const errors: ControllerDraftErrors = {};
  if (draft.target === '') errors.target = 'Pick a device';
  required(errors, 'period', draft.period, (value) =>
    value >= CONTROLLER_LIMITS.periodMin && value <= CONTROLLER_LIMITS.periodMax
      ? null
      : `Must be between ${CONTROLLER_LIMITS.periodMin} and ${CONTROLLER_LIMITS.periodMax} s`,
  );
  required(errors, 'tStart', draft.tStart, notNegative);
  optional(errors, 'ramp', draft.ramp, aboveZero);
  if (draft.type === 'droop') {
    required(errors, 'gain', draft.gain, aboveZero);
    required(errors, 'deadband', draft.deadband, notNegative);
    optional(errors, 'pMax', draft.pMax, aboveZero);
  } else {
    required(errors, 'power', draft.power, (value) =>
      value === 0 ? 'Must not be 0: positive discharges, negative absorbs' : null,
    );
    optional(errors, 'triggerDeviation', draft.triggerDeviation, aboveZero);
    optional(errors, 'triggerRocof', draft.triggerRocof, aboveZero);
    if (
      typed(draft.triggerDeviation) === null &&
      typed(draft.triggerRocof) === null &&
      errors.triggerDeviation === undefined
    ) {
      errors.triggerDeviation = 'Give a deviation, a rate, or both';
    }
    required(errors, 'hold', draft.hold, aboveZero);
  }
  return errors;
}

/** The ANDES variables a run records for a controller on `target`. */
export function recordedVariables(target: TdsControllerTarget): string[] {
  const { command, active_current: current, soc } = target.variables;
  return [command, current, ...(typeof soc === 'string' ? [soc] : [])];
}

/**
 * The controller a valid form describes, on `target`. Call only when
 * {@link validateDraft} found nothing.
 */
export function entryFromDraft(
  draft: ControllerDraft,
  target: TdsControllerTarget,
): TdsControllerEntry {
  const number = (text: string) => Number(text.trim());
  const blankable = (text: string) => (text.trim() === '' ? null : Number(text.trim()));
  const shared = {
    model: target.model,
    idx: target.idx,
    frequency: draft.frequency,
    period: number(draft.period),
    t_start: number(draft.tStart),
    ramp: blankable(draft.ramp),
  };
  const spec: TdsControllerSpec =
    draft.type === 'droop'
      ? {
          ...shared,
          type: 'droop',
          gain: number(draft.gain),
          deadband: number(draft.deadband),
          p_max: blankable(draft.pMax),
        }
      : {
          ...shared,
          type: 'ffr',
          power: number(draft.power),
          trigger_deviation: blankable(draft.triggerDeviation),
          trigger_rocof: blankable(draft.triggerRocof),
          hold: number(draft.hold),
        };
  return { spec, record: recordedVariables(target) };
}

const FREQUENCY_WORDS: Record<TdsFrequencySource, string> = {
  coi: 'system frequency',
  bus: 'frequency at its bus',
};

/** One line that says what a controller will do, for the list in the TDS tab. */
export function describeController(spec: TdsControllerSpec): string {
  const reads = FREQUENCY_WORDS[spec.frequency];
  if (spec.type === 'droop') {
    const band = spec.deadband > 0 ? ` beyond ±${formatNumber(spec.deadband)} Hz` : '';
    const cap =
      typeof spec.p_max === 'number'
        ? `up to ${formatNumber(spec.p_max)} MW`
        : "up to the device's own limit";
    return `${formatNumber(spec.gain)} MW per Hz of the ${reads}${band}, ${cap}`;
  }
  const absorbing = spec.power < 0;
  const triggers: string[] = [];
  if (typeof spec.trigger_deviation === 'number') {
    triggers.push(`is ${formatNumber(spec.trigger_deviation)} Hz ${absorbing ? 'high' : 'low'}`);
  }
  if (typeof spec.trigger_rocof === 'number') {
    triggers.push(
      `${absorbing ? 'rises' : 'falls'} ${formatNumber(spec.trigger_rocof)} Hz/s or faster`,
    );
  }
  return `${formatNumber(spec.power)} MW for ${formatNumber(spec.hold)} s, once the ${reads} ${triggers.join(' or ')}`;
}

function seconds(value: number): string {
  return `${formatNumber(Number(value.toFixed(3)))} s`;
}

function megawatts(value: number): string {
  return `${formatNumber(Number(value.toPrecision(4)))} MW`;
}

/** What a controller did in a run, as the substrate reported it. */
export function describeResult(result: TdsControllerResult): string {
  const acted = result.first_action_t;
  if (typeof acted !== 'number') {
    return result.type === 'droop'
      ? 'did not act: the frequency stayed inside its dead band'
      : 'did not trigger';
  }
  if (result.type === 'droop') {
    return `acted from t = ${seconds(acted)}, peaked at ${megawatts(result.peak_command)}, ${megawatts(result.final_command)} at the end`;
  }
  const released = result.released_t;
  return typeof released === 'number'
    ? `triggered at t = ${seconds(acted)}, let go at t = ${seconds(released)}`
    : `triggered at t = ${seconds(acted)}, still holding at the end`;
}

/**
 * What to tell the user when a run with controllers ends: each one's outcome
 * for a few, a count for many.
 */
export function summariseResults(results: readonly TdsControllerResult[]): string {
  const lines = results.map(
    (result) =>
      `${CONTROLLER_TYPE_LABELS[result.type]} on ${targetLabel(result)} ${describeResult(result)}.`,
  );
  if (lines.length <= 2) return lines.join(' ');
  const acted = results.filter((result) => typeof result.first_action_t === 'number').length;
  return `${acted} of ${results.length} controllers acted.`;
}

/**
 * The `dae_vars` of a run: what the user picked, then what its controllers
 * record, each once, cut at the most a run records (the picks come first).
 */
export function runDaeVars(
  picked: readonly string[],
  controllers: readonly TdsControllerEntry[],
  max: number,
): string[] {
  const names = new Set<string>(picked);
  for (const controller of controllers) {
    for (const name of controller.record) names.add(name);
  }
  return [...names].slice(0, max);
}
