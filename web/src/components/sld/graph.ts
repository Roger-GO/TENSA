/**
 * Pure helpers that translate a `TopologySummary` + coordinate map into
 * the React Flow `nodes` + `edges` shape the canvas renders. Lives in
 * its own module so the file is import-clean for testing (no React
 * runtime, no ReactFlow init) and so `SldCanvas.tsx` keeps the
 * `react-refresh` constant-export rule happy.
 */
import type { Edge, Node } from '@xyflow/react';
import type { BusCoord, TopologyEntry, TopologySummary } from '@/api/types';
import { subKindForControllerClass } from '@/lib/controllers';
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
 * Stub-edge stride record. Stubs (non-bus → bus connectors) participate
 * in the same `(busId, side)` cluster as branch edges so a stub doesn't
 * connect at the SAME point on the bus boundary as a line entering on
 * the same cardinal side — the user couldn't tell which was which.
 */
export interface StubAssignment {
  /** Bus side the stub connects to (matches BUS_SIDE_FOR_KIND). */
  busSide: Side;
  /** Stride within the (busId, busSide) cluster (counted alongside branches). */
  stride: number;
}

/**
 * For every edge in `topology`, compute the handle assignment + the
 * stride indices for both endpoints.
 *
 * Stride accounting groups every edge that touches `(busId, side)` —
 * regardless of whether this bus is the source or the target on that
 * side, AND including non-bus stub edges (generator/load/shunt → bus).
 * Without this, two devices with stubs landing on the same cardinal
 * side as a real branch all share the bus's connection dot, making the
 * topology unreadable. Bidirectional stride teases each connection
 * onto its own offset along the perpendicular axis.
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
): {
  branches: Map<string, HandleAssignment>;
  stubs: Map<string, StubAssignment>;
} {
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
    if (!warnedDegenerate && fromCoord.x === toCoord.x && fromCoord.y === toCoord.y) {
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
  const branches = new Map<string, HandleAssignment>();
  const stubs = new Map<string, StubAssignment>();
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
    branches.set(c.edgeId, {
      sourceSide: chosen.sourceSide,
      targetSide: chosen.targetSide,
      sourceStride,
      targetStride,
    });
  }

  // Third pass: register stub edges into the same cluster counters.
  // Each non-bus device gets one stub touching `(parentBus, kindSide)`
  // — the side is fixed by the kind (generator → north, load → south,
  // shunt → west). Stubs share the cluster with branches, so the stub
  // gets a stride that DOES NOT collide with branch endpoints already
  // counted in pass 2.
  const nonBusBucketsForStub: Array<{
    entries: readonly TopologyEntry[];
    parentKey: string;
    kindSide: Side;
    kind: 'generator' | 'load' | 'shunt';
  }> = [
    {
      entries: dedupeGeneratorsByIdx(topology.generators ?? []),
      parentKey: 'bus',
      kindSide: 'north',
      kind: 'generator',
    },
    {
      entries: topology.loads ?? [],
      parentKey: 'bus',
      kindSide: 'south',
      kind: 'load',
    },
    {
      entries: topology.shunts ?? [],
      parentKey: 'bus',
      kindSide: 'west',
      kind: 'shunt',
    },
  ];
  for (const bucket of nonBusBucketsForStub) {
    for (const entry of bucket.entries) {
      const parentIdx = _busFromParam(entry, bucket.parentKey);
      if (parentIdx === null || !coords[parentIdx]) continue;
      const stubId = `stub-${bucket.kind}-${String(entry.idx)}`;
      const clusterKey = `${parentIdx}|${bucket.kindSide}`;
      const stride = counts.get(clusterKey) ?? 0;
      counts.set(clusterKey, stride + 1);
      stubs.set(stubId, { busSide: bucket.kindSide, stride });
    }
  }
  return { branches, stubs };
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
  stubAssignments?: Map<string, StubAssignment>;
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
  /**
   * Per-React-Flow-node-id coordinate overrides captured from user drags
   * (the in-memory `dragOverrides` map). Drag overrides PRE-EMPT the
   * collision push-out: a node with a drag override is treated as
   * stationary so push-out can shift collisions around it without
   * snapping the user's chosen position.
   *
   * Keys here are React Flow ids (`${kind}-${idx}`, or the bus idx for
   * a bus). Entries that don't match any built node are ignored —
   * stale drag overrides for deleted elements get pruned by the canvas
   * effect on the next render.
   */
  dragOverrides?: Record<string, { x: number; y: number }>;
  /**
   * When true, the post-emission collision push-out pass runs after
   * non-bus nodes are placed (Unit 3). Default: true. Tests that want
   * to assert on the raw kind-default offsets pass `false` to skip it.
   */
  applyPushOut?: boolean;
}

