/**
 * Nothing on the diagram of IEEE 39 is drawn over anything else after any
 * of its buses or devices was moved (`holdMoves` in
 * `tests/unit/helpers/overlapSweeps.ts`, which says what is moved and how).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { IEEE39 } from '../../helpers/exampleCases';
import { holdMoves } from '../../helpers/overlapSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

// Every bus and every device would take a quarter of an hour on a case of this size (each move
// costs about a second, against a tenth on Kundur): one in twenty of each, with every move of
// the spread. The whole sweep was run once, with every bus and device, when the case was added.
holdMoves('IEEE 39', IEEE39, { every: 20 });
