/**
 * Pure helpers that translate a `TopologySummary` + coordinate map into
 * the React Flow `nodes` + `edges` shape the canvas renders. Lives in
 * its own module so the file is import-clean for testing (no React
 * runtime, no ReactFlow init) and so `SldCanvas.tsx` keeps the
 * `react-refresh` constant-export rule happy.
 */
import type { Edge, Node } from '@xyflow/react';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import type { CoordsByIdx } from './sidecar';

/** Pull bus1/bus2 idxs (as strings) off a Line/Transformer entry. */
export function entryTerminals(entry: TopologyEntry): { from: string; to: string } | null {
  const params = entry.params;
  if (!params) return null;
  const a = params.bus1;
  const b = params.bus2;
  if (a === undefined || b === undefined) return null;
  if (typeof a === 'boolean' || typeof b === 'boolean') return null;
  return { from: String(a), to: String(b) };
}

/**
 * Build the React Flow nodes + edges from a topology + coordinate map.
 * Pure — exported for unit tests so they can assert on the shape
 * without spinning up a ReactFlow render.
 */
export function buildGraph(
  topology: TopologySummary,
  coords: CoordsByIdx,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = topology.buses.map((b) => {
    const idx = String(b.idx);
    const c = coords[idx] ?? { x: 0, y: 0 };
    return {
      id: idx,
      type: 'bus',
      position: { x: c.x, y: c.y },
      data: {
        idx,
        name: b.name,
        kind: b.kind,
      },
    } satisfies Node;
  });

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const pushEdge = (entry: TopologyEntry, kindLabel: 'line' | 'transformer') => {
    const t = entryTerminals(entry);
    if (!t) return;
    const id = `${kindLabel}-${String(entry.idx)}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({
      id,
      source: t.from,
      target: t.to,
      type: 'topology',
      data: {
        idx: String(entry.idx),
        name: entry.name,
        kind: entry.kind,
        bucket: kindLabel,
      },
    });
  };
  for (const line of topology.lines) pushEdge(line, 'line');
  for (const trafo of topology.transformers) pushEdge(trafo, 'transformer');

  return { nodes, edges };
}