/**
 * Bounding-box footprint per kind. Width × height in canvas pixels.
 *
 * Buses use a slightly wider box because the bus glyph is the longest
 * stroke + label. Non-bus elements share a 50×46 footprint matching the
 * post-Unit-13c device-node shrink. Exported so tests can assert
 * deterministic overlap math without re-deriving the constants.
 */
export const NODE_FOOTPRINT: Record<
  'bus' | 'generator' | 'load' | 'shunt',
  {
    width: number;
    height: number;
  }
> = {
  // Busbar footprint: the bar is ~92px wide; height reserves room for the
  // bar plus the name/voltage label that hangs below it so stacked buses
  // don't collide labels.
  bus: { width: 92, height: 44 },
  generator: { width: 50, height: 46 },
  load: { width: 50, height: 46 },
  shunt: { width: 50, height: 46 },
};

/**
 * Pre-measure size hint for controller badge nodes. `NODE_FOOTPRINT` has
 * no controller entry (badges aren't part of the push-out overlap math),
 * so this small square approximates the `ControllerNode` glyph just well
 * enough that RF v12 draws a MiniMap rect before the DOM measures it.
 */
export const CONTROLLER_GLYPH_FOOTPRINT = 28;

/** Pixels of clear space the push-out pass keeps between nodes after a shift. */
export const PUSH_OUT_SAFETY_GAP = 8;

/**
 * Maximum push-out passes before the algorithm bails. Each pass runs to
 * "no more pair-overlaps" before exiting; in pathological inputs a
 * single pass can cause new overlaps to surface (push A out of B's box
 * directly into C's). 4 passes is empirically sufficient for the v0.2
 * demo set + the synthetic worst-case scenarios in `R34`.
 */
export const PUSH_OUT_MAX_PASSES = 4;

/**
 * Push-direction unit vector per kind. Drives where a colliding non-bus
 * node travels first; if the chosen direction would put the node
 * outside the canvas-bound (the convex hull of all bus positions
 * extended by 200 px), the pass falls back to the perpendicular
 * (lateral) axis. Generators push UP (north); loads push DOWN (south);
 * shunts push down-and-left (south-west). Buses are not push-out
 * candidates — they anchor everything else.
 */
interface PushDirSpec {
  /** Primary axis: 'x' or 'y'. */
  axis: 'x' | 'y';
  /** Sign on the primary axis (+1 = right/down, -1 = left/up). */
  sign: 1 | -1;
  /**
   * Secondary axis nudge — applied alongside the primary push to fan
   * the node away from the colliding box's center. For shunts this is
   * what gives them the south-west diagonal preferred by the plan.
   */
  secondarySign: 0 | 1 | -1;
}

const PUSH_DIR_FOR_KIND: Record<'generator' | 'load' | 'shunt', PushDirSpec> = {
  generator: { axis: 'y', sign: -1, secondarySign: 0 },
  load: { axis: 'y', sign: 1, secondarySign: 0 },
  shunt: { axis: 'x', sign: -1, secondarySign: 1 },
};

/**
 * Push-out input shape. Exported so unit tests can construct fixtures
 * directly and assert on the algorithm without round-tripping through
 * `buildGraph`.
 */
export interface PushOutNode {
  id: string;
  kind: 'bus' | 'generator' | 'load' | 'shunt';
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when the user explicitly dragged this node — never push it. */
  locked: boolean;
  /** Bus parent id (only set on non-bus nodes); a non-bus node never collides with its parent. */
  parentBusId: string | null;
}

