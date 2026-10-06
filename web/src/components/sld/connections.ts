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
 *   otherwise. A device that sits level with the bar, beyond one of its
 *   ends, runs straight into that end. An end of the bar is the middle of
 *   its rounded tip (`TAP_INSET` in), so a connection lands on the bar and
 *   not on its corner.
 * - The taps of one face keep `TAP_SPACING` between them (`spreadTaps`).
 *   Two faces do not compete: a generator above a bar and a load below it
 *   may share a tap. A bar that has no room for the taps of a face grows,
 *   about its middle, until it has.
 * - A device has a port at the middle of each of its four faces. Its
 *   connector leaves from the port on the face that points at its tap, so
 *   never from a corner and never from the far side.
 * - A device connector is a straight line (`straight`), which is a diagonal
 *   when the device does not sit square to its tap, or one horizontal and
 *   one vertical run with a right angle between them (`elbow`).
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

/** The length a bar is drawn at unless its taps need more, which is also the width of a bus node. */
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
 * so that it is not taken for part of that bar.
 */
const RUN_CLEARANCE = 16;

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

/** Where one connection would like to land on a face. */
export interface TapWish {
  /** The position along the bar it asks for. */
  desired: number;
  /**
   * `true` for the end of a stored route, which stays where the route has
   * it: the others make room.
   */
  pinned?: boolean;
}

const PINNED_WEIGHT = 1e6;

/**
 * Positions for the taps of one face: as close to what each asks for as
 * `spacing` between neighbours allows, in the order given, and inside
 * `[lo, hi]` when they fit there. When they do not fit, they are centred on
 * the span and run over both ends alike (the caller sizes the bar so that
 * they fit). A pinned tap keeps its place; one that sits outside the span
 * widens it.
 *
 * The least-squares answer: taps that crowd each other are spread about the
 * middle of what they asked for, so two that ask for the same spot end up
 * half a spacing either side of it.
 */
