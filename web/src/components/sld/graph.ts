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
import { DYNAMIC_GENERATOR_KINDS, generatorRowKey } from '@/lib/topology';
import { entryBaseKv, unratedBusIdx } from '@/lib/units';
import { busVoltageLimits } from './voltage';
import type { CoordsByIdx } from './sidecar';
import { BAR_LENGTH, BAR_THICKNESS, TAP_INSET, faceSpan, layoutConnections } from './connections';
import {
  DEVICE_PORT,
  TARGET_HANDLE,
  assignBranchSides,
  type BranchEnds,
  type HandleAssignment,
  type Side,
} from './sides';

export {
  DEVICE_PORT,
  SOURCE_HANDLE,
  TARGET_HANDLE,
  assignBranchSides,
  assignHandles,
  type BranchEnds,
  type HandleAssignment,
  type Side,
} from './sides';

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
 * Choose the vertical face (`north` / `south`) each bus's generators and
 * loads hang off. The face points AWAY from the bus's branch neighbours:
 * a bus that sits below its neighbours (e.g. the slack bus at the bottom
 * of the diagram) gets `south`, so its machine hangs below it instead of
 * shooting back up through the network it feeds. When a bus's branches
 * are level with it (a purely horizontal tap — the mid-ring buses whose
 * lines run left/right), the global vertical centroid breaks the tie so
 * the device points into the more open half of the canvas rather than
 * colliding with whatever is stacked directly beneath it.
 *
 * Used by `buildGraph` to place a device that the layout does not place.
 * Where its connector then attaches follows from where the device and its
 * bus sit (`connections.ts`), not from this face.
 *
 * Only buses with a CLEAR signal get an entry; a bus with no branches
 * sitting at the diagram centroid (e.g. a lone bus, or any case with no
 * vertical structure) is omitted so the caller keeps the kind default
 * (generator → north, load → south).
 */
