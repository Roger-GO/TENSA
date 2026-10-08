/**
 * Nothing on the diagram of IEEE 14 is drawn over anything else through what
 * connecting by a drag does to it: a component dropped on a bus, a draft
 * dragged onto one, a line or a transformer drawn between two buses, and a
 * device moved to another bus (`holdWiring` in
 * `tests/unit/helpers/wiringSweeps.ts`, which says how each state is made).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { IEEE14 } from '../../helpers/exampleCases';
import { holdWiring } from '../../helpers/wiringSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

holdWiring('IEEE 14', IEEE14);
