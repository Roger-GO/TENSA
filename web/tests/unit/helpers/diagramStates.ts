/**
 * The states a diagram goes through in the app, for the tests that hold a
 * whole drawing to a rule: as a case opens with no saved layout (the
 * automatic arrangement), after Tidy diagram, after Tidy and re-layout,
 * after a bus or a device was dragged, and after a line was moved by hand.
 * Each state is made the way the canvas makes it (`useAutoLayout`,
 * `planTidy`, `pictureOf`, `routesDrawClear`), so what a test checks is what
 * the canvas draws.
 *
 * A test that opens a case mocks `@/components/sld/elkClient` with the ELK
 * engine run in-thread: jsdom has no `Worker`.
 */
import type { Edge, Node } from '@xyflow/react';
import type { TopologySummary } from '@/api/types';
import type { ConnectionEdge, Point } from '@/components/sld/connections';
import { clearDrop } from '@/components/sld/dropPlace';
import { buildGraph, defaultBarLengths, type BuildGraphOptions } from '@/components/sld/graph';
import { autoLayout } from '@/components/sld/layout';
import { describeOverlaps, findOverlaps } from '@/components/sld/overlapCheck';
import {
  drawnDiagram,
  drawsClear,
  pictureOf,
  routesDrawClear,
  type Picture,
  type PictureOptions,
} from '@/components/sld/picture';
import { planTidy, type TidyPlan } from '@/components/sld/tidyPlan';
import { arrangeDiagram } from '@/components/sld/useAutoLayout';

/** A diagram as the canvas holds it: the nodes where they stand, and the edges with their routes. */
export interface Diagram {
  topology: TopologySummary;
  nodes: Node[];
  edges: Edge[];
  barLengths: Map<string, number>;
}

/** `topology` as its case opens with no saved layout. */
export async function opened(
  topology: TopologySummary,
  options: Pick<BuildGraphOptions, 'unitStates'> = {},
): Promise<Diagram> {
  const elk = await autoLayout(topology, undefined, { routes: false });
  const { coords, arrangement } = await arrangeDiagram(topology, elk.coords);
  const barLengths = defaultBarLengths(topology);
  const { nodes, edges } = buildGraph(topology, coords, {
    bendPoints: arrangement.routes,
    bendAnchors: arrangement.anchors,
    nonBusCoords: arrangement.devices,
    barLengths,
    ...options,
  });
  return { topology, nodes, edges, barLengths };
}

/** The picture of `diagram`, with or without the values of a power flow. */
export function drawn(
  diagram: Diagram,
  options: Omit<PictureOptions, 'barLengths'> = { values: false },
): Picture<ConnectionEdge> {
  return pictureOf(diagram.nodes, diagram.edges as ConnectionEdge[], {
    barLengths: diagram.barLengths,
    ...options,
  });
}

/** `diagram` with the routes its picture made kept as its own, as the canvas keeps them at rest. */
export function settled(diagram: Diagram): Diagram {
  return { ...diagram, edges: drawn(diagram).edges as Edge[] };
}

/**
 * `diagram` after Tidy diagram, or after Tidy and re-layout: the plan, put
 * in place, and `diagram` itself where the plan is refused for what it
 * would draw over what. `shown` is how the diagram is drawn when the tidy
 * is asked for: without the values of a power flow, unless it says so.
 */
export function tidied(
  diagram: Diagram,
  relayout: boolean,
  shown: Pick<PictureOptions, 'values' | 'labelWidths'> = { values: false },
): Diagram {
  const plan = planTidy({ nodes: diagram.nodes, edges: diagram.edges }, diagram.topology, {
    relayout,
    barLengths: diagram.barLengths,
    shown,
  });
  return withPlan(diagram, plan);
}

/**
 * `diagram` with `plan` put in place, the way the canvas puts a plan of
 * `planTidy` in place, and `diagram` itself where the plan is refused.
 */
export function withPlan(diagram: Diagram, plan: TidyPlan): Diagram {
  if (plan.refused !== undefined) return diagram;
  const at = new Map(plan.nodes.map((n) => [n.id, n.position]));
  const edges = plan.edges.map((edge) => {
    // A route that was drawn by hand stays as the plan has it, and is still
    // the user's; any other is the one the plan made.
    const kept = plan.byHand?.get(edge.id);
    const points = kept ?? plan.tidied.routes.get(edge.id);
    if (edge.type === 'stub' || points === undefined) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        bendPoints: points,
        bendAnchors: { source: { ...at.get(edge.source)! }, target: { ...at.get(edge.target)! } },
        bendManual: kept !== undefined ? true : undefined,
      },
    };
  });
  return { ...diagram, nodes: plan.nodes, edges };
}

