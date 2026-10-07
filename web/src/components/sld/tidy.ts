/**
 * Tidy: route every line and transformer of the diagram afresh, with the
 * buses and the devices where they are.
 *
 * The connection pass (`connections.ts`) draws a branch that has no stored
 * route from tap to tap, half way between its two bars, and keeps the bends
 * of one that has. Neither looks at what is in between, so on a diagram
 * arranged by hand a line runs through a generator, along the bar of a bus
 * it has nothing to do with, or on top of the line beside it. `tidyRoutes`
 * works the routes out together, on a grid, and hands back one polyline per
 * branch, which the diagram then keeps as that branch's stored route.
 *
 * What a tidied route keeps to:
 *
 * - It runs at right angles, along the lines of a grid `GRID_STEP` apart,
 *   which is also the grid a node snaps to. Where a diagram leaves less
 *   room than that, it may also run along a line that just clears what
 *   stands there: `DEVICE_CLEARANCE` beside a device, `RUN_CLEARANCE` over
 *   or under a bar, `SLIDE_CLEARANCE` past its tip. And it may run along
 *   the line of its own bar from a tip of that bar, which is how two buses
 *   that stand level are joined end to end.
 * - It leaves a bar by a face, at a tap of its own, or by a free end. A tap
 *   keeps `TAP_SPACING` from the taps the devices of the bus have and from
 *   the other branches of that face, so the connection pass leaves it where
 *   it is: what `tidyRoutes` answers is what gets drawn.
 * - It keeps clear of every generator, load and shunt, of the line of a bar
 *   it is not connected to, of the label of every bus but its own two
 *   (which it only passes on its way out of the south face), and of the
 *   badges and the control chains that are drawn out.
 * - No two routes share a run or run closer than `NEAR_LINE` side by side,
 *   none turns on another, and none passes through the corner of another:
 *   where two meet, they cross at a right angle. A crossing costs as much
 *   as a detour of `CROSS_COST`, and a bend as much as one of `BEND_COST`,
 *   so a route takes the way with the fewest of both that is not much
 *   longer. A device connector counts as a route that is already there.
 * - A bus with more branches on a face than its bar has room for gets a
 *   tap past the tip, up to `MAX_OVERHANG`, where nothing stands in the
 *   way; the bar is drawn out to it.
 * - It leaves every generator and load a place for its values where it can
 *   (`TidyOptions.keepFree`): the P / Q readout a power flow adds stands
 *   beside the connector of its device, on one side or the other, or on
 *   the far side of the device, and a route that would run through the last
 *   of those places goes a long way round first (`LAST_PLACE_COST`).
 *
 * The branches are routed one after the other, the shortest first, each
 * around the ones before it (A* over the grid, with the direction of travel
 * as part of the state so a bend can be priced). Then each is taken out and
 * routed again around all the others, twice, which lets an early one give
 * way to those that came later; two routes that cross are routed again
 * together, in both orders; and the routes around a device that was left
 * without a place for its values are routed again together with one of its
 * places shut. The same input gives the same routes.
 *
 * The work is bounded. It is counted in steps of the search (`TIDY_STEPS`),
 * so a large diagram is routed as well as the steps allow and no longer,
 * and the grid has a most points (`GRID_POINTS`), so one that spreads over
 * a great deal of room is routed on a coarser grid or not at all
 * (`TidyResult.tooLarge`).
 *
 * Nothing is moved here. `alignToGrid` is the part of "Tidy and re-layout"
 * that does move the buses: onto the grid, and into line with the ones they
 * are nearly level or nearly in a column with.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  RUN_CLEARANCE,
  SLIDE_CLEARANCE,
  TAP_INSET,
  TAP_SPACING,
  faceSpan,
  layoutConnections,
  simplifyRoute,
  type ConnectionEdge,
  type ConnectionNode,
  type ConnectionOptions,
  type Point,
  type Rect,
} from './connections';
import type { Side } from './sides';

/**
 * The step of the diagram's grid: the dots of the background, the places a
 * node snaps to, and the lines a tidied route runs along. Two routes side
 * by side are this far apart, which is more than `TAP_SPACING`, so their
 * taps never crowd each other on a bar.
 */
export const GRID_STEP = 16;

/** What a bend costs, as a length of route. */
export const BEND_COST = 30;

/** What crossing another route or a device connector costs, as a length of route. */
export const CROSS_COST = 120;

/**
 * How far past the tip of its bar a tap may stand; the bar is drawn out to
 * it. Room for four taps on the grid: a bar that has a load and a generator
 * on a face often has its lines leave beside them, past the tip.
 */
export const MAX_OVERHANG = 4 * GRID_STEP;

/** The gap a route keeps to a generator, load or shunt (`DEVICE_COLUMN_GAP` in `graph.ts`). */
export const DEVICE_CLEARANCE = 8;

/** Two runs side by side nearer than this would read as one line. */
export const NEAR_LINE = 10;

/**
 * What running through a place that is kept for the values of a device
 * costs, as a length of route (`TidyOptions.keepFree`). While the device has
 * another place that no route runs through, next to nothing: of two ways
 * alike the one that leaves it free is taken. Through the last one, as much
 * as crossing two lines: a route goes a long way round before it takes the
 * only place a device has left for its values.
 */
export const KEEP_FREE_COST = 2;
export const LAST_PLACE_COST = 2 * CROSS_COST;

/** The gap a route keeps to a controller badge and to a control chain that is drawn out. */
const BADGE_CLEARANCE = 4;

/** How far under the origin of a bus node its label reaches, with a voltage and an angle in it. */
const LABEL_BOTTOM = 48;

/** The room the label of a bus takes either side of its text. */
const LABEL_MARGIN = 4;

/** A grid point nearer than this to a device connector is on it. */
const WIRE_NEAR = 6;

/** What each pixel a tap stands off the middle of its bar costs: the tie-break between taps. */
const TAP_BIAS = 0.05;

/**
 * What a tap past the tip of its bar costs: more than two bends, so a bar
 * is drawn out only for a branch that has no good way from a tap on it.
 */
const OVERHANG_COST = 70;

/**
 * How much longer a run counts along a line that is not of the grid, so
 * that of two ways alike the one on the grid is taken.
 */
const OFF_GRID_COST = 1.1;

/**
 * The shortest run a route makes between two bends. The lines that just
 * clear a device can lie a pixel or two from a line of the grid, and a step
 * from one to the other would show as a kink.
 */
const MIN_RUN = 12;

/** How many grid steps around its two buses a route is first looked for in. */
const SEARCH_WINDOW = 12;

/** How many times each branch is routed again around the others, while there are steps left. */
const REFINE_PASSES = 2;

/** The most pairs of routes that cross that are routed again together. */
const PAIR_LIMIT = 200;

/**
 * The most routes that are routed again together to leave a device a place
 * for its values, and how far around its places the routes that go with
 * the ones through them are looked for.
 */
const GROUP_LIMIT = 5;
const GROUP_REACH = 3 * GRID_STEP;

/**
 * How much work one call does, counted in steps of the search (a state taken
 * off the frontier, about a microsecond of a desktop's time): a search that
 * has to cross other routes looks at every way round them first, which on a
 * diagram of a hundred buses is tens of thousands of steps for one branch.
 * Counted in steps and not in time, the same diagram is routed the same on
 * any machine.
 *
 * The first routing of the branches shares half of it, each search getting
 * an even part of what is left (`SEARCH_STEPS` at the least). A search that
 * runs out before it has a way makes for the goal (`HURRY`) and takes the
 * first way it finds (within `HURRY_STEPS`, and as many again as cross the
 * stretch it looks in). Routing each branch again, the pairs that cross and
 * the routes around a device go on while there are steps left, and a search
 * that runs out there leaves the route as it was. Past twice the budget
 * nothing more is routed, and the branches that have no route by then are
 * left to the connection pass (`TidyResult.outOfSteps`). A diagram of the
 * size of the example cases uses a few hundredths of it, and one of a
 * hundred buses all of it, which is about a second.
 */
export const TIDY_STEPS = 750_000;
const SEARCH_STEPS = 1_000;
const HURRY = 32;
const HURRY_STEPS = 4_000;

/**
 * The most points the grid has. A diagram past it is routed without the
 * lines that just clear a device, on the grid and the lines of the bars
 * alone; past it still, on a grid twice or four times as wide; and one that
 * is too large even so is not routed (`TidyResult.tooLarge`). The search
 * keeps some fifty bytes for each point.
 */
export const GRID_POINTS = 1_000_000;

/**
 * How far from everything that stands on the diagram the lines of the grid
 * go on. A stretch further than that from any bus or device, along either
 * axis, has no lines in it: a route crosses it in one run, on a line that
 * has something at one of its ends, so a bus that stands far off does not
 * make the grid as large as the room in between.
 */
const GRID_REACH = (SEARCH_WINDOW + 6) * GRID_STEP;

/** The box a device is taken to have when it carries no size hint. */
const DEVICE_SIZE = { width: 40, height: 41 };

