/**
 * Nothing on the diagram of the IEEE 118-bus case is drawn over anything
 * else with drafts on it, and placing one there stays quick: a drop and a
 * pick of a bus each ask the picture of the whole diagram a few times.
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { DRAFT_NODE_TYPE } from '@/components/sld/drafts';
import { CASE118 } from '../../helpers/case118';
import { drawn, opened, overlapsOf, settled } from '../../helpers/diagramStates';
import { drafted } from '../../helpers/draftSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

/** How many places the canvas asks the picture about on a diagram this size (`DROP_PICTURES_LARGE`). */
const LARGE_DIAGRAM_PICTURES = 3;

describe('nothing overlaps on a case of a hundred buses with drafts on it', () => {
  it('IEEE 118: a draft dropped in the thick of it, given a bus, and one drawn as a line', async () => {
    const first = settled(await opened(CASE118));
    const buses = first.nodes.filter((n) => n.type === 'bus');
    const found: string[] = [];
    const took: number[] = [];
    for (const bus of [buses[10]!, buses[48]!, buses[99]!]) {
      // On the bar itself: the draft stands in the nearest free place.
      const started = performance.now();
      const made = drafted(
        first,
        'PQ',
        { x: bus.position.x + 40, y: bus.position.y },
        { bus: bus.id },
        'draft-1',
        LARGE_DIAGRAM_PICTURES,
      );
      took.push(performance.now() - started);
      const what = `a load dropped on bus ${bus.id}`;
      expect(made.diagram.nodes.filter((n) => n.type === DRAFT_NODE_TYPE)).toHaveLength(1);
      found.push(...drawn(made.diagram).unrouted.map((id) => `${what}: no route for ${id}`));
      found.push(...overlapsOf(made.diagram).map((text) => `${what}: ${text}`));
    }
    const line = drafted(first, 'Line', { x: 0, y: 0 }, { bus1: '11', bus2: '17' });
    found.push(...drawn(line.diagram).unrouted.map((id) => `the line: no route for ${id}`));
    found.push(...overlapsOf(line.diagram).map((text) => `the line: ${text}`));
    expect(found).toEqual([]);
    // Each a drop and a pick of a bus: far inside what a person waits for.
    expect(Math.max(...took)).toBeLessThan(4_000);
  }, 120_000);
});
