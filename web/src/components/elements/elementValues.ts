/**
 * What an element form holds and whether it can be sent, worked out without a
 * form: the values a form of a model opens with (`seedElementValues`) and the
 * check of a set of values against the model's schema (`checkElementValues`).
 *
 * `ElementForm` is drawn from these, and so is a draft on the diagram
 * (`components/sld/drafts.ts`), which has to say whether it is ready to be
 * added while no form of it is open.
 *
 * Pure: nothing read but the arguments.
 */
import type { ParamValue, TopologyEntry, TopologyParamMeta, TopologySummary } from '@/api/types';
import { namedAfterIdx } from './elementHelp';
import { staticGenerators } from './genLink';

/**
 * Compute the next-available idx for a given model, used to prefill the
 * `idx` field on Add. Looks at the existing topology and returns either
 * a numeric next or a kind-prefixed next, depending on how the existing
 * idxs are shaped. `reserved` are idx values that count as taken though the
 * case does not have them: the ones of the drafts that were placed before.
 */
export function nextAvailableIdx(
  model: string,
  topology: TopologySummary | null,
  reserved: readonly string[] = [],
): string {
  if (!topology) return '1';
  const bucket = bucketForModel(topology, model);
  const existing = [...bucket.map((e) => String(e.idx)), ...reserved];
  if (existing.length === 0) {
    return defaultPrefixFor(model) + '1';
  }
  // If every existing idx is purely numeric, return max + 1 as numeric.
  const allNumeric = existing.every((s) => /^\d+$/.test(s));
  if (allNumeric) {
    const max = Math.max(...existing.map((s) => Number.parseInt(s, 10)));
    return String(max + 1);
  }
  // Otherwise look for a shared alphabetic prefix; bump the numeric tail.
  const prefixes = new Set(existing.map((s) => s.replace(/\d+$/, '')));
  if (prefixes.size === 1) {
    const prefix = [...prefixes][0]!;
    let max = 0;
    for (const s of existing) {
      const m = /(\d+)$/.exec(s);
      if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
    }
    return `${prefix}${max + 1}`;
  }
  // Heterogeneous idxs — fall back to a kind-prefixed counter.
  return defaultPrefixFor(model) + (existing.length + 1);
}

function bucketForModel(topology: TopologySummary, model: string): TopologyEntry[] {
  if (model === 'Bus') return topology.buses;
  if (model === 'Line') return [...(topology.lines ?? []), ...(topology.transformers ?? [])];
  if (['PV', 'Slack', 'GENROU', 'GENCLS'].includes(model))
    return (topology.generators ?? []).filter((g) => g.kind === model);
  if (['PQ', 'ZIP'].includes(model)) return (topology.loads ?? []).filter((l) => l.kind === model);
  if (model === 'Shunt') return topology.shunts ?? [];
  // Everything else the form adds is a controller: an exciter, a governor, a
  // battery. They are listed together, each under its own model.
  return (topology.controllers ?? []).filter((c) => c.kind === model);
}

function defaultPrefixFor(model: string): string {
  if (model === 'Bus') return '';
  if (model === 'Line') return 'L';
  if (model === 'Shunt') return 'SH';
  // Generators / loads use the model name as prefix.
  return `${model}_`;
}

/** The idx values the case already has for `model`: a new element cannot take one of them. */
export function existingIdxSetFor(topology: TopologySummary | null, model: string): Set<string> {
  if (!topology) return new Set();
  return new Set(bucketForModel(topology, model).map((e) => String(e.idx)));
}

export function emptyValueFor(meta: TopologyParamMeta): ParamValue {
  if (meta.kind === 'bool') return false;
  if (meta.kind === 'number') return '';
  return '';
}

/** Whether the field is a list to pick from, not a box to type in. */
export function isPick(meta: TopologyParamMeta): boolean {
  return meta.kind === 'bus_idx' || meta.kind === 'gen_idx' || meta.kind === 'syn_idx';
}

/** What an empty required field says under itself. */
export function missingText(meta: TopologyParamMeta): string {
  return isPick(meta) ? 'Required. Pick one from the list.' : 'Required. Enter a value.';
}

/**
 * The values a form of `model` opens with: every field empty, the idx the
 * next free one of the case (past `reservedIdxs`, see `nextAvailableIdx`),
 * the name after the idx for a model that is named so (`namedAfterIdx`), and
 * `defaults` over those.
 */
