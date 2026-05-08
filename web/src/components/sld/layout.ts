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
 * edge at a specific port chosen via `assignHandles(fromCoord,
 * toCoord)`; ELK's ORTHOGONAL routing then produces per-edge bend
 * points exiting the declared cardinal sides. The bend points feed the
 * `RoutedEdge` component so each line traces a unique corridor.
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
 * - Spacing chosen empirically: `nodeNode=60` + `nodeNodeBetweenLayers
 *   =80` gives buses room to render their IEC 60617 icons + name
 *   labels without overlap, while still fitting IEEE 39 in a single
 *   viewport at default zoom.
 * - Fallback: if ELK throws on either pass (rare; bundle problem or
 *   pathological graph), fall back to a plain sqrt(n)-wide grid + warn
 *   and skip bend points. The canvas still renders — just less
 *   prettily — so the user is never left staring at a blank pane.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import type { CoordsByIdx } from './sidecar';
import { computeHandleAssignments, type Side } from './graph';

/** Lazy ELK instance — `elkjs` reads `Worker` on construction in some bundles. */
let elkInstance: InstanceType<typeof ELK> | null = null;

function getElk(): InstanceType<typeof ELK> {
  if (!elkInstance) {
    elkInstance = new ELK();
  }
  return elkInstance;
}

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
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.edgeRouting': 'ORTHOGONAL',
};

/** Default node footprint passed to ELK (icon + label). */
const NODE_WIDTH = 60;
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
 *    targeted at port-suffixed shape ids derived from `assignHandles`
 *    on pass-1 coords. Bend points come back on `result.edges[].
 *    sections[0].{startPoint, bendPoints, endPoint}`.
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
    const result = (await getElk().layout(pass1Graph)) as ElkLayoutResult;
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
  // Reuse the canvas-side handle assignments so ELK's chosen ports
  // match the React Flow handle ids the buildGraph step will set.
  // computeHandleAssignments runs greedy conflict-avoidance (primary
  // → alternate axis on hub buses), so this stays in sync without
  // duplicating the logic.
  const handleAssignments = computeHandleAssignments(topology, coords);
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
    const result = (await getElk().layout(pass2Graph)) as ElkLayoutResult;
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
    console.warn('SLD auto-layout: ELK pass 2 failed, using pass-1 coords without bend points', err);
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
