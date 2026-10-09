/**
 * What Tidy diagram and Tidy and re-layout work out before anything on the
 * canvas changes: the nodes where they will stand, and the route of each
 * branch (`tidyRoutes`).
 *
 * Tidy diagram moves nothing: the nodes are the ones that are drawn. Tidy
 * and re-layout first brings the buses onto the grid (`alignToGrid`) and
 * puts every generator, load and shunt back beside its bus, where the
 * diagram places one that was never moved. Either way the branches are
 * routed around what then stands there, and kept out of where the P / Q
 * readouts of the devices will stand (`readoutReserve`), so a diagram that
 * is tidied before a power flow shows its values clear of the lines after
 * one.
 *
 * A plan made for a diagram that is on screen (`TidyPlanOptions.shown`) is
 * held to the picture it would give (`pictureOf`, `findOverlaps`), so a tidy
 * leaves nothing drawn over anything else that was not so before it:
 *
 * - No label of a bus is worse off for it. Where the routes made afresh
 *   would leave one with its name alone, or without a place by its bar (a
 *   line came down where it stood), they are made again with every place
 *   where a label stands shut to them (`TidyOptions.labels`): the routes
 *   the diagram has run through none, so there is a way that does not, and
 *   a branch that finds no other keeps the route it had. Where a label is
 *   worse off all the same (the symbol of a transformer came to stand
 *   where it stood), the lines of its bus keep the routes they have, as
 *   below.
 * - The connector of a device that stands away from its bus runs to where
 *   the bar ends, and a bar is as long as the lines that land on it draw it
 *   out. Routes made afresh can leave the bar shorter or longer, and the
 *   connector then runs another way, which may be through a symbol. Where
 *   the plan would draw something over something else, the lines of the
 *   buses that have a part in it keep the routes they have, and the rest
 *   are routed again around those. A plan that would still draw something
 *   over something else is not put in place (`TidyPlan.refused`).
 *
 * A plan that moves nothing leaves no line worse off either. A line or a
 * transformer whose route holds as the diagram draws it (it is on nothing,
 * and the router found it) is given another only where that one is better:
 * no longer, with no more bends, crossed in no more places, and less of one
 * of the three. The routes are made afresh all together first, which is what
 * finds the better ones; then every line that would come off worse, or that
 * would be changed for no gain, has the route it is drawn along back, and
 * the ones that gained are routed again around those, a few times over
 * (`KEEP_ROUNDS`), until each of them is better off or none is left. So a
 * tidy after one device was moved changes the lines the move had to do with
 * and leaves the rest where they ran (`TidyPlan.left`), and a route that
 * does not hold (drawn the plain way for want of a better one, or on
 * something) is made afresh whatever it was.
 *
 * Mending the routes that do not hold comes before leaving the others as
 * they are. Those rounds share a part of the steps of a tidy
 * (`KEEP_STEPS`), and none is made with no steps left for it: a routing
 * that may take no step finds no line a way. The last of them, which leaves
 * every route that holds as it is and routes only the rest, has steps of
 * its own whatever the ones before it took (`LAST_STEPS`). And a plan that
 * would leave a line that does not hold as it is drawn, where an earlier
 * plan had found it a way (the routes that stay left it no room, or the
 * steps ran out), is not taken: the last plan that had a way for it is,
 * though it changes a line for no gain. A line that stays on something is
 * worse than one that is longer than it was.
 *
 * A route that was drawn by hand (`data.bendManual`) is the user's and is
 * not made afresh: it stays as it is drawn (`TidyPlan.byHand`), and the
 * other lines are routed around it. After a re-layout it is brought along
 * with its buses, and one that is then on something is routed with the rest
 * (`TidyPlan.released`). The connector of a device that was drawn by hand
 * goes with its device the same way (`TidyPlan.connectorsByHand`), and is
 * worked out like any other where the place a re-layout puts its device in
 * leaves it through something, folded back on itself or along its own
 * symbol (`connections.ts`). A re-layout whose picture would still draw
 * something over something else is planned again without the routes drawn
 * by hand that have a part in that, and then without any of them, before
 * it is refused: what the user drew by hand does not keep the diagram from
 * being laid out again, and the plan says which of it was given up.
 *
 * Pure: no React, nothing read but the arguments. The canvas (`tidy` in
 * `SldCanvas.tsx`) puts the plan in place as one step for Undo.
 */
