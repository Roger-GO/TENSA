/**
 * What a continuation power flow can be asked for, and how to read what comes
 * back. Pure and import-clean (no React, no stores): the CPF form, the run
 * hooks, the curve, the generator panel and the CSV all read the same rules.
 *
 * The direction says what lambda increases. The three built-in ones scale
 * what the case has, so `lambda = 1` is twice the base value; a custom one
 * moves the devices it names by the MW and MVAr given, and lambda counts
 * multiples of them. The slack generator is never part of a direction: it
 * supplies what the rest leaves.
 */
import type {
  CpfDirection,
  CpfLimitEvent,
  CpfResult,
  CpfRunRequest,
  PflowResult,
  TopologyEntry,
  TopologySummary,
} from '@/api/types';

export type { CpfDirection } from '@/api/types';

/** Stop at the nose, or go on along the lower branch back to `lambda = 0`. */
export type CpfStopAt = 'nose' | 'full';

export interface CpfDirectionOption {
  value: CpfDirection;
  label: string;
  hint: string;
}

export const CPF_DIRECTIONS: readonly CpfDirectionOption[] = [
  {
    value: 'load',
    label: 'Loads and generation',
    hint: 'Every load and every PV generator grows in proportion to its base value. λ = 1 is twice the base case. ANDES default.',
  },
  {
    value: 'load-only',
    label: 'Loads only',
    hint: 'Every load grows in proportion; the PV generators stay where they are and the slack generator supplies the increase.',
  },
  {
    value: 'gen',
    label: 'Generation only',
    hint: 'Every PV generator grows in proportion; the loads stay and the slack generator takes up the difference.',
  },
  {
    value: 'custom',
    label: 'Custom',
    hint: 'Give the MW and MVAr each load gains, and the MW each PV generator gains, for one unit of λ.',
  },
];

/** The direction's name as the form shows it. */
export function directionLabel(direction: CpfDirection | null | undefined): string {
  return (
    CPF_DIRECTIONS.find((option) => option.value === direction)?.label ?? 'Loads and generation'
  );
}

/** What one unit of lambda is, for the axis and the file header. */
export function lambdaMeaning(direction: CpfDirection | null | undefined): string {
  switch (direction) {
    case 'load-only':
      return 'λ = 1 is twice the base load';
    case 'gen':
      return 'λ = 1 is twice the base PV generation';
    case 'custom':
      return 'λ = 1 is the custom increase as given';
    default:
      return 'λ = 1 is twice the base load and PV generation';
  }
}

// ---- a custom direction -----------------------------------------------------

/** What the user typed for one device: MW, and for a load MVAr. Blank is zero. */
export interface IncreaseDraft {
  p: string;
  q: string;
}

/** Drafts keyed by device idx. A device with no entry has no increase. */
export type IncreaseDrafts = Readonly<Record<string, IncreaseDraft>>;

export interface CustomDirection {
  loads: IncreaseDrafts;
  generators: IncreaseDrafts;
}

export const EMPTY_CUSTOM_DIRECTION: CustomDirection = { loads: {}, generators: {} };

/** A number as typed, `0` for blank, `null` for text that is not a finite number. */
export function parseIncrease(text: string | undefined): number | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return 0;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export type ParsedCustomDirection =
  | {
      ok: true;
      loadIncrease: NonNullable<CpfRunRequest['load_increase']>;
      generatorIncrease: NonNullable<CpfRunRequest['generator_increase']>;
    }
  | { ok: false; error: string };

/**
 * Turn the drafts into the two lists the request takes. Only the devices in
 * `loadIdx` / `generatorIdx` count (a draft left from another case is
 * dropped), and a device whose increase is zero is left out. Refused when a
 * field is not a number or when nothing is left to move.
 */
