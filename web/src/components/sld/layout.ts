/**
 * ELK auto-layout for the SLD canvas.
 *
 * Builds an ELK graph from a topology summary (each bus → ELK node;
 * each line/transformer → ELK edge between its two terminal buses) and
 * runs `elkjs`'s `layered` algorithm with orthogonal edge routing. The
 * result is a `{busIdx → {x, y}}` map the canvas applies to its
 * React Flow node positions.
 *
 * Unit 1 (Phase 0 spike-confirmed): two passes. Pass 1 uses no port
 * constraints to derive bus coords. Pass 2 declares 4 cardinal ports
 * per bus with `'elk.portConstraints': 'FIXED_SIDE'` and points each
 * edge at the port on the side the diagram draws it leaving by
 * (`computeHandleAssignments`); ELK's ORTHOGONAL routing then produces
 * per-edge bend points exiting the declared cardinal sides. The bend
 * points become the route each line is drawn through, so each traces a
 * corridor of its own.
 *
 * Design choices:
 *
 * - `elk.layered` + `BRANDES_KOEPF` node placement gives the cleanest
 *   single-line-diagram look on IEEE 14 / 39 (textbook hierarchical
 *   bus banding); other algorithms produce graph-blob output that
 *   loses the visible "wedge" against PowerWorld.
 * - `elk.direction = DOWN` puts the slack bus near the top — matches
 *   the canonical IEEE 14 / 39 reference layouts so the auto-layout
 *   degrades gracefully when no curated layout exists.
 * - Spacing: `nodeNode=60` gives buses room to render their IEC 60617
 *   icons + name labels without overlap, while still fitting IEEE 39 in
 *   a single viewport at default zoom. Between two layers there is
 *   `LAYER_GAP`, which is what the row of devices above a bus needs to
 *   stand clear of the branches ELK routes over it.
 * - ELK runs in a Web Worker (see `elkClient.ts`), so a layout never
 *   blocks the UI thread and the engine is not part of the main chunk.
 * - Fallback: if ELK throws on either pass (rare; the worker failing to
 *   load, or a pathological graph), fall back to a plain sqrt(n)-wide
 *   grid + warn and skip bend points. The canvas still renders — just
 *   less prettily — so the user is never left staring at a blank pane.
 */
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import type { CoordsByIdx } from './sidecar';
import { DEVICE_ROW_OFFSET, NODE_FOOTPRINT, computeHandleAssignments, type Side } from './graph';
import { RUN_CLEARANCE } from './connections';
import { elkLayout } from './elkClient';

/**
 * How far under the box of a bus ELK runs the first branch that turns
 * between that layer and the next. It is ELK's default, set here as well so
 * that `LAYER_GAP` can count on it.
 */
const EDGE_NODE_GAP = 10;

/**
 * The room between two layers of buses. The devices of a bus stand in a row
 * `DEVICE_ROW_OFFSET` above it when the layout does not place them, and the
 * first branch that turns between two layers runs `EDGE_NODE_GAP` under the
 * upper one. With this much between the layers that run passes
 * `RUN_CLEARANCE` above the row, as far as a run keeps from a bar it is not
 * connected to. With the 80 this used to be, it lay exactly on the top edge
 * of the device boxes, and a branch that came down and turned there looked
 * wired to the corner of one.
 */
export const LAYER_GAP = EDGE_NODE_GAP + RUN_CLEARANCE + DEVICE_ROW_OFFSET;

/**
 * Tunable layout options. Exported so tests can vary spacing without
 * editing the production constants. Production callers should pass no
 * argument and inherit the defaults below.
 */
export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.spacing.nodeNode': '60',
  'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
  'elk.layered.spacing.edgeNodeBetweenLayers': String(EDGE_NODE_GAP),
  'elk.edgeRouting': 'ORTHOGONAL',
};

/**
 * The box ELK lays a bus out as: as wide as the bar the bus is drawn as, so
 * two buses of one layer never touch, and high enough for the bar and the
 * label under it. Routes end on the boundary of this box; the diagram
 * brings them onto the bar (`connections.ts`).
 */
const NODE_WIDTH = NODE_FOOTPRINT.bus.width;
const NODE_HEIGHT = 40;

/** Grid fallback constants. */
const GRID_CELL_WIDTH = 120;
const GRID_CELL_HEIGHT = 100;