import type { Edge, Node } from '@xyflow/react';
import type { BusCoord, TopologySummary } from '@/api/types';
import {
  BAR_LENGTH,
  BAR_THICKNESS,
  layoutConnections,
  runsIn,
  type ConnectionEdge,
  type ConnectionLayout,
  type ConnectionNode,
  type ConnectorRoute,
  type ConnectorStyle,
  type NodeSize,
  type Point,
} from './connections';
import { buildGraph, type BuildGraphOptions } from './graph';
import { busLabelLack, busLabelReserve, chainBoxes, readoutReserve } from './labels';
import {
  crossingsByLine,
  describeOverlaps,
  findOverlaps,
  type DrawnLine,
  type Overlap,
} from './overlapCheck';
import { drawnDiagram, pictureOf, type Picture, type PictureOptions } from './picture';
import { routeDiagram } from './routing';
import { TIDY_STEPS, alignToGrid, tidyRoutes, type TidyResult } from './tidy';

export interface TidyPlanOptions {
  /** Whether the buses and the devices are placed afresh, and not only the branches routed. */
  relayout: boolean;
  /** The measured size of each node, by id. */
  sizes?: ReadonlyMap<string, NodeSize>;
  connectorStyle?: ConnectorStyle;
  barLengths?: ReadonlyMap<string, number>;
  /** What `buildGraph` needs to draw the diagram again for a re-layout. */
  controllerCoords?: Map<string, BusCoord>;
  unitStates?: BuildGraphOptions['unitStates'];
  /**
   * The nodes as the canvas last drew them, which say on which side each
   * control chain that is drawn out stands. Read by a tidy that moves
   * nothing; a re-layout places the chains with the units.
   */
  drawn?: readonly Node[];
  /** How many steps the search may take (`TIDY_STEPS`). */
  steps?: number;
  /**
   * How the diagram is drawn on screen: whether the values of a power flow
   * show, and how wide each of them is (`PictureOptions`). With it the plan
   * is held to the picture it gives: the labels of the buses keep their
   * places, and a plan that would draw something over something else is
   * mended or refused. Without it the routes are all the plan is.
   */
  shown?: Pick<PictureOptions, 'values' | 'labelWidths'>;
}

export interface TidyPlan {
  /** The diagram as it will stand: `graph` itself for a tidy that moves nothing. */
  nodes: Node[];
  edges: Edge[];
  /** The routes of its branches: of the ones that were routed afresh. */
  tidied: TidyResult;
  /**
   * The routes that were drawn by hand and stay as they are, by edge id:
   * each as it is drawn with the nodes where the plan has them. Absent
   * where the diagram has none.
   */
  byHand?: Map<string, Point[]>;
  /**
   * The connectors of devices that were drawn by hand and go along with
   * their devices to where a re-layout puts them, by edge id: each as it is
   * drawn there. Absent for a tidy that moves nothing, which leaves every
   * connector as it is.
   */
  connectorsByHand?: Map<string, Point[]>;
  /**
   * The routes that were drawn by hand and no longer fit where a re-layout
   * puts what they are attached to, by edge id: a line or a transformer is
   * routed afresh with the rest, and the connector of a device is worked
   * out like any other.
   */
  released?: string[];
  /**
   * Set where the plan is not to be put in place: what it would draw over
   * what, as text (`describeOverlaps`), none of which the diagram has as it
   * stands.
   */
  refused?: string[];
  /** For a plan that is refused: the lines and connectors that would be drawn over something, by edge id. */
  blamed?: string[];
  /**
   * The lines and transformers the plan leaves on the route they are drawn
   * along now, by edge id: the ones whose route holds and that no shorter,
   * straighter or less crossed one was found for. Each is among the routes
   * of `tidied` all the same. Absent for a re-layout, which routes every
   * line afresh, and where there is none.
   */
  left?: string[];
}

/** What an overlap goes by when two pictures are compared. */
const nameOf = ({ kind, a, b }: Overlap): string => `${kind}|${a}|${b}`;

/**
 * `edges` as the canvas has them once `routes` are put in place for the
 * nodes `nodes`: each branch along its new route, one that was drawn by
 * hand and stays (`byHand`) along that, and one that got none along the
 * route it had, or after a re-layout along none.
 */
