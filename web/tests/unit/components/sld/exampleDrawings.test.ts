/**
 * IEEE 14 and WSCC 9 as the diagram draws them with no saved layout: the
 * automatic layout places the buses and routes the branches (`layout.ts`),
 * `buildGraph` places the devices, and `layoutConnections` lands every
 * connector on the bars.
 *
 * The automatic layout runs every branch of one side of a bus through one
 * point and several of them down one corridor, a few pixels beside the bars
 * it passes. The connection pass parts them on the bar, and each run moves
 * along with its tap. These two cases are where that went wrong: on IEEE 14
 * a line from bus 2 to bus 5 was moved into the tips of the bars of buses 3
 * and 4 and behind a generator of bus 3, and on WSCC 9 a line was moved
 * onto the edge of a load. So the rules are held on the whole drawing: a
 * branch keeps clear of every bar but its own two and of every generator,
 * load and shunt, and a device connector runs through no other device.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologyEntry, TopologySummary } from '@/api/types';
import { autoLayout } from '@/components/sld/layout';
import { DEVICE_COLUMN_GAP, buildGraph } from '@/components/sld/graph';
import {
  SLIDE_CLEARANCE,
  layoutConnections,
  type ConnectorStyle,
} from '@/components/sld/connections';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

type Idx = number | string;

const entry = (
  idx: Idx,
  kind: string,
  params: TopologyEntry['params'],
  name = String(idx),
): TopologyEntry => ({ idx, name, kind, params });

const branches = (pairs: readonly [Idx, Idx][], firstNumber: number): TopologyEntry[] =>
  pairs.map(([bus1, bus2], i) => entry(`Line_${firstNumber + i}`, 'Line', { bus1, bus2 }));

const loads = (buses: readonly Idx[], firstNumber: number): TopologyEntry[] =>
  buses.map((bus, i) => entry(`PQ_${firstNumber + i}`, 'PQ', { bus }));

/** `ieee14_full.xlsx` of ANDES: what the diagram reads of it. */
const IEEE14: TopologySummary = {
  state: 'pre-setup',
  buses: Array.from({ length: 14 }, (_, i) => entry(i + 1, 'Bus', {}, `BUS${i + 1}`)),
  lines: branches(
    [
      [1, 2],
      [1, 5],
      [2, 3],
      [2, 4],
      [2, 5],
      [3, 4],
      [4, 5],
      [6, 11],
      [6, 12],
      [6, 13],
      [7, 9],
      [9, 10],
      [9, 14],
      [10, 11],
      [12, 13],
      [13, 14],
    ],
    1,
  ),
  transformers: branches(
    [
      [4, 7],
      [4, 9],
      [6, 5],
      [8, 7],
    ],
    17,
  ),
  generators: [
    entry(2, 'PV', { bus: 2 }),
    entry(3, 'PV', { bus: 3 }),
    entry(4, 'PV', { bus: 6 }),
    entry(5, 'PV', { bus: 8 }),
    entry(1, 'Slack', { bus: 1 }),
    ...[1, 2, 3, 6, 8].map((bus, i) => entry(`GENROU_${i + 1}`, 'GENROU', { bus, gen: i + 1 })),
  ],
  loads: loads([2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14], 1),
  shunts: [entry('Shunt_1', 'Shunt', { bus: 9 }), entry('Shunt_2', 'Shunt', { bus: 14 })],
  controllers: [
    ...[1, 2, 3, 4, 5].map((n) => entry(`TGOV1_${n}`, 'TGOV1', { syn: `GENROU_${n}` })),
    entry('EXST1_1', 'EXST1', { syn: 'GENROU_2' }),
  ],
};

/** `wscc9.xlsx` of ANDES. */
const WSCC9: TopologySummary = {
  state: 'pre-setup',
  buses: Array.from({ length: 9 }, (_, i) => entry(i + 1, 'Bus', {}, `Bus ${i + 1}`)),
  lines: branches(
    [
      [5, 4],
      [6, 4],
      [7, 5],
      [9, 6],
      [7, 8],
      [8, 9],
      [4, 1],
      [2, 7],
      [9, 3],
    ],
    0,
  ),
  transformers: [],
  generators: [
    entry(2, 'PV', { bus: 2 }),
    entry(3, 'PV', { bus: 3 }),
    entry(1, 'Slack', { bus: 1 }),
  ],
  loads: loads([5, 6, 8], 0),
  shunts: [],
  controllers: [],
};

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** How far the level or upright run from `a` to `b` is from `box`; 0 when it touches or enters it. */
function distance(a: readonly number[], b: readonly number[], box: Box): number {
  const dx = Math.max(box.left - Math.max(a[0]!, b[0]!), Math.min(a[0]!, b[0]!) - box.right, 0);
  const dy = Math.max(box.top - Math.max(a[1]!, b[1]!), Math.min(a[1]!, b[1]!) - box.bottom, 0);
  return Math.hypot(dx, dy);
}

