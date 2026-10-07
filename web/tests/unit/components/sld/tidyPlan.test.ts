/**
 * What Tidy diagram and Tidy and re-layout work out (`tidyPlan.ts`), held on
 * the three example cases drawn the way a layout saved by an earlier version
 * has them: the buses where ELK puts them, the devices where the diagram
 * places one that has no place, and the branches along the routes ELK makes,
 * which share corridors and take no notice of the devices. That is the
 * diagram a tidy is for. (A case that opens with no saved layout is tidy
 * already: `noOverlap.test.ts`.)
 *
 * The routes are checked in `tidy.test.ts`; this is about the whole diagram
 * once the plan is in place and a power flow has run: nothing on it is drawn
 * over anything else (`findOverlaps`), and after a re-layout every bus is on
 * the grid and every device square to its bar.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import type { ConnectionEdge, ConnectionLayout } from '@/components/sld/connections';
import { autoLayout } from '@/components/sld/layout';
import { buildGraph, defaultBarLengths } from '@/components/sld/graph';
import { countCrossings } from '@/components/sld/overlapCheck';
import { drawnDiagram } from '@/components/sld/picture';
import { GRID_STEP } from '@/components/sld/tidy';
import { branchesThroughSymbols, planTidy } from '@/components/sld/tidyPlan';
import {
  dragged,
  drawn,
  opened,
  overlapsOf,
  tidied,
  type Diagram,
} from '../../helpers/diagramStates';
import { IEEE14, KUNDUR, WSCC9 } from '../../helpers/exampleCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

/** `topology` drawn along the routes ELK makes, as a layout saved by an earlier version has it. */
async function alongElkRoutes(topology: TopologySummary): Promise<Diagram> {
  const { coords, bendPoints } = await autoLayout(topology);
  const barLengths = defaultBarLengths(topology);
  const { nodes, edges } = buildGraph(topology, coords, { bendPoints, barLengths });
  return { topology, nodes, edges, barLengths };
}

/** How often two lines of `diagram` cross. */
function crossings(diagram: Diagram): number {
  return countCrossings(drawnDiagram(diagram.nodes, drawn(diagram), { values: false }).lines);
}

const CASES = [
  ['IEEE 14', IEEE14],
  ['WSCC 9', WSCC9],
  ['Kundur', KUNDUR],
] as const;

describe('Tidy diagram on the example cases', () => {
  for (const [name, topology] of CASES) {
    it(`moves nothing of ${name}, and leaves nothing on it drawn over anything else`, async () => {
      const before = await alongElkRoutes(topology);
      const after = tidied(before, false);
      expect(drawn(after).unrouted).toEqual([]);
      // Nothing was moved.
      expect(after.nodes).toBe(before.nodes);
      expect(overlapsOf(after, { values: false })).toEqual([]);
      expect(overlapsOf(after, { values: true })).toEqual([]);
      const picture = drawn(after);
      expect(branchesThroughSymbols(after.nodes, picture.edges, picture.connections)).toEqual([]);
    });
  }

  it('routes every branch of IEEE 14, which ELK runs through symbols and down shared corridors', async () => {
    // Drawn along ELK's routes as they are stored, lines run through the
    // devices that were placed after them; the plan routes each of the
    // twenty afresh.
    const before = await alongElkRoutes(IEEE14);
    const plan = planTidy({ nodes: before.nodes, edges: before.edges }, IEEE14, {
      relayout: false,
      barLengths: before.barLengths,
    });
    expect(plan.tidied.unrouted).toEqual([]);
    expect(plan.tidied.routes.size).toBe(20);
    expect(plan.nodes).toBe(before.nodes);
  });
});

describe('Tidy and re-layout on the example cases', () => {
  for (const [name, topology] of CASES) {
    it(`puts every device of ${name} square to its bar, with nothing drawn over anything else`, async () => {
      const before = await alongElkRoutes(topology);
      const after = tidied(before, true);
      const picture = drawn(after);
      expect(picture.unrouted).toEqual([]);
      for (const node of after.nodes) {
        if (node.type !== 'bus') continue;
        expect(node.position.x % GRID_STEP, node.id).toBe(0);
        expect(node.position.y % GRID_STEP, node.id).toBe(0);
      }
      // Every device stands over or under its bar: its connector drops square.
      for (const edge of after.edges) {
        if (edge.type !== 'stub') continue;
        const points = picture.connections.routes.get(edge.id)!.points;
        expect(points, edge.id).toHaveLength(2);
        expect(points[0]![0], edge.id).toBe(points[1]![0]);
      }
      expect(overlapsOf(after, { values: false })).toEqual([]);
      expect(overlapsOf(after, { values: true })).toEqual([]);
      expect(branchesThroughSymbols(after.nodes, picture.edges, picture.connections)).toEqual([]);
      expect(crossings(after)).toBeLessThanOrEqual(name === 'IEEE 14' ? 2 : 0);
    });
  }

  it('still stands every device of IEEE 14 square to its bar after a bus was moved', async () => {
    // With bus 13 moved down and to the left, the lines of bus 9 come to
    // take the whole of its bar on the first pass, and its shunt has no
    // column left that is a gap clear of them. It stands as far past the
    // tip as the bar still reaches under it, and the lines are routed round
    // it; clear of them all it stood further out, with its connector run to
    // the tip of the bar at an angle.
    const moved = dragged(await opened(IEEE14), '13', -155.465, 42.399);
    const after = tidied(moved, true);
    const picture = drawn(after);
    expect(picture.unrouted).toEqual([]);
    for (const edge of after.edges) {
      if (edge.type !== 'stub') continue;
      const points = picture.connections.routes.get(edge.id)!.points;
      expect(points, edge.id).toHaveLength(2);
      expect(points[0]![0], edge.id).toBe(points[1]![0]);
    }
    expect(overlapsOf(after, { values: false })).toEqual([]);
    expect(overlapsOf(after, { values: true })).toEqual([]);
  });

  it('is the same plan when it is asked for again', async () => {
    const before = await alongElkRoutes(IEEE14);
    const first = tidied(before, true);
    const again = planTidy({ nodes: first.nodes, edges: first.edges }, IEEE14, {
      relayout: true,
      barLengths: first.barLengths,
    });
    expect(again.nodes.map((n) => n.position)).toEqual(first.nodes.map((n) => n.position));
    expect([...again.tidied.routes]).toEqual(
      first.edges
        .filter((e) => e.type !== 'stub')
        .map((e) => [e.id, (e.data as { bendPoints: unknown }).bendPoints]),
    );
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