/** Result of an auto-layout pass: bus coords + per-edge bend-point polylines. */
export interface LayoutResult {
  coords: CoordsByIdx;
  /**
   * Per-edge polyline (start point + bend points + end point, in
   * order). Edge ids match the `<bucket>-<idx>` pattern used by
   * `graph.ts/buildGraph`. Empty when ELK falls back to grid layout.
   */
  bendPoints: Map<string, [number, number][]>;
}

const SIDE_TO_ELK: Record<Side, 'NORTH' | 'EAST' | 'SOUTH' | 'WEST'> = {
  north: 'NORTH',
  east: 'EAST',
  south: 'SOUTH',
  west: 'WEST',
};

/**
 * Pull the bus1/bus2 idx values out of a Line / Transformer entry.
 * Both live inside the `params` dict per the Unit 5b extension.
 *
 * Returns `null` if the entry is missing one or both terminal idx
 * values — the caller filters these out (a topologically invalid edge
 * cannot be auto-routed and would crash ELK if passed in).
 */
function extractTerminals(
  entry: { params?: Record<string, number | string | boolean> } | undefined,
): { from: string; to: string } | null {
  const params = entry?.params;
  if (!params) return null;
  const bus1 = params.bus1;
  const bus2 = params.bus2;
  if (bus1 === undefined || bus2 === undefined) return null;
  if (typeof bus1 === 'boolean' || typeof bus2 === 'boolean') return null;
  return { from: String(bus1), to: String(bus2) };
}

interface CollectedBranch {
  /** `<bucket>-<idx>` — matches buildGraph's edge id convention. */
  id: string;
  from: string;
  to: string;
}

function collectBranches(topology: TopologySummary): CollectedBranch[] {
  const branches: CollectedBranch[] = [];
  for (const line of topology.lines) {
    const t = extractTerminals(line);
    if (t) branches.push({ id: `line-${String(line.idx)}`, ...t });
  }
  for (const trafo of topology.transformers) {
    const t = extractTerminals(trafo);
    if (t) branches.push({ id: `transformer-${String(trafo.idx)}`, ...t });
  }
  return branches;
}

/**
 * Fingerprint of everything `autoLayout` reads from a topology: the bus
 * idx values and each branch's id and terminals, in order. Two topologies
 * with the same signature lay out identically, so a caller can skip a
 * layout when only other fields changed (a power-flow run flips `state`
 * and rewrites parameter values; none of that moves a bus). It is the
 * exact serialization rather than a short hash, so two different graphs
 * can never share a key.
 */
export function layoutSignature(topology: TopologySummary): string {
  return JSON.stringify([
    topology.buses.map((b) => String(b.idx)),
    collectBranches(topology).map((b) => [b.id, b.from, b.to]),
  ]);
}

interface ElkLayoutResult {
  children?: Array<{
    id: string;
    x?: number;
    y?: number;
    ports?: Array<{ id: string; x?: number; y?: number }>;
    edges?: ElkResultEdge[];
  }>;
  edges?: ElkResultEdge[];
}

interface ElkResultEdge {
  id: string;
  sections?: Array<{
    startPoint?: { x: number; y: number };
    endPoint?: { x: number; y: number };
    bendPoints?: Array<{ x: number; y: number }>;
  }>;
}

/**
 * Run ELK on the topology and return per-bus coordinates + per-edge
 * bend-point polylines.
 *
 * Two passes:
 *
 * 1. Layered + ORTHOGONAL with no port constraints — gives final
 *    bus coords. Same shape as the v0.1 single-pass call.
 * 2. Same algorithm + 4 cardinal `FIXED_SIDE` ports per bus + edges
 *    targeted at port-suffixed shape ids derived from
 *    `computeHandleAssignments` on pass-1 coords. Bend points come back
 *    on `result.edges[].sections[0].{startPoint, bendPoints, endPoint}`.
 *
 * Pass 2 is skipped if `topology.buses.length < 2` (a single bus has
 * no edges; routing is moot).
 *
 * Callers should `await` and render `<SldLayoutSkeleton />` while
 * pending.
 */
