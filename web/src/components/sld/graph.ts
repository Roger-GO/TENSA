/**
 * Pure helpers that translate a `TopologySummary` + coordinate map into
 * the React Flow `nodes` + `edges` shape the canvas renders. Lives in
 * its own module so the file is import-clean for testing (no React
 * runtime, no ReactFlow init) and so `SldCanvas.tsx` keeps the
 * `react-refresh` constant-export rule happy.
 */
import type { Edge, Node } from '@xyflow/react';
import type { BusCoord, TopologyEntry, TopologySummary } from '@/api/types';
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
   * Lateral-offset index within the `(sourceBus, sourceSide)` cluster.
   * Counts BOTH outgoing edges (this bus is the source) AND incoming
   * edges (this bus is the target arriving on this side) — otherwise
   * an edge entering bus B on its west face shares the y-row near the
   * handle with another edge leaving bus B on its west face, and the
   * corridor reads visually as a single continuous line.
   */
  sourceStride: number;
  /**
   * Lateral-offset index within the `(targetBus, targetSide)` cluster.
   * Same dual-counting rule as `sourceStride` — applied at the target
   * endpoint by `TopologyEdge`.
   */
  targetStride: number;
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
 * Like `assignHandles` but on the OTHER axis — when the natural pick
 * conflicts with another edge already using that handle, the alternate
 * pick routes the edge through the perpendicular cardinal sides
 * instead. Used by `computeHandleAssignments` to disambiguate hub
 * buses (e.g., bus 2 with both 1→2 entering on west and 2→5 leaving on
 * west) by routing one of them through south/north instead.
 *
 * For a perfectly axis-aligned pair (only one axis has movement), the
 * alternate isn't well-defined — we fall back to the natural pick,
 * caller relies on stride to separate the corridor.
 */
export function assignHandlesAlternate(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { sourceSide: Side; targetSide: Side } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) {
    return { sourceSide: 'east', targetSide: 'east' };
  }
  // Pick the NON-dominant axis. Falls back to the dominant pick when
  // one axis has zero movement.
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dy === 0) {
      return dx > 0
        ? { sourceSide: 'east', targetSide: 'west' }
        : { sourceSide: 'west', targetSide: 'east' };
    }
    return dy > 0
      ? { sourceSide: 'south', targetSide: 'north' }
      : { sourceSide: 'north', targetSide: 'south' };
  }
  if (dx === 0) {
    return dy > 0
      ? { sourceSide: 'south', targetSide: 'north' }
      : { sourceSide: 'north', targetSide: 'south' };
  }
  return dx > 0
    ? { sourceSide: 'east', targetSide: 'west' }
    : { sourceSide: 'west', targetSide: 'east' };
}

/**
 * For every edge in `topology`, compute the handle assignment + the
 * stride indices for both endpoints.
 *
 * Stride accounting groups every edge that touches `(busId, side)` —
 * regardless of whether this bus is the source or the target on that
 * side. Two edges meeting at the same handle (one entering, one
 * leaving) would otherwise overlap in the y-row (or x-column) right
 * next to that handle, so the eye reads them as a single continuous
 * line. Bidirectional stride teases the two paths apart along the
 * perpendicular axis.
 *
 * The edge ids match `buildGraph`'s `<bucket>-<idx>` convention.
 *
 * Defensive against missing terminals or missing coords: skips with no
 * entry in the resulting map. Caller treats absence as "fall back to
 * default React Flow handle pick".
 */