export function computeDeviceVerticalSides(
  topology: TopologySummary,
  coords: CoordsByIdx,
): Map<string, 'north' | 'south'> {
  const yOf = (idx: string): number | undefined => coords[idx]?.y;
  const ys = topology.buses
    .map((b) => yOf(String(b.idx)))
    .filter((y): y is number => y !== undefined);
  const centroidY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
  const neighbors = new Map<string, string[]>();
  const link = (entry: TopologyEntry) => {
    const t = entryTerminals(entry);
    if (!t) return;
    const a = String(t.from);
    const b = String(t.to);
    (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
    (neighbors.get(b) ?? neighbors.set(b, []).get(b)!).push(a);
  };
  for (const line of topology.lines) link(line);
  for (const trafo of topology.transformers) link(trafo);
  // 12px guard so a near-level branch / near-centroid bus doesn't flip
  // the side on jitter — below it, there's no clear signal.
  const GUARD = 12;
  const sides = new Map<string, 'north' | 'south'>();
  for (const bus of topology.buses) {
    const idx = String(bus.idx);
    const by = yOf(idx);
    if (by === undefined) continue;
    const ny = (neighbors.get(idx) ?? []).map(yOf).filter((y): y is number => y !== undefined);
    const nc = ny.length ? ny.reduce((a, b) => a + b, 0) / ny.length : null;
    if (nc !== null && Math.abs(by - nc) > GUARD) {
      // Clear vertical relationship to the branch neighbours.
      sides.set(idx, by > nc ? 'south' : 'north');
    } else if (Math.abs(by - centroidY) > GUARD) {
      // Branches are level (or absent) but the bus is clearly off-centre.
      sides.set(idx, by >= centroidY ? 'south' : 'north');
    }
    // else: no clear signal → omit → caller uses the kind default.
  }
  return sides;
}

/** The lines and transformers of `topology` as `assignBranchSides` takes them. */
export function branchEndsOf(topology: TopologySummary): BranchEnds[] {
  const out: BranchEnds[] = [];
  const collect = (entry: TopologyEntry, bucket: 'line' | 'transformer') => {
    const t = entryTerminals(entry);
    if (t) out.push({ id: `${bucket}-${String(entry.idx)}`, source: t.from, target: t.to });
  };
  for (const line of topology.lines) collect(line, 'line');
  for (const trafo of topology.transformers) collect(trafo, 'transformer');
  return out;
}

/**
 * `assignBranchSides` for every line and transformer of `topology`, keyed by
 * edge id (`buildGraph`'s `<bucket>-<idx>` convention). The auto-layout
 * declares its ports from this, so the routes it computes leave each bus
 * where the diagram will draw them leaving.
 *
 * Defensive against missing terminals or missing coords: such a branch has
 * no entry in the resulting map.
 */
export function computeHandleAssignments(
  topology: TopologySummary,
  coords: CoordsByIdx,
): { branches: Map<string, HandleAssignment> } {
  return { branches: assignBranchSides(branchEndsOf(topology), coords) };
}

/**
 * Optional inputs for `buildGraph`. `bendPoints` comes from ELK's
 * `result.edges[].sections[].bendPoints` or from a saved layout; without
 * it every branch is routed from where its two buses sit.
 */
export interface BuildGraphOptions {
  /**
   * Per-edge polyline coords: from ELK in the auto-layout case, or the
   * routes a saved layout holds. Includes the start and end points. The
   * diagram keeps the bends and lands the two ends on the bars
   * (`connections.ts`). An edge absent from this map is routed from where
   * its buses sit, and so is one whose polyline no longer fits its buses
   * (`routeFitsBuses`).
   */
  bendPoints?: Map<string, [number, number][]>;
  /**
   * The length a layout sets for a bus's bar, by bus idx (`barLengthsOf`).
   * A device that is placed here keeps to the bar as it will be drawn.
   */
  barLengths?: ReadonlyMap<string, number>;
  /**
   * Positions of controllers a saved layout places on their own, keyed
   * `${modelClass}|${idx}`. A controller absent from this map is docked
   * beside the device it references and follows it.
   */
  controllerCoords?: Map<string, BusCoord>;
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
 * A bus is as wide as its bar. A non-bus element is drawn in a box as wide
 * as its label (`deviceBoxSize`), and the 50×46 here is what it is taken
 * to be where no box is known. Exported so tests can assert deterministic
 * overlap math without re-deriving the constants.
 */
export const NODE_FOOTPRINT: Record<
  'bus' | 'generator' | 'load' | 'shunt',
  {
    width: number;
    height: number;
  }
> = {
  // Busbar footprint: as wide as the bar at its default length; height
  // reserves room for the bar plus the name/voltage label that hangs below
  // it so stacked buses don't collide labels.
  bus: { width: BAR_LENGTH, height: 44 },
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
 * How far outside its bus's footprint (px) the end of a stored route may
 * sit and still count as being at that bus. ELK ends a route on the
 * boundary of the bus's box, inside the footprint; the slack is for a
 * router that lands a hair outside it.
 */
const ROUTE_END_TOLERANCE = 12;

function routeEndsAtBus(point: [number, number], bus: { x: number; y: number }): boolean {
  const { width, height } = NODE_FOOTPRINT.bus;
  return (
    point[0] >= bus.x - ROUTE_END_TOLERANCE &&
    point[0] <= bus.x + width + ROUTE_END_TOLERANCE &&
    point[1] >= bus.y - ROUTE_END_TOLERANCE &&
    point[1] <= bus.y + height + ROUTE_END_TOLERANCE
  );
}

/**
 * Whether a polyline computed for a branch still belongs on it: its two ends
 * sit at the branch's buses where the layout has them (`coord`), and neither
 * bus has been moved since (`moved`). A route is a list of fixed
 * points, so a bus that moved would leave it hanging in mid-air, and a
 * route stored for an idx that now names a branch between other buses (the
 * element was deleted and another added) would be drawn across the
 * diagram. Either way the branch goes back to routing that follows the
 * live node positions.
 */
export function routeFitsBuses(
  polyline: [number, number][],
  from: { coord: { x: number; y: number } | undefined; moved: boolean },
  to: { coord: { x: number; y: number } | undefined; moved: boolean },
): boolean {
  const first = polyline[0];
  const last = polyline[polyline.length - 1];
  if (polyline.length < 2 || first === undefined || last === undefined) return false;
  if (from.coord === undefined || to.coord === undefined || from.moved || to.moved) return false;
  return routeEndsAtBus(first, from.coord) && routeEndsAtBus(last, to.coord);
}

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
  parentBus: PushOutNode | null = null,
): { x: number; y: number } {
  if (b.kind === 'bus') return { x: b.x, y: b.y }; // Defensive — never push buses.
  // A generator / load overlapping a NON-parent bus: slide it LATERALLY
  // along its own (horizontal N/S) bus face to dodge the obstacle, rather
  // than ejecting it perpendicular — a perpendicular push travels PAST the
  // obstructing bus and leaves a long stub crossing the diagram, whereas a
  // lateral slide keeps the device at its short offset with a clean
  // perpendicular stub. Direction = away from the obstacle's centre.
  if (a.kind === 'bus' && (b.kind === 'generator' || b.kind === 'load')) {
    const sign = b.x >= a.x ? 1 : -1;
    const nx = b.x + sign * (overlap.dx + PUSH_OUT_SAFETY_GAP);
    if (bound !== null && (nx < bound.minX || nx > bound.maxX)) {
      // No lateral room — fall back to pushing along the stub axis, away
      // from the parent bus so the device still doesn't cross its own bar.
      const ySign = parentBus !== null ? (b.y >= parentBus.y ? 1 : -1) : b.y >= a.y ? 1 : -1;
      return { x: b.x, y: b.y + ySign * (overlap.dy + PUSH_OUT_SAFETY_GAP) };
    }
    return { x: nx, y: b.y };
  }
  const baseDir = PUSH_DIR_FOR_KIND[b.kind];
  // Orient a vertical push AWAY from the parent bus. Generators/loads now
  // hang off whichever face points away from the network (see
  // `computeDeviceVerticalSides`), so a fixed north/south push could shove
  // a device straight across the bar it's wired to and into the diagram
  // (a slack machine on a bottom bus was ejected up through its own
  // feeder). Pushing away from the bus keeps the device on its side. For
  // the default placements (north generator / south load) this resolves to
  // the original sign, so existing layouts are unchanged.
  const dir: PushDirSpec =
    baseDir.axis === 'y' && parentBus !== null
      ? { ...baseDir, sign: b.y >= parentBus.y ? 1 : -1 }
      : baseDir;
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
  const busById = new Map(buses.map((bus) => [bus.id, bus] as const));
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
        const parentBus = b.parentBusId !== null ? (busById.get(b.parentBusId) ?? null) : null;
        const next = shiftAwayFrom(a, b, overlap, bound, parentBus);
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
 * How far above or below its bus (origin to origin) a device is put when
 * the layout does not place it.
 *
 * Tuned to keep two vertically-adjacent buses (e.g., IEEE 14's BUS5 at
 * y=250 and BUS6 at y=400, only 150 px apart) from having their devices
 * collide: BUS5's south child lands at 320 and BUS6's north child at 330,
 * and the row-parity column offset below puts the two side by side.
 */
export const DEVICE_ROW_OFFSET = 70;

/**
 * How far from the middle of its bar the first device of a face stands by
 * default: over one third of the bar or the other, by the parity of the
 * bus's row (`Math.round(busY / 100)`). That leaves the middle of the bar,
 * where a single branch lands, free, and puts the devices of two buses that
 * sit one above the other in different columns.
 */
export const DEVICE_COLUMN_OFFSET = 33;

/**
 * The gap a device keeps to a branch that lands on its side of the bar, and
 * to the next device.
 */
export const DEVICE_COLUMN_GAP = 8;

/**
 * The box a device node is drawn in, worked out from the label under its
 * glyph (9 px monospace, a 24 px glyph, the node's padding and border). It
 * is what places a device over its column before React Flow has measured
 * it, and the size hint the node carries until then.
 */
export function deviceBoxSize(label: string): { width: number; height: number } {
  return { width: Math.round(Math.max(24, 5.4 * label.length) + 14), height: 41 };
}

/**
 * How many pixels of distance from its column a device gives up to stand one
 * pixel less past a tip.
 */
const PAST_TIP_COST = 4;

/** Something that stands on a face of a bar: `half` either side of `x`. */
export interface Column {
  x: number;
  half: number;
}

/**
 * The x nearest to `preferred` at which a box `half` wide either side
 * stands `DEVICE_COLUMN_GAP` clear of everything in `taken`. A place over
 * the bar (`[lo, hi]`) is one the connector drops square onto the bar from,
 * so each pixel past a tip counts as several of distance, and of two places
 * that come out equal the one closer to `middle` is taken.
 */
export function freeColumn(
  preferred: number,
  half: number,
  taken: readonly Column[],
  lo: number,
  hi: number,
  middle: number,
): number {
  const reach = (c: Column): number => c.half + half + DEVICE_COLUMN_GAP;
  const fits = (x: number): boolean => taken.every((c) => Math.abs(x - c.x) >= reach(c) - 1e-6);
  // Beside each thing in the way is the nearest free place on that side of it.
  const candidates = [preferred, ...taken.flatMap((c) => [c.x - reach(c), c.x + reach(c)])];
  const cost = (x: number): number =>
    Math.abs(x - preferred) + PAST_TIP_COST * Math.max(0, lo - x, x - hi);
  let best = preferred;
  let bestCost = Infinity;
  for (const x of candidates) {
    if (!fits(x)) continue;
    const c = cost(x);
    const tie = Math.abs(c - bestCost) < 1e-6;
    if (c < bestCost - 1e-6 || (tie && Math.abs(x - middle) < Math.abs(best - middle))) {
      best = x;
      bestCost = c;
    }
  }
  return best;
}

/** React Flow node-type strings for the non-bus kinds. Mirrors `NODE_TYPES`. */
const NON_BUS_NODE_TYPE = {
  generator: 'generator',
  load: 'load',
  shunt: 'shunt',
} as const;

/** The face of a device that looks at the given face of its bus. */
const FACING: Record<Side, Side> = {
  north: 'south',
  east: 'west',
  south: 'north',
  west: 'east',
};

/** The face of its bus each kind hangs off when nothing says otherwise. */
const BUS_SIDE_FOR_KIND: Record<'generator' | 'load' | 'shunt', 'north' | 'south'> = {
  generator: 'north',
  load: 'south',
  shunt: 'south',
};

interface NonBusBucket {
  entries: readonly TopologyEntry[];
  /** Resolves the parent-bus idx for an entry; returns `null` if missing. */
  parentBus: (entry: TopologyEntry) => string | null;
  kind: 'generator' | 'load' | 'shunt';
}

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

/**
 * Which generator node prints each row of the PF result's
 * `generator_outputs`, as `entry -> row key`; a node absent from the map
 * prints nothing. A machine reads the row of the static generator it names
 * in `gen` (`generatorRowKey`). When both are drawn (ieee14_full numbers its
 * machines GENROU_1..5, so PV 2 and GENROU_2 both stand on bus 2) printing
 * the row on each would show one injection twice. The machine prints it: it
 * is the node a time-domain run drives and the controllers dock to. The
 * static generator it names stays quiet, and one that no drawn machine names
 * prints its own row.
 */
function assignGeneratorRows(entries: readonly TopologyEntry[]): Map<TopologyEntry, string> {
  const rows = new Map<TopologyEntry, string>();
  const claimed = new Set<string>();
  for (const e of entries) {
    if (!DYNAMIC_GENERATOR_KINDS.has(e.kind)) continue;
    const key = generatorRowKey(e);
    // Two machines naming one generator: the first prints its row.
    if (claimed.has(key)) continue;
    claimed.add(key);
    rows.set(e, key);
  }
  for (const e of entries) {
    if (DYNAMIC_GENERATOR_KINDS.has(e.kind)) continue;
    const key = generatorRowKey(e);
    if (!claimed.has(key)) rows.set(e, key);
  }
  return rows;
}

function _busFromParam(entry: TopologyEntry, key: string): string | null {
  const params = entry.params;
  if (!params) return null;
  const value = params[key];
  if (value === undefined || typeof value === 'boolean') return null;
  return String(value);
}

/**
 * The accessible name of an element: `Bus BUS1 (idx 1)`, the words the right-click
 * menu's title uses. The idx follows when the name differs from it, because the
 * forms and the API use the idx while the diagram prints the name.
 */
function elementAriaLabel(noun: string, idx: string, name: unknown): string {
  const label = typeof name === 'string' && name !== '' ? name : idx;
  return label !== idx ? `${noun} ${label} (idx ${idx})` : `${noun} ${idx}`;
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
  const unrated = unratedBusIdx(topology);
  const nodes: Node[] = topology.buses.map((b) => {
    const idx = String(b.idx);
    const c = coords[idx] ?? { x: 0, y: 0 };
    const kv = entryBaseKv(b, unrated);
    return {
      id: idx,
      type: 'bus',
      ariaLabel: elementAriaLabel('Bus', idx, b.name),
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
        voltageLimits: busVoltageLimits(b),
        ...(kv === null ? {} : { baseKv: kv }),
      },
    } satisfies Node;
  });

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
    // A polyline was computed for where its two buses sat. If the user has
    // since moved either one (a drag override that differs from the layout
    // coord; the canvas records an override for every node at the end of any
    // drag, so the mere presence of one says nothing), or its ends are not at
    // these buses at all, it would render disconnected, floating in space.
    // Drop it so the branch is routed from tap to tap, which follows the
    // live node positions.
    const movedByDrag = (busId: string): boolean => {
      const override = branchDragOverrides[busId];
      const laidOut = coords[busId];
      return (
        override !== undefined &&
        (laidOut === undefined || override.x !== laidOut.x || override.y !== laidOut.y)
      );
    };
    const candidate = bends.get(id);
    const polyline =
      candidate !== undefined &&
      routeFitsBuses(
        candidate,
        { coord: coords[t.from], moved: movedByDrag(t.from) },
        { coord: coords[t.to], moved: movedByDrag(t.to) },
      )
        ? candidate
        : undefined;
    // Transformers always render via TransformerEdge (which carries the
    // 2W/3W icon at the midpoint), with a stored route or without one. A
    // line says by its type whether it keeps one.
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
      ariaLabel: `${elementAriaLabel(
        kindLabel === 'transformer' ? 'Transformer' : 'Line',
        String(entry.idx),
        entry.name,
      )}, bus ${t.from} to bus ${t.to}`,
      type: edgeType,
      data: {
        idx: String(entry.idx),
        name: entry.name,
        kind: entry.kind,
        bucket: kindLabel,
        bendPoints: polyline,
        // Where the two buses sat when the polyline was found to fit them.
        // The diagram draws it only while they are still there, so a bus
        // that is being dragged takes its branches along at once.
        bendAnchors:
          polyline === undefined
            ? undefined
            : { source: { ...coords[t.from]! }, target: { ...coords[t.to]! } },
        // Transformer-specific: 3-winding fallback gets a "3w" badge
        // overlaid on the 2-winding glyph (per Scope Boundaries).
        winding: detectWinding(entry),
      },
    });
  };
  for (const line of topology.lines) pushBranchEdge(line, 'line');
  for (const trafo of topology.transformers) pushBranchEdge(trafo, 'transformer');

  // Non-bus nodes (generators, loads, shunts). Each hangs off a face of
  // its parent bus: where the saved layout or a drag put it, or else over a
  // free part of the bar.
  const generatorEntries = dedupeGeneratorsByIdx(topology.generators ?? []);
  const generatorRows = assignGeneratorRows(generatorEntries);
  const nonBusBuckets: NonBusBucket[] = [
    {
      entries: generatorEntries,
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

  // Device placement side (see `computeDeviceVerticalSides`). A device
  // hangs off the bus on the vertical face pointing AWAY from the bus's
  // branch neighbours, so the slack machine on a bottom bus sits BELOW it
  // (not shooting up through the network). Computed against the effective
  // coords (drag overrides folded in), which is where the bars are.
  const effCoords: CoordsByIdx =
    Object.keys(branchDragOverrides).length === 0
      ? coords
      : (() => {
          const merged: CoordsByIdx = { ...coords };
          for (const [id, pos] of Object.entries(branchDragOverrides)) {
            if (merged[id] !== undefined) merged[id] = pos;
          }
          return merged;
        })();
  const deviceSides = computeDeviceVerticalSides(topology, effCoords);

  // Where the branches land on each bar, from a pass over the buses and the
  // branches alone: a device that is placed here stands clear of them.
  const branchBars = layoutConnections(
    nodes.map((n) => ({ ...n, position: effCoords[n.id] ?? n.position })),
    edges,
    { barLengths: opts.barLengths },
  ).bars;

  // What stands on each face of each bar (`<bus>|<face>`): the branches
  // that land there, the devices the layout or a drag put there, and the
  // devices placed here so far.
  const columns = new Map<string, Column[]>();
  const columnsOf = (busIdx: string, face: 'north' | 'south', busX: number): Column[] => {
    const key = `${busIdx}|${face}`;
    let list = columns.get(key);
    if (list === undefined) {
      list = (branchBars.get(busIdx)?.taps ?? [])
        .filter((tap) => tap.side === face)
        .map((tap) => ({ x: busX + tap.x, half: 0 }));
      columns.set(key, list);
    }
    return list;
  };

  interface PendingDevice {
    entry: TopologyEntry;
    kind: 'generator' | 'load' | 'shunt';
    nodeId: string;
    parentIdx: string;
    /** Where the bus sits now: its drag override, or its layout coord. */
    parentCoord: { x: number; y: number };
    size: { width: number; height: number };
    /** Set once the device has its place. */
    position?: { x: number; y: number };
    face?: 'north' | 'south';
  }
  const pending: PendingDevice[] = [];
  // Devices whose position comes from the saved layout. That is where they
  // were when the layout was written, so the push-out pass leaves them there.
  const placedByLayout = new Set<string>();
  for (const bucket of nonBusBuckets) {
    for (const entry of bucket.entries) {
      const parentIdx = bucket.parentBus(entry);
      if (parentIdx === null) {
        // A dynamic load (ANDES's ZIP) has no bus: it is the model of the
        // static load it names (`pq`), and that load is the one drawn.
        if (bucket.kind === 'load' && entry.params?.pq !== undefined) continue;
        // Defensive: an orphan element with no parent bus shouldn't
        // happen with a valid topology. Skip + warn.
        console.warn(`SLD: ${bucket.kind} ${String(entry.idx)} has no parent bus; skipping`);
        continue;
      }
      // Anchor devices to the bus's *effective* position: when the user
      // drags a bus, its drag override (not the stale auto-layout coord)
      // is where the bar now sits, so its generators/loads/shunts must
      // follow it. Without this, moving a bus strands its devices at the
      // old grid position, and they scatter off-canvas.
      const parentCoord = effCoords[parentIdx];
      if (!parentCoord) {
        console.warn(
          `SLD: ${bucket.kind} ${String(entry.idx)} references missing bus ${parentIdx}; skipping`,
        );
        continue;
      }
      const nodeId = `${bucket.kind}-${String(entry.idx)}`;
      const size = deviceBoxSize(entry.name || String(entry.idx));
      const device: PendingDevice = {
        entry,
        kind: bucket.kind,
        nodeId,
        parentIdx,
        parentCoord,
        size,
      };
      // Prefer the exact model-class match (`PV|1`); fall back to the
      // UI-category key (`generator|1`) so a sidecar that was saved
      // before a kind-edit still resolves the dragged coord. The dual-
      // key shape is documented in `sidecar.ts.buildNonBusCoordinates`.
      const modelKey = `${entry.kind}|${String(entry.idx)}`;
      const categoryKey = `${bucket.kind}|${String(entry.idx)}`;
      const sidecar = nonBusCoords.get(modelKey) ?? nonBusCoords.get(categoryKey);
      if (sidecar !== undefined) placedByLayout.add(nodeId);
      // A device that already has a place, from the layout or from a drag
      // (the canvas puts the override on top of whatever is built here),
      // stands where it is, and the ones placed below keep clear of it.
      const fixed = branchDragOverrides[nodeId] ?? sidecar;
      if (fixed !== undefined) {
        const built = sidecar ?? fixed;
        device.position = { x: built.x, y: built.y };
        const above = fixed.y + size.height / 2 <= parentCoord.y + BAR_THICKNESS / 2;
        device.face = above ? 'north' : 'south';
        columnsOf(parentIdx, device.face, parentCoord.x).push({
          x: fixed.x + size.width / 2,
          half: size.width / 2,
        });
      }
      pending.push(device);
    }
  }

  // The rest take the free place nearest their column: over the bar where
  // there is room, so the connector drops square onto it, and beside what
  // is already there otherwise.
  for (const device of pending) {
    if (device.position !== undefined) continue;
    const { parentIdx, parentCoord, size } = device;
    const face = deviceSides.get(parentIdx) ?? BUS_SIDE_FOR_KIND[device.kind];
    const bar = branchBars.get(parentIdx);
    const middle = parentCoord.x + BAR_LENGTH / 2;
    // Where a connector can land on this face of the bar.
    const span = bar ? faceSpan(bar) : { lo: TAP_INSET, hi: BAR_LENGTH - TAP_INSET };
    const lo = parentCoord.x + span.lo;
    const hi = parentCoord.x + span.hi;
    // Two buses one above the other put their devices in different columns.
    const rowParity = Math.round(parentCoord.y / 100) % 2 === 0 ? 1 : -1;
    const taken = columnsOf(parentIdx, face, parentCoord.x);
    const preferred = Math.min(hi, Math.max(lo, middle + rowParity * DEVICE_COLUMN_OFFSET));
    const x = freeColumn(preferred, size.width / 2, taken, lo, hi, middle);
    taken.push({ x, half: size.width / 2 });
    device.face = face;
    device.position = {
      x: x - size.width / 2,
      y: parentCoord.y + (face === 'north' ? -DEVICE_ROW_OFFSET : DEVICE_ROW_OFFSET),
    };
  }

  for (const device of pending) {
    const { entry, kind, nodeId, parentIdx, size } = device;
    const face = device.face!;
    const deviceLabel = elementAriaLabel(
      kind.charAt(0).toUpperCase() + kind.slice(1),
      String(entry.idx),
      entry.name,
    );
    // The row of the PF result this node prints, or null when another
    // node prints it (see `assignGeneratorRows`).
    const pflowIdx = kind === 'generator' ? (generatorRows.get(entry) ?? null) : String(entry.idx);
    nodes.push({
      id: nodeId,
      type: NON_BUS_NODE_TYPE[kind],
      ariaLabel: deviceLabel,
      position: device.position!,
      // Pre-measure size hint so RF v12 draws a MiniMap rect; see the
      // bus-node note above. Dropped once the device glyph is measured.
      initialWidth: size.width,
      initialHeight: size.height,
      data: {
        idx: String(entry.idx),
        name: entry.name,
        kind: entry.kind,
        parentBus: parentIdx,
        pflowIdx,
      },
    } satisfies Node);
    // Stub edge from the non-bus node to its bus. The handles are the ones
    // of where the device was built (beside a face of its bus); where the
    // connector really leaves the device and lands on the bar is worked out
    // from where the two sit (`connections.ts`), and follows a drag.
    const stubId = `stub-${nodeId}`;
    edges.push({
      id: stubId,
      ariaLabel: `${deviceLabel}, connection to bus ${parentIdx}`,
      source: nodeId,
      sourceHandle: DEVICE_PORT[FACING[face]],
      target: parentIdx,
      targetHandle: TARGET_HANDLE[face],
      type: 'stub',
      data: {
        kind: entry.kind,
        bucket: kind,
      },
    });
  }

  // Collision push-out (Unit 3, v0.1.y). Runs after the kind-based
  // fan-stack emission and any sidecar overrides have placed every
  // non-bus node. Pre-applies drag overrides so the user's chosen
  // position is treated as stationary; other nodes shift around them.
  // A position the saved layout holds is stationary too: it is where the
  // device was when the layout was written, overlapping a neighbour or
  // not, and shifting it would reopen the diagram differently from how it
  // was saved. Only a device the layout does not place (one added since)
  // is moved out of the way.
  const applyPushOut = opts.applyPushOut ?? true;
  if (applyPushOut) {
    const dragOverrides = opts.dragOverrides ?? {};
    const lockedIds = new Set([...Object.keys(dragOverrides), ...placedByLayout]);
    // Build the push-out input. Each non-bus node carries its parent
    // bus id so the push-out skips the parent collision (a generator
    // touching the north face of its bus is the design, not a bug). The
    // push-out works on boxes about their middle, and a node's position is
    // its top-left corner, so each goes in by the middle of its box: the
    // bar with its label for a bus, the box the device is drawn in for a
    // device.
    const boxOf = (n: Node): { width: number; height: number } =>
      n.type === 'bus'
        ? NODE_FOOTPRINT.bus
        : {
            width: n.initialWidth ?? NODE_FOOTPRINT.generator.width,
            height: n.initialHeight ?? NODE_FOOTPRINT.generator.height,
          };
    const pushInputs = nodes.map((n) => {
      const override = dragOverrides[n.id];
      const footprint = boxOf(n);
      const x = (override?.x ?? n.position.x) + footprint.width / 2;
      const y = (override?.y ?? n.position.y) + footprint.height / 2;
      const kind: 'bus' | 'generator' | 'load' | 'shunt' =
        n.type === 'bus' || n.type === 'generator' || n.type === 'load' || n.type === 'shunt'
          ? n.type
          : 'bus';
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
      const middle = resolved.get(n.id);
      const input = pushInputs[i]!;
      if (!middle) continue;
      // A node the pass left alone keeps its position to the last bit: a
      // round trip through the middle of its box would not give it back.
      const stayed = middle.x === input.x && middle.y === input.y;
      const override = dragOverrides[n.id];
      const next = stayed
        ? (override ?? n.position)
        : { x: middle.x - input.width / 2, y: middle.y - input.height / 2 };
      if (next.x === n.position.x && next.y === n.position.y) continue;
      nodes[i] = { ...n, position: { x: next.x, y: next.y } };
    }
  }

  // The side of a generator / load its P / Q readout hangs off: the side
  // facing its bus, the strip the stub runs through and the default offsets
  // leave clear. It is judged by where the device finally sits (push-out and
  // drag overrides applied) and not by the bus face its stub targets, so a
  // device the user moved across its bus keeps the readout between the two.
  const busPositions = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    if (n.type === 'bus') busPositions.set(n.id, branchDragOverrides[n.id] ?? n.position);
  }
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]!;
    if (n.type !== 'generator' && n.type !== 'load') continue;
    const parent = busPositions.get((n.data as { parentBus: string }).parentBus);
    if (parent === undefined) continue;
    const at = branchDragOverrides[n.id] ?? n.position;
    nodes[i] = { ...n, data: { ...n.data, valueSide: at.y < parent.y ? 'below' : 'above' } };
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
  appendControllerNodes(nodes, topology.controllers ?? [], opts.controllerCoords);

  return { nodes, edges };
}