/** Whether the run from `a` to `b` passes through the inside of `box`. */
function passesThrough(a: readonly number[], b: readonly number[], box: Box): boolean {
  const steps = Math.ceil(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    const x = a[0]! + t * (b[0]! - a[0]!);
    const y = a[1]! + t * (b[1]! - a[1]!);
    if (x > box.left + 1 && x < box.right - 1 && y > box.top + 1 && y < box.bottom - 1) return true;
  }
  return false;
}

/** The drawing of `topology` with no saved layout, and every way it breaks the rules above. */
async function drawn(topology: TopologySummary, connectorStyle: ConnectorStyle) {
  const { coords, bendPoints } = await autoLayout(topology);
  const { nodes, edges } = buildGraph(topology, coords, { bendPoints });
  const { bars, routes } = layoutConnections(nodes, edges, { connectorStyle });
  const boxOf = (id: string): Box => {
    const node = nodes.find((n) => n.id === id)!;
    const bar = bars.get(id);
    if (bar !== undefined) {
      return {
        left: node.position.x + bar.start,
        right: node.position.x + bar.end,
        top: node.position.y,
        bottom: node.position.y + 6,
      };
    }
    return {
      left: node.position.x,
      right: node.position.x + node.initialWidth!,
      top: node.position.y,
      bottom: node.position.y + node.initialHeight!,
    };
  };
  const buses = nodes.filter((n) => n.type === 'bus');
  const devices = nodes.filter((n) => ['generator', 'load', 'shunt'].includes(n.type ?? ''));
  const problems: string[] = [];
  for (const edge of edges) {
    const points = routes.get(edge.id)!.points;
    for (let i = 1; i < points.length; i += 1) {
      const [a, b] = [points[i - 1]!, points[i]!];
      if (edge.type === 'stub') {
        for (const device of devices) {
          if (device.id === edge.source || !passesThrough(a, b, boxOf(device.id))) continue;
          problems.push(`${edge.id} runs through ${device.id}`);
        }
        continue;
      }
      for (const bus of buses) {
        if (bus.id === edge.source || bus.id === edge.target) continue;
        const apart = distance(a, b, boxOf(bus.id));
        if (apart < SLIDE_CLEARANCE)
          problems.push(`${edge.id} is ${apart} from the bar of ${bus.id}`);
      }
      for (const device of devices) {
        const apart = distance(a, b, boxOf(device.id));
        if (apart < DEVICE_COLUMN_GAP) problems.push(`${edge.id} is ${apart} from ${device.id}`);
      }
    }
  }
  return { nodes, edges, routes, problems };
}

describe('the example cases, drawn by the automatic layout', () => {
  for (const connectorStyle of ['straight', 'elbow'] as const) {
    it(`keeps every branch of IEEE 14 clear of the bars and the devices it passes (${connectorStyle})`, async () => {
      const { nodes, edges, problems } = await drawn(IEEE14, connectorStyle);
      expect(nodes.filter((n) => n.type === 'bus')).toHaveLength(14);
      expect(edges.filter((e) => e.type !== 'stub')).toHaveLength(20);
      // One connector per load and shunt, and one per generating unit: a
      // generator and the machine that names it are one symbol.
      expect(edges.filter((e) => e.type === 'stub')).toHaveLength(18);
      expect(problems).toEqual([]);
    });

    it(`keeps every branch of WSCC 9 clear of the bars and the devices it passes (${connectorStyle})`, async () => {
      const { edges, problems } = await drawn(WSCC9, connectorStyle);
      expect(edges.filter((e) => e.type !== 'stub')).toHaveLength(9);
      expect(problems).toEqual([]);
    });
  }

  it('draws the line of IEEE 14 from bus 2 to bus 5 down the corridor left of the bars of buses 3 and 4', async () => {
    // Four branches land on the north port of bus 5. Parted about the one
    // in the middle, this line's long run stood inside the tips of the bars
    // of buses 3 and 4; they are parted so that it keeps the corridor the
    // layout routed it down.
    const { nodes, routes } = await drawn(IEEE14, 'straight');
    const x = (id: string): number => nodes.find((n) => n.id === id)!.position.x;
    const points = routes.get('line-Line_5')!.points;
    const longRun = points[points.length - 1]![0];
    expect(points[points.length - 2]![0]).toBe(longRun);
    for (const bus of ['3', '4']) {
      expect(x(bus) - longRun).toBeGreaterThanOrEqual(SLIDE_CLEARANCE);
    }
    // The four are still a spacing apart on the bar of bus 5, in the order
    // that keeps them from crossing: from the left, down the corridor
    // twice, and from the right.
    const landing = (id: string): number => {
      const route = routes.get(id)!.points;
      return route[route.length - 1]![0] - x('5');
    };
    expect(
      ['transformer-Line_19', 'line-Line_2', 'line-Line_5', 'line-Line_7'].map(landing),
    ).toEqual([18, 32, 46, 60]);
  });
});
