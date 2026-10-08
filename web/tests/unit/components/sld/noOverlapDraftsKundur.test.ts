/**
 * Nothing on the diagram of Kundur is drawn over anything else with drafts on
 * it: wherever one is dropped, when it is given a bus from its form, drawn
 * as a branch, dragged, and tidied with the rest (`holdDrafts` in
 * `tests/unit/helpers/draftSweeps.ts`, which says how each state is made).
 *
 * jsdom has no `Worker`, so the worker client is replaced by the same ELK
 * engine run in-thread, as in `layout.test.ts`.
 */
import { vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { KUNDUR } from '../../helpers/exampleCases';
import { holdDrafts } from '../../helpers/draftSweeps';

vi.mock('@/components/sld/elkClient', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  return { elkLayout: vi.fn((graph: ElkNode) => elk.layout(graph)) };
});

holdDrafts('Kundur', KUNDUR);
