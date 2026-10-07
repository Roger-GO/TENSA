/**
 * Nothing on the diagram of WSCC 9 is drawn over anything else after any
 * of its buses or devices was moved (`holdMoves` in
 * `tests/unit/helpers/overlapSweeps.ts`, which says what is moved and how).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { WSCC9 } from '../../helpers/exampleCases';
import { holdMoves } from '../../helpers/overlapSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

holdMoves('WSCC 9', WSCC9);
