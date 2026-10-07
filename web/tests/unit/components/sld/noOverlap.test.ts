/**
 * Nothing on the diagram is drawn over anything else: the rule, held on the
 * whole drawing of the three example cases and of the IEEE 118-bus case, in
 * every state the app puts a diagram in.
 *
 * - as the case opens with no saved layout (the automatic arrangement);
 * - after Tidy diagram, and after Tidy and re-layout;
 * - with the values of a power flow shown, where the labels of the buses are
 *   larger and the readouts of the devices and the flow labels are drawn;
 * - after a bus was dragged, and after a device was dragged beside its bus
 *   and across it, where the canvas routes the lines that are in the way
 *   afresh;
 * - with the control chains of the generating units drawn out;
 * - on a layout that places the buses alone (the one shipped for IEEE 14),
 *   where every route is made as the diagram is drawn.
 *
 * Each state is made as the canvas makes it (`diagramStates.ts`), drawn by
 * `pictureOf`, and read by `findOverlaps`, whose rules `overlapCheck.test.ts`
 * holds one by one: no two lines share a stretch or an end on a bar, none
 * runs through a bar, a symbol, a label or a readout, and no two boxes reach
 * into each other.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import { curatedLayoutFor } from '@/components/sld/curated';
import { buildGraph, defaultBarLengths } from '@/components/sld/graph';
import { countCrossings } from '@/components/sld/overlapCheck';
import { drawnDiagram } from '@/components/sld/picture';
import { CASE118 } from '../../helpers/case118';
import {
  dragged,
  drawn,
  opened,
  overlapsOf,
  settled,
  tidied,
  type Diagram,
} from '../../helpers/diagramStates';
import { IEEE14, KUNDUR, WSCC9 } from '../../helpers/exampleCases';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

const EXAMPLES: readonly [string, TopologySummary][] = [
  ['IEEE 14', IEEE14],
  ['Kundur', KUNDUR],
  ['WSCC 9', WSCC9],
];

/**
 * The widths the values of a solved case have on screen: a readout of two
 * lines such as `-21.6 MVAr`, a flow such as `-25.97 MW` after its arrow.
 */
function typicalWidths(diagram: Diagram) {
  return {
    readouts: new Map(diagram.nodes.map((n) => [n.id, 62])),
    flows: new Map(diagram.edges.map((e) => [e.id, 78])),
  };
}

/** Both ways a state is looked at: as it is, and with the values of a power flow on it. */
function bothWays(diagram: Diagram): string[] {
  return [
    ...overlapsOf(diagram, { values: false }).map((found) => `plain: ${found}`),
    ...overlapsOf(diagram, { values: true }).map((found) => `values: ${found}`),
    ...overlapsOf(diagram, { values: true, labelWidths: typicalWidths(diagram) }).map(
      (found) => `values as wide as they are: ${found}`,
    ),
  ];
}