/** Reasonable canvas bound (convex hull of buses + 200 px margin). Exported for tests. */
export interface CanvasBound {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Compute the canvas bound from the bus positions (extended by 200 px on every side). */
function computeCanvasBound(buses: PushOutNode[]): CanvasBound | null {
  if (buses.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of buses) {
    if (b.x < minX) minX = b.x;
    if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.y > maxY) maxY = b.y;
  }
  return {
    minX: minX - 200,
    maxX: maxX + 200,
    minY: minY - 200,
    maxY: maxY + 200,
  };
}

/** Axis-aligned bounding-box overlap. Returns 0 when the boxes don't overlap. */
function overlapAmount(a: PushOutNode, b: PushOutNode): { dx: number; dy: number } {
  const aLeft = a.x - a.width / 2;
  const aRight = a.x + a.width / 2;
  const aTop = a.y - a.height / 2;
  const aBottom = a.y + a.height / 2;
  const bLeft = b.x - b.width / 2;
  const bRight = b.x + b.width / 2;
  const bTop = b.y - b.height / 2;
  const bBottom = b.y + b.height / 2;
  // Negative or zero gap = no overlap on that axis.
  const overlapX = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
  const overlapY = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
  if (overlapX <= 0 || overlapY <= 0) return { dx: 0, dy: 0 };
  return { dx: overlapX, dy: overlapY };
}

/**
 * Push `b` away from `a` along `b`'s preferred axis. If the resulting
 * position would leave `bound`, fall back to the perpendicular axis.
 *
 * Returns the new position (immutable); the caller is responsible for
 * writing it back into the node array.
 */
function shiftAwayFrom(
  a: PushOutNode,
  b: PushOutNode,
  overlap: { dx: number; dy: number },
  bound: CanvasBound | null,
): { x: number; y: number } {
  if (b.kind === 'bus') return { x: b.x, y: b.y }; // Defensive — never push buses.
  const dir = PUSH_DIR_FOR_KIND[b.kind];
  // Distance to clear the overlap on each axis, including the safety
  // gap. We always shift by enough so the bounding boxes break apart
  // with PUSH_OUT_SAFETY_GAP of clearance between them.
  const shiftPrimary = (dir.axis === 'y' ? overlap.dy : overlap.dx) + PUSH_OUT_SAFETY_GAP;
  let nx = b.x;
  let ny = b.y;
  if (dir.axis === 'y') {
    ny = b.y + dir.sign * shiftPrimary;
    if (dir.secondarySign !== 0) {
      nx = b.x + dir.secondarySign * (overlap.dx + PUSH_OUT_SAFETY_GAP);
    }
  } else {
    nx = b.x + dir.sign * shiftPrimary;
    if (dir.secondarySign !== 0) {
      ny = b.y + dir.secondarySign * (overlap.dy + PUSH_OUT_SAFETY_GAP);
    }
  }
  // Canvas-bound check: if the primary push leaves the bound, fall back
  // to the perpendicular axis (lateral) using the side that points
  // AWAY from `a`'s center. This is the documented "exception: fall
  // back to LEFT or RIGHT" behavior.
  if (
    bound !== null &&
    (nx < bound.minX || nx > bound.maxX || ny < bound.minY || ny > bound.maxY)
  ) {
    // Restore start point and choose the perpendicular axis.
    nx = b.x;
    ny = b.y;
    if (dir.axis === 'y') {
      // Perpendicular is X — push laterally away from a.x.
      const lateralSign = b.x >= a.x ? 1 : -1;
      nx = b.x + lateralSign * (overlap.dx + PUSH_OUT_SAFETY_GAP);
    } else {
      const lateralSign = b.y >= a.y ? 1 : -1;
      ny = b.y + lateralSign * (overlap.dy + PUSH_OUT_SAFETY_GAP);
    }
  }
  return { x: nx, y: ny };
}