/**
 * `diagram` with the route of the edge `id` drawn by hand through `points`,
 * as the canvas keeps a route its editor hands it: with where the two ends
 * stand as what it was drawn for, and only where the picture the diagram
 * then gives has nothing drawn over anything else that it has not now
 * (`routesDrawClear`). `null` where the canvas refuses the route.
 */
export function routedByHand(
  diagram: Diagram,
  id: string,
  points: readonly Point[],
): Diagram | null {
  const at = new Map(diagram.nodes.map((n) => [n.id, n.position]));
  const edges = diagram.edges.map((edge) =>
    edge.id !== id
      ? edge
      : {
          ...edge,
          data: {
            ...edge.data,
            bendPoints: points.map(([x, y]): [number, number] => [x, y]),
            bendAnchors: {
              source: { ...at.get(edge.source)! },
              target: { ...at.get(edge.target)! },
            },
            bendManual: true,
          },
        },
  );
  const clear = routesDrawClear(diagram.nodes, diagram.edges as ConnectionEdge[], {
    barLengths: diagram.barLengths,
    values: false,
  });
  if (!clear(edges as ConnectionEdge[])) return null;
  return settled({ ...diagram, edges });
}

/** The edges of `diagram` whose route is drawn by hand, each with the points it is drawn through. */
export function routesByHand(diagram: Diagram): Map<string, Point[]> {
  const { connections } = drawn(diagram);
  const out = new Map<string, Point[]>();
  for (const edge of diagram.edges) {
    const points = connections.routes.get(edge.id)?.points;
    if (edge.data?.bendManual === true && points !== undefined) out.set(edge.id, points);
  }
  return out;
}

/** The nodes that go along when the node `id` is dragged: itself, and for a bus its devices. */
export function draggedWith(diagram: Diagram, id: string): Set<string> {
  return new Set(
    diagram.nodes
      .filter((n) => n.id === id || (n.data as { parentBus?: string }).parentBus === id)
      .map((n) => n.id),
  );
}

/** `diagram` with the nodes `ids` moved by `dx`, `dy`, as while they are dragged: nothing routed again. */
export function moved(diagram: Diagram, ids: ReadonlySet<string>, dx: number, dy: number): Diagram {
  const nodes = diagram.nodes.map((n) =>
    ids.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n,
  );
  return { ...diagram, nodes };
}

/**
 * How far the canvas shifts the nodes `ids` of `diagram` when they are
 * dropped where they stand (`clearDrop`): `null` where they are clear.
 * `before` is the diagram as it stood before they were moved: a place is
 * held to its picture as well (`drawsClear`), and with no clear place near
 * the nodes go back to where they stood in it.
 */
export function dropShift(
  diagram: Diagram,
  ids: ReadonlySet<string>,
  before: Diagram = diagram,
): { dx: number; dy: number; back?: true } | null {
  const { connections } = drawn(diagram, { values: false, dragging: true });
  const one = diagram.nodes.find((n) => ids.has(n.id));
  const stood = before.nodes.find((n) => n.id === one?.id);
  return clearDrop(diagram.nodes, diagram.edges as ConnectionEdge[], ids, connections, {
    atRest: drawn(before).connections,
    clear: drawsClear(before.nodes, before.edges as ConnectionEdge[], {
      barLengths: diagram.barLengths,
      values: false,
    }),
    back:
      one === undefined || stood === undefined
        ? undefined
        : { dx: stood.position.x - one.position.x, dy: stood.position.y - one.position.y },
  });
}

/**
 * `diagram` after the node `id` was dragged by `dx`, `dy` and dropped: a bus
 * takes its generators, loads and shunts along, what was dropped on
 * something stands in the nearest free place, as the canvas puts it there
 * (or back where it stood, with no free place near), and the routes are the
 * ones the canvas makes for the diagram at rest. `shift` is how far the
 * canvas shifts what was dropped, where the caller has asked already
 * (`dropShift`).
 */