export function spreadTaps(
  wishes: readonly TapWish[],
  lo: number,
  hi: number,
  spacing: number = TAP_SPACING,
): number[] {
  const n = wishes.length;
  if (n === 0) return [];
  // With `q[i] = position[i] - i * spacing` the spacing rule reads "q never
  // falls", which is an isotonic regression: pool neighbours that break it.
  const blocks: { weight: number; sum: number; count: number }[] = [];
  let pinnedLo = Infinity;
  let pinnedHi = -Infinity;
  wishes.forEach((wish, i) => {
    const z = wish.desired - i * spacing;
    const weight = wish.pinned ? PINNED_WEIGHT : 1;
    if (wish.pinned) {
      pinnedLo = Math.min(pinnedLo, z);
      pinnedHi = Math.max(pinnedHi, z);
    }
    blocks.push({ weight, sum: weight * z, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const before = blocks[blocks.length - 2]!;
      if (before.sum / before.weight <= last.sum / last.weight) break;
      before.weight += last.weight;
      before.sum += last.sum;
      before.count += last.count;
      blocks.pop();
    }
  });
  let qLo = lo;
  let qHi = hi - (n - 1) * spacing;
  if (qHi < qLo) qLo = qHi = (qLo + qHi) / 2;
  qLo = Math.min(qLo, pinnedLo);
  qHi = Math.max(qHi, pinnedHi);
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
  /** Tips the bar reaches beyond `half` to hold a pinned tap. */
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
  /** Orders two that come from the same place. */
  rank: number;
  /** The position it asks for; set once every bar has its length. */
  desired: (bar: Bar) => number;
  pinned: boolean;
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
}

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

/**
 * The connector of a device at `box` to its `tap`, which is on `side` of
 * `bar`.
 *
 * Into an end of the bar: straight, from the face that looks at it. Onto a
 * face: straight down (or up) when the device stands square over its tap.
 * Otherwise a straight line, or for an elbow one right angle: sideways out
 * of the device to over the tap and square onto the bar, or, for a device
 * past the tip of the bar with its tap too close for that, down to the
 * bar's level and along it into the tip. Where neither turn has room the
 * elbow is drawn straight too.
 */
function deviceRoute(
  box: Box,
  bar: Bar,
  side: Side,
  tap: Point,
  style: ConnectorStyle,
): { points: Point[]; face: Side } {
  if (!isVertical(side)) {
    const face: Side = side === 'east' ? 'west' : 'east';
    return { points: [port(box, face), tap], face };
  }
  const dx = tap[0] - box.cx;
  const towardsBar: Side = side === 'north' ? 'south' : 'north';
  if (Math.abs(dx) <= EPS) return { points: [port(box, towardsBar), tap], face: towardsBar };
  if (style === 'elbow') {
    if (Math.abs(dx) >= box.hw + ELBOW_MIN_RUN) {
      const face: Side = dx > 0 ? 'east' : 'west';
      const from = port(box, face);
      return { points: [from, [tap[0], from[1]], tap], face };
    }
    const pastTip = box.cx > bar.end || box.cx < bar.start;
    const clearOfBar = Math.abs(box.cy - bar.cy) > box.hh + BAR_THICKNESS / 2;
    if (pastTip && clearOfBar) {
      return { points: [port(box, towardsBar), [box.cx, tap[1]], tap], face: towardsBar };
    }
  }
  return straightRoute(box, tap);
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
    return {
      kind: 'face',
      side: next[1] < bar.cy ? 'north' : 'south',
      x: first[0],
      slides: after !== undefined && sameY(next, after),
    };
  }
  if (sameY(first, next) && !sameX(first, next)) {
    return {
      kind: 'end',
      side: next[0] >= bar.cx ? 'east' : 'west',
      x: first[0],
      slides: after !== undefined && sameX(next, after),
    };
  }
  return { kind: 'free', side: next[1] < bar.cy ? 'north' : 'south', x: next[0], slides: false };
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
    desired: (bar: Bar) => number,
    extra: { rank?: number; pinned?: boolean } = {},
  ): Request => {
    const made: Request = {
      bar,
      side,
      from,
      rank: extra.rank ?? 0,
      desired,
      pinned: extra.pinned ?? false,
      tap: [bar.cx, bar.cy],
    };
    requests.push(made);
    return made;
  };

  // ---- branches with a stored route ----
  interface Routed {
    edge: ConnectionEdge;
    points: Point[];
    source: { terminal: Terminal; request: Request };
    target: { terminal: Terminal; request: Request };
  }
  const routed: Routed[] = [];
  const unrouted: { edge: ConnectionEdge; source: Bar; target: Bar }[] = [];
  const claimedEnds = new Set<string>();
  const stubs: { edge: ConnectionEdge; box: Box; bar: Bar }[] = [];

  const routeEnd = (points: Point[], bar: Bar): { terminal: Terminal; request: Request } => {
    const terminal = readTerminal(points, bar);
    if (terminal.kind === 'end') {
      claimedEnds.add(`${bar.id}|${terminal.side}`);
      return { terminal, request: ask(bar, terminal.side, terminal.x, () => 0) };
    }
    const pinned = terminal.kind === 'face';
    return {
      terminal,
      request: ask(
        bar,
        terminal.side,
        terminal.x,
        pinned ? () => terminal.x : (b) => clamp(terminal.x, lo(b), hi(b)),
        { pinned },
      ),
    };
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
    const sourceEnd = routeEnd(stored, source);
    stored.reverse();
    const targetEnd = routeEnd(stored, target);
    stored.reverse();
    routed.push({ edge, points: stored, source: sourceEnd, target: targetEnd });
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
    const wish = (own: Bar, other: Bar) => (): number => {
      // Read when the bars have their final lengths.
      const low = Math.max(lo(own), lo(other));
      const high = Math.min(hi(own), hi(other));
      if (facing && low <= high) return (low + high) / 2;
      return clamp(other.cx, lo(own), hi(own));
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
        (b) => clamp(box.cx, lo(b), hi(b)),
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
      connectors.push({ edge, box, request: ask(bar, side, box.cx, () => 0) });
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
    // Room for the taps of this face, and for the ends a connection runs into.
    const ends = (bar.westTaken ? 1 : 0) + (bar.eastTaken ? 1 : 0);
    bar.half = Math.max(bar.half, (barLengthFor(list.length) + ends * TAP_SPACING) / 2);
  }
  for (const bar of bars.values()) {
    bar.start = bar.cx - bar.half;
    bar.end = bar.cx + bar.half;
  }
  for (const list of byFace.values()) {
    const bar = list[0]!.bar;
    // Stable: two that tie on both keys keep the order they were asked in.
    list.sort((a, b) => a.from - b.from || a.rank - b.rank);
    const positions = spreadTaps(
      list.map((r) => ({ desired: r.desired(bar), pinned: r.pinned })),
      lo(bar),
      hi(bar),
    );
    list.forEach((r, i) => {
      r.tap = [positions[i]!, bar.cy];
      // A tap that had to stay outside the bar takes the bar with it.
      bar.start = Math.min(bar.start, r.tap[0] - TAP_INSET);
      bar.end = Math.max(bar.end, r.tap[0] + TAP_INSET);
    });
  }
  for (const r of requests) {
    if (isVertical(r.side)) continue;
    r.tap = [r.side === 'east' ? r.bar.end - TAP_INSET : r.bar.start + TAP_INSET, r.bar.cy];
  }

  // ---- routes ----
  const routes = new Map<string, ConnectorRoute>();
  for (const { edge, points, source, target } of routed) {
    anchor(points, source.terminal, source.request.tap);
    points.reverse();
    anchor(points, target.terminal, target.request.tap);
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
  for (const { edge, box, request: asked } of connectors) {
    const { points, face } = deviceRoute(box, asked.bar, asked.side, asked.tap, style);
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

/** The point half way along `points`, and the direction of the run it is on (degrees, clockwise from +x). */
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