export function computeHandleAssignments(
  topology: TopologySummary,
  coords: CoordsByIdx,
): Map<string, HandleAssignment> {
  let warnedDegenerate = false;

  // First pass: each edge gets a primary side pick (dominant axis) and
  // an alternate (perpendicular axis). When the primary causes a hub
  // conflict (both directions through the same handle), the second
  // pass reassigns to the alternate so the corridors visually
  // disambiguate.
  interface Candidate {
    edgeId: string;
    sourceBus: string;
    targetBus: string;
    primary: { sourceSide: Side; targetSide: Side };
    alternate: { sourceSide: Side; targetSide: Side };
  }
  const candidates: Candidate[] = [];
  const collect = (entry: TopologyEntry, bucket: 'line' | 'transformer') => {
    const t = entryTerminals(entry);
    if (!t) return;
    const fromCoord = coords[t.from];
    const toCoord = coords[t.to];
    if (!fromCoord || !toCoord) return;
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
    candidates.push({
      edgeId: `${bucket}-${String(entry.idx)}`,
      sourceBus: t.from,
      targetBus: t.to,
      primary: assignHandles(fromCoord, toCoord),
      alternate: assignHandlesAlternate(fromCoord, toCoord),
    });
  };
  for (const line of topology.lines) collect(line, 'line');
  for (const trafo of topology.transformers) collect(trafo, 'transformer');

  // Second pass: greedy assignment with primary→alternate fallback.
  // The picker prefers any unused cluster, then falls back to whichever
  // axis has the smaller existing cluster. This guarantees an edge
  // never shares a corridor with another edge it could have avoided
  // through axis swap — the visual property the polish loop demanded.
  //
  // Iteration order is the topology iteration order — deterministic.
  const counts = new Map<string, number>();
  const out = new Map<string, HandleAssignment>();
  const clusterSize = (busId: string, side: Side) => counts.get(`${busId}|${side}`) ?? 0;
  for (const c of candidates) {
    const primaryLoad =
      clusterSize(c.sourceBus, c.primary.sourceSide) +
      clusterSize(c.targetBus, c.primary.targetSide);
    const alt = c.alternate;
    const altDifferent =
      alt.sourceSide !== c.primary.sourceSide || alt.targetSide !== c.primary.targetSide;
    let chosen = c.primary;
    if (altDifferent && primaryLoad > 0) {
      const altLoad =
        clusterSize(c.sourceBus, alt.sourceSide) + clusterSize(c.targetBus, alt.targetSide);
      // Prefer the alternate axis whenever it carries equal-or-less
      // load — equal-load ties pick the alternate so the second edge
      // through a hub bus splits onto a new axis instead of stacking
      // up stride alongside the first.
      if (altLoad <= primaryLoad) chosen = alt;
    }
    const sourceKey = `${c.sourceBus}|${chosen.sourceSide}`;
    const targetKey = `${c.targetBus}|${chosen.targetSide}`;
    const sourceStride = counts.get(sourceKey) ?? 0;
    counts.set(sourceKey, sourceStride + 1);
    const targetStride = counts.get(targetKey) ?? 0;
    counts.set(targetKey, targetStride + 1);
    out.set(c.edgeId, {
      sourceSide: chosen.sourceSide,
      targetSide: chosen.targetSide,
      sourceStride,
      targetStride,
    });
  }
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
  /**
   * Optional per-(model, idx) coordinate overrides for non-bus elements
   * (generators, loads, shunts). Keys are `${model}|${idx}` matching the
   * sidecar `non_bus_coordinates` schema. Entries absent from this map
   * fall back to kind-based offsets from the parent bus.
   */
  nonBusCoords?: Map<string, BusCoord>;
}

/**
 * Default offsets for non-bus elements relative to their parent bus.
 * Stack indices grow vertically per kind so multiple generators on one
 * bus don't overlap. Tunable; the user can drag to override and the
 * sidecar persists the result.
 */
export const NON_BUS_OFFSETS = {
  generator: { x: 0, y: -90, stackDx: 0, stackDy: -55 },
  load: { x: 0, y: 90, stackDx: 0, stackDy: 55 },
  shunt: { x: -100, y: 60, stackDx: -55, stackDy: 0 },
} as const satisfies Record<
  'generator' | 'load' | 'shunt',
  { x: number; y: number; stackDx: number; stackDy: number }
>;

/** React Flow node-type strings for the non-bus kinds. Mirrors `NODE_TYPES`. */
const NON_BUS_NODE_TYPE = {
  generator: 'generator',
  load: 'load',
  shunt: 'shunt',
} as const;

/** Stub-edge handle picks: every non-bus node has a single `bus-anchor` handle. */
const NON_BUS_HANDLE_ID = 'bus-anchor';

/** Bus-side handle each non-bus kind connects to. */
const BUS_SIDE_FOR_KIND: Record<'generator' | 'load' | 'shunt', Side> = {
  generator: 'north',
  load: 'south',
  shunt: 'west',
};

interface NonBusBucket {
  entries: readonly TopologyEntry[];
  /** Resolves the parent-bus idx for an entry; returns `null` if missing. */
  parentBus: (entry: TopologyEntry) => string | null;
  kind: 'generator' | 'load' | 'shunt';
}

