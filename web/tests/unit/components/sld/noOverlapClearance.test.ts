/**
 * Nothing on the diagram of an example case comes so near anything else that
 * the two read as one, after a generator is dragged beside its bus, a load
 * across its bar or far above it, and the diagram is tidied: the drags a
 * reviewer makes on IEEE 14, Kundur and WSCC 9, one on top of the other.
 *
 * The rules of the overlap checker that hold it (`overlapCheck.ts`): two
 * bars keep `BAR_GAP` between them, a line does not end or turn short of a
 * bar in line with one on its other face, a line does not run along the edge
 * of a symbol, and no two lines share an end on a bar. Each state is made
 * the way the canvas makes it (`diagramStates.ts`).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import { BAR_GAP, BAR_THICKNESS, SYMBOL_CLEAR } from '@/components/sld/connections';
import {
  bothWays,
  dragged,
  drawn,
  opened,
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

const CASES: readonly [string, TopologySummary][] = [
  ['IEEE 14', IEEE14],
  ['Kundur', KUNDUR],
  ['WSCC 9', WSCC9],
];

/** The nearest two bars of `diagram` come to each other, tip to tip or corner to corner. */
function nearestBars(diagram: Diagram): { apart: number; of: string } {
  const bars = [...drawn(diagram).connections.bars].map(([id, bar]) => {
    const { x, y } = diagram.nodes.find((n) => n.id === id)!.position;
    return { id, left: x + bar.start, right: x + bar.end, y };
  });
  let least = { apart: Infinity, of: '' };
  for (let i = 0; i < bars.length; i += 1) {
    for (let k = i + 1; k < bars.length; k += 1) {
      const [a, b] = [bars[i]!, bars[k]!];
      const across = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
      const down = Math.max(0, Math.abs(a.y - b.y) - 6);
      const apart = Math.hypot(across, down);
      if (apart < least.apart) least = { apart, of: `${a.id} and ${b.id}` };
    }
  }
  return least;
}

/**
 * How far a node of `diagram` goes to stand beside the east end of its bus,
 * level with the bar: 50 past the end of the bar as it is drawn, which is as
 * long as its taps have made it, and not as long as the node of the bus is
 * wide.
 */
function beside(diagram: Diagram, id: string): [number, number] {
  const node = diagram.nodes.find((n) => n.id === id)!;
  const bus = diagram.nodes.find((n) => n.id === (node.data as { parentBus: string }).parentBus)!;
  const bar = drawn(diagram).connections.bars.get(bus.id)!;
  const height = node.initialHeight ?? 41;
  return [
    bus.position.x + bar.end + 50 - node.position.x,
    bus.position.y + BAR_THICKNESS / 2 - height / 2 - node.position.y,
  ];
}

/** Whether the node `id` of `diagram` stands level with the bar of its bus, past its east end. */
function levelPastTheTip(diagram: Diagram, id: string): boolean {
  const node = diagram.nodes.find((n) => n.id === id)!;
  const bus = diagram.nodes.find((n) => n.id === (node.data as { parentBus: string }).parentBus)!;
  const bar = drawn(diagram).connections.bars.get(bus.id)!;
  const middle = node.position.y + (node.initialHeight ?? 41) / 2;
  return (
    Math.abs(middle - (bus.position.y + BAR_THICKNESS / 2)) < 1 &&
    node.position.x >= bus.position.x + bar.end
  );
}

/** The room between the east end of the bar of bus `west` and the west end of the bar of bus `east`. */
function gapBetween(diagram: Diagram, west: string, east: string): number {
  const bars = drawn(diagram).connections.bars;
  const at = (id: string) => diagram.nodes.find((n) => n.id === id)!.position.x;
  return at(east) + bars.get(east)!.start - (at(west) + bars.get(west)!.end);
}