/**
 * Box (px) of the P / Q readout a generator or load carries after a power
 * flow (`DeviceValueLabel`): two 10 px lines and the 2 px gap to the node, as
 * wide as the longest value the diagram shows ("-1575.0 MVAr": 12 characters
 * of 9 px mono plus padding). It hangs on the side of its node facing the
 * bus, in the strip between the two (`DEVICE_ROW_OFFSET` leaves 24 px of it
 * beyond the footprint), where only the stub runs. The node's far side
 * is where the controller badges and the neighbouring buses and devices crowd
 * in.
 */
export const DEVICE_VALUE_LABEL = { width: 72, height: 22 } as const;

/**
 * Docked offset of a controller badge from its parent device's origin. The
 * badge sits past the right edge of the node's readout (`DEVICE_VALUE_LABEL`,
 * centred on the node), so the two never share a strip, whichever face of its
 * bus the machine hangs off.
 */
export const CONTROLLER_DOCK = { x: 64, y: -18, stackDy: 22 } as const;

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
 * Append a badge node for each controller in `controllers`, mutating `nodes`
 * in place. A controller is docked beside the device it references, unless
 * `placedCoords` (a saved layout) puts it somewhere of its own. Iterative
 * passes resolve controller→controller reference chains; anything still
 * unresolved after the passes (a dangling idx) is placed as an orphan.
 */
