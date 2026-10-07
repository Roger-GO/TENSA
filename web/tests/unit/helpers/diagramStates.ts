/**
 * The states a diagram goes through in the app, for the tests that hold a
 * whole drawing to a rule: as a case opens with no saved layout (the
 * automatic arrangement), after Tidy diagram, after Tidy and re-layout, and
 * after a bus or a device was dragged. Each state is made the way the
 * canvas makes it (`useAutoLayout`, `planTidy`, `pictureOf`), so what a
 * test checks is what the canvas draws.
 *
 * A test that opens a case mocks `@/components/sld/elkClient` with the ELK
 * engine run in-thread: jsdom has no `Worker`.
 */
import type { Edge, Node } from '@xyflow/react';
import type { TopologySummary } from '@/api/types';
import type { ConnectionEdge } from '@/components/sld/connections';
import { buildGraph, defaultBarLengths, type BuildGraphOptions } from '@/components/sld/graph';
import { autoLayout } from '@/components/sld/layout';
import { describeOverlaps, findOverlaps } from '@/components/sld/overlapCheck';
import {
  drawnDiagram,
  pictureOf,
  type Picture,
  type PictureOptions,
} from '@/components/sld/picture';
import { planTidy } from '@/components/sld/tidyPlan';
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

/** `diagram` after Tidy diagram, or after Tidy and re-layout: the plan, put in place. */
export function tidied(diagram: Diagram, relayout: boolean): Diagram {
  const plan = planTidy({ nodes: diagram.nodes, edges: diagram.edges }, diagram.topology, {
    relayout,
    barLengths: diagram.barLengths,
  });
  const at = new Map(plan.nodes.map((n) => [n.id, n.position]));
  const edges = plan.edges.map((edge) => {
    const points = plan.tidied.routes.get(edge.id);
    if (points === undefined) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        bendPoints: points,
        bendAnchors: { source: { ...at.get(edge.source)! }, target: { ...at.get(edge.target)! } },
      },
    };
  });
  return { ...diagram, nodes: plan.nodes, edges };
}

/**
 * `diagram` after the node `id` was dragged by `dx`, `dy` and dropped: a bus
 * takes its generators, loads and shunts along, and the routes are the ones
 * the canvas makes for the diagram at rest.
 */
export function dragged(diagram: Diagram, id: string, dx: number, dy: number): Diagram {
  const nodes = diagram.nodes.map((n) =>
    n.id === id || (n.data as { parentBus?: string }).parentBus === id
      ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
      : n,
  );
  return settled({ ...diagram, nodes });
}

/** Every place where two things of `diagram` are drawn on each other, as text. */
export function overlapsOf(
  diagram: Diagram,
  options: Omit<PictureOptions, 'barLengths'> = { values: false },
): string[] {
  const picture = drawn(diagram, options);
  return describeOverlaps(findOverlaps(drawnDiagram(diagram.nodes, picture, options)));
}