describe('nothing is nearer to anything else than it is told apart by', () => {
  for (const [name, topology] of CASES) {
    it(`${name}: after a generator is dragged beside its bus, a load far above it, and a tidy`, async () => {
      const found: string[] = [];
      const states: [string, Diagram][] = [];
      const first = await opened(topology);
      states.push(['as it opens', first]);
      let diagram = tidied(first, false);
      states.push(['tidied', diagram]);
      let level = 0;
      for (const id of diagram.nodes.filter((n) => n.type === 'generator').map((n) => n.id)) {
        const [dx, dy] = beside(diagram, id);
        const aside = dragged(diagram, id, dx, dy);
        // Where it stands level with its bar and past its end, it was put where
        // it was dragged to: the bar is drawn out to its tap. Where a bar of
        // another bus is in the way, it stands as near as it can instead.
        if (levelPastTheTip(aside, id)) level += 1;
        states.push([`${id} beside its bus`, aside]);
        states.push([`${id} beside its bus, tidied`, tidied(aside, false)]);
      }
      // A generator really did stand beside its bus in some of the states, so
      // that a drop shifted away from it cannot leave the sweep with nothing.
      expect(level, `${name}: generators beside their bus`).toBeGreaterThan(0);
      // The two drags one after the other, as the review made them.
      const generators = diagram.nodes.filter((n) => n.type === 'generator');
      const loads = diagram.nodes.filter((n) => n.type === 'load');
      const [g, l] = [generators[generators.length > 1 ? 1 : 0]!, loads[0]!];
      const [dx, dy] = beside(diagram, g.id);
      diagram = dragged(diagram, g.id, dx, dy);
      diagram = dragged(diagram, l.id, 0, -150);
      states.push(['a generator beside its bus and a load far above it', diagram]);
      states.push(['and tidied', tidied(diagram, false)]);
      states.push(['and laid out again', tidied(diagram, true)]);
      states.push(['and drawn again as it is kept', settled(tidied(diagram, false))]);
      for (const [what, state] of states) {
        found.push(...bothWays(state).map((text) => `${what}: ${text}`));
        const { apart, of } = nearestBars(state);
        if (apart < BAR_GAP - 0.5) found.push(`${what}: the bars of ${of} are ${apart} apart`);
      }
      expect(found).toEqual([]);
      // The states are not all one: the drags moved something.
      expect(states.length).toBeGreaterThan(8);
    }, 300_000);
  }

  it('Kundur: a load pulled down beside the bars of buses 12 and 13 is left where it was dropped, and the bars keep their gap', async () => {
    // The load of bus 3 dropped level with the row of bus 12 and bus 13, west
    // of the bar of bus 13: bus 12's bar is drawn out to the tap of its
    // connector, and no nearer to bar 13 than BAR_GAP. Drawn out to within 8 of
    // it, the two read as one bar with a break in it, and the drop was refused
    // for that: it went back 24 to the east, with a notice.
    const first = await opened(KUNDUR);
    const was = first.nodes.find((n) => n.id === 'load-PQ_0')!.position;
    const aside = dragged(first, 'load-PQ_0', -24, 148);
    const now = aside.nodes.find((n) => n.id === 'load-PQ_0')!.position;
    expect(now).toEqual({ x: was.x - 24, y: was.y + 148 });
    // The bar did grow towards the load, which is what the test is about.
    expect(gapBetween(aside, '3', '8')).toBeLessThan(gapBetween(first, '3', '8'));
    expect(gapBetween(aside, '3', '8')).toBeGreaterThanOrEqual(BAR_GAP);
    expect(bothWays(aside)).toEqual([]);
    expect(bothWays(tidied(aside, false))).toEqual([]);
  });

  it('IEEE 14: a load dragged straight up past a generator keeps its connector off the block, drop, tidy and all', async () => {
    // The load of bus 2 set down above generator 1, whose block it overlaps by a
    // few pixels across: the nearest free place put its connector 2.5 beside
    // the block for the whole of its height, where line and border read as one.
    const first = await opened(IEEE14);
    const generator = first.nodes.find((n) => n.id === 'generator-1')!;
    const [width, height] = [generator.initialWidth ?? 0, generator.initialHeight ?? 0];
    const states: [string, Diagram][] = [];
    const dropped = dragged(first, 'load-PQ_1', 0, -150);
    states.push(['dropped', dropped]);
    states.push(['tidied', tidied(dropped, false)]);
    states.push(['drawn as it is kept', settled(tidied(dropped, false))]);
    for (const [what, state] of states) {
      expect(bothWays(state), what).toEqual([]);
      const [x, y] = [generator.position.x, generator.position.y];
      const stub = drawn(state).connections.routes.get('stub-load-PQ_1')!.points;
      // Wherever a run of the connector is level with the block, it is as far
      // from the edge as a line keeps from a symbol.
      for (let i = 1; i < stub.length; i += 1) {
        const [a, b] = [stub[i - 1]!, stub[i]!];
        if (
          Math.max(a[1], b[1]) <= y - SYMBOL_CLEAR ||
          Math.min(a[1], b[1]) >= y + height + SYMBOL_CLEAR
        ) {
          continue;
        }
        const near = Math.min(...[a[0], b[0]].map((px) => Math.max(x - px, px - (x + width), 0)));
        expect(near, `${what}: run ${i} of the connector`).toBeGreaterThanOrEqual(SYMBOL_CLEAR);
      }
    }
  });
});