function _busFromParam(entry: TopologyEntry, key: string): string | null {
  const params = entry.params;
  if (!params) return null;
  const value = params[key];
  if (value === undefined || typeof value === 'boolean') return null;
  return String(value);
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
  const nonBusCoords = opts.nonBusCoords ?? new Map<string, BusCoord>();
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const pushBranchEdge = (
    entry: TopologyEntry,
    kindLabel: 'line' | 'transformer',
  ) => {
    const t = entryTerminals(entry);
    if (!t) return;
    const id = `${kindLabel}-${String(entry.idx)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const handleAssignment = handles.get(id);
    const polyline = bends.get(id);
    // Transformers always render via TransformerEdge (which carries the
    // 2W/3W icon at the midpoint); routed-or-smooth-step is decided
    // inside that component based on whether bend points are present.
    let edgeType: 'topology' | 'routed' | 'transformer';
    if (kindLabel === 'transformer') {
      edgeType = 'transformer';
    } else {
      edgeType = polyline ? 'routed' : 'topology';
    }
    edges.push({
      id,
      source: t.from,
      target: t.to,
      sourceHandle: handleAssignment ? SOURCE_HANDLE[handleAssignment.sourceSide] : undefined,
      targetHandle: handleAssignment ? TARGET_HANDLE[handleAssignment.targetSide] : undefined,
      type: edgeType,
      data: {
        idx: String(entry.idx),
        name: entry.name,
        kind: entry.kind,
        bucket: kindLabel,
        sourceSide: handleAssignment?.sourceSide,
        targetSide: handleAssignment?.targetSide,
        sourceStride: handleAssignment?.sourceStride ?? 0,
        targetStride: handleAssignment?.targetStride ?? 0,
        bendPoints: polyline,
        // Transformer-specific: 3-winding fallback gets a "3w" badge
        // overlaid on the 2-winding glyph (per Scope Boundaries).
        winding: detectWinding(entry),
      },
    });
  };
  for (const line of topology.lines) pushBranchEdge(line, 'line');
  for (const trafo of topology.transformers) pushBranchEdge(trafo, 'transformer');

  // Non-bus nodes (generators, loads, shunts). Anchor each to its parent
  // bus's coordinate plus a kind-specific offset; multiple devices on
  // one bus stack along the offset axis.
  const nonBusBuckets: NonBusBucket[] = [
    {
      entries: topology.generators ?? [],
      parentBus: (e) => _busFromParam(e, 'bus'),
      kind: 'generator',
    },
    {
      entries: topology.loads ?? [],
      parentBus: (e) => _busFromParam(e, 'bus'),
      kind: 'load',
    },
    {
      entries: topology.shunts ?? [],
      parentBus: (e) => _busFromParam(e, 'bus'),
      kind: 'shunt',
    },
  ];

  // Per-(parentBus, kind) stack counter so two generators on the same bus
  // don't render at the same coord.
  const stackCounts = new Map<string, number>();
  for (const bucket of nonBusBuckets) {
    const offset = NON_BUS_OFFSETS[bucket.kind];
    for (const entry of bucket.entries) {
      const parentIdx = bucket.parentBus(entry);
      if (parentIdx === null) {
        // Defensive: an orphan element with no parent bus shouldn't
        // happen with a valid topology. Skip + warn.
        console.warn(
          `SLD: ${bucket.kind} ${String(entry.idx)} has no parent bus; skipping`,
        );
        continue;
      }
      const parentCoord = coords[parentIdx];
      if (!parentCoord) {
        console.warn(
          `SLD: ${bucket.kind} ${String(entry.idx)} references missing bus ${parentIdx}; skipping`,
        );
        continue;
      }
      const stackKey = `${parentIdx}|${bucket.kind}`;
      const stackIndex = stackCounts.get(stackKey) ?? 0;
      stackCounts.set(stackKey, stackIndex + 1);
      // Sidecar override (when present) takes precedence over the
      // computed offset; falling back to the default keeps the canvas
      // sensible without any persisted layout.
      const sidecarKey = `${entry.kind}|${String(entry.idx)}`;
      const sidecar = nonBusCoords.get(sidecarKey);
      const x =
        sidecar?.x ??
        parentCoord.x + offset.x + offset.stackDx * stackIndex;
      const y =
        sidecar?.y ??
        parentCoord.y + offset.y + offset.stackDy * stackIndex;
      const nodeId = `${bucket.kind}-${String(entry.idx)}`;
      nodes.push({
        id: nodeId,
        type: NON_BUS_NODE_TYPE[bucket.kind],
        position: { x, y },
        data: {
          idx: String(entry.idx),
          name: entry.name,
          kind: entry.kind,
          parentBus: parentIdx,
        },
      } satisfies Node);
      // Stub edge from the non-bus node to the bus's appropriate side.
      edges.push({
        id: `stub-${nodeId}`,
        source: nodeId,
        sourceHandle: NON_BUS_HANDLE_ID,
        target: parentIdx,
        targetHandle: TARGET_HANDLE[BUS_SIDE_FOR_KIND[bucket.kind]],
        type: 'stub',
        data: {
          kind: entry.kind,
          bucket: bucket.kind,
        },
      });
    }
  }

  return { nodes, edges };
}

/** Returns "3w" when an entry references a 3-winding transformer, else "2w". */
function detectWinding(entry: TopologyEntry): '2w' | '3w' {
  // ANDES models 3-winding transformers either via the `Trafo3` model
  // (a separate kind) or via three coupled Line entries. The substrate's
  // current Line→Transformer split puts both 2W and 3W into the same
  // bucket; we differentiate on the entry's `kind` field.
  if (entry.kind === 'Trafo3' || entry.kind === 'Transformer3W') return '3w';
  return '2w';
}