/** Two coordinates closer than this are the same place (as in `connections.ts`). */
const EPS = 0.5;

/** A node as `tidyRoutes` reads it: what the connection pass reads, and the name of a bus. */
export interface TidyNode extends ConnectionNode {
  data?: Record<string, unknown>;
}

export interface TidyOptions extends ConnectionOptions {
  /** What else stands on the diagram and is no node: a control chain that is drawn out. */
  obstacles?: readonly Rect[];
  /**
   * The places to keep free of routes, device by device: where the P / Q
   * readout of each generator and load can stand once a power flow has run
   * (beside its connector, on one side or the other, or on the far side of
   * the device). The routes leave each device one of its places where they
   * can (`LAST_PLACE_COST`).
   */
  keepFree?: readonly (readonly Rect[])[];
  /** How many steps the search may take; default `TIDY_STEPS`. */
  steps?: number;
}

export interface TidyResult {
  /**
   * The route of each branch, by edge id: the points it is drawn through,
   * from its tap on the bar of its source to its tap on the bar of its
   * target.
   */
  routes: Map<string, Point[]>;
  /**
   * The branches that have no route: no way was found for them, or the work
   * ran out before their turn came (`outOfSteps`, `tooLarge`). They are left
   * to the connection pass.
   */
  unrouted: string[];
  /** How many steps the search took (`TIDY_STEPS`). */
  steps: number;
  /** Set when some branch was not routed because the steps ran out. */
  outOfSteps?: true;
  /** Set when the diagram is too large to route at all (`GRID_POINTS`). */
  tooLarge?: true;
}

/** Direction of travel: along a row, or along a column. */
const H = 0;
const V = 1;

/** What a line of the grid is: of the grid proper, one that clears something, or the line of a bar. */
type LineKind = 'grid' | 'aux' | 'bar';

/** The lines of the grid along one axis. */
interface Axis {
  /** Where each line is, in ascending order. */
  at: number[];
  kind: LineKind[];
  /** The other lines a run on each line would be taken for one line with. */
  near: number[][];
  /** How much a run along each line counts for each pixel. */
  cost: number[];
}

/** The lines `wanted`, in order, with the ones in one place made one. */
function axisOf(wanted: { at: number; kind: LineKind }[]): Axis {
  // Of two in one place the one of the grid stays, then the one any branch may use.
  const rank: Record<LineKind, number> = { grid: 0, aux: 1, bar: 2 };
  const sorted = [...wanted].sort((p, q) => p.at - q.at || rank[p.kind] - rank[q.kind]);
  const lines: { at: number; kind: LineKind }[] = [];
  for (const line of sorted) {
    const last = lines[lines.length - 1];
    if (last === undefined || line.at - last.at > EPS) lines.push({ ...line });
    else if (rank[line.kind] < rank[last.kind]) last.kind = line.kind;
  }
  const at = lines.map((line) => line.at);
  return {
    at,
    kind: lines.map((line) => line.kind),
    near: at.map((v, i) => {
      const near: number[] = [];
      for (let k = i - 1; k >= 0 && v - at[k]! < NEAR_LINE; k -= 1) near.push(k);
      for (let k = i + 1; k < at.length && at[k]! - v < NEAR_LINE; k += 1) near.push(k);
      return near;
    }),
    cost: lines.map((line) => (line.kind === 'aux' ? OFF_GRID_COST : 1)),
  };
}

/** The first line of `axis` at or after `v`. */
function lineFrom(axis: Axis, v: number): number {
  let first = 0;
  for (let last = axis.at.length; first < last; ) {
    const middle = (first + last) >> 1;
    if (axis.at[middle]! < v - 1e-9) first = middle + 1;
    else last = middle;
  }
  return first;
}

/** The last line of `axis` at or before `v`. */
function lineTo(axis: Axis, v: number): number {
  return lineFrom(axis, v + 2e-9) - 1;
}

interface Bus {
  id: string;
  index: number;
  /** Origin of the node, and the middle of its bar. */
  x: number;
  y: number;
  cx: number;
  cy: number;
  /**
   * The tips of the bar, and the first and the last place a face can have
   * a tap, as they are now: with the bar drawn out to the taps the routes
   * made so far have past its tips.
   */
  start: number;
  end: number;
  lo: number;
  hi: number;
  /** The same of the bar as it is drawn with its device taps alone. */
  drawn: { start: number; end: number; lo: number; hi: number };
  /** The row of the grid its bar lies on. */
  row: number;
  /** Where the connectors of its devices land, by face. */
  deviceTaps: Record<'north' | 'south', number[]>;
  /** Where the routes made so far land, by face. */
  taps: Record<'north' | 'south', number[]>;
  /** The ends a device connector runs into. */
  endDevice: Record<'east' | 'west', boolean>;
  /** The ends a route runs into, by the id of the route. */
  endRoute: Record<'east' | 'west', string | null>;
  /** The sides the bar is drawn out on for a tap past its tip, and the grid points that takes. */
  grown: Record<'east' | 'west', boolean>;
  grownOver: number[];
  /**
   * Set once a branch found no place left on the bar. An end takes one
   * branch and shuts the taps beside it and the room past it, so a bus with
   * more branches than that leaves room for has them all on its faces.
   */
  endsBarred: boolean;
}

/** One way a route can leave a bar. */
interface Terminal {
  /** The first grid point outside the bar, and the direction the route arrives there in. */
  node: number;
  dir: number;
  /** Where it lands on the bar. */
  tap: Point;
  side: Side;
  /** What it costs: the run from the tap to `node`, and how far off the middle the tap is. */
  cost: number;
  /** How far past the tip of the bar the tap stands; 0 for one on the bar. */
  over: number;
}

/** A route that was found. */
interface Found {
  cost: number;
  /** The grid points it runs through, from the one outside its source to the one outside its target. */
  nodes: number[];
  source: Terminal;
  target: Terminal;
  points: Point[];
}

interface Branch {
  edge: ConnectionEdge;
  a: Bus;
  b: Bus;
  found: Found | null;
}

/** The estimated cost of a state to a sixteenth, which is what two states are told apart by. */
const KEY_STEPS = 16;

/** What is ahead of a state, to a quarter, in the bits of its key under the estimated cost. */
const AHEAD_STEPS = 4;
const AHEAD_RANGE = 1 << 20;

/**
 * A binary heap of search states: the one with the least estimated cost
 * first, of those that cost the same the one with the least still ahead of
 * it, and of those the first pushed. So of the many ways that are equally
 * good across open ground the search follows one to its end and does not
 * widen them all a step at a time.
 *
 * What is pushed is kept in the order it came (`keys`, `states`, `costs`),
 * and the heap holds the places of the ones still in it, so moving one up or
 * down the heap moves a single number.
 */
class Frontier {
  /** The estimated cost and what is ahead, as one number in that order. */
  private keys = new Float64Array(1024);
  private states = new Int32Array(1024);
  /** What the state had cost when it was pushed. */
  private costs = new Float64Array(1024);
  private pushed = 0;
  private heap = new Int32Array(1024);
  /** How many times over what is ahead of a state counts in its estimate (`hurry`). */
  private weight = 1;
  /** How many states are in it. */
  size = 0;
  /** What the state last taken out had cost when it was pushed. */
  cost = 0;

  clear(): void {
    this.pushed = 0;
    this.size = 0;
    this.weight = 1;
  }

  /** `estimate` as the heap tells two estimates apart. */
  static rounded(estimate: number): number {
    return Math.round(estimate * KEY_STEPS) / KEY_STEPS;
  }

  private keyOf(cost: number, ahead: number): number {
    return (
      Math.round((cost + this.weight * ahead) * KEY_STEPS) * AHEAD_RANGE +
      Math.min(AHEAD_RANGE - 1, Math.round(ahead * AHEAD_STEPS))
    );
  }

  /** Whether the entry `p` is taken out before the entry `q`. */
  private before(p: number, q: number): boolean {
    return this.keys[p]! < this.keys[q]! || (this.keys[p]! === this.keys[q]! && p < q);
  }

