/**
 * What Tidy diagram and Tidy and re-layout work out (`tidyPlan.ts`), held on
 * the three example cases as the automatic layout draws them: the diagram a
 * user has after opening a case, pressing the button and running a power
 * flow. The routes are checked in `tidy.test.ts`; this is about what is
 * drawn around them once the values show: that every generator and load has
 * a place for its P and Q that no line runs through, that the flow of a
 * line stands on no symbol, no readout and no other label, and that the
 * label of a bus stands on no symbol and no other label.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import { autoLayout } from '@/components/sld/layout';
import { buildGraph } from '@/components/sld/graph';
import {
  labelBoxAt,
  layoutConnections,
  type ConnectionEdge,
  type ConnectionLayout,
  type Point,
  type Rect,
} from '@/components/sld/connections';
import {
  LINE_LABEL_BOX,
  TRANSFORMER_LABEL_BOX,
  boxOnDiagram,
  busLabelBox,
  busLabelClear,
  overlaps,
  placeBranchLabels,
  placeReadouts,
} from '@/components/sld/labels';
import { GRID_STEP } from '@/components/sld/tidy';
import { branchesThroughSymbols, planTidy } from '@/components/sld/tidyPlan';
import { IEEE14, KUNDUR, WSCC9 } from '../../helpers/exampleCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const NO_SIZES = new Map<string, { width: number; height: number }>();

interface Drawing {
  nodes: Node[];
  edges: Edge[];
  connections: ConnectionLayout;
}

/** `topology` as the diagram draws it with no saved layout. */
async function opened(topology: TopologySummary): Promise<Drawing> {
  const { coords, bendPoints } = await autoLayout(topology);
  const { nodes, edges } = buildGraph(topology, coords, { bendPoints });
  return { nodes, edges, connections: layoutConnections(nodes, edges as ConnectionEdge[]) };
}

/** `drawing` after Tidy diagram, or after Tidy and re-layout: the plan, put in place. */
function tidied(drawing: Drawing, topology: TopologySummary, relayout: boolean) {
  const plan = planTidy({ nodes: drawing.nodes, edges: drawing.edges }, topology, { relayout });
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
  return {
    nodes: plan.nodes,
    edges,
    connections: layoutConnections(plan.nodes, edges as ConnectionEdge[]),
    tidied: plan.tidied,
  };
}

/** Whether a level or upright run of `points` passes through `box`, a pixel inside its edge. */
function crosses(points: readonly Point[], box: Rect): boolean {
  return points.slice(1).some((b, i) => {
    const a = points[i]!;
    return (
      Math.max(a[0], b[0]) > box.left + 1 &&
      Math.min(a[0], b[0]) < box.right - 1 &&
      Math.max(a[1], b[1]) > box.top + 1 &&
      Math.min(a[1], b[1]) < box.bottom - 1
    );
  });
}

