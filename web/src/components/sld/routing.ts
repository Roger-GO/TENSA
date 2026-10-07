/**
 * The route every line and transformer of the diagram is drawn along, kept
 * clear of everything else that is drawn.
 *
 * A branch is drawn along the route stored for it (the router's, from a
 * tidy or from an earlier pass here, or a saved layout's) while that route
 * still fits: its two buses stand where they stood, and it is on nothing
 * else. `routeDiagram` holds each stored route to that (`findOverlaps`, the
 * checker the tests hold the whole diagram to): a route that lies on
 * another line or beside it too closely, that ends on a bar where another
 * line ends, or that runs through a bar or a symbol is taken out, with the
 * branches that have no route that fits their buses. Those are then routed
 * afresh around the ones that stay (`tidyRoutes`, with the rest as
 * `keep`), so a bus that is moved takes its own branches along and leaves
 * every other line where it was, and a device dropped on a line makes that
 * line go round it.
 *
 * The connector of a device lands where it lands with no line about. A
 * stored route whose end holds a place on the bar so near that the tap of a
 * device is moved aside for it (a device that was dropped beside the end of
 * a line) is taken out as well, and routed again to a tap that leaves the
 * connector where it was: square to the bar, and clear of the device beside
 * it.
 *
 * The symbol of a transformer is part of what a route is held to. It is
 * placed on its line first (`placeTransformerSymbols`); a line that runs
 * through it is taken out and routed round it, and a transformer whose
 * symbol has no place on its route that is clear of the bars and the
 * devices is routed again by a way that has one.
 *
 * While a node is dragged on a large diagram (more than `FOLLOW_ABOVE`
 * branches) a route follows its bus (`followBuses`): the run that ends on
 * the bar goes along with it, and the rest stays as it was. That costs next
 * to nothing, so only the routes that are then on something are searched
 * for again, with every move of the drag. On a small diagram every branch
 * of the bus is searched for with every move, which there is time for, and
 * what is drawn in the drag is what is drawn after the drop.
 *
 * A branch the router finds no way for is drawn the first of these ways
 * that is on nothing: stepped from tap to tap by the connection pass, along
 * the route it had, brought along with its buses, or as one straight line
 * (at an angle, which shares no stretch with a line that runs at right
 * angles). With none of them clear it is drawn the way that is on least,
 * which a pass in a drag does not settle for before it has been made again
 * as a pass at rest is (below).
 *
 * The canvas runs this on every change of the nodes, a move of a drag
 * included, so the work is bounded: in steps of the search (`LIVE_STEPS`)
 * and in the size of the grid it is done on (`LIVE_GRID_POINTS`), which
 * covers only the surroundings of the branches that are routed. Where
 * those surroundings are more than one grid holds, the branches are routed
 * one at a time, each in the surroundings of its own two buses.
 *
 * A pass in a drag has a fraction of those bounds (`DRAG_STEPS`,
 * `DRAG_GRID_POINTS`), which is enough for nearly every move. Where it is
 * not, and a line would be left on a bar, a symbol or another line (a bus
 * dragged onto a line that runs the length of a large diagram, a search
 * that ran out of steps and took a poor way that put the next line out),
 * the pass is made again with the bounds of a pass at rest: that move of
 * the drag takes as long as the drop will, and nothing is drawn over
 * anything else on the way there.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  TAP_SPACING,
  TRANSFORMER_SYMBOL_SIZE,
  layoutConnections,
  simplifyRoute,
  stepRoute,
  type ConnectionEdge,
  type ConnectionOptions,
  type ConnectionPass,
  type LabelPlace,
  type Point,
  type Rect,
} from './connections';
import { placeTransformerSymbols, symbolBoxes } from './labels';
import {
  findOverlaps,
  type DrawnBar,
  type DrawnBox,
  type DrawnDiagram,
  type DrawnLine,
  type Overlap,
} from './overlapCheck';
import { GRID_STEP, tidyRoutes, type TidyNode, type TidyOptions } from './tidy';

/**
 * How many steps of the search one pass may take (`TIDY_STEPS` is what a
 * whole tidy may take). Enough to route every branch of a diagram the size
 * of the example cases, and the branches of a bus that is dragged on any;
 * what is left over on a larger one is drawn straight until the diagram is
 * tidied.
 */
