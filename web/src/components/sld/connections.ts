/**
 * Where the connectors of the diagram attach and how they run.
 *
 * A bus is drawn as a horizontal bar, and everything that connects to the
 * bus lands on that bar: the connector of a generator, load or shunt, and
 * each end of a line or transformer. `layoutConnections` works all of it
 * out in one pass from where the nodes sit now, so the canvas can run it on
 * every move of a drag and the picture follows the pointer.
 *
 * The rules:
 *
 * - A connection lands at a **tap**, a point on the centre line of the bar.
 *   One that comes from above or below lands on a long face (`north`,
 *   `south`): at the foot of the perpendicular from where it comes from
 *   when that falls on the bar, and at the nearest end of the bar
 *   otherwise. A device whose box still stands over a tip of the bar drops
 *   square as well, onto a bar that reaches out under its middle. A device
 *   that sits level with the bar, beyond one of its ends, runs straight
 *   into that end. An end of the bar is the middle of its rounded tip
 *   (`TAP_INSET` in), so a connection lands on the bar and not on its
 *   corner.
 * - The taps of one face keep `TAP_SPACING` between them (`spreadTaps`).
 *   Where two ask for places closer than that, the one that holds its place
 *   less firmly gives way (`TAP_HOLD`): a device that stands over the bar
 *   drops square onto it, and the end of a branch beside it moves aside. A
 *   bar that has no room for the taps of a face grows, about its middle,
 *   until it has, and a bar grows at a tip to hold a tap that was moved
 *   past it.
 * - A tap on one face and a tap on the other are either in one place, where
 *   they share a dot (a generator above a bar and a load below it, a line
 *   that comes down onto a bar and one that leaves under it), or a spacing
 *   apart like two taps of one face. Several that ask for the very same
 *   place stand whole spacings from it for that reason, and where two faces
 *   still crowd each other the taps of the one that gives way more easily
 *   are moved in line or clear.
 * - The run of a stored route that leaves a bar moves along with its tap,
 *   and a run that moves is kept `SLIDE_CLEARANCE` from every bar the
 *   branch is not connected to: the layout that made the route kept it
 *   clear where it was, not a spacing or two to the side. Of the ways to
 *   part several ends that ask for one place, the one that leaves the
 *   fewest runs up against a bar is taken (`TapWish.blocked`). A run that is
 *   still up against one stays where the route has it, and the branch
 *   steps across to its tap just outside its own bar.
 * - Where a branch could run straight down from one bar to the other but
 *   for its two taps being out of line, the one that is free to move is
 *   brought in line with the other.
 * - A device has a port at the middle of each of its four faces. Its
 *   connector leaves from the port on the face that points at its tap, so
 *   never from a corner and never from the far side.
 * - A device connector is a straight line (`straight`), which is a diagonal
 *   when the device does not sit square to its tap, or one horizontal and
 *   one vertical run with a right angle between them (`elbow`). Neither
 *   runs through another device or a controller badge where there is a way
 *   round: the connector then leaves by the face that looks at the bar.
 * - A branch is drawn with right angles. One with a stored route (from the
 *   auto-layout, or a saved layout) keeps its bends, and its two ends are
 *   brought onto the bars: the route was computed for a box around the bus,
 *   and its ends would otherwise hang beside the bar. A branch without a
 *   route, or whose bus has moved since the route was made, is routed from
 *   tap to tap; where it steps across it keeps clear of the line of a bar
 *   that stands between its two buses.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import { assignBranchSides, type BranchEnds, type HandleAssignment, type Side } from './sides';

/** A point on the canvas, `[x, y]`. */
export type Point = [number, number];

/**
 * The length a bar is drawn at unless its taps need more, which is also the
 * width of a bus node.
 */
export const BAR_LENGTH = 92;

/** The thickness a bar is drawn at. */
export const BAR_THICKNESS = 6;

/** The least distance between two taps on one face of a bar. */
export const TAP_SPACING = 14;

/**
 * How far in from the tip of the bar its outermost tap sits: at the middle
 * of the rounded tip, where the straight part of the bar ends.
 */
export const TAP_INSET = BAR_THICKNESS / 2;

/** The shortest bar a layout can ask for: room for two taps. */
export const MIN_BAR_LENGTH = 2 * TAP_INSET + TAP_SPACING;

/** The box a device is taken to have when it carries no size hint. */
const DEVICE_SIZE: NodeSize = { width: 40, height: 41 };

/** How a device connector is drawn. */
export type ConnectorStyle = 'straight' | 'elbow';

export const DEFAULT_CONNECTOR_STYLE: ConnectorStyle = 'straight';

/**
 * The shortest horizontal run an elbow starts with. A tap that is closer to
 * the side of the device than this leaves no room for a run and a turn, and
 * the connector is drawn straight.
 */
const ELBOW_MIN_RUN = 6;

/** How far a branch that leaves two buses by the same face runs clear of them. */
const BRIDGE_CLEARANCE: Record<Side, number> = { north: 24, south: 44, east: 24, west: 24 };

/**
 * How far a run across keeps from the line of a bar it is not connected to,
 * so that it is not taken for part of that bar. The automatic layout leaves
 * as much between the runs it makes and the devices under them (`layout.ts`).
 */
export const RUN_CLEARANCE = 16;

/**
 * How near a run that moved along with its tap may come to a bar it is not
 * connected to. Nearer, it would be taken for a connection on the tip of
 * that bar, or run through it.
 */
export const SLIDE_CLEARANCE = 8;

/** Two coordinates closer than this are the same place. */
const EPS = 0.5;

/** What `layoutConnections` reads of a node. */
export interface ConnectionNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  /** The size hint the node was built with, used until it has been measured. */
  initialWidth?: number;
  initialHeight?: number;
}

/** What `layoutConnections` reads of an edge. */
export interface ConnectionEdge {
  id: string;
  type?: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
}

export interface NodeSize {
  width: number;
  height: number;
}

export interface ConnectionOptions {
  /** The measured size of each node, by id. A node without one is taken at its size hint. */
  sizes?: ReadonlyMap<string, NodeSize>;
  /** How device connectors are drawn. Default: straight. */
  connectorStyle?: ConnectorStyle;
  /** The length a layout sets for a bus's bar, by bus id. The bar still grows to hold its taps. */
  barLengths?: ReadonlyMap<string, number>;
}

/** One tap on a bar. */
export interface BarTap {
  /** Where it is, as an x offset from the origin of the bus node. */
  x: number;
  /** The face (`north`, `south`) or end (`east`, `west`) of the bar the connection lands on. */
  side: Side;
}

/** The bar of one bus. */
export interface BarGeometry {
  /** Where the bar starts and ends, as x offsets from the origin of the bus node. */
  start: number;
  end: number;
  /** The taps on the bar, in ascending order of `x`. */
  taps: BarTap[];
}

/** How one connector is drawn. */
export interface ConnectorRoute {
  /** The points the connector runs through, in order from its source to its target. */
  points: Point[];
  /**
   * The side of the source it leaves by: the face of the device for a device
   * connector, the face or end of the bar for a branch.
   */
  sourceSide: Side;
  /** The face or end of the target's bar it lands on. */
  targetSide: Side;
}

export interface ConnectionLayout {
  /** The bar of every bus, by node id. */
  bars: Map<string, BarGeometry>;
  /** The route of every device connector and branch, by edge id. */
  routes: Map<string, ConnectorRoute>;
}