  /** Put `entry` in the heap at `i` or above it, where it belongs. */
  private rise(i: number, entry: number): void {
    const heap = this.heap;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(entry, heap[parent]!)) break;
      heap[i] = heap[parent]!;
      i = parent;
    }
    heap[i] = entry;
  }

  /** Put `entry` in the heap at `i` or below it, where it belongs. */
  private sink(i: number, entry: number): void {
    const heap = this.heap;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.before(heap[child + 1]!, heap[child]!)) child += 1;
      if (!this.before(heap[child]!, entry)) break;
      heap[i] = heap[child]!;
      i = child;
    }
    heap[i] = entry;
  }

  /** Push `state`, reached at `cost` with at least `ahead` still to go. */
  push(cost: number, ahead: number, state: number): void {
    if (this.pushed === this.keys.length) {
      const room = 2 * this.keys.length;
      const grown = <T extends Float64Array | Int32Array>(held: T, made: T): T => {
        made.set(held);
        return made;
      };
      this.keys = grown(this.keys, new Float64Array(room));
      this.states = grown(this.states, new Int32Array(room));
      this.costs = grown(this.costs, new Float64Array(room));
      this.heap = grown(this.heap, new Int32Array(room));
    }
    const entry = this.pushed;
    this.pushed += 1;
    this.keys[entry] = this.keyOf(cost, ahead);
    this.states[entry] = state;
    this.costs[entry] = cost;
    this.size += 1;
    this.rise(this.size - 1, entry);
  }

  /**
   * Make for the goal: from here on what is ahead of a state counts `weight`
   * times over, so the states nearest the goal are taken up first whatever
   * they cost. `aheadOf` gives what is ahead of a state already here.
   */
  hurry(weight: number, aheadOf: (state: number) => number): void {
    this.weight = weight;
    for (let i = 0; i < this.size; i += 1) {
      const entry = this.heap[i]!;
      this.keys[entry] = this.keyOf(this.costs[entry]!, aheadOf(this.states[entry]!));
    }
    for (let i = (this.size >> 1) - 1; i >= 0; i -= 1) this.sink(i, this.heap[i]!);
  }

  /** The least estimated cost, without taking its state out. */
  peek(): number {
    return Math.floor(this.keys[this.heap[0]!]! / AHEAD_RANGE) / KEY_STEPS;
  }

  pop(): number {
    const top = this.heap[0]!;
    this.cost = this.costs[top]!;
    this.size -= 1;
    if (this.size > 0) this.sink(0, this.heap[this.size]!);
    return this.states[top]!;
  }
}