describe('nothing overlaps on the example cases', () => {
  for (const [name, topology] of EXAMPLES) {
    it(`${name}: as it opens, tidied, and laid out again, with and without values`, async () => {
      const first = await opened(topology);
      expect(bothWays(first)).toEqual([]);
      expect(bothWays(tidied(first, false))).toEqual([]);
      expect(bothWays(tidied(first, true))).toEqual([]);
    });

    it(`${name}: every line has a route, and every value a place, as it opens`, async () => {
      const first = await opened(topology);
      const picture = drawn(first, { values: true, labelWidths: typicalWidths(first) });
      expect(picture.unrouted).toEqual([]);
      // The arrangement is what is drawn: nothing was routed again for it.
      expect([...picture.changed.keys()]).toEqual([]);
      // A flow label with no place clear of everything else is left off; on
      // these cases that is one line at the most, between a load and the
      // labels of two buses.
      const hidden = [...picture.labelPlaces].filter(([, place]) => place.hidden).map(([id]) => id);
      expect(hidden.length).toBeLessThanOrEqual(1);
      const dropped = [...picture.readouts].filter(([, { spot }]) => spot === 'none');
      expect(dropped.map(([id]) => id)).toEqual([]);
    });

    it(`${name}: a tidy of the diagram as it opens changes nothing`, async () => {
      const first = await opened(topology);
      const routes = (diagram: Diagram) =>
        diagram.edges.map((e) => [e.id, (e.data as { bendPoints?: unknown }).bendPoints]);
      expect(routes(tidied(first, true))).toEqual(routes(first));
      expect(tidied(first, true).nodes.map((n) => n.position)).toEqual(
        first.nodes.map((n) => n.position),
      );
    });

    it(`${name}: after a bus is dragged, and after a tidy of that`, async () => {
      const first = await opened(topology);
      const bus = first.nodes.find((n) => n.type === 'bus' && n.id === '5')!;
      // Along its row and a little off it: a move that does not drop the bus
      // or one of its devices on something else.
      for (const [dx, dy] of [
        [48, 0],
        [-64, 16],
        [16, -16],
      ] as const) {
        const moved = dragged(first, bus.id, dx, dy);
        expect(bothWays(moved), `bus 5 by ${dx}, ${dy}`).toEqual([]);
        expect(drawn(moved).unrouted).toEqual([]);
        expect(bothWays(tidied(moved, false)), `tidied after ${dx}, ${dy}`).toEqual([]);
      }
    });

    it(`${name}: after a device is dragged beside its bus, and across it`, async () => {
      const first = await opened(topology);
      const load = first.nodes.find((n) => n.type === 'load')!;
      const parent = first.nodes.find(
        (n) => n.id === (load.data as { parentBus: string }).parentBus,
      )!;
      const width = load.initialWidth ?? 0;
      const height = load.initialHeight ?? 0;
      const bar = drawn(first).connections.bars.get(parent.id)!;
      // Level with the bar, past its east tip and past its west tip, and on
      // the other face of the bar.
      const places = {
        east: { x: parent.position.x + bar.end + 48, y: parent.position.y + 3 - height / 2 },
        west: {
          x: parent.position.x + bar.start - 48 - width,
          y: parent.position.y + 3 - height / 2,
        },
        across: {
          x: load.position.x,
          y: 2 * parent.position.y + 6 - load.position.y - height,
        },
      };
      // What stands between a place and the bar: a drop there is not a way
      // to arrange a diagram, and is not held to the rule.
      const inTheWay = (to: { x: number; y: number }): boolean =>
        first.nodes.some((n) => {
          if (n.id === load.id || n.id === parent.id) return false;
          const reach = {
            left: Math.min(to.x, parent.position.x),
            right: Math.max(to.x, parent.position.x) + width,
          };
          const [w, h] = [
            n.type === 'bus' ? 140 : (n.initialWidth ?? 0),
            n.type === 'bus' ? 48 : (n.initialHeight ?? 0),
          ];
          return (
            n.position.x < reach.right + 16 &&
            n.position.x + w > reach.left - 16 &&
            n.position.y < to.y + height + 16 &&
            n.position.y + h > to.y - 16
          );
        });
      let tried = 0;
      for (const [where, to] of Object.entries(places)) {
        if (where !== 'across' && inTheWay(to)) continue;
        tried += 1;
        const moved = dragged(first, load.id, to.x - load.position.x, to.y - load.position.y);
        // The lines keep off the device where it was dropped, and off its
        // connector; what was dropped on a label or a symbol stays there.
        const found = bothWays(moved).filter((text) => !text.includes('box-box'));
        expect(found, `${load.id} ${where}`).toEqual([]);
        expect(drawn(moved).unrouted, `${load.id} ${where}`).toEqual([]);
      }
      expect(tried).toBeGreaterThanOrEqual(2);
    });
  }

  for (const [name, topology] of [EXAMPLES[0]!, EXAMPLES[1]!]) {
    it(`${name}: with the control chains of its units drawn out`, async () => {
      const units = new Map(
        topology.generators
          .filter((g) => g.kind === 'PV' || g.kind === 'Slack')
          .map((g) => [String(g.idx), { expanded: true }]),
      );
      const first = await opened(topology, { unitStates: units });
      const picture = drawn(first);
      expect(picture.chains.size).toBe(units.size);
      expect(bothWays(first)).toEqual([]);
    });
  }

  it('keeps the crossings of the example cases as few as they open with', async () => {
    const crossings = async (topology: TopologySummary): Promise<number> => {
      const first = await opened(topology);
      return countCrossings(drawnDiagram(first.nodes, drawn(first), { values: false }).lines);
    };
    expect(await crossings(KUNDUR)).toBe(0);
    expect(await crossings(WSCC9)).toBe(0);
    expect(await crossings(IEEE14)).toBeLessThanOrEqual(2);
  });
});

describe('nothing overlaps on a layout that places the buses and nothing else', () => {
  it('IEEE 14 in the layout shipped with the app: as it is first drawn, and once its routes are kept', () => {
    // The curated layout holds a coordinate for each bus: the devices stand
    // where the diagram puts one that has no place, and every route is made
    // as the diagram is drawn. Several of its buses stand level, a bar's
    // length apart.
    const layout = curatedLayoutFor('ieee14.raw')!;
    const barLengths = defaultBarLengths(IEEE14);
    const { nodes, edges } = buildGraph(IEEE14, layout.coordinates, { barLengths });
    const first: Diagram = { topology: IEEE14, nodes, edges, barLengths };
    expect(drawn(first).unrouted).toEqual([]);
    expect(bothWays(first)).toEqual([]);
    // Kept, the routes hold: the next picture makes none again.
    const kept = settled(first);
    expect(drawn(kept).changed.size).toBe(0);
    expect(bothWays(kept)).toEqual([]);
    expect(bothWays(tidied(kept, false))).toEqual([]);
  });
});

describe('nothing overlaps on a case of a hundred buses', () => {
  it('IEEE 118: as it opens, tidied, and laid out again, with and without values', async () => {
    const first = await opened(CASE118);
    expect(first.nodes.filter((n) => n.type === 'bus')).toHaveLength(118);
    expect(first.edges.filter((e) => e.type !== 'stub')).toHaveLength(186);
    expect(drawn(first).unrouted).toEqual([]);
    expect(bothWays(first)).toEqual([]);
    expect(bothWays(tidied(first, false))).toEqual([]);
    expect(bothWays(tidied(first, true))).toEqual([]);
  }, 120_000);

  it('IEEE 118: after a bus with many lines is dragged', async () => {
    const first = await opened(CASE118);
    const moved = dragged(first, '49', 40, 24);
    const found = bothWays(moved);
    expect(found).toEqual([]);
  }, 120_000);
});