/** Every way the labels of `drawing` are in each other's way or in a line's, with values shown. */
function labelProblems({ nodes, edges, connections }: Drawing): string[] {
  const clear = busLabelClear(nodes, connections, NO_SIZES, true);
  const busLabels = new Map<string, Rect>();
  for (const n of nodes) {
    if (n.type !== 'bus') continue;
    busLabels.set(n.id, busLabelBox(n, true, connections.bars.get(n.id), clear.get(n.id)));
  }
  const readouts = placeReadouts(nodes, connections, NO_SIZES, { busLabels });
  const places = placeBranchLabels(nodes, edges as ConnectionEdge[], connections, NO_SIZES, {
    busLabels,
    readouts: [...readouts.values()].map(({ box }) => box),
  });
  const flows = new Map<string, Rect>();
  for (const edge of edges) {
    const at = places.get(edge.id);
    if (edge.type === 'stub' || at === undefined) continue;
    const size = edge.type === 'transformer' ? TRANSFORMER_LABEL_BOX : LINE_LABEL_BOX;
    flows.set(edge.id, labelBoxAt(at, size.width, size.height));
  }
  const devices = nodes.filter((n) => n.type !== 'bus');
  const boxOf = (n: Node): Rect => boxOnDiagram(n, NO_SIZES, connections.bars);
  const found: string[] = [];
  for (const [id, { box }] of readouts) {
    for (const [edgeId, route] of connections.routes) {
      if (edgeId !== `stub-${id}` && crosses(route.points, box)) {
        found.push(`${edgeId} runs through the readout of ${id}`);
      }
    }
    for (const other of devices) {
      if (other.id !== id && overlaps(boxOf(other), box, 2)) {
        found.push(`the readout of ${id} is on ${other.id}`);
      }
    }
    for (const [otherId, other] of readouts) {
      if (otherId < id && overlaps(other.box, box, 2)) {
        found.push(`the readouts of ${id} and ${otherId} overlap`);
      }
    }
  }
  for (const [id, box] of flows) {
    for (const device of devices) {
      if (overlaps(boxOf(device), box)) found.push(`the label of ${id} is on ${device.id}`);
    }
    for (const [device, readout] of readouts) {
      if (overlaps(readout.box, box))
        found.push(`the label of ${id} is on the readout of ${device}`);
    }
    for (const [bus, label] of busLabels) {
      if (overlaps(label, box)) found.push(`the label of ${id} is on the label of bus ${bus}`);
    }
    for (const [other, label] of flows) {
      if (other < id && overlaps(label, box))
        found.push(`the labels of ${id} and ${other} overlap`);
    }
  }
  for (const [bus, label] of busLabels) {
    for (const device of devices) {
      if (overlaps(boxOf(device), label)) found.push(`the label of bus ${bus} is on ${device.id}`);
    }
    for (const [other, box] of busLabels) {
      if (other < bus && overlaps(box, label)) {
        found.push(`the labels of buses ${bus} and ${other} overlap`);
      }
    }
    for (const [edgeId, route] of connections.routes) {
      if (crosses(route.points, label))
        found.push(`${edgeId} runs through the label of bus ${bus}`);
    }
  }
  return found;
}

