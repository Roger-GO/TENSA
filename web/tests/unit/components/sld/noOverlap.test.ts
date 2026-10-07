/**
 * Nothing on the diagram is drawn over anything else: the rule, held on the
 * whole drawing of the three example cases and of the IEEE 118-bus case, in
 * every state the app puts a diagram in.
 *
 * - as the case opens with no saved layout (the automatic arrangement);
 * - after Tidy diagram, and after Tidy and re-layout;
 * - with the values of a power flow shown, where the labels of the buses are
 *   larger and the readouts of the devices and the flow labels are drawn;
 * - after any bus was dragged, by any of a spread of moves, and dropped,
 *   and after a tidy of that, and while it is dragged (wherever the move
 *   does not put it on something);
 * - after any device was dragged and dropped: beside its bus, across it,
 *   behind another device of its bus, and on another symbol or on a bar,
 *   which the canvas puts in the nearest free place (`clearDrop`);
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
import type { ConnectionEdge } from '@/components/sld/connections';
import { curatedLayoutFor } from '@/components/sld/curated';
import { buildGraph, defaultBarLengths } from '@/components/sld/graph';
import { countCrossings, describeOverlaps, findOverlaps } from '@/components/sld/overlapCheck';
import { drawnDiagram, pictureOf } from '@/components/sld/picture';
import { CASE118 } from '../../helpers/case118';
import {
  dragged,
  draggedWith,
  dropShift,
  drawn,
  moved,
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

/**
 * Every place where two things are on each other while the nodes `ids` of
 * `diagram` are dragged to where they stand: the picture of a move, made
 * from the routes the diagram had before it.
 */