export function seedElementValues(
  model: string,
  metas: readonly TopologyParamMeta[],
  topology: TopologySummary | null,
  defaults?: Readonly<Record<string, string | number | boolean>>,
  reservedIdxs?: readonly string[],
): Record<string, ParamValue> {
  const init: Record<string, ParamValue> = {};
  for (const m of metas) {
    init[m.name] =
      m.name === 'idx' ? nextAvailableIdx(model, topology, reservedIdxs) : emptyValueFor(m);
  }
  if (namedAfterIdx(model) && 'idx' in init && 'name' in init) init.name = init.idx;
  if (defaults) {
    for (const [k, v] of Object.entries(defaults)) init[k] = v;
  }
  return init;
}

/**
 * `seeded`, the values a form of `model` opens with, with the values that
 * were kept for it (`held`: the fields a draft was given) over them. A name
 * that was not kept goes with the idx that was, as it does while it is typed.
 */
export function withHeldValues(
  model: string,
  seeded: Readonly<Record<string, ParamValue>>,
  held: Readonly<Record<string, ParamValue>>,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = { ...seeded };
  for (const [name, value] of Object.entries(held)) {
    if (name in seeded) out[name] = value;
  }
  if (namedAfterIdx(model) && 'idx' in held && !('name' in held) && 'name' in out) {
    out.name = out.idx!;
  }
  return out;
}

/**
 * What the lists of a form offer, by the kind of field: the buses, the
 * static generators and the synchronous machines of the case, as the idx
 * values `BusIdxSelect`, `GenIdxSelect` and `SynIdxSelect` list.
 */
export interface PickTargets {
  bus_idx: ReadonlySet<string>;
  gen_idx: ReadonlySet<string>;
  syn_idx: ReadonlySet<string>;
}

export function pickTargets(topology: TopologySummary | null): PickTargets {
  return {
    bus_idx: new Set((topology?.buses ?? []).map((b) => String(b.idx))),
    gen_idx: new Set(staticGenerators(topology).map((g) => g.idx)),
    syn_idx: new Set(
      (topology?.generators ?? [])
        .filter((g) => g.kind === 'GENROU' || g.kind === 'GENCLS')
        .map((g) => String(g.idx)),
    ),
  };
}

/** What a pick that the case no longer has says under its field. */
const GONE_TEXT: Record<keyof PickTargets, (value: string) => string> = {
  bus_idx: (value) => `Bus ${value} is not in the system. Pick one from the list.`,
  gen_idx: (value) => `Generator ${value} is not in the system. Pick one from the list.`,
  syn_idx: (value) => `Machine ${value} is not in the system. Pick one from the list.`,
};

export interface ValueCheck {
  /** What is wrong with a field, by its name; empty when the values can be sent. */
  errors: Record<string, string>;
  /** The values as the server takes them: numbers as numbers, empty optional fields left out. */
  params: Record<string, ParamValue>;
}

/**
 * Check `values` against the fields of a model. A required field that is
 * empty, an idx the case already has (`existingIdxs`) and a number that is
 * not one are refused. With `targets`, so is a pick the case does not have:
 * a form's own lists only offer what is there, but values that were kept
 * (a draft) can name a bus that has since gone.
 */
export function checkElementValues(
  metas: readonly TopologyParamMeta[],
  values: Readonly<Record<string, ParamValue>>,
  existingIdxs: ReadonlySet<string>,
  targets?: PickTargets,
): ValueCheck {
  const errors: Record<string, string> = {};
  const params: Record<string, ParamValue> = {};
  for (const m of metas) {
    const v = values[m.name];
    if (m.required) {
      if (m.kind === 'bool') {
        // Booleans always have a value; nothing to validate.
      } else if (v === '' || v === undefined) {
        errors[m.name] = missingText(m);
        continue;
      }
    }
    // Reject duplicate idx client-side so the user sees the conflict
    // before the server roundtrip rejects it (Issue 6).
    if (m.name === 'idx' && typeof v === 'string' && v !== '') {
      if (existingIdxs.has(v)) {
        errors[m.name] = `idx "${v}" is already taken`;
        continue;
      }
    }
    // Skip empty optional fields entirely so the substrate falls
    // back to ANDES's own defaults instead of receiving "" / NaN.
    if (!m.required && (v === '' || v === undefined)) continue;
    if (targets !== undefined && isPick(m)) {
      const kind = m.kind as keyof PickTargets;
      if (!targets[kind].has(String(v))) {
        errors[m.name] = GONE_TEXT[kind](String(v));
        continue;
      }
    }
    if (m.kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors[m.name] = 'Enter a finite number';
        continue;
      }
      params[m.name] = n;
    } else if (m.kind === 'bool') {
      params[m.name] = Boolean(v);
    } else {
      params[m.name] = String(v);
    }
  }
  return { errors, params };
}
