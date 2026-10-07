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
 * A branch the router finds no way for is drawn from tap to tap by the
 * connection pass, and as one straight line where the steps of that would
 * be on something: a straight line at an angle shares no stretch with one
 * that runs at right angles.
 *
 * The canvas runs this on every change of the nodes, a move of a drag
 * included, so the work is bounded: in steps of the search (`LIVE_STEPS`)
 * and in the size of the grid it is done on (`LIVE_GRID_POINTS`), which
 * covers only the surroundings of the branches that are routed.
 *
 * Pure: no React, no React Flow, nothing read but the arguments.
 */
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  layoutConnections,
  type ConnectionEdge,
  type ConnectionOptions,
  type ConnectionPass,
  type Point,
  type Rect,
} from './connections';
import {
  findOverlaps,
  type DrawnBar,
  type DrawnBox,
  type DrawnDiagram,
  type DrawnLine,
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
 * of each. A branch that is not routed within them is drawn straight until
 * the node is dropped, and routed then.
 */
export const DRAG_STEPS = 12_000;
export const DRAG_GRID_POINTS = 40_000;

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
   * `DRAG_STEPS` and `DRAG_GRID_POINTS`.
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
  /** The branches no way was found for, by edge id: drawn from tap to tap. */
  unrouted: string[];
}

/** The lines, the bars and the symbols of the diagram, which a route is held to. */
function structureOf(
  nodes: readonly TidyNode[],
  edges: readonly ConnectionEdge[],
  connections: ConnectionPass,
  options: RoutingOptions,
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
  return { lines, bars, boxes };
}

/** Whether two routes run through the same points. */
function sameRoute(a: readonly Point[], b: readonly (readonly [number, number])[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 0.01 && Math.abs(p[1] - b[i]![1]) < 0.01)
  );
}

/** How many times the routes that do not hold are taken out and routed again. */
const ROUNDS = 2;

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
  const { obstacles, keepFree, preferFree, dragging, ...bounds } = options;
  const { steps = dragging ? DRAG_STEPS : LIVE_STEPS, ...rest } = bounds;
  const { gridPoints = dragging ? DRAG_GRID_POINTS : LIVE_GRID_POINTS, ...connectionOptions } =
    rest;
  const at = new Map(nodes.map((node) => [node.id, node.position]));
  const stored = new Map<string, unknown>(edges.map((edge) => [edge.id, edge.data?.bendPoints]));
  let drawn: E[] = [...edges];
  let connections = layoutConnections(nodes, drawn, connectionOptions);
  const isBranch = new Set(
    edges
      .filter((edge) => edge.type !== 'stub' && connections.routes.has(edge.id))
      .map((e) => e.id),
  );
  /** The branches that have been routed afresh, and the ones no way was found for. */
  const routedHere = new Set<string>();
  const unrouted = new Set<string>();
  let spent = 0;
  for (let round = 0; round < ROUNDS && isBranch.size > 0; round += 1) {
    // ---- which routes hold ----
    const broken = new Set<string>();
    for (const id of isBranch) {
      if (!connections.kept.has(id) && !unrouted.has(id)) broken.add(id);
    }
    for (const overlap of findOverlaps(structureOf(nodes, drawn, connections, options))) {
      if (overlap.kind === 'box-box') continue;
      // Two lines on each other: both go, and are routed again one around
      // the other. A line on a bar or a symbol: the line. One that has no
      // route of its own, and is drawn from tap to tap for now, takes none
      // that has down with it.
      const lines = overlap.kind === 'line-line' || overlap.kind === 'shared-tap';
      const both = lines ? [overlap.a, overlap.b] : [overlap.a];
      if (both.some((id) => isBranch.has(id) && !connections.kept.has(id))) continue;
      for (const id of both) if (isBranch.has(id)) broken.add(id);
    }
    if (broken.size === 0) break;

    // ---- route those around the rest ----
    // The ones that stay are kept exactly as they are drawn now: with their
    // taps where the connection pass has them, which the new routes keep
    // their distance from, so that nothing moves when they are put in.
    const keep = new Map<string, readonly Point[]>();
    const around: Rect = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (const edge of drawn) {
      if (!isBranch.has(edge.id)) continue;
      if (!broken.has(edge.id)) {
        if (!unrouted.has(edge.id)) keep.set(edge.id, connections.routes.get(edge.id)!.points);
        continue;
      }
      for (const bus of [edge.source, edge.target]) {
        const { x, y } = at.get(bus)!;
        const bar = connections.bars.get(bus);
        around.left = Math.min(around.left, x + (bar?.start ?? 0));
        around.right = Math.max(around.right, x + (bar?.end ?? BAR_LENGTH));
        around.top = Math.min(around.top, y);
        around.bottom = Math.max(around.bottom, y + BAR_THICKNESS);
      }
    }
    const tidied = tidyRoutes(nodes, drawn, {
      ...connectionOptions,
      obstacles,
      keepFree,
      preferFree,
      keep,
      within: {
        left: around.left - ROUTING_REACH,
        right: around.right + ROUTING_REACH,
        top: around.top - ROUTING_REACH,
        bottom: around.bottom + ROUTING_REACH,
      },
      steps: Math.max(0, steps - spent),
      gridPoints,
    });
    spent += tidied.steps;
    drawn = drawn.map((edge): E => {
      const anchors: RouteAnchors = {
        source: { ...at.get(edge.source)! },
        target: { ...at.get(edge.target)! },
      };
      const along = (points: readonly Point[]): E => ({
        ...edge,
        data: {
          ...edge.data,
          bendPoints: points.map(([x, y]): [number, number] => [x, y]),
          bendAnchors: anchors,
        },
      });
      const held = keep.get(edge.id);
      if (held !== undefined) return along(held);
      if (!broken.has(edge.id)) return edge;
      const points = tidied.routes.get(edge.id);
      if (points !== undefined) {
        routedHere.add(edge.id);
        return along(points);
      }
      // No way was found: without the route that did not hold, the
      // connection pass draws it from tap to tap.
      unrouted.add(edge.id);
      routedHere.delete(edge.id);
      return { ...edge, data: { ...edge.data, bendPoints: undefined, bendAnchors: undefined } };
    });
    connections = layoutConnections(nodes, drawn, connectionOptions);
  }
  if (unrouted.size > 0) {
    // The ones drawn from tap to tap whose steps are on something are drawn
    // as one straight line.
    const straight = new Set<string>();
    for (const overlap of findOverlaps(structureOf(nodes, drawn, connections, options))) {
      if (overlap.kind === 'box-box') continue;
      for (const id of [overlap.a, overlap.b]) if (unrouted.has(id)) straight.add(id);
    }
    if (straight.size > 0) {
      connections = layoutConnections(nodes, drawn, { ...connectionOptions, straight });
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
      anchors: { source: { ...at.get(edge.source)! }, target: { ...at.get(edge.target)! } },
    });
  }
  return { edges: drawn, connections, changed, unrouted: [...unrouted] };
}
