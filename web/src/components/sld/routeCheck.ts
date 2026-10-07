/**
 * Whether a route that is being drawn by hand is clear of the rest of the
 * diagram: the rule that nothing is drawn over anything else
 * (`overlapCheck.ts`), asked of one line while it is moved.
 *
 * `routeChecker` reads the diagram as it is drawn now (`drawnDiagram` of
 * its picture) and answers a check for one of its lines. The check takes
 * the points the line would run through and says what stands in the way,
 * in words for the user, or `null` when nothing does:
 *
 * - another line it would lie on, run too close beside, or end or turn on
 *   (two lines that cross are a crossing, and no overlap);
 * - the end of another line on the same bar, nearer than the taps keep;
 * - a bar it would run through or along, its own included, and an end that
 *   would leave its bar;
 * - a symbol, a control chain that is drawn out, the label of a bus, the
 *   values of a device or the flow label of another line it would run
 *   through, or pass nearer than a line the diagram routes itself does
 *   (`HAND_CLEARANCE` from a symbol, a chain and a bar that is not its own,
 *   `HAND_LABEL_CLEARANCE` from a label and a readout), so that a line put
 *   at the nearest clear place does not touch what it was moved off;
 * - for the connector of a device, its own symbol: it leaves by the middle
 *   of a face, square out of it or at an angle, and no later run of it comes
 *   back along the edge of the symbol (`onOwnSymbol`);
 * - itself: a route does not fold back on itself (`routeFolds`);
 * - for a transformer, a route with no straight stretch where its symbol
 *   has room.
 *
 * What goes with the line itself is not held against it, because the
 * diagram places it again once the line is where it was put: its own flow
 * label, the symbol of the transformer, and the values of the device a
 * connector belongs to. What the line was on already before it was touched
 * (a layout that was saved that way) is not held against it either, and
 * where it already passes something nearer than the room it would keep, it
 * may stay that near, and come no nearer.
 *
 * It looks only at what is near the line, so it can be asked at every move
 * of the pointer, and several times over to find the nearest place that is
 * clear. It is not the last word: the canvas asks the whole picture once
 * more before it keeps a route (`routesDrawClear`), since the taps of a bar
 * and the labels around the line are worked out with the route in place.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_THICKNESS,
  OWN_SYMBOL_ROOM,
  TRANSFORMER_SYMBOL_SIZE,
  labelBoxAt,
  onOwnSymbol,
  routeFolds,
  type ConnectionEdge,
  type NodeSize,
  type Point,
  type Rect,
} from './connections';
import { placeTransformerSymbols, type LabelNode } from './labels';
import {
  findOverlaps,
  lengthInside,
  type DrawnBar,
  type DrawnBox,
  type DrawnDiagram,
  type DrawnLine,
  type Overlap,
} from './overlapCheck';
import { drawnDiagram, type Picture, type PictureOptions } from './picture';

/** What stands in the way of a route, in words; `null` when it is clear. */
export type RouteCheck = (points: readonly Point[]) => string | null;

export interface RouteCheckOptions {
  /** The measured size of each node, by id. */
  sizes?: ReadonlyMap<string, NodeSize>;
  /** Whether the values of a power flow show: the readouts and the flow labels are then in the way too. */
  values: boolean;
  labelWidths?: PictureOptions['labelWidths'];
}

/** How far around a route the check looks: more than any rule of the checker reaches. */
const REACH = 32;

/**
 * The room a route that is moved by hand keeps to a symbol, to a control
 * chain that is drawn out and to a bar it does not end on: what the router
 * keeps to a device (`DEVICE_CLEARANCE` in `tidy.ts`). The overlap checker
 * itself asks for less (a line may not run through a box, and passes a bar
 * `BAR_CLEAR` off), which is the least a diagram may be drawn with and too
 * near for the place a line is taken to when it is refused another.
 */
export const HAND_CLEARANCE = 8;

/**
 * The same room to the label of a bus, to the values of a device and to the
 * flow label of another line. Those are placed again around the lines once
 * the route is kept, so less does: as much as the values keep to the symbol
 * they stand beside.
 */
export const HAND_LABEL_CLEARANCE = 4;

/** Two distances closer than this are the same. */
const EPS = 0.5;