// ---- taps -------------------------------------------------------------------

/**
 * How firmly a tap holds the place it asks for. Of two that are too close
 * the one that holds less gives way, and two that hold alike share the move.
 *
 * - `free`: an end of a branch routed from where its buses sit, and the
 *   connector of a device beyond a tip of the bar. Either lands as well a
 *   little further along.
 * - `route`: an end of a stored route that has bends. Its first bend slides
 *   along with it.
 * - `square`: the connector of a device that stands over the bar, which
 *   drops square onto the bar at this place and at no other.
 * - `straight`: an end of a stored route that runs straight from one bar to
 *   the next. Moved, it would have to step across.
 */
export const TAP_HOLD = { free: 0, route: 1, square: 2, straight: 3 } as const;

/** Where one connection would like to land on a face. */
export interface TapWish {
  /** The position along the bar it asks for. */
  desired: number;
  /** How firmly it holds that place (`TAP_HOLD`). Default: `free`. */
  hold?: number;
  /**
   * Whether the connection would be up against something with its tap at
   * `x`: the run that moves along with the tap would come too near a bar
   * it is not connected to. Absent: it can stand anywhere.
   */
  blocked?: (x: number) => boolean;
}

/** Several wishes, next to each other in the order of a face, that ask for the very same place. */
interface SameSpot {
  /** The first of them, and the one after the last. */
  start: number;
  end: number;
  /** Where, among them, the ones that hold the place most stand on average. */
  middle: number;
  /**
   * Which of them may be the one that has the place, counted from `start`:
   * the one that has it unless something is in the way first.
   */
  keepers: number[];
}

/**
 * The neighbours among `wishes` that ask for the very same place, group by
 * group. Spread about their middle, an even number of them would stand
 * half a spacing either side of it; they stand whole spacings from it, so
 * one of them has the place. By default that is the one in the middle of
 * those that hold it most (the first of the two in the middle). Where all
 * hold it alike, any other of them may have it as well, as long as they
 * all stay between `lo` and `hi`: the nearer to the middle the sooner.
 */
function sameSpots(
  wishes: readonly TapWish[],
  lo: number,
  hi: number,
  spacing: number,
): SameSpot[] {
  const found: SameSpot[] = [];
  for (let start = 0, end = 1; start < wishes.length; start = end, end += 1) {
    const place = wishes[start]!.desired;
    while (end < wishes.length && Math.abs(wishes[end]!.desired - place) < 1e-9) end += 1;
    const count = end - start;
    if (count < 2) continue;
    const together = wishes.slice(start, end).map((wish) => wish.hold ?? TAP_HOLD.free);
    const most = Math.max(...together);
    const places = together.flatMap((hold, i) => (hold === most ? [i] : []));
    const middle = places.reduce((sum, i) => sum + i, 0) / places.length;
    const keepers = [Math.floor(middle)];
    if (places.length === count) {
      const fits = (keeper: number): boolean =>
        place - keeper * spacing >= lo - 1e-6 &&
        place + (count - 1 - keeper) * spacing <= hi + 1e-6;
      const others = together.map((_, i) => i).filter((i) => i !== keepers[0] && fits(i));
      others.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
      if (fits(keepers[0]!)) keepers.push(...others);
    }
    found.push({ start, end, middle, keepers });
  }
  return found;
}

/**
 * Positions for the taps of one face: as close to what each asks for as
 * `spacing` between neighbours allows, in the order given, and inside
 * `[lo, hi]` when they fit there. When they do not fit, they are centred on
 * the span and run over both ends alike (the caller sizes the bar so that
 * they fit). A tap that holds its place keeps it against the span as well:
 * the span widens to let it, and to let the ones it pushed aside stand
 * beside it.
 *
 * The least-squares answer among taps that hold alike: those that crowd
 * each other are spread about the middle of what they asked for. Among taps
 * that do not, the ones that hold most have their places and the rest are
 * spread from there.
 *
 * Several that ask for the very same place are the exception: one of them
 * has it, and the others stand whole spacings to either side (two at `x` and
 * `x + spacing`, not half a spacing either side of `x`). Whatever asked for
 * that place on the other face of the bar, however many, then stands in
 * line with them or a whole spacing away: the automatic layout runs every
 * branch of one side of a bus through the middle of that side, so the taps
 * of the two faces of a bar ask for one place more often than not. Which of
 * them has the place is the one in the middle, unless that leaves a tap
 * where its connection is up against something (`TapWish.blocked`): then
 * it is the one that leaves the fewest so.
 */
export function spreadTaps(
  wishes: readonly TapWish[],
  lo: number,
  hi: number,
  spacing: number = TAP_SPACING,
): number[] {
  if (wishes.length === 0) return [];
  const spots = sameSpots(wishes, lo, hi, spacing);
  const asked = wishes.map((wish) => wish.desired);
  // The one of a same spot that has the place stands on it, and the others
  // whole spacings from it: they all ask for the place moved by the part of
  // a spacing that their middle is off it.
  const give = (spot: SameSpot, keeper: number): void => {
    const place = wishes[spot.start]!.desired + (spot.middle - keeper) * spacing;
    for (let i = spot.start; i < spot.end; i += 1) asked[i] = place;
  };
  for (const spot of spots) give(spot, spot.keepers[0]!);
  let positions = spreadAsked(wishes, asked, lo, hi, spacing);
  const upAgainst = (at: readonly number[]): number =>
    wishes.reduce((count, wish, i) => count + (wish.blocked?.(at[i]!) === true ? 1 : 0), 0);
  let inTheWay = upAgainst(positions);
  for (const spot of spots) {
    if (inTheWay === 0) break;
    let kept = spot.keepers[0]!;
    for (const keeper of spot.keepers.slice(1)) {
      give(spot, keeper);
      const tried = spreadAsked(wishes, asked, lo, hi, spacing);
      const count = upAgainst(tried);
      if (count >= inTheWay) continue;
      [kept, positions, inTheWay] = [keeper, tried, count];
      if (count === 0) break;
    }
    give(spot, kept);
  }
  return positions;
}

/** `spreadTaps` for wishes whose places are `asked`, with their holds. */
function spreadAsked(
  wishes: readonly TapWish[],
  asked: readonly number[],
  lo: number,
  hi: number,
  spacing: number,
): number[] {
  const n = wishes.length;
  // With `q[i] = position[i] - i * spacing` the spacing rule reads "q never
  // falls", which is an isotonic regression: pool neighbours that break it.
  // A pool sits at the mean of what its members that hold most ask for
  // (`sum` over `weight` of them), which is where the weighted answer goes
  // as their weight grows without bound.
  const blocks: { hold: number; weight: number; sum: number; count: number }[] = [];
  let heldLo = Infinity;
  let heldHi = -Infinity;
  wishes.forEach((wish, i) => {
    const z = asked[i]! - i * spacing;
    const hold = wish.hold ?? TAP_HOLD.free;
    if (hold > TAP_HOLD.free) {
      heldLo = Math.min(heldLo, z);
      heldHi = Math.max(heldHi, z);
    }
    blocks.push({ hold, weight: 1, sum: z, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const before = blocks[blocks.length - 2]!;
      if (before.sum / before.weight <= last.sum / last.weight) break;
      if (last.hold > before.hold) {
        before.hold = last.hold;
        before.weight = last.weight;
        before.sum = last.sum;
      } else if (last.hold === before.hold) {
        before.weight += last.weight;
        before.sum += last.sum;
      }
      before.count += last.count;
      blocks.pop();
    }
  });
  let qLo = lo;
  let qHi = hi - (n - 1) * spacing;
  if (qHi < qLo) qLo = qHi = (qLo + qHi) / 2;
  qLo = Math.min(qLo, heldLo);
  qHi = Math.max(qHi, heldHi);
  const out: number[] = [];
  for (const block of blocks) {
    const q = Math.min(qHi, Math.max(qLo, block.sum / block.weight));
    for (let k = 0; k < block.count; k += 1) out.push(q + out.length * spacing);
  }
  return out;
}

/** The length a bar needs for `count` taps on one face. */
export function barLengthFor(count: number): number {
  return Math.max(0, count - 1) * TAP_SPACING + 2 * TAP_INSET;
}

// ---- routes -----------------------------------------------------------------

function isVertical(side: Side): boolean {
  return side === 'north' || side === 'south';
}

function sameX(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) <= EPS;
}