export function dragged(
  diagram: Diagram,
  id: string,
  dx: number,
  dy: number,
  shift?: { dx: number; dy: number } | null,
): Diagram {
  const ids = draggedWith(diagram, id);
  let dropped = moved(diagram, ids, dx, dy);
  const by = shift === undefined ? dropShift(dropped, ids, diagram) : shift;
  if (by !== null) dropped = moved(dropped, ids, by.dx, by.dy);
  return settled(dropped);
}

/** Every place where two things of `diagram` are drawn on each other, as text. */
export function overlapsOf(
  diagram: Diagram,
  options: Omit<PictureOptions, 'barLengths'> = { values: false },
): string[] {
  const picture = drawn(diagram, options);
  return describeOverlaps(findOverlaps(drawnDiagram(diagram.nodes, picture, options)));
}

/**
 * The widths the values of a solved case have on screen: a readout of two
 * lines such as `-21.6 MVAr`, a flow such as `-25.97 MW` after its arrow.
 */
export function typicalWidths(diagram: Diagram) {
  return {
    readouts: new Map(diagram.nodes.map((n) => [n.id, 62])),
    flows: new Map(diagram.edges.map((e) => [e.id, 78])),
  };
}

/** Both ways a state is looked at: as it is, and with the values of a power flow on it. */
export function bothWays(diagram: Diagram): string[] {
  return [
    ...overlapsOf(diagram, { values: false }).map((found) => `plain: ${found}`),
    ...overlapsOf(diagram, { values: true }).map((found) => `values: ${found}`),
    ...overlapsOf(diagram, { values: true, labelWidths: typicalWidths(diagram) }).map(
      (found) => `values as wide as they are: ${found}`,
    ),
  ];
}

/**
 * Every place where two things are on each other while the nodes `ids` of
 * `diagram` are dragged to where they stand: the picture of a move, made
 * from the routes the diagram had before it.
 */
export function whileDragged(diagram: Diagram, before: Diagram, values: boolean): string[] {
  const picture = pictureOf(diagram.nodes, before.edges as ConnectionEdge[], {
    barLengths: diagram.barLengths,
    values,
    dragging: true,
  });
  return [
    ...picture.unrouted.map((id) => `no route for ${id}`),
    ...describeOverlaps(findOverlaps(drawnDiagram(diagram.nodes, picture, { values }))),
  ];
}

/**
 * Every place where two things are on each other at each move of a drag of
 * the node `id` by `dx`, `dy`, a move every `step`: each move is drawn from
 * the routes the moves before it made, the way the canvas carries them
 * through a drag (`dragRoutesRef` in `SldCanvas.tsx`). Only the moves count
 * that do not put what is dragged on something.
 */
export function alongDrag(
  first: Diagram,
  id: string,
  dx: number,
  dy: number,
  step: number,
): string[] {
  const ids = draggedWith(first, id);
  const moves = Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / step);
  const carried = new Map<string, { points: [number, number][]; anchors: unknown }>();
  const found: string[] = [];
  for (let k = 1; k <= moves; k += 1) {
    const there = moved(first, ids, (dx * k) / moves, (dy * k) / moves);
    const at = new Map(there.nodes.map((n) => [n.id, n.position]));
    const sits = (node: string, then: { x: number; y: number } | undefined): boolean =>
      then !== undefined && at.get(node)!.x === then.x && at.get(node)!.y === then.y;
    const edges = first.edges.map((edge) => {
      const route = carried.get(edge.id);
      const kept = (
        edge.data as { bendAnchors?: Record<'source' | 'target', { x: number; y: number }> }
      ).bendAnchors;
      // Back where the route it keeps was made for, a branch is drawn along that one.
      if (
        route === undefined ||
        (sits(edge.source, kept?.source) && sits(edge.target, kept?.target))
      ) {
        return edge;
      }
      return {
        ...edge,
        data: { ...edge.data, bendPoints: route.points, bendAnchors: route.anchors },
      };
    });
    const picture = pictureOf(there.nodes, edges as ConnectionEdge[], {
      barLengths: there.barLengths,
      values: false,
      dragging: true,
    });
    for (const [edge, route] of picture.changed) carried.set(edge, route);
    const here = describeOverlaps(
      findOverlaps(drawnDiagram(there.nodes, picture, { values: false })),
    );
    // What a drag passes through and a drop does not stay on is not held to the rule.
    if (here.length === 0 || dropShift(there, ids, first) !== null) continue;
    found.push(...here.map((text) => `bus ${id} by ${dx}, ${dy}, move ${k} of ${moves}: ${text}`));
  }
  return found;
}