function alongRoutes(
  nodes: readonly Node[],
  edges: readonly Edge[],
  routes: TidyResult['routes'],
  relayout: boolean,
  byHand: ReadonlyMap<string, readonly Point[]>,
): ConnectionEdge[] {
  const at = new Map(nodes.map((n) => [n.id, n.position]));
  return (edges as ConnectionEdge[]).map((edge) => {
    if (edge.type === 'stub') return edge;
    const kept = byHand.get(edge.id);
    const points = kept ?? routes.get(edge.id);
    const [source, target] = [at.get(edge.source), at.get(edge.target)];
    if (points === undefined || source === undefined || target === undefined) {
      return relayout
        ? {
            ...edge,
            data: {
              ...edge.data,
              bendPoints: undefined,
              bendAnchors: undefined,
              bendManual: undefined,
            },
          }
        : edge;
    }
    return {
      ...edge,
      data: {
        ...edge.data,
        bendPoints: points.map(([x, y]): [number, number] => [x, y]),
        bendAnchors: { source: { ...source }, target: { ...target } },
        bendManual: kept !== undefined ? true : undefined,
      },
    };
  });
}

/**
 * Plan a tidy of `graph`, the diagram as `buildGraph` made it with the nodes
 * where they are now, for the case whose topology is `topology`.
 */
export function planTidy(
  graph: { nodes: Node[]; edges: Edge[] },
  topology: TopologySummary,
  options: TidyPlanOptions,
): TidyPlan {
  // A re-layout moves what the routes drawn by hand are attached to. Where
  // the picture it gives would have something on something else, it is
  // planned again without the ones that have a part in that, and after two
  // such rounds without any that are left.
  const letGo = new Set<string>();
  for (let round = 0; ; round += 1) {
    const plan = planOnce(graph, topology, options, letGo);
    if (plan.refused === undefined || !options.relayout) return plan;
    const kept = [...(plan.byHand?.keys() ?? []), ...(plan.connectorsByHand?.keys() ?? [])];
    if (kept.length === 0) return plan;
    const blamed = kept.filter((id) => plan.blamed?.includes(id) === true);
    for (const id of round < 2 && blamed.length > 0 ? blamed : kept) letGo.add(id);
  }
}

/** `edge` without a route of its own. */
function withoutRoute<E extends Edge>(edge: E): E {
  return {
    ...edge,
    data: { ...edge.data, bendPoints: undefined, bendAnchors: undefined, bendManual: undefined },
  };
}