export const LIVE_STEPS = 60_000;

/** The most points the grid of one pass has (`GRID_POINTS` is what a whole tidy may have). */
export const LIVE_GRID_POINTS = 150_000;

/**
 * The same two bounds for a pass that is made while a node is dragged
 * (`RoutingOptions.dragging`), which is one of many in a second: a fraction
 * of each. Where a line is left on something within them, the pass is made
 * again with the bounds of a pass at rest.
 */
export const DRAG_STEPS = 12_000;
export const DRAG_GRID_POINTS = 40_000;

/**
 * The most branches a diagram has whose routes are searched for afresh
 * with every move of a drag (as many as a tidy plans within the press that
 * asked for it: `TIDY_AT_ONCE`). On a larger one a route follows its bus
 * while it is dragged, and is searched for when that puts it on something.
 */
export const FOLLOW_ABOVE = 30;

/** How far around the buses of the branches that are routed the grid of a pass reaches. */
const ROUTING_REACH = 14 * GRID_STEP;

/**
 * How near a stored route may pass a symbol and still be kept. The router
 * keeps twice as far; a symbol the browser measured a little wider than the
 * diagram took it to be does not send its neighbours round again.
 */
const SYMBOL_CLEARANCE = 4;

/** Where a route that was made here was made for: the positions of its two buses. */
export interface RouteAnchors {
  source: { x: number; y: number };
  target: { x: number; y: number };
}

export interface RoutingOptions extends ConnectionOptions {
  /** What else stands on the diagram and is no node: a control chain that is drawn out. */
  obstacles?: readonly Rect[];
  /** The places to keep free for the values of the devices (`TidyOptions.keepFree`). */
  keepFree?: TidyOptions['keepFree'];
  /** The places to leave free for the labels of the buses where that costs nothing (`TidyOptions.preferFree`). */
  preferFree?: TidyOptions['preferFree'];
  /**
   * Whether a node is being dragged: the pass is one of many, and is held to
   * `DRAG_STEPS` and `DRAG_GRID_POINTS`. On a diagram of more than
   * `FOLLOW_ABOVE` branches a route whose bus has moved follows it
   * (`followBuses`) and is searched for again only where that puts it on
   * something. A pass that leaves a line on something even so is made again
   * as a pass at rest is.
   */
  dragging?: boolean;
  /** How many steps the search may take; default `LIVE_STEPS`. */
  steps?: number;
  /** The most points the grid may have; default `LIVE_GRID_POINTS`. */
  gridPoints?: number;
}

export interface RoutedDiagram<E extends ConnectionEdge> {
  /**
   * The edges as they are drawn: each branch with the route it is drawn
   * along and the positions that route is for (`data.bendPoints`,
   * `data.bendAnchors`), and each one no way was found for without a route.
   */
  edges: E[];
  /** Where every connector attaches and runs (`layoutConnections` over those edges). */
  connections: ConnectionPass;
  /**
   * The branches that are not drawn along the route stored for them, by
   * edge id, each with the route it is drawn along: one that was routed
   * here, and one whose end had to move along its bar. The canvas keeps
   * these as the stored routes once the diagram is at rest, so the next
   * pass finds them in place.
   */
  changed: Map<string, { points: [number, number][]; anchors: RouteAnchors }>;
  /**
   * The branches no way was found for, by edge id: drawn from tap to tap,
   * stepped or straight, whichever is on least.
   */
  unrouted: string[];
  /** Where each transformer carries its symbol on the route it is drawn along, by edge id. */
  symbols: Map<string, LabelPlace>;
}

/** What the symbol of a transformer goes by among the boxes a route is held to. */
const SYMBOL = 'symbol:';

/**
 * The lines, the bars and the symbols of the diagram, which a route is held
 * to: the symbols of the devices, and those of the transformers where
 * `symbols` has them, each of which its own line runs through.
 */