function whileDragged(diagram: Diagram, before: Diagram, values: boolean): string[] {
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
 * The moves every bus of an example case is dragged by: along its row and
 * off it, a little way and a long way, among them the ones that once left a
 * line through the symbol of a transformer, the label of a bus on one, and
 * a symbol on a bar.
 */
const BUS_MOVES: readonly (readonly [number, number])[] = [
  [48, 0],
  [-64, 16],
  [16, -16],
  [-120, -120],
  [-120, 40],
  [0, -96],
  [0, -80],
  [16, -96],
  [120, 80],
  [120, 120],
  [160, -40],
  [-80, 80],
];

/** The moves every generator, load and shunt is dragged by. */
const DEVICE_MOVES: readonly (readonly [number, number])[] = [
  [-80, 0],
  [80, 0],
  [0, -60],
  [0, 60],
  [40, 40],
  [-120, 80],
  [100, -100],
  [-40, 140],
];

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

    it(`${name}: after any bus is dragged and dropped, after a tidy of that, and while it is dragged`, async () => {
      const first = await opened(topology);
      const found: string[] = [];
      let clear = 0;
      for (const bus of first.nodes.filter((n) => n.type === 'bus')) {
        for (const [dx, dy] of BUS_MOVES) {
          const what = `bus ${bus.id} by ${dx}, ${dy}`;
          const ids = draggedWith(first, bus.id);
          const there = moved(first, ids, dx, dy);
          // While it is dragged: wherever the move does not put the bus or
          // one of its devices on something, which a drag passes through
          // and a drop does not stay on.
          if (dropShift(there, ids, first) === null) {
            clear += 1;
            found.push(
              ...whileDragged(there, first, true).map((text) => `${what}, dragged: ${text}`),
            );
          }
          const dropped = dragged(first, bus.id, dx, dy);
          found.push(...drawn(dropped).unrouted.map((id) => `${what}: no route for ${id}`));
          found.push(...bothWays(dropped).map((text) => `${what}: ${text}`));
          found.push(...bothWays(tidied(dropped, false)).map((text) => `${what}, tidied: ${text}`));
        }
      }
      expect(found).toEqual([]);
      // Most of the moves are clear ones: the drag itself is held to the rule.
      expect(clear).toBeGreaterThan(BUS_MOVES.length);
    }, 240_000);

    it(`${name}: after any device is dragged and dropped, and while it is dragged`, async () => {
      const first = await opened(topology);
      const found: string[] = [];
      const devices = first.nodes.filter(
        (n) => n.type === 'generator' || n.type === 'load' || n.type === 'shunt',
      );
      for (const device of devices) {
        for (const [dx, dy] of DEVICE_MOVES) {
          const what = `${device.id} by ${dx}, ${dy}`;
          const ids = draggedWith(first, device.id);
          const there = moved(first, ids, dx, dy);
          if (dropShift(there, ids, first) === null) {
            found.push(
              ...whileDragged(there, first, true).map((text) => `${what}, dragged: ${text}`),
            );
          }
          const dropped = dragged(first, device.id, dx, dy);
          found.push(...drawn(dropped).unrouted.map((id) => `${what}: no route for ${id}`));
          found.push(...bothWays(dropped).map((text) => `${what}: ${text}`));
        }
      }
      expect(found).toEqual([]);
    }, 240_000);

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
      for (const [where, to] of Object.entries(places)) {
        // Where something stands there already, the device is put beside it.
        const dropped = dragged(first, load.id, to.x - load.position.x, to.y - load.position.y);
        expect(bothWays(dropped), `${load.id} ${where}`).toEqual([]);
        expect(drawn(dropped).unrouted, `${load.id} ${where}`).toEqual([]);
      }
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

  it('IEEE 14: a load dropped behind the generator of its bus is connected round it', async () => {
    const first = await opened(IEEE14);
    const generator = first.nodes.find((n) => n.id === 'generator-2')!;
    const load = first.nodes.find((n) => n.id === 'load-PQ_1')!;
    const bus = first.nodes.find((n) => n.id === '2')!;
    // Both hang on bus 2. The load goes right behind the generator, further
    // from the bar: straight to the bar, its connector would run through
    // the generator.
    const below = generator.position.y > bus.position.y;
    const to = {
      x: generator.position.x + ((generator.initialWidth ?? 0) - (load.initialWidth ?? 0)) / 2,
      y: below
        ? generator.position.y + (generator.initialHeight ?? 0) + 24
        : generator.position.y - 24 - (load.initialHeight ?? 0),
    };
    const ids = draggedWith(first, load.id);
    const there = moved(first, ids, to.x - load.position.x, to.y - load.position.y);
    // It may stand there: behind another device is a place like any other.
    expect(dropShift(there, ids, first)).toBeNull();
    expect(whileDragged(there, first, true)).toEqual([]);
    const dropped = dragged(first, load.id, to.x - load.position.x, to.y - load.position.y);
    expect(dropped.nodes.find((n) => n.id === load.id)!.position).toEqual(to);
    expect(bothWays(dropped)).toEqual([]);
    // Stepped round the generator, and square onto the bar beside it.
    const connector = drawn(dropped).connections.routes.get(`stub-${load.id}`)!.points;
    expect(connector.length).toBeGreaterThan(2);
    const [beforeLast, last] = [connector[connector.length - 2]!, connector[connector.length - 1]!];
    expect(beforeLast[0]).toBe(last[0]);
    expect(bothWays(tidied(dropped, false))).toEqual([]);
  });

  it('puts what is dropped on a symbol or on a bar in the nearest free place', async () => {
    const boxOf = (diagram: Diagram, id: string) => {
      const node = diagram.nodes.find((n) => n.id === id)!;
      return {
        left: node.position.x,
        right: node.position.x + (node.initialWidth ?? 0),
        top: node.position.y,
        bottom: node.position.y + (node.initialHeight ?? 0),
      };
    };
    const apart = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>): boolean =>
      a.left >= b.right || b.left >= a.right || a.top >= b.bottom || b.top >= a.bottom;

    // IEEE 14: the load of bus 4 on the west end of the bar of bus 6.
    const ieee = await opened(IEEE14);
    const load = ieee.nodes.find((n) => n.id === 'load-PQ_3')!;
    const bus6 = ieee.nodes.find((n) => n.id === '6')!;
    const bar6 = drawn(ieee).connections.bars.get('6')!;
    const onBar = { x: bus6.position.x + bar6.start - 10, y: bus6.position.y - 20 };
    const offBar = dragged(ieee, load.id, onBar.x - load.position.x, onBar.y - load.position.y);
    expect(offBar.nodes.find((n) => n.id === load.id)!.position).not.toEqual(onBar);
    expect(bothWays(offBar)).toEqual([]);

    // IEEE 14: bus 14 with its load on the shunt of bus 9.
    const shunt = ieee.nodes.find((n) => n.id === 'shunt-Shunt_1')!;
    const carried = ieee.nodes.find((n) => n.id === 'load-PQ_11')!;
    const beside = dragged(
      ieee,
      '14',
      shunt.position.x + 10 - carried.position.x,
      shunt.position.y + 5 - carried.position.y,
    );
    expect(apart(boxOf(beside, 'load-PQ_11'), boxOf(beside, 'shunt-Shunt_1'))).toBe(true);
    expect(bothWays(beside)).toEqual([]);
    expect(bothWays(tidied(beside, false))).toEqual([]);

    // Kundur: one generator on another.
    const kundur = await opened(KUNDUR);
    const [g3, g4] = ['generator-3', 'generator-4'].map(
      (id) => kundur.nodes.find((n) => n.id === id)!,
    );
    const stacked = dragged(
      kundur,
      g3!.id,
      g4!.position.x + 12 - g3!.position.x,
      g4!.position.y + 8 - g3!.position.y,
    );
    expect(apart(boxOf(stacked, 'generator-3'), boxOf(stacked, 'generator-4'))).toBe(true);
    expect(bothWays(stacked)).toEqual([]);
  });

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
    const dropped = dragged(first, '49', 40, 24);
    const found = bothWays(dropped);
    expect(found).toEqual([]);
  }, 120_000);

  it('IEEE 118: while a bus with lines to the far ends of the diagram is dragged', async () => {
    // The surroundings of all the lines of such a bus are more than the
    // grid of one move holds: its routes follow it, and the ones that then
    // are on something are searched for one at a time.
    const first = await opened(CASE118);
    const found: string[] = [];
    for (const [id, dx, dy] of [
      ['17', 48, 0],
      ['17', 24, 8],
      ['49', -48, 0],
      ['65', -48, 0],
      ['25', 48, 0],
      ['113', 24, 8],
    ] as const) {
      const ids = draggedWith(first, id);
      const there = moved(first, ids, dx, dy);
      expect(dropShift(there, ids, first), `bus ${id} by ${dx}, ${dy}`).toBeNull();
      found.push(
        ...whileDragged(there, first, false).map((text) => `bus ${id} by ${dx}, ${dy}: ${text}`),
      );
    }
    expect(found).toEqual([]);
  }, 120_000);
});