export function parseCustomDirection(
  custom: CustomDirection,
  loadIdx: readonly string[],
  generatorIdx: readonly string[],
): ParsedCustomDirection {
  const loadIncrease: NonNullable<CpfRunRequest['load_increase']> = [];
  for (const idx of loadIdx) {
    const draft = custom.loads[idx];
    if (draft === undefined) continue;
    const p = parseIncrease(draft.p);
    const q = parseIncrease(draft.q);
    if (p === null || q === null) {
      return { ok: false, error: `The increase of load ${idx} is not a number.` };
    }
    if (p !== 0 || q !== 0) loadIncrease.push({ idx, p, q });
  }
  const generatorIncrease: NonNullable<CpfRunRequest['generator_increase']> = [];
  for (const idx of generatorIdx) {
    const draft = custom.generators[idx];
    if (draft === undefined) continue;
    const p = parseIncrease(draft.p);
    if (p === null) {
      return { ok: false, error: `The increase of generator ${idx} is not a number.` };
    }
    if (p !== 0) generatorIncrease.push({ idx, p });
  }
  if (loadIncrease.length === 0 && generatorIncrease.length === 0) {
    return {
      ok: false,
      error: 'A custom direction needs an increase on at least one load or generator.',
    };
  }
  return { ok: true, loadIncrease, generatorIncrease };
}

/** A PQ load a custom direction can move, with what it draws in the solved power flow. */
export interface DirectionLoadRow {
  idx: string;
  name: string;
  bus: string | null;
  /** MW / MVAr in the solved power flow; `null` when there is none to read. */
  p: number | null;
  q: number | null;
}

/** A PV generator a custom direction can move, with what it supplies. */
export interface DirectionGeneratorRow {
  idx: string;
  name: string;
  bus: string | null;
  /** MW in the solved power flow; `null` when there is none to read. */
  p: number | null;
}

