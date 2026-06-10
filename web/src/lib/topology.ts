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
  return bucket.find((e) => String(e.idx) === selected.idx) ?? null;
}