/** `rect` with `by` more room on every side. */
function grown(rect: Rect, by: number): Rect {
  return {
    left: rect.left - by,
    right: rect.right + by,
    top: rect.top - by,
    bottom: rect.bottom + by,
  };
}

/** Whether a run of `points`, from the run `first` to the run `last`, comes within `room` of `rect`. */
function comesNear(
  points: readonly Point[],
  rect: Rect,
  room: number,
  first = 1,
  last = points.length - 1,
): boolean {
  const reach = grown(rect, room - EPS);
  for (let k = first; k <= last; k += 1) {
    if (lengthInside(points[k - 1]!, points[k]!, reach) > 0) return true;
  }
  return false;
}

/**
 * The room the route `points` keeps to `rect` as it is, up to `most`: the
 * most room it could be asked to keep without being refused where it is.
 */
function roomKept(
  points: readonly Point[],
  rect: Rect,
  most: number,
  first = 1,
  last = points.length - 1,
): number {
  if (!comesNear(points, rect, most, first, last)) return most;
  let [low, high] = [0, most];
  for (let step = 0; step < 6; step += 1) {
    const middle = (low + high) / 2;
    if (comesNear(points, rect, middle, first, last)) high = middle;
    else low = middle;
  }
  return low;
}

function boxOf(points: readonly Point[], by: number): Rect {
  const box: Rect = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  for (const [x, y] of points) {
    box.left = Math.min(box.left, x - by);
    box.right = Math.max(box.right, x + by);
    box.top = Math.min(box.top, y - by);
    box.bottom = Math.max(box.bottom, y + by);
  }
  return box;
}

function meet(a: Rect, b: Rect): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

/** What an element of the diagram is called in a notice. */
function namer(
  nodes: readonly LabelNode[],
  edges: readonly ConnectionEdge[],
): (id: string) => string {
  const nodeName = new Map<string, string>();
  for (const node of nodes) {
    const data = (node.data ?? {}) as { name?: unknown; idx?: unknown };
    const name =
      typeof data.name === 'string' && data.name !== ''
        ? data.name
        : typeof data.idx === 'string'
          ? data.idx
          : node.id;
    nodeName.set(node.id, name);
  }
  const edgeName = new Map<string, string>();
  for (const edge of edges) {
    const data = (edge.data ?? {}) as { name?: unknown; idx?: unknown };
    const name =
      typeof data.name === 'string' && data.name !== ''
        ? data.name
        : typeof data.idx === 'string'
          ? data.idx
          : edge.id;
    edgeName.set(
      edge.id,
      edge.type === 'stub'
        ? `the connector of ${nodeName.get(edge.source) ?? name}`
        : `${edge.type === 'transformer' ? 'transformer' : 'line'} ${name}`,
    );
  }
  const prefixed: [string, (name: string) => string][] = [
    ['label:', (name) => `the label of bus ${name}`],
    ['readout:', (name) => `the values of ${name}`],
    ['chain:', (name) => `the control chain of ${name}`],
    ['marker:', (name) => `the limit mark of ${name}`],
  ];
  return (id) => {
    const edge = edgeName.get(id);
    if (edge !== undefined) return edge;
    if (id.startsWith('flow:')) return `the flow label of ${edgeName.get(id.slice(5)) ?? 'a line'}`;
    if (id.startsWith('symbol:')) {
      return `the symbol of ${edgeName.get(id.slice(7)) ?? 'a transformer'}`;
    }
    for (const [prefix, say] of prefixed) {
      if (id.startsWith(prefix)) return say(nodeName.get(id.slice(prefix.length)) ?? 'a device');
    }
    const node = nodes.find((n) => n.id === id);
    if (node === undefined) return 'something else';
    const name = nodeName.get(id)!;
    return (node.type ?? 'bus') === 'bus' ? `the bar of bus ${name}` : `the symbol of ${name}`;
  };
}

/** `overlap`, which the line `id` has a part in, as what stands in its way. */
function inWords(overlap: Overlap, id: string, nameOf: (id: string) => string): string {
  const other = nameOf(overlap.a === id ? overlap.b : overlap.a);
  switch (overlap.kind) {
    case 'line-line':
      if (overlap.detail.startsWith('lie on')) return `it would lie on ${other}`;
      if (overlap.detail.startsWith('run')) return `it would run too close beside ${other}`;
      return `it would end or turn on ${other}`;
    case 'shared-tap':
      return `its end would be too close to the end of ${other}`;
    case 'loose-end':
      return `its end would leave ${other}`;
    case 'line-bar':
      return overlap.detail.startsWith('leaves')
        ? `it would leave ${other} in line with it`
        : `it would run through or along ${other}`;
    case 'line-box':
      return `it would run through ${other}`;
    default:
      return `it would be on ${other}`;
  }
}

