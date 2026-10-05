import type { TopologyEntry, TopologySummary } from '@/api/types';

/**
 * The `bus` and `gen` of a device that takes over a static generator.
 *
 * A machine (GENROU, GENCLS) and a battery (ESD1) each name the PV or Slack
 * generator they replace when a time-domain run starts (`gen`) and the bus they
 * are on (`bus`), which has to be that generator's bus. The schema lists the two
 * as unrelated dropdowns, so the form showed fourteen buses with nothing to say
 * which of them has a generator, and five generators with nothing to say where
 * they are. What is here ties them together: the generators with their bus and
 * the devices already on them, what to write beside a bus, what picking one of
 * the two does to the other, and what to warn about.
 */
export interface StaticGenerator {
  idx: string;
  /** `PV` or `Slack`. */
  kind: string;
  name: string;
  /** The bus it is on, when the topology says. */
  bus: string | null;
  /** Each dynamic device that already takes it over, as `deviceLabel` names it. */
  takenBy: readonly string[];
}

const STATIC_KINDS: ReadonlySet<string> = new Set(['PV', 'Slack']);

function paramText(entry: TopologyEntry, name: string): string | null {
  const value = entry.params?.[name];
  return value === undefined || value === '' ? null : String(value);
}

/**
 * How a device is named in a sentence: "GENROU_2" or "PV_B" by its idx where
 * that says what it is, "GENROU 2" or "PV 2" where the case numbers its devices
 * and a bare number would not say which one is meant.
 */
function deviceLabel(device: { kind: string; idx: number | string }): string {
  const idx = String(device.idx);
  return idx.startsWith(device.kind) ? idx : `${device.kind} ${idx}`;
}

/** The PV and Slack generators of the case, in the order the topology lists them. */
export function staticGenerators(topology: TopologySummary | null): StaticGenerator[] {
  if (!topology) return [];
  const generators = topology.generators ?? [];
  // A machine is listed with the generators and a battery or a converter with
  // the controllers; each names its static generator as `gen`.
  const dynamic = [
    ...generators.filter((g) => !STATIC_KINDS.has(g.kind)),
    ...(topology.controllers ?? []),
  ];
  return generators
    .filter((g) => STATIC_KINDS.has(g.kind))
    .map((g) => {
      const idx = String(g.idx);
      return {
        idx,
        kind: g.kind,
        name: g.name,
        bus: paramText(g, 'bus'),
        takenBy: dynamic.filter((d) => paramText(d, 'gen') === idx).map(deviceLabel),
      };
    });
}

/** "PV 2", "PV_B": how a static generator is named in a sentence. */
export function generatorLabel(gen: Pick<StaticGenerator, 'kind' | 'idx'>): string {
  return deviceLabel(gen);
}

/** "GENROU_2", "A and B", "A, B and 8 more": the devices on a generator, kept short. */
function namesOf(devices: readonly string[]): string {
  if (devices.length <= 2) return devices.join(' and ');
  return `${devices.slice(0, 2).join(', ')} and ${devices.length - 2} more`;
}

/** "used by GENROU_2" for a generator a device already takes over, else nothing. */
export function usedBy(gen: Pick<StaticGenerator, 'takenBy'>): string | null {
  return gen.takenBy.length === 0 ? null : `used by ${namesOf(gen.takenBy)}`;
}

/**
 * What to write beside each bus that has a static generator, by bus idx:
 * "generator: PV 2 used by GENROU_2".
 */
export function generatorsByBus(gens: readonly StaticGenerator[]): Map<string, string> {
  const labels = new Map<string, string[]>();
  for (const gen of gens) {
    if (gen.bus === null) continue;
    const used = usedBy(gen);
    const label = used === null ? generatorLabel(gen) : `${generatorLabel(gen)} ${used}`;
    labels.set(gen.bus, [...(labels.get(gen.bus) ?? []), label]);
  }
  return new Map(
    [...labels].map(([bus, names]) => [
      bus,
      `${names.length === 1 ? 'generator' : 'generators'}: ${names.join(', ')}`,
    ]),
  );
}