/** How often two branches of `drawing` cross. */
function crossings({ edges, connections }: Drawing): number {
  const routes = edges
    .filter((edge) => edge.type !== 'stub')
    .map((edge) => connections.routes.get(edge.id)!.points);
  const side = (u: Point, v: Point, w: Point): number =>
    (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  let count = 0;
  for (let i = 0; i < routes.length; i += 1) {
    for (let k = i + 1; k < routes.length; k += 1) {
      const [p, q] = [routes[i]!, routes[k]!];
      for (let m = 1; m < p.length; m += 1) {
        for (let n = 1; n < q.length; n += 1) {
          const [a, b, c, d] = [p[m - 1]!, p[m]!, q[n - 1]!, q[n]!];
          if (side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0) count += 1;
        }
      }
    }
  }
  return count;
}

const CASES = [
  ['IEEE 14', IEEE14],
  ['WSCC 9', WSCC9],
  ['Kundur', KUNDUR],
] as const;

describe('Tidy diagram on the example cases', () => {
  for (const [name, topology] of CASES) {
    it(`leaves the values of ${name} clear of the lines, and its labels clear of each other`, async () => {
      const before = await opened(topology);
      const after = tidied(before, topology, false);
      expect(after.tidied.unrouted).toEqual([]);
      // Nothing was moved.
      expect(after.nodes).toBe(before.nodes);
      expect(labelProblems(after)).toEqual([]);
      expect(branchesThroughSymbols(after.nodes, after.edges, after.connections)).toEqual([]);
      expect(crossings(after)).toBeLessThanOrEqual(crossings(before));
    });
  }

  it('finds every load of IEEE 14 a place for its values that the automatic layout does not', async () => {
    // As the case opens, lines run through the readouts of several loads:
    // a line lands on the bar between a load and the generator beside it,
    // and others pass on the far side of the load.
    const before = await opened(IEEE14);
    const struck = labelProblems(before).filter((problem) =>
      problem.includes('runs through the readout'),
    );
    expect(struck.length).toBeGreaterThan(0);
    expect(labelProblems(tidied(before, IEEE14, false))).toEqual([]);
  });
});

describe('Tidy and re-layout on the example cases', () => {
  for (const [name, topology] of CASES) {
    it(`puts every device of ${name} square to its bar, with its values and the labels clear`, async () => {
      const before = await opened(topology);
      const after = tidied(before, topology, true);
      expect(after.tidied.unrouted).toEqual([]);
      for (const node of after.nodes) {
        if (node.type !== 'bus') continue;
        expect(node.position.x % GRID_STEP, node.id).toBe(0);
        expect(node.position.y % GRID_STEP, node.id).toBe(0);
      }
      // Every device stands over or under its bar: its connector drops square.
      for (const edge of after.edges) {
        if (edge.type !== 'stub') continue;
        const points = after.connections.routes.get(edge.id)!.points;
        expect(points, edge.id).toHaveLength(2);
        expect(points[0]![0], edge.id).toBe(points[1]![0]);
      }
      expect(labelProblems(after)).toEqual([]);
      expect(branchesThroughSymbols(after.nodes, after.edges, after.connections)).toEqual([]);
      expect(crossings(after)).toBe(0);
    });
  }

  it('is the same plan when it is asked for again', async () => {
    const before = await opened(IEEE14);
    const first = tidied(before, IEEE14, true);
    const again = planTidy({ nodes: first.nodes, edges: first.edges }, IEEE14, { relayout: true });
    expect(again.nodes.map((n) => n.position)).toEqual(first.nodes.map((n) => n.position));
    expect([...again.tidied.routes]).toEqual([...first.tidied.routes]);
  });
});

describe('branchesThroughSymbols', () => {
  const bus = (id: string, x: number, y: number) => ({ id, type: 'bus', position: { x, y } });
  const line = (id: string, source: string, target: string): ConnectionEdge => ({
    id,
    type: 'topology',
    source,
    target,
  });

  it('finds a line that is drawn through a device, and one through the bar of another bus', () => {
    // Bus 3 stands between buses 1 and 2, and a load under bus 1 as well.
    const nodes = [
      bus('1', 0, 0),
      bus('2', 0, 320),
      bus('3', 0, 160),
      {
        id: 'load-PQ',
        type: 'load',
        position: { x: 26, y: 70 },
        initialWidth: 40,
        initialHeight: 41,
      },
    ];
    const edges = [line('through', '1', '2'), line('clear', '1', '3')];
    const connections: ConnectionLayout = {
      bars: new Map(nodes.slice(0, 3).map((n) => [n.id, { start: 0, end: 92, taps: [] }])),
      routes: new Map([
        [
          'through',
          {
            points: [
              [46, 3],
              [46, 323],
            ],
            sourceSide: 'south',
            targetSide: 'north',
          },
        ],
        [
          'clear',
          {
            points: [
              [80, 3],
              [80, 163],
            ],
            sourceSide: 'south',
            targetSide: 'north',
          },
        ],
      ]),
    };
    expect(branchesThroughSymbols(nodes, edges, connections)).toEqual(['through']);
    // With the load out of the way the bar of bus 3 is still in it.
    expect(branchesThroughSymbols(nodes.slice(0, 3), edges, connections)).toEqual(['through']);
    expect(branchesThroughSymbols(nodes.slice(0, 2), edges, connections)).toEqual([]);
  });

  it('counts no device connector, and no line for the bars it lands on', () => {
    const nodes = [
      bus('1', 0, 0),
      bus('2', 0, 160),
      {
        id: 'load-PQ',
        type: 'load',
        position: { x: 0, y: 70 },
        initialWidth: 40,
        initialHeight: 41,
      },
      {
        id: 'load-N',
        type: 'load',
        position: { x: 0, y: 30 },
        initialWidth: 40,
        initialHeight: 30,
      },
    ];
    const edges: ConnectionEdge[] = [
      line('l', '1', '2'),
      { id: 'stub-load-PQ', type: 'stub', source: 'load-PQ', target: '1' },
    ];
    const connections: ConnectionLayout = {
      bars: new Map(nodes.slice(0, 2).map((n) => [n.id, { start: 0, end: 92, taps: [] }])),
      routes: new Map([
        [
          'l',
          {
            points: [
              [80, 3],
              [80, 163],
            ],
            sourceSide: 'south',
            targetSide: 'north',
          },
        ],
        // Up through the other load on its way to the bar.
        [
          'stub-load-PQ',
          {
            points: [
              [20, 70],
              [20, 3],
            ],
            sourceSide: 'north',
            targetSide: 'south',
          },
        ],
      ]),
    };
    expect(branchesThroughSymbols(nodes, edges, connections)).toEqual([]);
  });
});