/** One plan of `planTidy`, without the routes drawn by hand that are named in `letGo`. */
function planOnce(
  graph: { nodes: Node[]; edges: Edge[] },
  topology: TopologySummary,
  options: TidyPlanOptions,
  letGo: ReadonlySet<string>,
): TidyPlan {
  const { relayout, barLengths, steps } = options;
  const sizes = options.sizes ?? new Map<string, NodeSize>();
  const connectionOptions = { sizes, connectorStyle: options.connectorStyle, barLengths };
  let { nodes, edges } = graph;
  if (relayout) {
    // The buses onto the grid; then the branches between the buses alone,
    // which gives each the way it would have with nothing else about; then
    // every device beside its bus, over or under the bar so that its
    // connector drops square, and clear of those ways where the bar has
    // such a place. The branches are routed once more below, around the
    // devices as they now stand.
    const buses: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      if (n.type === 'bus') buses[n.id] = { x: n.position.x, y: n.position.y };
    }
    const aligned = alignToGrid(buses, barLengths);
    const bare = buildGraph(
      { ...topology, generators: [], loads: [], shunts: [], controllers: [] },
      aligned,
      { barLengths },
    );
    // A rough routing does for placing the devices: a quarter of the steps.
    const first = tidyRoutes(bare.nodes, bare.edges as ConnectionEdge[], {
      barLengths,
      steps: (steps ?? TIDY_STEPS) / 4,
    });
    const bendAnchors = new Map<
      string,
      { source: { x: number; y: number }; target: { x: number; y: number } }
    >();
    for (const edge of bare.edges) {
      const [source, target] = [aligned[edge.source], aligned[edge.target]];
      if (first.routes.has(edge.id) && source !== undefined && target !== undefined) {
        bendAnchors.set(edge.id, { source: { ...source }, target: { ...target } });
      }
    }
    const placed = buildGraph(topology, aligned, {
      bendPoints: first.routes,
      bendAnchors,
      barLengths,
      controllerCoords: options.controllerCoords,
      unitStates: options.unitStates,
      deviceDetour: 0,
      // Each device was given a place clear of what stands around it; a
      // push afterwards would only take it off its bar.
      applyPushOut: false,
    });
    nodes = placed.nodes;
    // The diagram was built again from the topology: the routes that were
    // drawn by hand go back on their edges, as they were drawn and for
    // where their ends stood then, to be brought along from there.
    const drawnByHand = new Map(
      graph.edges
        .filter((edge) => edge.data?.bendManual === true && !letGo.has(edge.id))
        .map((edge) => [edge.id, edge]),
    );
    edges = placed.edges.map((edge) => {
      const held = drawnByHand.get(edge.id)?.data;
      return held === undefined
        ? edge
        : {
            ...edge,
            data: {
              ...edge.data,
              bendPoints: held.bendPoints,
              bendAnchors: held.bendAnchors,
              bendManual: true,
            },
          };
    });
  }
  // The chains that are drawn out, where they stand or will stand, and where
  // the readouts of the devices stand with no branch drawn: a route goes
  // round the first, and keeps out of the second where it can.
  const chains = chainBoxes(relayout ? nodes : (options.drawn ?? nodes), sizes);
  const connectors = layoutConnections(
    nodes,
    (edges as ConnectionEdge[]).filter((edge) => edge.type === 'stub'),
    connectionOptions,
  );
  // The routes that were drawn by hand and are no longer drawn that way.
  const released: string[] = graph.edges
    .filter((edge) => letGo.has(edge.id))
    .map((edge) => edge.id);
  // The connectors that were drawn by hand, where a re-layout has put their
  // devices: each as it is drawn there, and one that does not hold there
  // like any other connector from now on.
  const connectorsByHand = new Map<string, Point[]>();
  if (relayout) {
    const at = new Map(nodes.map((n) => [n.id, n.position]));
    edges = edges.map((edge) => {
      if (edge.type !== 'stub' || edge.data?.bendManual !== true) return edge;
      const points = connectors.routes.get(edge.id)?.points;
      const [source, target] = [at.get(edge.source), at.get(edge.target)];
      if (
        !connectors.byHand.has(edge.id) ||
        points === undefined ||
        source === undefined ||
        target === undefined
      ) {
        released.push(edge.id);
        return withoutRoute(edge);
      }
      connectorsByHand.set(edge.id, points);
      // As the canvas holds it once the plan is in place: drawn for where
      // its device and its bus stand now.
      return {
        ...edge,
        data: {
          ...edge.data,
          bendPoints: points.map(([x, y]): [number, number] => [x, y]),
          bendAnchors: { source: { ...source }, target: { ...target } },
        },
      };
    });
  }
  // The diagram as it is drawn now, where the plan is for one on screen and
  // moves nothing: the label of each bus keeps the place it has there.
  const shown: PictureOptions | null =
    options.shown === undefined ? null : { ...connectionOptions, ...options.shown };
  const drawnNow =
    shown === null || relayout ? null : pictureOf(nodes, edges as ConnectionEdge[], shown);
  const labels = [...(drawnNow?.busLabels.values() ?? [])].map(({ box }) => box);
  // The routes that were drawn by hand: each as it is drawn with the nodes
  // where they will stand, among the device connectors alone. One whose bus
  // a re-layout has moved is brought along, and one that is then on
  // something is routed with the rest.
  const byHand = new Map<string, Point[]>();
  const handDrawn = (edges as ConnectionEdge[]).filter(
    (edge) => edge.type !== 'stub' && edge.data?.bendManual === true,
  );
  if (handDrawn.length > 0) {
    const stubs = (edges as ConnectionEdge[]).filter((edge) => edge.type === 'stub');
    const held = routeDiagram(nodes, [...stubs, ...handDrawn], {
      ...connectionOptions,
      obstacles: [...chains.values()],
      steps: 0,
    });
    const letGo = new Set([...held.released, ...held.unrouted]);
    for (const edge of handDrawn) {
      const points = held.connections.routes.get(edge.id)?.points;
      if (points === undefined || letGo.has(edge.id)) released.push(edge.id);
      else byHand.set(edge.id, points);
    }
  }
  const kept = {
    ...(byHand.size > 0 ? { byHand } : {}),
    ...(connectorsByHand.size > 0 ? { connectorsByHand } : {}),
  };
  const given = released.length > 0 ? { released } : {};
  /**
   * The routes, made afresh: all of them but the ones drawn by hand, or
   * all but those and the ones in `keep`, and with `shut` through no place
   * where the label of a bus stands.
   */
  const route = (
    keep?: ReadonlyMap<string, readonly Point[]>,
    shut = false,
    within = steps,
  ): TidyResult =>
    tidyRoutes(nodes, edges as ConnectionEdge[], {
      ...connectionOptions,
      obstacles: [...chains.values()],
      labels: shut ? labels : undefined,
      keepFree: readoutReserve(nodes, connectors, sizes, { chains }),
      preferFree: busLabelReserve(nodes, connectors, sizes, { chains }),
      steps: within,
      keep: byHand.size === 0 ? keep : new Map([...(keep ?? []), ...byHand]),
    });
  const tidied = route();
  if (shown === null) return { nodes, edges, tidied, ...kept, ...given };

  // ---- held to the picture it gives ----
  const overlapsOf = (picture: Picture<ConnectionEdge>, drawnNodes: readonly Node[]): Overlap[] =>
    findOverlaps(drawnDiagram(drawnNodes, picture, shown));
  let overlapsNow: Overlap[] | null = null;
  /** What the diagram has drawn over what as it stands, before anything is planned. */
  const drawnOverlaps = (): Overlap[] =>
    (overlapsNow ??= overlapsOf(
      drawnNow ?? pictureOf(graph.nodes, graph.edges as ConnectionEdge[], shown),
      graph.nodes,
    ));
  /**
   * What does not hold in `picture`, which has `overlaps` drawn over each
   * other, by id: the lines no way was found for, and whatever is on
   * something or has something on it.
   */
  const amissIn = (picture: Picture<ConnectionEdge>, overlaps: readonly Overlap[]): Set<string> => {
    const amiss = new Set(picture.unrouted);
    for (const { a, b } of overlaps) {
      // A box that is drawn on a line (the symbol of a transformer) goes by that line.
      for (const id of [a, b]) amiss.add(id).add(id.slice(id.indexOf(':') + 1));
    }
    return amiss;
  };
  // The routes that hold as the diagram draws them now: on nothing, and no
  // stand-in for a way that was not found. Every other line or transformer
  // that is not drawn by hand is one to mend: it is drawn the plain way, or
  // on something.
  const holds = new Map<string, Point[]>();
  const toMend: string[] = [];
  if (drawnNow !== null) {
    const amiss = amissIn(drawnNow, drawnOverlaps());
    for (const edge of edges) {
      if (edge.type === 'stub' || byHand.has(edge.id)) continue;
      const points = drawnNow.connections.routes.get(edge.id)?.points;
      if (points === undefined || amiss.has(edge.id)) toMend.push(edge.id);
      else {
        holds.set(
          edge.id,
          points.map(([x, y]): Point => [x, y]),
        );
      }
    }
  }
  /**
   * What is wrong with the picture the diagram gives with `routes` in
   * place: what it has drawn over what that it has not now (nothing, for a
   * plan that leaves no more on each other than there is: a layout that
   * came with two symbols on each other is tidied all the same), and the
   * buses whose label is worse off than it is now (left with its name
   * alone, or without a place by its bar). With them how many of the lines
   * to mend it leaves unmended (`gone`: still drawn the plain way, or on
   * something), and the picture itself.
   */
  let known: Set<string> | null = null;
  const faults = (
    routes: TidyResult['routes'],
  ): { overlaps: Overlap[]; labels: string[]; gone: number; picture: Picture<ConnectionEdge> } => {
    const picture = pictureOf(nodes, alongRoutes(nodes, edges, routes, relayout, byHand), shown);
    const found = overlapsOf(picture, nodes);
    let overlaps: Overlap[] = [];
    if (found.length > 0) {
      known ??= new Set(drawnOverlaps().map(nameOf));
      if (found.length > known.size) overlaps = found.filter((o) => !known!.has(nameOf(o)));
    }
    const labels: string[] = [];
    for (const [bus, now] of drawnNow?.busLabels ?? []) {
      const label = picture.busLabels.get(bus);
      if (label !== undefined && busLabelLack(label) > busLabelLack(now)) labels.push(bus);
    }
    const amiss = toMend.length === 0 ? null : amissIn(picture, found);
    const gone = amiss === null ? 0 : toMend.filter((id) => amiss.has(id)).length;
    return { overlaps, labels, gone, picture };
  };
  type Faults = ReturnType<typeof faults>;
  /**
   * A plan with what is wrong with its picture. `starved` where the steps
   * ran out before what is wrong could be mended.
   */
  type Held = { tidied: TidyResult; found: Faults; starved?: true };
  // The steps the plans that leave some routes as they are may take, all of
  // them together (below): a part of what routing every line afresh may.
  // The plan that leaves every route that holds as it is routes the lines
  // that do not, which no tidy may leave undone: each routing of it has
  // `least` steps whatever was taken before.
  let spare = (steps ?? TIDY_STEPS) * KEEP_STEPS;
  const least = (steps ?? TIDY_STEPS) * LAST_STEPS;
  const none = (found: Faults): boolean => found.overlaps.length === 0 && found.labels.length === 0;
  /**
   * The plan that leaves least wrong with its picture, with the routes
   * `stay` left as they are drawn now (none of them, for a plan that makes
   * every route afresh) and the rest routed around them. `null` where there
   * are no steps left to route them with.
   */
  const heldToPicture = (stay: ReadonlyMap<string, Point[]>): Held | null => {
    /** `made`, with the routes that stay as they are among its routes. */
    const withKept = (made: TidyResult, more?: ReadonlyMap<string, Point[]>): TidyResult =>
      stay.size === 0 && more === undefined
        ? made
        : { ...made, routes: new Map([...made.routes, ...stay, ...(more ?? [])]) };
    /**
     * The routes made again around `keep`, within the steps that are left
     * for it: `null` with none left, since a routing that may take no step
     * finds no line a way.
     */
    const again = (keep: ReadonlyMap<string, Point[]>, shut = false): TidyResult | null => {
      if (stay.size === 0) return route(keep.size === 0 ? undefined : keep, shut);
      const within = stay.size === holds.size ? Math.max(spare, least) : spare;
      if (within <= 0) return null;
      const made = route(keep, shut, within);
      spare -= made.steps;
      return made;
    };
    const routed = stay.size === 0 ? tidied : again(stay);
    if (routed === null) return null;
    const plain = withKept(routed);
    const first = faults(plain.routes);
    // The plan that leaves least wrong, of the ones tried: nothing drawn
    // over anything comes first, then no line left unmended, then a label
    // that is as well off as it was.
    let best: Held = { tidied: plain, found: first };
    if (none(first) || drawnNow === null) return best;
    /**
     * Whether `best` has nothing wrong with its picture, once `other` was
     * held against it: routes made another way, around `more` as well, or
     * `null` where there were no steps left to make them.
     */
    const offer = (other: TidyResult | null, more?: ReadonlyMap<string, Point[]>): boolean => {
      if (other === null) {
        best = { ...best, starved: true };
        return false;
      }
      const candidate = withKept(other, more);
      const found = faults(candidate.routes);
      const order = [
        found.overlaps.length - best.found.overlaps.length,
        found.gone - best.found.gone,
        found.labels.length - best.found.labels.length,
      ];
      if ((order.find((by) => by !== 0) ?? 0) < 0) best = { tidied: candidate, found };
      return none(best.found);
    };
    // With no route through a place where a label stands.
    if (first.labels.length > 0 && offer(again(stay, true))) return best;
    // With the lines of the buses that have a part in it kept as they are
    // drawn now, and with them the bars their length and the symbols of the
    // transformers their places; the others are routed again around those.
    const busesOf = new Map<string, string[]>();
    for (const edge of edges) {
      busesOf.set(edge.id, edge.type === 'stub' ? [edge.target] : [edge.source, edge.target]);
      if (edge.type === 'stub') busesOf.set(edge.source, [edge.target]);
    }
    const buses = new Set(
      [first, best.found].flatMap((found) => [
        ...found.overlaps.flatMap(({ a, b }) => [a, b]).flatMap((id) => busesOf.get(id) ?? [id]),
        ...found.labels,
      ]),
    );
    const keep = new Map<string, Point[]>();
    for (const edge of edges) {
      if (edge.type === 'stub' || (!buses.has(edge.source) && !buses.has(edge.target))) continue;
      if (byHand.has(edge.id) || stay.has(edge.id)) continue;
      const points = drawnNow.connections.routes.get(edge.id)?.points;
      if (points !== undefined && !drawnNow.unrouted.includes(edge.id)) {
        keep.set(
          edge.id,
          points.map(([x, y]): Point => [x, y]),
        );
      }
    }
    if (keep.size > 0) offer(again(new Map([...stay, ...keep]), true), keep);
    return best;
  };
  /** `held` as the plan it is: refused where its picture has something drawn over something else. */
  const planOf = ({ tidied: made, found }: Held, left: readonly string[] = []): TidyPlan => {
    const settled = { nodes, edges, tidied: made, ...kept, ...given };
    // A label that is worse off is no reason to leave the lines untidied.
    if (found.overlaps.length === 0) {
      if (left.length === 0) return settled;
      // A line that is left on a route that holds has not gone without one.
      const unrouted = made.unrouted.filter((id) => !left.includes(id));
      return { ...settled, tidied: { ...made, unrouted }, left: [...left] };
    }
    // The lines and connectors that have a part in what is left, each once: a
    // box that is drawn on a line (its flow label, the symbol of a
    // transformer) goes by that line.
    const lines = new Set(edges.map((edge) => edge.id));
    const blamed = new Set<string>();
    for (const { a, b } of found.overlaps) {
      for (const id of [a, b]) {
        const line = id.slice(id.indexOf(':') + 1);
        if (lines.has(id)) blamed.add(id);
        else if (lines.has(line)) blamed.add(line);
      }
    }
    return { ...settled, refused: describeOverlaps(found.overlaps), blamed: [...blamed] };
  };
  // Every route afresh: there are always the steps for that.
  const afresh = heldToPicture(new Map())!;
  if (drawnNow === null) return planOf(afresh);

  // ---- and to leaving no line worse off ----
  // A route that holds as the diagram draws it now (`holds`) is given up
  // only for a better one: no longer, with no more bends and across no more
  // lines, and less of one of the three. Where a plan would leave a line
  // worse off, or change it for no gain, the line keeps the route it has
  // and the rest are routed around it; and where a line that stays would be
  // crossed by more lines than it is now, the ones that newly cross it keep
  // theirs. After `KEEP_ROUNDS` of that, every route that holds stays, and
  // only the ones that do not are made afresh.
  const linesOf = (picture: Picture<ConnectionEdge>): readonly DrawnLine[] =>
    drawnDiagram(nodes, picture, shown).lines;
  const before = routeMeasures(linesOf(drawnNow));
  let stay = new Map<string, Point[]>();
  // The last plan that may be put in place: nothing drawn over anything
  // else, and no line that does not hold left as it is that a plan before
  // it had found a way for. With it the lines it leaves on their routes.
  let sound: { held: Held; left: string[] } | null = null;
  for (let round = 0; ; round += 1) {
    const everyOne = stay.size === holds.size;
    const held = stay.size === 0 ? afresh : heldToPicture(stay);
    if (
      held === null ||
      held.found.overlaps.length > 0 ||
      (sound !== null && held.found.gone > sound.held.found.gone) ||
      (held.starved === true && !everyOne)
    ) {
      // No plan to take: there were no steps left to make it with, or to
      // mend it with; something would be drawn over something else; or a
      // line that does not hold would stay as it is though a plan before
      // found it a way (the routes that stay left it none, or the steps ran
      // out). With every route that holds left as it is, then, which has
      // steps of its own; and where that is no plan to take either, the
      // last one that was: a line that stays on something is worse than one
      // that is changed for no gain. With none such, every plan would draw
      // something over something else, and the one that was made is refused.
      if (!everyOne) {
        stay = new Map(holds);
        continue;
      }
      if (sound !== null) return planOf(sound.held, sound.left);
      return planOf(held ?? afresh);
    }
    const lines = linesOf(held.found.picture);
    const drawnAs = new Map(lines.map((line) => [line.id, line.points]));
    const after = routeMeasures(lines);
    /** The lines that are to have the route they are drawn along now back. */
    const back = new Set<string>();
    /** The ones that are left on it. */
    const left: string[] = [];
    for (const [id, points] of holds) {
      const [was, now] = [before.get(id), after.get(id)];
      if (was === undefined || now === undefined) continue;
      if (sameRoute(points, drawnAs.get(id) ?? [])) {
        left.push(id);
        // Only the lines across it can have changed.
        if (crossingsOf(now) <= crossingsOf(was)) continue;
        for (const other of now.crossed.keys()) {
          if (!was.crossed.has(other) && holds.has(other) && !stay.has(other)) back.add(other);
        }
      } else if (!stay.has(id) && !betterRoute(now, was)) back.add(id);
    }
    if (back.size === 0) return planOf(held, left);
    sound = { held, left };
    // The ones that are left on their route stay on it from here on: only
    // the lines that were given a better one are routed again, around the
    // rest, and fewer of them with every round.
    stay = new Map(holds);
    if (round < KEEP_ROUNDS) {
      for (const [id] of holds) {
        if (!left.includes(id) && !back.has(id)) stay.delete(id);
      }
    }
  }
}