function sameY(a: Point, b: Point): boolean {
  return Math.abs(a[1] - b[1]) <= EPS;
}

/** `points` without the ones that repeat their neighbour or lie on a straight run. */
export function simplifyRoute(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last !== undefined && sameX(last, p) && sameY(last, p)) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const [a, b, c] = [out[i - 1]!, out[i]!, out[i + 1]!];
    if ((sameX(a, b) && sameX(b, c)) || (sameY(a, b) && sameY(b, c))) out.splice(i, 1);
  }
  return out;
}

/** `p` moved `distance` out of the side it leaves by. */
function outOf(p: Point, side: Side, distance: number): Point {
  switch (side) {
    case 'north':
      return [p[0], p[1] - distance];
    case 'south':
      return [p[0], p[1] + distance];
    case 'east':
      return [p[0] + distance, p[1]];
    case 'west':
      return [p[0] - distance, p[1]];
  }
}

/** Swap x and y, so the routing of two ends can be written once for both axes. */
function flip(p: Point): Point {
  return [p[1], p[0]];
}

const FLIPPED: Record<Side, Side> = { north: 'west', west: 'north', south: 'east', east: 'south' };

/**
 * A route with right angles from `a` to `b`, each left by the given side
 * (`north` and `south` are the faces of a bar, `east` and `west` its ends).
 *
 * Two faces that look at each other: straight down when the taps are in
 * line, otherwise down, across half way, and down. Two ends that look at
 * each other: the same, turned. The same face twice: out, across clear of
 * both bars, and back. A face and an end: one turn when the corner lies
 * ahead of both, otherwise out of each and round.
 */
export function stepRoute(a: Point, aSide: Side, b: Point, bSide: Side): Point[] {
  if (!isVertical(aSide) && !isVertical(bSide)) {
    return stepRoute(flip(a), FLIPPED[aSide], flip(b), FLIPPED[bSide]).map(flip);
  }
  if (isVertical(aSide) && isVertical(bSide)) {
    if (aSide === bSide) {
      const clear = BRIDGE_CLEARANCE[aSide];
      const y = aSide === 'north' ? Math.min(a[1], b[1]) - clear : Math.max(a[1], b[1]) + clear;
      return simplifyRoute([a, [a[0], y], [b[0], y], b]);
    }
    const down = aSide === 'south' ? 1 : -1;
    if ((b[1] - a[1]) * down > 0) {
      const y = (a[1] + b[1]) / 2;
      return simplifyRoute([a, [a[0], y], [b[0], y], b]);
    }
    // The one that leaves downwards sits below the other: out of each, and round.
    const clear = BRIDGE_CLEARANCE.north;
    const apart = Math.abs(a[0] - b[0]) > 2 * clear;
    const x = apart ? (a[0] + b[0]) / 2 : Math.max(a[0], b[0]) + BAR_LENGTH;
    const outA = outOf(a, aSide, clear);
    const outB = outOf(b, bSide, clear);
    return simplifyRoute([a, outA, [x, outA[1]], [x, outB[1]], outB, b]);
  }
  if (!isVertical(aSide)) return stepRoute(b, bSide, a, aSide).reverse();
  // `a` leaves a face and `b` an end.
  const ahead =
    (aSide === 'north' ? b[1] < a[1] : b[1] > a[1]) &&
    (bSide === 'east' ? a[0] > b[0] : a[0] < b[0]);
  if (ahead) return simplifyRoute([a, [a[0], b[1]], b]);
  const outA = outOf(a, aSide, BRIDGE_CLEARANCE[aSide]);
  const outB = outOf(b, bSide, BRIDGE_CLEARANCE[bSide]);
  return simplifyRoute([a, outA, [outB[0], outA[1]], outB, b]);
}

// ---- the pass ---------------------------------------------------------------

/** A bus's bar, in canvas coordinates. */
interface Bar {
  id: string;
  /** Origin of the bus node. */
  x: number;
  /** Centre of the bar. */
  cx: number;
  cy: number;
  /** Half the bar's length. */
  half: number;
  /** Its two tips: `half` either side of the centre, or further out to hold a tap. */
  start: number;
  end: number;
  /** Whether a connection runs into the west end, and into the east end. */
  westTaken: boolean;
  eastTaken: boolean;
}

/** A device's box, in canvas coordinates. */
interface Box {
  cx: number;
  cy: number;
  /** Half its width and half its height. */
  hw: number;
  hh: number;
}

/** One connection asking for a tap on a bar. */
interface Request {
  bar: Bar;
  /** The face (`north`, `south`) or end (`east`, `west`) of the bar it lands on. */
  side: Side;
  /** Where along the bar it comes from, which orders the taps of a face. */
  from: number;
  /** Orders two that come from the same place, and `tie` two that are still level. */
  rank: number;
  tie: number;
  /** The place it asks for and how firmly; read once every bar has its length. */
  wish: (bar: Bar) => TapWish;
  /** How firmly it holds its place (`TAP_HOLD`); set with the tap. */
  hold: number;
  /** Where it lands; set by the allocation. */
  tap: Point;
}

/** How a stored route leaves a bus. */
interface Terminal {
  /**
   * `face`: straight up or down from the bar. `end`: sideways out of one
   * of its ends. `free`: at an angle.
   */
  kind: 'face' | 'end' | 'free';
  side: Side;
  /** The x the route leaves the bar at (`face`), or heads for (`free`). */
  x: number;
  /** Whether the first bend can slide along the run after it, to follow a tap that moved. */
  slides: boolean;
  /** How far the first run goes before the route turns: the y of the first bend of a `face`. */
  reach: number;
  /**
   * Orders the routes that leave a face at one place (the automatic layout
   * runs every branch of one side of a bus through one port), so that they
   * part without crossing: the ones that turn left, then the ones that run
   * on, then the ones that turn right, and of two that turn the same way
   * the one that turns nearer the bar on the outside.
   */
  turn: number;
  /** Where the run after the first bend goes, which orders two that turn at one height. */
  towards: number;
}

/** More than any route runs before its first bend. */
const TURN_BASE = 1e7;

/**
 * The first and the last place along `bar` a face can have a tap: the
 * middle of each rounded tip, or one spacing in from an end that a
 * connection runs into, which lands on that very spot.
 */