function structureOf(
  nodes: readonly TidyNode[],
  edges: readonly ConnectionEdge[],
  connections: ConnectionPass,
  options: RoutingOptions,
  symbols: ReadonlyMap<string, Rect>,
): DrawnDiagram {
  const lines: DrawnLine[] = [];
  for (const edge of edges) {
    const route = connections.routes.get(edge.id);
    if (route !== undefined) {
      lines.push({ id: edge.id, points: route.points, from: edge.source, to: edge.target });
    }
  }
  const bars: DrawnBar[] = [];
  const boxes: DrawnBox[] = [];
  for (const node of nodes) {
    const { x, y } = node.position;
    if ((node.type ?? 'bus') === 'bus') {
      const bar = connections.bars.get(node.id);
      bars.push({
        id: node.id,
        left: x + (bar?.start ?? 0),
        right: x + (bar?.end ?? BAR_LENGTH),
        y: y + BAR_THICKNESS / 2,
      });
      continue;
    }
    const size = options.sizes?.get(node.id);
    const width = size?.width ?? node.initialWidth ?? 0;
    const height = size?.height ?? node.initialHeight ?? 0;
    boxes.push({
      id: node.id,
      kind: 'symbol',
      box: {
        left: x - SYMBOL_CLEARANCE,
        right: x + width + SYMBOL_CLEARANCE,
        top: y - SYMBOL_CLEARANCE,
        bottom: y + height + SYMBOL_CLEARANCE,
      },
    });
  }
  (options.obstacles ?? []).forEach((box, i) => {
    boxes.push({ id: `obstacle:${i}`, kind: 'block', box });
  });
  for (const [id, box] of symbols) {
    boxes.push({ id: `${SYMBOL}${id}`, kind: 'symbol', box, of: [id] });
  }
  return { lines, bars, boxes };
}

/** How far two boxes may reach into each other and still count as apart (`OverlapOptions.slack`). */
const SLACK = 0.5;

/**
 * The transformers whose symbol stands on something it cannot stand on: a
 * device, a control chain that is drawn out, a bar, or the symbol of
 * another transformer. Their routes have no room for it.
 */
function symbolsWithoutRoom(
  symbols: ReadonlyMap<string, Rect>,
  nodes: readonly TidyNode[],
  connections: ConnectionPass,
  options: RoutingOptions,
): Set<string> {
  const standing: Rect[] = [...(options.obstacles ?? [])];
  for (const node of nodes) {
    const { x, y } = node.position;
    if ((node.type ?? 'bus') === 'bus') {
      const bar = connections.bars.get(node.id);
      standing.push({
        left: x + (bar?.start ?? 0),
        right: x + (bar?.end ?? BAR_LENGTH),
        top: y,
        bottom: y + BAR_THICKNESS,
      });
      continue;
    }
    const size = options.sizes?.get(node.id);
    standing.push({
      left: x,
      right: x + (size?.width ?? node.initialWidth ?? 0),
      top: y,
      bottom: y + (size?.height ?? node.initialHeight ?? 0),
    });
  }
  const meet = (a: Rect, b: Rect): boolean =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > SLACK &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > SLACK;
  const without = new Set<string>();
  for (const [id, box] of symbols) {
    if (standing.some((other) => meet(box, other))) without.add(id);
    for (const [other, taken] of symbols) {
      if (other !== id && meet(box, taken)) without.add(id);
    }
  }
  return without;
}

/** Two coordinates closer than this are the same place (as in `connections.ts`). */
const EPS = 0.5;

/**
 * `points`, a route that was made for two buses at `anchors`, brought along
 * to where they stand now. The end of the route goes with its bus, and so
 * does the run that leaves the bar, which stays square to it; the bend that
 * run ends in slides along the run after it, and everything in between
 * stays where it was. A single run from one bar straight to the other steps
 * across when its two ends are no longer in line. `null` for a route this
 * cannot be done to: one with a run at an angle, or with one bend only.
 *
 * What comes back is a route for the buses where they are, not one that is
 * clear of the rest of the diagram: `routeDiagram` holds it to that like
 * any other.
 */