/** What the connector of a device is refused for by its own symbol (`onOwnSymbol`). */
const OWN_SYMBOL: Record<NonNullable<ReturnType<typeof onOwnSymbol>>, string> = {
  through: 'it would run through its own symbol',
  along: 'it would run along the edge of its own symbol and not leave it',
  beside: 'it would run right beside its own symbol',
};

/**
 * A check of the routes the line `edge` could be given, on the diagram
 * whose nodes are `nodes` and whose picture is `picture`.
 */
export function routeChecker<E extends ConnectionEdge>(
  nodes: readonly LabelNode[],
  picture: Picture<E>,
  edge: ConnectionEdge,
  options: RouteCheckOptions,
): RouteCheck {
  const drawn: DrawnDiagram = drawnDiagram(nodes, picture, options);
  const id = edge.id;
  const nameOf = namer(nodes, picture.edges);
  const ownSymbol = `symbol:${id}`;
  // What goes with the line and is placed again once it has its route.
  const placedAgain = new Set([`flow:${id}`, ownSymbol, `readout:${edge.source}`]);
  const others: { line: DrawnLine; box: Rect }[] = drawn.lines
    .filter((line) => line.id !== id)
    .map((line) => ({ line, box: boxOf(line.points, 0) }));
  const bars: { bar: DrawnBar; box: Rect }[] = drawn.bars.map((bar) => ({
    bar,
    box: { left: bar.left, right: bar.right, top: bar.y, bottom: bar.y },
  }));
  const boxes = drawn.boxes.filter((box) => !placedAgain.has(box.id));
  // What a symbol keeps off: the symbols and the chains, not the labels,
  // which are placed around it afterwards.
  const standing = boxes.filter((box) => box.kind === 'symbol' || box.kind === 'block');
  const own =
    edge.type === 'stub' ? drawn.boxes.find((box) => box.id === edge.source)?.box : undefined;
  const isTransformer = edge.type === 'transformer';

  /** What is on what with the line drawn through `points`, of what the line has a part in. */
  const overlapsOf = (points: readonly Point[]): Overlap[] => {
    const reach = boxOf(points, REACH);
    const mine: DrawnLine = { id, points, from: edge.source, to: edge.target };
    const lines = others.filter(({ box }) => meet(box, reach)).map(({ line }) => line);
    const near: DrawnDiagram = {
      lines: [...lines, mine],
      bars: bars.filter(({ box }) => meet(box, reach)).map(({ bar }) => bar),
      boxes: boxes.filter(({ box }) => meet(box, reach)),
    };
    const found = findOverlaps(near).filter((overlap) => overlap.a === id || overlap.b === id);
    if (found.length > 0 || !isTransformer) return found;
    // The symbol of the transformer, where the diagram would put it on this
    // route: it needs a straight stretch where it is on nothing.
    const routes = new Map(picture.connections.routes);
    const held = routes.get(id);
    routes.set(id, {
      points: points.map(([x, y]): Point => [x, y]),
      sourceSide: held?.sourceSide ?? 'south',
      targetSide: held?.targetSide ?? 'north',
    });
    const place = placeTransformerSymbols(
      nodes,
      [edge],
      { bars: picture.connections.bars, routes },
      options.sizes ?? new Map(),
      standing
        .filter((box) => box.id.startsWith('symbol:') || box.kind === 'block')
        .map(({ box }) => box),
    ).get(id);
    if (place === undefined) return found;
    const symbol: DrawnBox = {
      id: ownSymbol,
      kind: 'symbol',
      box: labelBoxAt(place, TRANSFORMER_SYMBOL_SIZE, TRANSFORMER_SYMBOL_SIZE),
      of: [id],
    };
    const around = boxOf(
      [
        [symbol.box.left, symbol.box.top],
        [symbol.box.right, symbol.box.bottom],
      ],
      REACH,
    );
    return findOverlaps({
      lines: [...lines, mine],
      bars: near.bars,
      boxes: [...standing.filter(({ box }) => meet(box, around)), symbol],
    }).filter((overlap) => overlap.a === ownSymbol || overlap.b === ownSymbol);
  };
  const keyOf = ({ kind, a, b }: Overlap): string => `${kind}|${a}|${b}`;
  // What the line is on as it is drawn now is not held against a move of it.
  const now = drawn.lines.find((line) => line.id === id)?.points;
  const known = new Set((now === undefined ? [] : overlapsOf(now)).map(keyOf));

  // ---- the room it keeps ----
  // To every box that is not its own and to every bar it does not end on;
  // where it is nearer than that as it is drawn now, as near as it is.
  const roomOf = ({ kind }: DrawnBox): number =>
    kind === 'symbol' || kind === 'block' ? HAND_CLEARANCE : HAND_LABEL_CLEARANCE;
  // Not to what a line may run through by the rule itself (what it is drawn
  // from and to, and what is drawn on it), and not to the label of a bus it
  // ends on, which is placed again around the ends on its bar.
  const apart = boxes.filter(
    (box) =>
      box.id !== edge.source &&
      box.id !== edge.target &&
      box.of?.includes(id) !== true &&
      box.id !== `label:${edge.source}` &&
      box.id !== `label:${edge.target}`,
  );
  const boxRoom = new Map<string, number>();
  const barRoom = new Map<string, number>();
  const bodyOf = (bar: DrawnBar): Rect => ({
    left: bar.left,
    right: bar.right,
    top: bar.y - BAR_THICKNESS / 2,
    bottom: bar.y + BAR_THICKNESS / 2,
  });
  /** The runs of a route through `points` that do not land on `bar`: the first, and the last. */
  const passing = (bar: DrawnBar, points: readonly Point[]): [number, number] => [
    edge.source === bar.id ? 2 : 1,
    points.length - 1 - (edge.target === bar.id ? 1 : 0),
  ];
  if (now !== undefined) {
    const around = boxOf(now, REACH);
    for (const box of apart) {
      if (meet(box.box, around)) boxRoom.set(box.id, roomKept(now, box.box, roomOf(box)));
    }
    for (const { bar, box } of bars) {
      if (!meet(box, around)) continue;
      barRoom.set(bar.id, roomKept(now, bodyOf(bar), HAND_CLEARANCE, ...passing(bar, now)));
    }
  }
  /** What the line through `points` would pass too near, in words; `null` when it keeps its room. */
  const tooNear = (points: readonly Point[]): string | null => {
    const around = boxOf(points, REACH);
    for (const box of apart) {
      if (!meet(box.box, around)) continue;
      const room = boxRoom.get(box.id) ?? roomOf(box);
      if (room > EPS && comesNear(points, box.box, room)) {
        return `it would pass too close to ${nameOf(box.id)}`;
      }
    }
    for (const { bar, box } of bars) {
      if (!meet(box, around)) continue;
      const room = barRoom.get(bar.id) ?? HAND_CLEARANCE;
      if (room > EPS && comesNear(points, bodyOf(bar), room, ...passing(bar, points))) {
        return `it would pass too close to ${nameOf(bar.id)}`;
      }
    }
    return null;
  };
  // The connector of a device: how near its own symbol the runs after the
  // first may come. As near as the diagram itself draws one, for a
  // connector that is that near now.
  const ownRoom =
    own !== undefined && now !== undefined && onOwnSymbol(now, own, HAND_CLEARANCE) === 'beside'
      ? OWN_SYMBOL_ROOM
      : HAND_CLEARANCE;

  return (points) => {
    if (points.length < 2) return 'a line runs through two points at the least';
    if (own !== undefined) {
      const how = onOwnSymbol(points, own, ownRoom);
      if (how !== null) return OWN_SYMBOL[how];
    }
    if (routeFolds(points)) return 'it would fold back on itself';
    const found = overlapsOf(points).find((overlap) => !known.has(keyOf(overlap)));
    if (found === undefined) return tooNear(points);
    if (found.a === ownSymbol || found.b === ownSymbol) {
      return 'the symbol of the transformer would have no room on it';
    }
    return inWords(found, id, nameOf);
  };
}