export async function autoLayout(
  topology: TopologySummary,
  options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): Promise<LayoutResult> {
  const buses = topology.buses;
  if (buses.length === 0) {
    return { coords: {}, bendPoints: new Map() };
  }

  const branches = collectBranches(topology);
  const busIdSet = new Set(buses.map((b) => String(b.idx)));
  const validBranches = branches.filter((b) => busIdSet.has(b.from) && busIdSet.has(b.to));

  // ---- pass 1: get coords ----
  const pass1Graph: ElkNode = {
    id: 'root',
    layoutOptions: options,
    children: buses.map((b) => ({
      id: String(b.idx),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: validBranches.map((b) => ({
      id: b.id,
      sources: [b.from],
      targets: [b.to],
    })),
  };

  let coords: CoordsByIdx;
  try {
    const result = (await elkLayout(pass1Graph)) as ElkLayoutResult;
    coords = {};
    for (const child of result.children ?? []) {
      coords[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
    }
  } catch (err) {
    console.warn('SLD auto-layout: ELK pass 1 failed, using grid fallback', err);
    return {
      coords: gridLayout(buses.map((b) => String(b.idx))),
      bendPoints: new Map(),
    };
  }

  if (validBranches.length === 0) {
    return { coords, bendPoints: new Map() };
  }

  // ---- pass 2: bend points via FIXED_SIDE ports ----
  // Reuse the rule the diagram draws its branches by (the faces of the
  // bars, or the ends of two that stand in a row, one branch to an end),
  // so a route leaves each bus by the side it will be drawn leaving by.
  const { branches: handleAssignments } = computeHandleAssignments(topology, coords);
  const portTargets = new Map<string, { source: string; target: string }>();
  for (const branch of validBranches) {
    const ha = handleAssignments.get(branch.id);
    if (!ha) continue;
    portTargets.set(branch.id, {
      source: `${branch.from}.${ha.sourceSide}`,
      target: `${branch.to}.${ha.targetSide}`,
    });
  }

  const pass2Graph: ElkNode = {
    id: 'root',
    layoutOptions: options,
    children: buses.map((b) => ({
      id: String(b.idx),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      ports: (['north', 'east', 'south', 'west'] as Side[]).map((side) => ({
        id: `${String(b.idx)}.${side}`,
        layoutOptions: { 'elk.port.side': SIDE_TO_ELK[side] },
      })),
    })),
    edges: validBranches.map((b) => {
      const ports = portTargets.get(b.id);
      return {
        id: b.id,
        sources: [ports?.source ?? b.from],
        targets: [ports?.target ?? b.to],
      };
    }),
  };

  const bendPoints = new Map<string, [number, number][]>();
  let pass2Coords: CoordsByIdx | null = null;
  try {
    const result = (await elkLayout(pass2Graph)) as ElkLayoutResult;
    pass2Coords = {};
    for (const child of result.children ?? []) {
      pass2Coords[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
    }
    // Edges may sit on root or on the deepest common parent's children.
    const allEdges: ElkResultEdge[] = [
      ...(result.edges ?? []),
      ...(result.children ?? []).flatMap((c) => c.edges ?? []),
    ];
    for (const edge of allEdges) {
      const section = edge.sections?.[0];
      if (!section || !section.startPoint || !section.endPoint) continue;
      const polyline: [number, number][] = [];
      polyline.push([section.startPoint.x, section.startPoint.y]);
      for (const bp of section.bendPoints ?? []) {
        polyline.push([bp.x, bp.y]);
      }
      polyline.push([section.endPoint.x, section.endPoint.y]);
      bendPoints.set(edge.id, polyline);
    }
  } catch (err) {
    console.warn(
      'SLD auto-layout: ELK pass 2 failed, using pass-1 coords without bend points',
      err,
    );
    return { coords, bendPoints: new Map() };
  }

  // Pass 2 produces the final coords (same algorithm; ports nudge node
  // sizes by zero so coords match pass 1 in practice, but using pass 2
  // keeps the bend-point polylines self-consistent with the bus
  // positions React Flow renders).
  return { coords: pass2Coords ?? coords, bendPoints };
}

/**
 * Grid-layout fallback. sqrt(n) wide, row-major ordering of bus idxs.
 * Used when ELK throws and as a last-resort when no auto-layout has run.
 */
export function gridLayout(busIds: readonly string[]): CoordsByIdx {
  const cols = Math.max(1, Math.ceil(Math.sqrt(busIds.length)));
  const out: CoordsByIdx = {};
  for (let i = 0; i < busIds.length; i++) {
    const id = busIds[i];
    if (!id) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    out[id] = { x: col * GRID_CELL_WIDTH, y: row * GRID_CELL_HEIGHT };
  }
  return out;
}