/** How far `p` is from the run from `a` to `b`. */
function distanceToRun(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether the run from `a` to `b` and the run from `p` to `q` cross, each at a point inside it. */
function runsCross(a: Point, b: Point, p: Point, q: Point): boolean {
  const side = (u: Point, v: Point, w: Point): number =>
    (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  return side(p, q, a) * side(p, q, b) < 0 && side(a, b, p) * side(a, b, q) < 0;
}

/** `rect` with `by` more room on every side. */
function grown(rect: Rect, by: number): Rect {
  return {
    left: rect.left - by,
    right: rect.right + by,
    top: rect.top - by,
    bottom: rect.bottom + by,
  };
}

/**
 * Route the branches among `edges` afresh, with the nodes where they are.
 *
 * `nodes` and `edges` are the diagram as `buildGraph` made it: an edge of
 * type `stub` is a device connector, any other between two buses a branch.
 * The device connectors are laid out first, as the connection pass lays
 * them out with no branch about, and the branches are then routed around
 * the devices, the connectors and each other.
 */
export function tidyRoutes(
  nodes: readonly TidyNode[],
  edges: readonly ConnectionEdge[],
  options: TidyOptions = {},
): TidyResult {
  const stubs = edges.filter((edge) => edge.type === 'stub');
  const base = layoutConnections(nodes, stubs, options);

  // ---- the buses, and what stands on the diagram ----
  const buses: Bus[] = [];
  const busById = new Map<string, Bus>();
  const labels: Rect[] = [];
  const boxes: { box: Rect; clearance: number }[] = [];
  for (const node of nodes) {
    const { x, y } = node.position;
    if (node.type !== 'bus') {
      const measured = options.sizes?.get(node.id);
      const width = measured?.width ?? node.initialWidth ?? DEVICE_SIZE.width;
      const height = measured?.height ?? node.initialHeight ?? DEVICE_SIZE.height;
      boxes.push({
        box: { left: x, right: x + width, top: y, bottom: y + height },
        clearance: node.type === 'controller' ? BADGE_CLEARANCE : DEVICE_CLEARANCE,
      });
      continue;
    }
    const bar = base.bars.get(node.id);
    if (bar === undefined) continue;
    const span = faceSpan(bar);
    const on = (side: Side): number[] =>
      bar.taps.filter((tap) => tap.side === side).map((tap) => x + tap.x);
    const bus: Bus = {
      id: node.id,
      index: buses.length,
      x,
      y,
      cx: x + BAR_LENGTH / 2,
      cy: y + BAR_THICKNESS / 2,
      start: x + bar.start,
      end: x + bar.end,
      lo: x + span.lo,
      hi: x + span.hi,
      drawn: { start: x + bar.start, end: x + bar.end, lo: x + span.lo, hi: x + span.hi },
      row: -1,
      deviceTaps: { north: on('north'), south: on('south') },
      taps: { north: [], south: [] },
      endDevice: { east: on('east').length > 0, west: on('west').length > 0 },
      endRoute: { east: null, west: null },
      grown: { east: false, west: false },
      grownOver: [],
      endsBarred: false,
    };
    buses.push(bus);
    busById.set(bus.id, bus);
    // The label hangs under the middle of the bar: the name, and after a
    // power flow the voltage and the angle (10 px monospace).
    const name = String(node.data?.name ?? node.data?.idx ?? node.id);
    const half = (6 * Math.max(name.length + 2, 9) + 8) / 2 + LABEL_MARGIN;
    labels.push({
      left: bus.cx - half,
      right: bus.cx + half,
      top: bus.cy,
      bottom: y + LABEL_BOTTOM,
    });
  }
  for (const box of options.obstacles ?? []) boxes.push({ box, clearance: BADGE_CLEARANCE });

  const branches: Branch[] = [];
  for (const edge of edges) {
    if (edge.type === 'stub') continue;
    const a = busById.get(edge.source);
    const b = busById.get(edge.target);
    if (a && b && a !== b) branches.push({ edge, a, b, found: null });
  }
  const result: TidyResult = { routes: new Map(), unrouted: [], steps: 0 };
  if (branches.length === 0) return result;

  // ---- the grid ----
  // Its lines go on as far as `GRID_REACH` from what stands on the diagram,
  // and no further out than a route goes round the outermost of it.
  const across: [number, number][] = [];
  const down: [number, number][] = [];
  for (const bus of buses) {
    across.push([bus.start, bus.end]);
    down.push([bus.y, bus.y + LABEL_BOTTOM]);
  }
  for (const { box } of boxes) {
    across.push([box.left, box.right]);
    down.push([box.top, box.bottom]);
  }
  const margin = MAX_OVERHANG + 3 * GRID_STEP;
  const gridLines = (spans: [number, number][], step: number): { at: number; kind: LineKind }[] => {
    const sorted = [...spans].sort((p, q) => p[0] - q[0]);
    const low = sorted[0]![0] - margin;
    const high = sorted.reduce((most, span) => Math.max(most, span[1]), -Infinity) + margin;
    const lines: { at: number; kind: LineKind }[] = [];
    let next = -Infinity;
    for (let i = 0; i < sorted.length; ) {
      // The stretch this span and the ones that follow it closely make up.
      const from = Math.max(low, sorted[i]![0] - GRID_REACH);
      let to = sorted[i]![1] + GRID_REACH;
      for (i += 1; i < sorted.length && sorted[i]![0] - GRID_REACH <= to; i += 1) {
        to = Math.max(to, sorted[i]![1] + GRID_REACH);
      }
      const last = Math.ceil(Math.min(high, to) / step);
      for (let k = Math.max(next, Math.floor(from / step)); k <= last; k += 1) {
        lines.push({ at: k * step, kind: 'grid' });
      }
      next = last + 1;
    }
    return lines;
  };
  const linesOf = (fine: boolean, step: number): { cols: Axis; rws: Axis } => {
    const columns = gridLines(across, step);
    const rows = gridLines(down, step);
    // The line of every bar, which the branches of that bus run along from
    // its tips, and the lines that just clear a bar: over and under it, where
    // a branch that leaves by a face first turns, and past its tips.
    for (const bus of buses) {
      rows.push({ at: bus.cy, kind: 'bar' });
      rows.push({ at: bus.cy - RUN_CLEARANCE, kind: 'aux' });
      rows.push({ at: bus.cy + RUN_CLEARANCE, kind: 'aux' });
      rows.push({ at: bus.y + LABEL_BOTTOM, kind: 'aux' });
      columns.push({ at: bus.start - SLIDE_CLEARANCE, kind: 'aux' });
      columns.push({ at: bus.end + SLIDE_CLEARANCE, kind: 'aux' });
      // Where a device lands on one face a branch may land on the other, on
      // the same dot: any nearer place on that face would crowd it.
      for (const x of [...bus.deviceTaps.north, ...bus.deviceTaps.south]) {
        columns.push({ at: x, kind: 'aux' });
      }
    }
    // The lines that just clear a device: the way between two that stand
    // side by side over a bar is often no wider than that, and no line of
    // the grid need fall in it.
    if (fine) {
      for (const { box, clearance } of boxes) {
        columns.push({ at: box.left - clearance, kind: 'aux' });
        columns.push({ at: box.right + clearance, kind: 'aux' });
        rows.push({ at: box.top - clearance, kind: 'aux' });
        rows.push({ at: box.bottom + clearance, kind: 'aux' });
      }
    }
    return { cols: axisOf(columns), rws: axisOf(rows) };
  };
  // The finest grid that is not too large (`GRID_POINTS`).
  let grid: { cols: Axis; rws: Axis } | null = null;
  for (const [fine, wider] of [
    [true, 1],
    [false, 1],
    [false, 2],
    [false, 4],
  ] as const) {
    const tried = linesOf(fine, wider * GRID_STEP);
    if (tried.cols.at.length * tried.rws.at.length > GRID_POINTS) continue;
    grid = tried;
    break;
  }
  if (grid === null) {
    return { ...result, unrouted: branches.map((branch) => branch.edge.id), tooLarge: true };
  }
  const { cols, rws } = grid;
  const xs = cols.at;
  const ys = rws.at;
  const nC = xs.length;
  const nR = ys.length;
  const size = nC * nR;
  for (const bus of buses) {
    bus.row = ys.findIndex((y) => Math.abs(y - bus.cy) <= EPS);
  }
  const colFrom = (x: number): number => lineFrom(cols, x);
  const colTo = (x: number): number => lineTo(cols, x);
  const rowFrom = (y: number): number => lineFrom(rws, y);
  const rowTo = (y: number): number => lineTo(rws, y);
  /** Every grid point inside `rect`, and not on its edge. */
  const inside = (rect: Rect, visit: (n: number) => void): void => {
    const c0 = colFrom(rect.left + 1e-6);
    const c1 = colTo(rect.right - 1e-6);
    const r0 = rowFrom(rect.top + 1e-6);
    const r1 = rowTo(rect.bottom - 1e-6);
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) visit(r * nC + c);
    }
  };

  // ---- what is in the way ----
  /** Inside a device, a badge or a chain, or too near one. */
  const hard = new Uint8Array(size);
  /** Too near the bar of this bus (`-1`: of none, `-2`: of several). */
  const barZone = new Int32Array(size).fill(-1);
  /** On the label of this bus. */
  const labelZone = new Int32Array(size).fill(-1);
  const claim = (zone: Int32Array, n: number, bus: number): void => {
    zone[n] = zone[n] === -1 || zone[n] === bus ? bus : -2;
  };
  for (const { box, clearance } of boxes) {
    inside(grown(box, clearance), (n) => {
      hard[n] = 1;
    });
  }
  const barRect = (bus: Bus): Rect => ({
    left: bus.start - SLIDE_CLEARANCE,
    right: bus.end + SLIDE_CLEARANCE,
    top: bus.cy - RUN_CLEARANCE,
    bottom: bus.cy + RUN_CLEARANCE,
  });
  buses.forEach((bus, i) => {
    inside(barRect(bus), (n) => claim(barZone, n, bus.index));
    inside(labels[i]!, (n) => claim(labelZone, n, bus.index));
  });
  // The places kept for the values of the devices (`TidyOptions.keepFree`):
  // which grid points each takes, how many routes run through it now, and
  // which other places its device has.
  /** In one of those places. */
  const kept = new Uint8Array(size);
  /** The places a grid point is in, for the points that are in one. */
  const placesAt = new Map<number, number[]>();
  const placeBox: Rect[] = [];
  const placeMates: number[][] = [];
  const placeCrossed: number[] = [];
  /** The places of each device that has any. */
  const devicePlaces: number[][] = [];
  for (const boxes of options.keepFree ?? []) {
    const first = placeBox.length;
    const places = boxes.map((_, k) => first + k);
    devicePlaces.push(places);
    boxes.forEach((box, k) => {
      const place = first + k;
      placeBox.push(box);
      placeMates.push(places.filter((mate) => mate !== place));
      placeCrossed.push(0);
      inside(box, (n) => {
        kept[n] = 1;
        const list = placesAt.get(n);
        if (list) list.push(place);
        else placesAt.set(n, [place]);
      });
    });
  }
  /** The place no route may run through, while the routes around a device are routed again to leave it one. */
  let barred = -1;
  /**
   * What stepping from one grid point to the next costs for the places
   * kept free: for each it goes into, more when that is the last one its
   * device has left. A place counts as left while no route runs through it
   * and the run that is being made is not heading through it as well: a
   * line that passes close beside a device runs through the place beside
   * the connector and the one on the far side in one go.
   */
  const into = (from: number, to: number): number => {
    if (kept[to] === 0) return 0;
    const before = kept[from] === 0 ? undefined : placesAt.get(from);
    const level = Math.abs(to - from) === 1;
    const at = level ? ys[(to / nC) | 0]! : xs[to % nC]!;
    let cost = 0;
    for (const place of placesAt.get(to)!) {
      if (before?.includes(place)) continue;
      if (place === barred) return Infinity;
      const left = placeMates[place]!.some((mate) => {
        const box = placeBox[mate]!;
        const ahead = level ? at > box.top && at < box.bottom : at > box.left && at < box.right;
        return placeCrossed[mate] === 0 && !ahead;
      });
      cost += left ? KEEP_FREE_COST : LAST_PLACE_COST;
    }
    return cost;
  };
  /** How many devices have a route through every place kept for them. */
  const withoutAPlace = (): number =>
    devicePlaces.filter((places) => places.every((place) => placeCrossed[place]! > 0)).length;

  /** On a device connector, or right beside one. */
  const wireNode = new Uint8Array(size);
  /** The grid edge to the right of a point, and the one below it, crosses a device connector. */
  const wireCrossH = new Uint8Array(size);
  const wireCrossV = new Uint8Array(size);
  for (const stub of stubs) {
    const points = base.routes.get(stub.id)?.points ?? [];
    for (let i = 1; i < points.length; i += 1) {
      const [p, q] = [points[i - 1]!, points[i]!];
      const c0 = Math.max(0, colTo(Math.min(p[0], q[0]) - WIRE_NEAR));
      const c1 = Math.min(nC - 1, colFrom(Math.max(p[0], q[0]) + WIRE_NEAR));
      const r0 = Math.max(0, rowTo(Math.min(p[1], q[1]) - WIRE_NEAR));
      const r1 = Math.min(nR - 1, rowFrom(Math.max(p[1], q[1]) + WIRE_NEAR));
      for (let r = r0; r <= r1; r += 1) {
        for (let c = c0; c <= c1; c += 1) {
          const n = r * nC + c;
          const at: Point = [xs[c]!, ys[r]!];
          if (distanceToRun(at, p, q) < WIRE_NEAR) wireNode[n] = 1;
          if (c < c1 && runsCross(at, [xs[c + 1]!, ys[r]!], p, q)) wireCrossH[n] = 1;
          if (r < r1 && runsCross(at, [xs[c]!, ys[r + 1]!], p, q)) wireCrossV[n] = 1;
        }
      }
    }
  }

  // ---- what the routes made so far take up ----
  /** How many routes run along the row through a point, along the column, and turn on it. */
  const occH = new Uint16Array(size);
  const occV = new Uint16Array(size);
  const occBend = new Uint16Array(size);
  /** How many routes use the grid edge to the right of a point, and the one below it. */
  const edgeH = new Uint16Array(size);
  const edgeV = new Uint16Array(size);

  /** Whether nothing of another route is at `n`. */
  const untouched = (n: number): boolean => occH[n] === 0 && occV[n] === 0 && occBend[n] === 0;
  /** Whether no route runs along a column right beside the point at `c`, `r`, and none turns there. */
  const besideClearV = (c: number, r: number): boolean =>
    cols.near[c]!.every((c3) => occV[r * nC + c3] === 0 && occBend[r * nC + c3] === 0);
  /** The same for the rows right over and under it. */
  const besideClearH = (c: number, r: number): boolean =>
    rws.near[r]!.every((r3) => occH[r3 * nC + c] === 0 && occBend[r3 * nC + c] === 0);

  /** Whether a tap at `x` on `side` of `bus` keeps its distance from every other tap of the bar. */
  const tapFree = (bus: Bus, side: 'north' | 'south', x: number): boolean => {
    const other = side === 'north' ? 'south' : 'north';
    // To the last fraction: the connection pass parts two taps of a face
    // that are any nearer than the spacing.
    const crowds = (t: number): boolean => Math.abs(t - x) < TAP_SPACING - 1e-6;
    const apart = (t: number): boolean => Math.abs(t - x) <= EPS || !crowds(t);
    if (bus.deviceTaps[side].some(crowds) || bus.taps[side].some(crowds)) return false;
    if (!bus.deviceTaps[other].every(apart) || !bus.taps[other].every(apart)) return false;
    // No tap past a tip that something runs into, and a spacing clear of
    // the end of a route, as the connection pass keeps it from a device's.
    if ((bus.endDevice.west || bus.endRoute.west !== null) && x < bus.lo - EPS) return false;
    if ((bus.endDevice.east || bus.endRoute.east !== null) && x > bus.hi + EPS) return false;
    if (bus.endRoute.west !== null && crowds(bus.start + TAP_INSET)) return false;
    if (bus.endRoute.east !== null && crowds(bus.end - TAP_INSET)) return false;
    return true;
  };

  /** Where a route that runs into an end of `bus` lands: the middle of that tip. */
  const tipOf = (bus: Bus, side: 'east' | 'west'): Point => [
    side === 'east' ? bus.end - TAP_INSET : bus.start + TAP_INSET,
    bus.cy,
  ];

  /**
   * Whether a route can run into an end of `bus`: nothing does yet, the
   * bar was not drawn out on that side, and no tap of a face is within a
   * spacing of the tip, which is a tap of the bar as well.
   */
  const endOpen = (bus: Bus, side: 'east' | 'west'): boolean => {
    if (bus.endsBarred) return false;
    if (bus.endDevice[side] || bus.endRoute[side] !== null || bus.grown[side]) return false;
    const tip = tipOf(bus, side)[0];
    return [
      ...bus.deviceTaps.north,
      ...bus.deviceTaps.south,
      ...bus.taps.north,
      ...bus.taps.south,
    ].every((t) => Math.abs(t - tip) >= TAP_SPACING - 1e-6);
  };

  /**
   * The grid points the bar of `bus` would come too near to, were it drawn
   * out to a tap at `x` past its tip; `null` when something is there.
   */
  const growth = (bus: Bus, x: number): number[] | null => {
    const rect: Rect =
      x > bus.hi
        ? { ...barRect(bus), left: bus.end, right: x + TAP_INSET + SLIDE_CLEARANCE }
        : { ...barRect(bus), left: x - TAP_INSET - SLIDE_CLEARANCE, right: bus.start };
    const taken: number[] = [];
    let clear = true;
    inside(rect, (n) => {
      if (barZone[n] === bus.index) return;
      const free =
        hard[n] === 0 &&
        barZone[n] === -1 &&
        (labelZone[n] === -1 || labelZone[n] === bus.index) &&
        wireNode[n] === 0 &&
        untouched(n);
      if (!free) clear = false;
      taken.push(n);
    });
    return clear ? taken : null;
  };

  /** The ways a route can leave `bus`. */
  const terminalsOf = (bus: Bus): Terminal[] => {
    const out: Terminal[] = [];
    const westFree = !bus.endDevice.west && bus.endRoute.west === null;
    const eastFree = !bus.endDevice.east && bus.endRoute.east === null;
    for (const side of ['north', 'south'] as const) {
      const step = side === 'north' ? -1 : 1;
      const row =
        side === 'north' ? rowTo(bus.cy - RUN_CLEARANCE) : rowFrom(bus.cy + RUN_CLEARANCE);
      if (row < 0 || row >= nR) continue;
      const c0 = colFrom((westFree ? bus.drawn.lo - MAX_OVERHANG : bus.lo) - EPS);
      const c1 = colTo((eastFree ? bus.drawn.hi + MAX_OVERHANG : bus.hi) + EPS);
      for (let c = c0; c <= c1; c += 1) {
        const x = xs[c]!;
        if (!tapFree(bus, side, x)) continue;
        const over = Math.max(0, bus.lo - EPS - x, x - bus.hi - EPS);
        // The run from the bar to the first grid point clear of it: nothing
        // of another bus in it, and no other route.
        let clear = true;
        let avoided = 0;
        for (let r = bus.row + step; clear && r !== row + step; r += step) {
          const n = r * nC + c;
          const own = (zone: Int32Array): boolean => zone[n] === -1 || zone[n] === bus.index;
          clear =
            hard[n] === 0 &&
            own(barZone) &&
            own(labelZone) &&
            wireNode[n] === 0 &&
            occV[n] === 0 &&
            occBend[n] === 0 &&
            (r === row || occH[n] === 0);
          avoided += into(n - step * nC, n);
        }
        const node = row * nC + c;
        if (!clear || barZone[node] !== -1 || !besideClearV(c, row)) continue;
        if (avoided === Infinity || (over > 0 && growth(bus, x) === null)) continue;
        out.push({
          node,
          dir: V,
          tap: [x, bus.cy],
          side,
          cost:
            Math.abs(ys[row]! - bus.cy) * cols.cost[c]! +
            TAP_BIAS * Math.abs(x - bus.cx) +
            (over > 0 ? OVERHANG_COST + over : 0) +
            CROSS_COST * occH[node]! +
            avoided,
          over,
        });
      }
    }
    for (const side of ['east', 'west'] as const) {
      if (!endOpen(bus, side)) continue;
      const tip = tipOf(bus, side);
      const c =
        side === 'east' ? colFrom(bus.end + SLIDE_CLEARANCE) : colTo(bus.start - SLIDE_CLEARANCE);
      if (c < 0 || c >= nC) continue;
      const node = bus.row * nC + c;
      const free =
        hard[node] === 0 &&
        barZone[node] === -1 &&
        labelZone[node] === -1 &&
        wireNode[node] === 0 &&
        occH[node] === 0 &&
        occBend[node] === 0 &&
        besideClearH(c, bus.row);
      const avoided = into(side === 'east' ? node - 1 : node + 1, node);
      if (!free || avoided === Infinity) continue;
      out.push({
        node,
        dir: H,
        tap: tip,
        side,
        cost: Math.abs(xs[c]! - tip[0]) + CROSS_COST * occV[node]! + avoided,
        over: 0,
      });
    }
    return out;
  };

  // ---- the search ----
  /** The step from one grid point to the next away from a bar, by the side a route leaves it by. */
  const AHEAD: Record<Side, number> = { north: -nC, south: nC, east: 1, west: -1 };
  const best = new Float64Array(2 * size);
  const seen = new Uint32Array(2 * size);
  /** The state a state was reached from; `-1 - i` for the `i`th way out of the source. */
  const cameFrom = new Int32Array(2 * size);
  const frontier = new Frontier();
  let search = 0;
  /**
   * What is at the least still ahead of a state, for each face of the bus a
   * search is heading for (`aheadOf` in `routeBetween`): by the column the
   * state is in, for one that travels along a row and for one that travels
   * along a column.
   */
  const aheadAlongRow = [new Float64Array(nC), new Float64Array(nC)];
  const aheadAlongColumn = [new Float64Array(nC), new Float64Array(nC)];
  /** How many states the searches have taken off the frontier so far: the work done. */
  let steps = 0;
  const budget = options.steps ?? TIDY_STEPS;
  /** How many steps the search in hand may take. */
  let allowed = Infinity;
  /** Whether a search that runs out of them goes on for the first way it finds (`HURRY`). */
  let anyWay = false;
  /** Whether the last search ran out of steps before it had looked at every way that could be better. */
  let ranOut = false;
  /** Whether the last search looked at every way it could go, where it was told to look, and found none. */
  let noWay = false;

  /** The points a route is drawn through. */
  const pointsOf = (source: Terminal, path: readonly number[], target: Terminal): Point[] => {
    const points: Point[] = [source.tap];
    for (const n of path) points.push([xs[n % nC]!, ys[(n / nC) | 0]!]);
    points.push(target.tap);
    // The run out of an end follows the line of its bar, not the grid row
    // that line was taken to be.
    const level = (i: number, tap: Point): void => {
      const p = points[i];
      if (p !== undefined && Math.abs(p[1] - tap[1]) <= EPS) points[i] = [p[0], tap[1]];
    };
    if (source.dir === H) level(1, source.tap);
    if (target.dir === H) level(points.length - 2, target.tap);
    return simplifyRoute(points);
  };

  /** The route from `a` to `b` that costs least around everything that is there now. */
  const routeBetween = (a: Bus, b: Bus, window: number | null): Found | null => {
    const own = (zone: Int32Array, n: number): boolean =>
      zone[n] === -1 || zone[n] === a.index || zone[n] === b.index;
    const least: { route: Found | null } = { route: null };
    const offer = (candidate: Found): void => {
      if (least.route === null || candidate.cost < least.route.cost - 1e-9) least.route = candidate;
    };
    const direct = (dir: number, side: Side, tap: Point): Terminal => ({
      node: -1,
      dir,
      tap,
      side,
      cost: 0,
      over: 0,
    });

    // Straight from one bar to the other, where they stand one over the
    // other or level end to end: the grid may have no point between them.
    const upper = a.cy <= b.cy ? a : b;
    const lower = upper === a ? b : a;
    if (lower.cy - upper.cy > BAR_THICKNESS) {
      const c1 = colTo(Math.min(a.hi, b.hi) + EPS);
      for (let c = colFrom(Math.max(a.lo, b.lo) - EPS); c <= c1; c += 1) {
        const x = xs[c]!;
        if (!tapFree(upper, 'south', x) || !tapFree(lower, 'north', x)) continue;
        const path: number[] = [];
        let cost =
          (lower.cy - upper.cy) * cols.cost[c]! +
          TAP_BIAS * (Math.abs(x - a.cx) + Math.abs(x - b.cx));
        let clear = true;
        for (let r = upper.row + 1; clear && r < lower.row; r += 1) {
          const n = r * nC + c;
          clear =
            hard[n] === 0 &&
            own(barZone, n) &&
            own(labelZone, n) &&
            wireNode[n] === 0 &&
            occV[n] === 0 &&
            occBend[n] === 0 &&
            besideClearV(c, r);
          cost += CROSS_COST * occH[n]! + into(n - nC, n);
          path.push(n);
        }
        if (!clear || cost === Infinity) continue;
        const down = upper === a;
        if (!down) path.reverse();
        const source = direct(V, down ? 'south' : 'north', [x, a.cy]);
        const target = direct(V, down ? 'north' : 'south', [x, b.cy]);
        offer({ cost, nodes: path, source, target, points: pointsOf(source, path, target) });
      }
    }
    const left = a.cx <= b.cx ? a : b;
    const right = left === a ? b : a;
    if (
      a.row === b.row &&
      left.end < right.start &&
      endOpen(left, 'east') &&
      endOpen(right, 'west')
    ) {
      const path: number[] = [];
      let cost = right.start - left.end + 2 * TAP_INSET;
      let clear = true;
      const c1 = colTo(right.start - 1e-6);
      for (let c = colFrom(left.end + 1e-6); clear && c <= c1; c += 1) {
        const n = a.row * nC + c;
        clear =
          hard[n] === 0 &&
          own(barZone, n) &&
          labelZone[n] === -1 &&
          wireNode[n] === 0 &&
          occH[n] === 0 &&
          occBend[n] === 0 &&
          besideClearH(c, a.row);
        cost += CROSS_COST * occV[n]! + into(n - 1, n);
        path.push(n);
      }
      if (clear && cost !== Infinity) {
        const along = left === a;
        if (!along) path.reverse();
        const source = direct(H, along ? 'east' : 'west', tipOf(a, along ? 'east' : 'west'));
        const target = direct(H, along ? 'west' : 'east', tipOf(b, along ? 'west' : 'east'));
        offer({ cost, nodes: path, source, target, points: pointsOf(source, path, target) });
      }
    }

    // Around everything else: A* over the grid.
    const sources = terminalsOf(a);
    const targets = terminalsOf(b);
    if (sources.length === 0 || targets.length === 0) {
      ranOut = false;
      noWay = least.route === null;
      return least.route;
    }
    const passable = (n: number): boolean =>
      hard[n] === 0 && barZone[n] === -1 && own(labelZone, n);
    // A label a route may pass is that of one of its own two buses, and it
    // passes it straight down, on its way out of the south face.
    const onLabel = (n: number): boolean => labelZone[n] !== -1;
    const mayBend = (n: number): boolean => {
      if (!untouched(n) || wireNode[n] !== 0 || onLabel(n)) return false;
      const c = n % nC;
      const r = (n / nC) | 0;
      return (
        rws.near[r]!.every((r3) => untouched(r3 * nC + c)) &&
        cols.near[c]!.every((c3) => untouched(r * nC + c3))
      );
    };
    const rowOpen = (r: number): boolean => rws.kind[r] !== 'bar' || r === a.row || r === b.row;

    const targetsAt = new Map<number, Terminal[]>();
    for (const target of targets) {
      const list = targetsAt.get(target.node);
      if (list) list.push(target);
      else targetsAt.set(target.node, [target]);
    }
    // Where to look: around the two buses first.
    let wc0 = 0;
    let wc1 = nC - 1;
    let wr0 = 0;
    let wr1 = nR - 1;
    if (window !== null) {
      const far = window * GRID_STEP;
      wc0 = Math.max(wc0, colFrom(Math.min(a.start, b.start) - far));
      wc1 = Math.min(wc1, colTo(Math.max(a.end, b.end) + far));
      wr0 = Math.max(wr0, rowFrom(Math.min(a.cy, b.cy) - far));
      wr1 = Math.min(wr1, rowTo(Math.max(a.cy, b.cy) + far));
    }
    // What is still ahead of a state, at the least: the way to one of the
    // ways into `b`, what that way in costs, and the bends it takes to
    // arrive there in its direction. The ways in on a face are in one row,
    // so the least over them is looked up by the column of the state: with
    // one bend for a state that travels along a row, and for one that
    // travels along a column with none in the column of a way in and two in
    // any other. An end of the bar is one way in. The nearer this is to
    // what the rest of the route does cost, the fewer states the search
    // takes up, and across open ground it is exact.
    const faceRows: number[] = [];
    for (const side of ['north', 'south'] as const) {
      const onFace = targets.filter((target) => target.side === side);
      if (onFace.length === 0) continue;
      const alongRow = aheadAlongRow[faceRows.length]!;
      const alongColumn = aheadAlongColumn[faceRows.length]!;
      faceRows.push(ys[(onFace[0]!.node / nC) | 0]!);
      alongRow.fill(Infinity, wc0, wc1 + 1);
      alongColumn.fill(Infinity, wc0, wc1 + 1);
      for (const target of onFace) {
        const c = target.node % nC;
        if (c < wc0 || c > wc1) continue;
        alongRow[c] = Math.min(alongRow[c]!, target.cost);
        alongColumn[c] = alongRow[c]!;
      }
      for (let c = wc0 + 1; c <= wc1; c += 1) {
        alongRow[c] = Math.min(alongRow[c]!, alongRow[c - 1]! + xs[c]! - xs[c - 1]!);
      }
      for (let c = wc1 - 1; c >= wc0; c -= 1) {
        alongRow[c] = Math.min(alongRow[c]!, alongRow[c + 1]! + xs[c + 1]! - xs[c]!);
      }
      for (let c = wc0; c <= wc1; c += 1) {
        alongColumn[c] = Math.min(alongColumn[c]!, alongRow[c]! + 2 * BEND_COST);
        alongRow[c] = alongRow[c]! + BEND_COST;
      }
    }
    const ends = targets
      .filter((target) => target.dir === H)
      .map((target) => ({
        x: xs[target.node % nC]!,
        row: (target.node / nC) | 0,
        cost: target.cost,
      }));
    const aheadOf = (state: number): number => {
      const n = state >> 1;
      const along = state & 1;
      const c = n % nC;
      const r = (n / nC) | 0;
      const y = ys[r]!;
      let least = Infinity;
      for (let face = 0; face < faceRows.length; face += 1) {
        const rest =
          Math.abs(y - faceRows[face]!) +
          (along === H ? aheadAlongRow[face]![c]! : aheadAlongColumn[face]![c]!);
        if (rest < least) least = rest;
      }
      for (const end of ends) {
        const bends = r === end.row ? (along === H ? 0 : 1) : along === H ? 2 : 1;
        const rest =
          Math.abs(xs[c]! - end.x) + Math.abs(y - ys[end.row]!) + end.cost + BEND_COST * bends;
        if (rest < least) least = rest;
      }
      return least;
    };

    search += 1;
    frontier.clear();
    const reachState = (state: number, cost: number, from: number): void => {
      if (seen[state] === search && best[state]! <= cost) return;
      seen[state] = search;
      best[state] = cost;
      cameFrom[state] = from;
      frontier.push(cost, aheadOf(state), state);
    };
    sources.forEach((source, i) => reachState(2 * source.node + source.dir, source.cost, -1 - i));
    /**
     * Whether the run that ends at `state` is too short to end in a bend:
     * it began with one, less than `MIN_RUN` back.
     */
    const kinks = (state: number): boolean => {
      const d = state & 1;
      let run = 0;
      for (let at = state; run < MIN_RUN; ) {
        const from = cameFrom[at]!;
        // The run out of the bar is long enough by itself.
        if (from < 0) return false;
        const [n, m] = [at >> 1, from >> 1];
        run +=
          d === H
            ? Math.abs(xs[n % nC]! - xs[m % nC]!)
            : Math.abs(ys[(n / nC) | 0]! - ys[(m / nC) | 0]!);
        if ((from & 1) !== d) return run < MIN_RUN;
        at = from;
      }
      return false;
    };
    let goal: { cost: number; state: number; target: Terminal } | null = null;
    let stopAt = steps + allowed;
    let hurried = false;
    ranOut = false;
    while (frontier.size > 0) {
      if (steps >= stopAt) {
        // Out of steps. With no way found yet, and one wanted whatever it
        // costs, the search makes for the goal and takes the first.
        ranOut = true;
        if (hurried || !anyWay || goal !== null || least.route !== null) break;
        hurried = true;
        frontier.hurry(HURRY, aheadOf);
        // As many steps as find a way round a thing or two, and as it takes
        // to cross the stretch that is searched.
        stopAt = steps + HURRY_STEPS + 4 * (wc1 - wc0 + wr1 - wr0);
        continue;
      }
      if (hurried && goal !== null) break;
      const limit = Math.min(goal?.cost ?? Infinity, least.route?.cost ?? Infinity);
      if (!hurried && frontier.peek() >= Frontier.rounded(limit)) break;
      const state = frontier.pop();
      // Reached again since, by a way that costs less: that one is taken up.
      if (frontier.cost > best[state]!) continue;
      steps += 1;
      const n = state >> 1;
      const d = state & 1;
      const cost = best[state]!;
      for (const target of targetsAt.get(n) ?? []) {
        const turns = target.dir !== d;
        if (turns && (!mayBend(n) || kinks(state))) continue;
        const total = cost + target.cost + (turns ? BEND_COST : 0);
        if (goal === null || total < goal.cost) goal = { cost: total, state, target };
      }
      const c = n % nC;
      const r = (n / nC) | 0;
      // Where it came from: a route does not turn back on itself, nor back
      // into the bar it has just left.
      const from = cameFrom[state]!;
      const back = from >= 0 ? from >> 1 : n - AHEAD[sources[-1 - from]!.side];
      for (let k = 0; k < 4; k += 1) {
        const md = k < 2 ? H : V;
        const sign = k % 2 === 0 ? -1 : 1;
        const c2 = md === H ? c + sign : c;
        const r2 = md === V ? r + sign : r;
        if (c2 < wc0 || c2 > wc1 || r2 < wr0 || r2 > wr1) continue;
        const n2 = r2 * nC + c2;
        if (n2 === back || !passable(n2)) continue;
        const edge = sign > 0 ? n : n2;
        let step: number;
        if (md === H) {
          if (!rowOpen(r) || onLabel(n) || onLabel(n2)) continue;
          if (edgeH[edge] !== 0 || occH[n2] !== 0 || occBend[n2] !== 0) continue;
          const ec = edge % nC;
          if (rws.near[r]!.some((r3) => edgeH[r3 * nC + ec] !== 0)) continue;
          if (!besideClearH(c2, r)) continue;
          step = Math.abs(xs[c2]! - xs[c]!) * rws.cost[r]! + CROSS_COST * occV[n2]!;
          if (wireNode[n2] !== 0 || (wireCrossH[edge] !== 0 && wireNode[n] === 0)) {
            step += CROSS_COST;
          }
        } else {
          if (edgeV[edge] !== 0 || occV[n2] !== 0 || occBend[n2] !== 0) continue;
          const er = (edge / nC) | 0;
          if (cols.near[c]!.some((c3) => edgeV[er * nC + c3] !== 0)) continue;
          if (!besideClearV(c, r2)) continue;
          step = Math.abs(ys[r2]! - ys[r]!) * cols.cost[c]! + CROSS_COST * occH[n2]!;
          if (wireNode[n2] !== 0 || (wireCrossV[edge] !== 0 && wireNode[n] === 0)) {
            step += CROSS_COST;
          }
        }
        if (md !== d) {
          if (!mayBend(n) || kinks(state)) continue;
          step += BEND_COST;
        }
        step += into(n, n2);
        if (step !== Infinity) reachState(2 * n2 + md, cost + step, state);
      }
    }
    noWay = goal === null && least.route === null && !ranOut;
    if (goal !== null) {
      const path: number[] = [];
      let state = goal.state;
      while (state >= 0) {
        path.push(state >> 1);
        state = cameFrom[state]!;
      }
      path.reverse();
      const source = sources[-1 - state]!;
      offer({
        cost: goal.cost,
        nodes: path,
        source,
        target: goal.target,
        points: pointsOf(source, path, goal.target),
      });
    }
    return least.route;
  };

  // ---- taking a route up, and off again ----
  /** The direction of the run between two grid points next to each other. */
  const along = (from: number, to: number): number => (Math.abs(to - from) === 1 ? H : V);
  const bump = (counts: Uint16Array, n: number, by: number): void => {
    counts[n] = counts[n]! + by;
  };
  const mark = (route: Found, by: number): void => {
    const path = route.nodes;
    /** The places kept free that it runs through. */
    let through: Set<number> | null = null;
    for (let i = 0; i < path.length; i += 1) {
      const n = path[i]!;
      const before = i === 0 ? route.source.dir : along(path[i - 1]!, n);
      const after = i === path.length - 1 ? route.target.dir : along(n, path[i + 1]!);
      if (before !== after) bump(occBend, n, by);
      if (before === H || after === H) bump(occH, n, by);
      if (before === V || after === V) bump(occV, n, by);
      if (i > 0) bump(before === H ? edgeH : edgeV, Math.min(n, path[i - 1]!), by);
      if (kept[n] !== 0) for (const place of placesAt.get(n)!) (through ??= new Set()).add(place);
    }
    for (const place of through ?? []) placeCrossed[place] = placeCrossed[place]! + by;
  };
  const land = (bus: Bus, terminal: Terminal, id: string, on: boolean): void => {
    if (terminal.side === 'east' || terminal.side === 'west') {
      bus.endRoute[terminal.side] = on ? id : null;
      return;
    }
    const taps = bus.taps[terminal.side];
    if (on) taps.push(terminal.tap[0]);
    else taps.splice(taps.indexOf(terminal.tap[0]), 1);
    // The bar is drawn out to the outermost tap past each tip, and what
    // comes later keeps clear of it there; with that tap gone, it is as long
    // as it was.
    for (const n of bus.grownOver) barZone[n] = -1;
    bus.grownOver = [];
    const all = [...bus.taps.north, ...bus.taps.south];
    bus.hi = Math.max(bus.drawn.hi, ...all);
    bus.lo = Math.min(bus.drawn.lo, ...all);
    bus.grown = { east: bus.hi > bus.drawn.hi + EPS, west: bus.lo < bus.drawn.lo - EPS };
    bus.end = bus.grown.east ? Math.max(bus.drawn.end, bus.hi + TAP_INSET) : bus.drawn.end;
    bus.start = bus.grown.west ? Math.min(bus.drawn.start, bus.lo - TAP_INSET) : bus.drawn.start;
    if (!bus.grown.east && !bus.grown.west) return;
    inside(barRect(bus), (n) => {
      if (barZone[n] !== -1) return;
      barZone[n] = bus.index;
      bus.grownOver.push(n);
    });
  };
  const take = (branch: Branch, route: Found): void => {
    // The taps first: a bar is drawn out over grid points that are still free.
    land(branch.a, route.source, branch.edge.id, true);
    land(branch.b, route.target, branch.edge.id, true);
    mark(route, 1);
    branch.found = route;
  };
  const drop = (branch: Branch): Found | null => {
    const route = branch.found;
    if (route === null) return null;
    mark(route, -1);
    land(branch.a, route.source, branch.edge.id, false);
    land(branch.b, route.target, branch.edge.id, false);
    branch.found = null;
    return route;
  };
  /**
   * The route of `branch` around everything that is there now: looked for
   * around its two buses first, and across the whole diagram when there is
   * none there (and not when the steps ran out with more to look at there:
   * a wider look takes more).
   */
  const routeOf = (branch: Branch): Found | null => {
    const near = routeBetween(branch.a, branch.b, SEARCH_WINDOW);
    return near !== null || !noWay ? near : routeBetween(branch.a, branch.b, null);
  };

  // The shortest first: a line between two buses side by side has one good
  // way, and a long one has many.
  const apart = (branch: Branch): number =>
    Math.abs(branch.a.cx - branch.b.cx) + Math.abs(branch.a.cy - branch.b.cy);
  const order = branches
    .map((branch, i) => ({ branch, i, far: apart(branch) }))
    .sort((p, q) => p.far - q.far || p.i - q.i)
    .map(({ branch }) => branch);
  const byId = new Map(branches.map((branch) => [branch.edge.id, branch]));
  /**
   * Route `branch`. Where there is no place left for it on one of its two
   * bars, the branches that run into the ends of those bars are taken off,
   * the ends are barred, and they are routed again after it: on the faces
   * there is room for as many as come, with the bar drawn out.
   */
  const settle = (branch: Branch): void => {
    const route = routeOf(branch);
    if (route !== null) {
      take(branch, route);
      return;
    }
    // No way within the steps it had is not a bar with no place left.
    if (ranOut) {
      result.outOfSteps = true;
      return;
    }
    const evicted: Branch[] = [];
    for (const bus of [branch.a, branch.b]) {
      if (bus.endsBarred) continue;
      bus.endsBarred = true;
      for (const side of ['east', 'west'] as const) {
        const id = bus.endRoute[side];
        const other = id === null ? undefined : byId.get(id);
        if (other === undefined || other === branch) continue;
        drop(other);
        evicted.push(other);
      }
    }
    for (const again of [branch, ...evicted]) {
      const found = routeOf(again);
      if (found !== null) take(again, found);
    }
  };
  // The first routing: every branch gets a way, the best one there is while
  // the steps last and the first one found after that (`TIDY_STEPS`).
  anyWay = true;
  order.forEach((branch, i) => {
    if (steps >= 2 * budget) {
      result.outOfSteps = true;
      return;
    }
    allowed = Math.max(SEARCH_STEPS, (budget / 2 - steps) / (order.length - i));
    settle(branch);
  });
  // Then each is taken out and routed again around all the others, which
  // lets an early one give way to those that came later. A search that runs
  // out of steps here may have found a way no better than the one the branch
  // had, so that one stays.
  anyWay = false;
  for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
    for (let i = 0; i < order.length && steps < budget; i += 1) {
      const branch = order[i]!;
      allowed = Math.max(SEARCH_STEPS, (budget - steps) / (order.length - i));
      const held = drop(branch);
      const again = routeOf(branch);
      const route = again !== null && (!ranOut || held === null) ? again : held;
      if (route !== null) take(branch, route);
    }
  }

  const wires: Point[][] = stubs.map((stub) => base.routes.get(stub.id)?.points ?? []);
  /** How often two routes cross. */
  const crossings = (p: readonly Point[], q: readonly Point[]): number => {
    let count = 0;
    for (let i = 1; i < p.length; i += 1) {
      for (let k = 1; k < q.length; k += 1) {
        if (runsCross(p[i - 1]!, p[i]!, q[k - 1]!, q[k]!)) count += 1;
      }
    }
    return count;
  };
  /**
   * What the routes of `group` cost as they are drawn: their lengths, their
   * bends and what they cross, and each device that is left without a place
   * for its values.
   */
  const priceOf = (group: readonly Branch[]): number => {
    let length = 0;
    let bends = 0;
    let crossed = 0;
    group.forEach((branch, i) => {
      const points = branch.found!.points;
      bends += points.length - 2;
      for (let k = 1; k < points.length; k += 1) {
        length += Math.abs(points[k]![0] - points[k - 1]![0]);
        length += Math.abs(points[k]![1] - points[k - 1]![1]);
      }
      for (const wire of wires) crossed += crossings(points, wire);
      for (const other of order) {
        // Two of the group that cross each other are counted once.
        if (other === branch || other.found === null || group.indexOf(other) > i) continue;
        crossed += crossings(points, other.found.points);
      }
    });
    return length + BEND_COST * bends + CROSS_COST * crossed + LAST_PLACE_COST * withoutAPlace();
  };

  // Two routes that cross are then taken out together and routed again, one
  // first and then the other: routed one at a time, neither can take the
  // way the other is on, and often they only need to change places.
  if (steps < budget) {
    const routed = order.filter((branch) => branch.found !== null);
    const pairs: [Branch, Branch][] = [];
    for (let i = 0; i < routed.length && pairs.length < PAIR_LIMIT; i += 1) {
      for (let k = i + 1; k < routed.length && pairs.length < PAIR_LIMIT; k += 1) {
        if (crossings(routed[i]!.found!.points, routed[k]!.found!.points) > 0) {
          pairs.push([routed[i]!, routed[k]!]);
        }
      }
    }
    for (let i = 0; i < pairs.length && steps < budget; i += 1) {
      const [first, second] = pairs[i]!;
      if (first.found === null || second.found === null) continue;
      // Four searches to a pair: each of the two, in both orders.
      allowed = Math.max(SEARCH_STEPS, (budget - steps) / (4 * (pairs.length - i)));
      let best: { price: number; routes: [Found, Found] } = {
        price: priceOf([first, second]),
        routes: [first.found, second.found],
      };
      drop(first);
      drop(second);
      for (const [one, other] of [
        [first, second],
        [second, first],
      ] as const) {
        const early = routeOf(one);
        if (early !== null) take(one, early);
        const late = early === null ? null : routeOf(other);
        if (late !== null) take(other, late);
        if (early !== null && late !== null) {
          const price = priceOf([first, second]);
          if (price < best.price - 1e-9) best = { price, routes: [first.found!, second.found!] };
        }
        drop(one);
        drop(other);
      }
      take(first, best.routes[0]);
      take(second, best.routes[1]);
    }
  }

  // A device that is left without a place for its values has a route
  // through every one that was kept for it. Routed one at a time, none of
  // those routes gives way: each finds the other places taken. So they are
  // taken out together and routed again with one of the places shut, each
  // place in turn, and the drawing that costs least is kept. Each is tried
  // with the ends of their bars shut as well: a line that squeezes between
  // a load and the generator beside it can land on the other side of the
  // load, on the bar drawn out, and the lines that left by that end of the
  // bar then leave by its face beside it, which an end taken first rules out.
  for (const places of devicePlaces) {
    if (steps >= budget) break;
    if (!places.every((place) => placeCrossed[place]! > 0)) continue;
    const through = order.filter(
      (branch) =>
        branch.found !== null &&
        branch.found.nodes.some(
          (n) => kept[n] !== 0 && placesAt.get(n)!.some((place) => places.includes(place)),
        ),
    );
    if (through.length === 0 || through.length > GROUP_LIMIT) continue;
    // With them go the other routes of their buses that pass close by: one
    // that has the end of a bar, or the way beside the device, is what the
    // ones through the places would have to get round.
    const boxes = places.map((place) => placeBox[place]!);
    const around: Rect = grown(
      {
        left: Math.min(...boxes.map((box) => box.left)),
        right: Math.max(...boxes.map((box) => box.right)),
        top: Math.min(...boxes.map((box) => box.top)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
      },
      GROUP_REACH,
    );
    const near = new Set<number>();
    inside(around, (n) => near.add(n));
    const theirBuses = new Set(through.flatMap((branch) => [branch.a, branch.b]));
    const beside = order.filter(
      (branch) =>
        branch.found !== null &&
        !through.includes(branch) &&
        (theirBuses.has(branch.a) || theirBuses.has(branch.b)) &&
        branch.found.nodes.some((n) => near.has(n)),
    );
    const group =
      through.length + beside.length > GROUP_LIMIT
        ? through
        : order.filter((branch) => through.includes(branch) || beside.includes(branch));
    allowed = Math.max(SEARCH_STEPS, (budget - steps) / (2 * group.length * places.length));
    const bars = [...new Set(group.flatMap((branch) => [branch.a, branch.b]))];
    const shut = bars.map((bus) => bus.endsBarred);
    let best = { price: priceOf(group), routes: group.map((branch) => branch.found!) };
    for (const branch of group) drop(branch);
    for (const place of places) {
      for (const noEnds of [false, true]) {
        barred = place;
        bars.forEach((bus, i) => {
          bus.endsBarred = noEnds || shut[i]!;
        });
        const whole = group.every((branch) => {
          const found = routeOf(branch);
          if (found !== null) take(branch, found);
          return found !== null;
        });
        if (whole) {
          const price = priceOf(group);
          if (price < best.price - 1e-9) {
            best = { price, routes: group.map((branch) => branch.found!) };
          }
        }
        for (const branch of group) drop(branch);
      }
    }
    barred = -1;
    bars.forEach((bus, i) => {
      bus.endsBarred = shut[i]!;
    });
    group.forEach((branch, i) => take(branch, best.routes[i]!));
  }

  for (const branch of branches) {
    if (branch.found === null) result.unrouted.push(branch.edge.id);
    else result.routes.set(branch.edge.id, branch.found.points);
  }
  result.steps = steps;
  return result;
}