/**
 * How many times the lines a tidy would leave worse off are given their
 * routes back and the others routed around them, before every route that
 * holds is left as it is; how much of the steps of a tidy those rounds may
 * take together; and how much each routing of the last of them may take at
 * the least, the one that leaves every route that holds as it is and routes
 * the rest. A line whose route holds and that is not reached within them
 * keeps the route it has; one whose route does not hold is not left
 * without a way for want of steps (`planOnce`).
 */
const KEEP_ROUNDS = 3;
const KEEP_STEPS = 1 / 3;
const LAST_STEPS = 1 / 3;

/** What a route is measured by where a tidy is held to leaving no line worse off. */
interface RouteMeasure {
  length: number;
  bends: number;
  /** The lines and connectors that cross it, each with the number of places. */
  crossed: ReadonlyMap<string, number>;
}

const NO_CROSSINGS: ReadonlyMap<string, number> = new Map();

/** How many places `measure` is crossed in. */
function crossingsOf({ crossed }: RouteMeasure): number {
  let count = 0;
  for (const times of crossed.values()) count += times;
  return count;
}

/** Each of `lines` as a tidy measures it, by id. */
function routeMeasures(lines: readonly DrawnLine[]): Map<string, RouteMeasure> {
  const crossings = crossingsByLine(lines);
  return new Map(
    lines.map(({ id, points }) => {
      let length = 0;
      for (let i = 1; i < points.length; i += 1) {
        length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
      }
      return [
        id,
        {
          length,
          bends: Math.max(0, points.length - 2),
          crossed: crossings.get(id) ?? NO_CROSSINGS,
        },
      ];
    }),
  );
}

