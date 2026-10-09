import type { ParamValue } from '@/api/types';

/**
 * What the add form says about a model beyond its parameter names.
 *
 * The form is generated from the topology schema, which names each parameter
 * and gives its unit and nothing else. That is enough for a bus or a line. It
 * is not for a model whose values only mean something together, or whose
 * defaults describe no real device. Such a model gets an entry here: a note
 * shown above the form, a line under the fields that need one, warnings that
 * follow what is typed, and the values the form opens with.
 *
 * The main entry is the ESD1 battery. Every statement in it was checked against
 * ANDES 2.0 (`server/src/tensa/core/esd1.py` holds the reasoning and
 * `server/tests/integration/test_esd1_api.py` the measurements), and the
 * server refuses the values a run cannot use, so the text here explains and
 * the server enforces.
 *
 * A PQ load and a line have lines under their numbers too: which base a
 * per-unit value is on, what one such value is in MW, and what order of
 * magnitude a line's impedance has (the lines of the bundled IEEE 14 case).
 * `systemBaseEquivalent` is the same answer for the value that is typed: the
 * form shows it in MW or MVAr beside the field.
 *
 * The PV and Slack generators have lines under their four numbers and no
 * note. A battery needs a static generator on its bus first, so its form sends
 * a first-time user to theirs, where `Sn`, `Vn`, `p0` and `v0` are all the
 * form says. The lines give what ANDES's own parameter descriptions do
 * (`andes/models/static/pv.py`): the powers are per unit of the system base.
 */
export interface ElementHelp {
  /** What the model is and what it needs before it can be added. Empty for none. */
  note: readonly string[];
  /** One line per parameter whose name does not say what it holds. */
  fields: Readonly<Record<string, string>>;
}

/** What the form knows about the case besides the element being added. */
export interface ElementHelpContext {
  /** The system MVA base (`TopologySummary.base_mva`), when the case gives one. */
  baseMva: number | null;
}

/** "100 MVA" for a base the case gives; nothing for one it does not. */
function baseText(baseMva: number | null): string {
  return baseMva === null ? '' : ` (${formatMva(baseMva)} MVA)`;
}

function formatMva(value: number): string {
  return String(Number(value.toPrecision(6)));
}

const ESD1_FIELDS: Readonly<Record<string, string>> = {
  bus: 'The bus of the static generator the battery takes over. A bus that has one names it in the list, and picking the generator below sets the bus.',
  gen: 'The static generator (PV or Slack) on the same bus that the battery takes over. The battery starts at its power-flow P and Q, times gammap and gammaq.',
  pqflag:
    'Which power keeps its share of the current limit ialim: 1 for active power, 0 for reactive power.',
  pmx: "Largest active power, discharging and charging, per unit of Sn: 1 is the rating. ANDES's own default is 9999, which is no limit.",
  En: 'Energy capacity. The form opens with one hour at the rating: set it to the energy of the battery you mean. The state of charge moves by the delivered MW over En each hour.',
  qmx: 'Largest reactive power command, per unit of Sn.',
  qmn: 'Smallest reactive power command, per unit of Sn.',
  ialim: 'Current limit of the converter, per unit of Sn.',
  fn: 'Nominal frequency the trip points ft0 to ft3 are read against. Change them together: fn has to lie between ft1 and ft2, or the battery is tripped from the start.',
  ddn: 'Over-frequency droop: above fn by more than |fdbd| the output falls by ddn (per unit of Sn) for each Hz. The model does not respond to under-frequency.',
  gammap:
    "Share of the static generator's P the battery starts at: 1 when it is the only device on that generator.",
  gammaq:
    "Share of the static generator's Q the battery starts at: 1 when it is the only device on that generator.",
  Tf: 'Leave at 1. It divides the rate of the state of charge.',
  SOCmin: 'Discharging stops here. Between 0 and 1, below SOCmax (0 if left empty).',
  SOCmax: 'Charging stops here. Between 0 and 1, above SOCmin (1 if left empty).',
  SOCinit: 'State of charge at the start of a run, between SOCmin and SOCmax (0.5 if left empty).',
  EtaC: 'Charging efficiency, above 0 and at most 1: the share of the absorbed power that is stored.',
  EtaD: 'Discharging efficiency, above 0 and at most 1: the stored energy drawn is the delivered power over EtaD.',
};

function esd1Help(context: ElementHelpContext): ElementHelp {
  const base = baseText(context.baseMva);
  return {
    note: [
      "A battery behind a converter (ANDES's ESD1). It takes over a static generator on its bus when a time-domain run starts, so add a PV generator there first. That generator's p0 is the power the battery starts at (negative to charge). Give it the voltage the bus already has in the power flow as v0: otherwise it asks for more reactive power than the converter's current limit lets the battery deliver, and the run starts with a jump.",
      `Keep Sn equal to the system base${base}. The limits are per unit of Sn, but the set-point and the output are per unit of the system base, so with another Sn the same number is a different MW on each side.`,
      'The state of charge is the variable pIG_y of the battery: to plot it, add it under "ANDES variables to record" in the TDS tab. To change the power during a run, add an Alter disturbance on Pext0, which is added to the set-point in per unit of the system base.',
    ],
    fields: {
      ...ESD1_FIELDS,
      Sn: `Rating that pmx, qmx, qmn and ialim are per unit of. The set-point and the output are per unit of the system base${base}: keep Sn equal to it so the two read alike.`,
    },
  };
}

