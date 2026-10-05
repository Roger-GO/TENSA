/**
 * The names a power flow's elements go by. A result is keyed by idx alone, so a
 * result that is kept after its case has changed or gone (the power-flow
 * history, ``store/pflowHistory.ts``) carries the names its idx stood for.
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';
import { DYNAMIC_GENERATOR_KINDS } from '@/lib/topology';

/** The name each idx of a result stood for when it was solved. */
export interface ElementNames {
  buses: Record<string, string>;
  /** Lines and transformers: the result keys both by the idx of the ANDES `Line`. */
  lines: Record<string, string>;
  /** The static generators (PV, Slack), which are the ones a power flow solves. */
  generators: Record<string, string>;
  loads: Record<string, string>;
}

export const NO_ELEMENT_NAMES: ElementNames = { buses: {}, lines: {}, generators: {}, loads: {} };

function namesOf(entries: readonly TopologyEntry[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries ?? []) out[String(entry.idx)] = entry.name;
  return out;
}

/** The names a topology gives the elements a power flow reports on. */
export function elementNamesOf(topology: TopologySummary | null | undefined): ElementNames {
  if (!topology) return NO_ELEMENT_NAMES;
  return {
    buses: namesOf(topology.buses),
    lines: { ...namesOf(topology.lines), ...namesOf(topology.transformers) },
    generators: namesOf(topology.generators.filter((g) => !DYNAMIC_GENERATOR_KINDS.has(g.kind))),
    loads: namesOf(topology.loads),
  };
}