export interface BusAndGen {
  bus: string;
  gen: string;
}

export interface LinkedChange extends BusAndGen {
  /** The field the change moved besides the one the user set, and why. */
  note: { field: keyof BusAndGen; text: string } | null;
}

/**
 * `values` after the user set `changed`, with the other field brought along.
 *
 * A generator decides the bus, so picking one sets it. A bus decides the
 * generator when it has exactly one; a generator picked earlier that is on
 * another bus is dropped, since the pair would be refused.
 */
export function followLink(
  changed: keyof BusAndGen,
  values: BusAndGen,
  gens: readonly StaticGenerator[],
): LinkedChange {
  if (changed === 'gen') {
    const gen = gens.find((g) => g.idx === values.gen);
    if (gen === undefined || gen.bus === null || gen.bus === values.bus) {
      return { ...values, note: null };
    }
    return {
      ...values,
      bus: gen.bus,
      note: { field: 'bus', text: `Set to bus ${gen.bus}, where ${generatorLabel(gen)} is.` },
    };
  }
  if (values.bus === '') return { ...values, note: null };
  const onBus = gens.filter((g) => g.bus === values.bus);
  if (onBus.some((g) => g.idx === values.gen)) return { ...values, note: null };
  const only = onBus.length === 1 ? onBus[0] : undefined;
  if (only !== undefined) {
    return {
      ...values,
      gen: only.idx,
      note: {
        field: 'gen',
        text: `Set to ${generatorLabel(only)}, the static generator on bus ${values.bus}.`,
      },
    };
  }
  return { ...values, gen: '', note: null };
}

/**
 * What a bus brings along when nobody picked it by hand: its one static
 * generator, as long as no device takes that generator over yet, else `null`.
 *
 * A form can open on a bus (the diagram's "Add element here"), and the case
 * can gain the generator of that bus while the form is open. Neither is a pick
 * by the user, so neither chooses a generator that is already in use: that
 * would make a second device on it the form's own suggestion, and two devices
 * on one generator do not initialize as they stand (`linkWarnings`).
 */
export function freeGeneratorOn(
  bus: string,
  gens: readonly StaticGenerator[],
): LinkedChange | null {
  const linked = followLink('bus', { bus, gen: '' }, gens);
  const free = gens.some((g) => g.idx === linked.gen && g.takenBy.length === 0);
  return free ? linked : null;
}

/**
 * What to say under `bus` and `gen` for the values as they stand. Neither stops
 * the add: the server refuses what a run cannot use, and a shared generator is
 * a choice a case may make (ANDES's `ieee14_esd1.xlsx` puts ten batteries on
 * one PV, a tenth each). Left at their defaults two devices on one generator
 * each start at its whole output, and the time-domain run does not initialize
 * (measured in `server/tests/integration/test_esd1_api.py`).
 */
export function linkWarnings(
  values: BusAndGen,
  gens: readonly StaticGenerator[],
): Partial<Record<keyof BusAndGen, string>> {
  const warnings: Partial<Record<keyof BusAndGen, string>> = {};
  if (values.bus !== '' && !gens.some((g) => g.bus === values.bus)) {
    const elsewhere = gens.some((g) => g.bus !== null)
      ? ', or pick a bus that names its generator'
      : '';
    warnings.bus = `Bus ${values.bus} has no PV or Slack generator. Add one there first (Kind: PV generator)${elsewhere}.`;
  }
  const gen = gens.find((g) => g.idx === values.gen);
  if (gen !== undefined && gen.takenBy.length > 0) {
    const takes = gen.takenBy.length === 1 ? 'takes' : 'take';
    warnings.gen = `${namesOf(gen.takenBy)} already ${takes} over ${generatorLabel(gen)}. Devices on one static generator have to share it: their gammap must add up to 1, and their gammaq, or the time-domain run does not initialize. The simple way out is a PV generator for this one alone: add it (Kind: PV generator) and pick it here.`;
  }
  return warnings;
}
