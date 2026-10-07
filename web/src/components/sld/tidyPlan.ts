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
} from './connections';
import { buildGraph, type BuildGraphOptions } from './graph';
import { busLabelReserve, chainBoxes, readoutReserve } from './labels';
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
}

export interface TidyPlan {
  /** The diagram as it will stand: `graph` itself for a tidy that moves nothing. */
  nodes: Node[];
  edges: Edge[];
  /** The routes of its branches. */
  tidied: TidyResult;
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
    edges = placed.edges;
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
  const tidied = tidyRoutes(nodes, edges as ConnectionEdge[], {
    ...connectionOptions,
    obstacles: [...chains.values()],
    keepFree: readoutReserve(nodes, connectors, sizes, { chains }),
    preferFree: busLabelReserve(nodes, connectors, sizes, { chains }),
    steps,
  });
  return { nodes, edges, tidied };
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