function staticGeneratorHelp(model: 'PV' | 'Slack', context: ElementHelpContext): ElementHelp {
  const base = baseText(context.baseMva);
  const fields: Record<string, string> = {
    Sn: `Power rating of the generator, in MVA. It does not scale the powers below: p0 and the limits are per unit of the system base${base}, and the form shows each in MW or MVAr beside its field.`,
    Vn: 'Rated voltage: the Vn of the bus it is on, which the form fills in when the bus is picked.',
    v0: 'Voltage it holds at its bus, per unit of the rated voltage: 1 is the rated voltage.',
  };
  if (model === 'PV') {
    const example =
      context.baseMva === null ? '' : `: 0.4 is ${formatMva(0.4 * context.baseMva)} MW`;
    fields.p0 = `Active power it delivers, per unit of the system base${base}${example}. A battery that takes this generator over starts at this power, so 0 starts it idle.`;
  }
  return { note: [], fields };
}

/**
 * ANDES's ZIP (`andes/models/dynload/zip.py`): a dynamic load that takes over a
 * static one, with nothing of its own but the shares.
 */
const ZIP_HELP: ElementHelp = {
  note: [
    "A ZIP load is not a load of its own: when a time-domain run starts it takes over the PQ load named in pq, on that load's bus and with its power, and makes each share of it follow the voltage differently. Add the PQ load first. A power flow still solves the PQ load as it is.",
    'The three shares of the active power, and the three of the reactive power, are in percent and each three must add up to 100.',
  ],
  fields: {
    pq: 'The idx of the PQ load it takes over, as the Loads table lists it.',
    kpp: 'Percent of the active power that stays constant.',
    kpi: 'Percent of the active power drawn as constant current: it follows the voltage.',
    kpz: 'Percent of the active power drawn as constant impedance: it follows the voltage squared.',
    kqp: 'Percent of the reactive power that stays constant.',
    kqi: 'Percent of the reactive power drawn as constant current: it follows the voltage.',
    kqz: 'Percent of the reactive power drawn as constant impedance: it follows the voltage squared.',
  },
};

/** `: 0.9 is 90 MW` for a base the case gives; nothing for one it does not. */
function exampleText(pu: number, unit: string, baseMva: number | null): string {
  return baseMva === null ? '' : `: ${pu} is ${formatMva(pu * baseMva)} ${unit}`;
}

function loadHelp(context: ElementHelpContext): ElementHelp {
  const base = baseText(context.baseMva);
  return {
    note: [],
    fields: {
      Vn: 'Rated voltage: the Vn of the bus it is on, which the form fills in when the bus is picked.',
      p0: `Active power the load draws, per unit of the system base${base}${exampleText(0.9, 'MW', context.baseMva)}.`,
      q0: `Reactive power the load draws, per unit of the system base${base}${exampleText(0.3, 'MVAr', context.baseMva)}. Negative for a load that delivers reactive power.`,
    },
  };
}

/**
 * A line or a transformer. The server takes the base of a branch from the
 * system and from the buses it joins (`_inject_line_voltage_base`), so what
 * is typed is on the system base. The orders of magnitude are those of the
 * lines of the bundled IEEE 14 case, which is on a 100 MVA base.
 */
function lineHelp(context: ElementHelpContext): ElementHelp {
  const base = baseText(context.baseMva);
  return {
    note: [],
    fields: {
      r: `Series resistance, per unit of the system base${base} at the rated voltage of its buses. The lines of the IEEE 14 example run from about 0.01 to 0.22.`,
      x: 'Series reactance, on the same base; for a line it is usually a few times r. The lines of the IEEE 14 example run from about 0.04 to 0.35.',
      b: 'Total charging susceptance of the line, on the same base. 0 for a short line or a transformer.',
      tap: 'Turns ratio of a transformer off its nominal one: 1, or empty, for a line.',
      rate_a:
        'Long-term rating in MVA, which the loading of the branch is read against. Left empty or 0, it is not checked for overload.',
      u: 'In service: 1. Set 0 to take the branch out without deleting it.',
    },
  };
}

/** The help for `model`, or `null` when the schema says all there is to say. */
export function elementHelp(model: string, context: ElementHelpContext): ElementHelp | null {
  if (model === 'ESD1') return esd1Help(context);
  if (model === 'PV' || model === 'Slack') return staticGeneratorHelp(model, context);
  if (model === 'ZIP') return ZIP_HELP;
  if (model === 'PQ') return loadHelp(context);
  if (model === 'Line') return lineHelp(context);
  return null;
}