/** A route this much shorter or longer than another is as long as it. */
const SAME_LENGTH = 0.5;

/**
 * Whether the route measured as `now` is one to give the route measured as
 * `was` up for: no longer, with no more bends and across no more lines,
 * and better in one of the three.
 */
function betterRoute(now: RouteMeasure, was: RouteMeasure): boolean {
  const [across, acrossBefore] = [crossingsOf(now), crossingsOf(was)];
  if (now.length > was.length + SAME_LENGTH || now.bends > was.bends || across > acrossBefore) {
    return false;
  }
  return now.length < was.length - SAME_LENGTH || now.bends < was.bends || across < acrossBefore;
}

/** Whether two routes run through the same points. */
function sameRoute(a: readonly Point[], b: readonly Point[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 0.01 && Math.abs(p[1] - b[i]![1]) < 0.01)
  );
}

/**
 * The lines and transformers that are drawn through a generator, load or
 * shunt, or through the bar of a bus they are not connected to: the ones a
 * tidy would route clear. A branch whose bus was moved is drawn from tap to
 * tap until the diagram is tidied again, whatever stands in between, and a
 * device dropped on a route stays on it; the Tidy diagram button counts
 * them (`SldArrangeControls`).
 */
export function branchesThroughSymbols(
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  connections: ConnectionLayout,
  sizes: ReadonlyMap<string, NodeSize> = new Map(),
): string[] {
  const branches = new Map<string, ConnectionEdge>();
  const routes = new Map<string, ConnectorRoute>();
  for (const edge of edges) {
    const route = connections.routes.get(edge.id);
    if (edge.type === 'stub' || route === undefined) continue;
    branches.set(edge.id, edge);
    routes.set(edge.id, route);
  }
  if (routes.size === 0) return [];
  const through = runsIn(routes);
  const found = new Set<string>();
  for (const node of nodes) {
    const { x, y } = node.position;
    if ((node.type ?? 'bus') === 'bus') {
      const bar = connections.bars.get(node.id);
      const box = {
        left: x + (bar?.start ?? 0),
        right: x + (bar?.end ?? BAR_LENGTH),
        top: y,
        bottom: y + BAR_THICKNESS,
      };
      for (const { id } of through(box)) {
        const edge = branches.get(id)!;
        if (edge.source !== node.id && edge.target !== node.id) found.add(id);
      }
      continue;
    }
    if (node.type !== 'generator' && node.type !== 'load' && node.type !== 'shunt') continue;
    const size = sizes.get(node.id);
    const width = size?.width ?? node.initialWidth ?? 0;
    const height = size?.height ?? node.initialHeight ?? 0;
    for (const { id } of through({ left: x, right: x + width, top: y, bottom: y + height })) {
      found.add(id);
    }
  }
  return [...found];
}