function appendControllerNodes(
  nodes: Node[],
  controllers: readonly TopologyEntry[],
  placedCoords: ReadonlyMap<string, BusCoord> = new Map(),
): void {
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
    // A controller the layout places takes no slot in its parent's dock
    // stack, so the docked ones beside it close up.
    const placedAt = placedCoords.get(`${entry.kind}|${idx}`);
    const stackKey = parent ? parentId! : '__orphan__';
    const stackIndex = stackCounts.get(stackKey) ?? 0;
    if (placedAt === undefined) stackCounts.set(stackKey, stackIndex + 1);

    let position: { x: number; y: number };
    if (placedAt !== undefined) {
      position = { x: placedAt.x, y: placedAt.y };
    } else if (parent) {
      position = {
        x: parent.position.x + CONTROLLER_DOCK.x,
        y: parent.position.y + CONTROLLER_DOCK.y + stackIndex * CONTROLLER_DOCK.stackDy,
      };
    } else {
      position = { x: 24, y: 24 + stackIndex * CONTROLLER_DOCK.stackDy };
    }
    // Vector (controller origin → parent origin) so ControllerNode can
    // draw an exact tether back to the device, wherever the badge sits.
    const connectorDx = parent ? parent.position.x - position.x : 0;
    const connectorDy = parent ? parent.position.y - position.y : 0;

    const node: Node = {
      id: nodeId,
      type: 'controller',
      position,
      // Pre-measure size hint so RF v12 draws a MiniMap rect; see the
      // bus-node note above. `NODE_FOOTPRINT` has no controller entry, so
      // approximate the small badge glyph with a 28×28 box.
      initialWidth: CONTROLLER_GLYPH_FOOTPRINT,
      initialHeight: CONTROLLER_GLYPH_FOOTPRINT,
      // Badges aren't free-dragged: a docked one follows its parent device,
      // and one the layout places stays where the layout has it.
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
        // Set only for a badge the layout places, so a capture of the
        // diagram keeps its entry and writes none for a docked one.
        ...(placedAt !== undefined ? { placed: true } : {}),
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