/**
 * Collision push-out post-process. Walks every pair `(A, B)` where
 * either is a non-bus node and their bounding boxes overlap; shifts
 * `B` (the lower-priority element of the pair) along its kind's
 * preferred push direction by `(overlap + safety_gap)` until clear.
 *
 * Idempotent: running twice on the same input produces the same
 * output. Locked nodes (those with a drag override) are NEVER moved —
 * other nodes are pushed out of THEIR way instead.
 *
 * Iteration order is fixed (`generator → load → shunt` within the
 * existing buildGraph emission order) so the output is deterministic.
 *
 * Pure function: input nodes array is not mutated; a new array of
 * `{ id, position }` results is returned. Bus positions are passed
 * through unchanged — only non-bus positions can change.
 *
 * R34 scope: collision-free on the v0.2 demo topology set + a synthetic
 * worst-case input (5 generators on one bus; vertically-stacked buses
 * 80 px apart). Universal-input collision-freedom is explicitly out of
 * scope; v0.5's compound-ELK swap is the proper fix.
 */
export function pushOutCollisions(
  inputs: ReadonlyArray<PushOutNode>,
  options: { maxPasses?: number; bound?: CanvasBound | null } = {},
): Map<string, { x: number; y: number }> {
  const maxPasses = options.maxPasses ?? PUSH_OUT_MAX_PASSES;
  // Working copy — mutated during the pass. Index by id for fast
  // lookup when the caller queries the final position.
  const work: PushOutNode[] = inputs.map((n) => ({ ...n }));
  const buses = work.filter((n) => n.kind === 'bus');
  const bound = options.bound ?? computeCanvasBound(buses);
  // Non-bus nodes are the only candidates that move. We iterate every
  // pair (A, B) where B is non-bus and !locked; if (A, B) overlaps and
  // they're not (parent, child), shift B.
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let movedAny = false;
    for (let bi = 0; bi < work.length; bi += 1) {
      const b = work[bi]!;
      if (b.kind === 'bus' || b.locked) continue;
      for (let ai = 0; ai < work.length; ai += 1) {
        if (ai === bi) continue;
        const a = work[ai]!;
        // Skip the parent-bus pair: a generator IS connected to its
        // parent, the stub edge crosses the bus boundary by design.
        if (a.kind === 'bus' && b.parentBusId === a.id) continue;
        const overlap = overlapAmount(a, b);
        if (overlap.dx === 0 || overlap.dy === 0) continue;
        const next = shiftAwayFrom(a, b, overlap, bound);
        if (next.x !== b.x || next.y !== b.y) {
          b.x = next.x;
          b.y = next.y;
          movedAny = true;
        }
      }
    }
    if (!movedAny) break;
  }
  const result = new Map<string, { x: number; y: number }>();
  for (const n of work) {
    result.set(n.id, { x: n.x, y: n.y });
  }
  return result;
}

/**
 * Default offsets for non-bus elements relative to their parent bus.
 *
 * Tuned to keep two vertically-adjacent buses (e.g., IEEE 14's BUS5 at
 * y=250 and BUS6 at y=400 — only 150 px apart) from having their
 * non-bus children collide. With y_offset=70, BUS5's south child lands
 * at 320 and BUS6's north child at 330 — a 10-px gap that the
 * row-parity x-stagger below widens further.
 *
 * Stack indices grow on a mix of axes per kind so multiple devices on
 * one bus don't overlap each other. Tunable; the user can drag to
 * override (Unit 9).
 */
export const NON_BUS_OFFSETS = {
  generator: { x: 0, y: -70, stackDx: 50, stackDy: -45 },
  load: { x: 0, y: 70, stackDx: 50, stackDy: 45 },
  shunt: { x: -75, y: 55, stackDx: -50, stackDy: 30 },
} as const satisfies Record<
  'generator' | 'load' | 'shunt',
  { x: number; y: number; stackDx: number; stackDy: number }
>;

/** Stack-row width: 4 devices per row before wrapping vertically. */
const STACK_ROW_LIMIT = 4;

/**
 * Vertical-neighbor stagger. When two buses are stacked vertically
 * (same column, different y row), their north / south children land
 * at the same default position. We stagger the children laterally
 * based on the parent-bus row parity so the lower bus's north child
 * sits a few px to one side of the upper bus's south child. The
 * parity is derived from `Math.round(busY / 100)` — for IEEE 14's
 * curated layout this produces alternating offsets per row.
 */