function busOf(entry: TopologyEntry): string | null {
  const bus = entry.params?.bus;
  return bus === undefined || bus === null ? null : String(bus);
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The devices a custom direction can name: the case's PQ loads and PV
 * generators (the routine moves no other model, and the slack is not part of
 * a direction), each with its power in the last converged power flow.
 */
export function directionRows(
  topology: TopologySummary | null,
  pflow: PflowResult | null,
): { loads: DirectionLoadRow[]; generators: DirectionGeneratorRow[] } {
  if (topology === null) return { loads: [], generators: [] };
  const solved = pflow !== null && pflow.converged ? pflow : null;
  const loads = (topology.loads ?? [])
    .filter((entry) => entry.kind === 'PQ')
    .map((entry) => {
      const idx = String(entry.idx);
      const row = solved?.load_consumption?.[idx];
      return {
        idx,
        name: entry.name,
        bus: busOf(entry),
        p: finiteOrNull(row?.p),
        q: finiteOrNull(row?.q),
      };
    });
  const generators = (topology.generators ?? [])
    .filter((entry) => entry.kind === 'PV')
    .map((entry) => {
      const idx = String(entry.idx);
      return {
        idx,
        name: entry.name,
        bus: busOf(entry),
        p: finiteOrNull(solved?.generator_outputs?.[idx]?.p),
      };
    });
  return { loads, generators };
}

// ---- the request ------------------------------------------------------------

/** What one run of the nose curve is asked for. */
export interface CpfRunOptions {
  direction: CpfDirection;
  /** The lists of a custom direction; ignored for the others. */
  loadIncrease?: NonNullable<CpfRunRequest['load_increase']>;
  generatorIncrease?: NonNullable<CpfRunRequest['generator_increase']>;
  /** `null` leaves the case's own setting. */
  enforceQLimits?: boolean | null;
  stopAt?: CpfStopAt;
  step?: number;
  maxIter?: number;
}

/** The request body: only what was set; the rest stays the server's default. */
export function cpfRequestBody(options: CpfRunOptions): Partial<CpfRunRequest> {
  const body: Partial<CpfRunRequest> = { direction: options.direction };
  if (options.direction === 'custom') {
    if (options.loadIncrease !== undefined && options.loadIncrease.length > 0) {
      body.load_increase = options.loadIncrease;
    }
    if (options.generatorIncrease !== undefined && options.generatorIncrease.length > 0) {
      body.generator_increase = options.generatorIncrease;
    }
  }
  if (options.enforceQLimits !== null && options.enforceQLimits !== undefined) {
    body.enforce_q_limits = options.enforceQLimits;
  }
  if (options.stopAt === 'full') body.stop_at = 'full';
  if (options.step !== undefined) body.step = options.step;
  if (options.maxIter !== undefined) body.max_iter = options.maxIter;
  return body;
}

// ---- reading a result -------------------------------------------------------

/** Whether the curve goes on past its nose along the lower branch. */
export function hasLowerBranch(result: CpfResult): boolean {
  return (
    result.stop_at === 'full' && result.nose_idx >= 0 && result.nose_idx < result.lambdas.length - 1
  );
}

/** The generators the power flow already held at a limit when the run started. */
export function heldFromTheStart(result: CpfResult): CpfLimitEvent[] {
  return (result.limit_events ?? []).filter((event) => event.step === 0);
}

/** The generators that reached a limit along the path, in the order they did. */
export function switchedAlongThePath(result: CpfResult): CpfLimitEvent[] {
  return (result.limit_events ?? []).filter((event) => event.step > 0);
}

/** The generator whose switch is where the nose is, if the nose is due to one. */
export function noseLimitEvent(result: CpfResult): CpfLimitEvent | null {
  return (result.limit_events ?? []).find((event) => event.at_nose) ?? null;
}

/**
 * The held generators whose voltage came back across the set-point before the
 * end of the path. A real exciter would leave the limit there; ANDES's limiter
 * never lets go, so the curve from that step is approximate.
 */
export function wouldHaveReleased(result: CpfResult): CpfLimitEvent[] {
  return (result.limit_events ?? []).filter(
    (event) => event.would_release_step !== null && event.would_release_step !== undefined,
  );
}

/** `Slack 1` or `PV 3`: how a generator of a result is named in a sentence. */
export function generatorName(of: { model: string; idx: string }): string {
  return `${of.model} ${of.idx}`;
}

/** `Qmax` or `Qmin`, as the rest of the UI writes a limit. */
export function limitName(limit: CpfLimitEvent['limit']): string {
  return limit === 'qmax' ? 'Qmax' : 'Qmin';
}

/** The axis name of a result: lambda for a nose curve, Q for a QV curve. */
export function axisSymbol(result: CpfResult): string {
  return result.mode === 'qv' ? 'Q' : 'λ';
}

/**
 * What to say about reactive limits in one or two sentences, or `null` when
 * the result says nothing about them (one kept from before the server
 * reported them).
 */
export function limitsSummary(result: CpfResult): string | null {
  if (result.q_limits_enforced === undefined) return null;
  const held = heldFromTheStart(result).length;
  const switched = switchedAlongThePath(result).length;
  const plural = (n: number) => (n === 1 ? 'generator' : 'generators');
  // With every generator held from the start nothing regulates a voltage, and
  // the curve is the one of a system of fixed reactive injections.
  const total = (result.generators ?? []).length;
  const noneLeft =
    total > 0 && held === total ? ' None is left to hold a voltage along the curve.' : '';
  if (result.q_limits_enforced) {
    if (held + switched === 0) {
      return 'Q limits were enforced and no generator reached one.';
    }
    const parts: string[] = [];
    if (held > 0) parts.push(`${held} ${plural(held)} held at a limit from the start`);
    if (switched > 0) parts.push(`${switched} more reached one along the path`);
    return `Q limits were enforced: ${parts.join(', ')}.${noneLeft}`;
  }
  if (held > 0) {
    return (
      `Q limits were not enforced along the path. The power flow holds ${held} ${plural(held)} ` +
      `at a limit, and ${held === 1 ? 'it stays' : 'they stay'} held; the others are free to go past theirs.` +
      noneLeft
    );
  }
  return 'Q limits were not enforced: generators are free to go past them.';
}

/**
 * The caution for a path on which held generators would have left their limit,
 * or `null` when none would.
 */
export function releaseCaution(result: CpfResult): string | null {
  const n = wouldHaveReleased(result).length;
  if (n === 0) return null;
  return (
    `${n} held ${n === 1 ? 'generator has its' : 'generators have their'} voltage back across the ` +
    `set-point before the end of the path, where a real exciter would leave the limit. ANDES ` +
    `keeps a generator at a limit once it is there, so from that point (see the table) the ` +
    `curve is the one for a generator pinned at its limit.`
  );
}
