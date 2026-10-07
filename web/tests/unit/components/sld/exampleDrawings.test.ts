/**
 * The example cases as the diagram draws them with no saved layout: ELK
 * places the buses (`layout.ts`), and the diagram is arranged around them
 * as Tidy and re-layout arranges it (`useAutoLayout`): the buses on the
 * grid, every device beside its bus, every branch routed clear of the rest.
 *
 * `noOverlap.test.ts` holds these drawings to the rule that nothing is
 * drawn over anything else. This file holds what a first look at an opened
 * case shows besides: every element is there, every connector of a device
 * drops square onto its bar, every branch runs at right angles from a tap
 * to a tap and keeps its distance from the bars and the devices it passes,
 * with the device connectors drawn straight or with a right angle.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import { DEVICE_COLUMN_GAP } from '@/components/sld/graph';
import { SLIDE_CLEARANCE, type ConnectorStyle } from '@/components/sld/connections';
import { GRID_STEP } from '@/components/sld/tidy';

import { drawn, opened } from '../../helpers/diagramStates';
import { IEEE14, KUNDUR, WSCC9 } from '../../helpers/exampleCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

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

/** The drawing of `topology` as its case opens, and every way it breaks the rules above. */
async function opens(topology: TopologySummary, connectorStyle: ConnectorStyle) {
  const diagram = await opened(topology);
  const { nodes, edges } = diagram;
  const { bars, routes } = drawn(diagram, { values: false, connectorStyle }).connections;
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
    if (edge.type === 'stub') {
      // Square onto the bar: one upright run from the device to its tap.
      const square = points.length === 2 && points[0]![0] === points[1]![0];
      if (!square) problems.push(`${edge.id} does not drop square onto its bar`);
      continue;
    }
    const ends = [boxOf(edge.source), boxOf(edge.target)];
    const onBar = (p: readonly number[], bar: Box): boolean =>
      p[1] === bar.top + 3 && p[0]! >= bar.left + 3 && p[0]! <= bar.right - 3;
    if (!onBar(points[0]!, ends[0]!) || !onBar(points[points.length - 1]!, ends[1]!)) {
      problems.push(`${edge.id} does not run from a tap to a tap`);
    }
    for (let i = 1; i < points.length; i += 1) {
      const [a, b] = [points[i - 1]!, points[i]!];
      if (a[0] !== b[0] && a[1] !== b[1]) problems.push(`${edge.id} runs at an angle`);
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
  return { nodes, edges, buses, devices, problems };
}

describe('the example cases, as they open with no saved layout', () => {
  for (const connectorStyle of ['straight', 'elbow'] as const) {
    it(`draws every branch of IEEE 14 from tap to tap, clear of the bars and the devices it passes (${connectorStyle})`, async () => {
      const { buses, edges, problems } = await opens(IEEE14, connectorStyle);
      expect(buses).toHaveLength(14);
      expect(edges.filter((e) => e.type !== 'stub')).toHaveLength(20);
      // One connector per load and shunt, and one per generating unit: a
      // generator and the machine that names it are one symbol.
      expect(edges.filter((e) => e.type === 'stub')).toHaveLength(18);
      expect(problems).toEqual([]);
    });

    it(`draws WSCC 9 and Kundur the same way (${connectorStyle})`, async () => {
      const wscc = await opens(WSCC9, connectorStyle);
      expect(wscc.edges.filter((e) => e.type !== 'stub')).toHaveLength(9);
      expect(wscc.problems).toEqual([]);
      const kundur = await opens(KUNDUR, connectorStyle);
      expect(kundur.edges.filter((e) => e.type !== 'stub')).toHaveLength(15);
      expect(kundur.problems).toEqual([]);
    });
  }

  it('stands every bus on the grid, and every device in the row over or under its bar', async () => {
    const { nodes, buses, devices } = await opens(IEEE14, 'straight');
    for (const bus of buses) {
      expect(bus.position.x % GRID_STEP, bus.id).toBe(0);
      expect(bus.position.y % GRID_STEP, bus.id).toBe(0);
    }
    for (const device of devices) {
      const parent = nodes.find((n) => n.id === (device.data as { parentBus: string }).parentBus)!;
      expect(Math.abs(device.position.y - parent.position.y), device.id).toBe(70);
    }
  });

  it('opens the same diagram every time', async () => {
    const [first, second] = [await opened(IEEE14), await opened(IEEE14)];
    expect(second.nodes.map((n) => n.position)).toEqual(first.nodes.map((n) => n.position));
    expect(second.edges.map((e) => e.data)).toEqual(first.edges.map((e) => e.data));
  });
});