const ROW_STAGGER_PIXELS = 28;

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

/** ANDES SynGen (rotor) model classes — the dynamic half of a machine. */
const DYNAMIC_GENERATOR_KINDS: ReadonlySet<string> = new Set(['GENROU', 'GENCLS']);

/**
 * Collapse the generators bucket to one entry per idx. ANDES shares an idx
 * between a machine's static power-flow record (`PV`/`Slack`) and its dynamic
 * rotor model (`GENROU`/`GENCLS`), so the raw bucket carries two entries per
 * machine. Emitting both produces a duplicate `generator-<idx>` React node id
 * (and `stub-generator-<idx>` edge id) — a console error + an ambiguous anchor
 * for controllers that dock via `syn`. Keep one entry per idx, preferring the
 * dynamic record (it owns the rotor stack controllers attach to), and preserve
 * first-seen idx order.
 */
function dedupeGeneratorsByIdx(entries: readonly TopologyEntry[]): TopologyEntry[] {
  const chosen = new Map<string, TopologyEntry>();
  for (const e of entries) {
    const key = String(e.idx);
    const existing = chosen.get(key);
    if (existing === undefined) {
      chosen.set(key, e);
    } else if (DYNAMIC_GENERATOR_KINDS.has(e.kind) && !DYNAMIC_GENERATOR_KINDS.has(existing.kind)) {
      chosen.set(key, e);
    }
  }
  const seen = new Set<string>();
  const out: TopologyEntry[] = [];
  for (const e of entries) {
    const key = String(e.idx);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chosen.get(key)!);
  }
  return out;
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
      // Pre-measure size hint. RF v12 only draws a MiniMap rect for a
      // node whose user object carries dimensions; `initialWidth/Height`
      // seed that before the DOM measures the real glyph and are dropped
      // afterward, so they never pin the node (unlike `width/height`).
      initialWidth: NODE_FOOTPRINT.bus.width,
      initialHeight: NODE_FOOTPRINT.bus.height,
      data: {
        idx,
        name: b.name,
        kind: b.kind,
      },
    } satisfies Node;
  });

  const handles = opts.handleAssignments ?? new Map<string, HandleAssignment>();
  const stubAssignments = opts.stubAssignments ?? new Map<string, StubAssignment>();
  const bends = opts.bendPoints ?? new Map<string, [number, number][]>();
  const nonBusCoords = opts.nonBusCoords ?? new Map<string, BusCoord>();
  const branchDragOverrides = opts.dragOverrides ?? {};
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const pushBranchEdge = (entry: TopologyEntry, kindLabel: 'line' | 'transformer') => {
    const t = entryTerminals(entry);
    if (!t) return;
    const id = `${kindLabel}-${String(entry.idx)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const handleAssignment = handles.get(id);
    // If either endpoint bus was moved by the user (drag override), the
    // ELK bend-points are stale — they were computed for the auto-layout
    // grid position, not where the bus now sits — so a routed polyline
    // would render disconnected, floating in space. Drop the polyline so
    // the edge falls back to dynamic routing that follows the live node
    // positions (and reaches the moved bus's handle).
    const endpointMoved =
      branchDragOverrides[t.from] !== undefined || branchDragOverrides[t.to] !== undefined;
    const polyline = endpointMoved ? undefined : bends.get(id);
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
      entries: dedupeGeneratorsByIdx(topology.generators ?? []),
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
        console.warn(`SLD: ${bucket.kind} ${String(entry.idx)} has no parent bus; skipping`);
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
      // Stacks wrap onto a new row every STACK_ROW_LIMIT devices: the
      // first 4 fan horizontally on one row, devices 5+ jump to a
      // second row. Centering on the bus uses an alternating sign so
      // the cluster stays visually balanced without a pre-pass to
      // count total devices on the parent.
      const col = stackIndex % STACK_ROW_LIMIT;
      const row = Math.floor(stackIndex / STACK_ROW_LIMIT);
      // Alternate left/right around the bus center: indices 0,1,2,3
      // map to columns 0, 1, -1, 2 → roughly centered fan.
      const COL_SCHEDULE = [0, 1, -1, 2, -2, 3, -3];
      const colSigned = COL_SCHEDULE[col] ?? col;
      // Vertical-neighbor stagger: bus rows alternating ±ROW_STAGGER
      // so two stacked buses' children land on different x columns,
      // even when both want to sit at busX (col=0). For non-zero
      // colSigned the stagger is irrelevant; we only stagger col=0.
      const rowParity = Math.round(parentCoord.y / 100) % 2 === 0 ? 1 : -1;
      const rowStagger = colSigned === 0 ? rowParity * ROW_STAGGER_PIXELS : 0;
      // Prefer the exact model-class match (`PV|1`); fall back to the
      // UI-category key (`generator|1`) so a sidecar that was saved
      // before a kind-edit still resolves the dragged coord. The dual-
      // key shape is documented in `sidecar.ts.buildNonBusCoordinates`.
      const modelKey = `${entry.kind}|${String(entry.idx)}`;
      const categoryKey = `${bucket.kind}|${String(entry.idx)}`;
      const sidecar = nonBusCoords.get(modelKey) ?? nonBusCoords.get(categoryKey);
      const x = sidecar?.x ?? parentCoord.x + offset.x + offset.stackDx * colSigned + rowStagger;
      const y = sidecar?.y ?? parentCoord.y + offset.y + offset.stackDy * row;
      const nodeId = `${bucket.kind}-${String(entry.idx)}`;
      nodes.push({
        id: nodeId,
        type: NON_BUS_NODE_TYPE[bucket.kind],
        position: { x, y },
        // Pre-measure size hint so RF v12 draws a MiniMap rect; see the
        // bus-node note above. Dropped once the device glyph is measured.
        initialWidth: NODE_FOOTPRINT[bucket.kind].width,
        initialHeight: NODE_FOOTPRINT[bucket.kind].height,
        data: {
          idx: String(entry.idx),
          name: entry.name,
          kind: entry.kind,
          parentBus: parentIdx,
        },
      } satisfies Node);
      // Stub edge from the non-bus node to the bus's appropriate side.
      // Pull the stride for this stub so StubEdge can lateral-offset
      // the bus-end endpoint and avoid sharing a connection point with
      // any branch entering on the same cardinal side.
      const stubId = `stub-${nodeId}`;
      const stubAssignment = stubAssignments.get(stubId);
      edges.push({
        id: stubId,
        source: nodeId,
        sourceHandle: NON_BUS_HANDLE_ID,
        target: parentIdx,
        targetHandle: TARGET_HANDLE[BUS_SIDE_FOR_KIND[bucket.kind]],
        type: 'stub',
        data: {
          kind: entry.kind,
          bucket: bucket.kind,
          busSide: stubAssignment?.busSide ?? BUS_SIDE_FOR_KIND[bucket.kind],
          targetStride: stubAssignment?.stride ?? 0,
        },
      });
    }
  }

  // Collision push-out (Unit 3, v0.1.y). Runs after the kind-based
  // fan-stack emission and any sidecar overrides have placed every
  // non-bus node. Pre-applies drag overrides so the user's chosen
  // position is treated as stationary; other nodes shift around them.
  const applyPushOut = opts.applyPushOut ?? true;
  if (applyPushOut) {
    const dragOverrides = opts.dragOverrides ?? {};
    const lockedIds = new Set(Object.keys(dragOverrides));
    // Build the push-out input. Each non-bus node carries its parent
    // bus id so the push-out skips the parent collision (a generator
    // touching the north face of its bus is the design, not a bug).
    const pushInputs = nodes.map((n) => {
      const override = dragOverrides[n.id];
      const x = override?.x ?? n.position.x;
      const y = override?.y ?? n.position.y;
      const kind: 'bus' | 'generator' | 'load' | 'shunt' =
        n.type === 'bus' || n.type === 'generator' || n.type === 'load' || n.type === 'shunt'
          ? n.type
          : 'bus';
      const footprint = NODE_FOOTPRINT[kind];
      const parentBusId =
        n.type !== 'bus' && typeof (n.data as { parentBus?: unknown })?.parentBus === 'string'
          ? (n.data as { parentBus: string }).parentBus
          : null;
      return {
        id: n.id,
        kind,
        x,
        y,
        width: footprint.width,
        height: footprint.height,
        // Buses are also locked (they anchor the layout). Drag-overridden
        // non-bus nodes are locked too.
        locked: kind === 'bus' || lockedIds.has(n.id),
        parentBusId,
      };
    });
    const resolved = pushOutCollisions(pushInputs);
    // Stamp the resolved positions back onto the node array. Drag
    // overrides take precedence — push-out's locked-node guarantee
    // already keeps overridden ids stationary, so the resolved map
    // returns the override coord verbatim. SldCanvas tracks the
    // prior render's positions in a `useRef` and applies a
    // `transition: transform` style to nodes that moved (Unit 3
    // animation requirement); buildGraph itself doesn't carry that
    // signal — the canvas owns the prior-render comparison.
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i]!;
      const next = resolved.get(n.id);
      if (!next) continue;
      if (next.x === n.position.x && next.y === n.position.y) continue;
      nodes[i] = { ...n, position: { x: next.x, y: next.y } };
    }
  }

  // ---- Dynamic controllers (Unit 19) ----------------------------------
  // Dock each controller beside the device it references. ANDES wires a
  // controller to a SynGen (`syn`), a Bus/StaticGen (`bus`/`gen`), or
  // another controller (`avr`→Exciter, `reg`→RenGen, `ree`→RenExciter), so
  // resolution runs in iterative passes: a PSS docks beside its exciter,
  // which has already docked beside its GENROU; REPCA1→REECA1→REGCP1
  // resolves the same way. Runs after collision push-out so anchors use
  // each parent's final position. A controller whose reference can't be
  // resolved renders as an orphan badge in the gutter.
  appendControllerNodes(nodes, topology.controllers ?? []);

  return { nodes, edges };
}

/** Docked offset of a controller badge from its parent device's origin. */
const CONTROLLER_DOCK = { x: 32, y: -18, stackDy: 22 } as const;

/**
 * Resolve the React Flow node id a controller should dock to, given the
 * nodes placed so far. Returns the target node id, `'orphan'` (no resolvable
 * ref param), or `'wait'` (a ref exists but its target node hasn't been placed
 * yet — retry on a later pass).
 *
 * Generator/bus references resolve directly (those nodes are placed before any
 * controller). Upstream-controller references (`avr`→Exciter, `reg`→RenGen,
 * `ree`→RenExciter) name another controller by its model-local idx, so they
 * resolve through `controllerNodeIdByIdx` (idx → kind-namespaced node id),
 * which is why the renewable / PSS chains need iterative passes.
 */
function resolveControllerParent(
  entry: TopologyEntry,
  nodeById: ReadonlyMap<string, Node>,
  controllerNodeIdByIdx: ReadonlyMap<string, string>,
): { id: string } | 'orphan' | 'wait' {
  const params = entry.params;
  if (!params) return 'orphan';
  const refVal = (key: string): string | null => {
    const v = params[key];
    if (v === undefined || v === null || typeof v === 'boolean') return null;
    const s = String(v);
    return s === '' ? null : s;
  };
  // Direct device refs: SynGen / StaticGen → a generator node; ACNode → a
  // bus node (bus node ids carry no prefix). Generators are de-duped by idx
  // upstream, so `generator-<idx>` is unambiguous.
  const directRefs: string[] = [];
  const synRef = refVal('syn') ?? refVal('gen');
  if (synRef !== null) directRefs.push('generator-' + synRef);
  const busRef = refVal('bus');
  if (busRef !== null) directRefs.push(busRef);
  for (const id of directRefs) {
    if (nodeById.has(id)) return { id };
  }
  // Upstream-controller ref: resolve the referenced controller's idx to its
  // placed (kind-namespaced) node id; wait if it hasn't been placed yet.
  const ctrlRef = refVal('avr') ?? refVal('reg') ?? refVal('ree');
  if (ctrlRef !== null) {
    const cid = controllerNodeIdByIdx.get(ctrlRef);
    if (cid !== undefined && nodeById.has(cid)) return { id: cid };
    return 'wait';
  }
  // A direct ref was named but its node is missing (dangling): the parent
  // device is genuinely absent — keep waiting (becomes an orphan after the
  // passes drain). No ref at all → immediate orphan.
  return directRefs.length > 0 ? 'wait' : 'orphan';
}

/**
 * Append a docked badge node for each controller in `controllers`,
 * mutating `nodes` in place. Iterative passes resolve controller→controller
 * reference chains; anything still unresolved after the passes (a dangling
 * idx) is placed as an orphan.
 */
function appendControllerNodes(nodes: Node[], controllers: readonly TopologyEntry[]): void {
  if (controllers.length === 0) return;
  const nodeById = new Map<string, Node>(nodes.map((n) => [n.id, n] as const));
  const stackCounts = new Map<string, number>();
  // idx → placed controller node id, so `avr`/`reg`/`ree` chain refs (which
  // name a controller by its model-local idx) resolve to the right node even
  // though node ids are kind-namespaced. First-placed wins under the rare
  // case of two controllers sharing an idx.
  const controllerNodeIdByIdx = new Map<string, string>();

  const place = (entry: TopologyEntry, parentId: string | null): void => {
    const idx = String(entry.idx);
    // Namespace by model class: ANDES idx is model-local, so two different
    // controllers (e.g. an exciter + a governor on the same machine) can
    // share a numeric idx. A bare `controller-<idx>` id would collide,
    // dropping one badge from the SLD and aliasing inspector lookups.
    const nodeId = `controller-${entry.kind}-${idx}`;
    const subKind = subKindForControllerClass(entry.kind);
    const parent = parentId !== null ? nodeById.get(parentId) : undefined;
    const stackKey = parent ? parentId! : '__orphan__';
    const stackIndex = stackCounts.get(stackKey) ?? 0;
    stackCounts.set(stackKey, stackIndex + 1);

    let position: { x: number; y: number };
    let connectorDx = 0;
    let connectorDy = 0;
    if (parent) {
      position = {
        x: parent.position.x + CONTROLLER_DOCK.x,
        y: parent.position.y + CONTROLLER_DOCK.y + stackIndex * CONTROLLER_DOCK.stackDy,
      };
      // Vector (controller origin → parent origin) so ControllerNode can
      // draw an exact tether back to the device for any stack row.
      connectorDx = parent.position.x - position.x;
      connectorDy = parent.position.y - position.y;
    } else {
      position = { x: 24, y: 24 + stackIndex * CONTROLLER_DOCK.stackDy };
    }

    const node: Node = {
      id: nodeId,
      type: 'controller',
      position,
      // Pre-measure size hint so RF v12 draws a MiniMap rect; see the
      // bus-node note above. `NODE_FOOTPRINT` has no controller entry, so
      // approximate the small badge glyph with a 28×28 box.
      initialWidth: CONTROLLER_GLYPH_FOOTPRINT,
      initialHeight: CONTROLLER_GLYPH_FOOTPRINT,
      // Docked badges aren't free-dragged (no sidecar persistence for
      // controllers); they follow their parent device.
      draggable: false,
      data: {
        idx,
        name: entry.name,
        kind: entry.kind,
        subKind,
        orphan: !parent,
        connectorDx,
        connectorDy,
        parentNodeId: parentId ?? undefined,
      },
    };
    nodes.push(node);
    nodeById.set(nodeId, node);
    if (!controllerNodeIdByIdx.has(idx)) controllerNodeIdByIdx.set(idx, nodeId);
  };

  const pending = [...controllers];
  let changed = true;
  while (changed && pending.length > 0) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i]!;
      const resolved = resolveControllerParent(entry, nodeById, controllerNodeIdByIdx);
      if (resolved === 'wait') continue;
      pending.splice(i, 1);
      changed = true;
      place(entry, resolved === 'orphan' ? null : resolved.id);
    }
  }
  // Dangling references (a parent idx that names no node) → orphan badges.
  for (const entry of pending) place(entry, null);
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