export function followBuses(
  points: readonly (readonly [number, number])[],
  anchors: RouteAnchors,
  source: { x: number; y: number },
  target: { x: number; y: number },
): Point[] | null {
  const count = points.length;
  if (count < 2 || count === 3) return null;
  const level = (a: readonly [number, number], b: readonly [number, number]): boolean =>
    Math.abs(a[1] - b[1]) <= EPS;
  const upright = (a: readonly [number, number], b: readonly [number, number]): boolean =>
    Math.abs(a[0] - b[0]) <= EPS;
  for (let i = 1; i < count; i += 1) {
    if (!level(points[i - 1]!, points[i]!) && !upright(points[i - 1]!, points[i]!)) return null;
  }
  const by = {
    source: [source.x - anchors.source.x, source.y - anchors.source.y],
    target: [target.x - anchors.target.x, target.y - anchors.target.y],
  } as const;
  const out = points.map(([x, y]): Point => [x, y]);
  const first = out[0]!;
  const last = out[count - 1]!;
  if (count === 2) {
    // Straight from a face of one bar to a face of the other.
    if (!upright(first, last)) return null;
    const down = last[1] > first[1];
    const a: Point = [first[0] + by.source[0], first[1] + by.source[1]];
    const b: Point = [last[0] + by.target[0], last[1] + by.target[1]];
    if (Math.abs(a[0] - b[0]) <= EPS) return [a, [a[0], b[1]]];
    return stepRoute(a, down ? 'south' : 'north', b, down ? 'north' : 'south');
  }
  // Each end with the bend its first run ends in: that bend follows along
  // the run after it, which keeps the first run square to the bar.
  const bring = (end: Point, bend: Point, [dx, dy]: readonly [number, number]): void => {
    const faced = upright(end, bend);
    end[0] += dx;
    end[1] += dy;
    if (faced) bend[0] += dx;
    else bend[1] += dy;
  };
  bring(first, out[1]!, by.source);
  bring(last, out[count - 2]!, by.target);
  return simplifyRoute(out);
}

/** Whether two routes run through the same points. */
function sameRoute(a: readonly Point[], b: readonly (readonly [number, number])[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 0.01 && Math.abs(p[1] - b[i]![1]) < 0.01)
  );
}

/** How many times the routes that do not hold are taken out and routed again. */
const ROUNDS = 3;

/** The ways a branch that no way was found for is drawn, in the order they are tried. */
type Fallback = 'stepped' | 'followed' | 'straight';

/**
 * Give every branch among `edges` a route that is on nothing else, with the
 * nodes where they are: the one stored for it where that still holds, and a
 * new one otherwise.
 */
export function routeDiagram<E extends ConnectionEdge>(
  nodes: readonly TidyNode[],
  edges: readonly E[],
  options: RoutingOptions = {},
): RoutedDiagram<E> {
  const { left, ...routed } = routeOnce(nodes, edges, options);
  if (options.dragging !== true || left === 0) return routed;
  // A line was left on something within the bounds of a drag: once more,
  // as the diagram is routed at rest.
  const { left: leftAtRest, ...atRest } = routeOnce(nodes, edges, { ...options, dragging: false });
  return leftAtRest <= left ? atRest : routed;
}

/**
 * One pass of `routeDiagram`, within the bounds `options` gives it. `left`
 * is how many places it leaves a line or a transformer on something: none,
 * for a pass that found every branch a way.
 */
