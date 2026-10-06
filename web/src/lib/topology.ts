/**
 * Topology lookup helpers shared by the inspector surfaces.
 *
 * `bucketFor` + `findTopologyEntry` were byte-identical across
 * `ElementFormFields`, `ElementInspector`, and (inline) `RightInspector`;
 * consolidating them here keeps the controller-disambiguation rule in one
 * place. ANDES idx is model-local, so two controllers can share an idx —
 * controller selections therefore match on `(modelClass, idx)`, while static
 * elements match on `idx` alone within their bucket (review(phase5)).
 */
import type { TopologyEntry, TopologySummary } from '@/api/types';
import type { SelectedElement } from '@/store/case';

/** The topology bucket backing a given selected-element kind, or null. */
export function bucketFor(
  topology: TopologySummary,
  kind: SelectedElement['kind'],
): TopologyEntry[] | null {
  switch (kind) {
    case 'bus':
      return topology.buses;
    case 'line':
      return topology.lines;
    case 'transformer':
      return topology.transformers;
    case 'generator':
      return topology.generators;
    case 'load':
      return topology.loads;
    case 'shunt':
      return topology.shunts ?? [];
    case 'controller':
      return topology.controllers ?? [];
    default:
      return null;
  }
}

/** Resolve the selected element to its `TopologyEntry`, or null if absent. */
export function findTopologyEntry(
  topology: TopologySummary,
  selected: SelectedElement,
): TopologyEntry | null {
  const bucket = bucketFor(topology, selected.kind);
  if (!bucket) return null;
  if (selected.kind === 'controller') {
    // Disambiguate by (modelClass, idx): a numeric idx can be shared across
    // controller models, so matching on idx alone could alias to the wrong
    // device (e.g. an exciter vs a governor both at idx 1).
    return (
      bucket.find((e) => e.kind === selected.modelClass && String(e.idx) === selected.idx) ?? null
    );
  }
  // A selection that names its model (a row of the Machines table) finds that
  // device even where another model's device has the same idx.
  if (selected.modelClass !== undefined) {
    const exact = bucket.find(
      (e) => e.kind === selected.modelClass && String(e.idx) === selected.idx,
    );
    if (exact) return exact;
  }
  return bucket.find((e) => String(e.idx) === selected.idx) ?? null;
}

/**
 * The bus a load is on. A dynamic load (ANDES's ZIP) has none of its own: it
 * takes over the static load it names (`pq`) and is on that load's bus.
 */
export function loadBusIdx(load: TopologyEntry, loads: readonly TopologyEntry[]): string | null {
  const own = load.params?.bus;
  if (own !== undefined && own !== null && typeof own !== 'boolean') return String(own);
  const named = load.params?.pq;
  if (named === undefined || named === null) return null;
  const taken = loads.find((other) => other !== load && String(other.idx) === String(named));
  const bus = taken?.params?.bus;
  return bus === undefined || bus === null || typeof bus === 'boolean' ? null : String(bus);
}

/** Every element a topology lists, whatever its bucket. */
function entriesOf(topology: TopologySummary): TopologyEntry[] {
  return [
    ...topology.buses,
    ...topology.lines,
    ...topology.transformers,
    ...topology.generators,
    ...topology.loads,
    ...(topology.shunts ?? []),
    ...(topology.controllers ?? []),
  ];
}

/**
 * The elements `before` lists and `after` does not, each as its ANDES model and
 * idx: what the edit between the two took off the system.
 */
export function elementsGone(
  before: TopologySummary,
  after: TopologySummary,
): { model: string; idx: string | number }[] {
  const key = (entry: TopologyEntry) => `${entry.kind} ${String(entry.idx)}`;
  const left = new Set(entriesOf(after).map(key));
  return entriesOf(before)
    .filter((entry) => !left.has(key(entry)))
    .map((entry) => ({ model: entry.kind, idx: entry.idx }));
}

/** ANDES SynGen (rotor) model classes: the dynamic half of a machine. */
export const DYNAMIC_GENERATOR_KINDS: ReadonlySet<string> = new Set(['GENROU', 'GENCLS']);

/**
 * Key of a generator's row in the PF result's `generator_outputs`. The power
 * flow solves the static generators (PV, Slack) only, so a dynamic machine
 * has no row of its own: it reads the one of the static generator it names in
 * `gen`. Every other generator reads the row under its own idx, as does a
 * machine that names none.
 */
export function generatorRowKey(entry: TopologyEntry): string {
  if (DYNAMIC_GENERATOR_KINDS.has(entry.kind)) {
    const gen = entry.params?.gen;
    if (gen !== undefined && typeof gen !== 'boolean') return String(gen);
  }
  return String(entry.idx);
}
