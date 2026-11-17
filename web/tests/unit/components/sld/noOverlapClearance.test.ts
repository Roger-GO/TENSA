/**
 * Nothing on the diagram of an example case comes so near anything else that
 * the two read as one, after a generator is dragged beside its bus, a load
 * across its bar or far above it, and the diagram is tidied: the drags a
 * reviewer makes on IEEE 14, Kundur and WSCC 9, one on top of the other.
 *
 * The rules of the overlap checker that hold it (`overlapCheck.ts`): two
 * bars keep `BAR_GAP` between them, a line does not end or turn short of a
 * bar in line with one on its other face, and no two lines share an end on a
 * bar. Each state is made the way the canvas makes it (`diagramStates.ts`).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { TopologySummary } from '@/api/types';
import { BAR_GAP, BAR_LENGTH } from '@/components/sld/connections';
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

/** How far a node of `diagram` goes to stand beside the east end of its bus, level with the bar. */
function beside(diagram: Diagram, id: string): [number, number] {
  const node = diagram.nodes.find((n) => n.id === id)!;
  const bus = diagram.nodes.find((n) => n.id === (node.data as { parentBus: string }).parentBus)!;
  const height = node.initialHeight ?? 41;
  return [
    bus.position.x + BAR_LENGTH + 50 - node.position.x,
    bus.position.y - height / 2 - node.position.y,
  ];
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
      for (const id of diagram.nodes.filter((n) => n.type === 'generator').map((n) => n.id)) {
        const [dx, dy] = beside(diagram, id);
        const aside = dragged(diagram, id, dx, dy);
        states.push([`${id} beside its bus`, aside]);
        states.push([`${id} beside its bus, tidied`, tidied(aside, false)]);
      }
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

  it('Kundur: bars 12 and 13 stand clear of each other with a generator beside bus 12', async () => {
    // The generator of bus 12 stands level with its bar, past its east tip,
    // towards bus 13 on the same row: the bar is drawn out to its tap, and no
    // nearer to bus 13 than BAR_GAP.
    const first = await opened(KUNDUR);
    const [dx, dy] = beside(first, 'generator-3');
    const aside = dragged(first, 'generator-3', dx, dy);
    const bars = drawn(aside).connections.bars;
    const at = (id: string) => aside.nodes.find((n) => n.id === id)!.position.x;
    expect(at('8') + bars.get('8')!.start - (at('3') + bars.get('3')!.end)).toBeGreaterThanOrEqual(
      BAR_GAP,
    );
    expect(bothWays(aside)).toEqual([]);
  });
});