function lo(bar: Bar): number {
  return bar.cx - bar.half + TAP_INSET + (bar.westTaken ? TAP_SPACING : 0);
}

function hi(bar: Bar): number {
  return bar.cx + bar.half - TAP_INSET - (bar.eastTaken ? TAP_SPACING : 0);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The face or end of `bar` that `box` comes at it from. A device beyond a
 * tip of the bar runs into that end while it is level with the bar: while
 * its box reaches the bar's height for a straight connector, and only while
 * its middle is within the bar's own thickness for an elbow, which
 * otherwise has room to turn and land square on a face.
 */
function deviceSide(box: Box, bar: Bar, style: ConnectorStyle): Side {
  const band = style === 'elbow' ? BAR_THICKNESS : box.hh + BAR_THICKNESS / 2;
  const level = Math.abs(box.cy - bar.cy) <= band;
  if (level && box.cx - box.hw >= bar.cx + bar.half) return 'east';
  if (level && box.cx + box.hw <= bar.cx - bar.half) return 'west';
  return box.cy <= bar.cy ? 'north' : 'south';
}

/** The middle of a face of `box`. */
function port(box: Box, face: Side): Point {
  switch (face) {
    case 'north':
      return [box.cx, box.cy - box.hh];
    case 'south':
      return [box.cx, box.cy + box.hh];
    case 'east':
      return [box.cx + box.hw, box.cy];
    case 'west':
      return [box.cx - box.hw, box.cy];
  }
}

/** A straight connector: from the face the line from the middle of `box` to `tap` crosses. */
function straightRoute(box: Box, tap: Point): { points: Point[]; face: Side } {
  const dx = tap[0] - box.cx;
  const dy = tap[1] - box.cy;
  const face: Side =
    Math.abs(dx) * box.hh > Math.abs(dy) * box.hw
      ? dx > 0
        ? 'east'
        : 'west'
      : dy > 0
        ? 'south'
        : 'north';
  return { points: [port(box, face), tap], face };
}

/** Whether the run from `a` to `b` passes through `box`, and not just along its edge. */
function runsThrough(a: Point, b: Point, box: Box): boolean {
  // The part of the run that is inside the box, as a range of the way along it.
  let from = 0;
  let to = 1;
  const within = (delta: number, near: number, far: number): boolean => {
    if (Math.abs(delta) < 1e-9) return near < 0 && far > 0;
    from = Math.max(from, Math.min(near / delta, far / delta));
    to = Math.min(to, Math.max(near / delta, far / delta));
    return from < to;
  };
  const hw = box.hw - EPS;
  const hh = box.hh - EPS;
  return (
    within(b[0] - a[0], box.cx - hw - a[0], box.cx + hw - a[0]) &&
    within(b[1] - a[1], box.cy - hh - a[1], box.cy + hh - a[1])
  );
}

/**
 * The connector of a device at `box` to its `tap`, which is on `side` of
 * `bar`.
 *
 * Into an end of the bar: straight, from the face that looks at it. Onto a
 * face: straight down (or up) when the device stands square over its tap.
 * Otherwise there are several ways, and the first that `blocked` does not
 * refuse is taken (the first of them all when it refuses every one):
 *
 * - for an elbow, sideways out of the device to over the tap and square
 *   onto the bar, where the tap is far enough aside for a run and a turn;
 * - for an elbow, from a device past the tip of the bar whose tap is the
 *   one at that tip (`atTip`), down to the bar's level and along it into
 *   the tip;
 * - the straight line from the face it crosses on its way from the middle
 *   of the device;
 * - the straight line from the face that looks at the bar, which is the way
 *   out from between two neighbours.
 */
function deviceRoute(
  box: Box,
  bar: Bar,
  side: Side,
  tap: Point,
  style: ConnectorStyle,
  atTip: boolean,
  blocked: (points: Point[]) => boolean,
): { points: Point[]; face: Side } {
  if (!isVertical(side)) {
    const face: Side = side === 'east' ? 'west' : 'east';
    return { points: [port(box, face), tap], face };
  }
  const dx = tap[0] - box.cx;
  const towardsBar: Side = side === 'north' ? 'south' : 'north';
  if (Math.abs(dx) <= EPS) return { points: [port(box, towardsBar), tap], face: towardsBar };
  const ways: { points: Point[]; face: Side }[] = [];
  if (style === 'elbow') {
    if (Math.abs(dx) >= box.hw + ELBOW_MIN_RUN) {
      const face: Side = dx > 0 ? 'east' : 'west';
      const from = port(box, face);
      ways.push({ points: [from, [tap[0], from[1]], tap], face });
    }
    const pastTip = box.cx > bar.end || box.cx < bar.start;
    const clearOfBar = Math.abs(box.cy - bar.cy) > box.hh + BAR_THICKNESS / 2;
    if (pastTip && clearOfBar && atTip) {
      ways.push({ points: [port(box, towardsBar), [box.cx, tap[1]], tap], face: towardsBar });
    }
  }
  const straight = straightRoute(box, tap);
  ways.push(straight);
  if (straight.face !== towardsBar) {
    ways.push({ points: [port(box, towardsBar), tap], face: towardsBar });
  }
  return ways.find((way) => !blocked(way.points)) ?? ways[0]!;
}

/**
 * How a stored route leaves `bar`, read from its first run. `points` starts
 * at the bus and is cut down in place when the route turns while it is
 * still over the bar: such a route leaves the bar by a face, at the turn.
 */
function readTerminal(points: Point[], bar: Bar): Terminal {
  while (
    points.length > 2 &&
    sameY(points[0]!, points[1]!) &&
    points[1]![0] > bar.cx - bar.half &&
    points[1]![0] < bar.cx + bar.half
  ) {
    points.shift();
  }
  const first = points[0]!;
  const next = points[1]!;
  const after = points[2];
  if (sameX(first, next) && !sameY(first, next)) {
    const slides = after !== undefined && sameY(next, after);
    const way = !slides || sameX(next, after) ? 0 : Math.sign(after[0] - next[0]);
    return {
      kind: 'face',
      side: next[1] < bar.cy ? 'north' : 'south',
      x: first[0],
      slides,
      reach: next[1],
      turn: way * (TURN_BASE - Math.abs(next[1] - first[1])),
      towards: slides ? after[0] : first[0],
    };
  }
  if (sameY(first, next) && !sameX(first, next)) {
    return {
      kind: 'end',
      side: next[0] >= bar.cx ? 'east' : 'west',
      x: first[0],
      slides: after !== undefined && sameX(next, after),
      reach: next[0],
      turn: 0,
      towards: first[0],
    };
  }
  return {
    kind: 'free',
    side: next[1] < bar.cy ? 'north' : 'south',
    x: next[0],
    slides: false,
    reach: next[1],
    turn: 0,
    towards: next[0],
  };
}

/** Put the first point of `points` on `tap`, and keep the first run square to the bar. */
function anchor(points: Point[], terminal: Terminal, tap: Point): void {
  const next = points[1]!;
  points[0] = tap;
  if (!terminal.slides) return;
  if (terminal.kind === 'face') points[1] = [tap[0], next[1]];
  else if (terminal.kind === 'end') points[1] = [next[0], tap[1]];
}

function pointsOf(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  return (value as [number, number][]).map((p): Point => [p[0], p[1]]);
}

function anchorsOf(value: unknown): { source: Anchor; target: Anchor } | null {
  if (value === null || typeof value !== 'object') return null;
  const { source, target } = value as { source?: Anchor; target?: Anchor };
  return source && target ? { source, target } : null;
}

interface Anchor {
  x: number;
  y: number;
}

function sits(at: { x: number; y: number }, anchorPoint: Anchor): boolean {
  return Math.abs(at.x - anchorPoint.x) < 0.01 && Math.abs(at.y - anchorPoint.y) < 0.01;
}

/** Whether two taps are too close: not in one place, and less than a spacing apart. */
function crowd(a: number, b: number): boolean {
  const apart = Math.abs(a - b);
  return apart > EPS && apart < TAP_SPACING - EPS;
}

/** What moving a tap costs for each unit, squared, by how firmly it holds its place (`TAP_HOLD`). */
const MOVE_COST = [1, 1e3, 1e6, 1e9];

/**
 * Places for the taps of one face (`moving`, in order along the bar) at
 * which none crowds a tap of the other face (`fixed`): each is in line with
 * one of those or a spacing clear of them all. The taps keep their order
 * and the spacing between them, stay within `[low, high]`, and move as
 * little as that allows, the ones that hold their place least first. `null`
 * when there are no such places.
 */
function clearOfFace(
  moving: readonly Request[],
  fixed: readonly number[],
  low: number,
  high: number,
): { cost: number; taps: number[] } | null {
  // A tap ends up where it is, in line with a tap of the other face, or a
  // whole number of spacings from one of those: as far as a neighbour or
  // the other face pushed it.
  const candidates: number[] = [];
  for (const base of [...moving.map((r) => r.tap[0]), ...fixed]) {
    for (let k = -moving.length; k <= moving.length; k += 1) {
      const x = base + k * TAP_SPACING;
      if (x < low - 1e-6 || x > high + 1e-6 || fixed.some((f) => crowd(f, x))) continue;
      candidates.push(x);
    }
  }
  candidates.sort((a, b) => a - b);
  const places = candidates.filter((x, i) => i === 0 || x - candidates[i - 1]! > 1e-6);
  // `cost[j][c]`: the least it costs to place the taps up to the `j`th with
  // that one at `places[c]`, and `before[j][c]` where the tap before it is
  // then: the cheapest place a spacing or more to its left.
  const cost: number[][] = [];
  const before: number[][] = [];
  moving.forEach((r, j) => {
    const weight = MOVE_COST[r.hold] ?? 1;
    const earlier = cost[j - 1];
    const row: number[] = [];
    const back: number[] = [];
    let least = earlier === undefined ? 0 : Infinity;
    let leastAt = -1;
    let reached = 0;
    places.forEach((x, c) => {
      for (; earlier !== undefined && places[reached]! <= x - TAP_SPACING + 1e-6; reached += 1) {
        if (earlier[reached]! < least) {
          least = earlier[reached]!;
          leastAt = reached;
        }
      }
      row[c] = least + weight * (x - r.tap[0]) ** 2;
      back[c] = leastAt;
    });
    cost.push(row);
    before.push(back);
  });
  const last = cost[moving.length - 1] ?? [];
  let at = -1;
  last.forEach((total, c) => {
    if (total < (at < 0 ? Infinity : last[at]!)) at = c;
  });
  if (at < 0) return null;
  const taps: number[] = [];
  for (let j = moving.length - 1, c = at; j >= 0; c = before[j]![c]!, j -= 1) taps[j] = places[c]!;
  return { cost: last[at]!, taps };
}

/**
 * Lay out every connection of the diagram: the bar of each bus with its
 * taps, and the route of each device connector and branch.
 *
 * `nodes` and `edges` are the diagram as `buildGraph` made it, with the
 * nodes where they are now. A device connector is an edge of type `stub`
 * from the device to its bus; any other edge between two buses is a branch,
 * and one that carries `data.bendPoints` with the `data.bendAnchors` its
 * buses still sit at keeps that route.
 */
export function layoutConnections(
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  options: ConnectionOptions = {},
): ConnectionLayout {
  const style = options.connectorStyle ?? DEFAULT_CONNECTOR_STYLE;
  const bars = new Map<string, Bar>();
  const boxes = new Map<string, Box>();
  const origins: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    if (node.type === 'bus') {
      const set = options.barLengths?.get(node.id);
      const length = set === undefined ? BAR_LENGTH : Math.max(MIN_BAR_LENGTH, set);
      const cx = node.position.x + BAR_LENGTH / 2;
      bars.set(node.id, {
        id: node.id,
        x: node.position.x,
        cx,
        cy: node.position.y + BAR_THICKNESS / 2,
        half: length / 2,
        start: cx - length / 2,
        end: cx + length / 2,
        westTaken: false,
        eastTaken: false,
      });
      origins[node.id] = node.position;
    } else {
      const size = options.sizes?.get(node.id);
      const width = size?.width ?? node.initialWidth ?? DEVICE_SIZE.width;
      const height = size?.height ?? node.initialHeight ?? DEVICE_SIZE.height;
      boxes.set(node.id, {
        cx: node.position.x + width / 2,
        cy: node.position.y + height / 2,
        hw: width / 2,
        hh: height / 2,
      });
    }
  }

  const requests: Request[] = [];
  const ask = (
    bar: Bar,
    side: Side,
    from: number,
    wish: (bar: Bar) => TapWish,
    order: { rank?: number; tie?: number } = {},
  ): Request => {
    const made: Request = {
      bar,
      side,
      from,
      rank: order.rank ?? 0,
      tie: order.tie ?? 0,
      wish,
      hold: TAP_HOLD.free,
      tap: [bar.cx, bar.cy],
    };
    requests.push(made);
    return made;
  };
  /** An end of the bar is one place: there is nothing to ask for. */
  const theEnd = (): TapWish => ({ desired: 0 });

  // ---- branches with a stored route ----
  interface Routed {
    edge: ConnectionEdge;
    points: Point[];
    /** One run, straight from a face of one bar to a face of the other. */
    straight: boolean;
    source: { terminal: Terminal; request: Request };
    target: { terminal: Terminal; request: Request };
  }
  const routed: Routed[] = [];
  const unrouted: { edge: ConnectionEdge; source: Bar; target: Bar }[] = [];
  const claimedEnds = new Set<string>();
  const stubs: { edge: ConnectionEdge; box: Box; bar: Bar }[] = [];

  // The bars by the height of their line, to find the ones an upright run passes.
  const barsByHeight = [...bars.values()].sort((a, b) => a.cy - b.cy);
  /**
   * Whether an upright run at `x`, from the height `from` to the height
   * `to`, comes nearer than `SLIDE_CLEARANCE` to a bar that is not one of
   * `own`.
   */
  const barInTheWay = (x: number, from: number, to: number, own: readonly Bar[]): boolean => {
    const top = Math.min(from, to) - SLIDE_CLEARANCE;
    const bottom = Math.max(from, to) + SLIDE_CLEARANCE;
    let first = 0;
    for (let last = barsByHeight.length; first < last; ) {
      const middle = (first + last) >> 1;
      if (barsByHeight[middle]!.cy <= top) first = middle + 1;
      else last = middle;
    }
    for (let i = first; i < barsByHeight.length && barsByHeight[i]!.cy < bottom; i += 1) {
      const bar = barsByHeight[i]!;
      if (own.includes(bar)) continue;
      if (x > bar.start - SLIDE_CLEARANCE && x < bar.end + SLIDE_CLEARANCE) return true;
    }
    return false;
  };

  // The end of a stored route stays where the route has it, and the others
  // make room; one drawn at an angle lands under where it heads.
  const routeEnd = (bar: Bar, other: Bar, terminal: Terminal, straight: boolean): Request => {
    if (terminal.kind === 'end') {
      claimedEnds.add(`${bar.id}|${terminal.side}`);
      return ask(bar, terminal.side, terminal.x, theEnd);
    }
    if (terminal.kind === 'free') {
      return ask(bar, terminal.side, terminal.x, (b) => ({
        desired: clamp(terminal.x, lo(b), hi(b)),
      }));
    }
    const hold = straight ? TAP_HOLD.straight : TAP_HOLD.route;
    // The run that moves along with the tap: as far as the first bend, or
    // all the way to the other bar. Where the route has it, it is clear.
    const moves = straight || terminal.slides;
    const reach = straight ? other.cy : terminal.reach;
    const blocked = (x: number): boolean =>
      moves && Math.abs(x - terminal.x) > EPS && barInTheWay(x, bar.cy, reach, [bar, other]);
    return ask(bar, terminal.side, terminal.x, () => ({ desired: terminal.x, hold, blocked }), {
      rank: terminal.turn,
      tie: terminal.towards,
    });
  };

  for (const edge of edges) {
    if (edge.type === 'stub') {
      const box = boxes.get(edge.source);
      const bar = bars.get(edge.target);
      if (box && bar) stubs.push({ edge, box, bar });
      continue;
    }
    const source = bars.get(edge.source);
    const target = bars.get(edge.target);
    if (!source || !target || source === target) continue;
    const stored = pointsOf(edge.data?.bendPoints);
    const anchors = anchorsOf(edge.data?.bendAnchors);
    const fits =
      stored !== null &&
      anchors !== null &&
      sits(origins[edge.source]!, anchors.source) &&
      sits(origins[edge.target]!, anchors.target);
    if (!fits) {
      unrouted.push({ edge, source, target });
      continue;
    }
    // Each end is read with the route turned to start at its bus.
    const sourceTerminal = readTerminal(stored, source);
    stored.reverse();
    const targetTerminal = readTerminal(stored, target);
    stored.reverse();
    const straight =
      stored.length === 2 && sourceTerminal.kind === 'face' && targetTerminal.kind === 'face';
    routed.push({
      edge,
      points: stored,
      straight,
      source: {
        terminal: sourceTerminal,
        request: routeEnd(source, target, sourceTerminal, straight),
      },
      target: {
        terminal: targetTerminal,
        request: routeEnd(target, source, targetTerminal, straight),
      },
    });
  }

  // ---- branches routed from where their buses sit ----
  const sides: Map<string, HandleAssignment> = assignBranchSides(
    unrouted.map(
      ({ edge }): BranchEnds => ({ id: edge.id, source: edge.source, target: edge.target }),
    ),
    Object.fromEntries([...bars.values()].map((bar) => [bar.id, { x: bar.cx, y: bar.cy }])),
    claimedEnds,
  );
  const stepped: { edge: ConnectionEdge; source: Request; target: Request }[] = [];
  for (const { edge, source, target } of unrouted) {
    const assigned = sides.get(edge.id);
    if (!assigned) continue;
    // Two faces that look at each other share a tap position where the two
    // bars overlap, so the branch runs straight; otherwise each end goes to
    // the tip of its bar nearest the other bus.
    const facing =
      isVertical(assigned.sourceSide) &&
      isVertical(assigned.targetSide) &&
      assigned.sourceSide !== assigned.targetSide;
    const wish = (own: Bar, other: Bar) => (): TapWish => {
      // Read when the bars have their final lengths.
      const low = Math.max(lo(own), lo(other));
      const high = Math.min(hi(own), hi(other));
      if (facing && low <= high) return { desired: (low + high) / 2 };
      return { desired: clamp(other.cx, lo(own), hi(own)) };
    };
    stepped.push({
      edge,
      source: ask(source, assigned.sourceSide, target.cx, wish(source, target)),
      target: ask(target, assigned.targetSide, source.cx, wish(target, source)),
    });
  }

  // ---- device connectors ----
  const connectors: { edge: ConnectionEdge; box: Box; request: Request }[] = [];
  // A device that sits level with a bar runs into its end, and an end takes
  // one connection: the nearest to level, unless a branch already has it.
  const wantsEnd = new Map<string, { box: Box; bar: Bar; edge: ConnectionEdge }[]>();
  const onFace = (edge: ConnectionEdge, box: Box, bar: Bar): void => {
    const left = box.cx < bar.cx;
    const off = Math.abs(box.cy - bar.cy);
    connectors.push({
      edge,
      box,
      request: ask(
        bar,
        box.cy <= bar.cy ? 'north' : 'south',
        box.cx,
        // Over the bar, or with its box over a tip of it, it drops square
        // onto the bar; further out it lands on the tip.
        (b) =>
          Math.abs(box.cx - b.cx) <= b.half + box.hw
            ? { desired: box.cx, hold: TAP_HOLD.square }
            : { desired: clamp(box.cx, lo(b), hi(b)) },
        // Of two devices beyond the same tip, the nearer takes the outer tap.
        { rank: left ? off : -off },
      ),
    });
  };
  for (const { edge, box, bar } of stubs) {
    const side = deviceSide(box, bar, style);
    if (isVertical(side)) {
      onFace(edge, box, bar);
      continue;
    }
    const key = `${bar.id}|${side}`;
    const list = wantsEnd.get(key);
    if (list) list.push({ box, bar, edge });
    else wantsEnd.set(key, [{ box, bar, edge }]);
  }
  const endTaken = new Set<string>(claimedEnds);
  for (const { source, target } of stepped) {
    if (!isVertical(source.side)) endTaken.add(`${source.bar.id}|${source.side}`);
    if (!isVertical(target.side)) endTaken.add(`${target.bar.id}|${target.side}`);
  }
  for (const [key, list] of wantsEnd) {
    list.sort((a, b) => Math.abs(a.box.cy - a.bar.cy) - Math.abs(b.box.cy - b.bar.cy));
    list.forEach(({ box, bar, edge }, i) => {
      if (i > 0 || endTaken.has(key)) {
        onFace(edge, box, bar);
        return;
      }
      const side: Side = key.endsWith('|east') ? 'east' : 'west';
      connectors.push({ edge, box, request: ask(bar, side, box.cx, theEnd) });
    });
  }

  // ---- size the bars, then hand out the taps ----
  const byFace = new Map<string, Request[]>();
  for (const r of requests) {
    if (!isVertical(r.side)) {
      if (r.side === 'east') r.bar.eastTaken = true;
      else r.bar.westTaken = true;
      continue;
    }
    const key = `${r.bar.id}|${r.side}`;
    const list = byFace.get(key);
    if (list) list.push(r);
    else byFace.set(key, [r]);
  }
  for (const list of byFace.values()) {
    const bar = list[0]!.bar;
    // Room for the taps of this face. Where an end is taken as well they do
    // not all fit between the two, run over both alike, and the bar is
    // brought out to them below.
    bar.half = Math.max(bar.half, barLengthFor(list.length) / 2);
  }
  for (const bar of bars.values()) {
    bar.start = bar.cx - bar.half;
    bar.end = bar.cx + bar.half;
  }
  for (const list of byFace.values()) {
    const bar = list[0]!.bar;
    // Stable: two that tie on every key keep the order they were asked in.
    list.sort((a, b) => a.from - b.from || a.rank - b.rank || a.tie - b.tie);
    const wishes = list.map((r) => r.wish(bar));
    const positions = spreadTaps(wishes, lo(bar), hi(bar));
    list.forEach((r, i) => {
      r.hold = wishes[i]!.hold ?? TAP_HOLD.free;
      r.tap = [positions[i]!, bar.cy];
    });
  }

  // ---- the two faces of a bar ----
  // A tap of one face that stands less than a spacing from a tap of the
  // other, and not on it, would have its dot run into that one's. The taps
  // of one of the two faces are then moved, each in line with a tap of the
  // other face or a spacing clear of them all: the face that it costs less
  // to move, and of two that cost the same the one with fewer taps.
  for (const bar of bars.values()) {
    const north = byFace.get(`${bar.id}|north`);
    const south = byFace.get(`${bar.id}|south`);
    if (!north || !south) continue;
    if (!north.some((n) => south.some((s) => crowd(n.tap[0], s.tap[0])))) continue;
    const at = (list: readonly Request[]): number[] => list.map((r) => r.tap[0]);
    const low = Math.min(lo(bar), ...at(north), ...at(south));
    const high = Math.max(hi(bar), ...at(north), ...at(south));
    const options = [
      { face: south, placed: clearOfFace(south, at(north), low, high) },
      { face: north, placed: clearOfFace(north, at(south), low, high) },
    ].filter((option) => option.placed !== null);
    options.sort((a, b) => a.placed!.cost - b.placed!.cost || a.face.length - b.face.length);
    const chosen = options[0];
    if (!chosen) continue;
    chosen.face.forEach((r, i) => {
      r.tap = [chosen.placed!.taps[i]!, bar.cy];
    });
  }

  // ---- straighten ----
  // A branch that would run straight down from one bar to the other, were
  // its two taps in line, has them brought in line where one of them is
  // free to move: within its bar, a spacing clear of the other taps of its
  // face, without changing places with any of them, and not to where it
  // would crowd a tap of the other face. The tap on the face with fewer
  // taps is the one that moves.
  const faceOf = (r: Request): Request[] => byFace.get(`${r.bar.id}|${r.side}`) ?? [];
  const acrossFrom = (r: Request): Request[] =>
    byFace.get(`${r.bar.id}|${r.side === 'north' ? 'south' : 'north'}`) ?? [];
  const canMoveTo = (r: Request, x: number): boolean => {
    if (x < lo(r.bar) - EPS || x > hi(r.bar) + EPS) return false;
    const [from, to] = [Math.min(r.tap[0], x), Math.max(r.tap[0], x)];
    return (
      faceOf(r).every(
        (q) =>
          q === r ||
          (Math.abs(q.tap[0] - x) >= TAP_SPACING - EPS && (q.tap[0] < from || q.tap[0] > to)),
      ) && acrossFrom(r).every((q) => !crowd(q.tap[0], x))
    );
  };
  const straighten = (a: Request, b: Request): void => {
    if (!isVertical(a.side) || !isVertical(b.side) || a.side === b.side) return;
    if (Math.abs(a.tap[0] - b.tap[0]) <= EPS) return;
    const [freer, other] = faceOf(a).length <= faceOf(b).length ? [a, b] : [b, a];
    if (canMoveTo(freer, other.tap[0])) freer.tap = [other.tap[0], freer.tap[1]];
    else if (canMoveTo(other, freer.tap[0])) other.tap = [freer.tap[0], other.tap[1]];
  };
  for (const { source, target } of stepped) straighten(source, target);
  for (const { straight, source, target } of routed) {
    if (straight) straighten(source.request, target.request);
  }

  // ---- the tips ----
  for (const { bar, side, tap } of requests) {
    if (!isVertical(side)) continue;
    // A tap that had to stay outside the bar takes the bar with it, and
    // keeps a spacing from an end that a connection runs into.
    bar.start = Math.min(bar.start, tap[0] - TAP_INSET - (bar.westTaken ? TAP_SPACING : 0));
    bar.end = Math.max(bar.end, tap[0] + TAP_INSET + (bar.eastTaken ? TAP_SPACING : 0));
  }
  for (const r of requests) {
    if (isVertical(r.side)) continue;
    r.tap = [r.side === 'east' ? r.bar.end - TAP_INSET : r.bar.start + TAP_INSET, r.bar.cy];
  }

  // ---- routes ----
  const routes = new Map<string, ConnectorRoute>();
  // Bring the first point of `points` onto the tap of that end. The run to
  // the first bend goes along with the tap, unless that takes it up against
  // a bar the branch is not connected to: then the run stays where the
  // route has it, and the branch steps across to its tap just outside its
  // own bar, where there is room for the step.
  const land = (
    points: Point[],
    { terminal, request }: { terminal: Terminal; request: Request },
    own: readonly Bar[],
  ): void => {
    const [from, bend] = [points[0]!, points[1]!];
    const tap = request.tap;
    const moved = terminal.kind === 'face' && terminal.slides && Math.abs(tap[0] - from[0]) > EPS;
    if (moved && barInTheWay(tap[0], tap[1], bend[1], own)) {
      const out = outOf(tap, terminal.side, BRIDGE_CLEARANCE[terminal.side]);
      const room = Math.abs(bend[1] - tap[1]) > BRIDGE_CLEARANCE[terminal.side] + EPS;
      if (room && !barInTheWay(tap[0], tap[1], out[1], own)) {
        points.splice(0, 1, tap, out, [from[0], out[1]]);
        return;
      }
    }
    anchor(points, terminal, tap);
  };
  for (const { edge, points, source, target } of routed) {
    const own = [source.request.bar, target.request.bar];
    land(points, source, own);
    points.reverse();
    land(points, target, own);
    points.reverse();
    let drawn = points;
    if (
      points.length === 2 &&
      !sameX(points[0]!, points[1]!) &&
      !sameY(points[0]!, points[1]!) &&
      source.terminal.kind !== 'free' &&
      target.terminal.kind !== 'free'
    ) {
      // A single run whose two taps are no longer in line: step across.
      drawn = stepRoute(points[0]!, source.request.side, points[1]!, target.request.side);
    }
    routes.set(edge.id, {
      points: simplifyRoute(drawn),
      sourceSide: source.request.side,
      targetSide: target.request.side,
    });
  }
  // The bars by the height of their line, to find the ones a run comes near.
  const barsByRow = new Map<number, Bar[]>();
  for (const bar of bars.values()) {
    const row = Math.round(bar.cy / RUN_CLEARANCE);
    const list = barsByRow.get(row);
    if (list) list.push(bar);
    else barsByRow.set(row, [bar]);
  }
  const barsAlong = (y: number, from: number, to: number, own: readonly Bar[]): Bar[] => {
    const row = Math.round(y / RUN_CLEARANCE);
    return [row - 1, row, row + 1]
      .flatMap((r) => barsByRow.get(r) ?? [])
      .filter(
        (bar) =>
          !own.includes(bar) &&
          Math.abs(bar.cy - y) < RUN_CLEARANCE &&
          bar.end > from &&
          bar.start < to,
      );
  };
  for (const { edge, source, target } of stepped) {
    let points = stepRoute(source.tap, source.side, target.tap, target.side);
    const [first, turn, back, last] = points;
    if (
      points.length === 4 &&
      first !== undefined &&
      turn !== undefined &&
      back !== undefined &&
      last !== undefined &&
      sameY(turn, back)
    ) {
      // The run across, half way between the two bars, may fall on the line
      // of a third bar that stands between them, where it would read as
      // part of that bar. It then runs clear above that bar.
      const from = Math.min(turn[0], back[0]);
      const to = Math.max(turn[0], back[0]);
      const own = [source.bar, target.bar];
      const low = Math.min(first[1], last[1]) + RUN_CLEARANCE;
      const high = Math.max(first[1], last[1]) - RUN_CLEARANCE;
      let y = turn[1];
      for (let tries = 0; tries < 4; tries += 1) {
        const inTheWay = barsAlong(y, from, to, own);
        if (inTheWay.length === 0) break;
        const above = Math.min(...inTheWay.map((bar) => bar.cy)) - RUN_CLEARANCE;
        const below = Math.max(...inTheWay.map((bar) => bar.cy)) + RUN_CLEARANCE;
        if (above > low) y = above;
        else if (below < high) y = below;
        else break;
      }
      if (y !== turn[1] && barsAlong(y, from, to, own).length === 0) {
        points = [first, [turn[0], y], [back[0], y], last];
      }
    }
    routes.set(edge.id, { points, sourceSide: source.side, targetSide: target.side });
  }
  // What a device connector keeps out of: every device and controller badge
  // but its own. They are kept in the order of their middles, so that a
  // connector is held against the ones along its way and not against every
  // box of the diagram.
  const inTheWay = [...boxes.values()].sort((a, b) => a.cx - b.cx);
  const widest = inTheWay.reduce((most, box) => Math.max(most, box.hw), 0);
  const blockedFor =
    (own: Box) =>
    (points: Point[]): boolean => {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const [left, right] = [Math.min(...xs), Math.max(...xs)];
      const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
      // The first box that reaches as far right as where the connector starts.
      let first = 0;
      for (let last = inTheWay.length; first < last; ) {
        const middle = (first + last) >> 1;
        if (inTheWay[middle]!.cx < left - widest) first = middle + 1;
        else last = middle;
      }
      for (let i = first; i < inTheWay.length && inTheWay[i]!.cx <= right + widest; i += 1) {
        const box = inTheWay[i]!;
        const apart =
          box === own ||
          box.cx + box.hw <= left ||
          box.cx - box.hw >= right ||
          box.cy + box.hh <= top ||
          box.cy - box.hh >= bottom;
        if (apart) continue;
        if (points.some((p, k) => k > 0 && runsThrough(points[k - 1]!, p, box))) return true;
      }
      return false;
    };
  // The outermost taps of each bar: a connector may run along the line of
  // the bar into a tip only to the tap that is first there.
  const outermost = new Map<Bar, { first: number; last: number }>();
  for (const r of requests) {
    const held = outermost.get(r.bar);
    if (held === undefined) outermost.set(r.bar, { first: r.tap[0], last: r.tap[0] });
    else {
      held.first = Math.min(held.first, r.tap[0]);
      held.last = Math.max(held.last, r.tap[0]);
    }
  }
  for (const { edge, box, request: asked } of connectors) {
    const { first, last } = outermost.get(asked.bar)!;
    const atTip = box.cx < asked.bar.cx ? asked.tap[0] <= first + EPS : asked.tap[0] >= last - EPS;
    const { points, face } = deviceRoute(
      box,
      asked.bar,
      asked.side,
      asked.tap,
      style,
      atTip,
      blockedFor(box),
    );
    routes.set(edge.id, { points, sourceSide: face, targetSide: asked.side });
  }

  // ---- bars ----
  const taps = new Map<string, BarTap[]>();
  for (const r of requests) {
    const tap: BarTap = { x: r.tap[0] - r.bar.x, side: r.side };
    const list = taps.get(r.bar.id);
    if (list) list.push(tap);
    else taps.set(r.bar.id, [tap]);
  }
  const out = new Map<string, BarGeometry>();
  for (const bar of bars.values()) {
    out.set(bar.id, {
      start: bar.start - bar.x,
      end: bar.end - bar.x,
      taps: (taps.get(bar.id) ?? []).sort((a, b) => a.x - b.x),
    });
  }
  return { bars: out, routes };
}