function routeOnce<E extends ConnectionEdge>(
  nodes: readonly TidyNode[],
  edges: readonly E[],
  options: RoutingOptions,
): RoutedDiagram<E> & { left: number } {
  const { obstacles, keepFree, preferFree, dragging, ...bounds } = options;
  const { steps = dragging ? DRAG_STEPS : LIVE_STEPS, ...rest } = bounds;
  const { gridPoints = dragging ? DRAG_GRID_POINTS : LIVE_GRID_POINTS, ...connectionOptions } =
    rest;
  const sizes = options.sizes ?? new Map();
  const at = new Map(nodes.map((node) => [node.id, node.position]));
  const stored = new Map<string, unknown>(edges.map((edge) => [edge.id, edge.data?.bendPoints]));
  const anchorsNow = (edge: ConnectionEdge): RouteAnchors => ({
    source: { ...at.get(edge.source)! },
    target: { ...at.get(edge.target)! },
  });
  /** `edge` drawn along `points`, as a route for its buses where they are. */
  const along = (edge: E, points: readonly Point[]): E => ({
    ...edge,
    data: {
      ...edge.data,
      bendPoints: points.map(([x, y]): [number, number] => [x, y]),
      bendAnchors: anchorsNow(edge),
    },
  });
  /** `edge` without a route: the connection pass draws it from tap to tap. */
  const bare = (edge: E): E => ({
    ...edge,
    data: { ...edge.data, bendPoints: undefined, bendAnchors: undefined },
  });

  // ---- the routes whose buses have moved ----
  // Each brought along with its buses. While a node is dragged on a large
  // diagram they are drawn that way, and searched for again only where that
  // is on something; otherwise they are searched for again, and this is
  // what is left for one no way is found for.
  const followed = new Map<string, Point[]>();
  for (const edge of edges) {
    if (edge.type === 'stub') continue;
    const points = edge.data?.bendPoints;
    const anchors = edge.data?.bendAnchors as RouteAnchors | undefined;
    const source = at.get(edge.source);
    const target = at.get(edge.target);
    if (!Array.isArray(points) || !anchors?.source || !anchors.target || !source || !target) {
      continue;
    }
    const sits = (now: { x: number; y: number }, then: { x: number; y: number }): boolean =>
      Math.abs(now.x - then.x) < 0.01 && Math.abs(now.y - then.y) < 0.01;
    if (sits(source, anchors.source) && sits(target, anchors.target)) continue;
    const brought = followBuses(points as [number, number][], anchors, source, target);
    if (brought !== null) followed.set(edge.id, brought);
  }
  const follow =
    dragging === true && edges.filter((edge) => edge.type !== 'stub').length > FOLLOW_ABOVE;
  let drawn: E[] = follow
    ? edges.map((edge) => {
        const brought = followed.get(edge.id);
        return brought === undefined ? edge : along(edge, brought);
      })
    : [...edges];
  let connections = layoutConnections(nodes, drawn, connectionOptions);
  const isBranch = new Set(
    edges
      .filter((edge) => edge.type !== 'stub' && connections.routes.has(edge.id))
      .map((e) => e.id),
  );
  const edgeOf = new Map(edges.map((edge) => [edge.id, edge]));
  // Where the connector of each device lands with no line about.
  const stubEdges = edges.filter((edge) => edge.type === 'stub');
  const alone = layoutConnections(nodes, stubEdges, connectionOptions);
  /**
   * The branches whose end on a bar has moved the tap of a device aside,
   * with the routes as `pass` has them: the ones that end within two
   * spacings of where that tap would stand.
   */
  const crowdingTaps = (drawnNow: readonly E[], pass: ConnectionPass): Set<string> => {
    const crowded = new Map<string, number[]>();
    for (const stub of stubEdges) {
      const wanted = alone.routes.get(stub.id)?.points;
      const got = pass.routes.get(stub.id)?.points;
      if (wanted === undefined || got === undefined) continue;
      const [to, at] = [wanted[wanted.length - 1]![0], got[got.length - 1]![0]];
      if (Math.abs(to - at) <= EPS) continue;
      const list = crowded.get(stub.target);
      if (list) list.push(to);
      else crowded.set(stub.target, [to]);
    }
    const found = new Set<string>();
    if (crowded.size === 0) return found;
    for (const edge of drawnNow) {
      const points = edge.type === 'stub' ? undefined : pass.routes.get(edge.id)?.points;
      if (points === undefined) continue;
      for (const [bus, end] of [
        [edge.source, points[0]!],
        [edge.target, points[points.length - 1]!],
      ] as const) {
        const near = (crowded.get(bus) ?? []).some((x) => Math.abs(x - end[0]) < 2 * TAP_SPACING);
        if (near) found.add(edge.id);
      }
    }
    return found;
  };
  /** Where each transformer carries its symbol, with the routes as `pass` has them. */
  const symbolsOn = (drawnNow: readonly E[], pass: ConnectionPass): Map<string, LabelPlace> =>
    placeTransformerSymbols(nodes, drawnNow, pass, sizes, obstacles ?? []);
  /** Every place where a line of the diagram, as `pass` has it, is on something. */
  const overlapsOn = (
    drawnNow: readonly E[],
    pass: ConnectionPass,
    boxes: ReadonlyMap<string, Rect>,
  ): Overlap[] =>
    findOverlaps(structureOf(nodes, drawnNow, pass, options, boxes)).filter(
      (overlap) => overlap.kind !== 'box-box',
    );
  /** How far around the buses of `ids` a routing of them looks. */
  const around = (ids: Iterable<string>, pass: ConnectionPass): Rect => {
    const box: Rect = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (const id of ids) {
      const edge = edgeOf.get(id)!;
      for (const bus of [edge.source, edge.target]) {
        const { x, y } = at.get(bus)!;
        const bar = pass.bars.get(bus);
        box.left = Math.min(box.left, x + (bar?.start ?? 0));
        box.right = Math.max(box.right, x + (bar?.end ?? BAR_LENGTH));
        box.top = Math.min(box.top, y);
        box.bottom = Math.max(box.bottom, y + BAR_THICKNESS);
      }
    }
    return {
      left: box.left - ROUTING_REACH,
      right: box.right + ROUTING_REACH,
      top: box.top - ROUTING_REACH,
      bottom: box.bottom + ROUTING_REACH,
    };
  };
  /** The box the symbol of a transformer takes about `spot`. */
  const symbolAt = ([x, y]: Point): Rect => {
    const half = TRANSFORMER_SYMBOL_SIZE / 2;
    return { left: x - half, right: x + half, top: y - half, bottom: y + half };
  };

  /** The branches that have been routed afresh, and the ones no way was found for. */
  const routedHere = new Set<string>();
  const unrouted = new Set<string>();
  let spent = 0;
  // Whether the routes were last looked at and every one held.
  let held = isBranch.size === 0;
  for (let round = 0; round < ROUNDS && isBranch.size > 0; round += 1) {
    // ---- which routes hold ----
    const symbols = symbolBoxes(symbolsOn(drawn, connections));
    const kept = (id: string): boolean => isBranch.has(id) && connections.kept.has(id);
    const broken = new Set<string>();
    for (const id of isBranch) {
      if (!connections.kept.has(id) && !unrouted.has(id)) broken.add(id);
    }
    // A transformer whose symbol has no place on its route that is clear of
    // the bars and the devices is routed again, by a way that has one.
    for (const id of symbolsWithoutRoom(symbols, nodes, connections, options)) {
      if (kept(id)) broken.add(id);
    }
    // A route whose end has moved the tap of a device aside is routed
    // again, to a tap that leaves the connector of the device where it was.
    for (const id of crowdingTaps(drawn, connections)) if (kept(id)) broken.add(id);
    for (const overlap of overlapsOn(drawn, connections, symbols)) {
      if (overlap.kind === 'line-box' && overlap.b.startsWith(SYMBOL)) {
        // A line through the symbol of a transformer goes round it. The
        // connector of a device cannot, and leaves it to the transformer to
        // find another way. A branch that has no route of its own takes
        // nothing down with it, and neither does the symbol of one.
        const owner = overlap.b.slice(SYMBOL.length);
        if (!kept(owner)) continue;
        if (kept(overlap.a)) broken.add(overlap.a);
        else if (!isBranch.has(overlap.a)) broken.add(owner);
        continue;
      }
      // Two lines on each other: both go, and are routed again one around
      // the other. A line on a bar or a symbol: the line. One that has no
      // route of its own, and is drawn from tap to tap for now, takes none
      // that has down with it.
      const lines = overlap.kind === 'line-line' || overlap.kind === 'shared-tap';
      const both = lines ? [overlap.a, overlap.b] : [overlap.a];
      if (both.some((id) => isBranch.has(id) && !connections.kept.has(id))) continue;
      for (const id of both) if (isBranch.has(id)) broken.add(id);
    }
    if (broken.size === 0) {
      held = true;
      break;
    }

    // ---- route those around the rest ----
    // The ones that stay are kept exactly as they are drawn now: with their
    // taps where the connection pass has them, which the new routes keep
    // their distance from, so that nothing moves when they are put in. The
    // symbols of the transformers among them stay where they are as well.
    const keep = new Map<string, readonly Point[]>();
    const keptSymbols = new Map<string, Rect>();
    for (const edge of drawn) {
      if (!isBranch.has(edge.id) || broken.has(edge.id) || unrouted.has(edge.id)) continue;
      keep.set(edge.id, connections.routes.get(edge.id)!.points);
      const symbol = symbols.get(edge.id);
      if (symbol !== undefined) keptSymbols.set(edge.id, symbol);
    }
    const routing = { ...connectionOptions, obstacles, keepFree, preferFree, gridPoints };
    const made = new Map<string, Point[]>();
    const together = tidyRoutes(nodes, drawn, {
      ...routing,
      keep,
      symbols: keptSymbols,
      within: around(broken, connections),
      steps: Math.max(0, steps - spent),
    });
    spent += together.steps;
    for (const [id, points] of together.routes) made.set(id, points);
    if (together.tooLarge === true) {
      // Their surroundings together are more than one grid holds (the
      // branches of a bus with lines to the far ends of a large diagram, or
      // one such line in the grid of a drag): one at a time then, the
      // shortest first, each in the surroundings of its own two buses and
      // around the ones before it.
      const apart = (id: string): number => {
        const edge = edgeOf.get(id)!;
        const [a, b] = [at.get(edge.source)!, at.get(edge.target)!];
        return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      };
      const order = [...broken].sort((p, q) => apart(p) - apart(q));
      const others = new Map(keep);
      const heldSymbols = new Map(keptSymbols);
      order.forEach((id, i) => {
        const left = steps - spent;
        if (left <= 0) return;
        const one = tidyRoutes(nodes, drawn, {
          ...routing,
          keep: others,
          symbols: heldSymbols,
          only: new Set([id]),
          within: around([id], connections),
          // One branch alone is searched for in a grid as large as a pass at
          // rest has: the search is bounded by its steps all the same.
          gridPoints: Math.max(gridPoints, LIVE_GRID_POINTS),
          steps: left / (order.length - i),
        });
        spent += one.steps;
        const points = one.routes.get(id);
        if (points === undefined) return;
        made.set(id, points);
        others.set(id, points);
        const spot = one.spots.get(id);
        if (spot !== undefined) heldSymbols.set(id, symbolAt(spot));
      });
    }
    drawn = drawn.map((edge): E => {
      const stays = keep.get(edge.id);
      if (stays !== undefined) return along(edge, stays);
      if (!broken.has(edge.id)) return edge;
      const points = made.get(edge.id);
      if (points !== undefined) {
        routedHere.add(edge.id);
        return along(edge, points);
      }
      // No way was found: without the route that did not hold, the
      // connection pass draws it from tap to tap.
      unrouted.add(edge.id);
      routedHere.delete(edge.id);
      return bare(edge);
    });
    connections = layoutConnections(nodes, drawn, connectionOptions);
  }

  /** How many places a line or a transformer of the diagram is still on something. */
  let stillOn = 0;
  if (unrouted.size > 0) {
    // ---- the branches no way was found for ----
    // Stepped from tap to tap, as the connection pass has them now. The
    // ones that are on something that way are tried along the route they
    // had, brought along with their buses, and then as one straight line;
    // each is drawn the way it is on least.
    const way = new Map<string, Fallback>([...unrouted].map((id) => [id, 'stepped']));
    const drawBy = (ways: ReadonlyMap<string, Fallback>): { edges: E[]; pass: ConnectionPass } => {
      const straight = new Set<string>();
      const edgesNow = drawn.map((edge): E => {
        const how = ways.get(edge.id);
        if (how === 'straight') straight.add(edge.id);
        return how === 'followed' ? along(edge, followed.get(edge.id)!) : edge;
      });
      return {
        edges: edgesNow,
        pass: layoutConnections(nodes, edgesNow, { ...connectionOptions, straight }),
      };
    };
    /** How many things each of the branches without a way is on, drawn as `state` has them. */
    const onSomething = (state: { edges: E[]; pass: ConnectionPass }): Map<string, number> => {
      const symbols = symbolBoxes(symbolsOn(state.edges, state.pass));
      const counts = new Map<string, number>([...unrouted].map((id) => [id, 0]));
      const count = (id: string): void => {
        if (counts.has(id)) counts.set(id, counts.get(id)! + 1);
      };
      for (const id of symbolsWithoutRoom(symbols, nodes, state.pass, options)) count(id);
      for (const overlap of overlapsOn(state.edges, state.pass, symbols)) {
        count(overlap.a);
        count(overlap.b.startsWith(SYMBOL) ? overlap.b.slice(SYMBOL.length) : overlap.b);
      }
      return counts;
    };
    let state = { edges: drawn, pass: connections };
    let counts = onSomething(state);
    for (const next of ['followed', 'straight'] as const) {
      const poor = [...unrouted].filter(
        (id) => counts.get(id)! > 0 && (next !== 'followed' || followed.has(id)),
      );
      if (poor.length === 0) continue;
      const tried = new Map(way);
      for (const id of poor) tried.set(id, next);
      const triedState = drawBy(tried);
      const triedCounts = onSomething(triedState);
      const better = poor.filter((id) => triedCounts.get(id)! < counts.get(id)!);
      if (better.length === 0) continue;
      for (const id of better) way.set(id, next);
      state = better.length === poor.length ? triedState : drawBy(way);
      counts = better.length === poor.length ? triedCounts : onSomething(state);
    }
    drawn = state.edges;
    connections = state.pass;
    // One that is on nothing along the route it had has that route again.
    for (const [id, how] of way) {
      if (how !== 'followed' || counts.get(id) !== 0) continue;
      unrouted.delete(id);
      routedHere.add(id);
    }
    // The others carry no route: what is drawn for them is not kept.
    drawn = drawn.map((edge) => (unrouted.has(edge.id) ? bare(edge) : edge));
  }
  if (!held || unrouted.size > 0) {
    // The routes were made again and not looked at since, or some branch
    // has none: what is on something as the diagram is drawn now. Only a
    // line or a transformer counts, which another pass could find a way
    // for; the connector of a device runs where it runs.
    const symbols = symbolBoxes(symbolsOn(drawn, connections));
    stillOn += symbolsWithoutRoom(symbols, nodes, connections, options).size;
    for (const overlap of overlapsOn(drawn, connections, symbols)) {
      const other = overlap.b.startsWith(SYMBOL) ? overlap.b.slice(SYMBOL.length) : overlap.b;
      if (isBranch.has(overlap.a) || isBranch.has(other)) stillOn += 1;
    }
  }

  // What is drawn along another route than the one stored for it.
  const changed: RoutedDiagram<E>['changed'] = new Map();
  for (const edge of drawn) {
    if (!isBranch.has(edge.id) || unrouted.has(edge.id)) continue;
    const points = connections.routes.get(edge.id)!.points;
    const was = stored.get(edge.id);
    if (!routedHere.has(edge.id) && Array.isArray(was) && sameRoute(points, was)) continue;
    changed.set(edge.id, {
      points: points.map(([x, y]): [number, number] => [x, y]),
      anchors: anchorsNow(edge),
    });
  }
  return {
    edges: drawn,
    connections,
    changed,
    unrouted: [...unrouted],
    symbols: symbolsOn(drawn, connections),
    left: stillOn,
  };
}