/** How near two buses stand to a common row or column to be brought onto it. */
export const ALIGN_TOLERANCE = (3 * GRID_STEP) / 4;

/** The room two buses of one row keep between their bars. */
const ROW_GAP = GRID_STEP;

/** How far apart, up and down, two buses are that do not share a row. */
const ROW_HEIGHT = 3 * GRID_STEP;

/**
 * The positions of the buses, brought onto the grid: each coordinate goes
 * to the nearest line of the grid, and buses that are nearly level, or
 * nearly in a column, go to the same line (the one nearest the middle of
 * where they were). Two buses that then stand on top of each other are
 * parted, the one further right moving right.
 */
export function alignToGrid(
  coords: Readonly<Record<string, { x: number; y: number }>>,
): Record<string, { x: number; y: number }> {
  const ids = Object.keys(coords);
  const snapped = (axis: 'x' | 'y'): Map<string, number> => {
    const sorted = [...ids].sort((p, q) => coords[p]![axis] - coords[q]![axis] || (p < q ? -1 : 1));
    const out = new Map<string, number>();
    for (let from = 0; from < sorted.length; ) {
      let to = from + 1;
      const first = coords[sorted[from]!]![axis];
      while (to < sorted.length && coords[sorted[to]!]![axis] - first <= ALIGN_TOLERANCE) to += 1;
      const group = sorted.slice(from, to);
      const mean = group.reduce((sum, id) => sum + coords[id]![axis], 0) / group.length;
      const line = Math.round(mean / GRID_STEP) * GRID_STEP;
      for (const id of group) out.set(id, line);
      from = to;
    }
    return out;
  };
  const x = snapped('x');
  const y = snapped('y');
  const out: Record<string, { x: number; y: number }> = {};
  for (const id of ids) out[id] = { x: x.get(id)!, y: y.get(id)! };
  // Part the ones that came to stand on top of each other, left to right.
  const room = Math.ceil((BAR_LENGTH + ROW_GAP) / GRID_STEP) * GRID_STEP;
  const byColumn = [...ids].sort((p, q) => out[p]!.x - out[q]!.x || (p < q ? -1 : 1));
  for (let i = 0; i < byColumn.length; i += 1) {
    const moved = out[byColumn[i]!]!;
    for (let k = 0; k < i; k += 1) {
      const fixed = out[byColumn[k]!]!;
      if (Math.abs(moved.y - fixed.y) >= ROW_HEIGHT) continue;
      if (moved.x - fixed.x < room) moved.x = fixed.x + room;
    }
  }
  return out;
}