/**
 * The first and the last place along a bar where a face can have a tap, as
 * x offsets from the origin of the bus node: the middle of each rounded
 * tip, or one spacing in from an end that a connection runs into.
 */
export function faceSpan(bar: BarGeometry): { lo: number; hi: number } {
  const taken = (end: Side): number => (bar.taps.some((tap) => tap.side === end) ? TAP_SPACING : 0);
  return {
    lo: bar.start + TAP_INSET + taken('west'),
    hi: bar.end - TAP_INSET - taken('east'),
  };
}

/** How far the label of a bus keeps from a connector that lands beside it. */
const LABEL_CLEARANCE = 4;

/**
 * Where the label of a bus hangs under its bar: the x of its middle, as an
 * offset from the origin of the bus node, for a label `width` wide.
 *
 * Under the middle of the bar when no connector comes down through it
 * there. Otherwise in the gap between two connectors of the south face
 * that is nearest the middle and wide enough, or beside the outermost one,
 * so a line never runs through the name and the values of a bus.
 */
export function busLabelOffset(bar: BarGeometry | undefined, width: number): number {
  const middle = BAR_LENGTH / 2;
  if (!bar) return middle;
  const lines = bar.taps.filter((tap) => tap.side === 'south').map((tap) => tap.x);
  const reach = width / 2 + LABEL_CLEARANCE;
  if (lines.every((x) => Math.abs(x - middle) >= reach)) return middle;
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  const spots = [first - reach, last + reach];
  for (let i = 1; i < lines.length; i += 1) {
    const from = lines[i - 1]! + reach;
    const to = lines[i]! - reach;
    if (from <= to) spots.push(clamp(middle, from, to));
  }
  // Nearest the middle; of two equally near, the one to the left.
  return spots.reduce((best, x) => {
    const nearer = Math.abs(x - middle) - Math.abs(best - middle);
    return nearer < -EPS || (Math.abs(nearer) <= EPS && x < best) ? x : best;
  });
}

/**
 * The point half way along `points`, and the direction of the run it is on
 * (degrees, clockwise from +x).
 */
export function routeMidpoint(points: readonly Point[]): {
  x: number;
  y: number;
  angleDeg: number;
} {
  const first = points[0];
  if (first === undefined) return { x: 0, y: 0, angleDeg: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  if (total === 0) return { x: first[0], y: first[1], angleDeg: 0 };
  let travelled = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > 0 && travelled + length >= total / 2) {
      const t = (total / 2 - travelled) / length;
      return {
        x: a[0] + t * (b[0] - a[0]),
        y: a[1] + t * (b[1] - a[1]),
        angleDeg: (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI,
      };
    }
    travelled += length;
  }
  const last = points[points.length - 1]!;
  return { x: last[0], y: last[1], angleDeg: 0 };
}

/** The SVG path through `points`: straight runs, square corners. */
export function routePath(points: readonly Point[]): string {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
}