/** The fields that hold a power per unit of the system base, by model, and the unit of each. */
const SYSTEM_BASE_POWERS: Readonly<Record<string, Readonly<Record<string, 'MW' | 'MVAr'>>>> = {
  PQ: { p0: 'MW', q0: 'MVAr' },
  PV: { p0: 'MW', pmax: 'MW', pmin: 'MW', qmax: 'MVAr', qmin: 'MVAr' },
  Slack: { p0: 'MW', pmax: 'MW', pmin: 'MW', qmax: 'MVAr', qmin: 'MVAr' },
};

/**
 * What the per-unit value typed into the field `name` of a `model` is in MW
 * or MVAr (`= 90 MW`), for the fields that hold a power on the system base;
 * `null` for any other field, an empty one, or a case that gives no base.
 */
export function systemBaseEquivalent(
  model: string,
  name: string,
  value: ParamValue | undefined,
  context: ElementHelpContext,
): string | null {
  const unit = SYSTEM_BASE_POWERS[model]?.[name];
  if (unit === undefined || context.baseMva === null) return null;
  if (value === undefined || value === '' || typeof value === 'boolean') return null;
  const pu = Number(value);
  if (!Number.isFinite(pu)) return null;
  return `= ${formatMva(pu * context.baseMva)} ${unit}`;
}

function asNumber(value: ParamValue | undefined): number | null {
  if (value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whether two ratings are the same number, to within what a field can hold. */
function sameRating(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * What to say under a field for the values as they stand, by parameter name.
 * A warning does not stop the add. A rating off the system base the server
 * takes, and says the same in the Messages tab; a state of charge outside its
 * window it refuses, and the line under the field says so before the add is
 * sent.
 */
export function elementWarnings(
  model: string,
  values: Readonly<Record<string, ParamValue>>,
  context: ElementHelpContext,
): Record<string, string> {
  const warnings: Record<string, string> = {};
  if (model === 'ZIP') {
    // ANDES takes shares that do not add up and says so only when the run starts.
    for (const [first, shares, power] of [
      ['kpp', ['kpp', 'kpi', 'kpz'], 'active'],
      ['kqp', ['kqp', 'kqi', 'kqz'], 'reactive'],
    ] as const) {
      const given = shares.map((name) => asNumber(values[name]));
      if (given.some((share) => share === null)) continue;
      const total = given.reduce<number>((sum, share) => sum + (share ?? 0), 0);
      if (Math.abs(total - 100) > 1e-9) {
        warnings[first] =
          `The shares of the ${power} power (${shares.join(', ')}) add up to ${formatMva(total)}, not 100.`;
      }
    }
    return warnings;
  }
  if (model !== 'ESD1') return warnings;
  const sn = asNumber(values.Sn);
  const base = context.baseMva;
  if (sn !== null && sn > 0 && base !== null && !sameRating(sn, base)) {
    const pmx = asNumber(values.pmx);
    const cap =
      pmx !== null && pmx > 0 && pmx < 9999
        ? ` With pmx = ${formatMva(pmx)} the battery delivers at most ${formatMva((pmx * sn) / base)} pu on the system base (${formatMva(pmx * sn)} MW).`
        : '';
    warnings.Sn = `Sn is not the system base (${formatMva(base)} MVA): the limits are per unit of ${formatMva(sn)} MVA while the set-point and the output are per unit of ${formatMva(base)} MVA.${cap}`;
  }
  // Left empty, the window is ANDES's own: 0 to 1.
  const soc = asNumber(values.SOCinit);
  const low = asNumber(values.SOCmin) ?? 0;
  const high = asNumber(values.SOCmax) ?? 1;
  if (soc !== null && (soc < low || soc > high)) {
    warnings.SOCinit = `A state of charge of ${soc} is outside SOCmin to SOCmax (${low} to ${high}): 1 is a full battery. The add is refused until SOCinit lies between them.`;
  }
  return warnings;
}

/**
 * The values the add form opens with for `model`, beyond the kind's own. A
 * battery opens rated on the system base, with active power given priority and
 * limited to the rating, and holding one hour of that rating (`En` in MWh
 * equal to `Sn` in MVA). No energy is the usual one, but an empty required
 * field at the foot of a long form is where a first-time user's add stops,
 * and an hour at the rating is a battery a study can start from; the line
 * under the field says that it is the form's value and not the battery's.
 */
export function elementDefaults(
  model: string,
  context: ElementHelpContext,
): Record<string, string | number | boolean> | undefined {
  if (model !== 'ESD1') return undefined;
  const sized = { pqflag: 1, pmx: 1 };
  return context.baseMva === null ? sized : { Sn: context.baseMva, ...sized, En: context.baseMva };
}

/**
 * Whether the add form opens with the name set to the idx it proposes, and
 * keeps the two alike until the name is typed over. It does for every model:
 * an element is known by its idx wherever it is shown, ANDES's own cases name
 * most of theirs after it (`ESD1_1`, a generator `2`), and a name that is
 * required and empty beside an idx that is already filled in is one more
 * field with nothing to ask. A name of the user's own is typed over it.
 */
export function namedAfterIdx(_model: string): boolean {
  return true;
}
