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

/** Cardinal handle sides exposed by every Bus node. */
export type Side = 'north' | 'east' | 'south' | 'west';

/**
 * Handle id convention. Each Bus exposes a `<side>-source` and a
 * `<side>-target` Handle so an edge can specify exactly which corner to
 * enter / exit. The id is `<side>-<role>`.
 */
export const SOURCE_HANDLE: Record<Side, string> = {
  north: 'north-source',
  east: 'east-source',
  south: 'south-source',
  west: 'west-source',
};
export const TARGET_HANDLE: Record<Side, string> = {
  north: 'north-target',
  east: 'east-target',
  south: 'south-target',
  west: 'west-target',
};

export interface HandleAssignment {
  sourceSide: Side;
  targetSide: Side;
  /**
   * Index within the cluster of edges that share the same
   * `(sourceBus, sourceSide)` group. Drives the lateral offset
   * applied by `TopologyEdge` so co-handle edges don't share a corridor.
   */
  stride: number;
}

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
 * Pick cardinal handle sides for a single edge based on the geometry
 * of its terminal-bus pair. The dominant axis of the (to - from) vector
 * picks the source side; the target side is the opposite cardinal.
 *
 * - Horizontal-dominant: source = 'east', target = 'west' (or reversed).
 * - Vertical-dominant: source = 'south', target = 'north' (or reversed).
 *
 * Degenerate (same coord): falls back to a reasonable default and emits
 * a single console warning (not per-edge — buses overlapping is itself
 * a bug worth surfacing once).
 *
 * Pure function — no I/O, no React Flow, no React.
 */
export function assignHandles(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { sourceSide: Side; targetSide: Side } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return { sourceSide: 'east', targetSide: 'east' };
  }
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0
      ? { sourceSide: 'east', targetSide: 'west' }
      : { sourceSide: 'west', targetSide: 'east' };
  }
  return dy > 0
    ? { sourceSide: 'south', targetSide: 'north' }
    : { sourceSide: 'north', targetSide: 'south' };
}

/**
 * For every edge in `topology`, compute the handle assignment + the
 * stride index within its source-side cluster. Edges sharing the same
 * `(sourceBus, sourceSide)` get incrementing stride values starting at
 * 0 — TopologyEdge uses the stride to lateral-offset the path.
 *
 * The result key is the edge id used by `buildGraph` (`<bucket>-<idx>`).
 *
 * Defensive against missing terminals or missing coords: skips with no
 * entry in the resulting map. Caller treats absence as "fall back to
 * default React Flow handle pick".
 */
export function computeHandleAssignments(
  topology: TopologySummary,
  coords: CoordsByIdx,
): Map<string, HandleAssignment> {
  const out = new Map<string, HandleAssignment>();
  const sourceCounts = new Map<string, number>(); // key = `${busId}|${side}`
  let warnedDegenerate = false;

  const handle = (entry: TopologyEntry, bucket: 'line' | 'transformer') => {
    const t = entryTerminals(entry);
    if (!t) return;
    const fromCoord = coords[t.from];
    const toCoord = coords[t.to];
    if (!fromCoord || !toCoord) return;
    const sides = assignHandles(fromCoord, toCoord);
    if (
      !warnedDegenerate &&
      fromCoord.x === toCoord.x &&
      fromCoord.y === toCoord.y
    ) {
      console.warn(
        `SLD: bus ${t.from} and ${t.to} share the same coordinate; falling back to default handles`,
      );
      warnedDegenerate = true;
    }
    const sourceClusterKey = `${t.from}|${sides.sourceSide}`;
    const stride = sourceCounts.get(sourceClusterKey) ?? 0;
    sourceCounts.set(sourceClusterKey, stride + 1);
    out.set(`${bucket}-${String(entry.idx)}`, { ...sides, stride });
  };

  for (const line of topology.lines) handle(line, 'line');
  for (const trafo of topology.transformers) handle(trafo, 'transformer');
  return out;
}

/**
 * Optional inputs for `buildGraph`. Both fields are derived once per
 * layout pass — `handleAssignments` from `computeHandleAssignments`,
 * `bendPoints` from ELK's `result.edges[].sections[].bendPoints`. When
 * both are absent the canvas falls back to default React Flow handle
 * pick + smooth-step routing (the v0.1 behaviour).
 */
export interface BuildGraphOptions {
  handleAssignments?: Map<string, HandleAssignment>;
  /**
   * Per-edge polyline coords from ELK (auto-layout case). Includes the
   * start and end points; the edge component renders `M start L bend1
   * ... L end`. Edges absent from this map render via `TopologyEdge`
   * (curated/sidecar smooth-step path).
   */
  bendPoints?: Map<string, [number, number][]>;
}

/**
 * Build the React Flow nodes + edges from a topology + coordinate map.
 * Pure — exported for unit tests so they can assert on the shape
 * without spinning up a ReactFlow render.
 */
export function buildGraph(
  topology: TopologySummary,
  coords: CoordsByIdx,
  opts: BuildGraphOptions = {},
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

  const handles = opts.handleAssignments ?? new Map<string, HandleAssignment>();
  const bends = opts.bendPoints ?? new Map<string, [number, number][]>();
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const pushEdge = (entry: TopologyEntry, kindLabel: 'line' | 'transformer') => {
    const t = entryTerminals(entry);
    if (!t) return;
    const id = `${kindLabel}-${String(entry.idx)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const handleAssignment = handles.get(id);
    const polyline = bends.get(id);
    edges.push({
      id,
      source: t.from,
      target: t.to,
      sourceHandle: handleAssignment ? SOURCE_HANDLE[handleAssignment.sourceSide] : undefined,
      targetHandle: handleAssignment ? TARGET_HANDLE[handleAssignment.targetSide] : undefined,
      type: polyline ? 'routed' : 'topology',
      data: {
        idx: String(entry.idx),
        name: entry.name,
        kind: entry.kind,
        bucket: kindLabel,
        sourceSide: handleAssignment?.sourceSide,
        targetSide: handleAssignment?.targetSide,
        stride: handleAssignment?.stride ?? 0,
        bendPoints: polyline,
      },
    });
  };
  for (const line of topology.lines) pushEdge(line, 'line');
  for (const trafo of topology.transformers) pushEdge(trafo, 'transformer');

  return { nodes, edges };
}
