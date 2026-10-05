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
 * The one entry is the ESD1 battery. Every statement in it was checked against
 * ANDES 2.0 (`server/src/tensa/core/esd1.py` holds the reasoning and
 * `server/tests/integration/test_esd1_api.py` the measurements), and the
 * server refuses the values a run cannot use, so the text here explains and
 * the server enforces.
 */
export interface ElementHelp {
  /** What the model is and what it needs before it can be added. */
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
  En: 'Energy capacity. The state of charge moves by the delivered MW over En each hour.',
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

/** The help for `model`, or `null` when the schema says all there is to say. */
export function elementHelp(model: string, context: ElementHelpContext): ElementHelp | null {
  return model === 'ESD1' ? esd1Help(context) : null;
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
 * limited to the rating. Its energy is left for the user: no value of it is
 * the usual one.
 */
export function elementDefaults(
  model: string,
  context: ElementHelpContext,
): Record<string, string | number | boolean> | undefined {
  if (model !== 'ESD1') return undefined;
  const sized = { pqflag: 1, pmx: 1 };
  return context.baseMva === null ? sized : { Sn: context.baseMva, ...sized };
}

/**
 * Whether the add form opens with the name set to the idx it proposes, and
 * keeps the two alike until the name is typed over. A battery is known by its
 * idx wherever it is shown, and ANDES's own cases name theirs after it
 * (`ESD1_1`), so an empty name is one more required field with nothing to ask.
 */
export function namedAfterIdx(model: string): boolean {
  return model === 'ESD1';
}
